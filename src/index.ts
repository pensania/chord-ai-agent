import { createHmac } from "node:crypto";
import { Checkout } from "./checkout.js";
import { hashPin } from "./admin/auth.js";
import { MemoryOpsStore } from "./ops/memory.js";
import { Kitchen } from "./stock/kitchen.js";
import { MemoryStockStore } from "./stock/memory.js";
import { Operations } from "./ops/operations.js";
import { forwardToChord } from "./webhook.js";
import { loadConfig } from "./config.js";
import { Paystack } from "./paystack.js";
import { createApp } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { LeadautLink } from "./revenue/connection.js";
import { AlertHub, ResendMailer } from "./ops/alerts.js";
import { SheetsStore, parseServiceAccount } from "./store/sheets.js";
import { PostgresDb, PostgresOpsStore, PostgresOutboxJournal, PostgresSettings, PostgresStockStore, PostgresStore, type SettingsStore } from "./store/postgres.js";
import type { OpsStore } from "./ops/types.js";
import type { OutboxJournal } from "./revenue/outbox.js";
import type { StockStore } from "./stock/types.js";
import type { Store } from "./store/types.js";

const cfg = loadConfig();
for (const w of cfg.warnings) console.warn(JSON.stringify({ msg: "config_warning", warning: w }));

let store: Store = new MemoryStore();
let storeName = "memory";
// Staff, rota, order stages, stock, expenses, pay and portal settings: in Postgres when it's on,
// otherwise in memory (reset on restart).
let opsStore: OpsStore = new MemoryOpsStore();
let stockStore: StockStore = new MemoryStockStore();
let settings: SettingsStore | undefined;
let journal: OutboxJournal | undefined;
if (cfg.store === "postgres") {
  const db = new PostgresDb(cfg.databaseUrl!);
  await connectWithRetry(db);
  store = new PostgresStore(db);
  opsStore = new PostgresOpsStore(db);
  stockStore = new PostgresStockStore(db);
  settings = new PostgresSettings(db);
  journal = new PostgresOutboxJournal(db);
  storeName = "postgres";
} else if (cfg.store === "sheets") {
  try {
    store = new SheetsStore(cfg.googleSheetId!, cfg.googleServiceAccountJson!);
    storeName = "sheets";
  } catch (e) {
    // Usually malformed service-account JSON. Keep serving on the memory store rather than crash-looping.
    console.warn(JSON.stringify({ msg: "config_warning", warning: `Google Sheets store failed to start (${e instanceof Error ? e.message : e}); using memory store` }));
  }
}
const paystack = new Paystack({ secretKey: cfg.paystackSecretKey });

// Paid orders go to Leadaut, the revenue system, with retries. The owner connects it on the
// portal's Integrations page; LEADAUT_WEBHOOK_URL/SECRET on Render are the fallback.
const leadaut = new LeadautLink({ settings, journal, log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })) });
await leadaut.restore({ url: cfg.revenueWebhookUrl, secret: cfg.revenueWebhookSecret });
leadaut.outbox.start();

// Live board updates and order alerts for the staff on duty (and the owner), in the portal and by email if set up.
const logJson = (msg: string, extra?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...extra }));
const alerts = new AlertHub(
  opsStore,
  { today: () => operations.today(), onDuty: (date, role) => operations.onDuty(date, role) },
  {
    mailer: cfg.resendApiKey && cfg.alertEmailFrom ? new ResendMailer({ apiKey: cfg.resendApiKey, from: cfg.alertEmailFrom }) : undefined,
    ownerEmail: cfg.ownerEmail,
    baseUrl: cfg.publicUrl,
    log: logJson,
  },
);
const alertFailed = (e: unknown) => console.error(JSON.stringify({ msg: "order_alert_failed", error: e instanceof Error ? e.message : String(e) }));

const checkout = new Checkout(store, paystack, {
  callbackUrl: cfg.paystackCallbackUrl,
  placeholderEmailDomain: cfg.placeholderEmailDomain,
  onPaid: (order) => {
    leadaut.paid(order);
    alerts.newOrder(order).catch(alertFailed);
  },
});

const chord = cfg.chordEventUrl && cfg.chordEventSecret ? { url: cfg.chordEventUrl, secret: cfg.chordEventSecret } : undefined;

// STAFF_PINS fills in PINs that aren't set yet. A PIN the owner set on the portal is kept.
for (const { staffId, pin } of cfg.staffPins) {
  const s = await opsStore.getStaff(staffId);
  if (s && !s.pinHash) await opsStore.saveStaff({ ...s, pinHash: hashPin(pin) });
  else if (!s) console.warn(JSON.stringify({ msg: "config_warning", warning: `STAFF_PINS names unknown staff "${staffId}"` }));
}
const kitchen = new Kitchen(stockStore, opsStore, { menu: () => store.listMenu() });
const operations = new Operations(store, opsStore, {
  stock: kitchen,
  onStageChange: async (e) => {
    console.log(JSON.stringify({ msg: "order_stage_changed", reference: e.reference, from: e.from, to: e.to, by: e.by }));
    const order = await store.getOrder(e.reference);
    if (order) {
      leadaut.stage(e, order);
      alerts.stageChanged(e, order).catch(alertFailed);
    }
    if (chord) {
      // Chord can't message the customer from an event run today; this gives the owner's workflow the update.
      const fwd = await forwardToChord(chord, { event_type: "order.stage_changed", event_id: `${e.reference}:${e.to}:${Date.now()}`, ...e });
      console.log(JSON.stringify({ msg: "chord_event_forwarded", reference: e.reference, ...fwd }));
    }
  },
});

const app = createApp({
  checkout,
  mcpBearerToken: cfg.mcpBearerToken,
  paystackSecretKey: cfg.paystackSecretKey,
  storeName,
  chord,
  revenueStatus: () => (leadaut.connected ? leadaut.outbox.status() : undefined),
  operations,
  admin: cfg.adminPassword
    ? {
        operations,
        opsStore,
        ownerPassword: cfg.adminPassword,
        leadaut,
        kitchen,
        alerts,
        // Sessions stay valid across restarts only if the secret is stable, so derive it from settings that are.
        sessionSecret: cfg.adminSessionSecret ?? createHmac("sha256", cfg.mcpBearerToken).update(`admin:${cfg.adminPassword}`).digest("hex"),
      }
    : undefined,
});

app.listen(cfg.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: cfg.port, store: storeName, chordEvents: Boolean(chord), leadautSync: leadaut.connected, adminPortal: Boolean(cfg.adminPassword), adminPasswordLength: cfg.adminPassword?.length }));
  if (storeName === "sheets") void checkSheet();
});

// Read the Menu tab once at startup so a sharing or ID mistake shows up in the logs straight away,
// not on the first customer's order.
async function checkSheet() {
  try {
    const menu = await store.listMenu();
    console.log(JSON.stringify({ msg: "sheet_ok", menuItems: menu.length }));
  } catch (e) {
    let clientEmail: unknown;
    try { clientEmail = parseServiceAccount(cfg.googleServiceAccountJson!).client_email; } catch { /* already reported */ }
    console.error(JSON.stringify({
      msg: "sheet_unreachable",
      error: e instanceof Error ? e.message : String(e),
      hint: `Share the Sheet with ${clientEmail ?? "the service account's client_email"} as Editor, and check GOOGLE_SHEET_ID and that the Google Sheets API is enabled`,
    }));
  }
}

/** A sleeping or just-created database can take a few seconds. Give up after about a minute: taking orders that can't be saved is worse than being down. */
async function connectWithRetry(db: PostgresDb) {
  for (let attempt = 1; ; attempt++) {
    try {
      await db.migrate();
      return;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ msg: "postgres_connect_failed", attempt, error }));
      if (attempt >= 6) {
        console.error(JSON.stringify({ msg: "postgres_unavailable", hint: "Check DATABASE_URL. The app won't take orders without its database." }));
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, Math.min(15_000, 1000 * 2 ** attempt)));
    }
  }
}
