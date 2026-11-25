import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Checkout, ToolResult } from "./checkout.js";
import { buildMcpServer, loggableReference } from "./mcp.js";
import type { Operations } from "./ops/operations.js";
import { adminRouter, type AdminDeps } from "./admin/routes.js";
import { handlePaymentEvent, parsePaystackEvent, PaymentEvents, type PaymentEvent } from "./payment-events.js";
import { forwardToChord, verifyPaystackSignature } from "./webhook.js";
import type { Fetch } from "./paystack.js";

type ChordTarget = { url: string; secret: string; fetchImpl?: Fetch };
type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Tell Chord about a payment that was confirmed or held. Nothing else is forwarded. */
export async function forwardPayment(chord: ChordTarget | undefined, result: ToolResult, log: Log) {
  if (!chord || !result.ok || (result.status !== "paid" && result.status !== "needs_review")) return;
  const reference = String(result.reference);
  const fwd = await forwardToChord(chord, {
    event_type: result.status === "paid" ? "order.paid" : "order.needs_review",
    event_id: `${reference}:${result.status}`,
    reference,
    status: result.status,
    total_ngn: result.total_ngn,
    lines: result.lines,
    zone: result.zone,
    note: result.note,
  });
  log("chord_event_forwarded", { reference, ...fwd });
}

/** Handle one Paystack event: settle or re-check the order, then tell Chord. Throws to be tried again. */
export function paymentEventHandler(checkout: Checkout, chord: ChordTarget | undefined, log: Log) {
  return async (e: PaymentEvent) => {
    const result = await handlePaymentEvent(checkout, e);
    log("paystack_webhook_processed", { event: e.type, reference: e.reference, status: result.status, ok: result.ok });
    if (e.type === "charge.success") await forwardPayment(chord, result, log);
  };
}

export type AppDeps = {
  checkout: Checkout;
  mcpBearerToken: string;
  paystackSecretKey: string;
  chord?: ChordTarget;
  /** Paystack's webhooks, kept until they're handled. Made here, in memory, when not given. */
  payments?: PaymentEvents;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Which store is live ("memory" or "sheets"), shown on /healthz so a deploy can be checked from outside. */
  storeName?: string;
  /** Counts from the Leadaut outbox, shown on /healthz. */
  revenueStatus?: () => { pending: number; sent: number; dead: number } | undefined;
  /** Kitchen operations: adds the order_status tool. */
  operations?: Operations;
  /** Admin portal at /admin. Off when not given. */
  admin?: AdminDeps;
};

function bearerOk(header: string | undefined, token: string) {
  const got = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.set("trust proxy", 1); // Render and Caddy terminate TLS in front of us
  const log = deps.log ?? ((msg, extra) => console.log(JSON.stringify({ msg, ...extra, at: new Date().toISOString() })));

  const payments = deps.payments ?? new PaymentEvents(paymentEventHandler(deps.checkout, deps.chord, log), { log });

  app.get("/healthz", (_req, res) => {
    const r = deps.revenueStatus?.();
    res.json({ ok: true, store: deps.storeName ?? "memory", leadaut: r ? { pending: r.pending, sent: r.sent, failed: r.dead } : "off", ...(deps.payments ? { payments: deps.payments.status() } : {}) });
  });

  // Paystack webhook needs the raw bytes for the signature check, so it is registered before express.json().
  app.post("/webhooks/paystack", express.raw({ type: "*/*", limit: "256kb" }), async (req: Request, res: Response) => {
    // The body is only used to find the order: amounts and statuses are always asked of Paystack.
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifyPaystackSignature(raw, req.header("x-paystack-signature"), deps.paystackSecretKey)) {
      log("paystack_webhook_bad_signature");
      res.status(401).json({ ok: false });
      return;
    }
    let event: PaymentEvent | undefined;
    try {
      event = parsePaystackEvent(raw);
    } catch {
      log("paystack_webhook_bad_json");
    }
    if (!event) {
      log("paystack_webhook_ignored");
      res.status(200).json({ ok: true });
      return;
    }
    // Only a 200 stops Paystack sending it again, so it goes out once the event is safe: saved to
    // the database, or (on a store that can't keep it) acted on.
    let safe = false;
    try {
      safe = await payments.receive(event);
    } catch (e) {
      log("paystack_webhook_not_saved", { event: event.type, reference: event.reference, error: e instanceof Error ? e.message : String(e) });
    }
    res.status(safe ? 200 : 503).json({ ok: safe });
  });

  if (deps.admin) {
    app.use("/admin", adminRouter(deps.admin));
  } else {
    app.use("/admin", (_req: Request, res: Response) => {
      res.status(404).type("text").send("The admin portal is off. Set ADMIN_PASSWORD (at least 10 characters) to turn it on.");
    });
  }

  app.use(express.json({ limit: "1mb" }));

  const requireBearer = (req: Request, res: Response, next: NextFunction) => {
    if (!bearerOk(req.header("authorization"), deps.mcpBearerToken)) {
      res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
      return;
    }
    next();
  };

  // Stateless MCP over streamable HTTP: a fresh server + transport per request.
  app.post("/mcp", requireBearer, async (req: Request, res: Response) => {
    // Logged on arrival as well as on result, so a call refused for bad arguments still shows up.
    for (const m of Array.isArray(req.body) ? req.body : [req.body]) {
      if (m?.method !== "tools/call") continue;
      log("tool_call", { tool: String(m.params?.name).slice(0, 40), reference: loggableReference(m.params?.arguments?.reference) });
    }
    const server = buildMcpServer(deps.checkout, deps.operations, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log("mcp_error", { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
