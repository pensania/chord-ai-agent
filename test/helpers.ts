import type { Fetch } from "../src/paystack.js";

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
