# CircuitRun tests

These tests never touch your live site or your live Supabase. They use a fake Supabase in the browser and a throw-away Postgres.

## One-time setup (on your laptop)
1. Install Node.js 18 or newer.
2. In this `tests` folder run: `npm install` and then `npx playwright install chromium`.

## Run
- `npm test` runs everything.
- `npm run test:browser`: real Chromium on the real pages. Double click, slow or broken internet, retries, huge or hostile input, broken saved data, hostile web addresses.
- `npm run test:sql`: all your SQL files run in a Postgres engine inside Node (PGlite). Order rules, coupons, limits, admin log, photo rules, hostile values.
- `npm run test:concurrency`: many customers at the same moment. Needs a real PostgreSQL server and the `psql` command.
  Example: `PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres npm run test:concurrency`.
  It creates and WIPES a database named `cr_concurrency_test`. Never point it at your real Supabase project. Without a server it prints SKIPPED.

## Rules for new features
1. Write the test first and watch it fail.
2. Write the code until it passes.
3. Run `npm test` before every upload.

## What the tests do not cover
- The live site, the real Supabase project and real phones. Do a test order on the live site after every SQL or page upload.
- Real payments (the site has no payment gateway yet).
