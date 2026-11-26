# Foundr 🏢
### Fractional Real Estate Investment Platform with AI Risk Analysis

![Next.js](https://img.shields.io/badge/Next.js-15-black)
![Node.js](https://img.shields.io/badge/Node.js-Backend-green)
![MongoDB](https://img.shields.io/badge/MongoDB-Database-brightgreen)
![TailwindCSS](https://img.shields.io/badge/TailwindCSS-Styling-blue)
![Groq](https://img.shields.io/badge/Groq-LPU%20Inference-orange)
![License](https://img.shields.io/badge/License-MIT-blue)

**Foundr** is a full-stack platform that enables **fractional investment in commercial real estate**.  
Users can browse properties, invest partially in high-value assets, and receive **AI-powered risk analysis** instantly.

The platform combines **modern web architecture with ultra-low latency AI inference** to provide investors with real-time insights.

---

# 🔗 Live Demo

👉 [View Live Project](https://foundr-gamma.vercel.app/)

---

# 🚀 Features

## Fractional Property Investment
- Users can invest in **fractions of high-value commercial properties**
- Live **funding progress tracking**
- Transparent property valuation

## AI Risk Copilot
- AI-generated **Pros vs Risks investment report**
- Powered by **Groq LPU inference**
- Uses **GPT-OSS-120B model**
- Generates results in **<500ms**

## Role-Based Access Control
Two user roles:

**Developers**
- List new properties
- Manage asset listings
- Track property funding

**Investors**
- Browse properties
- Invest fractional capital
- Track portfolio performance

## Authentication & Security
- **JWT authentication**
- Protected API routes using middleware
- Secure session management

## Premium UI/UX
- **Next.js App Router**
- **Tailwind CSS design system**
- Smooth animations using **Framer Motion**
- Fully responsive layouts

---

# 🛠 Tech Stack

| Layer | Technology |
|------|-------------|
| Frontend | Next.js 15, React |
| Styling | Tailwind CSS, Framer Motion |
| Backend | Node.js, Next.js API Routes |
| Database | MongoDB Atlas (Mongoose ODM) |
| AI | Groq LPU (openai/gpt-oss-120b) |
| Deployment | Vercel |

---

### Key Concepts

**Fractional Accounting Model**
- Property documents store total valuation
- Investment transactions track partial contributions
- Funding completion automatically updates property status

**Ultra-Low Latency AI**
- Groq LPU hardware allows near real-time financial analysis
- Eliminates long response times typical in GPU inference APIs

---

# ⚙️ Local Installation

## 1 Clone the repository

```bash
git clone https://github.com/ChandanMeher/foundr.git
cd foundr
```

## 2 Install dependencies

```bash
npm install
```

## 3 Create environment variables

Create `.env.local`

```
MONGODB_URI=your_mongodb_uri
JWT_SECRET=your_secret
GROQ_API_KEY=your_groq_key
REDIS_URL=your_tcp_redis_url
EMAIL_MODE=sandbox
```

## 4 Run the development servers

```bash
npm run dev:all      # Starts Next.js (http://localhost:3000) and /worker (http://localhost:4000) together
# Or run separately in two terminals:
npm run dev
npm run worker
```

App will run on:

```
http://localhost:3000
```

---

# 🛠 Engineering Highlights

| Problem Solved | Technology & Pattern | Measured Result |
| :--- | :--- | :--- |
| **Fail-Fast JWT & Cross-Domain RBAC** (`KI-001`–`003`, `KI-016`, Phase 1) | Split `src/lib/auth-core.ts` (`jose` HS256) + single-use 60s handoff token (`GET /api/admin/queues-link`) $\rightarrow$ worker-scoped `HttpOnly` `bullboard_session` cookie | Eliminated `"fallback_secret"` across 10 files; blocked anonymous/non-Admin mutations (`401`/`403`); verified smoke checks rejecting unauthenticated, expired, Investor (`403`), replayed (`401`), and `foundr_token` (`401`) Bull Board requests while serving Admin `bullboard_session` (`200`) |
| **Crash-Safe Idempotency & Concurrency Ceiling** (`KI-004`, Phase 1) | MongoDB atomic conditional `findOneAndUpdate` (`$expr: currentFunding + amount <= totalValuation` + `$not: { $elemMatch }`) + Redis `Idempotency-Key` (`NX EX 30` -> `24h` replay cache + MongoDB fallback) | Verified by `npm test` (`tests/concurrency.test.ts` on isolated `foundr_test` DB, `3/3` passed in `3.20s` / `4.83s` total): `20` parallel ₹2L commitments on ₹10L cap yielded `5` × `200`, `15` × `400`, exact cap; `5` parallel duplicates yielded `1` write (`422` on mismatch); simulated post-commit Redis crash still replayed `200` (`X-Idempotent-Replay: true`) with `1` DB record |
| **Production Worker, Async Flow & Live SSE** (Phase 1) | Persistent `/worker` Express service (`npm ci --omit=dev` verified with runtime `tsx` + `scripts/check-worker-deps.mjs`), BullMQ `investment-events` flow (`FlowProducer`), and CORS SSE (`20s` `: ping` + initial DB snapshot) | Decouples `notify-developer`, `confirm-investor`, `audit-log` (`AuditLog`), and `check-funded` -> `funded-fanout` (`5` retries, exponential backoff, `removeOnFail: false`); live smoke & clean-install tests verified `GET /health` (`200`, `noeviction`, `connected_clients`), live + reconnect SSE state sync, and worker connection budget (`5` / `30` max) |
| **Sliding-Window Rate Limiter, HMAC OTP & Session Revocation** (`KI-007`, Phase 2) | Atomic single-Lua Redis sorted-set limiter (`src/lib/rate-limit.ts`), HMAC-SHA256 Redis OTP (`600s` TTL, `timingSafeEqual`, 5-wrong lockout), and mandatory JWT `jti` + `revoked:{jti}` / `tokensValidAfter` (`src/lib/revocation.ts`) | Verified by `npm test` (`tests/phase2.test.ts` + `tests/concurrency.test.ts`, `9/9` passed in `14.44s` / `17.96s` total): `20` parallel burst requests with `limit=5` allowed strictly `5`; `5` wrong OTP codes locked the `6th` valid code (`429`) & non-existing emails matched `200`; revoked/no-`jti` tokens failed Node `getSession()` while keeping Edge middleware Redis-free |
| **Delayed Lifecycle & `Asia/Kolkata` Scheduled Queues** (Phase 2) | Dedicated `lifecycle` (`expire-listing`, `review-reminder`, `cancelLifecycleJobs`) and `scheduled` (`daily-digest`, `nightly-cleanup`, `weekly-stats` via `upsertJobScheduler`) queues + `GET /api/admin/stats` & Admin snapshot card | Verified idempotent scheduler registration (`3` schedulers on repeated startup), sandbox digest emitting `1` Admin summary and `0` investor emails, stale `approvedAt`/funded no-op guards, `AuditLog` preservation + legacy OTP cleanup (`1` prod user field set removed), and `GET /health` per-queue counts across all `3` BullMQ queues |

---

# 📈 Future Improvements

- Payment gateway integration (Razorpay)
- Blockchain-based property ownership tokens
- Investment analytics dashboard
- Email notifications for funding milestones
- Advanced AI financial forecasting

---

# 👨‍💻 Author

**Chandan Meher (Jeet)**  
B.Tech Computer Science Engineering  
Dayananda Sagar College of Engineering

LinkedIn: [https://www.linkedin.com/in/chandan-meher-74ab1a2bb/]  
Portfolio: [https://personal-portfolio-0906.netlify.app/]

---
