import { newReference, normalisePhone, quote, sameBasket, type Order, type RequestedItem } from "./domain.js";
import { Paystack, PaystackError } from "./paystack.js";
import type { Store } from "./store/types.js";

/**
 * Every result carries `ok` and a plain-English `next_step` so the model
 * knows what to tell the customer without guessing.
 */
export type ToolResult = Record<string, unknown> & { ok: boolean; next_step: string };

const PENDING_REUSE_MS = 30 * 60 * 1000;

export class Checkout {
  private locks = new Map<string, Promise<unknown>>();

  constructor(
    private store: Store,
    private paystack: Paystack,
    private opts: { callbackUrl?: string; placeholderEmailDomain?: string; now?: () => Date; /** Called once when an order becomes paid. Must not throw. */ onPaid?: (order: Order) => void } = {},
  ) {}

  private now() {
    return this.opts.now?.() ?? new Date();
  }

  /** Serialise work per order so the webhook and the chat can't both mark it paid and double-count stock. */
  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /** Lagos date and weekday, so the model can turn "Saturday" into a calendar date. */
  private today() {
    const d = new Date(this.now().getTime() + 60 * 60 * 1000);
    return `${d.toISOString().slice(0, 10)} (${d.toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })})`;
  }

  async checkStock(items?: RequestedItem[], deliveryZone?: string): Promise<ToolResult> {
    const [menu, zones] = await Promise.all([this.store.listMenu(), this.store.listZones()]);
    if (menu.length === 0) {
      return { ok: false, error: "menu_empty", next_step: "The menu could not be loaded. Apologise and say a staff member will reply shortly. Do not invent items or prices." };
    }
    const available = menu.filter((m) => m.active).map((m) => ({ sku: m.sku, name: m.name, price_ngn: m.priceNgn, in_stock: m.stock }));
    if (!items || items.length === 0) {
      return { ok: true, today: this.today(), menu: available, delivery_zones: zones.map((z) => ({ zone: z.zone, fee_ngn: z.feeNgn })), next_step: "Help the customer choose. Only offer items with in_stock > 0." };
    }
    const q = quote(menu, zones, items, deliveryZone ?? "Pickup");
    if (!q.ok) {
      return { ok: false, problems: q.problems, menu: available, next_step: "Explain each problem briefly and suggest the closest in-stock alternative. Do not create a payment link yet." };
    }
    return {
      ok: true,
      lines: q.lines,
      subtotal_ngn: q.subtotalNgn,
      delivery_fee_ngn: q.deliveryFeeNgn,
      total_ngn: q.totalNgn,
      zone: q.zone,
      today: this.today(),
      next_step: "Read the order and total back to the customer and ask them to confirm before creating a payment link.",
    };
  }

  async createPaymentLink(input: {
    customerName: string;
    customerPhone: string;
    customerEmail?: string;
    items: RequestedItem[];
    deliveryZone: string;
    deliveryAddress: string;
    neededBy?: string;
  }): Promise<ToolResult> {
    const phone = normalisePhone(input.customerPhone);
    const neededBy = input.neededBy?.trim() || undefined;
    if (neededBy && (!/^\d{4}-\d{2}-\d{2}$/.test(neededBy) || Number.isNaN(Date.parse(neededBy)))) {
      return { ok: false, error: "bad_date", next_step: "needed_by must be a date like 2026-11-07. Work out the calendar date the customer means and call again." };
    }
    if (neededBy && neededBy < this.today().slice(0, 10)) {
      return { ok: false, error: "date_in_past", today: this.today(), next_step: "That date has already passed. Check the day with the customer, using today's date given here." };
    }
    const [menu, zones] = await Promise.all([this.store.listMenu(), this.store.listZones()]);
    const q = quote(menu, zones, input.items, input.deliveryZone);
    if (!q.ok) {
      return { ok: false, problems: q.problems, next_step: "Something changed since the quote. Explain the problem and offer alternatives. No link was created." };
    }

    // Idempotency: same customer, same basket, still unpaid and recent -> return the existing link.
    const open = await this.store.findOpenOrderByPhone(phone);
    if (open && open.paymentUrl && sameBasket(open, q.lines, q.zone) && this.now().getTime() - Date.parse(open.createdAt) < PENDING_REUSE_MS) {
      return {
        ok: true,
        reused: true,
        reference: open.reference,
        payment_url: open.paymentUrl,
        total_ngn: open.totalNgn,
        next_step: "This is the same unpaid order as before. Resend the same link. Do not create another one.",
      };
    }

    const reference = newReference(this.now());
    const order: Order = {
      reference,
      createdAt: this.now().toISOString(),
      customerName: input.customerName.trim(),
      customerPhone: phone,
      lines: q.lines,
      deliveryZone: q.zone,
      deliveryAddress: input.deliveryAddress.trim(),
      subtotalNgn: q.subtotalNgn,
      deliveryFeeNgn: q.deliveryFeeNgn,
      totalNgn: q.totalNgn,
      status: "pending_payment",
      neededBy,
    };
    await this.store.createOrder(order);

    try {
      const { authorizationUrl } = await this.paystack.initialize({
        // Paystack requires an email. WhatsApp customers often don't give one, so use a placeholder per phone.
        // The domain must have a real TLD: Paystack rejects reserved ones like ".example".
        email: input.customerEmail?.trim() || `${phone.replace(/\D/g, "")}@${this.opts.placeholderEmailDomain ?? "example.com"}`,
        amountKobo: q.totalNgn * 100,
        reference,
        callbackUrl: this.opts.callbackUrl,
        metadata: { customer_name: order.customerName, customer_phone: phone, zone: q.zone },
      });
      await this.store.updateOrder(reference, { paymentUrl: authorizationUrl });
      return {
        ok: true,
        reference,
        payment_url: authorizationUrl,
        total_ngn: q.totalNgn,
        next_step: "Send the payment link and the reference. Tell the customer to reply 'paid' when done. Never mark the order as confirmed yourself.",
      };
    } catch (e) {
      const err = e instanceof PaystackError ? e : new PaystackError(String(e), "provider_down");
      await this.store.updateOrder(reference, { status: "payment_failed", note: `link not created: ${err.message}` });
      return {
        ok: false,
        error: err.kind === "provider_down" ? "payment_provider_unavailable" : "payment_link_rejected",
        detail: err.message,
        next_step:
          err.kind === "provider_down"
            ? "The payment system is not responding. Apologise, keep the order details, and offer to try again in a few minutes."
            : "The payment link could not be created. Apologise and say a staff member will follow up. Do not retry more than once.",
      };
    }
  }

  async verifyPayment(reference: string, source: "chat" | "webhook" = "chat"): Promise<ToolResult> {
    return this.withLock(reference, () => this.verifyUnlocked(reference.trim().toUpperCase(), source));
  }

  private async verifyUnlocked(reference: string, source: "chat" | "webhook"): Promise<ToolResult> {
    const order = await this.store.getOrder(reference);
    if (!order) {
      return { ok: false, error: "unknown_reference", next_step: "No order has this reference. Ask the customer to check it, or look at the reference you sent them earlier." };
    }
    if (order.status === "paid") {
      return { ok: true, status: "paid", reference, total_ngn: order.totalNgn, already_confirmed: true, next_step: "Already confirmed. Reassure the customer. Do not charge again." };
    }
    if (order.status === "needs_review") {
      return { ok: true, status: "needs_review", reference, note: order.note, next_step: "A staff member is reviewing this payment. Tell the customer they will hear back shortly." };
    }

    let v;
    try {
      v = await this.paystack.verify(reference);
    } catch (e) {
      if (e instanceof PaystackError && e.kind === "not_found") {
        return { ok: true, status: "not_paid_yet", reference, payment_url: order.paymentUrl, next_step: "No payment yet. Resend the link and ask the customer to complete it." };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: "payment_provider_unavailable", detail: msg, next_step: "Could not reach the payment system. Do not confirm the order. Ask the customer to wait a minute and try again." };
    }

    if (v.status === "success") {
      const expectedKobo = order.totalNgn * 100;
      if (v.amountKobo !== expectedKobo || v.currency !== "NGN") {
        const note = `amount mismatch: paid ${v.amountKobo} ${v.currency}, expected ${expectedKobo} NGN`;
        await this.store.updateOrder(reference, { status: "needs_review", note });
        return { ok: true, status: "needs_review", reference, note, next_step: "Do not confirm. Tell the customer a staff member will check their payment and reply shortly." };
      }
      const short = await this.store.consumeStock(order.lines);
      if (short.length > 0) {
        const note = `paid but oversold: ${short.join(", ")} (${source})`;
        await this.store.updateOrder(reference, { status: "needs_review", paidAt: v.paidAt ?? this.now().toISOString(), note });
        return { ok: true, status: "needs_review", reference, note, next_step: "Payment received but an item sold out. Apologise, say the owner will call to offer a swap or a refund. Do not promise delivery." };
      }
      const paidOrder = await this.store.updateOrder(reference, { status: "paid", paidAt: v.paidAt ?? this.now().toISOString(), note: `verified via ${source}` });
      if (paidOrder) {
        try {
          this.opts.onPaid?.(paidOrder);
        } catch (e) {
          console.error("onPaid failed", e); // reporting must never undo a confirmed payment
        }
      }
      return {
        ok: true,
        status: "paid",
        reference,
        total_ngn: order.totalNgn,
        lines: order.lines,
        zone: order.deliveryZone,
        next_step: "Payment verified. Confirm the order, the delivery zone, and that the kitchen will message on dispatch.",
      };
    }

    if (v.status === "failed" || v.status === "reversed") {
      await this.store.updateOrder(reference, { status: v.status === "failed" ? "payment_failed" : "needs_review", note: `paystack: ${v.status} ${v.gatewayResponse ?? ""}`.trim() });
      return {
        ok: true,
        status: v.status === "failed" ? "payment_failed" : "needs_review",
        reason: v.gatewayResponse,
        reference,
        next_step:
          v.status === "failed"
            ? "The payment failed. Tell the customer kindly, give the reason if it's clear, and offer a fresh payment link with create_payment_link."
            : "The payment was reversed. A staff member must handle this. Do not confirm.",
      };
    }

    // abandoned / ongoing / pending / queued: not paid yet, link may still work
    return { ok: true, status: "not_paid_yet", paystack_status: v.status, reference, payment_url: order.paymentUrl, next_step: "Payment not completed yet. Resend the link and ask them to finish, then say 'paid'." };
  }
}
