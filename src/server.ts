import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Checkout } from "./checkout.js";
import { buildMcpServer } from "./mcp.js";
import type { Operations } from "./ops/operations.js";
import { adminRouter, type AdminDeps } from "./admin/routes.js";
import { forwardToChord, verifyPaystackSignature } from "./webhook.js";
import type { Fetch } from "./paystack.js";

export type AppDeps = {
  checkout: Checkout;
  mcpBearerToken: string;
  paystackSecretKey: string;
  chord?: { url: string; secret: string; fetchImpl?: Fetch };
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

  app.get("/healthz", (_req, res) => {
    const r = deps.revenueStatus?.();
    res.json({ ok: true, store: deps.storeName ?? "memory", leadaut: r ? { pending: r.pending, sent: r.sent, failed: r.dead } : "off" });
  });

  // Paystack webhook needs the raw bytes for the signature check, so it is registered before express.json().
  app.post("/webhooks/paystack", express.raw({ type: "*/*", limit: "256kb" }), async (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!verifyPaystackSignature(raw, req.header("x-paystack-signature"), deps.paystackSecretKey)) {
      log("paystack_webhook_bad_signature");
      res.status(401).json({ ok: false });
      return;
    }
    // Acknowledge fast; Paystack retries if we are slow. Then do the work.
    res.status(200).json({ ok: true });

    let event: { event?: string; data?: { reference?: string } };
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      log("paystack_webhook_bad_json");
      return;
    }
    const reference = event.data?.reference;
    if (event.event !== "charge.success" || !reference) {
      log("paystack_webhook_ignored", { event: event.event });
      return;
    }
    // Never trust the webhook body for money: re-verify with the API.
    const result = await deps.checkout.verifyPayment(reference, "webhook");
    log("paystack_webhook_processed", { reference, status: result.status, ok: result.ok });

    if (deps.chord && result.ok && (result.status === "paid" || result.status === "needs_review")) {
      const fwd = await forwardToChord(deps.chord, {
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
    const server = buildMcpServer(deps.checkout, deps.operations);
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
