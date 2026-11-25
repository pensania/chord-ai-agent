import type { DeliveryZone, MenuItem, Order } from "../domain.js";

type Lines = { sku: string; qty: number }[];

/** Menu stock, inside `Store.transact`. */
export interface MenuStock {
  /** Take every line, or nothing at all. Returns the SKUs that didn't have enough. */
  take(lines: Lines): Promise<string[]>;
  putBack(lines: Lines): Promise<void>;
}

export interface Store {
  listMenu(): Promise<MenuItem[]>;
  listZones(): Promise<DeliveryZone[]>;

  createOrder(order: Order): Promise<void>;
  getOrder(reference: string): Promise<Order | undefined>;
  updateOrder(reference: string, patch: Partial<Order>): Promise<Order | undefined>;
  listOrders(): Promise<Order[]>;

  /**
   * Change one order and the menu stock together. `fn` sees the order as it is now, with other
   * writers kept out; the patch it returns is saved with the stock changes, or none of it is.
   * Returning undefined changes nothing on the order. Resolves to the order afterwards.
   */
  transact(reference: string, fn: (order: Order, stock: MenuStock) => Promise<Partial<Order> | undefined>): Promise<Order | undefined>;

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
  /** Change an item's details. Stock is left alone, so a sale made meanwhile isn't undone. */
  updateMenuItem(sku: string, patch: Partial<Pick<MenuItem, "name" | "priceNgn" | "active">>): Promise<MenuItem | undefined>;
  /** Set the stock, only if it's still `expected`. Returns the item, and whether it changed. */
  setMenuStock(sku: string, stock: number, expected: number): Promise<{ item: MenuItem; saved: boolean } | undefined>;
  /** Add a zone or change its fee. */
  saveZone(zone: DeliveryZone): Promise<void>;
  removeZone(zone: string): Promise<boolean>;
}
