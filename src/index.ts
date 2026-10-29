import { Checkout } from "./checkout.js";
import { loadConfig } from "./config.js";
import { Paystack } from "./paystack.js";
import { createApp } from "./server.js";
import { MemoryStore } from "./store/memory.js";
import { SheetsStore } from "./store/sheets.js";

const cfg = loadConfig();
const store = cfg.store === "sheets" ? new SheetsStore(cfg.googleSheetId!, cfg.googleServiceAccountJson!) : new MemoryStore();
const paystack = new Paystack({ secretKey: cfg.paystackSecretKey });
const checkout = new Checkout(store, paystack, { callbackUrl: cfg.paystackCallbackUrl, placeholderEmailDomain: cfg.placeholderEmailDomain });

const app = createApp({
  checkout,
  mcpBearerToken: cfg.mcpBearerToken,
  paystackSecretKey: cfg.paystackSecretKey,
  chord: cfg.chordEventUrl && cfg.chordEventSecret ? { url: cfg.chordEventUrl, secret: cfg.chordEventSecret } : undefined,
});

app.listen(cfg.port, () => {
  console.log(JSON.stringify({ msg: "listening", port: cfg.port, store: cfg.store, chordEvents: Boolean(cfg.chordEventUrl) }));
});
