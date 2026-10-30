# TSG Labs build exercise: submission

_Draft: replace anything in [brackets] and edit the wording into your own voice before sending._

## Role and problem statement

**Role:** Forward-deployed Engineering (also open to Technical Product Management).

Mama Tola's Kitchen is a (made-up) Lagos home kitchen that sells party trays on WhatsApp, like thousands of real food vendors. Today the owner takes each order by chat, waits for a transfer screenshot, and checks bank alerts by hand. That costs her evenings and exposes her to fake payment receipts. This Chord teammate takes the order, quotes the exact total from a live menu, sends a Paystack link, and confirms the order only after Paystack verifies the payment. I deliberately left out refunds, same-day orders and rider tracking; refunds and complaints are handed to the owner.

## Links

| What | Where |
| --- | --- |
| Live agent | Chord teammate "Chord Assistant" (business name "Mama Tola's Kitchen") on olumideokewale@gmail.com's workspace, reachable in the WhatsApp simulator |
| Tool server | https://chord-checkout.onrender.com (MCP at `/mcp`, Paystack webhook at `/webhooks/paystack`) |
| Code | this repo; start with [README.md](README.md) |
| Recording | [3-minute video link] |
| Field notes | [docs/field-notes.md](docs/field-notes.md) |
| Go-live note | [docs/go-live-note.md](docs/go-live-note.md) |
| What's left | [docs/whats-next.md](docs/whats-next.md) |

## After the core build

The brief is the WhatsApp checkout above. Once it worked, I carried on into what the kitchen needs after payment, because that's where a vendor feels the next pain: a back office at `/admin` where staff accept, cook and dispatch orders with live alerts for whoever is on duty, stock and expenses, and every order synced to Leadaut, the revenue system I built, through its existing store webhook. None of it is needed to judge the exercise, and [docs/whats-next.md](docs/whats-next.md) says what's still open.

## Checklist before sending

- [x] Custom tool calls a real system (Paystack test mode), and the action happens
- [x] Failures handled: sold out, failed or abandoned payment, amount mismatch, oversold after payment, Paystack down, duplicate "I've paid"
- [x] Skill file with business context: `skills/mama-tolas-kitchen/`
- [x] Teammate created on Chord, MCP server registered, skill published
- [x] Full simulator conversation where the agent creates a link and confirms a verified payment (29 Oct, order MTK-261029-SXMZQ)
- [ ] Re-run test conversation 1 on today's deploy, so the recording matches the code
- [ ] 3-minute recording of that conversation, showing the tool firing (the order landing on `/admin` live is a good moment)
- [x] Field notes: three main entries, each with error, diagnosis, fix and a Chord suggestion
- [x] Go-live note updated for the back office and alerts
- [ ] README "How AI tools were used" rewritten in your words
- [ ] Teammate left live; Render kept awake (uptime ping) during the review window
- [x] Billing failure (field note 3) reported in the submission itself
