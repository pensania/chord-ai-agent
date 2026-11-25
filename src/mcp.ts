import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Checkout, ToolResult } from "./checkout.js";
import type { Operations } from "./ops/operations.js";

const item = z.object({
  sku: z.string().describe("Menu SKU, e.g. JOL-SMALL"),
  qty: z.number().int().min(1).max(50),
});

function asContent(result: ToolResult) {
  // Business failures (out of stock, payment failed) are normal results, not tool errors, so the model reads next_step.
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** Text from the model that's safe to log: an order reference and nothing else, so no phone or name slips in. */
export const loggableReference = (v: unknown) => (typeof v === "string" && /^MTK-[A-Z0-9-]{1,20}$/i.test(v.trim()) ? v.trim().toUpperCase() : undefined);

/** Run a tool and log what came back, so a reply in the chat can be matched to a real call. No customer details are logged. */
async function safely(tool: string, log: Log, fn: () => Promise<ToolResult>) {
  const started = Date.now();
  const done = (r: ToolResult) => {
    log("tool_result", { tool, reference: loggableReference(r.reference), ok: r.ok, status: r.status, error: r.error, already_confirmed: r.already_confirmed, total_ngn: r.total_ngn, ms: Date.now() - started });
    return asContent(r);
  };
  try {
    return done(await fn());
  } catch (e) {
    // Store or network failure we didn't anticipate. Tell the model plainly instead of throwing a protocol error.
    console.error("tool error", e);
    return done({ ok: false, error: "internal_error", next_step: "Something went wrong on our side. Apologise and say a staff member will reply shortly. Do not confirm anything." });
  }
}

export function buildMcpServer(checkout: Checkout, ops?: Operations, log: Log = () => {}) {
  const server = new McpServer({ name: "mama-tolas-checkout", version: "0.2.0" });

  server.registerTool(
    "check_stock",
    {
      title: "Check menu and stock",
      description:
        "Get the live menu with prices, and what can be made for a day. If items are given, also check they can be made and compute the exact total including delivery. Each day has its own capacity, so give needed_by as soon as you know the day. Always use this for prices; never calculate totals yourself.",
      inputSchema: { items: z.array(item).optional(), delivery_zone: z.string().optional().describe("One of the delivery zones, or 'Pickup'"), needed_by: z.string().optional().describe("Calendar date the customer needs the order, YYYY-MM-DD") },
      annotations: { readOnlyHint: true },
    },
    async ({ items, delivery_zone, needed_by }) => safely("check_stock", log, () => checkout.checkStock(items, delivery_zone, needed_by)),
  );

  server.registerTool(
    "create_payment_link",
    {
      title: "Create Paystack payment link",
      description:
        "Create the order and a Paystack payment link for it. Only call after the customer has confirmed items, delivery zone and address. Safe to call twice: the same unpaid basket returns the same link, with any new day, time or address saved on it. A different basket replaces the customer's earlier unpaid link, so put everything they want in one order.",
      inputSchema: {
        customer_name: z.string().min(1),
        customer_phone: z.string().min(7).describe("Customer's WhatsApp number"),
        customer_email: z.string().email().optional().describe("Only if the customer offers one. Never ask for it; payment works without it."),
        items: z.array(item).min(1),
        delivery_zone: z.string(),
        delivery_address: z.string().min(3).describe("Full street address with house number or a landmark, or 'Pickup'"),
        needed_by: z.string().describe("Required. Calendar date the customer needs the order, YYYY-MM-DD (use `today` from check_stock to work it out)"),
        deliver_by: z.string().optional().describe("Latest time the customer wants it that day, 24-hour HH:MM between 10:00 and 18:00, e.g. 13:00 for 'by 1pm'. Always send it if they gave a time; the kitchen only sees it here."),
      },
    },
    async (a) =>
      safely("create_payment_link", log, () =>
        checkout.createPaymentLink({
          customerName: a.customer_name,
          customerPhone: a.customer_phone,
          customerEmail: a.customer_email,
          items: a.items,
          deliveryZone: a.delivery_zone,
          deliveryAddress: a.delivery_address,
          neededBy: a.needed_by,
          deliverBy: a.deliver_by,
        }),
      ),
  );

  server.registerTool(
    "verify_payment",
    {
      title: "Verify payment with Paystack",
      description:
        "Ask Paystack whether the order with this reference has been paid. The only way to confirm an order. Call when the customer says they've paid, or asks whether their payment arrived. Not for thanks or goodbyes, and not to re-check a confirmation you already sent.",
      inputSchema: { reference: z.string().min(4).describe("Order reference, e.g. MTK-261025-AB12C") },
      annotations: { idempotentHint: true },
    },
    async ({ reference }) => safely("verify_payment", log, () => checkout.verifyPayment(reference, "chat")),
  );

  if (ops) {
    server.registerTool(
      "order_status",
      {
        title: "Order progress",
        description:
          "Where a paid order is now: accepted, cooking, ready, out for delivery (with the rider's name and number), delivered or picked up. Call when the customer asks about an order they've already paid for.",
        inputSchema: { reference: z.string().min(4).describe("Order reference, e.g. MTK-261025-AB12C") },
        annotations: { readOnlyHint: true },
      },
      async ({ reference }) => safely("order_status", log, () => ops.customerStatus(reference)),
    );
  }

  return server;
}
