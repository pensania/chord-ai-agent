import seed from "../../data/seed.json" with { type: "json" };
import { OPEN_STATUSES, replaceable, shortFor, soldOn, type DayPlan, type DeliveryZone, type MenuItem, type Order } from "../domain.js";
import { KeyedLock } from "../lock.js";
import type { Store } from "./types.js";

export class MemoryStore implements Store {
  private menu: MenuItem[];
  private zones: DeliveryZone[];
  private orders = new Map<string, Order>();
  /** Capacity set for one day, by "date|sku". */
  private capacity = new Map<string, number>();
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

  private plan(date?: string): DayPlan {
    if (!date) return { sold: {}, capacity: {} };
    const capacity = Object.fromEntries([...this.capacity].filter(([k]) => k.startsWith(`${date}|`)).map(([k, n]) => [k.slice(date.length + 1), n]));
    return { sold: soldOn(date, [...this.orders.values()]), capacity };
  }

  transact(reference: string, fn: (order: Order, short: () => Promise<string[]>) => Promise<Partial<Order> | undefined>) {
    return this.write(async () => {
      const o = this.orders.get(reference);
      if (!o) return undefined;
      const patch = await fn(structuredClone(o), async () => shortFor(o.lines, this.menu, this.plan(o.neededBy)));
      Object.assign(o, structuredClone(patch ?? {}));
      return structuredClone(o);
    });
  }

  async dayPlan(date: string) {
    return this.plan(date);
  }
  setDayCapacity(date: string, sku: string, capacity: number | undefined) {
    return this.write(() => {
      if (capacity === undefined) this.capacity.delete(`${date}|${sku}`);
      else this.capacity.set(`${date}|${sku}`, capacity);
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
  updateMenuItem(sku: string, patch: Partial<Omit<MenuItem, "sku">>) {
    return this.write(() => {
      const m = this.menu.find((x) => x.sku === sku);
      return m && structuredClone(Object.assign(m, patch));
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
