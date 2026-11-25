import { Paystack, type Fetch } from "../src/paystack.js";

type Route = (url: string, init?: RequestInit) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;

/** A fake fetch that records calls and answers from a route function. */
export function fakeFetch(route: Route) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f: Fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    const r = await route(url, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  };
  return { f, calls };
}

export const noSleep = async () => {};
export const TEST_KEY = "sk_test_unit";

/** A day that is always a valid needed_by, whenever the tests run. */
export const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 3600_000).toISOString().slice(0, 10);

type Tx = { id: number; amount: number; status: string; currency?: string; gateway_response?: string };

/** Minimal in-memory Paystack: initialize stores the amount; tests set what verify, refunds and disputes return. */
export function fakePaystack() {
  const tx = new Map<string, Tx>();
  const refunds: { transaction: number; amount: number | string; status: string }[] = [];
  const disputes = new Map<string, { id: number; status: string; resolution?: string | null; refund_amount?: number; transaction: { reference: string } }>();
  let down = false;
  /** Runs before each answer, to make something happen mid-call. */
  let before: ((url: string) => Promise<void> | void) | undefined;
  const { f, calls } = fakeFetch(async (url, init) => {
    await before?.(url);
    if (down) return { status: 503, body: {} };
    const ok = (data: unknown) => ({ status: 200, body: { status: true, data } });
    if (url.endsWith("/transaction/initialize")) {
      const b = JSON.parse(String(init?.body));
      tx.set(b.reference, { id: 1000 + tx.size, amount: b.amount, status: "abandoned" });
      return ok({ authorization_url: `https://checkout.paystack.com/${b.reference}`, reference: b.reference });
    }
    if (url.includes("/refund?")) return ok(refunds.filter((r) => String(r.transaction) === new URL(url).searchParams.get("transaction")));
    if (url.includes("/dispute/")) {
      const d = disputes.get(url.split("/dispute/")[1]);
      return d ? ok(d) : { status: 404, body: { status: false, message: "Dispute not found" } };
    }
    const t = tx.get(decodeURIComponent(url.split("/transaction/verify/")[1] ?? ""));
    if (!t) return { status: 400, body: { status: false, message: "Transaction reference not found" } };
    return ok({ id: t.id, status: t.status, amount: t.amount, currency: t.currency ?? "NGN", gateway_response: t.gateway_response, paid_at: "2026-10-25T10:00:00Z" });
  });
  return {
    paystack: new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep }),
    calls,
    links: () => calls.filter((c) => c.url.endsWith("/initialize")).length,
    set: (ref: string, patch: Partial<Omit<Tx, "id">>) => Object.assign(tx.get(ref)!, patch),
    /** A transaction Paystack knows about that wasn't made through `initialize` here. */
    add: (ref: string, t: Omit<Tx, "id">) => tx.set(ref, { id: 1000 + tx.size, ...t }),
    refund: (ref: string, amount: number | string, status = "processed") => refunds.push({ transaction: tx.get(ref)!.id, amount, status }),
    dispute: (id: number, ref: string, patch: { status: string; resolution?: string | null; refund_amount?: number }) => disputes.set(String(id), { id, transaction: { reference: ref }, ...patch }),
    setDown: (v: boolean) => (down = v),
    before: (fn?: typeof before) => (before = fn),
  };
}
