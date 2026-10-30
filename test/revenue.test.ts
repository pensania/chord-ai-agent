import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Order } from "../src/domain.js";
import { RevenueOutbox, signRevenueEvent } from "../src/revenue/outbox.js";
import { RevenueSync } from "../src/revenue/sync.js";

const SECRET = "leadaut-test-secret-123";

const order: Order = {
  reference: "MTK-261105-AAAAA",
  createdAt: "2026-11-05T08:00:00Z",
  customerName: "Ada Obi",
  customerPhone: "+2348031234567",
  lines: [{ sku: "JOL-SMALL", name: "Party jollof tray (small, serves 10)", qty: 2, unitPriceNgn: 25000, lineTotalNgn: 50000 }],
  deliveryZone: "Yaba",
  deliveryAddress: "12 Herbert Macaulay Way",
  subtotalNgn: 50000,
  deliveryFeeNgn: 3000,
  totalNgn: 53000,
  status: "paid",
  paidAt: "2026-11-05T08:05:00Z",
  neededBy: "2026-11-07",
};

/** A receiver that answers with the given statuses in turn, then 200. */
function receiver(statuses: number[] = []) {
  const calls: { headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
    return new Response("{}", { status: statuses.shift() ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("revenue outbox", () => {
  it("signs each event the same way Chord does, so the receiver can check it", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: "https://leadaut.test/hook", secret: SECRET, fetchImpl, now: () => 1_700_000_000_000 });
    box.enqueue({ event_type: "order.paid", event_id: "R1:paid", occurred_at: "x", data: {} });
    await box.flush();
    const [c] = calls;
    const want = createHmac("sha256", SECRET).update(`1700000000000.${c.body}`).digest("hex");
    expect(c.headers["X-Mtk-Signature"]).toBe(`sha256=${want}`);
    expect(c.headers["X-Mtk-Event-Id"]).toBe("R1:paid");
    expect(signRevenueEvent(c.body, SECRET, 1_700_000_000_000)["X-Mtk-Signature"]).toBe(c.headers["X-Mtk-Signature"]);
  });

  it("ignores a repeated event id", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: "https://leadaut.test/hook", secret: SECRET, fetchImpl });
    expect(box.enqueue({ event_type: "order.paid", event_id: "R1:paid", occurred_at: "x", data: {} })).toBe(true);
    expect(box.enqueue({ event_type: "order.paid", event_id: "R1:paid", occurred_at: "x", data: {} })).toBe(false);
    await box.flush();
    expect(calls).toHaveLength(1);
  });

  it("retries a 500 after a backoff, and gives up on a 400", async () => {
    let now = 0;
    const { calls, fetchImpl } = receiver([500, 400]);
    const box = new RevenueOutbox({ url: "https://leadaut.test/hook", secret: SECRET, fetchImpl, now: () => now });
    box.enqueue({ event_type: "order.paid", event_id: "R1:paid", occurred_at: "x", data: {} });
    await box.flush();
    expect(box.status()).toMatchObject({ pending: 1, sent: 0 });
    await box.flush(); // not due yet
    expect(calls).toHaveLength(1);
    now += 30_000;
    await box.flush();
    expect(calls).toHaveLength(2);
    expect(box.status()).toMatchObject({ pending: 0, dead: 1, lastError: "HTTP 400" });
    // After the receiver is fixed, failed events can be sent again.
    expect(box.retryDead()).toBe(1);
    await box.flush();
    expect(box.status()).toMatchObject({ sent: 1, dead: 0 });
  });

  it("gives up after the last attempt on a receiver that stays down", async () => {
    let now = 0;
    const { fetchImpl } = receiver([503, 503, 503]);
    const box = new RevenueOutbox({ url: "https://leadaut.test/hook", secret: SECRET, fetchImpl, now: () => now, maxAttempts: 3 });
    box.enqueue({ event_type: "order.paid", event_id: "R1:paid", occurred_at: "x", data: {} });
    for (let i = 0; i < 3; i++) {
      await box.flush();
      now += 3600_000;
    }
    expect(box.status().dead).toBe(1);
  });
});

describe("revenue sync", () => {
  it("sends the customer as a lead and the order as a transaction when paid", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: "https://leadaut.test/hook", secret: SECRET, fetchImpl });
    new RevenueSync(box).paid(order);
    await box.flush();
    const [lead, tx] = calls.map((c) => JSON.parse(c.body));
    expect(lead).toMatchObject({ event_type: "customer.upserted", event_id: "MTK-261105-AAAAA:customer", data: { lead: { external_id: "+2348031234567", name: "Ada Obi", source: "whatsapp" } } });
    expect(tx).toMatchObject({
      event_type: "order.paid",
      occurred_at: "2026-11-05T08:05:00Z",
      data: { transaction: { reference: "MTK-261105-AAAAA", amount_ngn: 53000, currency: "NGN", fulfilment: "delivery", items: [{ sku: "JOL-SMALL", qty: 2, total_ngn: 50000 }] } },
    });
  });

  it("reports fulfilment and cancellation, and nothing for in-between stages", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: "https://leadaut.test/hook", secret: SECRET, fetchImpl });
    const sync = new RevenueSync(box);
    const ev = (from: string, to: string) => ({ reference: order.reference, from, to, by: "owner", customerPhone: order.customerPhone, customerMessage: "" }) as never;
    sync.stage(ev("new", "accepted"), order);
    sync.stage(ev("out_for_delivery", "delivered"), order);
    sync.stage(ev("accepted", "cancelled"), { ...order, reference: "MTK-2" });
    await box.flush();
    expect(calls.map((c) => JSON.parse(c.body).event_type)).toEqual(["order.fulfilled", "order.cancelled"]);
    expect(JSON.parse(calls[1].body).data).toMatchObject({ refund_due: true, stage_when_cancelled: "accepted" });
  });
});
