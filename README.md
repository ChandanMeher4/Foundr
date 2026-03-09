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
```

## 4 Run the development server

```bash
npm run dev
```

App will run on:

```
http://localhost:3000
```

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
