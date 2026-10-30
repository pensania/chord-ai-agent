# Leadaut sync

Leadaut is the kitchen's revenue system. Every paying customer becomes a lead there, and every paid order becomes a store order on that lead. Revenue, repeat customers, lifetime value and forecasts are reported in Leadaut, not in this app.

## How it works

Leadaut already accepts orders from online stores through its **Store** connection. Its WooCommerce webhook does everything we need:

- It checks the signature.
- It records each order once, keyed by the order number, so a resend only updates the order.
- It finds the customer by phone number, or creates them as a new lead.
- It updates the lead's order count, total spend and lifecycle stage. It fires its first-purchase, repeat-purchase and high-value events, so Leadaut workflows can react.
- It shows each delivery on the E-commerce page.

So this app sends each order to that webhook in WooCommerce's order format. **Leadaut needs no code changes.** The receiver is `backend/app/api/ecommerce.py` (`woocommerce_webhook`) and `backend/app/services/ecommerce/woocommerce.py` (`parse_order`) on Leadaut's `staging` branch. The test payloads in `test/revenue.test.ts` were checked against `parse_order` and `verify_signature` directly.

## Turning it on

In Leadaut:

1. Make sure the **Store** add-on is on for the account (Marketplace, or included on the plan).
2. Open **Insights → E-commerce** (`/insights/ecommerce`). Under **Connect your store**, enter `https://chord-checkout.onrender.com` as the store URL and press **Connect WooCommerce**.
3. Leadaut shows a webhook URL and a secret that starts with `lds_wc_`. The secret is shown once.
4. In the kitchen's admin portal, sign in as the owner and open **Integrations**. Paste the webhook URL and the secret, and press **Check and save**.

The portal checks them with Leadaut before saving. It sends a signed ping that Leadaut acknowledges without recording anything, so a wrong URL or secret shows up straight away and no test order lands in Leadaut. The page then shows how many orders were sent, how many are waiting and how many failed. It also has buttons to check the connection again, resend failed orders and disconnect.

Settings saved on the portal live in memory, like the rest of the portal until the storage layer lands. To keep them through a restart, also set them on Render:

| Setting | Value |
| --- | --- |
| `LEADAUT_WEBHOOK_URL` | The webhook URL from step 3, `https://…/api/webhooks/ecommerce/woocommerce/<id>`. The app adds `?topic=` itself. |
| `LEADAUT_WEBHOOK_SECRET` | The `lds_wc_…` secret from step 3. |

On start, the Render values connect Leadaut, and the portal shows "From the Render settings". Saving on the portal overrides them until the next restart. With neither set, nothing is sent. `/healthz` shows `"leadaut": {"pending", "sent", "failed"}` when the sync is on, and `"off"` when it isn't.

Paste the webhook URL as Leadaut shows it, with or without a `?topic=` on the end. The app sets the topic on each delivery itself, so one URL covers every event.

The E-commerce page in Leadaut lists four topics to verify. This app sends `order.created`, `order.updated` and `order.refunded`; each turns green after its first real order. `customer.updated` stays on "waiting", which is expected: customers are created and updated from their orders.

## What is sent and when

| Kitchen event | Topic | `status` sent | What Leadaut does |
| --- | --- | --- | --- |
| Payment verified (by the agent's `verify_payment` or Paystack's webhook) | `order.created` | `processing` | Records a paid order. Creates or updates the lead and counts the purchase. |
| Marked *Delivered* in the portal | `order.updated` | `delivered` | Order stays paid. No double count. |
| Marked *Picked up* in the portal | `order.updated` | `picked-up` | Same as delivered. |
| Cancelled in the portal (refund due) | `order.refunded` | `refunded`, with a full refund line | Marks the order refunded and takes it off the lead's total spend. |

Unpaid orders, amount mismatches and orders needing review are not sent. Only money that Paystack has confirmed is sent.

### Order body

```json
{
  "id": "MTK-261105-AAAAA", "number": "MTK-261105-AAAAA", "status": "processing",
  "currency": "NGN", "total": "53000.00", "shipping_total": "3000.00",
  "customer_id": 0, "created_via": "chord_agent", "payment_method": "paystack",
  "date_created_gmt": "2026-11-05T08:00:00", "date_paid_gmt": "2026-11-05T08:05:00", "date_completed_gmt": null,
  "billing": { "first_name": "Ada", "last_name": "Obi", "phone": "+2348031234567", "email": "", "city": "Yaba", "country": "NG" },
  "line_items": [{ "name": "Party jollof tray (small, serves 10)", "sku": "JOL-SMALL", "quantity": 2,
                   "price": 25000, "subtotal": "50000.00", "total": "50000.00" }],
  "refunds": [],
  "meta_data": [{ "key": "source", "value": "whatsapp" }, { "key": "channel", "value": "chord_agent" },
                { "key": "fulfilment", "value": "delivery" }, { "key": "delivery_zone", "value": "Yaba" },
                { "key": "needed_by", "value": "2026-11-07" }]
}
```

- The customer key is the WhatsApp number in E.164 (`billing.phone`). Customers have no email, so Leadaut matches on phone.
- The delivery address isn't sent. Leadaut only needs the area.

### Headers

| Header | Value |
| --- | --- |
| `X-WC-Webhook-Signature` | base64 HMAC-SHA256 of the raw body with the `lds_wc_` secret, as WooCommerce signs it |
| `X-WC-Webhook-Topic` | `order.created`, `order.updated` or `order.refunded` (also sent as `?topic=`, replacing any topic in the pasted URL) |
| `X-WC-Webhook-Delivery-ID` | `<reference>:<status>`, for tracing |

## Retries

Leadaut's store webhook answers 200 even when it refuses an event, with `{"ok": false, "error": "…"}` in the body. The app reads that body.

- `{"ok": true}`: done.
- `bad_signature`, `unknown_integration`, `invalid_json` or `account_missing`: the event is not retried, because retrying won't fix a wrong secret or URL. The app logs `revenue_event_dead`. Fix the setting, then call the outbox's `retryDead()` or resend.
- Any other refusal (a paused store, the Store feature switched off, a processing error), a 5xx, a 408, a 429 or a timeout is retried after 30 s, 1 min, 2 min and so on. The wait is capped at 1 hour, for up to 8 tries.

Updates for one order go out in order. If an order's earlier update is waiting to retry, its later updates wait too, so Leadaut never sees "refunded" before "paid".

## Limits

- The outbox is held in memory, like the rest of the app until the storage layer lands. A restart drops events that haven't been delivered yet. Delivered events are safe in Leadaut.
- Leadaut's receiver takes off the refund from a lead's total spend each time it receives a `refunded` order, even a repeat. The app sends each refund once. A repeat would only happen if Leadaut saved the order but its reply was lost, which is rare. The fix on Leadaut's side is tracked in [pensania/revenue-engine#470](https://github.com/pensania/revenue-engine/issues/470).
- In Leadaut the connection is labelled WooCommerce. A first-class "API" or "Chord" store type would be a small Leadaut change, and isn't needed for the data to be right.
