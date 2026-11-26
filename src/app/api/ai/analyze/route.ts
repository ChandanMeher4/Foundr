import { NextResponse } from "next/server";
import OpenAI from "openai";
import { getClientIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";

export async function POST(req: Request) {
  try {
    const ip = getClientIp(req);
    const aiLimit = await rateLimit({
      key: `ai:ip:${ip}`,
      limit: 20,
      windowSeconds: 3600,
    });
    if (!aiLimit.allowed) {
      return rateLimitResponse(20, aiLimit);
    }

    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json({ error: "Groq API key not configured." }, { status: 500 });
    }

    const groq = new OpenAI({
      apiKey: process.env.GROQ_API_KEY,
      baseURL: "https://api.groq.com/openai/v1", 
    });

    const { title, description, location, minInvestment, totalValuation } = await req.json();

    const prompt = `
      Property: ${title}
      Location: ${location?.address || "Unknown"}
      Description: ${description}
      Min Investment: ₹${minInvestment}
      Total Target: ₹${totalValuation}

      Provide a strict, objective analysis. Return exactly 3 strong pros and 3 potential risks. 
      Format it clearly with bullet points. Do not include introductory or concluding fluff, just the facts.
    `;

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b", 
      messages: [
        { 
          role: "system", 
          content: "You are an expert Wall Street real estate analyst evaluating a fractional investment." 
        },
        { 
          role: "user", 
          content: prompt 
        }
      ],
    });

    const text = completion.choices[0].message.content;

    return NextResponse.json({ analysis: text });

  } catch (error) {
    console.error("Groq AI Generation Error:", error);
    return NextResponse.json({ error: "Failed to analyze property." }, { status: 500 });
  }
}