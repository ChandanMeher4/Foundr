import { FlowProducer, Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { sanitizeJobIdSegment } from "./razorpay";
import { getRedisConnection, getRedisKeyPrefix } from "./redis";

export const INVESTMENT_EVENTS_QUEUE = "investment-events";
export const LIFECYCLE_QUEUE = "lifecycle";
export const SCHEDULED_QUEUE = "scheduled";
export const PAYMENTS_QUEUE = "payments";

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

export interface ProcessWebhookPayload {
  eventId: string;
}

export interface FinalizePaymentPayload {
  reservationId?: string;
  orderId?: string;
  paymentId?: string;
  amountPaise?: number;
}

export interface ReleaseReservationPayload {
  projectId: string;
  reservationId: string;
  orderId?: string;
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
  __foundrPaymentsQueue?: Queue;
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

/** Returns singleton BullMQ Queue for Razorpay payments, webhooks, and reservation releases. */
export function getPaymentsQueue(): Queue {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrPaymentsQueue) {
    const prefix = getBullPrefix();
    g.__foundrPaymentsQueue = new Queue(PAYMENTS_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
      ...(prefix ? { prefix } : {}),
    });
  }
  return g.__foundrPaymentsQueue;
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

/** Removes any pending delayed lifecycle jobs (`expire-listing`, `review-reminder`, deferred expires) for a project. */
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

  try {
    const delayed = await queue.getDelayed(0, 50);
    for (const job of delayed) {
      const data = job.data as { projectId?: string } | undefined;
      if (job.name === "expire-listing" && data?.projectId === projectId) {
        await job.remove().catch(() => {});
      }
    }
  } catch (err) {
    console.warn(
      "[Lifecycle] Could not scan delayed deferred jobs:",
      err instanceof Error ? err.message : err,
    );
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

/** Defers expire-listing when active reservations exist (uses unique jobId so active job doesn't deduplicate it). */
export async function deferExpireListing(
  payload: ExpireListingPayload,
  delayMs: number,
): Promise<void> {
  const queue = getLifecycleQueue();
  await queue.add("expire-listing", payload, {
    ...DEFAULT_JOB_OPTS,
    delay: Math.max(1000, delayMs),
    jobId: `expire_${sanitizeJobIdSegment(payload.projectId)}_defer_${Date.now()}`,
  });
}

/** Enqueues webhook processing onto the `payments` queue cleanly without colons in jobId. */
export async function enqueuePaymentWebhook(eventId: string): Promise<void> {
  const queue = getPaymentsQueue();
  await queue.add(
    "process-webhook",
    { eventId } satisfies ProcessWebhookPayload,
    {
      ...DEFAULT_JOB_OPTS,
      jobId: `webhook_${sanitizeJobIdSegment(eventId)}`,
    },
  );
}

/** Enqueues idempotent payment finalization onto the `payments` queue. */
export async function enqueuePaymentFinalize(
  payload: FinalizePaymentPayload,
): Promise<void> {
  const queue = getPaymentsQueue();
  const key = payload.reservationId || payload.orderId || String(Date.now());
  await queue.add("finalize-payment", payload, {
    ...DEFAULT_JOB_OPTS,
    jobId: `finalize_${sanitizeJobIdSegment(key)}`,
  });
}

/** Enqueues delayed reservation expiry check (`reservation_{reservationId}`). */
export async function enqueueReleaseReservation(
  payload: ReleaseReservationPayload,
  delayMs: number,
): Promise<void> {
  const queue = getPaymentsQueue();
  await queue.add("release-reservation", payload, {
    ...DEFAULT_JOB_OPTS,
    delay: Math.max(1000, delayMs),
    jobId: `reservation_${sanitizeJobIdSegment(payload.reservationId)}`,
  });
}
