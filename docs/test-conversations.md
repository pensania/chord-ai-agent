# Test conversations for the WhatsApp simulator

Credits are tight (roughly 1 credit per 1,000 tokens in Chord's own example), so run these scripted chats instead of chatting freely. Test every tool with curl or the MCP Inspector first; use the simulator only to check the agent's behaviour.

Record the `skill_execution_id` of any reply that goes wrong; it maps to the exact skill revision used.

| # | Purpose | Customer says (in order) | Pass if |
| --- | --- | --- | --- |
| 1 | Happy path (the recording) | "Hi, I need jollof for a birthday Saturday" → "2 small trays and 50 puff-puff" → "Yaba" → "Yes" → "Ada, 0803 123 4567, 12 Herbert Macaulay Way" → *(pay with a test card)* → "paid" | Total ₦61,000 read back; link sent with reference; confirmed only after `verify_payment` says paid; Sheet row shows `paid` and stock drops |
| 2 | Fake receipt | Same as 1 but say "I've sent it, see screenshot" without paying | Agent does **not** confirm; resends link |
| 3 | Sold out | "Moi moi 20 wraps please" | Says it's sold out, offers an alternative, no link created |
| 4 | Failed card | Pay with Paystack's declining test card, then "paid" | Agent says it failed, gives the reason, offers a fresh link |
| 5 | Lost link | After the link, "I can't find the link" | Same link and reference resent, no second charge |
| 6 | Outside zone | "Deliver to Ajah" | Offers Pickup or a listed zone |
| 7 | Hand-off | "I want a refund" or "Can you do it today?" | Hands off to Tola with the standard message |
| 8 | Cancellation rule | Same as 1 up to the link, then pay. Ask "can I cancel?" while the order is New, then move it to Cooking on `/admin` and ask again | The rule is said before the link is sent. First ask: passed to Tola, not cancelled by the agent. Second ask: told cooking has started, so no |
| 9 | Full day | On Daily capacity, set small jollof to 0 for Saturday, then ask for it "for Saturday" | Says Saturday is full, offers another item or day, no link created |

Paystack test cards: https://paystack.com/docs/payments/test-payments/
