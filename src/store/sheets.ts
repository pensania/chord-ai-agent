import { GoogleAuth } from "google-auth-library";
import { OPEN_STATUSES, replaceable, shortFor, soldOn, type DayPlan, type DeliveryZone, type MenuItem, type Order, type OrderLine } from "../domain.js";
import { KeyedLock } from "../lock.js";
import type { Store } from "./types.js";

/**
 * Google Sheet layout (header row 1, data from row 2):
 *   Menu:   sku | name | price_ngn | stock (how many for one delivery day) | active
 *   Zones:  zone | fee_ngn
 *   Capacity (optional): date | sku | capacity, for days that differ from the usual
 *   Orders: reference | created_at | customer_name | customer_phone | items_json | zone | address |
 *           subtotal_ngn | delivery_fee_ngn | total_ngn | status | payment_url | paid_at | note | needed_by | extra_json
 * The owner can edit Menu and Zones by hand, or on the portal. `extra_json` holds the fields that
 * have no column of their own (delivery time, amounts received and refunded, stock flags, payment issues).
 */
const ORDER_COLS = [
  "reference", "createdAt", "customerName", "customerPhone", "lines", "deliveryZone", "deliveryAddress",
  "subtotalNgn", "deliveryFeeNgn", "totalNgn", "status", "paymentUrl", "paidAt", "note", "neededBy",
] as const;

const EXTRA = ["paidKobo", "stockTaken", "replacedBy", "cancelledAt", "refundDueKobo", "refundedKobo", "refundBaseKobo", "refundSeq", "paymentIssue", "deliverBy"] as const;

type Values = (string | number | boolean)[][];

export function parseServiceAccount(raw: string): Record<string, unknown> {
  const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(text);
}

export class SheetsStore implements Store {
  private auth: GoogleAuth;
  /** Sheets has no row locks, so writes go one at a time within this process. Run one instance. */
  private lock = new KeyedLock();
  constructor(private sheetId: string, serviceAccountJson: string) {
    this.auth = new GoogleAuth({
      credentials: parseServiceAccount(serviceAccountJson),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }

  protected async call<T>(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<T> {
    const client = await this.auth.getClient();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${this.sheetId}${path}`;
    const res = await client.request<T>({ url, method, data: body, timeout: 8000 });
    return res.data;
  }

  private async read(range: string): Promise<Values> {
    const data = await this.call<{ values?: Values }>("GET", `/values/${encodeURIComponent(range)}`);
    return data.values ?? [];
  }

  /** Write several ranges in one request, which Sheets applies together or not at all. */
  private async write(data: { range: string; values: Values }[]) {
    if (data.length) await this.call("POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
  }

  private exclusive<T>(fn: () => Promise<T>) {
    return this.lock.run("sheet", fn);
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

  private toRow(o: Order): (string | number)[] {
    const cells = ORDER_COLS.map((c) => {
      const v = o[c];
      if (c === "lines") return JSON.stringify(v);
      return v === undefined ? "" : (v as string | number);
    });
    const extra = Object.fromEntries(EXTRA.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
    return [...cells, Object.keys(extra).length ? JSON.stringify(extra) : ""];
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
      neededBy: str("neededBy"),
      ...(JSON.parse(String(r[ORDER_COLS.length] || "{}")) as Partial<Order>),
    };
  }

  createOrder(order: Order) {
    return this.exclusive(async () => {
      await this.call("POST", `/values/${encodeURIComponent("Orders!A:P")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        values: [this.toRow(order)],
      });
    });
  }

  private async orderRows(): Promise<{ index: number; order: Order }[]> {
    const rows = await this.read("Orders!A2:P");
    return rows.map((r, i) => ({ index: i + 2, r })).filter(({ r }) => r[0]).map(({ index, r }) => ({ index, order: this.fromRow(r) }));
  }

  private async findRow(reference: string) {
    return (await this.orderRows()).find((r) => r.order.reference === reference);
  }

  private orderCells(index: number, order: Order) {
    return { range: `Orders!A${index}:P${index}`, values: [this.toRow(order)] };
  }

  async getOrder(reference: string) {
    return (await this.findRow(reference))?.order;
  }

  updateOrder(reference: string, patch: Partial<Order>) {
    return this.transact(reference, async () => patch);
  }

  /** What an order uses of its day is counted from the order rows, so one row write changes both. */
  transact(reference: string, fn: (order: Order, short: () => Promise<string[]>) => Promise<Partial<Order> | undefined>) {
    return this.exclusive(async () => {
      const rows = await this.orderRows();
      const found = rows.find((r) => r.order.reference === reference);
      if (!found) return undefined;
      const { neededBy, lines } = found.order;
      const patch = await fn(found.order, async () =>
        shortFor(lines, await this.listMenu(), neededBy ? { sold: soldOn(neededBy, rows.map((r) => r.order)), capacity: await this.capacityOn(neededBy) } : { sold: {}, capacity: {} }),
      );
      if (!patch) return found.order;
      const next = { ...found.order, ...patch };
      await this.write([this.orderCells(found.index, next)]);
      return next;
    });
  }

  /** The Capacity tab, or undefined when the sheet doesn't have one (Sheets answers 400 for an unknown tab). */
  private async capacityRows(): Promise<Values | undefined> {
    try {
      return await this.read("Capacity!A2:C");
    } catch (e) {
      if ((e as { response?: { status?: number } }).response?.status === 400) return undefined;
      throw e;
    }
  }

  private async capacityOn(date: string): Promise<Record<string, number>> {
    const rows = (await this.capacityRows()) ?? [];
    return Object.fromEntries(rows.filter((r) => String(r[0] ?? "").trim() === date && r[1] && String(r[2] ?? "") !== "").map((r) => [String(r[1]).trim(), Number(r[2])]));
  }

  async dayPlan(date: string): Promise<DayPlan> {
    return { sold: soldOn(date, await this.listOrders()), capacity: await this.capacityOn(date) };
  }

  setDayCapacity(date: string, sku: string, capacity: number | undefined) {
    return this.exclusive(async () => {
      const rows = await this.capacityRows();
      if (!rows) throw new Error("The Google Sheet has no Capacity tab. Add one with the headers date, sku, capacity.");
      const i = rows.findIndex((r) => String(r[0] ?? "").trim() === date && String(r[1] ?? "").trim() === sku);
      if (i >= 0) await this.write([{ range: `Capacity!A${i + 2}:C${i + 2}`, values: [capacity === undefined ? ["", "", ""] : [date, sku, capacity]] }]);
      else if (capacity !== undefined)
        await this.call("POST", `/values/${encodeURIComponent("Capacity!A:C")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[date, sku, capacity]] });
    });
  }

  async listOrders() {
    return (await this.orderRows()).map((r) => r.order);
  }

  async openOrdersByPhone(phone: string) {
    return (await this.listOrders()).filter((o) => o.customerPhone === phone && OPEN_STATUSES.includes(o.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  activateOrder(reference: string, paymentUrl: string) {
    return this.exclusive(async () => {
      const rows = await this.orderRows();
      const found = rows.find((r) => r.order.reference === reference);
      if (!found) return undefined;
      if (found.order.status !== "pending_payment") return { order: found.order, replaced: [] as string[] };
      const order: Order = { ...found.order, paymentUrl };
      const others = rows.filter((r) => r.order.customerPhone === order.customerPhone && r.order.reference !== reference && OPEN_STATUSES.includes(r.order.status) && replaceable(r.order));
      await this.write([this.orderCells(found.index, order), ...others.map((r) => this.orderCells(r.index, { ...r.order, status: "replaced", replacedBy: reference }))]);
      return { order, replaced: others.map((r) => r.order.reference) };
    });
  }

  private async menuRow(sku: string) {
    const rows = await this.read("Menu!A2:E");
    const i = rows.findIndex((r) => String(r[0] ?? "").trim() === sku);
    if (i < 0) return undefined;
    const item = (await this.listMenu()).find((m) => m.sku === sku)!;
    return { row: i + 2, item };
  }

  addMenuItem(m: MenuItem) {
    return this.exclusive(async () => {
      if (await this.menuRow(m.sku)) return false;
      await this.call("POST", `/values/${encodeURIComponent("Menu!A:E")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[m.sku, m.name, m.priceNgn, m.stock, m.active]] });
      return true;
    });
  }
  updateMenuItem(sku: string, patch: Partial<Omit<MenuItem, "sku">>) {
    return this.exclusive(async () => {
      const found = await this.menuRow(sku);
      if (!found) return undefined;
      const item = { ...found.item, ...patch };
      await this.write([{ range: `Menu!B${found.row}:E${found.row}`, values: [[item.name, item.priceNgn, item.stock, item.active]] }]);
      return item;
    });
  }
  saveZone(z: DeliveryZone) {
    return this.exclusive(async () => {
      const i = (await this.read("Zones!A2:B")).findIndex((r) => String(r[0] ?? "").trim() === z.zone);
      if (i >= 0) return this.write([{ range: `Zones!B${i + 2}`, values: [[z.feeNgn]] }]);
      await this.call("POST", `/values/${encodeURIComponent("Zones!A:B")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values: [[z.zone, z.feeNgn]] });
    });
  }
  removeZone(zone: string) {
    return this.exclusive(async () => {
      const i = (await this.read("Zones!A2:B")).findIndex((r) => String(r[0] ?? "").trim() === zone);
      if (i < 0) return false;
      await this.write([{ range: `Zones!A${i + 2}:B${i + 2}`, values: [["", ""]] }]); // blank rows are skipped
      return true;
    });
  }
}
