export type MenuItem = {
  sku: string;
  name: string;
  priceNgn: number;
  stock: number;
  active: boolean;
};

export type DeliveryZone = { zone: string; feeNgn: number };

export type OrderLine = { sku: string; name: string; qty: number; unitPriceNgn: number; lineTotalNgn: number };

export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "payment_failed"
  | "needs_review" // paid but something is off (amount mismatch, oversold, reversed); held for the owner
  | "closed" // the owner reviewed a held payment and closed it (refund or no money); never confirmed
  | "replaced"; // the customer got a newer link before paying this one; a late payment on it is held

export type Order = {
  reference: string;
  createdAt: string;
  customerName: string;
  customerPhone: string;
  lines: OrderLine[];
  deliveryZone: string;
  deliveryAddress: string;
  subtotalNgn: number;
  deliveryFeeNgn: number;
  totalNgn: number;
  status: OrderStatus;
  paymentUrl?: string;
  paidAt?: string;
  note?: string;
  /** Day the customer needs it (Lagos date, YYYY-MM-DD). */
  neededBy?: string;
  /** What was actually received, in kobo. Differs from the total when the owner accepts a short payment. */
  paidKobo?: number;
  /** True while this order's items are off the menu stock. Set in the same write that takes them, so a retry can't take them twice. */
  stockTaken?: boolean;
  /** The newer order that replaced this one. */
  replacedBy?: string;
  /** Set when the owner cancels after payment. */
  cancelledAt?: string;
  /** What the owner decided to return in total, in kobo. */
  refundDueKobo?: number;
  /** What Paystack says went back to the customer, in kobo. */
  refundedKobo?: number;
  /** Returned through Paystack before the owner accepted the order another way, so it isn't counted as a refund of it. */
  refundBaseKobo?: number;
  /** Goes up each time the refund changes, so each change is reported to Leadaut once. */
  refundSeq?: number;
  /** A reversal, dispute or full refund after the order was confirmed. Pauses the kitchen until the owner settles it. */
  paymentIssue?: PaymentIssue;
};

export type PaymentIssue = {
  kind: "reversed" | "disputed" | "refunded";
  at: string;
  detail: string;
  disputeId?: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

/** Orders above this go to the owner, who agrees them personally. */
export const MAX_ORDER_NGN = 300_000;

/** Statuses whose payment link hasn't been settled or replaced. */
export const OPEN_STATUSES: readonly OrderStatus[] = ["pending_payment", "payment_failed"];

/** Whether a newer link replaces this unpaid order. One whose link was never created can't be paid, so it's left as it failed. */
export const replaceable = (o: Order) => o.status === "pending_payment" || Boolean(o.paymentUrl);

/** One spelling per reference, so "mtk-1" and "MTK-1" share a lock, a row and a Paystack lookup. */
export const normaliseReference = (raw: string) => raw.trim().toUpperCase();

/** What the customer paid, in kobo. Orders from before amounts were recorded were paid exactly. */
export const paidKobo = (o: Order) => o.paidKobo ?? o.totalNgn * 100;

/** The refund to count against this order: what the owner agreed, or more if Paystack says more went back. */
export function refundKobo(o: Order) {
  return Math.min(paidKobo(o), Math.max(o.refundDueKobo ?? 0, o.refundedKobo ?? 0));
}

export const netNgn = (o: Order) => (paidKobo(o) - refundKobo(o)) / 100;

export const openIssue = (o: Order) => (o.paymentIssue && !o.paymentIssue.resolvedAt ? o.paymentIssue : undefined);

/**
 * Whether the order's items are off the menu stock. Orders from before `stockTaken` existed took
 * it when Paystack's amount matched, and not when the owner accepted a held payment.
 */
export function hasStock(o: Order) {
  return o.stockTaken ?? (o.status === "paid" && !/^accepted after review/.test(o.note ?? ""));
}

/** The refund the cancellation policy gives: all of it up to 24 hours before the delivery window opens (10am in Lagos), half after that. */
export function policyRefundKobo(o: Order, now: Date) {
  const paid = paidKobo(o);
  if (!o.neededBy) return paid;
  const opens = Date.parse(`${o.neededBy}T09:00:00Z`); // 10:00 in Lagos
  return now.getTime() <= opens - 24 * 3600_000 ? paid : Math.round(paid / 200) * 100;
}

/** A real calendar date, YYYY-MM-DD. Date.parse alone takes 31 February and rolls it over. */
export function isCalendarDate(s: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export type RequestedItem = { sku: string; qty: number };

export type QuoteProblem =
  | { kind: "unknown_item"; sku: string }
  | { kind: "out_of_stock"; sku: string; name: string; requested: number; available: number }
  | { kind: "unknown_zone"; zone: string; validZones: string[] };

export type Quote =
  | { ok: true; lines: OrderLine[]; subtotalNgn: number; deliveryFeeNgn: number; totalNgn: number; zone: string }
  | { ok: false; problems: QuoteProblem[] };

/** Prices are always computed here, never taken from the model. */
export function quote(menu: MenuItem[], zones: DeliveryZone[], items: RequestedItem[], zoneName: string): Quote {
  const problems: QuoteProblem[] = [];
  const lines: OrderLine[] = [];

  // Merge duplicate SKUs so "2 small + 1 small" is checked as 3.
  const merged = new Map<string, number>();
  for (const it of items) {
    const sku = it.sku.trim().toUpperCase();
    merged.set(sku, (merged.get(sku) ?? 0) + it.qty);
  }

  for (const [sku, qty] of merged) {
    const m = menu.find((x) => x.sku.toUpperCase() === sku && x.active);
    if (!m) {
      problems.push({ kind: "unknown_item", sku });
      continue;
    }
    if (m.stock < qty) {
      problems.push({ kind: "out_of_stock", sku: m.sku, name: m.name, requested: qty, available: Math.max(0, m.stock) });
      continue;
    }
    lines.push({ sku: m.sku, name: m.name, qty, unitPriceNgn: m.priceNgn, lineTotalNgn: m.priceNgn * qty });
  }

  const zone = zones.find((z) => z.zone.toLowerCase() === zoneName.trim().toLowerCase());
  if (!zone) problems.push({ kind: "unknown_zone", zone: zoneName, validZones: zones.map((z) => z.zone) });

  if (problems.length > 0 || !zone) return { ok: false, problems };
  const subtotalNgn = lines.reduce((s, l) => s + l.lineTotalNgn, 0);
  return { ok: true, lines, subtotalNgn, deliveryFeeNgn: zone.feeNgn, totalNgn: subtotalNgn + zone.feeNgn, zone: zone.zone };
}

/** Same basket, zone and total, so the existing link still charges the right amount. */
export function sameBasket(a: Pick<Order, "deliveryZone" | "lines" | "totalNgn">, lines: OrderLine[], zone: string, totalNgn: number): boolean {
  if (a.deliveryZone !== zone || a.totalNgn !== totalNgn || a.lines.length !== lines.length) return false;
  const key = (ls: OrderLine[]) => ls.map((l) => `${l.sku}x${l.qty}`).sort().join(",");
  return key(a.lines) === key(lines);
}

export function newReference(now = new Date()): string {
  const d = now.toISOString().slice(2, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `MTK-${d}-${rand}`;
}

export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.startsWith("234")) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+234${digits.slice(1)}`;
  return digits ? `+${digits}` : raw;
}
