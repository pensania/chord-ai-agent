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
| Staff: names, numbers, roles, PINs, email for alerts | edit | view |
| Integrations: connect Leadaut, check it, resend failed orders ([details](leadaut-sync.md)) | yes | no |

Pick **Owner** and enter `ADMIN_PASSWORD`, or pick **Staff** and enter a phone number or staff ID plus a PIN. A failed sign-in logs `admin_login_failed` with the typed and expected lengths (never the text), so a mismatch with the value on Render is easy to spot. Sessions last 12 hours. The cookie is HttpOnly and SameSite=Strict, cross-site form posts are refused, and five wrong sign-ins from one IP pause logins for 15 minutes.

### Live board and order alerts

Every open portal page keeps a live connection (`/admin/live`, Server-Sent Events). The header shows **Live**. When an order is paid or moves, the queue, the Done list and the order page update in place, without a refresh. A board isn't swapped while someone is typing in a form.

The people the order needs next also get an alert: a toast, a short beep, a count on the bell, and a phone or desktop notification if they turned those on from the bell and the tab is in the background. The owner gets every alert. Nobody is told about their own move.

| What happened | Who is told |
| --- | --- |
| New paid order | intake on duty |
| Payment held for review | intake on duty (the owner settles it) |
| Accepted | the assigned cook (or the kitchen on duty if no cook was assigned) |
| Cooking | owner only |
| Ready, for delivery | dispatch on duty |
| Ready, for pickup | intake on duty |
| Back from the road | dispatch on duty |
| Out for delivery | the assigned rider |
| Delivered / picked up | intake on duty |
| Cancelled | the cook, the rider and intake on duty |

"On duty" means today's rota. The bell lists the last 20 alerts for the signed-in person; the server keeps the last 300 in memory, so the list starts empty after a restart.

Notifications only arrive while a portal tab is open (the phone can be locked with the browser in the background). There is no push service yet, so a closed browser hears nothing. Email covers that case.

**Email (optional).** Set `RESEND_API_KEY` and `ALERT_EMAIL_FROM` and each alert is also emailed to the people in it who have an email: staff get theirs from the Staff page, the owner from `OWNER_EMAIL`. The email links straight to the order (`PUBLIC_URL`, which Render fills in). A failed email is logged as `alert_email_failed` and never holds up the kitchen.

### Held payments

A payment that can't be confirmed safely is held instead: the customer paid the wrong amount, the last tray sold out while they were paying, or the bank reversed the payment. The agent tells the customer someone will reply, and the order stays out of the kitchen queue.

Held payments sit at the top of the queue under **Payments that need you**, with the reason in plain words and the customer's number, and intake on duty and the owner get an alert. Staff see the list; only the owner settles it:

- **Put in the queue** once a swap is agreed or the difference is settled. The order becomes paid, goes to intake as a new order and syncs to Leadaut.
- **Close it** after a refund, or when the payment was reversed. The order is never confirmed, and the agent won't confirm it later or send a new link for it.

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
| `ADMIN_PASSWORD` | to turn the portal on | Owner password, at least 10 characters. Unset = `/admin` returns 404. Avoid `$`: Render turns `$$` into `$`. |
| `STAFF_PINS` | optional | `kemi:1234,musa:4321`. Sets a PIN for staff who don't have one yet. A PIN set on the Staff page is kept. |
| `RESEND_API_KEY` | optional | Turns on alert emails, sent through [Resend](https://resend.com). Needs `ALERT_EMAIL_FROM` too. |
| `ALERT_EMAIL_FROM` | with the key | Sender, on a domain verified in Resend, e.g. `Mama Tola's Kitchen <orders@yourdomain.com>`. |
| `OWNER_EMAIL` | optional | Where the owner's alert emails go. |
| `PUBLIC_URL` | optional | The site's address for links in emails. Render sets `RENDER_EXTERNAL_URL`, which is used when this is empty. |
| `ADMIN_SESSION_SECRET` | optional | Signs session cookies. By default it's derived from the bearer token and the password. |

Staff and the default weekly rota come from `data/staff.json` (made-up people). The owner can change both on the portal.

## Stock, expenses and pay

Three more portal pages: **Stock** (everyone can see it), **Expenses** and **Staff pay** (owner only).

- **Ingredients and recipes.** `data/kitchen.json` seeds 15 ingredients and a recipe for each menu item: how much of each ingredient one tray or pack uses. When an order moves to *Cooking*, its ingredients come off stock once (moving it back and forth doesn't take them twice). Stock may go below zero rather than stop the kitchen; a negative number means the count is off.
- **Low stock.** Each ingredient has a "warn at" level. Anything at or below it shows on the Stock page and as a banner on the order queue.
- **Counts.** The owner and kitchen staff can enter a physical count; the difference is logged as an adjustment.
- **Recipe costs.** Each menu item shows its ingredient cost and margin at current prices, so a price rise at the market shows up straight away.
- **Expenses.** The owner logs spending by category (ingredients, gas, packaging, transport, rent, power and water, equipment, other). Listing ingredients on an expense restocks them and sets their price per unit to what was just paid.
- **Staff pay.** Each person can be paid per shift or monthly. Per-shift pay counts each day the person is on the rota, once per day whatever their role, so changing the rota changes the payroll. The figure is for the whole month as scheduled.
- **Revenue and reporting** are not built here. They go to Leadaut, which becomes the revenue system: customers as leads, paid orders as transactions.

## Where it's kept

With `STORE=postgres`, orders, staff, rota, order stages, stock, expenses, pay rates and portal settings are all kept in Postgres and survive restarts. See [storage.md](storage.md).

On `STORE=memory` (and for everything but orders on `STORE=sheets`), they live in memory and a Render free-plan sleep resets them. The default rota and `STAFF_PINS` cover the basics after a restart.
