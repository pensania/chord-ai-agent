# Mama Tola's Kitchen: WhatsApp checkout on Chord

A Chord teammate that takes party-tray orders on WhatsApp, sends a Paystack payment link, and **confirms the order only after Paystack verifies the payment**. That removes the "send me your receipt" loop where small food vendors lose evenings checking bank alerts and get caught by fake transfer screenshots.

Built for the TSG Labs build exercise. Mama Tola's Kitchen is a made-up business; all keys are Paystack **test** keys and all data is fake.

## What's here

| Path | What it is |
| --- | --- |
| `skills/mama-tolas-kitchen/` | The skill: business context, conversation flow, hard rules, hand-off rules. `reference/policies.md` is read on demand. |
| `src/` | MCP tool server (streamable HTTP) that Chord calls. |
| `src/checkout.ts` | Order logic: pricing, idempotent links, payment verification, stock. |
| `src/paystack.ts` | Paystack client: timeouts, retry with backoff on 5xx, refuses live keys. |
| `src/store/` | `memory` store (seeded from `data/seed.json`) and `sheets` store (Google Sheet the owner can edit). |
| `src/server.ts` | `/mcp` (bearer auth), `/webhooks/paystack` (signature checked), `/healthz`, `/admin`. |
| `src/ops/` | Kitchen operations after payment: order stages, staff, rota, auto-assignment. |
| `src/revenue/` | Leadaut sync: customers as leads and paid orders as transactions, sent as signed events with retries. See [docs/leadaut-sync.md](docs/leadaut-sync.md). |
| `src/stock/` | Ingredients, recipes, stock deduction when cooking starts, expenses and staff pay. |
| `src/admin/` | Admin portal for the owner and staff: queue board, order pages, stock, expenses, pay, rota, staff. See [docs/operations.md](docs/operations.md). |
| `docs/` | Field notes, go-live note, test conversations, VPS deploy guide. |
| `deploy/vps/` | Docker Compose + Caddy (auto HTTPS), setup and deploy scripts. |

## Tools the teammate gets

| Tool | Does | Notes |
| --- | --- | --- |
| `check_stock` | Live menu, stock, and an exact quote for a basket + delivery zone | The model never does arithmetic; totals come from here. |
| `create_payment_link` | Creates the order row and a Paystack link (amount in kobo, unique reference) | Same customer + same unpaid basket within 30 min returns the same link, so a confused retry can't double-charge. |
| `verify_payment` | Asks Paystack for the truth and updates the order | The only path to "confirmed". Handles not-paid-yet, failed (with reason), reversed, amount mismatch, paid-but-sold-out, and Paystack being down. |
| `order_status` | Where a paid order is: accepted, cooking, ready, out for delivery (with rider), delivered | Read-only. Unpaid orders are sent back to `verify_payment`. |

Each result includes `ok` and a plain-English `next_step`, so the model knows what to tell the customer on every branch.

## How a payment is confirmed

```
customer says "paid" ──► verify_payment ──► Paystack /transaction/verify ──► paid? ─► confirm
Paystack charge.success webhook ──► signature check ──► same verify_payment ──► (optional) signed event to Chord
```

The webhook and the chat both go through one locked `verify_payment`, so stock is counted once even if both arrive together. The webhook body is never trusted for money; it only triggers a re-verify.

## Run it locally

```bash
cp .env.example .env        # set MCP_BEARER_TOKEN and a Paystack sk_test_ key
npm install
npm test                    # 25 tests, no network needed
npm run dev                 # http://localhost:8080
```

Try a tool without Chord (saves credits):

```bash
curl -s localhost:8080/mcp -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"check_stock","arguments":{}}}'
```

Test a deployed server end to end, including a real Paystack test payment, with `BASE=https://<host> TOKEN=<MCP_BEARER_TOKEN> scripts/smoke.sh`.

Or point the MCP Inspector (`npx @modelcontextprotocol/inspector`) at `http://localhost:8080/mcp` with the bearer header.

### Google Sheet store (optional)

1. Create a sheet with tabs `Menu`, `Zones`, `Orders`. Share it with your service account's `client_email` as Editor.
2. `GOOGLE_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON=... npm run seed:sheet`
3. Set `STORE=sheets`. The owner can now change prices and stock in the sheet, and watch orders arrive.

## Deploy

Chord needs a public HTTPS URL (private and loopback addresses are blocked).

- **Your own VPS (recommended here):** Docker Compose plus Caddy for automatic HTTPS. See [docs/deploy-vps.md](docs/deploy-vps.md). In short: `sudo deploy/vps/setup.sh`, fill in `deploy/vps/.env`, then `deploy/vps/deploy.sh`.
- **Render:** `render.yaml` is a Blueprint (New → Blueprint → this repo). See [docs/deploy-render.md](docs/deploy-render.md).
- **Any container host:** `docker build -t chord-checkout .` and run it with the env vars from `.env.example`.

Then in Paystack (test mode) → Settings → API Keys & Webhooks, set the webhook URL to `https://<host>/webhooks/paystack`.

## Connect it to Chord

1. **Register the MCP server** in the workspace: `url` = `https://<host>/mcp`, `transport` = `streamable_http`, `auth_type` = `bearer`, `auth_token` = your `MCP_BEARER_TOKEN`, `enabled_tools` = `["check_stock","create_payment_link","verify_payment"]`. Put the token in `auth_token`, not in custom `headers` (headers are readable by anyone with `mcp:read`).
2. **Check health** and read the `status` field; the health endpoint returns 200 even when the probe fails.
3. **Assign it** to the teammate with an explicit `mcp_server_ids` list. An empty list means every enabled server in the workspace.
4. **Upload the skill**: `skills/mama-tolas-kitchen/` (entrypoint `SKILL.md`, reference `reference/policies.md`), then publish the draft (a saved draft is not live).
5. **Test in the WhatsApp simulator** with `docs/test-conversations.md`. Pay with a [Paystack test card](https://paystack.com/docs/payments/test-payments/).
6. *(Optional)* Create an event subscription for the teammate and set `CHORD_EVENT_WEBHOOK_URL` and `CHORD_EVENT_SIGNING_SECRET`. Verified payments are forwarded as `order.paid` / `order.needs_review` events, signed `sha256=` HMAC over `timestamp.body`.

Exact routes and field names are from the [Chord API docs](https://api.chordhq.xyz/docs); check them against the API reference before relying on them.

## Deliberately left out

Refunds (handed to the owner), multiple currencies, live rider tracking, and automatic customer messages (Chord can't message a customer first yet; see [docs/operations.md](docs/operations.md)).

## How AI tools were used

_Draft, edit before submitting._ Claude (Claude Code) helped read the brief and the Chord docs, draft the plan, and write the first version of the tool server, tests and skill. Deployment, simulator testing and the field notes are my own; problems found along the way are in `docs/field-notes.md`.
