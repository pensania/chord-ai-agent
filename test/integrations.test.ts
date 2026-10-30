import request from "supertest";
import { describe, expect, it } from "vitest";
import { signSession } from "../src/admin/auth.js";
import { Checkout } from "../src/checkout.js";
import { MemoryOpsStore } from "../src/ops/memory.js";
import { Operations } from "../src/ops/operations.js";
import { Paystack } from "../src/paystack.js";
import { LeadautLink } from "../src/revenue/connection.js";
import { RevenueOutbox, signRevenueBody } from "../src/revenue/outbox.js";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import { fakeFetch, TEST_KEY } from "./helpers.js";

const PASSWORD = "correct-horse-battery";
const HOOK = "https://api.leadaut.test/api/webhooks/ecommerce/woocommerce/0b7c";
const SECRET = "lds_wc_0123456789abcdef0123456789abcdef";

/** Plays Leadaut's store webhook: checks the signature like it does, answers 200 either way. */
function leadautStub(knownSecret = SECRET) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    if (!url.startsWith(HOOK)) return new Response("Not found", { status: 404 });
    const sig = (init.headers as Record<string, string>)["X-WC-Webhook-Signature"];
    const ok = sig === signRevenueBody(String(init.body), knownSecret);
    return new Response(JSON.stringify(ok ? { ok: true, info: "ping_acknowledged_json" } : { ok: false, error: "bad_signature" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

async function setup() {
  const store = new MemoryStore();
  const opsStore = new MemoryOpsStore();
  const operations = new Operations(store, opsStore);
  const { f } = fakeFetch(() => ({ status: 500, body: {} }));
  const checkout = new Checkout(store, new Paystack({ secretKey: TEST_KEY, fetchImpl: f }));
  const stub = leadautStub();
  const leadaut = new LeadautLink({ outbox: new RevenueOutbox({ fetchImpl: stub.fetchImpl }) });
  const app = createApp({
    checkout,
    mcpBearerToken: "tok",
    paystackSecretKey: TEST_KEY,
    operations,
    admin: { operations, opsStore, ownerPassword: PASSWORD, sessionSecret: "s3cret", leadaut },
    log: () => {},
  });
  const owner = request.agent(app);
  await owner.post("/admin/login").type("form").send({ who: "owner", secret: PASSWORD }).expect(303);
  return { app, owner, leadaut, stub };
}

describe("integrations page", () => {
  it("is for the owner only, and shows in the owner's sidebar", async () => {
    const { app, owner } = await setup();
    const page = await owner.get("/admin/integrations").expect(200);
    expect(page.text).toContain("Connect Leadaut");
    expect(page.text).toContain('href="/admin/integrations"');
    const staff = `mtk_admin=${signSession("staff:kemi", "s3cret")}`;
    const queue = await request(app).get("/admin").set("Cookie", staff).expect(200);
    expect(queue.text).not.toContain('href="/admin/integrations"');
    await request(app).get("/admin/integrations").set("Cookie", staff).expect(403);
    await request(app).post("/admin/integrations/leadaut").set("Cookie", staff).type("form").send({ url: HOOK, secret: SECRET }).expect(403);
  });

  it("checks the URL and secret with Leadaut before saving, without sending an order", async () => {
    const { owner, leadaut, stub } = await setup();
    const res = await owner.post("/admin/integrations/leadaut").type("form").send({ url: HOOK, secret: SECRET }).expect(303);
    expect(decodeURIComponent(res.headers.location)).toContain("Leadaut connected");
    expect(leadaut.view()).toMatchObject({ connected: true, source: "portal", url: HOOK, secretEnd: "cdef", lastCheck: { ok: true } });
    expect(stub.calls).toHaveLength(1);
    expect(JSON.parse(stub.calls[0].body)).toEqual({ webhook_id: "chord-connection-check" });
    const page = await owner.get("/admin/integrations").expect(200);
    expect(page.text).toContain("••••cdef");
    expect(page.text).not.toContain(SECRET);
  });

  it("doesn't save a secret Leadaut rejects, or a URL that isn't https", async () => {
    const { owner, leadaut } = await setup();
    const bad = await owner.post("/admin/integrations/leadaut").type("form").send({ url: HOOK, secret: "lds_wc_wrongwrongwrongwrong" }).expect(400);
    expect(bad.text).toContain("didn&#39;t accept the secret");
    expect(leadaut.connected).toBe(false);
    const http = await owner.post("/admin/integrations/leadaut").type("form").send({ url: "http://api.leadaut.test/x", secret: SECRET }).expect(400);
    expect(http.text).toContain("must start with https://");
    const missing = await owner.post("/admin/integrations/leadaut").type("form").send({ url: "https://api.leadaut.test/nope", secret: SECRET }).expect(400);
    expect(missing.text).toContain("Nothing at that URL");
    expect(leadaut.connected).toBe(false);
  });

  it("keeps the saved secret when only the URL is resubmitted, and can disconnect", async () => {
    const { owner, leadaut } = await setup();
    await owner.post("/admin/integrations/leadaut").type("form").send({ url: HOOK, secret: SECRET }).expect(303);
    await owner.post("/admin/integrations/leadaut").type("form").send({ url: HOOK, secret: "" }).expect(303);
    expect(leadaut.secret()).toBe(SECRET);
    await owner.post("/admin/integrations/leadaut/disconnect").expect(303);
    expect(leadaut.connected).toBe(false);
  });
});

describe("leadaut link", () => {
  it("only queues orders while connected, and sends waiting ones once a secret is fixed", async () => {
    let now = 0;
    const stub = leadautStub();
    const link = new LeadautLink({ outbox: new RevenueOutbox({ fetchImpl: stub.fetchImpl, now: () => now }) });
    const order = { reference: "MTK-1", createdAt: "2026-11-05T08:00:00Z", customerName: "Ada Obi", customerPhone: "+2348031234567", lines: [], deliveryZone: "Yaba", deliveryAddress: "", subtotalNgn: 0, deliveryFeeNgn: 0, totalNgn: 0, status: "paid", paidAt: "2026-11-05T08:05:00Z" } as never;
    link.paid(order);
    expect(link.view().outbox.pending).toBe(0);

    link.connect(HOOK, "lds_wc_wrongwrongwrongwrong", "render");
    link.paid(order);
    await link.outbox.flush();
    expect(link.view().outbox).toMatchObject({ dead: 1, lastError: "leadaut: bad_signature" });

    link.connect(HOOK, SECRET, "portal");
    expect(link.retryFailed()).toBe(1);
    await link.outbox.flush();
    expect(link.view().outbox).toMatchObject({ dead: 0, sent: 1 });
  });
});
