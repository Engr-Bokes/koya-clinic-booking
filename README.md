# CareSlot clinic booking assessment

Node.js/Express API, durable PostgreSQL storage, and a plain HTML/CSS/JavaScript patient demo for Koya Cohort 4. Implements all five levels of the provided booking API contract. This is an assessment demo; use fictional patient details only.

## Run with an existing PostgreSQL database

Use Node 22+ and PostgreSQL 14+. Database credentials and API keys belong in the environment, never source control.

```sh
npm ci
export DATABASE_URL='postgresql://…'
export API_KEY='your-long-random-key'
npm start
```

Open http://localhost:3000 for the patient-facing frontend. The preferred API base is http://localhost:3000/api, with public usage documentation at http://localhost:3000/docs and discovery metadata at http://localhost:3000/api. Enter the configured API key in the demo to load slots. Tables initialize automatically. Static pages, API discovery, and documentation are public; every clinical API request requires `X-API-Key`. Missing or wrong keys return 401. No real patient authentication or authorization is provided by this assessment protocol.

## Contract

See `docs/openapi.json` for the original supplied contract. The published specification at `/docs/openapi.json` adds `/api` as its server base. Preferred API routes:

- `POST /api/reset` atomically replaces slots and clears bookings and request bookkeeping.
- `GET /api/slots` lists chronological slots with availability; `provider` is an exact filter.
- `POST /api/bookings` validates, normalizes, and books one future slot.
- `GET /api/bookings/:id` retrieves a booking.
- `DELETE /api/bookings/:id` cancels one confirmed booking and releases its slot.
- `GET /api/bookings?email=…&limit=10&cursor=…` lists bookings with cursor pagination.

The original unprefixed routes remain supported for existing clients, using the exact same handlers and stored data. New clients and the assessment API-base field should use `/api`. The patient page uses `/api` for every request.

The supplied contract intentionally includes an authenticated destructive reset endpoint for the evaluator. Treat its key as a credential and use an isolated assessment database.

## Correctness choices

PostgreSQL transactions, slot row locks, and a partial unique index enforce one confirmed booking per slot. Idempotency keys are stored durably with request signatures, response bodies, status codes and headers. Cursor ordering uses `(created_at,id)` with millisecond precision. A shared/exclusive database advisory-lock barrier serializes reset against other operations, even across multiple app instances.

Idempotency replay and different-body rejection precede rate limiting. JSON object-key order does not change a request's identity, but identity is checked before name/email normalization. A reused key with changed request data returns 422. Cached failed responses also replay, including a cached 429; use a new key for a genuinely new attempt after a throttle delay.

Fresh attempts with a string email are counted in a durable rolling 60-second window, including validation failures and 429s. Retries of the same idempotent request do not consume a new attempt. Throttled requests can extend the rolling window. A missing or non-string email has no email-specific bucket and is rejected by validation.

## Tests

Tests with an explicitly configured database reset the assessment tables. Use a disposable dedicated test database, never production.

```sh
TEST_DATABASE_URL='postgresql://…' npm test
```

The API-prefix integration test uses its own schema to avoid interfering with the other tests. If `TEST_DATABASE_URL` points to a transaction pooler such as Neon’s `-pooler` hostname, also set `TEST_DIRECT_DATABASE_URL` to the direct connection for isolated-schema tests. The production app continues to use its pooled URL.

To start and clean up a temporary embedded PostgreSQL cluster:

```sh
npm run test:local
```

Without a test database, `npm test` runs unit/HTTP pre-database checks and skips the database integration group. `test:local` executes everything against real PostgreSQL.

Verified locally on 14 November 2026: **16 tests passed, 0 failed, 0 skipped** against PostgreSQL 18.6. Tests include `/api` discovery without key exposure, authentication, complete prefixed booking flows, and data compatibility with legacy routes. Required-field buttons stay disabled until their inputs are ready, including a selected future slot, a nonblank name and valid email for booking. Clearing inputs disables the relevant button again. Whitespace-only input does not count; the optional provider filter can still be blank. DOM-harness tests cover these readiness rules and restored-key behavior. Browser verification also covered listing slots, creating a fictional booking, showing confirmation, cancelling, and restoring availability. This does not replace post-deployment checks.

On macOS, the downloaded local test binary may be quarantined. If initdb is killed before startup, inspect that specific downloaded package and allow only its `node_modules/@embedded-postgres/darwin-arm64/native` directory to run. No test binaries are needed in production.

## Local interactive demo

```sh
DEMO_RUNTIME_DIR=/absolute/path/to/temporary/runtime node scripts/demo-local.mjs
```

Uses a temporary database on port 55439 and a server on http://localhost:3040, seeded with fictional appointments. Runtime credentials are stored only in that external temporary directory. This is not a public deployment and is not suitable for the evaluator's submitted URL.

## Deploy

`vercel.json` routes `/` to the frontend, `/docs` to the documentation page, `/docs/openapi.json` to the published contract, and API requests to the serverless handler. `src/http.js` provides the `/api` prefix, public discovery response, and legacy compatibility. Set `DATABASE_URL` to a durable hosted PostgreSQL database (for example a Neon free project), and set `API_KEY` to a long random credential. Use HTTPS and keep the project running unchanged after submitting, as required by the assessment. Never deploy the temporary embedded test database as production storage.

Before submitting, retest authentication, persistence, reset, concurrency, idempotency, cancellation, pagination, and rate-limit headers against the public URL. Do not submit localhost URLs. The public frontend URL is `https://careslot-chibuokem.vercel.app`, and the public API base is `https://careslot-chibuokem.vercel.app/api`. Usage documentation is at `https://careslot-chibuokem.vercel.app/docs`. The candidate must record a genuine short walkthrough demonstrating their understanding and the live page.

## AI assistance

This implementation was developed with AI assistance, which the assessment explicitly permits. The candidate should review and understand the code, explain the key choices and limitations in their own words, and disclose assistance accurately where asked.

See `docs/architecture.md` for walkthrough preparation and scope limitations.
