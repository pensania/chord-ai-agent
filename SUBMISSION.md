# TSG Labs build exercise: submission

_Draft: replace anything in [brackets] and edit the wording into your own voice before sending._

## Role and problem statement

**Role:** Forward-deployed Engineering (also open to Technical Product Management).

Mama Tola's Kitchen is a (made-up) Lagos home kitchen that sells party trays on WhatsApp, like thousands of real food vendors. Today the owner takes each order by chat, waits for a transfer screenshot, and checks bank alerts by hand. That costs her evenings and exposes her to fake payment receipts. This Chord teammate takes the order, quotes the exact total from a live menu, sends a Paystack link, and confirms the order only after Paystack verifies the payment. I deliberately left out delivery tracking, refunds and a staff dashboard; refunds and complaints are handed to the owner.

## Links

| What | Where |
| --- | --- |
| Live agent | Chord teammate "[name]" on [olumideokewale@gmail.com]'s workspace, reachable in the WhatsApp simulator |
| Tool server | https://chord-checkout.onrender.com (MCP at `/mcp`, Paystack webhook at `/webhooks/paystack`) |
| Code | this repo; start with [README.md](README.md) |
| Recording | [3-minute video link] |
| Field notes | [docs/field-notes.md](docs/field-notes.md) |
| Go-live note | [docs/go-live-note.md](docs/go-live-note.md) |

## Checklist before sending

- [x] Custom tool calls a real system (Paystack test mode), and the action happens: smoke test passes on the live server
- [x] Failures handled: sold out, failed or abandoned payment, amount mismatch, oversold after payment, Paystack down, duplicate "I've paid"
- [x] Skill file with business context: `skills/mama-tolas-kitchen/`
- [ ] Teammate created on Chord, MCP server registered and healthy, skill published
- [ ] Full simulator conversation where the agent creates a link and confirms a verified payment
- [ ] 3-minute recording of that conversation, showing the tool firing (Render logs or the Sheet updating)
- [ ] Field notes: 2 or 3 strongest entries, each with error, diagnosis, fix and a Chord suggestion
- [ ] Go-live note reviewed for a non-technical owner
- [ ] README "How AI tools were used" rewritten in your words
- [ ] Teammate left live; Render kept awake (uptime ping) during the review window
