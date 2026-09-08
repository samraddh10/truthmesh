import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, requireModelAccess } from './load.ts';

describe('loadConfig', () => {
  it('loads without a provider, so a service that never calls the model can start', () => {
    const config = loadConfig({});
    expect(config.awsRegion).toBeUndefined();
    expect(config.groqApiKey).toBeUndefined();
  });

  it('reads a region that is present', () => {
    expect(loadConfig({ AWS_REGION: 'us-east-1' }).awsRegion).toBe('us-east-1');
  });

  it('accepts a region alone, with credentials left to the SDK chain', () => {
    const config = loadConfig({ AWS_REGION: 'ap-south-1' });
    expect(config.awsRegion).toBe('ap-south-1');
    expect(config.awsAccessKeyId).toBeUndefined();
    expect(config.awsSecretAccessKey).toBeUndefined();
  });

  it('treats a blank credential as absent rather than as one the SDK should use', () => {
    const config = loadConfig({ AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: '   ' });
    expect(config.awsAccessKeyId).toBeUndefined();
  });

  it('reads a blank region as an absent provider rather than refusing to parse', () => {
    expect(loadConfig({ AWS_REGION: '' }).awsRegion).toBeUndefined();
    expect(loadConfig({ AWS_REGION: '   ' }).awsRegion).toBeUndefined();
  });

  it('carries explicit credentials through when they are given', () => {
    const config = loadConfig({
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_SESSION_TOKEN: 'token',
    });
    expect(config.awsAccessKeyId).toBe('AKIAEXAMPLE');
    expect(config.awsSecretAccessKey).toBe('secret');
    expect(config.awsSessionToken).toBe('token');
  });

  it('applies every default named in plan section 1.3', () => {
    const config = loadConfig({});
    expect(config.bedrockModelId).toBe('moonshotai.kimi-k2.5');
    expect(config.embeddingModel).toBe('Xenova/all-mpnet-base-v2');
    expect(config.embeddingDimensions).toBe(768);
    expect(config.maxUploadMb).toBe(50);
    expect(config.maxPdfPages).toBe(300);
    expect(config.llmConcurrency).toBe(2);
    expect(config.candidateTopK).toBe(15);
    expect(config.storageDir).toBe('./storage');
    expect(config.port).toBe(3000);
    expect(config.databaseUrl).toMatch(/^postgres:\/\//);
  });

  it('supplies the budgets the plan names but leaves unvalued', () => {
    const config = loadConfig({});
    expect(config.documentTokenBudget).toBeGreaterThan(0);
    expect(config.llmTimeoutMs).toBeGreaterThan(0);
    expect(config.providerMaxRetries).toBeGreaterThanOrEqual(0);
  });

  it('reads overrides as numbers, not strings', () => {
    const config = loadConfig({ MAX_UPLOAD_MB: '10', CANDIDATE_TOP_K: '25' });
    expect(config.maxUploadMb).toBe(10);
    expect(config.candidateTopK).toBe(25);
  });

  it('rejects a port that is not a valid TCP port', () => {
    for (const port of ['0', '70000', 'abc', '3000.5']) {
      expect(() => loadConfig({ PORT: port }), `expected ${port} to be rejected`).toThrow(ConfigError);
    }
  });

  it('rejects an embedding width that could not match the vector column', () => {
    expect(() => loadConfig({ EMBEDDING_DIMENSIONS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ EMBEDDING_DIMENSIONS: 'wide' })).toThrow(ConfigError);
  });


  it('names the offending variable when the environment is invalid', () => {
    expect(() => loadConfig({ MAX_PDF_PAGES: '-1' })).toThrow(/MAX_PDF_PAGES/);
  });
});

describe('requireModelAccess', () => {
  it('refuses to start when neither provider is configured', () => {
    expect(() => requireModelAccess(loadConfig({}))).toThrow(ConfigError);
    expect(() => requireModelAccess(loadConfig({ AWS_REGION: '  ' }))).toThrow(
      /no model provider is configured/,
    );
  });

  it('accepts either provider on its own', () => {
    expect(() => requireModelAccess(loadConfig({ AWS_REGION: 'us-east-1' }))).not.toThrow();
    expect(() => requireModelAccess(loadConfig({ GROQ_API_KEY: 'gsk-test' }))).not.toThrow();
  });
});
