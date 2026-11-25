import { FlowProducer, Queue } from "bullmq";
import type { ConnectionOptions } from "bullmq";
import { getRedisConnection } from "./redis";

export const INVESTMENT_EVENTS_QUEUE = "investment-events";

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
  ip: string;
  createdAt: string;
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
};

function bullConnection(): ConnectionOptions {
  return getRedisConnection() as unknown as ConnectionOptions;
}

/** Returns singleton BullMQ Queue instance sharing the single global Redis connection. */
export function getInvestmentQueue(): Queue {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrInvestQueue) {
    g.__foundrInvestQueue = new Queue(INVESTMENT_EVENTS_QUEUE, {
      connection: bullConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTS,
    });
  }
  return g.__foundrInvestQueue;
}

/** Returns singleton BullMQ FlowProducer sharing the single global Redis connection. */
export function getInvestmentFlowProducer(): FlowProducer {
  const g = globalThis as GlobalWithQueues;
  if (!g.__foundrFlowProducer) {
    g.__foundrFlowProducer = new FlowProducer({
      connection: bullConnection(),
    });
  }
  return g.__foundrFlowProducer;
}

/**
 * Enqueues the post-investment BullMQ parent/child flow:
 * Children (`notify-developer`, `confirm-investor`, `audit-log`) run concurrently,
 * then Parent (`check-funded`) executes once all three finish.
 */
export async function enqueueInvestmentFlow(
  payload: InvestmentJobPayload,
): Promise<void> {
  const flowProducer = getInvestmentFlowProducer();
  const id = payload.investmentId;

  await flowProducer.add({
    name: "check-funded",
    queueName: INVESTMENT_EVENTS_QUEUE,
    data: payload,
    opts: {
      ...DEFAULT_JOB_OPTS,
      jobId: `check-funded_${id}`,
    },
    children: [
      {
        name: "notify-developer",
        queueName: INVESTMENT_EVENTS_QUEUE,
        data: payload,
        opts: {
          ...DEFAULT_JOB_OPTS,
          jobId: `notify-developer_${id}`,
        },
      },
      {
        name: "confirm-investor",
        queueName: INVESTMENT_EVENTS_QUEUE,
        data: payload,
        opts: {
          ...DEFAULT_JOB_OPTS,
          jobId: `confirm-investor_${id}`,
        },
      },
      {
        name: "audit-log",
        queueName: INVESTMENT_EVENTS_QUEUE,
        data: payload,
        opts: {
          ...DEFAULT_JOB_OPTS,
          jobId: `audit-log_${id}`,
        },
      },
    ],
  });
}
