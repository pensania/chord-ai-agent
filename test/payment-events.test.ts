import { createHmac } from "node:crypto";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Checkout } from "../src/checkout.js";
import { type EventEntry, type EventJournal, parsePaystackEvent, PaymentEvents } from "../src/payment-events.js";
import { createApp, paymentEventHandler } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresEventJournal, PostgresStore } from "../src/store/postgres.js";
import { fakePaystack, IN_A_WEEK, TEST_KEY } from "./helpers.js";
import { PG_URL, pgSchema } from "./stores.js";

/** D-02: a webhook is only acknowledged once it can't be lost. */
class FakeJournal implements EventJournal {
  readonly durable = true;
  saved = new Map<string, EventEntry>();
  broken = false;
  async load() {
    return structuredClone([...this.saved.values()].filter((e) => e.state === "pending"));
  }
  async save(e: EventEntry) {
    if (this.broken) throw new Error("database down");
    this.saved.set(e.event.id, structuredClone(e));
  }
}

const log = () => {};
const order = { customerName: "Ada", customerPhone: "08031234567", items: [{ sku: "JOL-SMALL", qty: 2 }], deliveryZone: "Yaba", deliveryAddress: "12 Herbert Macaulay Way", neededBy: IN_A_WEEK };

describe("Paystack webhook queue (D-02)", () => {
  let store: MemoryStore;
  let ps: ReturnType<typeof fakePaystack>;
  let co: Checkout;
  let now = 0;
  beforeEach(() => {
    store = new MemoryStore();
    ps = fakePaystack();
    co = new Checkout(store, ps.paystack);
    now = 0;
  });
  const queue = (journal?: EventJournal, maxAttempts?: number) => new PaymentEvents(paymentEventHandler(co, undefined, log), { journal, now: () => now, maxAttempts });
  const app = (payments?: PaymentEvents) => createApp({ checkout: co, mcpBearerToken: "tok", paystackSecretKey: TEST_KEY, payments, log });
  const post = (a: ReturnType<typeof app>, event: string, data: unknown) => {
    const body = JSON.stringify({ event, data });
    return request(a).post("/webhooks/paystack").set("x-paystack-signature", createHmac("sha512", TEST_KEY).update(body).digest("hex")).set("Content-Type", "application/json").send(body);
  };
  const status = async (ref: string) => (await store.getOrder(ref))?.status;

  it("acknowledges a saved event while Paystack is down, then confirms the order on retry", async () => {
    const journal = new FakeJournal();
    const payments = queue(journal);
    const ref = String((await co.createPaymentLink(order)).reference);
    ps.set(ref, { status: "success" });
    ps.setDown(true);
    const a = app(payments);
    await post(a, "charge.success", { reference: ref }).expect(200);
    await payments.flush();
    expect(await status(ref)).toBe("pending_payment");
    expect((await request(a).get("/healthz")).body.payments).toEqual({ pending: 1, failed: 0 });

    ps.setDown(false);
    await payments.flush(); // not due yet
    expect(await status(ref)).toBe("pending_payment");
    now += 30_000;
    await payments.flush();
    expect(await status(ref)).toBe("paid");
    expect([...journal.saved.values()].map((e) => e.state)).toEqual(["done"]);
  });

  it("picks up after a restart", async () => {
    const journal = new FakeJournal();
    const ref = String((await co.createPaymentLink(order)).reference);
    ps.set(ref, { status: "success" });
    ps.setDown(true);
    const before = queue(journal);
    await post(app(before), "charge.success", { reference: ref }).expect(200);
    await before.flush();
    ps.setDown(false);
    const after = queue(journal);
    expect(await after.load()).toBe(1);
    await after.flush();
    expect(await status(ref)).toBe("paid");
  });

  it("asks Paystack to send it again when it can't be saved", async () => {
    const journal = new FakeJournal();
    const payments = queue(journal);
    const ref = String((await co.createPaymentLink(order)).reference);
    ps.set(ref, { status: "success" });
    journal.broken = true;
    await post(app(payments), "charge.success", { reference: ref }).expect(503);
    expect(await status(ref)).toBe("pending_payment");
    journal.broken = false;
    await post(app(payments), "charge.success", { reference: ref }).expect(200);
    await payments.flush();
    expect(await status(ref)).toBe("paid");
  });

  it("without a database, acknowledges only once the event has been acted on", async () => {
    const a = app();
    const ref = String((await co.createPaymentLink(order)).reference);
    ps.set(ref, { status: "success" });
    ps.setDown(true);
    await post(a, "charge.success", { reference: ref }).expect(503);
    ps.setDown(false);
    await post(a, "charge.success", { reference: ref }).expect(200);
    expect(await status(ref)).toBe("paid");
    await post(a, "charge.success", { reference: ref }).expect(200);
    expect((await store.listMenu()).find((m) => m.sku === "JOL-SMALL")!.stock).toBe(4);
  });

  it("retries a success Paystack's own API doesn't show yet, and gives up in the end", async () => {
    const payments = queue(new FakeJournal(), 2);
    const ref = String((await co.createPaymentLink(order)).reference);
    await post(app(payments), "charge.success", { reference: ref }).expect(200);
    await payments.flush();
    expect(payments.status()).toEqual({ pending: 1, failed: 0 });
    now += 30_000;
    await payments.flush();
    expect(payments.status()).toEqual({ pending: 0, failed: 1 });
    ps.set(ref, { status: "success" });
    await post(app(payments), "charge.success", { reference: ref }).expect(200); // sent again: tried again
    await payments.flush();
    expect(await status(ref)).toBe("paid");
  });

  it("acts on refunds and disputes (D-11), and ignores the rest", async () => {
    const a = app();
    const ref = String((await co.createPaymentLink(order)).reference);
    ps.set(ref, { status: "success" });
    await co.verifyPayment(ref);
    // The amount in the body is never believed: Paystack's API says nothing was refunded.
    await post(a, "refund.processed", { transaction_reference: ref, amount: "5300000" }).expect(200);
    expect((await store.getOrder(ref))!.refundedKobo).toBeUndefined();
    ps.refund(ref, 1_000_000);
    await post(a, "refund.processed", { transaction_reference: ref, amount: "1000000", refund_reference: "r1" }).expect(200);
    expect((await store.getOrder(ref))!.refundedKobo).toBe(1_000_000);
    ps.dispute(5, ref, { status: "awaiting-merchant-feedback" });
    await post(a, "charge.dispute.create", { id: 5, transaction: { reference: ref } }).expect(200);
    expect((await store.getOrder(ref))!.paymentIssue).toMatchObject({ kind: "disputed", disputeId: "5" });
    await post(a, "transfer.success", { reference: ref }).expect(200);
    await post(a, "charge.success", { reference: "SOMEONE-ELSES" }).expect(200); // not our order: nothing to retry
  });

  it("reads references from every event shape", () => {
    const parse = (event: string, data: unknown) => parsePaystackEvent(Buffer.from(JSON.stringify({ event, data })));
    expect(parse("charge.success", { reference: " mtk-1 " })).toMatchObject({ reference: "MTK-1" });
    expect(parse("refund.failed", { transaction: { reference: "MTK-1" } })).toMatchObject({ reference: "MTK-1" });
    expect(parse("charge.dispute.resolve", { id: 3, transaction_reference: null, transaction: { reference: "MTK-1" } })).toMatchObject({ reference: "MTK-1", disputeId: "3" });
    expect(parse("charge.success", {})).toBeUndefined();
    expect(parse("subscription.create", { reference: "MTK-1" })).toBeUndefined();
  });
});

describe.skipIf(!PG_URL)("webhook queue on postgres", () => {
  const schema = pgSchema("events");
  afterAll(() => schema.drop());

  it("keeps an event through a restart and doesn't repeat a finished one", async () => {
    const db = await schema.fresh();
    const ps = fakePaystack();
    const boot = () => {
      const co = new Checkout(new PostgresStore(db), ps.paystack);
      return { co, events: new PaymentEvents(paymentEventHandler(co, undefined, log), { journal: new PostgresEventJournal(db) }) };
    };
    const one = boot();
    const ref = String((await one.co.createPaymentLink(order)).reference);
    ps.set(ref, { status: "success" });
    ps.setDown(true);
    expect(await one.events.receive({ id: "e1", type: "charge.success", reference: ref })).toBe(true);
    await one.events.flush();

    ps.setDown(false);
    const two = boot();
    expect(await two.events.load()).toBe(1);
    await two.events.flush();
    expect((await new PostgresStore(db).getOrder(ref))?.status).toBe("paid");
    expect(await boot().events.load()).toBe(0);
  });
});
