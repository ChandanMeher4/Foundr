import type { Job, Queue } from "bullmq";
import dbConnect from "../src/lib/db";
import { sendAppEmail } from "../src/lib/email";
import type { InvestmentJobPayload } from "../src/lib/queue";
import AuditLog from "../src/models/AuditLog";
import Project from "../src/models/Project";
import User from "../src/models/User";

interface FundedFanoutPayload {
  projectId: string;
  projectTitle: string;
  totalValuation: number;
  recipientEmail: string;
  recipientName: string;
  recipientRole: "Investor" | "Developer" | "Admin";
}

function formatInr(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

export async function processInvestmentJob(
  job: Job,
  queue: Queue,
): Promise<unknown> {
  switch (job.name) {
    case "notify-developer": {
      const data = job.data as InvestmentJobPayload;
      const recipient = data.developerEmail || process.env.ADMIN_EMAIL;
      if (!recipient) {
        console.log(
          `[notify-developer] No developer/admin email available for investment ${data.investmentId}`,
        );
        return { skipped: true };
      }
      return sendAppEmail({
        to: recipient,
        subject: `New Investment Commitment: ${formatInr(data.amount)} in ${data.projectTitle}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">Great news, ${data.developerName}!</h2>
            <p>You received a new investment commitment for <strong>${data.projectTitle}</strong>.</p>
            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px;">
              <p><strong>Investor:</strong> ${data.investorName} (${data.investorEmail})</p>
              <p><strong>Amount:</strong> ${formatInr(data.amount)}</p>
              <p><strong>Total Raised:</strong> ${formatInr(data.currentFunding)} / ${formatInr(data.totalValuation)}</p>
            </div>
          </div>
        `,
      });
    }

    case "confirm-investor": {
      const data = job.data as InvestmentJobPayload;
      return sendAppEmail({
        to: data.investorEmail,
        subject: `Commitment Receipt: ${formatInr(data.amount)} in ${data.projectTitle}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Thank you, ${data.investorName}!</h2>
            <p>Your fractional investment commitment has been recorded.</p>
            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px;">
              <p><strong>Reference ID:</strong> ${data.investmentId}</p>
              <p><strong>Property:</strong> ${data.projectTitle}</p>
              <p><strong>Committed Amount:</strong> ${formatInr(data.amount)}</p>
              <p><strong>Timestamp:</strong> ${data.createdAt}</p>
            </div>
          </div>
        `,
      });
    }

    case "audit-log": {
      const data = job.data as InvestmentJobPayload;
      await dbConnect();
      const record = await AuditLog.findOneAndUpdate(
        { investmentId: data.investmentId },
        {
          $setOnInsert: {
            investmentId: data.investmentId,
            eventType: "INVESTMENT_COMMITTED",
            projectId: data.projectId,
            userId: data.investorId,
            amount: data.amount,
            ...(data.idempotencyKey
              ? { idempotencyKey: data.idempotencyKey }
              : {}),
            ip: data.ip,
            metadata: {
              projectTitle: data.projectTitle,
              currentFunding: data.currentFunding,
              totalValuation: data.totalValuation,
              committedAt: data.createdAt,
            },
          },
        },
        { upsert: true, returnDocument: "after" },
      );
      return { auditLogId: record._id.toString() };
    }

    case "check-funded": {
      const data = job.data as InvestmentJobPayload;
      await dbConnect();
      const project = await Project.findById(data.projectId)
        .populate("developerName", "name email")
        .populate("investors.userId", "name email")
        .lean();

      if (!project) {
        return { funded: false, reason: "project_not_found" };
      }

      const isFunded =
        project.status === "Funded" ||
        (project.currentFunding || 0) >= project.totalValuation;

      if (!isFunded) {
        return { funded: false, currentFunding: project.currentFunding };
      }

      // Build deduplicated fan-out recipients
      const recipients = new Map<string, FundedFanoutPayload>();
      const addRecipient = (
        email: string | undefined,
        name: string,
        role: "Investor" | "Developer" | "Admin",
      ) => {
        if (!email) return;
        const normalized = email.trim().toLowerCase();
        if (!recipients.has(normalized)) {
          recipients.set(normalized, {
            projectId: data.projectId,
            projectTitle: project.title,
            totalValuation: project.totalValuation,
            recipientEmail: normalized,
            recipientName: name,
            recipientRole: role,
          });
        }
      };

      const dev = project.developerName as
        | { name?: string; email?: string }
        | undefined;
      addRecipient(dev?.email, dev?.name || "Developer", "Developer");

      const investors = Array.isArray(project.investors) ? project.investors : [];
      for (const inv of investors) {
        const u = inv.userId as { name?: string; email?: string } | undefined;
        addRecipient(u?.email, u?.name || "Investor", "Investor");
      }

      const admins = await User.find({ role: "Admin" }).select("name email").lean();
      for (const admin of admins) {
        addRecipient(admin.email, admin.name || "Admin", "Admin");
      }

      const jobs = Array.from(recipients.entries()).map(([emailKey, payload]) => {
        const safeEmailKey = emailKey.replace(/[^a-zA-Z0-9._-]/g, "_");
        return {
          name: "funded-fanout",
          data: payload,
          opts: {
            attempts: 5,
            backoff: { type: "exponential" as const, delay: 2000 },
            removeOnComplete: { count: 200 },
            removeOnFail: false,
            jobId: `funded-fanout_${data.projectId}_${safeEmailKey}`,
          },
        };
      });

      if (jobs.length > 0) {
        await queue.addBulk(jobs);
      }

      return { funded: true, fannedOutCount: jobs.length };
    }

    case "funded-fanout": {
      const data = job.data as FundedFanoutPayload;
      return sendAppEmail({
        to: data.recipientEmail,
        subject: `Project Fully Funded: ${data.projectTitle}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #059669;">100% Funded Milestone Reached!</h2>
            <p>Hello ${data.recipientName},</p>
            <p><strong>${data.projectTitle}</strong> has reached 100% of its ${formatInr(data.totalValuation)} valuation target.</p>
          </div>
        `,
      });
    }

    default:
      throw new Error(`Unknown job name: ${job.name}`);
  }
}
