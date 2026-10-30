import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Order } from "../src/domain.js";
import { RevenueOutbox, type RevenueEvent, signRevenueBody } from "../src/revenue/outbox.js";
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

/** A receiver that gives the given answers in turn (a status, or a 200 with that JSON), then `{ ok: true }`. */
function receiver(answers: (number | Record<string, unknown>)[] = []) {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const a = answers.shift() ?? { ok: true };
    return typeof a === "number" ? new Response("{}", { status: a }) : new Response(JSON.stringify(a), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const URL_ = "https://api.leadaut.test/api/webhooks/ecommerce/woocommerce/0b7c";
const ev = (id: string, key = "R1", topic: RevenueEvent["topic"] = "order.created"): RevenueEvent => ({ event_id: id, topic, key, occurred_at: "x", body: { id: key } });

describe("revenue outbox", () => {
  it("signs each delivery the way WooCommerce does, so Leadaut's store webhook accepts it", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl });
    box.enqueue(ev("R1:processing"));
    await box.flush();
    const [c] = calls;
    expect(c.url).toBe(`${URL_}?topic=order.created`);
    expect(c.headers["X-WC-Webhook-Topic"]).toBe("order.created");
    expect(c.headers["X-WC-Webhook-Signature"]).toBe(createHmac("sha256", SECRET).update(c.body).digest("base64"));
    expect(signRevenueBody(c.body, SECRET)).toBe(c.headers["X-WC-Webhook-Signature"]);
  });

  it("takes the URL as Leadaut shows it, with any ?topic=, and sets the topic per delivery", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: `${URL_}?topic=order.updated`, secret: SECRET, fetchImpl });
    box.enqueue(ev("R1:processing"));
    box.enqueue(ev("R1:refunded", "R1", "order.refunded"));
    await box.flush();
    expect(calls.map((c) => c.url)).toEqual([`${URL_}?topic=order.created`, `${URL_}?topic=order.refunded`]);
  });

  it("ignores a repeated event id", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl });
    expect(box.enqueue(ev("R1:processing"))).toBe(true);
    expect(box.enqueue(ev("R1:processing"))).toBe(false);
    await box.flush();
    expect(calls).toHaveLength(1);
  });

  it("retries a 500 after a backoff, and gives up on a 400", async () => {
    let now = 0;
    const { calls, fetchImpl } = receiver([500, 400]);
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl, now: () => now });
    box.enqueue(ev("R1:processing"));
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

  it("reads Leadaut's 200 refusals: a bad secret stops, a paused store is retried", async () => {
    let now = 0;
    const { fetchImpl } = receiver([{ ok: false, error: "bad_signature" }, { ok: false, error: "integration_paused" }]);
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl, now: () => now });
    box.enqueue(ev("A:processing", "A"));
    box.enqueue(ev("B:processing", "B"));
    await box.flush();
    expect(box.status()).toMatchObject({ dead: 1, pending: 1, sent: 0 });
    expect(box.status().recentDead[0]).toEqual({ event_id: "A:processing", error: "leadaut: bad_signature" });
    now += 30_000;
    await box.flush();
    expect(box.status()).toMatchObject({ dead: 1, pending: 0, sent: 1 });
  });

  it("keeps one order's updates in order while an earlier one is retrying", async () => {
    let now = 0;
    const { calls, fetchImpl } = receiver([503]);
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl, now: () => now });
    box.enqueue(ev("R1:processing"));
    box.enqueue(ev("R1:refunded", "R1", "order.updated"));
    box.enqueue(ev("R2:processing", "R2"));
    await box.flush();
    expect(calls.map((c) => c.headers["X-WC-Webhook-Delivery-ID"])).toEqual(["R1:processing", "R2:processing"]);
    now += 30_000;
    await box.flush();
    expect(calls.map((c) => c.headers["X-WC-Webhook-Delivery-ID"]).slice(2)).toEqual(["R1:processing", "R1:refunded"]);
  });

  it("gives up after the last attempt on a receiver that stays down", async () => {
    let now = 0;
    const { fetchImpl } = receiver([503, 503, 503]);
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl, now: () => now, maxAttempts: 3 });
    box.enqueue(ev("R1:processing"));
    for (let i = 0; i < 3; i++) {
      await box.flush();
      now += 3600_000;
    }
    expect(box.status().dead).toBe(1);
  });
});

describe("revenue sync", () => {
  it("sends a paid order in WooCommerce's shape, keyed by the WhatsApp number", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl });
    new RevenueSync(box).paid(order);
    await box.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["X-WC-Webhook-Topic"]).toBe("order.created");
    expect(JSON.parse(calls[0].body)).toMatchObject({
      id: "MTK-261105-AAAAA",
      status: "processing",
      currency: "NGN",
      total: "53000.00",
      shipping_total: "3000.00",
      date_paid_gmt: "2026-11-05T08:05:00",
      billing: { first_name: "Ada", last_name: "Obi", phone: "+2348031234567", city: "Yaba" },
      line_items: [{ sku: "JOL-SMALL", quantity: 2, subtotal: "50000.00" }],
      refunds: [],
    });
  });

  it("reports fulfilment and cancellation, and nothing for in-between stages", async () => {
    const { calls, fetchImpl } = receiver();
    const box = new RevenueOutbox({ url: URL_, secret: SECRET, fetchImpl });
    const sync = new RevenueSync(box, { now: () => new Date("2026-11-07T12:00:00Z") });
    const st = (from: string, to: string) => ({ reference: order.reference, from, to, by: "owner", customerPhone: order.customerPhone, customerMessage: "" }) as never;
    sync.stage(st("new", "accepted"), order);
    sync.stage(st("out_for_delivery", "delivered"), order);
    sync.stage(st("accepted", "cancelled"), { ...order, reference: "MTK-2" });
    await box.flush();
    const sent = calls.map((c) => JSON.parse(c.body));
    expect(sent.map((b) => b.status)).toEqual(["delivered", "refunded"]);
    expect(calls.map((c) => c.headers["X-WC-Webhook-Topic"])).toEqual(["order.updated", "order.refunded"]);
    expect(sent[0].date_completed_gmt).toBe("2026-11-07T12:00:00");
    expect(sent[1].refunds).toEqual([{ total: "-53000.00", reason: "Cancelled after payment" }]);
  });
});
