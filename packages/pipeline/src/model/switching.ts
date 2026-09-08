import { appSettings, type Database, type ModelProvider } from '@superjoin/db';

import { ModelError, type CompletionRequest, type CompletionResult } from './types.ts';

const CACHE_TTL_MS = 3_000;

export interface ProviderEntry {
  readonly model: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export interface SwitchingClientOptions {
  readonly db: Database;
  readonly providers: Partial<Record<ModelProvider, ProviderEntry>>;
  readonly fallback: ModelProvider;
}

export class SwitchingClient {
  private cachedProvider: ModelProvider | undefined;
  private cachedAt = 0;

  constructor(private readonly options: SwitchingClientOptions) {}

  get model(): string {
    const active = this.cachedProvider ?? this.options.fallback;
    return this.options.providers[active]?.model ?? `${active} (not configured)`;
  }

  async activeProvider(): Promise<ModelProvider> {
    const now = Date.now();
    if (this.cachedProvider !== undefined && now - this.cachedAt < CACHE_TTL_MS) {
      return this.cachedProvider;
    }

    let selected: ModelProvider = this.options.fallback;
    try {
      const [row] = await this.options.db.select().from(appSettings).limit(1);
      if (row !== undefined) selected = row.activeProvider as ModelProvider;
    } catch {
    }

    if (this.options.providers[selected] === undefined) selected = this.options.fallback;

    this.cachedProvider = selected;
    this.cachedAt = now;
    return selected;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const provider = await this.activeProvider();
    const client = this.options.providers[provider];

    if (client === undefined) {
      throw new ModelError(
        `no credentials configured for ${provider}; set them in .env and restart the worker`,
        'provider_not_configured',
        false,
      );
    }

    return client.complete(request);
  }
}
