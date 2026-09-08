import { MODEL_PROVIDERS, appSettings, type ModelProvider } from '@superjoin/db';
import type { IngestionContext } from '@superjoin/pipeline';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export interface SettingsRouteDependencies {
  readonly ingestion: IngestionContext;
  readonly models: Partial<Record<ModelProvider, string>>;
}

function isProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export async function registerSettingsRoutes(
  app: FastifyInstance,
  deps: SettingsRouteDependencies,
): Promise<void> {
  const { db } = deps.ingestion.database;

  async function readSettings(): Promise<{
    active: ModelProvider;
    available: readonly ModelProvider[];
  }> {
    const [row] = await db.select().from(appSettings).limit(1);

    if (row === undefined) {
      await db.insert(appSettings).values({}).onConflictDoNothing();
      return { active: 'bedrock', available: [] };
    }

    return {
      active: row.activeProvider as ModelProvider,
      available: (row.availableProviders ?? []).filter(isProvider),
    };
  }

  function render(active: ModelProvider, available: readonly ModelProvider[]) {
    return {
      activeProvider: active,
      providers: MODEL_PROVIDERS.map((id) => ({
        id,
        configured: available.includes(id),
        model: deps.models[id] ?? null,
      })),
    };
  }

  app.get('/settings', async () => {
    const { active, available } = await readSettings();
    return render(active, available);
  });

  app.patch('/settings', async (request, reply) => {
    const body = request.body as { provider?: unknown };

    if (!isProvider(body.provider)) {
      reply.code(400);
      return {
        error: 'invalid_provider',
        message: `provider must be one of ${MODEL_PROVIDERS.join(', ')}`,
      };
    }

    const { available } = await readSettings();

    if (!available.includes(body.provider)) {
      reply.code(409);
      return {
        error: 'provider_not_configured',
        message: `${body.provider} has no credentials configured on this deployment`,
      };
    }

    const [existing] = await db.select({ id: appSettings.id }).from(appSettings).limit(1);

    if (existing === undefined) {
      await db.insert(appSettings).values({ activeProvider: body.provider });
    } else {
      await db
        .update(appSettings)
        .set({ activeProvider: body.provider, updatedAt: new Date() })
        .where(eq(appSettings.id, existing.id));
    }

    return render(body.provider, available);
  });
}
