import { Resend } from "resend";

export interface SendEmailInput {
  to: string | string[];
  cc?: string[];
  subject: string;
  html: string;
  from?: string;
}

const DEFAULT_FROM = "Foundr <onboarding@resend.dev>";

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) return null;
  return new Resend(apiKey);
}

/**
 * Dispatches emails respecting EMAIL_MODE:
 * - "sandbox" (default): routes exclusively to ADMIN_EMAIL or logs safely without calling external recipients.
 * - "live": sends to real target recipients via Resend.
 */
export async function sendAppEmail(input: SendEmailInput): Promise<{
  mode: "sandbox" | "live";
  delivered: boolean;
  id?: string;
}> {
  const mode = process.env.EMAIL_MODE === "live" ? "live" : "sandbox";
  const intendedTo = Array.isArray(input.to) ? input.to.join(", ") : input.to;

  if (mode === "sandbox") {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (!adminEmail) {
      console.log(
        `[EMAIL SANDBOX LOG] Intended To: ${intendedTo} | Subject: ${input.subject}`,
      );
      return { mode, delivered: false };
    }

    const resend = getResendClient();
    if (!resend) {
      console.warn("[EMAIL SANDBOX] RESEND_API_KEY missing; logged only.");
      return { mode, delivered: false };
    }

    const { data, error } = await resend.emails.send({
      from: input.from || DEFAULT_FROM,
      to: adminEmail,
      subject: `[SANDBOX -> ${intendedTo}] ${input.subject}`,
      html: input.html,
    });

    if (error) {
      throw new Error(`Resend sandbox error: ${error.message}`);
    }

    return { mode, delivered: true, id: data?.id };
  }

  const resend = getResendClient();
  if (!resend) {
    throw new Error("RESEND_API_KEY is required when EMAIL_MODE=live");
  }

  const { data, error } = await resend.emails.send({
    from: input.from || DEFAULT_FROM,
    to: input.to,
    ...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
    subject: input.subject,
    html: input.html,
  });

  if (error) {
    throw new Error(`Resend live error: ${error.message}`);
  }

  return { mode, delivered: true, id: data?.id };
}
