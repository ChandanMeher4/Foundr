import { NextResponse } from "next/server";
import dbConnect from "@/lib/db";
import Project from "@/models/Project";
import User from "@/models/User"; 
import { cookies } from "next/headers";
import { jwtVerify } from "jose";
import { revalidatePath } from "next/cache";
import { Resend } from "resend";

// Initialize Resend with environment variable
const resend = new Resend(process.env.RESEND_API_KEY);

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const resolvedParams = await params;
    const projectId = resolvedParams.id;

    const body = await req.json();
    const amount = Number(body.amount);

    const cookieStore = await cookies();
    const token = cookieStore.get("foundr_token")?.value;

    if (!token)
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const SECRET = new TextEncoder().encode(
      process.env.JWT_SECRET || "fallback_secret",
    );
    const { payload } = await jwtVerify(token, SECRET);
    const investorId = payload.id;

    await dbConnect();

    // 1. Fetch the project AND populate the developer's email
    const project = await Project.findById(projectId).populate(
      "developerName",
      "name email",
    );
    if (!project)
      return NextResponse.json(
        { error: "Opportunity not found" },
        { status: 404 },
      );

    // 2. Fetch the investor's details 
    const investor = await User.findById(investorId);

    if (amount < project.minInvestment) {
      return NextResponse.json(
        {
          error: `Minimum commitment is ₹${project.minInvestment.toLocaleString("en-IN")}`,
        },
        { status: 400 },
      );
    }

    // 3. Increment the funding and push the investor into the array
    const updatedProject = await Project.findByIdAndUpdate(
      projectId,
      {
        $inc: { currentFunding: amount },
        $push: { investors: { userId: investorId, amount: amount } },
      },
      { new: true },
    );

  
    try {
      const { data, error } = await resend.emails.send({
        from: "Foundr <onboarding@resend.dev>",

        to: "mchandan1204@gmail.com",

        subject: `🎉 New Investment Commitment: ₹${amount.toLocaleString("en-IN")}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Great news, ${project.developerName.name}!</h2>
            <p>You just received a new investment commitment for your project <strong>${project.title}</strong>.</p>
            
            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin-top: 20px;">
              <h3 style="margin-top: 0; color: #111827;">Commitment Details:</h3>
              <ul style="list-style: none; padding: 0; color: #4b5563;">
                <li style="margin-bottom: 10px;"><strong>Investor Name:</strong> ${investor.name}</li>
                <li style="margin-bottom: 10px;"><strong>Investor Email:</strong> <a href="mailto:${investor.email}">${investor.email}</a></li>
                <li style="margin-bottom: 10px;"><strong>Amount:</strong> ₹${amount.toLocaleString("en-IN")}</li>
              </ul>
            </div>
          </div>
        `,
      });

      if (error) {
        console.error("Resend API blocked the email:", error);
      } else {
        console.log("Email ACTUALLY sent! Resend ID:", data?.id);
      }
    } catch (emailError) {
      console.error("Critical failure in email block:", emailError);
    }

    revalidatePath("/");
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/developer");

    return NextResponse.json(
      { message: "Commitment secured successfully!", project: updatedProject },
      { status: 200 },
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: "Failed to process commitment." },
      { status: 500 },
    );
  }
}
