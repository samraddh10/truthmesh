import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';

export const DOCUMENT_QUEUE = 'process-document';

export interface DocumentJob {
  readonly runId: string;
  readonly documentId: string;
  readonly collectionId: string;
  readonly stages?: readonly string[];
}

export interface QueuePolicy {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryDelayMaxSeconds: number;
  readonly expireInSeconds: number;
}

export const DEFAULT_QUEUE_POLICY: QueuePolicy = {
  retryLimit: 5,
  retryDelaySeconds: 5,
  retryDelayMaxSeconds: 300,
  expireInSeconds: 3600,
};

export function createQueueClient(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    max: 4,
  });
}

export async function startQueue(
  boss: PgBoss,
  policy: QueuePolicy = DEFAULT_QUEUE_POLICY,
): Promise<void> {
  await boss.start();
  await boss.createQueue(DOCUMENT_QUEUE, {
    retryLimit: policy.retryLimit,
    retryDelay: policy.retryDelaySeconds,
    retryBackoff: true,
    retryDelayMax: policy.retryDelayMaxSeconds,
    expireInSeconds: policy.expireInSeconds,
  });
}

export interface DrizzleExecutor {
  execute(query: unknown): Promise<{ rows: unknown[] } | { rows: unknown[] }[] | unknown[]>;
}

export async function enqueueDocumentJob(
  boss: PgBoss,
  tx: DrizzleExecutor,
  job: DocumentJob,
): Promise<string | null> {
  return boss.send(DOCUMENT_QUEUE, job, {
    db: fromDrizzle(tx, sql as never),
    singletonKey: job.documentId,
  });
}
