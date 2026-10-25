# Going live: note for Tola

**What it does.** The assistant answers your WhatsApp orders day and night. It shows customers today's menu and prices from your Google Sheet, adds the right delivery fee, and sends a Paystack payment link. It only tells a customer their order is confirmed once Paystack says the money has arrived. Screenshots and "I've sent it" don't count. Every order appears as a row in the Orders tab, and stock goes down when an order is paid.

**What it doesn't do.** It doesn't give refunds, accept same-day orders, or change an order after payment. For those, and for complaints or allergy questions it can't answer, it tells the customer you'll reply yourself. It doesn't track the rider.

**Before real customers use it:**
1. **Live Paystack keys.** Swap the test key for your live key, and set the webhook in your Paystack dashboard. The code refuses live keys today on purpose, so this is a deliberate change.
2. **A real WhatsApp number** connected to Chord, separate from your personal line.
3. **Keep the Sheet accurate.** If you sell trays outside WhatsApp, update the stock column or the assistant may sell something you don't have. If that happens after payment, it flags the order for you instead of confirming.
4. **Failed payments.** Customers get a new link automatically. You don't need to do anything.
5. **Who gets alerted.** Orders marked `needs_review` (wrong amount, sold out after payment, reversed payment) need you within 2 hours. We should send these to your phone by SMS or email before launch. Today they only show in the Sheet.
6. **When something breaks.** If Paystack or the Sheet is down, the assistant says so and doesn't confirm anything. Someone technical should get an alert when that happens more than twice in an hour.
7. **Two orders at the same moment** for the last tray could both be paid before stock updates. It's rare for a shop your size, and it's flagged for you rather than hidden.
