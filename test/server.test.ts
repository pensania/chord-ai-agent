import { createHmac } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { Checkout } from "../src/checkout.js";
import { Paystack } from "../src/paystack.js";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import { signChordEvent } from "../src/webhook.js";
import { fakeFetch, noSleep, TEST_KEY } from "./helpers.js";

function setup(chordFetch?: ReturnType<typeof fakeFetch>) {
  const store = new MemoryStore();
  let status = "abandoned";
  const { f } = fakeFetch((url, init) =>
    url.endsWith("/initialize")
      ? { status: 200, body: { status: true, data: { authorization_url: "https://checkout.paystack.com/x", reference: JSON.parse(String(init?.body)).reference } } }
      : { status: 200, body: { status: true, data: { status, amount: 5_300_000, currency: "NGN" } } },
  );
  const checkout = new Checkout(store, new Paystack({ secretKey: TEST_KEY, fetchImpl: f, sleep: noSleep }));
  const app = createApp({
    checkout,
    mcpBearerToken: "tok",
    paystackSecretKey: TEST_KEY,
    chord: chordFetch ? { url: "https://chord.example/api/events/webhook/sub_1", secret: "chordsecret", fetchImpl: chordFetch.f } : undefined,
    log: () => {},
  });
  return { app, store, checkout, markPaid: () => (status = "success") };
}

const mcpHeaders = { Authorization: "Bearer tok", Accept: "application/json, text/event-stream", "Content-Type": "application/json" };

describe("/healthz", () => {
  it("reports which store is live", async () => {
    const { app } = setup();
    const res = await request(app).get("/healthz").expect(200);
    expect(res.body).toEqual({ ok: true, store: "memory", leadaut: "off" });
  });
});

describe("MCP endpoint", () => {
  it("rejects calls without the bearer token", async () => {
    const { app } = setup();
    await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(401);
  });

  it("lists the three tools", async () => {
    const { app } = setup();
    await request(app)
      .post("/mcp")
      .set(mcpHeaders)
      .send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
      .expect(200);
    const res = await request(app).post("/mcp").set(mcpHeaders).send({ jsonrpc: "2.0", id: 1, method: "tools/list" }).expect(200);
    expect(res.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["check_stock", "create_payment_link", "verify_payment"]);
  });

  it("runs check_stock end to end", async () => {
    const { app } = setup();
    const res = await request(app)
      .post("/mcp")
      .set(mcpHeaders)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "check_stock", arguments: { items: [{ sku: "JOL-SMALL", qty: 1 }], delivery_zone: "Lekki" } } })
      .expect(200);
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload).toMatchObject({ ok: true, total_ngn: 31000 });
  });
});

describe("Paystack webhook", () => {
  const sign = (body: string) => createHmac("sha512", TEST_KEY).update(body).digest("hex");

  it("rejects a bad signature", async () => {
    const { app } = setup();
    await request(app).post("/webhooks/paystack").set("x-paystack-signature", "nope").set("Content-Type", "application/json").send("{}").expect(401);
  });

  it("re-verifies with Paystack, marks the order paid and forwards a signed Chord event", async () => {
    const chord = fakeFetch(() => ({ status: 200, body: { accepted: true } }));
    const { app, store, checkout, markPaid } = setup(chord);
    const link = await checkout.createPaymentLink({ customerName: "Ada", customerPhone: "08031234567", items: [{ sku: "JOL-SMALL", qty: 2 }], deliveryZone: "Yaba", deliveryAddress: "12 Herbert Macaulay Way" });
    markPaid();
    const body = JSON.stringify({ event: "charge.success", data: { reference: link.reference, amount: 1 } });
    await request(app).post("/webhooks/paystack").set("x-paystack-signature", sign(body)).set("Content-Type", "application/json").send(body).expect(200);
    await new Promise((r) => setTimeout(r, 20)); // work happens after the 200

    expect((await store.getOrder(String(link.reference)))?.status).toBe("paid");
    expect(chord.calls).toHaveLength(1);
    const sent = chord.calls[0];
    const headers = sent.init?.headers as Record<string, string>;
    const expected = signChordEvent(String(sent.init?.body), "chordsecret", Number(headers["X-Chord-Timestamp"]));
    expect(headers["X-Chord-Signature"]).toBe(expected["X-Chord-Signature"]);
    expect(JSON.parse(String(sent.init?.body))).toMatchObject({ event_type: "order.paid", event_id: `${link.reference}:paid` });
  });
});
