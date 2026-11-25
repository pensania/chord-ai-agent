import type { DayPlan, DeliveryZone, MenuItem, Order } from "../domain.js";

export interface Store {
  listMenu(): Promise<MenuItem[]>;
  listZones(): Promise<DeliveryZone[]>;

  createOrder(order: Order): Promise<void>;
  getOrder(reference: string): Promise<Order | undefined>;
  updateOrder(reference: string, patch: Partial<Order>): Promise<Order | undefined>;
  listOrders(): Promise<Order[]>;

  /**
   * Change one order. `fn` sees the order as it is now, with other writers kept out. `short` says
   * which of its SKUs the order's delivery day can't cover, and keeps that day's capacity from
   * being taken by anyone else until the change is saved. Returning undefined changes nothing.
   * Resolves to the order afterwards.
   */
  transact(reference: string, fn: (order: Order, short: () => Promise<string[]>) => Promise<Partial<Order> | undefined>): Promise<Order | undefined>;

  /** What's sold, and any capacity set, for one delivery day. */
  dayPlan(date: string): Promise<DayPlan>;
  /** Give an item its own capacity for a day, or undefined to go back to the usual. */
  setDayCapacity(date: string, sku: string, capacity: number | undefined): Promise<void>;

  /** Unpaid orders for a customer (pending or failed), newest first. */
  openOrdersByPhone(phone: string): Promise<Order[]>;

  /**
   * Give a pending order its payment link and mark the customer's other unpaid orders as replaced
   * by it, together, so one customer never has two live links. If the order isn't pending any
   * more (a newer one replaced it first), nothing changes.
   */
  activateOrder(reference: string, paymentUrl: string): Promise<{ order: Order; replaced: string[] } | undefined>;

  /** Add an item. False if the SKU is taken. */
  addMenuItem(item: MenuItem): Promise<boolean>;
  updateMenuItem(sku: string, patch: Partial<Omit<MenuItem, "sku">>): Promise<MenuItem | undefined>;
  /** Add a zone or change its fee. */
  saveZone(zone: DeliveryZone): Promise<void>;
  removeZone(zone: string): Promise<boolean>;
}
