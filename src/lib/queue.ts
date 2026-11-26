import { FlowProducer, Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { getRedisConnection, getRedisKeyPrefix } from "./redis";

export const INVESTMENT_EVENTS_QUEUE = "investment-events";
export const LIFECYCLE_QUEUE = "lifecycle";
export const SCHEDULED_QUEUE = "scheduled";

export interface InvestmentJobPayload {
  investmentId: string;
  projectId: string;
  projectTitle: string;
  investorId: string;
  investorName: string;
  investorEmail: string;
  developerName: string;
  developerEmail?: string;
  amount: number;
  currentFunding: number;
  totalValuation: number;
  becameFunded: boolean;
  idempotencyKey?: string;
  ip: string;
  createdAt: string;
}

export interface ExpireListingPayload {
  projectId: string;
  approvedAt: string;
}

export interface ReviewReminderPayload {
  projectId: string;
}

const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 2000,
  },
  removeOnComplete: { count: 200 },
  removeOnFail: false,
};

type GlobalWithQueues = typeof globalThis & {
  __foundrInvestQueue?: Queue;
  __foundrFlowProducer?: FlowProducer;
  __foundrLifecycleQueue?: Queue;
  __foundrScheduledQueue?: Queue;
};

function bullConnection(): ConnectionOptions {
  return getRedisConnection() as unknown as ConnectionOptions;
}

export function getBullPrefix(): string | undefined {
  const keyPrefix = getRedisKeyPrefix();
  return keyPrefix ? `${keyPrefix}bull` : undefined;
}

/** Uses underscore separator so BullMQ custom jobId colon validation never rejects jobs. */
export function getExpireListingJobId(projectId: string): string {
  return `expire_${projectId}`;
}

export function getReviewReminderJobId(projectId: string): string {
  return `reminder_${projectId}`;
}

export function getLifecycleDelays(): { expireMs: number; reminderMs: number } {
  if (process.env.LIFECYCLE_DEMO_MODE === "true") {
    return {
      expireMs: 15 * 1000,
      reminderMs: 10 * 1000,
    };
  }
  return {
    expireMs: 30 * 24 * 60 * 60 * 1000,
    reminderMs: 48 * 60 * 60 * 1000,
  };
}

/** Returns singleton BullMQ Queue for investment events sharing the single global Redis connection. */
export function getInvestmentQueue(): Queue {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrInvestQueue) {
    const prefix = getBullPrefix();
    g.__foundrInvestQueue = new Queue(INVESTMENT_EVENTS_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
      ...(prefix ? { prefix } : {}),
    });
  }
  return g.__foundrInvestQueue;
}

/** Returns singleton BullMQ Queue for delayed project lifecycle jobs. */
export function getLifecycleQueue(): Queue {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrLifecycleQueue) {
    const prefix = getBullPrefix();
    g.__foundrLifecycleQueue = new Queue(LIFECYCLE_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
      ...(prefix ? { prefix } : {}),
    });
  }
  return g.__foundrLifecycleQueue;
}

/** Returns singleton BullMQ Queue for scheduled recurring cron jobs. */
export function getScheduledQueue(): Queue {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrScheduledQueue) {
    const prefix = getBullPrefix();
    g.__foundrScheduledQueue = new Queue(SCHEDULED_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
      ...(prefix ? { prefix } : {}),
    });
  }
  return g.__foundrScheduledQueue;
}

/** Returns singleton BullMQ FlowProducer sharing the single global Redis connection. */
export function getInvestmentFlowProducer(): FlowProducer {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrFlowProducer) {
    const prefix = getBullPrefix();
    g.__foundrFlowProducer = new FlowProducer({
      connection: bullConnection(),
      ...(prefix ? { prefix } : {}),
    });
  }
  return g.__foundrFlowProducer;
}

/**
 * Enqueues the post-investment BullMQ parent/child flow.
 */
export async function enqueueInvestmentFlow(
  payload: InvestmentJobPayload,
): Promise<void> {
  const flowProducer = getInvestmentFlowProducer();
  const id = payload.investmentId;
  const prefix = getBullPrefix();

  await flowProducer.add({
    name: "check-funded",
    queueName: INVESTMENT_EVENTS_QUEUE,
    data: payload,
    ...(prefix ? { prefix } : {}),
    opts: {
      ...DEFAULT_JOB_OPTS,
      jobId: `check-funded_${id}`,
    },
    children: [
      {
        name: "notify-developer",
        queueName: INVESTMENT_EVENTS_QUEUE,
        data: payload,
        ...(prefix ? { prefix } : {}),
        opts: {
          ...DEFAULT_JOB_OPTS,
          jobId: `notify-developer_${id}`,
        },
      },
      {
        name: "confirm-investor",
        queueName: INVESTMENT_EVENTS_QUEUE,
        data: payload,
        ...(prefix ? { prefix } : {}),
        opts: {
          ...DEFAULT_JOB_OPTS,
          jobId: `confirm-investor_${id}`,
        },
      },
      {
        name: "audit-log",
        queueName: INVESTMENT_EVENTS_QUEUE,
        data: payload,
        ...(prefix ? { prefix } : {}),
        opts: {
          ...DEFAULT_JOB_OPTS,
          jobId: `audit-log_${id}`,
        },
      },
    ],
  });
}

/** Removes any pending delayed lifecycle jobs (`expire-listing`, `review-reminder`) for a project. */
export async function cancelLifecycleJobs(projectId: string): Promise<void> {
  const queue = getLifecycleQueue();
  for (const jobId of [
    getExpireListingJobId(projectId),
    getReviewReminderJobId(projectId),
  ]) {
    try {
      const existing = await queue.getJob(jobId);
      if (existing) {
        await existing.remove();
      }
    } catch (err) {
      console.warn(
        `[Lifecycle] Could not remove job ${jobId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Schedules a 48h (or demo) admin reminder if a newly submitted listing stays Pending Review. */
export async function scheduleReviewReminder(projectId: string): Promise<void> {
  const queue = getLifecycleQueue();
  const { reminderMs } = getLifecycleDelays();
  const jobId = getReviewReminderJobId(projectId);

  const stale = await queue.getJob(jobId);
  if (stale) {
    await stale.remove().catch(() => {});
  }

  await queue.add(
    "review-reminder",
    { projectId } satisfies ReviewReminderPayload,
    {
      ...DEFAULT_JOB_OPTS,
      delay: reminderMs,
      jobId,
    },
  );
}

/** Schedules a 30d (or demo) automatic expiry check when a listing goes Live. */
export async function scheduleExpireListing(
  payload: ExpireListingPayload,
): Promise<void> {
  await cancelLifecycleJobs(payload.projectId);
  const queue = getLifecycleQueue();
  const { expireMs } = getLifecycleDelays();

  await queue.add("expire-listing", payload, {
    ...DEFAULT_JOB_OPTS,
    delay: expireMs,
    jobId: getExpireListingJobId(payload.projectId),
  });
}
