import type { Job, Queue } from "bullmq";
import { invalidateMarketplaceCache } from "../src/lib/cache";
import dbConnect from "../src/lib/db";
import { sendAppEmail } from "../src/lib/email";
import { cleanupLegacyOtpFields } from "../src/lib/otp";
import type {
  ExpireListingPayload,
  InvestmentJobPayload,
  ReviewReminderPayload,
} from "../src/lib/queue";
import AuditLog from "../src/models/AuditLog";
import PlatformStats from "../src/models/PlatformStats";
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

interface DigestProjectSummary {
  id: string;
  title: string;
  address: string;
  category: string;
  minInvestment: number;
  totalValuation: number;
}

interface SendDigestPayload {
  recipientEmail: string;
  recipientName: string;
  projects: DigestProjectSummary[];
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
      throw new Error(`Unknown investment job name: ${job.name}`);
  }
}

export async function processLifecycleJob(job: Job): Promise<unknown> {
  await dbConnect();

  switch (job.name) {
    case "expire-listing": {
      const { projectId, approvedAt } = job.data as ExpireListingPayload;
      const project = await Project.findById(projectId)
        .populate("developerName", "name email")
        .lean();

      if (!project) {
        return { noOp: true, reason: "project_not_found" };
      }
      if (project.status !== "Live") {
        return { noOp: true, reason: `status_${project.status}` };
      }
      if ((project.currentFunding || 0) >= project.totalValuation) {
        return { noOp: true, reason: "already_funded" };
      }
      if (
        !project.approvedAt ||
        new Date(project.approvedAt).toISOString() !==
          new Date(approvedAt).toISOString()
      ) {
        return { noOp: true, reason: "approvedAt_mismatch" };
      }

      const updateRes = await Project.updateOne(
        {
          _id: projectId,
          status: "Live",
          approvedAt: new Date(approvedAt),
          currentFunding: { $lt: project.totalValuation },
        },
        { $set: { status: "Expired" } },
      );

      if (updateRes.modifiedCount === 0) {
        return { noOp: true, reason: "concurrent_state_change" };
      }

      await invalidateMarketplaceCache();

      const dev = project.developerName as
        | { name?: string; email?: string }
        | undefined;
      const recipient = dev?.email || process.env.ADMIN_EMAIL;
      if (recipient) {
        try {
          await sendAppEmail({
            to: recipient,
            subject: `Listing Expired: ${project.title}`,
            html: `
              <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
                <h2>Listing Window Closed</h2>
                <p>Hello ${dev?.name || "Developer"},</p>
                <p>Your listing <strong>${project.title}</strong> reached its 30-day window at ${formatInr(project.currentFunding || 0)} / ${formatInr(project.totalValuation)} and is now marked <strong>Expired</strong>.</p>
              </div>
            `,
          });
        } catch (emailErr) {
          console.error("[expire-listing] Developer email failed:", emailErr);
        }
      }

      return { expired: true, projectId };
    }

    case "review-reminder": {
      const { projectId } = job.data as ReviewReminderPayload;
      const project = await Project.findById(projectId).lean();
      if (!project || project.status !== "Pending Review") {
        return {
          noOp: true,
          reason: project ? `status_${project.status}` : "project_not_found",
        };
      }

      const admins = await User.find({ role: "Admin" })
        .select("email")
        .lean();
      const recipients = Array.from(
        new Set(
          [
            ...admins.map((a) => a.email).filter(Boolean),
            process.env.ADMIN_EMAIL?.trim(),
          ].filter((e): e is string => Boolean(e)),
        ),
      );

      if (recipients.length === 0) {
        console.log(
          `[review-reminder] Pending Review reminder skipped (no admin recipients) for ${projectId}`,
        );
        return { noOp: false, reminded: false, reason: "no_admin_recipients" };
      }

      try {
        await sendAppEmail({
          to: recipients,
          subject: `Admin Review Reminder: ${project.title}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Pending Review Listing Reminder</h2>
              <p><strong>${project.title}</strong> has been awaiting moderation for over 48 hours.</p>
              <p>Target Valuation: ${formatInr(project.totalValuation)}</p>
            </div>
          `,
        });
      } catch (emailErr) {
        console.error("[review-reminder] Admin email failed:", emailErr);
      }

      return { reminded: true, projectId, recipientCount: recipients.length };
    }

    default:
      throw new Error(`Unknown lifecycle job name: ${job.name}`);
  }
}

export async function processScheduledJob(
  job: Job,
  scheduledQueue: Queue,
  allQueues: Queue[] = [scheduledQueue],
): Promise<unknown> {
  await dbConnect();

  switch (job.name) {
    case "daily-digest": {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recentListings = await Project.find({
        status: "Live",
        approvedAt: { $gte: since },
      })
        .select("title location category totalValuation minInvestment")
        .lean();

      if (recentListings.length === 0) {
        return {
          mode: process.env.EMAIL_MODE === "live" ? "live" : "sandbox",
          newProjects: 0,
          notifiedCount: 0,
        };
      }

      const summaries: DigestProjectSummary[] = recentListings.map((p) => ({
        id: p._id.toString(),
        title: p.title,
        address: p.location?.address || "",
        category: p.category,
        minInvestment: p.minInvestment,
        totalValuation: p.totalValuation,
      }));

      const investors = await User.find({
        role: "Investor",
        digestOptIn: { $ne: false },
      })
        .select("_id name email city")
        .lean();

      if (process.env.EMAIL_MODE !== "live") {
        const adminRecipient =
          process.env.ADMIN_EMAIL?.trim() || "sandbox-admin@foundr.local";
        await sendAppEmail({
          to: adminRecipient,
          subject: `Daily Digest Summary: ${summaries.length} new listing(s) for ${investors.length} investor(s)`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Daily Digest (Sandbox Summary)</h2>
              <p><strong>${summaries.length}</strong> new project(s) approved in the last 24 hours would have been sent to <strong>${investors.length}</strong> opted-in investor(s).</p>
              <ul>${summaries.map((p) => `<li>${p.title} (${p.address}) — Min ${formatInr(p.minInvestment)}</li>`).join("")}</ul>
            </div>
          `,
        });

        return {
          mode: "sandbox",
          summarySent: true,
          wouldNotifyCount: investors.length,
          newProjects: summaries.length,
        };
      }

      const dayKey = new Date().toISOString().slice(0, 10);
      const jobs = investors
        .filter((inv) => Boolean(inv.email))
        .map((inv) => {
          const city = (inv.city || "").trim().toLowerCase();
          const cityMatches = city
            ? summaries.filter((s) => s.address.toLowerCase().includes(city))
            : [];
          const matchedProjects =
            cityMatches.length > 0 ? cityMatches : summaries;

          return {
            name: "send-digest",
            data: {
              recipientEmail: inv.email,
              recipientName: inv.name || "Investor",
              projects: matchedProjects,
            } satisfies SendDigestPayload,
            opts: {
              attempts: 5,
              backoff: { type: "exponential" as const, delay: 2000 },
              removeOnComplete: { count: 200 },
              removeOnFail: false,
              jobId: `send-digest_${dayKey}_${inv._id.toString()}`,
            },
          };
        });

      if (jobs.length > 0) {
        await scheduledQueue.addBulk(jobs);
      }

      return {
        mode: "live",
        investorsQueued: jobs.length,
        newProjects: summaries.length,
      };
    }

    case "send-digest": {
      const data = job.data as SendDigestPayload;
      return sendAppEmail({
        to: data.recipientEmail,
        subject: `Foundr Daily Opportunities: ${data.projects.length} New Listing(s)`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>New Opportunities on Foundr</h2>
            <p>Hello ${data.recipientName},</p>
            <ul>${data.projects.map((p) => `<li><strong>${p.title}</strong> (${p.address}) — Min ${formatInr(p.minInvestment)} / Target ${formatInr(p.totalValuation)}</li>`).join("")}</ul>
          </div>
        `,
      });
    }

    case "nightly-cleanup": {
      const completedGraceMs = 7 * 24 * 60 * 60 * 1000;
      const failedGraceMs = 30 * 24 * 60 * 60 * 1000;

      let completedCleaned = 0;
      let failedCleaned = 0;

      for (const q of allQueues) {
        const cleanedCompleted = await q.clean(completedGraceMs, 1000, "completed");
        const cleanedFailed = await q.clean(failedGraceMs, 1000, "failed");
        completedCleaned += cleanedCompleted.length;
        failedCleaned += cleanedFailed.length;
      }

      const legacyOtpUsersCleaned = await cleanupLegacyOtpFields();
      console.log(
        `[Nightly Cleanup] completedCleaned=${completedCleaned} failedCleaned=${failedCleaned} legacyOtpUsersCleaned=${legacyOtpUsersCleaned}`,
      );

      return {
        completedCleaned,
        failedCleaned,
        legacyOtpUsersCleaned,
      };
    }

    case "weekly-stats": {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [liveListings, fundedListings, fundingAgg, investorCount, newUsersLast7Days] =
        await Promise.all([
          Project.countDocuments({ status: "Live" }),
          Project.countDocuments({ status: "Funded" }),
          Project.aggregate<{ total: number }>([
            { $match: { status: { $in: ["Live", "Funded"] } } },
            { $group: { _id: null, total: { $sum: "$currentFunding" } } },
          ]),
          User.countDocuments({ role: "Investor" }),
          User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
        ]);

      const totalCommitted = fundingAgg[0]?.total ?? 0;
      const computedAt = new Date();

      await PlatformStats.findOneAndUpdate(
        { key: "latest" },
        {
          $set: {
            key: "latest",
            liveListings,
            fundedListings,
            totalCommitted,
            investorCount,
            newUsersLast7Days,
            computedAt,
          },
        },
        { upsert: true, returnDocument: "after" },
      );

      return {
        liveListings,
        fundedListings,
        totalCommitted,
        investorCount,
        newUsersLast7Days,
        computedAt: computedAt.toISOString(),
      };
    }

    default:
      throw new Error(`Unknown scheduled job name: ${job.name}`);
  }
}
