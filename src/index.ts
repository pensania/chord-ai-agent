import { Checkout } from "./checkout.js";
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

const app = createApp({
  checkout,
  mcpBearerToken: cfg.mcpBearerToken,
  paystackSecretKey: cfg.paystackSecretKey,
  storeName,
  chord: cfg.chordEventUrl && cfg.chordEventSecret ? { url: cfg.chordEventUrl, secret: cfg.chordEventSecret } : undefined,
});

app.listen(cfg.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: cfg.port, store: storeName, chordEvents: Boolean(cfg.chordEventUrl) }));
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
