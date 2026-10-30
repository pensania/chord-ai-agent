# Leadaut sync

Leadaut is the kitchen's revenue system. Every paying customer becomes a lead there, and every paid order becomes a transaction. Revenue, repeat customers and forecasts are reported in Leadaut, not in this app.

This app sends signed JSON events to one HTTPS endpoint on the Leadaut side. This page is the contract that endpoint has to meet.

## Turning it on

Set both settings on Render. Leave them empty to keep the sync off.

| Setting | What it is |
| --- | --- |
| `LEADAUT_WEBHOOK_URL` | The Leadaut endpoint that receives events. Must be `https://`. |
| `LEADAUT_WEBHOOK_SECRET` | A shared secret, 16 or more characters. It's used to sign each event, and Leadaut needs the same value to check the signatures. |

`/healthz` shows `"leadaut": {"pending", "sent", "failed"}` when the sync is on, and `"off"` when it isn't.

## What is sent and when

| Event | When | Key |
| --- | --- | --- |
| `customer.upserted` | Payment verified (by the agent's `verify_payment` or Paystack's webhook) | `lead.external_id` = WhatsApp number in E.164 |
| `order.paid` | Same moment, right after the customer | `transaction.reference` = order reference |
| `order.fulfilled` | Order marked *Delivered* or *Picked up* in the portal | `reference` |
| `order.cancelled` | Order cancelled in the portal after payment; a refund is due | `reference` |

Unpaid orders, amount mismatches and orders needing review are not sent. Only money that Paystack has confirmed is sent.

### Envelope

```json
{
  "event_type": "order.paid",
  "event_id": "MTK-261105-AAAAA:paid",
  "occurred_at": "2026-11-05T08:05:00Z",
  "data": { "transaction": { } }
}
```

### `customer.upserted`

```json
{ "lead": { "external_id": "+2348031234567", "phone": "+2348031234567", "name": "Ada Obi",
  "source": "whatsapp", "channel": "chord_agent", "business": "Mama Tola's Kitchen", "area": "Yaba" } }
```

Create the lead if no lead has this `external_id`. Otherwise update the name and area. A repeat customer sends this again with every order.

### `order.paid`

```json
{ "transaction": { "reference": "MTK-261105-AAAAA", "customer_external_id": "+2348031234567",
  "customer_name": "Ada Obi", "currency": "NGN", "amount_ngn": 53000, "subtotal_ngn": 50000,
  "delivery_fee_ngn": 3000, "fulfilment": "delivery", "delivery_zone": "Yaba", "needed_by": "2026-11-07",
  "payment_provider": "paystack", "paid_at": "2026-11-05T08:05:00Z", "created_at": "2026-11-05T08:00:00Z",
  "items": [{ "sku": "JOL-SMALL", "name": "Party jollof tray (small, serves 10)", "qty": 2,
              "unit_price_ngn": 25000, "total_ngn": 50000 }] } }
```

Amounts are whole naira.

### `order.fulfilled` and `order.cancelled`

```json
{ "reference": "MTK-261105-AAAAA", "customer_external_id": "+2348031234567", "how": "delivered", "amount_ngn": 53000 }
{ "reference": "MTK-261105-AAAAA", "customer_external_id": "+2348031234567", "amount_ngn": 53000, "refund_due": true, "stage_when_cancelled": "accepted" }
```

## What the endpoint must do

1. **Check the signature** before anything else. The headers are `X-Mtk-Timestamp` (milliseconds) and `X-Mtk-Signature: sha256=<hex>`. The signature is HMAC-SHA256 of `<timestamp>.<raw body>` with the shared secret, which is the same scheme as Chord's event subscriptions. Compare in constant time. Reject timestamps more than 5 minutes old.
2. **Ignore repeats.** `event_id` is stable (also sent as `X-Mtk-Event-Id`). The app retries until it gets a 2xx, so the same event can arrive twice. Store the event IDs you've already processed and return 200 for repeats.
3. **Answer quickly.** Return any 2xx within 8 seconds and do the slow work afterwards.
4. **Use status codes to steer retries.**
   - 2xx: done.
   - 5xx, 408 or 429: retried after 30 s, 1 min, 2 min and so on, capped at 1 hour, up to 8 tries.
   - Any other 4xx: the event is rejected and not retried. The app logs `revenue_event_dead`.

## Limits

The outbox is held in memory, like the rest of the app until the storage layer lands. A restart drops events that haven't been delivered yet. Delivered events are safe in Leadaut.
