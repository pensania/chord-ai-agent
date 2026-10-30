# Going live: note for Tola

**What it does.** The assistant answers your WhatsApp orders day and night. It shows customers today's menu and prices, adds the right delivery fee, and sends a Paystack payment link. It only tells a customer their order is confirmed once Paystack says the money has arrived. Screenshots and "I've sent it" don't count. Paid orders then appear on your back office (`/admin`), where your staff accept, cook and dispatch them, and the person on duty is alerted at each step.

**What it doesn't do.** It doesn't give refunds, accept same-day orders, or change an order after payment. For those, and for complaints or allergy questions it can't answer, it tells the customer you'll reply yourself. It can't message a customer first, so "your food is on the way" is one tap from the order page, sent from your phone. It doesn't track the rider.

**Before real customers use it:**
1. **Live Paystack keys.** Swap the test key for your live key and set the webhook in your Paystack dashboard. The code refuses live keys today on purpose, so this is a deliberate change.
2. **A real WhatsApp number** connected to Chord, separate from your personal line.
3. **A paid database.** Orders, stock and staff are kept in a database. The free one we tested on is deleted after 30 days.
4. **Failed payments.** Customers get a new link automatically. You don't need to do anything.
5. **Payments that need you.** A wrong amount, or a tray that sold out after payment, is held for you instead of confirmed. Today these don't show on the back office or alert anyone. That must be fixed before launch, so you can call the customer within 2 hours.
6. **Who gets alerted.** Staff on duty see alerts while the back office is open on their phone. Turn on email so they also hear when it's closed.
7. **When something breaks.** If Paystack or the database is down, the assistant says so and doesn't confirm anything. Someone technical should get an alert when that happens more than twice in an hour.
