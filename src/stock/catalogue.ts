import { isCalendarDate, leftOn, type DeliveryZone, type MenuItem } from "../domain.js";
import type { Store } from "../store/types.js";
import { StockError } from "./kitchen.js";

const isPickup = (zone: string) => zone.toLowerCase() === "pickup";

const whole = (n: number, min: number, max: number) => Number.isInteger(n) && n >= min && n <= max;

export type DayLine = { item: MenuItem; own?: number; sold: number; left: number };

/** What the owner sells and where it's delivered: menu items, prices, how many per day, and delivery zones. */
export class Catalogue {
  constructor(private store: Store) {}

  menu() {
    return this.store.listMenu();
  }

  zones() {
    return this.store.listZones();
  }

  private details(input: { name: string; priceNgn: number; stock: number; active: boolean }) {
    const name = input.name.trim().replace(/\s+/g, " ");
    if (!name || name.length > 80) throw new StockError("The name must be 1 to 80 characters", "bad_input");
    if (!whole(input.priceNgn, 1, 10_000_000)) throw new StockError("The price must be a whole number of naira, 1 or more", "bad_input");
    return { name, priceNgn: input.priceNgn, stock: this.perDay(input.stock), active: input.active };
  }

  private perDay(n: number) {
    if (!whole(n, 0, 10_000)) throw new StockError("The number per day must be a whole number from 0 to 10,000", "bad_input");
    return n;
  }

  async addItem(input: { sku: string; name: string; priceNgn: number; stock: number; active: boolean }): Promise<MenuItem> {
    const sku = input.sku.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9-]{1,23}$/.test(sku)) throw new StockError("The code must be 2 to 24 letters, numbers or dashes, like JOL-SMALL", "bad_input");
    const item: MenuItem = { sku, ...this.details(input) };
    // Any spelling of an existing code is taken: codes are matched without case when ordering.
    const taken = (await this.store.listMenu()).some((m) => m.sku.toUpperCase() === sku);
    if (taken || !(await this.store.addMenuItem(item))) throw new StockError(`There is already an item with the code ${sku}`, "bad_input");
    return item;
  }

  async updateItem(sku: string, input: { name: string; priceNgn: number; stock: number; active: boolean }): Promise<MenuItem> {
    const item = await this.store.updateMenuItem(sku, this.details(input));
    if (!item) throw new StockError("No menu item with that code", "not_found");
    return item;
  }

  /** One delivery day: each item's usual number, its number for this day if set, what's sold and what's left. */
  async day(date: string): Promise<DayLine[]> {
    this.checkDate(date);
    const [menu, plan] = await Promise.all([this.store.listMenu(), this.store.dayPlan(date)]);
    return menu.map((item) => ({ item, own: plan.capacity[item.sku], sold: plan.sold[item.sku] ?? 0, left: leftOn(item, plan) }));
  }

  /** Give items their own number for a day; undefined goes back to the usual. All are checked before any is saved. */
  async setDay(date: string, numbers: Record<string, number | undefined>) {
    this.checkDate(date);
    const known = new Set((await this.store.listMenu()).map((m) => m.sku));
    const entries = Object.entries(numbers).filter(([sku]) => known.has(sku));
    for (const [, n] of entries) if (n !== undefined) this.perDay(n);
    const now = (await this.store.dayPlan(date)).capacity;
    for (const [sku, n] of entries) if (n !== now[sku]) await this.store.setDayCapacity(date, sku, n);
  }

  private checkDate(date: string) {
    if (!isCalendarDate(date)) throw new StockError("The day must be a date like 2026-11-07", "bad_input");
  }

  async saveZone(input: { zone: string; feeNgn: number }): Promise<DeliveryZone> {
    const name = input.zone.trim().replace(/\s+/g, " ");
    if (!name || name.length > 60) throw new StockError("The zone name must be 1 to 60 characters", "bad_input");
    if (!whole(input.feeNgn, 0, 1_000_000)) throw new StockError("The fee must be a whole number of naira, 0 or more", "bad_input");
    if (isPickup(name) && input.feeNgn !== 0) throw new StockError("Pickup is always free", "bad_input");
    // "yaba" edits Yaba instead of making a second zone.
    const existing = (await this.store.listZones()).find((z) => z.zone.toLowerCase() === name.toLowerCase());
    const zone = { zone: existing?.zone ?? name, feeNgn: input.feeNgn };
    await this.store.saveZone(zone);
    return zone;
  }

  async removeZone(zone: string) {
    if (isPickup(zone.trim())) throw new StockError("Pickup can't be removed", "bad_input");
    if (!(await this.store.removeZone(zone))) throw new StockError("No such zone", "not_found");
  }
}
