import seed from "../../data/seed.json" with { type: "json" };
import type { DeliveryZone, MenuItem, Order } from "../domain.js";
import type { Store } from "./types.js";

export class MemoryStore implements Store {
  private menu: MenuItem[];
  private zones: DeliveryZone[];
  private orders = new Map<string, Order>();

  constructor(data: { menu: MenuItem[]; deliveryZones: DeliveryZone[] } = seed) {
    this.menu = structuredClone(data.menu);
    this.zones = structuredClone(data.deliveryZones);
  }

  async listMenu() {
    return structuredClone(this.menu);
  }
  async listZones() {
    return structuredClone(this.zones);
  }
  async consumeStock(lines: { sku: string; qty: number }[]) {
    const short: string[] = [];
    for (const l of lines) {
      const m = this.menu.find((x) => x.sku === l.sku);
      if (!m || m.stock < l.qty) short.push(l.sku);
      if (m) m.stock = Math.max(0, m.stock - l.qty);
    }
    return short;
  }
  async createOrder(order: Order) {
    this.orders.set(order.reference, structuredClone(order));
  }
  async getOrder(reference: string) {
    const o = this.orders.get(reference);
    return o && structuredClone(o);
  }
  async updateOrder(reference: string, patch: Partial<Order>) {
    const o = this.orders.get(reference);
    if (!o) return undefined;
    Object.assign(o, patch);
    return structuredClone(o);
  }
  async listOrders() {
    return structuredClone([...this.orders.values()]);
  }
  async findOpenOrderByPhone(phone: string) {
    const open = [...this.orders.values()]
      .filter((o) => o.customerPhone === phone && o.status === "pending_payment")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return open[0] && structuredClone(open[0]);
  }
}
