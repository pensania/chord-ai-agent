import seed from "../../data/seed.json" with { type: "json" };
import { OPEN_STATUSES, replaceable, type DeliveryZone, type MenuItem, type Order } from "../domain.js";
import { KeyedLock } from "../lock.js";
import type { MenuStock, Store } from "./types.js";

export class MemoryStore implements Store {
  private menu: MenuItem[];
  private zones: DeliveryZone[];
  private orders = new Map<string, Order>();
  private lock = new KeyedLock();

  constructor(data: { menu: MenuItem[]; deliveryZones: DeliveryZone[] } = seed) {
    this.menu = structuredClone(data.menu);
    this.zones = structuredClone(data.deliveryZones);
  }

  /** Every write waits for the one before it, so a transaction is never interleaved with another write. */
  private write<T>(fn: () => Promise<T> | T) {
    return this.lock.run("write", async () => fn());
  }

  async listMenu() {
    return structuredClone(this.menu);
  }
  async listZones() {
    return structuredClone(this.zones);
  }
  createOrder(order: Order) {
    return this.write(() => void this.orders.set(order.reference, structuredClone(order)));
  }
  async getOrder(reference: string) {
    const o = this.orders.get(reference);
    return o && structuredClone(o);
  }
  updateOrder(reference: string, patch: Partial<Order>) {
    return this.write(() => {
      const o = this.orders.get(reference);
      if (!o) return undefined;
      Object.assign(o, structuredClone(patch));
      return structuredClone(o);
    });
  }
  async listOrders() {
    return structuredClone([...this.orders.values()]);
  }

  transact(reference: string, fn: (order: Order, stock: MenuStock) => Promise<Partial<Order> | undefined>) {
    return this.write(async () => {
      const o = this.orders.get(reference);
      if (!o) return undefined;
      const menu = structuredClone(this.menu); // worked on as a copy, kept only if fn succeeds
      const find = (sku: string) => menu.find((m) => m.sku === sku);
      const patch = await fn(structuredClone(o), {
        take: async (lines) => {
          const short = lines.filter((l) => (find(l.sku)?.stock ?? 0) < l.qty).map((l) => l.sku);
          if (!short.length) for (const l of lines) find(l.sku)!.stock -= l.qty;
          return short;
        },
        putBack: async (lines) => {
          for (const l of lines) {
            const m = find(l.sku);
            if (m) m.stock += l.qty;
          }
        },
      });
      this.menu = menu;
      Object.assign(o, structuredClone(patch ?? {}));
      return structuredClone(o);
    });
  }

  private open(phone: string) {
    return [...this.orders.values()].filter((o) => o.customerPhone === phone && OPEN_STATUSES.includes(o.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async openOrdersByPhone(phone: string) {
    return structuredClone(this.open(phone));
  }
  activateOrder(reference: string, paymentUrl: string) {
    return this.write(() => {
      const o = this.orders.get(reference);
      if (!o) return undefined;
      const replaced: string[] = [];
      if (o.status === "pending_payment") {
        o.paymentUrl = paymentUrl;
        for (const old of this.open(o.customerPhone)) {
          if (old.reference === reference || !replaceable(old)) continue;
          Object.assign(old, { status: "replaced", replacedBy: reference } satisfies Partial<Order>);
          replaced.push(old.reference);
        }
      }
      return { order: structuredClone(o), replaced };
    });
  }

  addMenuItem(item: MenuItem) {
    return this.write(() => {
      if (this.menu.some((m) => m.sku === item.sku)) return false;
      this.menu.push(structuredClone(item));
      return true;
    });
  }
  updateMenuItem(sku: string, patch: Partial<Pick<MenuItem, "name" | "priceNgn" | "active">>) {
    return this.write(() => {
      const m = this.menu.find((x) => x.sku === sku);
      return m && structuredClone(Object.assign(m, patch));
    });
  }
  setMenuStock(sku: string, stock: number, expected: number) {
    return this.write(() => {
      const m = this.menu.find((x) => x.sku === sku);
      if (!m) return undefined;
      const saved = m.stock === expected;
      if (saved) m.stock = stock;
      return { item: structuredClone(m), saved };
    });
  }
  saveZone(zone: DeliveryZone) {
    return this.write(() => {
      const z = this.zones.find((x) => x.zone === zone.zone);
      if (z) z.feeNgn = zone.feeNgn;
      else this.zones.push(structuredClone(zone));
    });
  }
  removeZone(zone: string) {
    return this.write(() => {
      const before = this.zones.length;
      this.zones = this.zones.filter((z) => z.zone !== zone);
      return this.zones.length < before;
    });
  }
}
