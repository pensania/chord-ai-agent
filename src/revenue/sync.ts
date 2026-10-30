import type { Order } from "../domain.js";
import type { StageEvent } from "../ops/operations.js";
import type { RevenueEvent, RevenueOutbox } from "./outbox.js";

const BUSINESS = "Mama Tola's Kitchen";

/** The customer as a lead: one per WhatsApp number, which is the stable key. */
export function leadOf(order: Order) {
  return {
    external_id: order.customerPhone,
    phone: order.customerPhone,
    name: order.customerName,
    source: "whatsapp",
    channel: "chord_agent",
    business: BUSINESS,
    area: order.deliveryZone,
  };
}

/** A paid order as a transaction. Amounts are whole naira. */
export function transactionOf(order: Order) {
  return {
    reference: order.reference,
    customer_external_id: order.customerPhone,
    customer_name: order.customerName,
    currency: "NGN",
    amount_ngn: order.totalNgn,
    subtotal_ngn: order.subtotalNgn,
    delivery_fee_ngn: order.deliveryFeeNgn,
    items: order.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unit_price_ngn: l.unitPriceNgn, total_ngn: l.lineTotalNgn })),
    fulfilment: order.deliveryZone.toLowerCase() === "pickup" ? "pickup" : "delivery",
    delivery_zone: order.deliveryZone,
    needed_by: order.neededBy,
    payment_provider: "paystack",
    paid_at: order.paidAt,
    created_at: order.createdAt,
  };
}

/** Turns business events into revenue events and queues them. */
export class RevenueSync {
  constructor(
    private outbox: RevenueOutbox,
    private opts: { now?: () => Date } = {},
  ) {}

  private at() {
    return (this.opts.now?.() ?? new Date()).toISOString();
  }

  private push(event: Omit<RevenueEvent, "occurred_at"> & { occurred_at?: string }) {
    this.outbox.enqueue({ occurred_at: this.at(), ...event });
  }

  /** A verified payment: make sure the customer exists as a lead, then record the transaction. */
  paid(order: Order) {
    this.push({ event_type: "customer.upserted", event_id: `${order.reference}:customer`, data: { lead: leadOf(order) } });
    this.push({ event_type: "order.paid", event_id: `${order.reference}:paid`, occurred_at: order.paidAt, data: { transaction: transactionOf(order) } });
  }

  /** Order stages that change revenue: delivered or picked up (fulfilled), cancelled (refund due). */
  stage(e: StageEvent, order: Order) {
    if (e.to === "delivered" || e.to === "picked_up") {
      this.push({ event_type: "order.fulfilled", event_id: `${order.reference}:fulfilled`, data: { reference: order.reference, customer_external_id: order.customerPhone, how: e.to, amount_ngn: order.totalNgn } });
    }
    if (e.to === "cancelled") {
      this.push({ event_type: "order.cancelled", event_id: `${order.reference}:cancelled`, data: { reference: order.reference, customer_external_id: order.customerPhone, amount_ngn: order.totalNgn, refund_due: true, stage_when_cancelled: e.from } });
    }
  }
}
