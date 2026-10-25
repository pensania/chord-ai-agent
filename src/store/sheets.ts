import { GoogleAuth } from "google-auth-library";
import type { DeliveryZone, MenuItem, Order, OrderLine } from "../domain.js";
import type { Store } from "./types.js";

/**
 * Google Sheet layout (header row 1, data from row 2):
 *   Menu:   sku | name | price_ngn | stock | active
 *   Zones:  zone | fee_ngn
 *   Orders: reference | created_at | customer_name | customer_phone | items_json | zone | address |
 *           subtotal_ngn | delivery_fee_ngn | total_ngn | status | payment_url | paid_at | note
 * The owner can edit Menu and Zones by hand; the agent only appends and updates Orders and stock.
 */
const ORDER_COLS = [
  "reference", "createdAt", "customerName", "customerPhone", "lines", "deliveryZone", "deliveryAddress",
  "subtotalNgn", "deliveryFeeNgn", "totalNgn", "status", "paymentUrl", "paidAt", "note",
] as const;

type Values = (string | number | boolean)[][];

export function parseServiceAccount(raw: string): Record<string, unknown> {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}

export class SheetsStore implements Store {
  private auth: GoogleAuth;
  constructor(private sheetId: string, serviceAccountJson: string) {
    this.auth = new GoogleAuth({
      credentials: parseServiceAccount(serviceAccountJson),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  private async call<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
    const client = await this.auth.getClient();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}${path}`;
    const res = await client.request<T>({ url, method, data: body, timeout: 8000 });
    return res.data;
  }

  private async read(range: string): Promise<Values> {
    const data = await this.call<{ values?: Values }>("GET", `/values/${encodeURIComponent(range)}`);
    return data.values ?? [];
  }

  private async write(range: string, values: Values) {
    await this.call("PUT", `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values });
  }

  async listMenu(): Promise<MenuItem[]> {
    const rows = await this.read("Menu!A2:E");
    return rows
      .filter((r) => r[0])
      .map((r) => ({
        sku: String(r[0]).trim(),
        name: String(r[1] ?? ""),
        priceNgn: Number(r[2] ?? 0),
        stock: Number(r[3] ?? 0),
        active: String(r[4] ?? "TRUE").toUpperCase() !== "FALSE",
      }));
  }

  async listZones(): Promise<DeliveryZone[]> {
    const rows = await this.read("Zones!A2:B");
    return rows.filter((r) => r[0]).map((r) => ({ zone: String(r[0]).trim(), feeNgn: Number(r[1] ?? 0) }));
  }

  async consumeStock(lines: { sku: string; qty: number }[]): Promise<string[]> {
    // Read-modify-write. Fine for one small shop; see docs/go-live-note.md for the concurrency caveat.
    const rows = await this.read("Menu!A2:D");
    const short: string[] = [];
    for (const l of lines) {
      const i = rows.findIndex((r) => String(r[0]).trim() === l.sku);
      if (i < 0) {
        short.push(l.sku);
        continue;
      }
      const stock = Number(rows[i][3] ?? 0);
      if (stock < l.qty) short.push(l.sku);
      await this.write(`Menu!D${i + 2}`, [[Math.max(0, stock - l.qty)]]);
    }
    return short;
  }

  private toRow(o: Order): (string | number)[] {
    return ORDER_COLS.map((c) => {
      const v = o[c];
      if (c === "lines") return JSON.stringify(v);
      return v === undefined ? "" : (v as string | number);
    });
  }

  private fromRow(r: Values[number]): Order {
    const get = (c: (typeof ORDER_COLS)[number]) => r[ORDER_COLS.indexOf(c)];
    const str = (c: (typeof ORDER_COLS)[number]) => (get(c) === undefined || get(c) === "" ? undefined : String(get(c)));
    return {
      reference: String(get("reference")),
      createdAt: String(get("createdAt")),
      customerName: String(get("customerName") ?? ""),
      customerPhone: String(get("customerPhone") ?? ""),
      lines: JSON.parse(String(get("lines") || "[]")) as OrderLine[],
      deliveryZone: String(get("deliveryZone") ?? ""),
      deliveryAddress: String(get("deliveryAddress") ?? ""),
      subtotalNgn: Number(get("subtotalNgn") ?? 0),
      deliveryFeeNgn: Number(get("deliveryFeeNgn") ?? 0),
      totalNgn: Number(get("totalNgn") ?? 0),
      status: String(get("status")) as Order["status"],
      paymentUrl: str("paymentUrl"),
      paidAt: str("paidAt"),
      note: str("note"),
    };
  }

  async createOrder(order: Order) {
    await this.call("POST", `/values/${encodeURIComponent("Orders!A:N")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
      values: [this.toRow(order)],
    });
  }

  private async findRow(reference: string): Promise<{ index: number; order: Order } | undefined> {
    const rows = await this.read("Orders!A2:N");
    const i = rows.findIndex((r) => String(r[0]) === reference);
    return i < 0 ? undefined : { index: i + 2, order: this.fromRow(rows[i]) };
  }

  async getOrder(reference: string) {
    return (await this.findRow(reference))?.order;
  }

  async updateOrder(reference: string, patch: Partial<Order>) {
    const found = await this.findRow(reference);
    if (!found) return undefined;
    const next = { ...found.order, ...patch };
    await this.write(`Orders!A${found.index}:N${found.index}`, [this.toRow(next)]);
    return next;
  }

  async findOpenOrderByPhone(phone: string) {
    const rows = await this.read("Orders!A2:N");
    const open = rows
      .map((r) => this.fromRow(r))
      .filter((o) => o.customerPhone === phone && o.status === "pending_payment")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return open[0];
  }
}
