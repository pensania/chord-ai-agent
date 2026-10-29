# Connect the Google Sheet (orders and stock that survive restarts)

Without this, the server keeps orders in memory. They vanish every time Render's free plan sleeps, and nothing shows up in the Sheet. About 10 minutes, all free.

The Sheet already exists: **Mama Tola's Kitchen orders (Chord agent)**, with `Menu`, `Zones` and `Orders` tabs. Its ID is the long part of the URL between `/d/` and `/edit`.

If the `Orders` tab was made before 29 Oct, type `needed_by` in cell **O1** (the day each order is for).

## 1. Create a service account (Google Cloud)
1. Open https://console.cloud.google.com and create a project (any name, e.g. `mama-tola`).
2. **APIs & Services → Library**: search "Google Sheets API" and click **Enable**.
3. **IAM & Admin → Service Accounts → Create service account**. Name it `chord-checkout`. Skip the optional role and user steps.
4. Open the new account → **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Keep it private: it's a password.
5. Copy the account's email. It looks like `chord-checkout@mama-tola.iam.gserviceaccount.com`.

## 2. Share the Sheet with it
Open the Sheet → **Share** → paste that email → **Editor** → untick "Notify people" → **Share**.

## 3. Set three variables on Render
Service → **Environment** → add:

| Key | Value |
| --- | --- |
| `STORE` | `sheets` |
| `GOOGLE_SHEET_ID` | the ID from the Sheet's URL |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | the whole contents of the downloaded `.json` file (paste it as is) |

Save. Render redeploys.

## 4. Check it
- `https://chord-checkout.onrender.com/healthz` should return `{"ok":true,"store":"sheets"}`.
- In Render's **Logs**, look for `sheet_ok`. If you see `sheet_unreachable`, its `hint` says what to fix. Usually the Sheet isn't shared with the service account's email, or the Sheets API isn't enabled.
- Run one order in the simulator. A new row should appear in `Orders` with status `pending`, then `paid` after payment, and the item's `stock` in `Menu` should drop.

If the JSON is malformed, the server logs a `config_warning` and keeps running on memory, so a typo can't take the agent offline.
