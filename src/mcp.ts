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

async function safely(fn: () => Promise<ToolResult>) {
  try {
    return asContent(await fn());
  } catch (e) {
    // Store or network failure we didn't anticipate. Tell the model plainly instead of throwing a protocol error.
    console.error("tool error", e);
    return asContent({ ok: false, error: "internal_error", next_step: "Something went wrong on our side. Apologise and say a staff member will reply shortly. Do not confirm anything." });
  }
}

export function buildMcpServer(checkout: Checkout, ops?: Operations) {
  const server = new McpServer({ name: "mama-tolas-checkout", version: "0.2.0" });

  server.registerTool(
    "check_stock",
    {
      title: "Check menu and stock",
      description:
        "Get the live menu with prices and stock. If items are given, also check they are in stock and compute the exact total including delivery. Always use this for prices; never calculate totals yourself.",
      inputSchema: { items: z.array(item).optional(), delivery_zone: z.string().optional().describe("One of the delivery zones, or 'Pickup'") },
      annotations: { readOnlyHint: true },
    },
    async ({ items, delivery_zone }) => safely(() => checkout.checkStock(items, delivery_zone)),
  );

  server.registerTool(
    "create_payment_link",
    {
      title: "Create Paystack payment link",
      description:
        "Create the order and a Paystack payment link for it. Only call after the customer has confirmed items, delivery zone and address. Safe to call twice: an identical unpaid order returns the same link.",
      inputSchema: {
        customer_name: z.string().min(1),
        customer_phone: z.string().min(7).describe("Customer's WhatsApp number"),
        customer_email: z.string().email().optional(),
        items: z.array(item).min(1),
        delivery_zone: z.string(),
        delivery_address: z.string().min(3).describe("Street address, or 'Pickup'"),
        needed_by: z.string().optional().describe("Calendar date the customer needs the order, YYYY-MM-DD (use `today` from check_stock to work it out)"),
      },
    },
    async (a) =>
      safely(() =>
        checkout.createPaymentLink({
          customerName: a.customer_name,
          customerPhone: a.customer_phone,
          customerEmail: a.customer_email,
          items: a.items,
          deliveryZone: a.delivery_zone,
          deliveryAddress: a.delivery_address,
          neededBy: a.needed_by,
        }),
      ),
  );

  server.registerTool(
    "verify_payment",
    {
      title: "Verify payment with Paystack",
      description:
        "Ask Paystack whether the order with this reference has been paid. The only way to confirm an order. Call when the customer says they've paid, or asks about their order.",
      inputSchema: { reference: z.string().min(4).describe("Order reference, e.g. MTK-261025-AB12C") },
      annotations: { idempotentHint: true },
    },
    async ({ reference }) => safely(() => checkout.verifyPayment(reference, "chat")),
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
      async ({ reference }) => safely(() => ops.customerStatus(reference)),
    );
  }

  return server;
}
