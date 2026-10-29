import { createHmac } from "node:crypto";
import { Checkout } from "./checkout.js";
import { hashPin } from "./admin/auth.js";
import { MemoryOpsStore } from "./ops/memory.js";
import { Operations } from "./ops/operations.js";
import { forwardToChord } from "./webhook.js";
import { loadConfig } from "./config.js";
import { Paystack } from "./paystack.js";
import { createApp } from "./server.js";
import { MemoryStore } from "./store/memory.js";
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
const checkout = new Checkout(store, paystack, { callbackUrl: cfg.paystackCallbackUrl, placeholderEmailDomain: cfg.placeholderEmailDomain });

const chord = cfg.chordEventUrl && cfg.chordEventSecret ? { url: cfg.chordEventUrl, secret: cfg.chordEventSecret } : undefined;

// Staff, rota and order stages live in memory for now; the Sheet/database layer comes last.
const opsStore = new MemoryOpsStore();
for (const { staffId, pin } of cfg.staffPins) {
  const s = await opsStore.getStaff(staffId);
  if (s) await opsStore.saveStaff({ ...s, pinHash: hashPin(pin) });
  else console.warn(JSON.stringify({ msg: "config_warning", warning: `STAFF_PINS names unknown staff "${staffId}"` }));
}
const operations = new Operations(store, opsStore, {
  onStageChange: async (e) => {
    console.log(JSON.stringify({ msg: "order_stage_changed", reference: e.reference, from: e.from, to: e.to, by: e.by }));
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
  operations,
  admin: cfg.adminPassword
    ? {
        operations,
        opsStore,
        ownerPassword: cfg.adminPassword,
        // Sessions stay valid across restarts only if the secret is stable, so derive it from settings that are.
        sessionSecret: cfg.adminSessionSecret ?? createHmac("sha256", cfg.mcpBearerToken).update(`admin:${cfg.adminPassword}`).digest("hex"),
      }
    : undefined,
});

app.listen(cfg.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: cfg.port, store: storeName, chordEvents: Boolean(chord), adminPortal: Boolean(cfg.adminPassword) }));
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
