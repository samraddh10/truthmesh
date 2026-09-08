import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claimEvidence, processingRuns, relationships, sourceBlocks } from '@superjoin/db';

import type { EmbeddingProvider } from '../embedding/index.ts';
import { ModelError, type CompletionProvider } from '../model/index.ts';
import { ProcessingError, type ProcessingContext, type StageHandler } from '../processor.ts';
import { recordIssue, recordProgress } from '../run-state.ts';
import { findCandidates, type CandidatePair } from './candidates.ts';
import {
  CHECKS_VERSION,
  deterministicLabel,
  isPlainCorroboration,
  runDeterministicChecks,
  type DeterministicChecks,
} from './checks.ts';
import {
  RELATIONSHIP_PROMPT_VERSION,
  classifyPair,
  type EvidenceHandle,
  type RelationshipLabel,
} from './classify.ts';

export const COMPARISON_METHOD_VERSION = `${CHECKS_VERSION}+${RELATIONSHIP_PROMPT_VERSION}`;

export interface ComparisonStageOptions {
  readonly client: CompletionProvider;
  readonly embeddings?: EmbeddingProvider;
  readonly topK?: number;
  readonly tokenBudget?: number;
  readonly fastPathCorroborations?: boolean;
  readonly cooldownMs?: number;
  readonly cooldownAttempts?: number;
}

const DEFAULTS = {
  topK: 15,
  tokenBudget: 400_000,
} as const;

const COOLDOWN_MS = 45_000;
const COOLDOWN_ATTEMPTS = 2;



export interface ComparisonSummary {
  readonly pairsConsidered: number;
  readonly exactPairs: number;
  readonly semanticPairs: number;
  readonly classifiedByModel: number;
  readonly classifiedDeterministically: number;
  readonly resumedFromStore: number;
  readonly relationshipsWritten: number;
  readonly byLabel: Readonly<Record<string, number>>;
  readonly semanticRetrievalAvailable: boolean;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

async function loadEvidenceHandles(
  db: Database,
  claimIds: readonly string[],
): Promise<Map<string, EvidenceHandle[]>> {
  if (claimIds.length === 0) return new Map();

  const rows = await db
    .select({
      id: claimEvidence.id,
      claimId: claimEvidence.claimId,
      quote: claimEvidence.quote,
      verification: claimEvidence.verification,
      physicalPage: sourceBlocks.physicalPage,
      context: sourceBlocks.content,
    })
    .from(claimEvidence)
    .innerJoin(sourceBlocks, eq(sourceBlocks.id, claimEvidence.sourceBlockId))
    .where(inArray(claimEvidence.claimId, [...claimIds]));

  const byClaim = new Map<string, EvidenceHandle[]>();

  for (const row of rows) {
    const existing = byClaim.get(row.claimId) ?? [];
    existing.push({
      handle: '',
      evidenceId: row.id,
      claimId: row.claimId,
      physicalPage: row.physicalPage,
      quote: row.quote,
      context: row.context,
      verification: row.verification,
    });
    byClaim.set(row.claimId, existing);
  }

  return byClaim;
}

async function loadClassifiedPairs(
  db: Database,
  pairs: readonly CandidatePair[],
): Promise<Map<string, RelationshipLabel>> {
  if (pairs.length === 0) return new Map();

  const rows = await db
    .select({
      claimAId: relationships.claimAId,
      claimBId: relationships.claimBId,
      label: relationships.label,
    })
    .from(relationships)
    .where(
      and(
        eq(relationships.methodVersion, COMPARISON_METHOD_VERSION),
        eq(relationships.method, 'model'),
        inArray(
          relationships.claimAId,
          pairs.map((pair) => pair.a.id),
        ),
        inArray(
          relationships.claimBId,
          pairs.map((pair) => pair.b.id),
        ),
      ),
    );

  return new Map(rows.map((row) => [`${row.claimAId}:${row.claimBId}`, row.label]));
}

function handlesForPair(
  pair: CandidatePair,
  byClaim: ReadonlyMap<string, EvidenceHandle[]>,
): EvidenceHandle[] {
  const ordered = [...(byClaim.get(pair.a.id) ?? []), ...(byClaim.get(pair.b.id) ?? [])];
  return ordered.slice(0, 8).map((handle, index) => ({ ...handle, handle: `E${index + 1}` }));
}

interface Verdict {
  readonly label: RelationshipLabel;
  readonly rationale: string;
  readonly supportingEvidenceIds: readonly string[];
  readonly differingContext: readonly string[];
  readonly uncertaintyReasons: readonly string[];
  readonly method: 'deterministic' | 'model';
  readonly modelName: string | null;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

function fromChecks(
  checks: DeterministicChecks,
  extraUncertainty: readonly string[],
  supportingEvidenceIds: readonly string[] = [],
): Verdict {
  const decided = deterministicLabel(checks);

  return {
    label: decided.label,
    rationale: decided.rationale,
    supportingEvidenceIds: decided.label === 'corroborates' ? supportingEvidenceIds : [],
    differingContext: checks.contextDifferences.map((difference) => difference.dimension),
    uncertaintyReasons: [...decided.uncertaintyReasons, ...extraUncertainty],
    method: 'deterministic',
    modelName: null,
    promptTokens: 0,
    completionTokens: 0,
  };
}

export function promiseOf(checks: DeterministicChecks): number {
  if (!checks.worthComparing) return -1;

  let score = 0;

  if (!checks.sameDocument) score += 8;

  if (checks.entityMatch === 'same') score += 6;
  if (checks.predicate.relation === 'same') score += 5;
  else if (checks.predicate.relation === 'modifier_variant') score += 2;

  if (checks.bothAccepted) score += 4;

  if (checks.value !== null) {
    score += 3;
    if (checks.value.agreement === 'agree' || checks.value.agreement === 'disagree') score += 3;
  }

  if (checks.sharedSourceBlocks.length > 0) score -= 5;

  if (checks.scaleRatio !== null) score += 2;

  return score;
}

export async function compareDocument(
  context: ProcessingContext,
  options: ComparisonStageOptions,
): Promise<ComparisonSummary> {
  const { db } = context.database;
  const tokenBudget = options.tokenBudget ?? DEFAULTS.tokenBudget;
  const fastPath = options.fastPathCorroborations ?? true;

  const candidates = await findCandidates(db, {
    collectionId: context.job.collectionId,
    documentId: context.job.documentId,
    topK: options.topK ?? DEFAULTS.topK,
    ...(options.embeddings !== undefined ? { provider: options.embeddings } : {}),
  });

  if (candidates.embedding.reason !== null) {
    await recordIssue(db, context.job.runId, {
      stage: 'comparing',
      failureKind: 'semantic_retrieval_unavailable',
      failureClass: 'transient',
      message: `candidate retrieval used exact matching only: ${candidates.embedding.reason}`,
    });
  }

  const byLabel: Record<string, number> = {};
  let classifiedByModel = 0;
  let classifiedDeterministically = 0;
  let resumedFromStore = 0;
  let written = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  const cooldownMs = options.cooldownMs ?? COOLDOWN_MS;
  let cooldownsLeft = options.cooldownAttempts ?? COOLDOWN_ATTEMPTS;
  let considered = 0;

  if (candidates.pairs.length === 0) {
    return {
      pairsConsidered: 0,
      exactPairs: 0,
      semanticPairs: 0,
      classifiedByModel: 0,
      classifiedDeterministically: 0,
      resumedFromStore: 0,
      relationshipsWritten: 0,
      byLabel,
      semanticRetrievalAvailable: candidates.embedding.available,
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  if (options.embeddings !== undefined && candidates.embedding.available) {
    await db
      .update(processingRuns)
      .set({ embeddingModel: options.embeddings.model })
      .where(eq(processingRuns.id, context.job.runId));
  }

  const evidenceByClaim = await loadEvidenceHandles(
    db,
    [...new Set(candidates.pairs.flatMap((pair) => [pair.a.id, pair.b.id]))],
  );

  const alreadyClassified = await loadClassifiedPairs(db, candidates.pairs);

  const [before] = await db
    .select({ input: processingRuns.inputTokens, output: processingRuns.outputTokens })
    .from(processingRuns)
    .where(eq(processingRuns.id, context.job.runId))
    .limit(1);

  const scored = candidates.pairs
    .map((pair) => {
      const checks = runDeterministicChecks(pair.a, pair.b);
      return { pair, checks, promise: promiseOf(checks) };
    })
    .sort((a, b) => b.promise - a.promise);

  for (const { pair, checks } of scored) {
    considered += 1;
    let verdict: Verdict;

    const settled = alreadyClassified.get(`${pair.a.id}:${pair.b.id}`);

    if (settled !== undefined) {
      resumedFromStore += 1;
      byLabel[settled] = (byLabel[settled] ?? 0) + 1;
      continue;
    }

    if (!checks.worthComparing) {
      verdict = fromChecks(checks, []);
    } else if (fastPath && isPlainCorroboration(checks)) {
      verdict = fromChecks(
        checks,
        [],
        handlesForPair(pair, evidenceByClaim).map((handle) => handle.evidenceId),
      );
    } else if (promptTokens + completionTokens >= tokenBudget) {
      verdict = fromChecks(checks, ['the classification budget for this document was exhausted']);
    } else {
      for (;;) {
        try {
          const classified = await classifyPair(
            pair.a,
            pair.b,
            checks,
            handlesForPair(pair, evidenceByClaim),
            { client: options.client },
          );

          verdict = {
            label: classified.label,
            rationale: classified.rationale,
            supportingEvidenceIds: classified.supportingEvidenceIds,
            differingContext: classified.differingContext,
            uncertaintyReasons: classified.uncertaintyReasons,
            method: 'model',
            modelName: classified.servedByModel,
            promptTokens: classified.promptTokens,
            completionTokens: classified.completionTokens,
          };

          promptTokens += classified.promptTokens;
          completionTokens += classified.completionTokens;
          break;
        } catch (error) {
          const modelError = error instanceof ModelError ? error : null;
          const retryable = modelError?.retryable ?? true;

          await recordIssue(db, context.job.runId, {
            stage: 'comparing',
            failureKind: modelError?.kind ?? 'classification_failed',
            failureClass: retryable ? 'transient' : 'permanent',
            message: `pair ${pair.a.id} / ${pair.b.id}: ${(error as Error).message.slice(0, 300)}`,
          });

          if (modelError?.kind === 'provider_rate_limited' && cooldownsLeft > 0) {
            cooldownsLeft -= 1;
            await recordIssue(db, context.job.runId, {
              stage: 'comparing',
              failureKind: 'classification_cooldown',
              failureClass: 'transient',
              message: `throttled on pair ${pair.a.id} / ${pair.b.id}; pausing ${Math.round(cooldownMs / 1000)}s before asking again rather than failing with ${scored.length - considered} pairs still to compare`,
            });
            await new Promise((resolve) => setTimeout(resolve, cooldownMs));
            continue;
          }

          throw new ProcessingError(
            `classifier unavailable for pair ${pair.a.id} / ${pair.b.id}: ${(error as Error).message}`,
            modelError?.kind ?? 'classification_failed',
            retryable ? 'transient' : 'permanent',
            'comparing',
          );
        }
      }
    }

    if (verdict.method === 'model') classifiedByModel += 1;
    else classifiedDeterministically += 1;

    const inserted = await writeRelationship(db, context.job.collectionId, pair, checks, verdict);
    if (inserted) written += 1;

    byLabel[verdict.label] = (byLabel[verdict.label] ?? 0) + 1;
  }

  await db
    .update(processingRuns)
    .set({
      inputTokens: (before?.input ?? 0) + promptTokens,
      outputTokens: (before?.output ?? 0) + completionTokens,
    })
    .where(eq(processingRuns.id, context.job.runId));

  await recordProgress(db, context.job.runId, {
    relationshipsCreated: candidates.pairs.length,
  });

  return {
    pairsConsidered: candidates.pairs.length,
    exactPairs: candidates.exactPairs,
    semanticPairs: candidates.semanticPairs,
    classifiedByModel,
    classifiedDeterministically,
    resumedFromStore,
    relationshipsWritten: written,
    byLabel,
    semanticRetrievalAvailable: candidates.embedding.available,
    promptTokens,
    completionTokens,
  };
}

async function writeRelationship(
  db: Database,
  collectionId: string,
  pair: CandidatePair,
  checks: DeterministicChecks,
  verdict: Verdict,
): Promise<boolean> {
  const values = {
    collectionId,
    claimAId: pair.a.id,
    claimBId: pair.b.id,
    label: verdict.label,
    rationale: verdict.rationale,
    contextDifferences: verdict.differingContext,
    uncertaintyReasons: verdict.uncertaintyReasons,
    deterministicChecks: {
      ...checks,
      retrievedBy: pair.sources,
      semanticDistance: pair.distance,
    },
    supportingEvidenceIds: verdict.supportingEvidenceIds,
    method: verdict.method,
    methodVersion: COMPARISON_METHOD_VERSION,
    modelName: verdict.modelName,
    promptVersion: verdict.method === 'model' ? RELATIONSHIP_PROMPT_VERSION : null,
  };

  const inserted = await db
    .insert(relationships)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: relationships.id });

  if (inserted.length > 0) return true;

  if (verdict.method === 'model') {
    await db
      .update(relationships)
      .set(values)
      .where(
        and(
          eq(relationships.claimAId, pair.a.id),
          eq(relationships.claimBId, pair.b.id),
          eq(relationships.methodVersion, COMPARISON_METHOD_VERSION),
          eq(relationships.method, 'deterministic'),
        ),
      );
  }

  return false;
}

export function createComparisonStage(options: ComparisonStageOptions): StageHandler {
  return {
    stage: 'comparing',
    async run(context) {
      await compareDocument(context, options);
    },
  };
}
