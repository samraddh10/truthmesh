import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { Database } from '@superjoin/db';
import { claimEvidence, claims } from '@superjoin/db';

import type { ExtractedClaim } from './contract.ts';
import { decideClaimStatus, type EvidenceVerdict, type VerifiedEvidence } from './verify.ts';

export function assertionFingerprint(claim: ExtractedClaim): string {
  const normalize = (value: string | null): string =>
    (value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

  const qualifiers = [...claim.qualifiers]
    .map((entry) => `${normalize(entry.name)}=${normalize(entry.value)}`)
    .sort()
    .join('|');

  const parts = [
    normalize(claim.subject),
    claim.predicate,
    normalize(claim.numeric_value ?? claim.raw_value),
    normalize(claim.currency),
    normalize(claim.scale),
    normalize(claim.unit),
    normalize(claim.period_label),
    claim.period_type ?? '',
    normalize(claim.scope),
    claim.assertion_status ?? '',
    qualifiers,
  ];

  return createHash('sha256').update(parts.join(' ')).digest('hex');
}

export interface PersistClaimOptions {
  readonly documentId: string;
  readonly runId: string;
}

export interface PersistedClaim {
  readonly claimId: string;
  readonly inserted: boolean;
  readonly status: 'accepted' | 'needs_review' | 'rejected';
  readonly evidenceWritten: number;
}

export async function persistClaim(
  db: Database,
  claim: ExtractedClaim,
  evidence: readonly VerifiedEvidence[],
  options: PersistClaimOptions,
): Promise<PersistedClaim> {
  const fingerprint = assertionFingerprint(claim);

  const inserted = await db
    .insert(claims)
    .values({
      documentId: options.documentId,
      runId: options.runId,
      subject: claim.subject,
      predicate: claim.predicate,
      originalStatement: claim.original_statement,
      rawValue: claim.raw_value,
      numericValue: claim.numeric_value,
      currency: claim.currency,
      scale: claim.scale,
      unit: claim.unit,
      periodLabel: claim.period_label,
      periodType: claim.period_type,
      scope: claim.scope,
      assertionStatus: claim.assertion_status,
      qualifiers: claim.qualifiers,
      status: 'needs_review',
      assertionFingerprint: fingerprint,
    })
    .onConflictDoNothing()
    .returning({ id: claims.id });

  const existingId = inserted[0]?.id ?? (await findClaimId(db, options.documentId, fingerprint));

  if (existingId === null) {
    throw new Error(`claim could not be stored for document ${options.documentId}`);
  }

  let evidenceWritten = 0;
  for (const row of evidence) {
    if (row.sourceBlockId === null) continue;

    const written = await db
      .insert(claimEvidence)
      .values({
        claimId: existingId,
        sourceBlockId: row.sourceBlockId,
        quote: row.quote,
        quoteStart: row.quoteStart,
        quoteEnd: row.quoteEnd,
        verification: row.verification,
        entailment: row.entailment,
        verificationNote: row.verificationNote,
        supportRole: row.supportRole,
      })
      .onConflictDoNothing()
      .returning({ id: claimEvidence.id });

    evidenceWritten += written.length;
  }

  const status = await settleClaimStatus(db, existingId, claim, evidence);

  return {
    claimId: existingId,
    inserted: inserted.length > 0,
    status,
    evidenceWritten,
  };
}

async function findClaimId(
  db: Database,
  documentId: string,
  fingerprint: string,
): Promise<string | null> {
  const [row] = await db
    .select({ id: claims.id })
    .from(claims)
    .where(and(eq(claims.documentId, documentId), eq(claims.assertionFingerprint, fingerprint)))
    .limit(1);

  return row?.id ?? null;
}

async function settleClaimStatus(
  db: Database,
  claimId: string,
  claim: ExtractedClaim,
  attempted: readonly VerifiedEvidence[],
): Promise<'accepted' | 'needs_review' | 'rejected'> {
  const stored = await db
    .select({
      verification: claimEvidence.verification,
      entailment: claimEvidence.entailment,
    })
    .from(claimEvidence)
    .where(eq(claimEvidence.claimId, claimId));

  const unresolved: EvidenceVerdict[] = attempted
    .filter((row) => row.sourceBlockId === null)
    .map((row) => ({ verification: row.verification, entailment: row.entailment }));

  const { status, statusReason } = decideClaimStatus(
    [...stored, ...unresolved],
    claim.raw_value ?? claim.numeric_value ?? 'the reported value',
  );

  await db.update(claims).set({ status, statusReason }).where(eq(claims.id, claimId));

  return status;
}
