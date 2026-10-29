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
  | "needs_review"; // paid but something is off (amount mismatch, oversold)

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
};

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

/** Same customer, same basket, still unpaid: reuse the link instead of creating a second charge. */
export function sameBasket(a: Order, lines: OrderLine[], zone: string): boolean {
  if (a.deliveryZone !== zone || a.lines.length !== lines.length) return false;
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
