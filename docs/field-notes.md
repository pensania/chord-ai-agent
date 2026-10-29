# Deployment field notes

Write these as problems happen, with the exact error and time. Keep the best 2 or 3 for the submission.

Template:

### N. Short title
- **What happened:** (include the error message)
- **How I found the cause:**
- **Fix or workaround:**
- **What Chord should change:** (docs, API or product, specific enough to ship next week)

---

### 1. Event subscriptions can't reach the customer, and the docs only say so indirectly
- **What happened:** The plan was to have a Paystack webhook trigger a Chord run that messages the customer "payment received". The event-subscriptions guide says no conversation thread is created for an event run and the result goes back to your webhook, and that runs have "customer-channel restrictions", which aren't defined anywhere.
- **How I found the cause:** Read the event-subscriptions, threads and external-chat guides side by side. The only documented way to message a customer first is external chat: create a thread, take it over as a human, then post. There's no WhatsApp equivalent in the docs.
- **Fix or workaround:** The server confirms payment itself (webhook → re-verify with Paystack → update the Sheet). The agent tells the customer on their next message. The Chord event is optional and only carries a summary for the owner.
- **What Chord should change:** Define "customer-channel restrictions" in one place, and add a `reply_to: { thread_id | channel + sender_id }` option to event subscriptions so a verified payment can notify the customer in the same WhatsApp chat.

### 2. (to fill in during deployment)
