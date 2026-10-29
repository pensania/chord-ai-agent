/**
 * One-off: fill a Google Sheet with the Menu, Zones and Orders tabs from data/seed.json.
 * Usage: GOOGLE_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON=... npm run seed:sheet
 * Create the three tabs (Menu, Zones, Orders) first and share the sheet with the service account's client_email.
 */
import { GoogleAuth } from "google-auth-library";
import seed from "../data/seed.json" with { type: "json" };
import { parseServiceAccount } from "../src/store/sheets.js";

const sheetId = process.env.GOOGLE_SHEET_ID;
const sa = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!sheetId || !sa) throw new Error("Set GOOGLE_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON");

const auth = new GoogleAuth({ credentials: parseServiceAccount(sa), scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
const client = await auth.getClient();

const put = (range: string, values: unknown[][]) =>
  client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    method: "PUT",
    data: { values },
  });

await put("Menu!A1", [["sku", "name", "price_ngn", "stock", "active"], ...seed.menu.map((m) => [m.sku, m.name, m.priceNgn, m.stock, m.active])]);
await put("Zones!A1", [["zone", "fee_ngn"], ...seed.deliveryZones.map((z) => [z.zone, z.feeNgn])]);
await put("Orders!A1", [[
  "reference", "created_at", "customer_name", "customer_phone", "items_json", "zone", "address",
  "subtotal_ngn", "delivery_fee_ngn", "total_ngn", "status", "payment_url", "paid_at", "note",
]]);
console.log("Seeded Menu, Zones and Orders headers.");
