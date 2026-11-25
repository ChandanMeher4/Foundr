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
| **Fail-Fast JWT & RBAC Enforcement** (`KI-001`–`003`, `KI-016`) | Centralized `src/lib/auth-core.ts` + `src/lib/auth.ts` (`jose` HS256) with `requireRole()` route guards & startup secret validation | Eliminated `"fallback_secret"` across 10 files; blocked anonymous project approvals (`401`/`403`), non-Admin Bull Board access (`401`/`403`), and admin signup escalation (`400`) |
| **Concurrent Overfunding Prevention & Idempotency** (`KI-004`, Phase 1) | MongoDB atomic conditional `findOneAndUpdate` (`$expr: currentFunding + amount <= totalValuation`) + Redis `Idempotency-Key` (`NX EX 30` -> `24h` replay cache) | Verified by `npm test` (`tests/concurrency.test.ts`, `2/2` passed in `2544ms`): `20` simultaneous commitments of ₹2,00,000 against a ₹10,00,000 target yielded `5` × `200`, `15` × `400`, exact `currentFunding === totalValuation`; `5` parallel duplicate keys yielded `1` DB write + `422` on amount mismatch |
| **Async Investment Pipeline & Live SSE Stream** (Phase 1) | Separate persistent `/worker` Node service (`BullMQ` `FlowProducer` `investment-events` + Redis `psubscribe("funding:*")` SSE + Admin Bull Board at `/admin/queues`) | Decouples `notify-developer`, `confirm-investor`, `audit-log` (`AuditLog`), and `check-funded` -> `funded-fanout` (`5` retries, exponential backoff, `removeOnFail: false`); live smoke test verified `/health` (`200`, `noeviction`), SSE `event: funding` CORS stream, and shared `4`-connection budget (`1` web + `3` worker) |

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
