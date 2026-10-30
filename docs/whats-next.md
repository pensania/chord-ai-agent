# What's left, and what I'd build next

The brief asked for one useful job done end to end. That job, WhatsApp checkout with verified payment, is finished and tested in the simulator. The back office, stock and the Leadaut sync went past the brief; they're built and tested but haven't been run with real staff. This page lists what's still open, in the order I'd do it.

## Before real customers (blocks go-live)

| Item | Why it matters | Size |
| --- | --- | --- |
| Show held payments (`needs_review`) on the back office and alert the owner | A wrong amount or an oversold tray is held, not confirmed, but today nobody is told. The owner only finds it by asking. | Small: a "Needs you" lane on the queue and a call to the existing alert hub |
| Live Paystack keys, behind a deliberate switch | The code refuses live keys so a test can't charge anyone. | Small |
| A real WhatsApp number on Chord | The simulator is the only channel today. | Owner setup |
| A paid, backed-up database (Neon, Supabase or Render paid) | Render's free Postgres is deleted after 30 days. | Setup |
| Outage alerting | If Paystack or the database fails more than twice in an hour, someone technical should hear. A log-based alert (Render or Better Stack) is enough. | Small |

## Blocked on Chord

| Item | What's in the way | What I tried |
| --- | --- | --- |
| Tell the customer "payment received" and "on the way" automatically | Event-subscription runs can't post to the customer's WhatsApp chat (field note 1). | The server confirms payment itself, the agent tells the customer on their next message, and each order page has a one-tap WhatsApp button. |
| Staff act from WhatsApp ("accept MTK-…") | Chord doesn't pass the verified sender's number to tools, so a customer could claim to be staff. | Staff actions stay on the PIN-protected back office. |
| See which tools the agent called | The simulator hides tool calls (field note 2). | Read server logs by order reference. |

## With more time

- **Push notifications** that reach a closed browser (web push with a service worker), so staff don't need the back office open.
- **Refunds from the back office** through Paystack's refund API, sent to Leadaut as a refund. Today a cancellation tells the owner a refund is due.
- **Same-day orders** with a cut-off time and kitchen capacity per day.
- **Reports**: sales by day, best sellers and margin per tray from recipes and ingredient costs. Leadaut already gets every order, so this may live there.
- **Leadaut repeated-refund fix**: filed as pensania/revenue-engine#470, waiting on the Leadaut team.

## Known limits today

- The alert list on the bell is kept in memory and starts empty after a restart.
- Render's free plan sleeps after 15 minutes. The first message after that waits about a minute for the server to wake. Keep it awake with an uptime ping during the review.
