# Kitchen operations and the admin portal

Phase 1 of the [growth roadmap](https://claude.ai/artifact/95KJcr3FdSrCJkF8wPe4yE). Once a payment is verified, the order goes into a queue that staff move through on a simple web portal. The agent can tell customers where their order is.

## Stages

```
new ──accept──► accepted ──► cooking ──► ready ──► out_for_delivery ──► delivered
                                           └──────► picked_up   (pickup orders)
any open stage ──► cancelled   (owner only; refunds stay manual)
out_for_delivery ──► ready      (rider came back; dispatch or owner)
```

| Move | Who can do it |
| --- | --- |
| new → accepted | intake |
| accepted → cooking → ready | kitchen |
| ready → out_for_delivery | dispatch (pick a rider or let the server pick) |
| out_for_delivery → delivered | the assigned rider, or dispatch |
| ready → picked_up | intake or dispatch |
| anything → cancelled | owner |

The owner can make any move. Only orders that `verify_payment` marked `paid` enter the queue.

**Auto-assignment.** On accept, the order goes to the cook on today's kitchen rota with the fewest open orders. On dispatch, the same applies to riders. Dispatch can override the rider.

**Due dates.** The agent now asks what day the order is for and passes `needed_by`. The queue is sorted by it, and overdue orders are shown in red.

## Admin portal (`/admin`)

| Page | Owner | Staff |
| --- | --- | --- |
| Queue: a board by stage, today's on-duty strip, move buttons | all moves | moves for their roles |
| Order: lines, total, history, rider, **Send this update on WhatsApp** | yes | yes |
| Done: delivered, picked-up and cancelled orders | yes | yes |
| Rota: week grid, role × day | edit | view |
| Staff: names, numbers, roles, PINs | edit | view |

Sign in with `owner` plus `ADMIN_PASSWORD`, or with a staff phone number plus a PIN. Sessions last 12 hours. The cookie is HttpOnly and SameSite=Strict, cross-site form posts are refused, and five wrong sign-ins from one IP pause logins for 15 minutes.

### Customer updates

Chord can't message a customer first today. Event runs can't reach the customer channel (field note 1). So there are two paths:

1. **Pull:** the agent calls `order_status` when the customer asks, and answers from the real stage.
2. **Push, by hand:** each order page has a **Send this update on WhatsApp** button. It opens WhatsApp with the customer's number and a ready-written message for the current stage. One tap from the business phone sends it.

Each stage change is also logged and, if `CHORD_EVENT_WEBHOOK_URL` is set, sent to Chord as a signed `order.stage_changed` event. When Chord supports proactive WhatsApp messages, the button can become automatic without changing the queue.

### Why staff don't use the agent for this (yet)

The roadmap had staff replying "accept MTK-…" on WhatsApp. That would mean the agent trusts a phone number the model passes in, and any customer could claim to be staff. Until Chord passes the verified sender to tools, staff actions stay on the portal, behind a PIN. This also keeps staff chatter from spending Chord credits.

## Settings

| Variable | Needed | What it does |
| --- | --- | --- |
| `ADMIN_PASSWORD` | to turn the portal on | Owner password, at least 10 characters. Unset = `/admin` returns 404. |
| `STAFF_PINS` | optional | `kemi:1234,musa:4321`. PINs set on the Staff page are lost when the memory store restarts. These aren't. |
| `ADMIN_SESSION_SECRET` | optional | Signs session cookies. By default it's derived from the bearer token and the password. |

Staff and the default weekly rota come from `data/staff.json` (made-up people). The owner can change both on the portal.

## Limits until the storage layer lands

Staff edits, rota changes and order stages live in memory, like orders on `STORE=memory`. A Render free-plan sleep resets them. The default rota and `STAFF_PINS` cover the basics after a restart. The Sheets (or Postgres) layer for operations is the last step of this phase.
