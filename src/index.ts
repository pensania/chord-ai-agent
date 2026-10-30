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
import { SheetsStore, parseServiceAccount } from "./store/sheets.js";
import type { Store } from "./store/types.js";

const cfg = loadConfig();
for (const w of cfg.warnings) console.warn(JSON.stringify({ msg: "config_warning", warning: w }));

let store: Store = new MemoryStore();
let storeName = "memory";
if (cfg.store === "sheets") {
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
// portal's Integrations page; LEADAUT_WEBHOOK_URL/SECRET on Render are the fallback after a restart.
const leadaut = new LeadautLink({ log: (msg, extra) => console.log(JSON.stringify({ msg, ...extra })) });
if (cfg.revenueWebhookUrl && cfg.revenueWebhookSecret) leadaut.connect(cfg.revenueWebhookUrl, cfg.revenueWebhookSecret, "render");
leadaut.outbox.start();

const checkout = new Checkout(store, paystack, {
  callbackUrl: cfg.paystackCallbackUrl,
  placeholderEmailDomain: cfg.placeholderEmailDomain,
  onPaid: (order) => leadaut.paid(order),
});

const chord = cfg.chordEventUrl && cfg.chordEventSecret ? { url: cfg.chordEventUrl, secret: cfg.chordEventSecret } : undefined;

// Staff, rota and order stages live in memory for now; the Sheet/database layer comes last.
const opsStore = new MemoryOpsStore();
for (const { staffId, pin } of cfg.staffPins) {
  const s = await opsStore.getStaff(staffId);
  if (s) await opsStore.saveStaff({ ...s, pinHash: hashPin(pin) });
  else console.warn(JSON.stringify({ msg: "config_warning", warning: `STAFF_PINS names unknown staff "${staffId}"` }));
}
// Ingredients, expenses and pay, also in memory until the storage layer lands.
const kitchen = new Kitchen(new MemoryStockStore(), opsStore, { menu: () => store.listMenu() });
const operations = new Operations(store, opsStore, {
  stock: kitchen,
  onStageChange: async (e) => {
    console.log(JSON.stringify({ msg: "order_stage_changed", reference: e.reference, from: e.from, to: e.to, by: e.by }));
    if (leadaut.connected) {
      const order = await store.getOrder(e.reference);
      if (order) leadaut.stage(e, order);
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
