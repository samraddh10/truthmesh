import { readFile } from 'node:fs/promises';

import {
  CHECKS_VERSION,
  COMPARISON_METHOD_VERSION,
  ENTITY_MATCH_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  NORMALIZATION_VERSION,
  PARSER_VERSION,
  RELATIONSHIP_PROMPT_VERSION,
  TRANSCRIPTION_PROMPT_VERSION,
} from '@superjoin/pipeline';
import { describe, expect, it } from 'vitest';

const freeze = JSON.parse(await readFile('evaluation/freeze.json', 'utf8')) as {
  versions: Record<string, string>;
  model: { llm: string; embedding: string; embedding_dimensions: number };
};

const live: Record<string, string> = {
  PARSER_VERSION,
  TRANSCRIPTION_PROMPT_VERSION,
  EXTRACTION_PROMPT_VERSION,
  NORMALIZATION_VERSION,
  ENTITY_MATCH_PROMPT_VERSION,
  CHECKS_VERSION,
  RELATIONSHIP_PROMPT_VERSION,
  COMPARISON_METHOD_VERSION,
};

describe('the generalization freeze', () => {
  it('covers every version the pipeline records', () => {
    expect(Object.keys(freeze.versions).sort()).toEqual(Object.keys(live).sort());
  });

  it.each(Object.keys(live))('%s matches the frozen value', (name) => {
    expect(live[name]).toBe(freeze.versions[name]);
  });

  it('keeps the composed comparison version consistent with its parts', () => {
    expect(COMPARISON_METHOD_VERSION).toBe(`${CHECKS_VERSION}+${RELATIONSHIP_PROMPT_VERSION}`);
  });

  it('records the models the baseline was measured under', () => {
    expect(freeze.model.llm).toMatch(/:free$/);
    expect(freeze.model.embedding_dimensions).toBe(768);
  });
});
