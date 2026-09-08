import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, loadDotEnvFile } from '@superjoin/config';
import { closeDatabase, createDatabase } from '@superjoin/db';

import { goldDocumentResolver, loadGoldset } from './goldset.ts';
import { loadCollection, loadStructure, resolveCollection } from './load.ts';
import {
  measureCandidateRecall,
  measureCoverage,
  measureEvidence,
  measureGrounding,
  measureRelationships,
} from './metrics.ts';
import { renderReport } from './report.ts';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

const target = process.argv[2];
if (target === undefined || target.startsWith('--')) {
  console.error('usage: npm run evaluate -- <collection name or id> [--out <path>] [--goldset <path>]');
  process.exit(2);
}

loadDotEnvFile();
const config = loadConfig();

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const goldsetPath = resolve(argument('goldset', join(repoRoot, 'evaluation/goldset.json')));
const outPath = resolve(argument('out', join(repoRoot, 'evaluation/results/latest.md')));

const goldset =
  argument('goldset', '') === 'none' ? null : await loadGoldset(goldsetPath);
const handle = createDatabase(config.databaseUrl);

try {
  const { id, name } = await resolveCollection(handle.db, target);
  const loaded = await loadCollection(handle.db, id, name);
  const goldDocumentOf =
    goldset === null ? () => undefined : goldDocumentResolver(goldset, loaded.filenameOf);

  const structure = await loadStructure(handle.db, id);
  const empty = { version: '', created: '', collection: '', method: '', conventions: {}, documents: [], claims: [], pairs: [] };
  const scored = goldset ?? empty;

  const coverage = measureCoverage(scored, loaded.claims, goldDocumentOf);
  const grounding = measureGrounding(scored, loaded.claims, goldDocumentOf);
  const evidence = measureEvidence(loaded.claims);
  const candidates = measureCandidateRecall(
    scored,
    loaded.claims,
    loaded.candidates,
    goldDocumentOf,
  );
  const relationships = measureRelationships(
    scored,
    loaded.claims,
    loaded.relationships,
    goldDocumentOf,
  );

  const report = renderReport({
    goldset,
    collectionName: name,
    collectionId: id,
    generatedAt: new Date(),
    coverage,
    grounding,
    evidence,
    candidates,
    relationships,
    cost: loaded.cost,
    structure,
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, report, 'utf8');

  console.log(report);
  console.log(`written to ${outPath}`);
} finally {
  await closeDatabase(handle);
}
