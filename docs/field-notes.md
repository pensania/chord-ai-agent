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

### 2. Render deploy crash-looped on an optional setting
- **What happened:** On Render (29 Oct), the service failed at startup with `Missing or invalid config: GOOGLE_SERVICE_ACCOUNT_JSON`. The Google Sheet store was selected, but the service-account key wasn't set up yet.
- **How I found the cause:** The startup log named the variable. Config treated the Sheet's settings as required whenever `STORE=sheets`, so one optional integration blocked the whole server.
- **Fix or workaround:** Optional integrations now degrade instead of blocking. A missing or malformed Sheet config falls back to the memory store with a `config_warning` log line. A Chord event URL without its signing secret disables forwarding. Only the bearer token and the Paystack test key stop startup.
- **What Chord should change:** This one was mine. Still, Chord's MCP health check returning HTTP 200 even when it fails would have hidden a crash-looping server behind a green status. Return a non-2xx code, or show `status` prominently in the dashboard.

### 3. (to fill in)
