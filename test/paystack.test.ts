import { describe, expect, it } from "vitest";
import { Paystack, PaystackError } from "../src/paystack.js";
import { fakeFetch, noSleep, TEST_KEY } from "./helpers.js";

describe("Paystack client", () => {
  it("refuses live keys", () => {
    expect(() => new Paystack({ secretKey: "sk_live_x" })).toThrow(/test key/);
  });

  it("retries 5xx then succeeds", async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() => (++n < 3 ? { status: 502, body: "<html>bad gateway</html>" } : { status: 200, body: { status: true, data: { authorization_url: "https://checkout.paystack.com/x", reference: "R1" } } }));
    const p = new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep });
    const r = await p.initialize({ email: "a@b.c", amountKobo: 100, reference: "R1" });
    expect(r.authorizationUrl).toContain("paystack");
    expect(calls).toHaveLength(3);
  });

  it("gives up after retries with provider_down", async () => {
    const { f } = fakeFetch(() => ({ status: 503, body: {} }));
    const p = new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep });
    await expect(p.verify("R1")).rejects.toMatchObject({ kind: "provider_down" });
  });

  it("does not retry a 4xx and maps 'not found'", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 400, body: { status: false, message: "Transaction reference not found" } }));
    const p = new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep });
    const err = await p.verify("NOPE").catch((e) => e);
    expect(err).toBeInstanceOf(PaystackError);
    expect(err.kind).toBe("not_found");
    expect(calls).toHaveLength(1);
  });

  it("treats an empty success body as rejected, not success", async () => {
    const { f } = fakeFetch(() => ({ status: 200, body: { status: true, data: null } }));
    const p = new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep });
    await expect(p.verify("R1")).rejects.toMatchObject({ kind: "rejected" });
  });
});
