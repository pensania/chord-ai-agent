import type { DeliveryZone, MenuItem, Order } from "../domain.js";

export interface Store {
  listMenu(): Promise<MenuItem[]>;
  listZones(): Promise<DeliveryZone[]>;
  /** Decrement stock for a paid order. Returns SKUs that no longer had enough stock. */
  consumeStock(lines: { sku: string; qty: number }[]): Promise<string[]>;
  createOrder(order: Order): Promise<void>;
  getOrder(reference: string): Promise<Order | undefined>;
  updateOrder(reference: string, patch: Partial<Order>): Promise<Order | undefined>;
  findOpenOrderByPhone(phone: string): Promise<Order | undefined>;
}
