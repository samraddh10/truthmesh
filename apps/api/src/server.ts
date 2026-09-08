import multipart from '@fastify/multipart';
import { loadConfig, type Config } from '@superjoin/config';
import { createDatabase, closeDatabase, type DatabaseHandle } from '@superjoin/db';
import {
  checkReadiness,
  createQueueClient,
  ensureStorage,
  limitsFromConfig,
  startQueue,
  type IngestionContext,
} from '@superjoin/pipeline';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';

import { registerCollectionRoutes } from './routes/collections.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerFactRoutes } from './routes/facts.ts';
import { registerRelationshipRoutes } from './routes/relationships.ts';
import { DEFAULT_STALLED_AFTER_MS, registerRunRoutes } from './routes/runs.ts';
import { registerSettingsRoutes } from './routes/settings.ts';

export const PIPELINE_VERSION = '0.1.0';

export interface Server {
  readonly app: FastifyInstance;
  readonly config: Config;
  readonly database: DatabaseHandle;
  readonly boss: PgBoss;
  close(): Promise<void>;
}

export interface ServerOptions {
  readonly logger?: boolean;
}

export async function buildServer(
  config: Config = loadConfig(),
  options: ServerOptions = {},
): Promise<Server> {
  const database = createDatabase(config.databaseUrl);
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: 'info',
            base: { service: 'api' },
          },
  });

  await ensureStorage(config.storageDir);

  const maxUploadBytes = config.maxUploadMb * 1024 * 1024;
  await app.register(multipart, {
    limits: { fileSize: maxUploadBytes, files: 20 },
  });

  const boss = createQueueClient(config.databaseUrl);
  await startQueue(boss);

  const ingestion: IngestionContext = {
    database,
    boss,
    storageDir: config.storageDir,
    limits: limitsFromConfig(config.maxUploadMb, config.maxPdfPages),
    pipelineVersion: PIPELINE_VERSION,
  };

  await registerCollectionRoutes(app, { ingestion, maxUploadBytes });
  await registerRunRoutes(app, { ingestion, stalledAfterMs: DEFAULT_STALLED_AFTER_MS });
  await registerDocumentRoutes(app, { ingestion, stalledAfterMs: DEFAULT_STALLED_AFTER_MS });
  await registerFactRoutes(app, { ingestion });
  await registerRelationshipRoutes(app, { ingestion });

  await registerSettingsRoutes(app, {
    ingestion,
    models: { bedrock: config.bedrockModelId, groq: config.groqModel },
  });

  app.get('/health', async () => ({ status: 'ok', service: 'api' }));

  app.get('/ready', async (_request, reply) => {
    const readiness = await checkReadiness('api', database, config.storageDir);
    reply.code(readiness.ok ? 200 : 503);
    return readiness;
  });

  return {
    app,
    config,
    database,
    boss,
    async close() {
      await app.close();
      await boss.stop({ graceful: true, timeout: 5000 });
      await closeDatabase(database);
    },
  };
}
