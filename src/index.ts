import { Checkout } from "./checkout.js";
import { loadConfig } from "./config.js";
import { Paystack } from "./paystack.js";
import { createApp } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { SheetsStore } from "./store/sheets.js";
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
  chord: cfg.chordEventUrl && cfg.chordEventSecret ? { url: cfg.chordEventUrl, secret: cfg.chordEventSecret } : undefined,
});

app.listen(cfg.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: cfg.port, store: storeName, chordEvents: Boolean(cfg.chordEventUrl) }));
});
