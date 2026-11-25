import { paidKobo, refundKobo, type Order } from "../domain.js";
import type { StageEvent } from "../ops/operations.js";
import type { RevenueOutbox } from "./outbox.js";

/**
 * The state Leadaut should record. Leadaut counts all but `refunded` as paid, so `refunded` is only
 * for an order whose money all went back. A partial refund stays `completed` with a refund line,
 * as WooCommerce sends it.
 */
export type WcStatus = "processing" | "delivered" | "picked-up" | "completed" | "refunded";

const money = (ngn: number) => ngn.toFixed(2);
/** WooCommerce's *_gmt dates: UTC with no offset. */
const gmt = (iso?: string) => (iso ? new Date(iso).toISOString().slice(0, 19) : null);

/**
 * A paid order in WooCommerce's order shape, which Leadaut's store webhook already reads.
 * Leadaut finds or creates the customer by phone (WhatsApp number), takes the name from
 * billing, and records the order once per reference, so a resend only updates it.
 *
 * `total` is the money actually received, and `refunds` what went back, not the order's price.
 */
export function wcOrder(order: Order, status: WcStatus, at = new Date().toISOString()) {
  const [first, ...rest] = order.customerName.trim().split(/\s+/);
  const refunded = refundKobo(order);
  const pickup = order.deliveryZone.toLowerCase() === "pickup";
  return {
    id: order.reference,
    number: order.reference,
    status,
    currency: "NGN",
    total: money(paidKobo(order) / 100),
    shipping_total: money(order.deliveryFeeNgn),
    customer_id: 0,
    created_via: "chord_agent",
    payment_method: "paystack",
    payment_method_title: "Paystack",
    date_created_gmt: gmt(order.createdAt),
    date_paid_gmt: gmt(order.paidAt),
    date_completed_gmt: status === "delivered" || status === "picked-up" || status === "completed" ? gmt(at) : null,
    billing: { first_name: first ?? "", last_name: rest.join(" "), phone: order.customerPhone, email: "", city: pickup ? "" : order.deliveryZone, country: "NG" },
    line_items: order.lines.map((l) => ({
      name: l.name,
      sku: l.sku,
      quantity: l.qty,
      price: l.unitPriceNgn,
      subtotal: money(l.lineTotalNgn),
      total: money(l.lineTotalNgn),
    })),
    refunds: refunded > 0 ? [{ total: money(-refunded / 100), reason: order.cancelledAt ? "Cancelled after payment" : "Refunded after payment" }] : [],
    meta_data: [
      { key: "source", value: "whatsapp" },
      { key: "channel", value: "chord_agent" },
      { key: "fulfilment", value: pickup ? "pickup" : "delivery" },
      { key: "delivery_zone", value: order.deliveryZone },
      ...(paidKobo(order) !== order.totalNgn * 100 ? [{ key: "order_total", value: money(order.totalNgn) }] : []),
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

  private send(order: Order, topic: "order.created" | "order.updated" | "order.refunded", status: WcStatus, suffix = "") {
    const at = (this.opts.now?.() ?? new Date()).toISOString();
    this.outbox.enqueue({ event_id: `${order.reference}:${status}${suffix}`, topic, key: order.reference, occurred_at: at, body: wcOrder(order, status, at) });
  }

  /** A verified payment: Leadaut records the order and creates or updates the customer. */
  paid(order: Order) {
    this.send(order, "order.created", "processing");
  }

  /** The refund on an order changed, through a cancellation or Paystack. Each change is sent once, with the total refunded so far. */
  refund(order: Order) {
    if (!order.refundSeq) return;
    const suffix = order.refundSeq > 1 ? `:${order.refundSeq}` : "";
    if (refundKobo(order) >= paidKobo(order)) this.send(order, "order.refunded", "refunded", suffix);
    else this.send(order, "order.updated", "completed", suffix);
  }

  /** Delivered or picked up (still paid, now fulfilled), or cancelled after payment. */
  stage(e: StageEvent, order: Order) {
    if (e.to === "cancelled") return this.refund(order);
    // All the money went back: "delivered" would count the order as paid again.
    if (refundKobo(order) >= paidKobo(order)) return;
    if (e.to === "delivered") this.send(order, "order.updated", "delivered");
    if (e.to === "picked_up") this.send(order, "order.updated", "picked-up");
  }
}
