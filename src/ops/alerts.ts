import { randomUUID } from "node:crypto";
import { explainHold } from "../checkout.js";
import type { Order } from "../domain.js";
import type { StageEvent } from "./operations.js";
import type { OpsStore, Role, Stage, Staff } from "./types.js";

/**
 * Tells the right people when an order needs them, and keeps every open portal page up to date.
 *
 * Who hears about what (the owner always does, and nobody is told about their own move):
 *   new paid order         → intake on duty
 *   payment held for review → intake on duty (only the owner can settle it)
 *   accepted               → the assigned cook (or the kitchen on duty)
 *   ready, for delivery    → dispatch on duty
 *   ready, for pickup      → intake on duty
 *   back from the road     → dispatch on duty
 *   out for delivery       → the assigned rider
 *   delivered / picked up  → intake on duty
 *   cancelled              → the cook, the rider and intake on duty
 */

export type Alert = {
  id: string;
  at: string;
  reference: string;
  title: string;
  body: string;
  url: string;
  /** "owner" or "staff:<id>". */
  audience: string[];
};

export type LiveMessage = { type: "refresh" } | { type: "alert"; alert: Alert };

/** Sends an alert by email to the people who have an address. Optional. */
export interface AlertMailer {
  send(to: string, subject: string, text: string, url: string): Promise<void>;
}

type Duty = { today(): string; onDuty(date: string, role: Role): Promise<Staff[]> };

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const isPickup = (o: Order) => o.deliveryZone.toLowerCase() === "pickup";
const items = (o: Order) => o.lines.map((l) => `${l.qty}× ${l.name}`).join(", ");
const first = (name: string) => name.replace(/\s*\(.*\)$/, "").split(/\s+/)[0];

export class AlertHub {
  private subscribers = new Map<string, Set<(m: LiveMessage) => void>>();
  private recentAlerts: Alert[] = [];

  constructor(
    private ops: OpsStore,
    private duty: Duty,
    private opts: { now?: () => Date; mailer?: AlertMailer; ownerEmail?: string; baseUrl?: string; log?: (msg: string, extra?: Record<string, unknown>) => void } = {},
  ) {}

  /** A portal page listening for updates. Returns the function that stops listening. */
  subscribe(key: string, send: (m: LiveMessage) => void) {
    const set = this.subscribers.get(key) ?? new Set();
    set.add(send);
    this.subscribers.set(key, set);
    return () => {
      set.delete(send);
      if (!set.size) this.subscribers.delete(key);
    };
  }

  /** How many portal pages are open, for logs and tests. */
  listeners() {
    let n = 0;
    for (const s of this.subscribers.values()) n += s.size;
    return n;
  }

  /** The latest alerts for one person, newest first. */
  recent(key: string, limit = 20) {
    return this.recentAlerts.filter((a) => a.audience.includes(key)).slice(-limit).reverse();
  }

  /** A payment was verified: the order is now in the queue. */
  async newOrder(order: Order) {
    const intake = await this.onDuty("intake");
    await this.raise(
      {
        reference: order.reference,
        title: `New order ${order.reference} · ${naira(order.totalNgn)}`,
        body: `${order.customerName} · ${items(order)}${order.neededBy ? ` · for ${order.neededBy}` : ""}. Accept it on the queue.`,
      },
      intake.map((s) => s.id),
    );
  }

  /** A payment was held instead of confirmed (wrong amount, sold out, reversed). */
  async held(order: Order) {
    const intake = await this.onDuty("intake");
    await this.raise(
      {
        reference: order.reference,
        title: `Check payment for ${order.reference}`,
        body: `${explainHold(order)} ${order.customerName}, ${order.customerPhone}. The customer was told someone will reply shortly.`,
      },
      intake.map((s) => s.id),
    );
  }

  /** Ask every open page to reload its board, e.g. after the owner settles a held payment. */
  refresh() {
    this.broadcast({ type: "refresh" });
  }

  /** An order moved. Called after the move is saved. */
  async stageChanged(e: StageEvent, order: Order) {
    const ops = await this.ops.getOrderOps(e.reference);
    const ids: string[] = [];
    let title = "";
    let body = "";
    const ref = e.reference;
    const who = isPickup(order) ? "pickup" : `delivery to ${order.deliveryZone}`;
    const to: Stage = e.to;
    if (to === "accepted") {
      if (ops?.cookId) ids.push(ops.cookId);
      else ids.push(...(await this.onDuty("kitchen")).map((s) => s.id));
      const cook = ops?.cookId ? await this.ops.getStaff(ops.cookId) : undefined;
      title = `Cook ${ref}`;
      body = `${items(order)}. ${cook ? `Assigned to ${first(cook.name)}.` : "No cook on the rota today, so it's open to the kitchen."}`;
    } else if (to === "cooking") {
      title = `${ref} is cooking`;
      body = items(order);
    } else if (to === "ready" && e.from === "out_for_delivery") {
      ids.push(...(await this.onDuty("dispatch")).map((s) => s.id));
      title = `${ref} came back to the kitchen`;
      body = `Send it out again for ${who}.`;
    } else if (to === "ready") {
      ids.push(...(await this.onDuty(isPickup(order) ? "intake" : "dispatch")).map((s) => s.id));
      title = isPickup(order) ? `${ref} is ready for pickup` : `${ref} is ready for a rider`;
      body = isPickup(order) ? `${order.customerName} will collect it. Mark it picked up when they do.` : `Dispatch it for ${who}.`;
    } else if (to === "out_for_delivery") {
      if (ops?.riderId) ids.push(ops.riderId);
      title = `Deliver ${ref} to ${order.deliveryZone}`;
      body = `${order.customerName}, ${order.customerPhone}. ${order.deliveryAddress}`;
    } else if (to === "delivered" || to === "picked_up") {
      ids.push(...(await this.onDuty("intake")).map((s) => s.id));
      title = `${ref} ${to === "delivered" ? "delivered" : "picked up"}`;
      body = `${order.customerName} · ${naira(order.totalNgn)}`;
    } else if (to === "cancelled") {
      ids.push(...[ops?.cookId, ops?.riderId].filter((x): x is string => Boolean(x)), ...(await this.onDuty("intake")).map((s) => s.id));
      title = `${ref} was cancelled`;
      body = `Stop work on it. A refund of ${naira(order.totalNgn)} is due to ${order.customerName}.`;
    }
    if (!title) return this.broadcast({ type: "refresh" });
    await this.raise({ reference: ref, title, body }, ids, e.by);
  }

  private async onDuty(role: Role) {
    return this.duty.onDuty(this.duty.today(), role);
  }

  private async raise(a: Pick<Alert, "reference" | "title" | "body">, staffIds: string[], by?: string) {
    const audience = [...new Set(["owner", ...staffIds.map((id) => `staff:${id}`)])].filter((k) => k !== (by === "owner" ? "owner" : `staff:${by}`));
    const alert: Alert = { id: randomUUID(), at: (this.opts.now?.() ?? new Date()).toISOString(), url: `/admin/orders/${encodeURIComponent(a.reference)}`, audience, ...a };
    this.recentAlerts.push(alert);
    if (this.recentAlerts.length > 300) this.recentAlerts.splice(0, this.recentAlerts.length - 300);
    // Everyone's board refreshes; only the people the order needs get the alert itself.
    for (const [key, set] of this.subscribers) {
      const m: LiveMessage = audience.includes(key) ? { type: "alert", alert } : { type: "refresh" };
      for (const send of set) send(m);
    }
    this.opts.log?.("order_alert", { reference: a.reference, title: a.title, to: audience });
    await this.email(alert);
  }

  private broadcast(m: LiveMessage) {
    for (const set of this.subscribers.values()) for (const send of set) send(m);
  }

  /** Email is best effort: a mail failure never blocks the kitchen. */
  private async email(alert: Alert) {
    const mailer = this.opts.mailer;
    if (!mailer) return;
    const link = this.opts.baseUrl ? `${this.opts.baseUrl.replace(/\/$/, "")}${alert.url}` : alert.url;
    const to: string[] = [];
    for (const key of alert.audience) {
      if (key === "owner") {
        if (this.opts.ownerEmail) to.push(this.opts.ownerEmail);
      } else {
        const s = await this.ops.getStaff(key.slice(6));
        if (s?.active && s.email) to.push(s.email);
      }
    }
    await Promise.all(
      [...new Set(to)].map((addr) =>
        mailer.send(addr, alert.title, alert.body, link).catch((e) => this.opts.log?.("alert_email_failed", { reference: alert.reference, error: e instanceof Error ? e.message : String(e) })),
      ),
    );
  }
}

/** Sends alert emails through Resend's HTTP API. */
export class ResendMailer implements AlertMailer {
  constructor(private cfg: { apiKey: string; from: string; fetchImpl?: typeof fetch }) {}

  async send(to: string, subject: string, text: string, url: string) {
    const res = await (this.cfg.fetchImpl ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.cfg.from, to: [to], subject, text: `${text}\n\nOpen the order: ${url}\n\nMama Tola's Kitchen back office` }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}`);
  }
}
