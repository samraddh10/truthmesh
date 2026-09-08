import { loadConfig, loadDotEnvFile, requireModelAccess } from '@superjoin/config';

loadDotEnvFile();
import { appSettings, closeDatabase, createDatabase } from '@superjoin/db';

import { documents } from '@superjoin/db';
import {
  DOCUMENT_QUEUE,
  checkReadiness,
  configuredProviders,
  createComparisonStage,
  createEmbeddingProvider,
  createExtractionStage,
  createModelClient,
  createNormalizationStage,
  createQueueClient,
  createVisualStage,
  ensureStorage,
  parsingStage,
  processDocumentJob,
  startQueue,
  type DocumentJob,
  type StageHandler,
} from '@superjoin/pipeline';
import { eq } from 'drizzle-orm';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const boss = createQueueClient(config.databaseUrl);

function log(level: 'info' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    service: 'worker',
    message,
    ...fields,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

try {
  requireModelAccess(config);
} catch (error) {
  log('error', 'not configured', { detail: (error as Error).message });
  process.exit(1);
}

const modelClient = createModelClient(config, database.db);

async function publishProviderAvailability(): Promise<void> {
  const available = configuredProviders(config);
  try {
    const [row] = await database.db.select({ id: appSettings.id }).from(appSettings).limit(1);
    if (row === undefined) {
      await database.db
        .insert(appSettings)
        .values({
          availableProviders: available,
          ...(available[0] !== undefined ? { activeProvider: available[0] } : {}),
        })
        .onConflictDoNothing();
      return;
    }
    await database.db
      .update(appSettings)
      .set({ availableProviders: available, updatedAt: new Date() })
      .where(eq(appSettings.id, row.id));
  } catch (error) {
    log('error', 'could not publish provider availability', {
      detail: (error as Error).message,
    });
  }
}

const embeddings = createEmbeddingProvider(config);

const STAGES: readonly StageHandler[] = [
  parsingStage,
  createVisualStage({
    client: modelClient,
    async documentHash(context) {
      const [row] = await context.database.db
        .select({ contentHash: documents.contentHash })
        .from(documents)
        .where(eq(documents.id, context.job.documentId))
        .limit(1);
      return row?.contentHash ?? '0'.repeat(64);
    },
  }),
  createExtractionStage({
    client: modelClient,
    tokenBudget: config.documentTokenBudget,
    concurrency: config.llmConcurrency,
    batchInputTokens: config.extractionBatchTokens,
    batchMaxChunks: config.extractionBatchChunks,
  }),
  createNormalizationStage({ client: modelClient }),
  createComparisonStage({
    client: modelClient,
    embeddings,
    topK: config.candidateTopK,
  }),
];

let shuttingDown = false;

async function shutdown(signal: string, code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', 'shutting down', { signal });
  try {
    await boss.stop({ graceful: true, timeout: 30_000 });
    await closeDatabase(database);
  } catch (error) {
    log('error', 'shutdown failed', { error: (error as Error).message });
    process.exit(1);
  }
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

await ensureStorage(config.storageDir);

const readiness = await checkReadiness('worker', database, config.storageDir);

if (!readiness.ok) {
  log('error', 'not ready', {
    database: readiness.database.detail,
    storage: readiness.storage.detail,
  });
  await shutdown('startup', 1);
}

await startQueue(boss);

await boss.work<DocumentJob>(
  DOCUMENT_QUEUE,
  { batchSize: 1 },
  async ([job]) => {
    if (job === undefined) return;

    const started = Date.now();
    log('info', 'processing', { runId: job.data.runId, documentId: job.data.documentId });

    try {
      const outcome = await processDocumentJob(
        { database, storageDir: config.storageDir, stages: STAGES },
        job.data,
      );
      if (outcome.status === 'abandoned') {
        log('info', 'abandoned', { runId: outcome.runId, reason: outcome.reason });
      } else {
        log('info', 'finished', {
          runId: outcome.runId,
          stage: outcome.stage,
          durationMs: Date.now() - started,
        });
      }
    } catch (error) {
      log('error', 'job failed, will retry if attempts remain', {
        runId: job.data.runId,
        error: (error as Error).message,
      });
      throw error;
    }
  },
);

await publishProviderAvailability();

log('info', 'ready', {
  queue: DOCUMENT_QUEUE,
  stages: STAGES.length,
  storageRoot: readiness.storage.root,
  migrationsApplied: readiness.database.migrationsApplied,
  providers: configuredProviders(config),
  bedrockModel: config.bedrockModelId,
  groqModel: config.groqModel,
  llmConcurrency: config.llmConcurrency,
  embeddingModel: config.embeddingModel,
  candidateTopK: config.candidateTopK,
});
