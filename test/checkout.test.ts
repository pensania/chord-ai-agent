import { beforeEach, describe, expect, it } from "vitest";
import { Checkout, explainHold, ReviewError } from "../src/checkout.js";
import { Paystack } from "../src/paystack.js";
import { MemoryStore } from "../src/store/memory.js";
import { fakeFetch, noSleep, TEST_KEY } from "./helpers.js";

/** Minimal in-memory Paystack: initialize stores the amount; tests set what verify returns. */
function fakePaystack() {
  const tx = new Map<string, { amount: number; status: string; gateway_response?: string }>();
  let down = false;
  const { f, calls } = fakeFetch((url, init) => {
    if (down) return { status: 503, body: {} };
    if (url.endsWith("/transaction/initialize")) {
      const b = JSON.parse(String(init?.body));
      tx.set(b.reference, { amount: b.amount, status: "abandoned" });
      return { status: 200, body: { status: true, data: { authorization_url: `https://checkout.paystack.com/${b.reference}`, reference: b.reference } } };
    }
    const ref = decodeURIComponent(url.split("/transaction/verify/")[1] ?? "");
    const t = tx.get(ref);
    if (!t) return { status: 400, body: { status: false, message: "Transaction reference not found" } };
    return { status: 200, body: { status: true, data: { status: t.status, amount: t.amount, currency: "NGN", gateway_response: t.gateway_response, paid_at: "2026-10-25T10:00:00Z" } } };
  });
  return {
    paystack: new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep }),
    calls,
    set: (ref: string, patch: Partial<{ amount: number; status: string; gateway_response: string }>) => Object.assign(tx.get(ref)!, patch),
    setDown: (v: boolean) => (down = v),
  };
}

const order = {
  customerName: "Ada",
  customerPhone: "0803 123 4567",
  items: [{ sku: "JOL-SMALL", qty: 2 }],
  deliveryZone: "Yaba",
  deliveryAddress: "12 Herbert Macaulay Way",
};

describe("Checkout", () => {
  let store: MemoryStore;
  let ps: ReturnType<typeof fakePaystack>;
  let co: Checkout;
  beforeEach(() => {
    store = new MemoryStore();
    ps = fakePaystack();
    co = new Checkout(store, ps.paystack);
  });

  it("charges the server-computed total in kobo", async () => {
    const r = await co.createPaymentLink(order);
    expect(r).toMatchObject({ ok: true, total_ngn: 53000 });
    const body = JSON.parse(String(ps.calls[0].init?.body));
    expect(body.amount).toBe(5_300_000);
    expect(body.email).toBe("2348031234567@example.com");
  });

  it("uses the configured placeholder email domain", async () => {
    co = new Checkout(store, ps.paystack, { placeholderEmailDomain: "orders.mamatolas.ng" });
    await co.createPaymentLink(order);
    expect(JSON.parse(String(ps.calls[0].init?.body)).email).toBe("2348031234567@orders.mamatolas.ng");
  });

  it("reuses the link for the same unpaid basket instead of charging twice", async () => {
    const a = await co.createPaymentLink(order);
    const b = await co.createPaymentLink({ ...order, customerPhone: "+2348031234567" });
    expect(b).toMatchObject({ ok: true, reused: true, reference: a.reference });
    expect(ps.calls.filter((c) => c.url.endsWith("/initialize"))).toHaveLength(1);
  });

  it("refuses to create a link for sold-out items", async () => {
    const r = await co.createPaymentLink({ ...order, items: [{ sku: "MOIMOI-20", qty: 1 }] });
    expect(r.ok).toBe(false);
    expect(ps.calls).toHaveLength(0);
  });

  it("reports provider downtime honestly when creating a link", async () => {
    ps.setDown(true);
    const r = await co.createPaymentLink(order);
    expect(r).toMatchObject({ ok: false, error: "payment_provider_unavailable" });
  });

  it("does not confirm an unpaid order", async () => {
    const { reference } = await co.createPaymentLink(order);
    const r = await co.verifyPayment(String(reference));
    expect(r).toMatchObject({ ok: true, status: "not_paid_yet" });
  });

  it("confirms a verified payment once and decrements stock once", async () => {
    const { reference } = await co.createPaymentLink(order);
    ps.set(String(reference), { status: "success" });
    const [a, b] = await Promise.all([co.verifyPayment(String(reference), "webhook"), co.verifyPayment(String(reference), "chat")]);
    expect([a.status, b.status]).toEqual(["paid", "paid"]);
    expect(b.already_confirmed).toBe(true);
    const menu = await store.listMenu();
    expect(menu.find((m) => m.sku === "JOL-SMALL")?.stock).toBe(4);
  });

  it("tells the revenue system about a payment exactly once", async () => {
    const paid: string[] = [];
    co = new Checkout(store, ps.paystack, { onPaid: (o) => void paid.push(`${o.reference}:${o.status}`) });
    const { reference } = await co.createPaymentLink(order);
    ps.set(String(reference), { status: "success" });
    await Promise.all([co.verifyPayment(String(reference), "webhook"), co.verifyPayment(String(reference), "chat")]);
    await co.verifyPayment(String(reference), "chat");
    expect(paid).toEqual([`${reference}:paid`]);
  });

  it("flags an amount mismatch for review instead of confirming", async () => {
    const { reference } = await co.createPaymentLink(order);
    ps.set(String(reference), { status: "success", amount: 100 });
    const r = await co.verifyPayment(String(reference));
    expect(r.status).toBe("needs_review");
    expect((await store.getOrder(String(reference)))?.status).toBe("needs_review");
  });

  it("holds a short payment for the owner, alerts once, and lets the owner settle it", async () => {
    const held: string[] = [];
    const paid: string[] = [];
    co = new Checkout(store, ps.paystack, { onHeld: (o) => held.push(o.reference), onPaid: (o) => paid.push(o.reference) });
    const { reference } = await co.createPaymentLink(order);
    const ref = String(reference);
    ps.set(ref, { status: "success", amount: 5_000_000 });
    await co.verifyPayment(ref);
    await co.verifyPayment(ref); // the customer says "paid" again: still held, no second alert
    expect(held).toEqual([ref]);
    const list = await co.heldPayments();
    expect(list.map((o) => o.reference)).toEqual([ref]);
    expect(explainHold(list[0])).toBe("Paid ₦50,000, but the order is ₦53,000.");

    const accepted = await co.review(ref.toLowerCase(), "accept", "owner");
    expect(accepted).toMatchObject({ status: "paid" });
    expect(accepted.note).toMatch(/^accepted after review by owner: amount mismatch/);
    expect(paid).toEqual([ref]);
    expect(await co.heldPayments()).toEqual([]);
    expect((await co.verifyPayment(ref)).already_confirmed).toBe(true);
    await expect(co.review(ref, "close", "owner")).rejects.toBeInstanceOf(ReviewError);
  });

  it("closes a reversed payment for good: the agent won't confirm it or re-check Paystack", async () => {
    const held: string[] = [];
    co = new Checkout(store, ps.paystack, { onHeld: (o) => held.push(o.reference) });
    const { reference } = await co.createPaymentLink(order);
    const ref = String(reference);
    ps.set(ref, { status: "reversed" });
    expect((await co.verifyPayment(ref)).status).toBe("needs_review");
    expect(held).toEqual([ref]);
    expect(explainHold((await store.getOrder(ref))!)).toMatch(/reversed/);
    await co.review(ref, "close", "owner");
    ps.set(ref, { status: "success" });
    const calls = ps.calls.length;
    const r = await co.verifyPayment(ref);
    expect(r.status).toBe("closed");
    expect(ps.calls.length).toBe(calls);
    expect((await store.getOrder(ref))?.status).toBe("closed");
  });

  it("handles a failed payment and allows a fresh link", async () => {
    const first = await co.createPaymentLink(order);
    ps.set(String(first.reference), { status: "failed", gateway_response: "Declined" });
    const r = await co.verifyPayment(String(first.reference));
    expect(r).toMatchObject({ status: "payment_failed", reason: "Declined" });
    const second = await co.createPaymentLink(order);
    expect(second.ok).toBe(true);
    expect(second.reference).not.toBe(first.reference);
  });

  it("flags paid-but-oversold for the owner", async () => {
    const a = await co.createPaymentLink({ ...order, customerPhone: "08030000001", items: [{ sku: "JOL-LARGE", qty: 3 }] });
    const b = await co.createPaymentLink({ ...order, customerPhone: "08030000002", items: [{ sku: "JOL-LARGE", qty: 3 }] });
    ps.set(String(a.reference), { status: "success" });
    ps.set(String(b.reference), { status: "success" });
    expect((await co.verifyPayment(String(a.reference))).status).toBe("paid");
    const r = await co.verifyPayment(String(b.reference));
    expect(r.status).toBe("needs_review");
    expect(String(r.note)).toMatch(/oversold/);
    expect(explainHold((await store.getOrder(String(b.reference)))!)).toMatch(/^Paid, but sold out before payment landed: Party jollof tray \(large/);
  });

  it("says so when Paystack is down during verify, without confirming", async () => {
    const { reference } = await co.createPaymentLink(order);
    ps.setDown(true);
    const r = await co.verifyPayment(String(reference));
    expect(r).toMatchObject({ ok: false, error: "payment_provider_unavailable" });
    expect((await store.getOrder(String(reference)))?.status).toBe("pending_payment");
  });

  it("returns a helpful error for an unknown reference", async () => {
    expect(await co.verifyPayment("MTK-000000-XXXXX")).toMatchObject({ ok: false, error: "unknown_reference" });
  });
});

describe("needed_by", () => {
  it("stores a valid date and refuses past or malformed ones", async () => {
    const store = new MemoryStore();
    const { paystack } = fakePaystack();
    const c = new Checkout(store, paystack, { now: () => new Date("2026-11-05T09:00:00Z") });
    const base = { customerName: "Ada", customerPhone: "08031234567", items: [{ sku: "JOL-SMALL", qty: 1 }], deliveryZone: "Pickup", deliveryAddress: "Pickup" };
    expect(await c.createPaymentLink({ ...base, neededBy: "Saturday" })).toMatchObject({ ok: false, error: "bad_date" });
    expect(await c.createPaymentLink({ ...base, neededBy: "2026-11-01" })).toMatchObject({ ok: false, error: "date_in_past" });
    const r = await c.createPaymentLink({ ...base, neededBy: "2026-11-07" });
    expect(r.ok).toBe(true);
    expect((await store.getOrder(String(r.reference)))?.neededBy).toBe("2026-11-07");
  });
});
