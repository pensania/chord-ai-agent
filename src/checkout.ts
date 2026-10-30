import { newReference, normalisePhone, quote, sameBasket, type Order, type RequestedItem } from "./domain.js";
import { Paystack, PaystackError } from "./paystack.js";
import type { Store } from "./store/types.js";

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString("en-NG")}`;

/** Why a payment is held, in words the owner can act on. */
export function explainHold(order: Pick<Order, "note" | "lines">): string {
  const note = order.note ?? "";
  const mismatch = /amount mismatch: paid (\d+) (\w+), expected (\d+)/.exec(note);
  if (mismatch) {
    const paid = mismatch[2] === "NGN" ? naira(Number(mismatch[1])) : `${Number(mismatch[1]) / 100} ${mismatch[2]}`;
    return `Paid ${paid}, but the order is ${naira(Number(mismatch[3]))}.`;
  }
  const oversold = /paid but oversold: ([^(]+)/.exec(note);
  if (oversold) {
    const skus = oversold[1].split(",").map((x) => x.trim());
    const names = skus.map((sku) => order.lines.find((l) => l.sku === sku)?.name ?? sku);
    return `Paid, but sold out before payment landed: ${names.join(", ")}. Offer a swap or a refund.`;
  }
  if (/paystack: reversed/.test(note)) return "The payment was reversed by the bank or card issuer. No money is held.";
  return note || "Held for a check.";
}

/** What the agent says when Tola takes over. The agent sends it as an ordinary reply: Chord's own
 * "connect to a teammate" handoff keeps its message internal and the customer sees nothing. */
export const PASS_TO_TOLA = "Let me get Tola to look at this personally. She'll reply here within 2 hours (8am to 8pm).";

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
    private opts: { callbackUrl?: string; placeholderEmailDomain?: string; now?: () => Date; /** Called once when an order becomes paid. Must not throw. */ onPaid?: (order: Order) => void;
      /** Called once when a payment is held for the owner (needs_review). Must not throw. */ onHeld?: (order: Order) => void;
    } = {},
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
    // The kitchen needs a day to shop and cook, so the rule is "tomorrow or later" by Lagos calendar
    // date. A rule in hours ("24 hours' notice") made the model refuse an evening order for
    // tomorrow afternoon, which the kitchen does take.
    if (neededBy && neededBy === this.today().slice(0, 10)) {
      return { ok: false, error: "same_day", today: this.today(), next_step: `Same-day orders need Tola. Reply to the customer yourself with: "${PASS_TO_TOLA}" Do not create a link, and do not transfer or escalate the conversation.` };
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

  /** Hold a payment for the owner instead of confirming it, and tell whoever is listening. */
  private async hold(reference: string, patch: Partial<Order>) {
    const held = await this.store.updateOrder(reference, { ...patch, status: "needs_review" });
    if (!held) return;
    try {
      this.opts.onHeld?.(held);
    } catch (e) {
      console.error("onHeld failed", e); // an alert failing must never change what the customer is told
    }
  }

  /** Payments waiting for the owner, oldest first. */
  async heldPayments(): Promise<Order[]> {
    const orders = await this.store.listOrders();
    return orders.filter((o) => o.status === "needs_review").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * The owner's call on a held payment. "accept" puts it in the kitchen queue as paid (after a swap
   * is agreed, or a short payment is settled another way); "close" ends it without confirming
   * (refund given, or the payment was reversed).
   */
  async review(reference: string, decision: "accept" | "close", by: string): Promise<Order> {
    const ref = reference.trim().toUpperCase();
    return this.withLock(ref, async () => {
      const order = await this.store.getOrder(ref);
      if (!order) throw new ReviewError("No order with that reference");
      if (order.status !== "needs_review") throw new ReviewError("This payment isn't waiting for a review any more");
      const why = order.note ? `: ${order.note}` : "";
      if (decision === "close") {
        return (await this.store.updateOrder(ref, { status: "closed", note: `closed after review by ${by}${why}` }))!;
      }
      const paid = (await this.store.updateOrder(ref, { status: "paid", paidAt: order.paidAt ?? this.now().toISOString(), note: `accepted after review by ${by}${why}` }))!;
      try {
        this.opts.onPaid?.(paid);
      } catch (e) {
        console.error("onPaid failed", e);
      }
      return paid;
    });
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
    if (order.status === "closed") {
      return { ok: true, status: "closed", reference, next_step: "Tola reviewed this payment and closed the order. Do not confirm it or send a new link for it. Say Tola will reply about it herself. Send that as your own reply; do not transfer or escalate the conversation." };
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
        await this.hold(reference, { note });
        return { ok: true, status: "needs_review", reference, note, next_step: "Do not confirm. Tell the customer a staff member will check their payment and reply shortly." };
      }
      const short = await this.store.consumeStock(order.lines);
      if (short.length > 0) {
        const note = `paid but oversold: ${short.join(", ")} (${source})`;
        await this.hold(reference, { paidAt: v.paidAt ?? this.now().toISOString(), note });
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
      const note = `paystack: ${v.status} ${v.gatewayResponse ?? ""}`.trim();
      if (v.status === "failed") await this.store.updateOrder(reference, { status: "payment_failed", note });
      else await this.hold(reference, { note });
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

export class ReviewError extends Error {}
