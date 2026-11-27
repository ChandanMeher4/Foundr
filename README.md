# Foundr — Fractional Real Estate Investment Platform

Fractional commercial & residential real estate marketplace built with Next.js 16, MongoDB Atlas, Redis, BullMQ, Razorpay Test Mode, and Groq AI risk analysis.

[![CI](https://github.com/ChandanMeher4/Foundr/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ChandanMeher4/Foundr/actions/workflows/ci.yml)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Vercel-black)](https://foundr-gamma.vercel.app/)

> **Disclaimer:** **Demo project: no real money moves and this is not investment advice.** All listings, valuations, test payments, and commitments exist strictly for technical demonstration.

---

## Screenshots

<!-- TODO(owner): add screenshots to docs/screenshots/ and link them here -->

Screenshots are being prepared under [docs/screenshots/](docs/screenshots/README.md). *(Add captured UI & Bull Board screenshots there before embedding them in this section.)*

---

## Features by Role

| Role | Capabilities |
| :--- | :--- |
| **Investor** | Browse live & funded properties in List or interactive India Leaflet Map view; switch between `Newest` and `Trending` views (top-3 badged); search by address/title & filter by category; view real-time SSE funding progress bars; run cached AI Pros/Risks reports; star/bookmark opportunities; commit fractional INR amounts idempotently (direct ledger when `PAYMENTS_ENABLED=false`, or **Razorpay Test Mode** Checkout when enabled) and inspect payment history on `/profile` |
| **Developer** | Submit new early-stage properties via `/list-project` with Geoapify India address autocomplete and Cloudinary image uploads; monitor portfolio capital raised and investor commitment ledgers on `/developer` |
| **Admin** | Approve/verify (`Live`, sets `approvedAt`) or reject/delete `Pending Review` listings on `/admin`; inspect weekly `PlatformStats` snapshots; revoke all active sessions for a user; replay or discard Mongo-backed `DeadLetter` payment jobs; access the isolated cross-domain Bull Board queue dashboard |

---

## Architecture

Foundr splits request-driven Next.js serverless routes on **Vercel** from long-running background processing and persistent SSE streams in a standalone Node service (`/worker`) on **Render**, backed by shared **MongoDB Atlas** and **TCP Redis (`noeviction`)**.

```mermaid
flowchart TD
    Browser["Browser (React 19 UI + EventSource)"] -->|HTTPS + foundr_token cookie| Next["Vercel Next.js 16 App + API Routes"]
    Browser -->|Direct unsigned image upload| Cloudinary["Cloudinary CDN"]
    Browser -->|India address autocomplete| Geoapify["Geoapify API"]
    Browser -.->|Cross-origin SSE GET /projects/:id/stream| WorkerSSE["Render Worker SSE Endpoint"]

    Next -->|Mongoose atomic $expr + Outbox/DLQ| Mongo[("MongoDB Atlas")]
    Next -->|Idempotency, caches, trending ZSETs, rate limits, BullMQ| Redis[("Redis Cloud TCP (noeviction)")]
    Next -->|Test orders & signature verify| Razorpay["Razorpay Test API (rzp_test_*)"]
    Next -->|AI analysis (cached 24h + global limiter)| Groq["Groq LPU (openai/gpt-oss-120b)"]
    Next -->|OTP sandbox email| Resend["Resend API"]
    Next -->|60s Admin handoff JWT -> /admin/queues/login| WorkerBoard["Render Bull Board (bullboard_session cookie)"]

    Redis -->|Queues: investment-events, lifecycle, scheduled, payments| WorkerBull["Render BullMQ Workers"]
    Redis -->|psubscribe funding:*| WorkerSSE
    WorkerBull -->|AuditLog upsert, finalization, reaper & DLQ| Mongo
    WorkerBull -->|Order status checks & test refunds| Razorpay
    WorkerBull -->|Invalidate marketplace cache on expiry/capture| Redis
    WorkerBull -->|Receipts, digests, refunds & DLQ alerts| Resend
    WorkerBoard -->|Inspects queues & schedulers| Redis
```

### Razorpay Test-Mode Checkout & Webhook Outbox Sequence

```mermaid
sequenceDiagram
    autonumber
    actor Investor
    participant UI as InvestButton & Checkout Modal
    participant API as /checkout & /webhooks/razorpay
    participant Redis as Redis Cloud (TCP)
    participant Mongo as MongoDB (Project, Payment, WebhookEvent)
    participant Razorpay as Razorpay Test API
    participant Worker as Render /worker (payments + SSE)

    Investor->>UI: Initiate commitment (>= minInvestment)
    UI->>API: POST /checkout { amount } + Idempotency-Key
    API->>Mongo: Release expired holds + atomic findOneAndUpdate ($expr current+reserved+amount <= valuation)
    API->>Razorpay: orders.create (integer paise; compensating release on 502)
    API->>Mongo: Upsert Payment ("created") + best-effort delayed release-reservation
    API-->>UI: 200 { orderId, amountPaise, keyId, reservationId }
    Investor->>Razorpay: Complete simulated Checkout ("Test mode - no real money")
    Razorpay->>API: POST /api/webhooks/razorpay (raw HMAC-SHA256 -> WebhookEvent outbox)
    API->>Redis: Best-effort enqueue process-webhook (5m reaper recovers drops)
    API-->>Razorpay: 200 { received: true }
    Worker->>Mongo: Atomic finalize ($pull hold, $inc currentFunding, AuditLog PAYMENT_CAPTURED)
    Worker->>Redis: Invalidate cache + PUBLISH funding:* + enqueue investment-events
```

---

## Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Web Framework & UI** | Next.js `16.4.6` (App Router), React `19.2.3`, TypeScript `5`, Tailwind CSS v4 |
| **Database** | MongoDB Atlas via Mongoose (`Project` w/ `2dsphere` index & pending `reservations[]`, `User`, `AuditLog`, `PlatformStats`, `Payment`, `WebhookEvent`, `DeadLetter`) |
| **Queues & Caching Store** | Hosted TCP Redis (`ioredis` `^6.1.0`, `maxmemory-policy noeviction`), BullMQ `^6.7.10` (`investment-events`, `lifecycle`, `scheduled`, `payments`) |
| **Worker Service** | Standalone Node + Express `5` (`tsx` runtime), CORS SSE (`text/event-stream`), `@bull-board/express` |
| **Auth & Security** | Split `jose` HS256 JWT (`src/lib/auth-core.ts` + Redis `jti`/`tokensValidAfter` revocation), `bcryptjs`, Redis Lua rate limiter |
| **External Integrations** | Razorpay Test SDK (`razorpay ^2.9.8`, `rzp_test_*` simulation only), Groq (`openai` SDK -> `openai/gpt-oss-120b`), Resend (`EMAIL_MODE=sandbox\|live`), Cloudinary, Geoapify, Leaflet / CartoDB |
| **Testing & CI** | Vitest `^4.1.12`, ESLint 9 (`eslint-config-next`), GitHub Actions (`mongo:7` + `redis:7` service containers) |

---

## Engineering Highlights (Measured Results)

| Problem Solved | Implementation Pattern | Verified Result (`npm test` / tooling) | Source |
| :--- | :--- | :--- | :--- |
| **Concurrent Overfunding Race** | MongoDB conditional `findOneAndUpdate` (`$expr: currentFunding + amount <= totalValuation` + `$not: { $elemMatch }`) | `20` parallel `₹2,00,000` commitments on a `₹10,00,000` cap yield strictly `5` × `200`, `15` × `400`, final `currentFunding = 1,000,000`, `status = "Funded"` | [tests/concurrency.test.ts](tests/concurrency.test.ts) |
| **Duplicate Clicks & Redis Crash Replay** | Redis `Idempotency-Key` (`NX EX 30` -> `24h` replay cache) + DB `(userId, idempotencyKey)` fallback | `5` duplicate parallel requests create `1` investment; mismatched amount returns `422`; deleting Redis key post-commit replays `200` (`X-Idempotent-Replay: true`) with `1` DB record | [tests/concurrency.test.ts](tests/concurrency.test.ts) |
| **Razorpay Test-Mode Capacity Reservation** | Embedded pending `reservations[]` + `reservedFunding` (`$ifNull`-safe atomic `findOneAndUpdate`), integer paise `Payment` ledger & lazy `rzp_test_` guard (`503`) | `20` parallel checkouts for `₹1L` on `₹3L` cap yield `3` × `200` + `17` × `409` (`expiresAt` hint) while staying `"Live"`; gateway failure rolls back `502`; `/invest` honors `reservedFunding` & rejects floats (`400`) | [tests/phase4.test.ts](tests/phase4.test.ts) |
| **Webhook Outbox, State Machine & Late Refunds** | Raw-body HMAC-SHA256 `POST /api/webhooks/razorpay` -> `WebhookEvent` outbox (`unique eventId`) + strict `ALLOWED_PAYMENT_TRANSITIONS` + 5m reaper | Tampered/missing signatures fail `400` with `0` inserts; duplicate `eventId` -> `200`; `failed -> captured` succeeds while `captured -> failed` ignored; late capture after expiry commits if capacity exists or runs mocked refund + email + `PAYMENT_REFUNDED` `AuditLog` | [tests/phase4.test.ts](tests/phase4.test.ts) |
| **MongoDB Dead-Letter Queue (DLQ)** | Exhausted `payments` jobs write sanitized `DeadLetter` docs (`dead_letters`) & alert `ADMIN_EMAIL`; atomic `open -> replaying` lock (`409` race) | Failed-job alerts keep secrets redacted; `nightly-cleanup` leaves `DeadLetter` intact; Admin `replay` cleans old Redis job & enqueues `payments_replay_{id}_{ts}` (`409` on concurrent replay); `discard` marks `"discarded"` | [tests/phase4.test.ts](tests/phase4.test.ts) |
| **Atomic Sliding-Window Rate Limiting** | Single atomic Redis Lua ZSET script (`rateLimit`) shared across auth, AI, view, checkout, webhook & invest routes | `20` parallel burst calls with `limit = 5` allow strictly `5` and block `15` with `retryAfterSeconds >= 1`; resets after window expiry | [tests/phase2.test.ts](tests/phase2.test.ts) |
| **Hardened OTP & Enumeration Defense** | Redis `HMAC-SHA256(SHA-256("otp-v1:" + JWT_SECRET))` (`600s` TTL), `crypto.timingSafeEqual`, 5-attempt delete + lock | `5` wrong codes lock the `6th` valid attempt (`429`); existing and unknown emails return identical `200`; code fails after expiry and single use | [tests/phase2.test.ts](tests/phase2.test.ts) |
| **Token Revocation & Cross-Domain Bull Board** | Mandatory JWT `jti`, `revoked:{jti}` on logout, `tokensValidAfter` on role change/revoke-all, single-use `60s` Bull Board handoff | Legacy no-`jti` JWTs fail verification; logout & `POST /api/admin/users/[id]/revoke-sessions` & role mutation invalidate tokens immediately | [tests/phase2.test.ts](tests/phase2.test.ts) |
| **Delayed Lifecycle & `Asia/Kolkata` Crons** | `lifecycle` (`expire-listing` w/ active-reservation deferral, `review-reminder`) + `scheduled` (`daily-digest`, `nightly-cleanup`, `weekly-stats`, `payments-reaper`) queues | Stale `approvedAt` / funded deals no-op safely; active `reservedFunding > 0` defers expiry; repeated `registerScheduledJobs` yields `4` schedulers; cleanup keeps `AuditLog` & `DeadLetter` intact | [tests/phase2.test.ts](tests/phase2.test.ts) & [tests/phase4.test.ts](tests/phase4.test.ts) |
| **Bookmark Persistence Across Reloads** | `GET /api/user/star` + server-hydrated `initialStarred` (`React.cache(getSession)`), logged-out redirect to `/login` | Unauthenticated `GET`/`POST` return `401`; toggling persists in MongoDB across reloads; revoked sessions return `401` | [tests/star.test.ts](tests/star.test.ts) |
| **Marketplace Redis Read Cache (`60s`)** | Versioned `cache:v1:marketplace:projects` (`EX 60`), `CACHE_DISABLED` bypass & cross-process invalidation (`invest`, finalize, `PATCH`, `DELETE`, worker `expire-listing`) | Local `npm start` against remote Atlas & Redis Cloud (`15` reqs/pass): cold `BYPASS` (`p50=85.87 ms`, `p95=1455.44 ms`) vs. warm `HIT` (`p50=47.82 ms`, `p95=88.49 ms`; `15/16` `HIT` after `1` `MISS`, `0.938` hit ratio) | [tools/bench-cache.mjs](tools/bench-cache.mjs) |
| **AI Copilot Cache (`24h`)** | SHA-256 `cache:v1:ai:{id}:{hash}` (`EX 86400`) checked before per-IP & global rate limits | Local `npm start` against remote Atlas, Redis Cloud & Groq: `MISS` (`1657.34 ms`, HTTP `200`) vs. `HIT` (`107.12 ms`, HTTP `200`); HIT skips Groq and consumes `0` IP limit budget | [tools/bench-cache.mjs](tools/bench-cache.mjs) & [tests/phase3a.test.ts](tests/phase3a.test.ts) |
| **Authoritative AI, Single-Flight & Global Limiter** | Server loads DB fields (`404` non-owner pending), `<project_data>` delimiters, `groq:global` (`30/60s`), `ai:lock` `SET NX EX 30` | Forged request title/valuation ignored; `6` concurrent identical misses coalesce within documented bound (`<= 2` calls, `4+` poll HITs); `31st` miss returns `429` + `Retry-After` | [tests/phase3a.test.ts](tests/phase3a.test.ts) |
| **Deduplicated 7-Day Trending Leaderboard** | Post-mount view beacon (`+1`), AI (`+2`), star add (`+3`) deduped via `SET NX EX 86400`, real invest/capture (`+5`), lazy `ZUNIONSTORE WEIGHTS 7..1` | Duplicate same-day events, star removals & idempotent replays add `0`; `>7d` buckets and non-`Live` listings excluded; daily keys keep `<=8d` TTL | [tests/phase3a.test.ts](tests/phase3a.test.ts) |
| **Production Worker Dependency Hygiene** | Runtime `tsx` + static AST import scan before deploy (`npm ci --omit=dev`) | Fails build if `worker/` or transitive `src/` imports depend on any `devDependencies` package | [tools/check-worker-deps.mjs](tools/check-worker-deps.mjs) |

---

## Key Design Decisions

- **Money correctness lives in MongoDB, not Redis:** Atomic conditional updates enforce the `100%` funding ceiling (`currentFunding + reservedFunding <= totalValuation`) and per-idempotency-key uniqueness in the database ledger; Redis handles locks, rate limits, queues, and Pub/Sub.
- **Separate persistent `/worker` service:** Vercel serverless functions cannot host long-running BullMQ workers or hold long-lived SSE connections, so `/worker` runs independently on Render (without Docker) while sharing MongoDB, Redis, and `src/lib/auth-core.ts`.
- **Signature-only Edge middleware vs. Node revocation:** `src/middleware.ts` avoids `ioredis` so it runs cleanly on Vercel's Edge runtime, enforcing signature, role, and `jti` presence, while `React.cache(getSession)` and `requireRole()` enforce live Redis revocation once per server render/request.
- **Intentional fail-open vs. fail-closed policies:** General sliding-window rate limits and revocation checks fail **open** (with loud logs) so transient Redis blips do not brick site logins, whereas `/api/auth/otp/verify` fails **closed** (`503`/`429`) to prevent brute-forcing 6-digit OTPs.
- **Strict Test-Mode Payments Guard:** `getRazorpayClient()` initializes lazily and refuses any non-`rzp_test_` `RAZORPAY_KEY_ID` (`503`) without breaking Next.js builds or CI; webhook verification uses raw body HMAC and stores an outbox document before touching Redis.

---

## Run Locally

### Prerequisites
- Node.js `20+` (CI verifies on Node `22`)
- MongoDB instance (local or test URI)
- Redis server (`maxmemory-policy noeviction`)

### Setup & Commands

```bash
git clone https://github.com/ChandanMeher4/Foundr.git
cd Foundr
npm ci
cp .env.example .env.local
# Populate your local values inside .env.local
```

Start Next.js (`http://localhost:3000`) and `/worker` (`http://localhost:4000`) together:

```bash
npm run dev:all
```

Run checks and integration tests (automatically isolated to `*_test` database and `test:` Redis keys via [tests/setup.ts](tests/setup.ts); Razorpay tests run offline with an injected mock client and require no Razorpay credentials):

```bash
npm run lint
npm run typecheck
npm run check:worker-deps
npm test
npm run build
npm audit --omit=dev --audit-level=critical
```

> **Local Webhook Testing Tip:** To exercise live Razorpay Test Dashboard webhooks locally with `PAYMENTS_ENABLED=true`, expose `http://localhost:3000/api/webhooks/razorpay` via Cloudflare Tunnel or `ngrok` and configure that HTTPS URL + `RAZORPAY_WEBHOOK_SECRET` in Razorpay Test Mode settings.

---

## Deployment Overview

Foundr deploys cleanly without Docker across four managed services (see [.github/workflows/ci.yml](.github/workflows/ci.yml) and [.env.example](.env.example)):

1. **Vercel (Next.js Web App):** Standard Next.js build (`npm run build`).
   - Core & Features: `MONGODB_URI`, `REDIS_URL`, `JWT_SECRET`, `GROQ_API_KEY`, `RESEND_API_KEY`, `EMAIL_MODE`, `ADMIN_EMAIL`, `OTP_LOGIN_ENABLED`, `NEXT_PUBLIC_OTP_LOGIN_ENABLED`, `NEXT_PUBLIC_WORKER_URL`, `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME`, `NEXT_PUBLIC_CLOUDINARY_UPLOAD_PRESET`, `NEXT_PUBLIC_GEOAPIFY_KEY`, optional `CACHE_DISABLED`.
   - Phase 4 Payments *(when enabling `PAYMENTS_ENABLED=true`)*: `PAYMENTS_ENABLED`, `RAZORPAY_KEY_ID` (`rzp_test_*`), `RAZORPAY_KEY_SECRET`, **`RAZORPAY_WEBHOOK_SECRET`** *(Vercel only)*, `RESERVATION_TTL_MINUTES`, optional `PAYMENTS_DEMO_MODE`.
2. **Render (Persistent `/worker` Node Service):**
   - Build command: `npm ci --omit=dev`
   - Start command: `npm run worker`
   - Env vars: `MONGODB_URI`, `REDIS_URL`, `JWT_SECRET` *(identical to Vercel)*, `RESEND_API_KEY`, `EMAIL_MODE`, `ADMIN_EMAIL`, `FRONTEND_ORIGIN` *(e.g., `https://foundr-gamma.vercel.app`)*, plus optional `CACHE_DISABLED`, `PAYMENTS_ENABLED`, `RAZORPAY_KEY_ID` (`rzp_test_*`), `RAZORPAY_KEY_SECRET`, `RESERVATION_TTL_MINUTES`, `PAYMENTS_DEMO_MODE`. *(Do **not** set `RAZORPAY_WEBHOOK_SECRET` on Render.)*
3. **Redis Cloud (Free Tier TCP):** Configured with `maxmemory-policy noeviction`; Next.js uses one shared singleton connection per instance and `/worker` uses 6 connections total (adding `+1` `payments` worker connection).
4. **MongoDB Atlas:** Hosts `projects` (`2dsphere` & reservation expiry indexes), `users`, `auditlogs`, `platform_stats`, `payments`, `webhook_events`, and `dead_letters`.

> **Deploy Coordination Note:** Both Vercel and Render `/worker` must redeploy together for Phase 4 so `payments` queue handlers, `payments-reaper`, `Project.reservations[]`, and late-payment refund/release checks stay synchronized. `PAYMENTS_ENABLED` defaults unset/`false` until test keys are configured.

---

## Demo Accounts

Use either dedicated dummy demo account below to evaluate [foundr-gamma.vercel.app](https://foundr-gamma.vercel.app/) without registering:

| Role | Email | Password | Dashboard / Scope |
| :--- | :--- | :--- | :--- |
| **Investor** | `shivamkumar@gmail.com` | `Shivam@1234` | Marketplace, AI Copilot, Starring, Investment Commitments |
| **Developer** | `princediwedi@gmail.com` | `Prince@1234` | `/developer`, `/list-project` |

> **Security Note:** Admin credentials and `/admin` / Bull Board queue dashboards are strictly private and never included in demo documentation.

---

## Honest Operational Notes

- **Worker Cold-Start Wake Delay:** The `/worker` service runs on Render's free tier and can take ~1 minute to wake after idling; UptimeRobot monitors `/health` at 5-minute intervals to keep it warm for live SSE and scheduled crons.
- **Email Sandbox & Live OTP Flag:** Because no custom sending domain is verified on Resend yet, production runs with `EMAIL_MODE=sandbox` and `OTP_LOGIN_ENABLED=false` (OTP UI hidden on the live site).
- **Simulated Commitments & Test-Mode Payments:** When `PAYMENTS_ENABLED=false` (default), clicking commit tests the atomic ledger, idempotency, Redis Pub/Sub SSE, and BullMQ pipeline directly; when `PAYMENTS_ENABLED=true`, checkout runs strictly in **Razorpay Test Mode (`rzp_test_*`)** labeled `"Test mode - no real money"` — zero real funds or custodial accounts move.

---

## Roadmap

- [x] **Razorpay Test-Mode Checkout:** Atomic capacity reservation at checkout (`$ifNull` legacy safe) + delayed BullMQ release, raw HMAC webhook outbox + 5m reaper, and MongoDB Dead-Letter Queue (`ADR-0024`–`0026`)
- [ ] **Validation & Contracts:** Request/response Zod schemas and OpenAPI specs (`/api/docs`)
- [ ] **Observability:** Structured `pino` logging (`requestId` correlated into BullMQ jobs), Sentry error tracking, `/api/health`, Admin-gated `/api/metrics`, and targeted Playwright E2E coverage
- [ ] **Receipts (Deferred):** Investment PDF receipts generated inside the existing `confirm-investor` BullMQ job and persisted in MongoDB

---

## Author

**Chandan Meher (Jeet)** — B.Tech CSE, Dayananda Sagar College of Engineering  
LinkedIn: https://www.linkedin.com/in/chandan-meher-74ab1a2bb/ | Portfolio: https://personal-portfolio-0906.netlify.app/
