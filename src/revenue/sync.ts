import type { Order } from "../domain.js";
import type { StageEvent } from "../ops/operations.js";
import type { RevenueOutbox } from "./outbox.js";

/** The state Leadaut should record. Leadaut counts processing, delivered and picked-up as paid. */
export type WcStatus = "processing" | "delivered" | "picked-up" | "refunded";

const money = (ngn: number) => ngn.toFixed(2);
/** WooCommerce's *_gmt dates: UTC with no offset. */
const gmt = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 19) : null);

/**
 * A paid order in WooCommerce's order shape, which Leadaut's store webhook already reads.
 * Leadaut finds or creates the customer by phone (WhatsApp number), takes the name from
 * billing, and records the order once per reference, so a resend only updates it.
 */
export function wcOrder(order: Order, status: WcStatus, at = new Date().toISOString()) {
  const [first, ...rest] = order.customerName.trim().split(/\s+/);
  const pickup = order.deliveryZone.toLowerCase() === "pickup";
  return {
    id: order.reference,
    number: order.reference,
    status,
    currency: "NGN",
    total: money(order.totalNgn),
    shipping_total: money(order.deliveryFeeNgn),
    customer_id: 0,
    created_via: "chord_agent",
    payment_method: "paystack",
    payment_method_title: "Paystack",
    date_created_gmt: gmt(order.createdAt),
    date_paid_gmt: gmt(order.paidAt),
    date_completed_gmt: status === "delivered" || status === "picked-up" ? gmt(at) : null,
    billing: { first_name: first ?? "", last_name: rest.join(" "), phone: order.customerPhone, email: "", city: pickup ? "" : order.deliveryZone, country: "NG" },
    line_items: order.lines.map((l) => ({
      name: l.name,
      sku: l.sku,
      quantity: l.qty,
      price: l.unitPriceNgn,
      subtotal: money(l.lineTotalNgn),
      total: money(l.lineTotalNgn),
    })),
    refunds: status === "refunded" ? [{ total: money(-order.totalNgn), reason: "Cancelled after payment" }] : [],
    meta_data: [
      { key: "source", value: "whatsapp" },
      { key: "channel", value: "chord_agent" },
      { key: "fulfilment", value: pickup ? "pickup" : "delivery" },
      { key: "delivery_zone", value: order.deliveryZone },
      ...(order.neededBy ? [{ key: "needed_by", value: order.neededBy }] : []),
    ],
  };
}

/** Sends paid orders, and the stage changes that matter for revenue, to Leadaut. */
export class RevenueSync {
  constructor(
    private outbox: RevenueOutbox,
    private opts: { now?: () => Date } = {},
  ) {}

  private send(order: Order, topic: "order.created" | "order.updated", status: WcStatus) {
    const at = (this.opts.now?.() ?? new Date()).toISOString();
    this.outbox.enqueue({ event_id: `${order.reference}:${status}`, topic, key: order.reference, occurred_at: at, body: wcOrder(order, status, at) });
  }

  /** A verified payment: Leadaut records the order and creates or updates the customer. */
  paid(order: Order) {
    this.send(order, "order.created", "processing");
  }

  /** Delivered or picked up (still paid, now fulfilled), or cancelled after payment (refunded). */
  stage(e: StageEvent, order: Order) {
    if (e.to === "delivered") this.send(order, "order.updated", "delivered");
    if (e.to === "picked_up") this.send(order, "order.updated", "picked-up");
    if (e.to === "cancelled") this.send(order, "order.updated", "refunded");
  }
}
