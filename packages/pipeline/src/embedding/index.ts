export const EMBEDDING_TASK_TYPE = 'SEMANTIC_SIMILARITY';

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly taskType: string;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class EmbeddingUnavailableError extends Error {
  override readonly name = 'EmbeddingUnavailableError';

  constructor(
    message: string,
    readonly cause_: unknown,
  ) {
    super(message);
  }
}

export interface LocalEmbeddingOptions {
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize?: number;
}

type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly taskType = EMBEDDING_TASK_TYPE;

  private extractor: FeatureExtractor | null = null;
  private loading: Promise<FeatureExtractor> | null = null;

  constructor(private readonly options: LocalEmbeddingOptions) {}

  get model(): string {
    return this.options.model;
  }

  get dimensions(): number {
    return this.options.dimensions;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await this.load();
    const batchSize = this.options.batchSize ?? 16;
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += batchSize) {
      const batch = texts.slice(start, start + batchSize).map(truncate);
      const output = await extractor(batch, { pooling: 'mean', normalize: true });

      for (const vector of output.tolist()) {
        if (vector.length !== this.options.dimensions) {
          throw new EmbeddingUnavailableError(
            `${this.options.model} returned ${vector.length} dimensions, but EMBEDDING_DIMENSIONS is ${this.options.dimensions}`,
            null,
          );
        }
        vectors.push(vector);
      }
    }

    return vectors;
  }

  private async load(): Promise<FeatureExtractor> {
    if (this.extractor !== null) return this.extractor;
    if (this.loading !== null) return this.loading;

    this.loading = (async () => {
      try {
        const transformers = await import('@huggingface/transformers');
        const extractor = (await transformers.pipeline(
          'feature-extraction',
          this.options.model,
        )) as unknown as FeatureExtractor;

        this.extractor = extractor;
        return extractor;
      } catch (error) {
        this.loading = null;
        throw new EmbeddingUnavailableError(
          `the embedding model ${this.options.model} could not be loaded: ${(error as Error).message}`,
          error,
        );
      }
    })();

    return this.loading;
  }
}

export interface EmbeddingConfig {
  readonly embeddingModel: string;
  readonly embeddingDimensions: number;
}

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  return new LocalEmbeddingProvider({
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
  });
}

export interface ClaimDescription {
  readonly subject: string;
  readonly predicate: string;
  readonly scope?: string | null;
  readonly periodLabel?: string | null;
  readonly unit?: string | null;
  readonly qualifiers?: readonly { readonly name: string; readonly value: string }[];
}

export function describeClaim(claim: ClaimDescription): string {
  const parts = [claim.subject, claim.predicate.replace(/_/g, ' ')];

  if (claim.scope !== null && claim.scope !== undefined && claim.scope !== '') {
    parts.push(claim.scope);
  }
  if (claim.periodLabel !== null && claim.periodLabel !== undefined && claim.periodLabel !== '') {
    parts.push(claim.periodLabel);
  }
  if (claim.unit !== null && claim.unit !== undefined && claim.unit !== '') {
    parts.push(`measured in ${claim.unit}`);
  }
  for (const qualifier of claim.qualifiers ?? []) {
    parts.push(`${qualifier.name} ${qualifier.value}`);
  }

  return parts.join(', ');
}

function truncate(text: string): string {
  return text.length > 1200 ? text.slice(0, 1200) : text;
}
