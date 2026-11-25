import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Checkout, explainHold, ReviewError } from "../src/checkout.js";
import { netNgn, paidKobo, refundKobo, type Order } from "../src/domain.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { Operations, type Actor } from "../src/ops/operations.js";
import { Reconciler } from "../src/reconcile.js";
import { RevenueOutbox } from "../src/revenue/outbox.js";
import { RevenueSync } from "../src/revenue/sync.js";
import type { PostgresDb } from "../src/store/postgres.js";
import type { Store } from "../src/store/types.js";
import { fakePaystack } from "./helpers.js";
import { pgSchema, STORES } from "./stores.js";

/**
 * One regression test or more for each defect in section 13 of the TRD, D-01 to D-13 (the webhook
 * queue half of D-02 is in payment-events.test.ts, the pages of D-08 in menu.test.ts). Each runs on every store.
 */
const owner: Actor = { kind: "owner" };
const schema = pgSchema("defects");
afterAll(async () => {
  if (process.env.TEST_DATABASE_URL) await schema.drop();
});

describe.each(STORES)("on $name", ({ name, skip, make }) => {
  describe.skipIf(skip)("defects", () => {
    let store: Store;
    let db: PostgresDb | undefined;
    let ps: ReturnType<typeof fakePaystack>;
    let co: Checkout;
    let now: Date;
    let told: string[];
    const checkout = () =>
      new Checkout(store, ps.paystack, {
        now: () => now,
        onPaid: (o) => told.push(`paid ${o.reference}`),
        onHeld: (o) => told.push(`held ${o.reference}`),
        onRefund: (o) => told.push(`refund ${refundKobo(o)}`),
        onIssue: (o) => told.push(`issue ${o.paymentIssue!.kind}`),
        onRefundFailed: () => told.push("refund failed"),
      });
    beforeEach(async () => {
      db = name === "postgres" ? await schema.fresh() : undefined;
      store = make(db);
      ps = fakePaystack();
      now = new Date("2026-11-05T09:00:00Z"); // 10:00 in Lagos
      told = [];
      co = checkout();
    });

    const base = { customerName: "Ada", customerPhone: "0803 123 4567", items: [{ sku: "JOL-SMALL", qty: 2 }], deliveryZone: "Yaba", deliveryAddress: "12 Herbert Macaulay Way", neededBy: "2026-11-10" };
    const link = async (patch: Partial<typeof base> = {}, c = co) => String((await c.createPaymentLink({ ...base, ...patch })).reference);
    const stock = async (sku = "JOL-SMALL") => (await store.listMenu()).find((m) => m.sku === sku)!.stock;
    const get = async (ref: string) => (await store.getOrder(ref))!;
    const pay = async (ref: string, patch: { amount?: number } = {}) => {
      ps.set(ref, { status: "success", ...patch });
      return co.verifyPayment(ref);
    };

    it("D-01: mixed-case references settle once", async () => {
      const ref = await link();
      ps.set(ref, { status: "success" });
      const rs = await Promise.all([ref, ref.toLowerCase(), ` ${ref} `, ref.toLowerCase()].map((r) => co.verifyPayment(r)));
      expect(rs.map((r) => r.status)).toEqual(["paid", "paid", "paid", "paid"]);
      expect(await stock()).toBe(4);
      expect(told).toEqual([`paid ${ref}`]);
    });

    it("D-01: two servers settling the same payment still settle it once", async () => {
      const ref = await link();
      ps.set(ref, { status: "success" });
      await Promise.all([co.verifyPayment(ref), checkout().verifyPayment(ref.toLowerCase(), "webhook")]);
      expect(await stock()).toBe(4);
      expect(told).toEqual([`paid ${ref}`]);
    });

    it("D-02: reconciliation confirms a payment whose webhook never came, and only once", async () => {
      const found: unknown[] = [];
      const ref = await link();
      const rec = new Reconciler(store, co, { now: () => now, onFound: (r) => void found.push(r.status) });
      expect((await rec.run()).found).toEqual([]);
      ps.set(ref, { status: "success" });
      ps.setDown(true);
      now = new Date(now.getTime() + 5 * 60_000);
      expect((await rec.run()).found).toEqual([]);
      expect((await get(ref)).status).toBe("pending_payment");
      ps.setDown(false); // an order that couldn't be checked is due again straight away
      expect((await rec.run()).found).toEqual([ref]);
      expect(await get(ref)).toMatchObject({ status: "paid", note: "verified via reconcile" });
      now = new Date(now.getTime() + 5 * 60_000);
      expect((await rec.run()).found).toEqual([]);
      expect(found).toEqual(["paid"]);
      expect(await stock()).toBe(4);
    });

    it("D-02: a background check leaves a declined card alone, and one broken order doesn't block the rest", async () => {
      const broken = await Promise.all([1, 2, 3].map(async (n) => {
        const ref = `MTK-261105-BAD${n}`;
        await store.createOrder({ ...(await get(await link({ customerPhone: `0803000001${n}` }))), reference: ref, customerPhone: "+234", paymentUrl: "x" });
        return ref;
      }));
      const ref = await link({ customerPhone: "08030000020" });
      ps.before((url) => {
        if (broken.some((b) => url.endsWith(b))) throw new Error("boom");
      });
      ps.set(ref, { status: "failed" });
      const rec = new Reconciler(store, co, { now: () => now });
      for (let i = 0; i < 3; i++) await rec.run();
      expect((await get(ref)).status).toBe("pending_payment");
      ps.set(ref, { status: "success" });
      now = new Date(now.getTime() + 5 * 60_000);
      for (let i = 0; i < 3; i++) await rec.run();
      expect((await get(ref)).status).toBe("paid");
    });

    it("D-03: a reused link carries the new day, address and name", async () => {
      const ref = await link();
      const again = await co.createPaymentLink({ ...base, neededBy: "2026-11-12", deliveryAddress: "5 Bode Thomas", customerName: "Ada Obi" });
      expect(again).toMatchObject({ ok: true, reused: true, updated: true, reference: ref, needed_by: "2026-11-12" });
      expect(await get(ref)).toMatchObject({ neededBy: "2026-11-12", deliveryAddress: "5 Bode Thomas", customerName: "Ada Obi" });
      expect(await co.createPaymentLink({ ...base, neededBy: "2026-11-12", deliveryAddress: "5 Bode Thomas", customerName: "Ada Obi" })).not.toHaveProperty("updated", true);
      expect(ps.links()).toBe(1);
    });

    it("D-03: a price change makes a new link instead of reusing one for the old amount", async () => {
      const ref = await link();
      await store.updateMenuItem("JOL-SMALL", { priceNgn: 26000 });
      const again = await co.createPaymentLink(base);
      expect(again).toMatchObject({ ok: true, total_ngn: 55000, replaced: [ref] });
    });

    it("D-04: a payment that can't be fully met takes nothing, and closing it changes nothing", async () => {
      const a = await link({ items: [{ sku: "JOL-SMALL", qty: 2 }, { sku: "JOL-LARGE", qty: 2 }] });
      const b = await link({ customerPhone: "08030000002", items: [{ sku: "JOL-LARGE", qty: 2 }] });
      expect((await pay(b)).status).toBe("paid");
      expect((await pay(a)).status).toBe("needs_review");
      expect([await stock("JOL-SMALL"), await stock("JOL-LARGE")]).toEqual([6, 1]);
      await co.review(a, "close", "owner");
      expect([await stock("JOL-SMALL"), await stock("JOL-LARGE")]).toEqual([6, 1]);
    });

    it("D-05: accepting a wrong-amount payment takes its stock, once", async () => {
      const ref = await link();
      await pay(ref, { amount: 5_000_000 });
      expect(await stock()).toBe(6);
      const [x, y] = await Promise.allSettled([co.review(ref, "accept", "owner"), co.review(ref.toLowerCase(), "accept", "owner")]);
      expect([x.status, y.status]).toEqual(["fulfilled", "rejected"]);
      expect(await stock()).toBe(4);
      expect(await get(ref)).toMatchObject({ status: "paid", stockTaken: true, paidKobo: 5_000_000 });
    });

    it("D-05: accepting without enough stock needs the owner to say so, and then takes none", async () => {
      const ref = await link();
      await pay(ref, { amount: 5_000_000 });
      await store.setMenuStock("JOL-SMALL", 1, 6);
      await expect(co.review(ref, "accept", "owner")).rejects.toThrow(/Not enough menu stock for Party jollof/);
      expect(await get(ref)).toMatchObject({ status: "needs_review" });
      await co.review(ref, "accept", "owner", { withoutStock: true });
      expect(await get(ref)).toMatchObject({ status: "paid", stockTaken: false });
      expect(await stock()).toBe(1);
    });

    it("D-06: a new basket replaces the old link, and a late payment on it is held", async () => {
      const old = await link();
      const next = await co.createPaymentLink({ ...base, items: [{ sku: "PUFF-50", qty: 1 }] });
      const ref = String(next.reference);
      expect(next.replaced).toEqual([old]);
      expect(String(next.next_step)).toContain("not to pay the old link");
      expect(await get(old)).toMatchObject({ status: "replaced", replacedBy: ref });
      expect(await co.verifyPayment(old)).toMatchObject({ status: "replaced", replaced_by: ref, payment_url: next.payment_url });
      expect((await store.openOrdersByPhone("+2348031234567")).map((o) => o.reference)).toEqual([ref]);

      await pay(ref);
      expect((await pay(old)).status).toBe("needs_review");
      expect(explainHold(await get(old))).toBe(`Paid ₦53,000 on an old link. The customer's newer order is ${ref}, so check whether they paid twice.`);
      expect(await stock()).toBe(6);
      expect(told).toEqual([`paid ${ref}`, `held ${old}`]);
    });

    it("D-06: accepting a payment on the old link closes the newer link", async () => {
      const old = await link();
      const ref = await link({ items: [{ sku: "PUFF-50", qty: 1 }] });
      await pay(old);
      await co.review(old, "accept", "owner");
      expect(await get(ref)).toMatchObject({ status: "replaced", replacedBy: old });
      expect(await stock()).toBe(4);
    });

    it("D-06: an earlier link that was already paid is confirmed, not replaced", async () => {
      const old = await link();
      ps.set(old, { status: "success" });
      const r = await co.createPaymentLink({ ...base, items: [{ sku: "PUFF-50", qty: 1 }] });
      expect(r).toMatchObject({ ok: false, error: "earlier_order_paid", reference: old });
      expect((await get(old)).status).toBe("paid");
      expect((await co.createPaymentLink({ ...base, items: [{ sku: "PUFF-50", qty: 1 }] })).ok).toBe(true); // a separate order
    });

    it("D-06: if the new link can't be made, the old one stays payable", async () => {
      const old = await link();
      ps.before((url) => void ps.setDown(url.endsWith("/initialize")));
      expect(await co.createPaymentLink({ ...base, items: [{ sku: "PUFF-50", qty: 1 }] })).toMatchObject({ ok: false });
      ps.before();
      ps.setDown(false);
      expect((await pay(old)).status).toBe("paid");
    });

    it("D-06: a card declined on an old link doesn't bring it back", async () => {
      const old = await link();
      await link({ items: [{ sku: "PUFF-50", qty: 1 }] });
      ps.set(old, { status: "failed" });
      expect((await co.verifyPayment(old)).status).toBe("replaced");
      expect((await get(old)).status).toBe("replaced");
    });

    it("D-07: requests at the same moment make one order", async () => {
      const rs = await Promise.all(Array.from({ length: 5 }, () => co.createPaymentLink(base)));
      expect(new Set(rs.map((r) => r.reference)).size).toBe(1);
      expect(await store.listOrders()).toHaveLength(1);
      expect(ps.links()).toBe(1);
    });

    it("D-07: two servers at the same moment leave one payable link", async () => {
      await Promise.all([co.createPaymentLink(base), checkout().createPaymentLink(base)]);
      const all = await store.listOrders();
      expect(all.filter((o) => o.status === "pending_payment")).toHaveLength(1);
      const live = all.find((o) => o.status === "pending_payment")!;
      for (const o of all) if (o !== live) expect(o).toMatchObject({ status: "replaced", replacedBy: live.reference });
    });

    it("D-09: refuses an order with no date, an impossible date, or a total over the limit", async () => {
      const { neededBy: _, ...undated } = base;
      expect(await co.createPaymentLink(undated)).toMatchObject({ ok: false, error: "date_required" });
      expect(await co.createPaymentLink({ ...base, neededBy: "  " })).toMatchObject({ ok: false, error: "date_required" });
      expect(await co.createPaymentLink({ ...base, neededBy: "2026-11-31" })).toMatchObject({ ok: false, error: "bad_date" });
      expect(await co.createPaymentLink({ ...base, neededBy: "2026-11-05" })).toMatchObject({ ok: false, error: "same_day" });

      await store.setMenuStock("JOL-SMALL", 50, 6);
      const big = { ...base, deliveryZone: "Pickup", items: [{ sku: "JOL-SMALL", qty: 12 }] };
      expect(await co.checkStock([{ sku: "JOL-SMALL", qty: 13 }], "Pickup")).toMatchObject({ ok: true, total_ngn: 325000, over_limit: true });
      expect(await co.createPaymentLink({ ...big, items: [{ sku: "JOL-SMALL", qty: 13 }] })).toMatchObject({ ok: false, error: "over_limit", limit_ngn: 300000 });
      expect(await co.createPaymentLink({ ...big, deliveryZone: "Yaba" })).toMatchObject({ ok: false, error: "over_limit" }); // delivery counts
      expect(ps.calls).toHaveLength(0);
      expect(await store.listOrders()).toEqual([]);
      expect(await co.createPaymentLink(big)).toMatchObject({ ok: true, total_ngn: 300000 }); // exactly the limit is fine
    });

    it("D-10: a crash while settling leaves stock and status as they were, so the retry takes stock once", async () => {
      const ref = await link();
      await expect(
        store.transact(ref, async (o, s) => {
          expect(await s.take(o.lines)).toEqual([]);
          throw new Error("crash");
        }),
      ).rejects.toThrow("crash");
      expect(await stock()).toBe(6);
      expect((await get(ref)).status).toBe("pending_payment");
      expect((await pay(ref)).status).toBe("paid");
      expect(await stock()).toBe(4);
      expect((await get(ref)).stockTaken).toBe(true);
    });

    it("D-10: never oversells when different orders are paid together", async () => {
      const refs = await Promise.all([1, 2, 3, 4, 5].map((n) => link({ customerPhone: `0803000000${n}`, items: [{ sku: "JOL-LARGE", qty: 1 }] })));
      const rs = await Promise.all(refs.map((r) => pay(r)));
      expect(rs.filter((r) => r.status === "paid")).toHaveLength(3);
      expect(rs.filter((r) => r.status === "needs_review")).toHaveLength(2);
      expect(await stock("JOL-LARGE")).toBe(0);
    });

    const ops = () => new Operations(store, new MemoryOpsStore(), { now: () => now });

    it("D-11: a reversal after confirmation pauses the order and tells the owner once", async () => {
      const ref = await link();
      await pay(ref);
      ps.set(ref, { status: "reversed" });
      expect(await co.recheckPaid(ref)).toMatchObject({ ok: true, changed: true });
      expect(await co.recheckPaid(ref.toLowerCase())).toMatchObject({ changed: false });
      expect(told).toEqual([`paid ${ref}`, "refund 5300000", "issue reversed"]);
      expect((await co.paymentIssues()).map((o) => o.reference)).toEqual([ref]);
      expect((await co.verifyPayment(ref)).next_step).toContain("Do not promise delivery");

      const o = ops();
      const kemi: Actor = { kind: "staff", staff: { id: "k", name: "K", phone: "", roles: ["intake"], active: true } };
      await expect(o.move(ref, "accepted", kemi)).rejects.toThrow(/Wait for the owner/);
      expect((await o.detail(ref, kemi)).nextStages).toEqual([]);
      expect(await o.customerStatus(ref)).toMatchObject({ payment_issue: "reversed" });
      await co.clearIssue(ref, "owner");
      expect((await o.move(ref, "accepted", kemi)).ops.stage).toBe("accepted");
      await expect(co.clearIssue(ref, "owner")).rejects.toBeInstanceOf(ReviewError);
      expect(await co.recheckPaid(ref)).toMatchObject({ changed: false }); // settled, so not raised again
    });

    it("D-11: the reconciliation job finds a reversal without a webhook", async () => {
      const ref = await link();
      await pay(ref);
      const rec = new Reconciler(store, co, { now: () => now });
      ps.set(ref, { status: "reversed" });
      expect((await rec.run()).found).toEqual([ref]);
      now = new Date(now.getTime() + 25 * 3600_000);
      expect((await rec.run()).found).toEqual([]);
    });

    it("D-11: a partial refund is recorded and the order carries on; a full one pauses it; pending ones don't count", async () => {
      const ref = await link();
      await pay(ref);
      ps.refund(ref, "1000000");
      ps.refund(ref, 500_000, "pending");
      ps.set(ref, { status: "reversed" }); // Paystack may show this on any refund
      await co.recheckPaid(ref);
      expect(await get(ref)).toMatchObject({ refundedKobo: 1_000_000, status: "paid" });
      expect((await get(ref)).paymentIssue).toBeUndefined();
      ps.refund(ref, 4_300_000);
      await co.recheckPaid(ref, "refund_failed");
      expect((await get(ref)).paymentIssue).toMatchObject({ kind: "refunded" });
      expect(told).toEqual([`paid ${ref}`, "refund 1000000", "refund failed", "refund 5300000", "issue refunded"]);
    });

    it("D-11: disputes pause the order; winning lifts it, losing records the money", async () => {
      const ref = await link();
      await pay(ref);
      ps.dispute(7, ref, { status: "awaiting-merchant-feedback", refund_amount: 5_300_000 });
      await co.recordDispute(ref, "7");
      await co.recordDispute(ref, "7"); // a reminder
      expect(told).toEqual([`paid ${ref}`, "issue disputed"]);
      ps.dispute(7, ref, { status: "resolved", resolution: "declined" });
      await co.recordDispute(ref, "7");
      expect((await get(ref)).paymentIssue).toMatchObject({ resolvedBy: "paystack" });
      expect(refundKobo(await get(ref))).toBe(0);

      ps.dispute(8, ref, { status: "awaiting-merchant-feedback" });
      await co.recordDispute(ref, "8");
      ps.dispute(8, ref, { status: "resolved", resolution: "merchant-accepted", refund_amount: 5_300_000 });
      await co.recordDispute(ref, "8");
      await co.recordDispute(ref, "8");
      expect(told).toEqual([`paid ${ref}`, "issue disputed", "issue disputed", "refund 5300000", "issue disputed"]);
      expect((await get(ref)).paymentIssue!.detail).toContain("Dispute lost: ₦53,000");
    });

    it("D-11: ignores a dispute that belongs to another order, or that Paystack doesn't know", async () => {
      const ref = await link();
      await pay(ref);
      ps.dispute(9, "MTK-SOMEONE-ELSE", { status: "awaiting-merchant-feedback" });
      await co.recordDispute(ref, "9");
      await co.recordDispute(ref, "404");
      expect((await get(ref)).paymentIssue).toBeUndefined();
    });

    it("D-11: a reversed order the owner accepted on other money isn't reversed again", async () => {
      const ref = await link();
      ps.set(ref, { status: "reversed" });
      expect((await co.verifyPayment(ref)).status).toBe("needs_review");
      await expect(co.review(ref, "accept", "owner")).rejects.toThrow(/Enter the amount received/);
      await co.review(ref, "accept", "owner", { receivedKobo: 5_300_000 });
      expect(await co.recheckPaid(ref)).toMatchObject({ changed: false });
      expect(netNgn(await get(ref))).toBe(53000);
    });

    it("D-12: Leadaut gets the money received and the refund agreed, not the order total", async () => {
      const sent: Record<string, unknown>[] = [];
      const box = new RevenueOutbox({ url: "https://l.test/h", secret: "s".repeat(20), fetchImpl: (async (_u: string, i: RequestInit) => (sent.push(JSON.parse(String(i.body))), new Response('{"ok":true}'))) as unknown as typeof fetch });
      const sync = new RevenueSync(box);
      co = new Checkout(store, ps.paystack, { now: () => now, onPaid: (o) => sync.paid(o), onRefund: (o) => sync.refund(o) });
      const ref = await link();
      await pay(ref, { amount: 5_000_000 });
      await co.review(ref, "accept", "owner");
      now = new Date("2026-11-09T10:00:00Z"); // under 24 hours before 10am on the 10th: half
      const o = new Operations(store, new MemoryOpsStore(), { now: () => now, onStageChange: async (e) => sync.stage(e, (await store.getOrder(e.reference))!) });
      await o.move(ref, "cancelled", owner);
      await co.setRefund(ref, 5_000_000); // the owner decides to give it all back
      await co.setRefund(ref, 5_000_000);
      ps.refund(ref, 5_000_000); // and Paystack confirms it
      await co.recheckPaid(ref);
      await box.flush();
      expect(sent.map((b) => [b.status, b.total, (b.refunds as { total: string }[])[0]?.total])).toEqual([
        ["processing", "50000.00", undefined],
        ["completed", "50000.00", "-25000.00"],
        ["refunded", "50000.00", "-50000.00"],
      ]);
      expect((await get(ref)).paymentIssue).toBeUndefined(); // the owner asked for this refund
    });

    it("D-12: refuses refunds that don't fit what was received", async () => {
      const ref = await link();
      await expect(co.setRefund(ref, 100)).rejects.toThrow(/paid order/);
      await pay(ref);
      await expect(co.setRefund(ref, 5_300_001)).rejects.toThrow(/more than/);
      await expect(co.setRefund(ref, NaN)).rejects.toThrow(/Enter the refund/);
      await expect(ops().move(ref, "cancelled", owner, { refundKobo: NaN })).rejects.toThrow(/Enter the refund/);
      expect(await get(ref)).not.toHaveProperty("cancelledAt");
      expect(await stock()).toBe(4);
    });

    it("D-12: a cancellation refunds all of it up to 24 hours before the delivery window, then half", async () => {
      const o = ops();
      const order = async () => ({ ...(await get(await link())), paidKobo: 5_300_000 }) as Order;
      const it = await order();
      now = new Date("2026-11-09T09:00:00Z");
      expect(o.suggestedRefundKobo(it)).toBe(5_300_000);
      now = new Date("2026-11-09T09:00:01Z");
      expect(o.suggestedRefundKobo(it)).toBe(2_650_000);
      expect(paidKobo({ ...it, paidKobo: undefined })).toBe(5_300_000); // orders from before amounts were kept
    });

    it("D-13: cancelling before cooking puts the items back once; after cooking starts they stay sold", async () => {
      const early = await link();
      await pay(early);
      const o = ops();
      await o.move(early, "accepted", owner);
      expect(await stock()).toBe(4);
      const tries = await Promise.allSettled([o.move(early, "cancelled", owner), o.move(early, "cancelled", owner), o.move(early, "cooking", owner)]);
      expect(tries.map((t) => t.status)).toEqual(["fulfilled", "rejected", "rejected"]);
      expect(await stock()).toBe(6);

      const late = await link({ customerPhone: "08030000003" });
      await pay(late);
      for (const s of ["accepted", "cooking", "cancelled"] as const) await o.move(late, s, owner);
      expect(await stock()).toBe(4);
    });

    it("D-13: the owner, and only the owner, can cancel an order that's out for delivery", async () => {
      const ref = await link();
      await pay(ref);
      const o = ops();
      for (const s of ["accepted", "cooking", "ready", "out_for_delivery"] as const) await o.move(ref, s, owner);
      const dispatch: Actor = { kind: "staff", staff: { id: "d", name: "D", phone: "", roles: ["dispatch", "rider"], active: true } };
      await expect(o.move(ref, "cancelled", dispatch)).rejects.toMatchObject({ code: "forbidden" });
      expect((await o.move(ref, "cancelled", owner)).ops.stage).toBe("cancelled");
    });

    it("D-13: a cancellation cut short can be run again without restocking twice", async () => {
      const ref = await link();
      await pay(ref);
      const opsStore = new MemoryOpsStore();
      const save = opsStore.saveOrderOps.bind(opsStore);
      opsStore.saveOrderOps = async () => {
        throw new Error("crash");
      };
      const o = new Operations(store, opsStore, { now: () => now });
      await expect(o.move(ref, "cancelled", owner, { refundKobo: 1_000_000 })).rejects.toThrow("crash");
      opsStore.saveOrderOps = save;
      await o.move(ref, "cancelled", owner);
      expect(await stock()).toBe(6);
      expect(await get(ref)).toMatchObject({ refundDueKobo: 1_000_000, refundSeq: 1 });
    });

    it("D-13: an order accepted without stock has none to put back", async () => {
      const ref = await link();
      await pay(ref, { amount: 5_000_000 });
      await store.setMenuStock("JOL-SMALL", 0, 6);
      await co.review(ref, "accept", "owner", { withoutStock: true });
      await ops().move(ref, "cancelled", owner);
      expect(await stock()).toBe(0);
    });

    it("keeps every order field through a save", async () => {
      const ref = await link();
      const all: Partial<Order> = { paidKobo: 1, stockTaken: false, replacedBy: "X", cancelledAt: "2026-11-05", refundDueKobo: 2, refundedKobo: 3, refundBaseKobo: 4, refundSeq: 5, paymentIssue: { kind: "disputed", at: "t", detail: "d", disputeId: "1" } };
      await store.updateOrder(ref, all);
      expect(await get(ref)).toMatchObject(all);
    });
  });
});
