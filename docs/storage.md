# Storage

| `STORE` | What's kept through a restart |
| --- | --- |
| `memory` (default) | Nothing. Menu, staff and the rota come back from `data/`. |
| `sheets` | Menu, prices, stock and orders, in the Google Sheet. Staff, rota, stages, stock counts, expenses, pay and portal settings reset. |
| `postgres` | Everything: orders, menu stock, staff and PINs, rota, order stages, ingredients, recipes, stock moves, expenses, pay rates, the Leadaut connection, and orders waiting to be sent to Leadaut. |

## Switching to Postgres

1. Create a Postgres database and copy its connection string, e.g. `postgres://user:pass@host:5432/db?sslmode=require`.
2. On Render, set `DATABASE_URL` to it and `STORE` to `postgres`, then save and deploy.
3. On the first start the app creates its tables and fills them from `data/seed.json`, `data/staff.json` and `data/kitchen.json`. Later starts never overwrite a table that already has rows, so the owner's edits are safe across deploys.

`/healthz` shows `"store": "postgres"` once it's on.

If the database can't be reached at start, the app retries for about a minute, then stops with `postgres_unavailable` in the logs. It doesn't fall back to memory, because taking orders that would vanish is worse than being down.

### Which database

- **Render Postgres, free:** [free databases expire 30 days after they're created](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90), so it suits a demo, not the kitchen. A paid Render database keeps going.
- **Neon or Supabase, free tier:** don't expire. Use the pooled connection string with `sslmode=require`.

## How it's stored

Each record (an order, a staff member, an ingredient) is one row with the whole record as JSONB, plus the few columns it's looked up by. Adding a field to an order doesn't need a migration. Tables are created with `CREATE TABLE IF NOT EXISTS` on every start, under a lock so two instances starting at once don't both seed.

Paying for the last tray locks the menu row, so two payments arriving together can't both take it.

The Leadaut secret saved on the portal is stored in the `settings` table as written. Treat database access like access to Render's settings.

## Tests

`test/postgres.test.ts` runs against a real Postgres when `TEST_DATABASE_URL` is set, in its own schema that's dropped afterwards. CI starts a Postgres 16 service for it. Without the variable, those tests are skipped.
