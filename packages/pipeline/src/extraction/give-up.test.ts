import { describe, expect, it } from 'vitest';

import { ModelError } from '../model/index.ts';
import { classifyFailure } from './stage.ts';

describe('classifyFailure', () => {
  it('counts a rate limit as throttling, where further calls only burn quota', () => {
    const error = new ModelError('429 Too Many Requests', 'provider_rate_limited', true, 30, 429);
    expect(classifyFailure(error)).toBe('throttled');
  });

  it('counts an unreadable reply separately, because the next chunk may still succeed', () => {
    const error = new ModelError(
      'extraction did not match the schema after one repair: claims: Invalid input: expected array, received null',
      'schema_violation_after_repair',
      false,
    );
    expect(classifyFailure(error)).toBe('malformed');
  });

  it('counts a first-pass schema violation as malformed too', () => {
    const error = new ModelError('extraction did not match the schema', 'schema_violation', true);
    expect(classifyFailure(error)).toBe('malformed');
  });

  it('treats anything else as an ordinary failure, which keeps the stricter ceiling', () => {
    expect(classifyFailure(new ModelError('502 Bad Gateway', 'http_502', true, undefined, 502))).toBe(
      'other',
    );
    expect(classifyFailure(new Error('socket hang up'))).toBe('other');
    expect(classifyFailure('not an error at all')).toBe('other');
  });

  it('does not let a run of schema flakes reach the throttle ceiling', () => {
    const flakes = Array.from(
      { length: 4 },
      () =>
        new ModelError(
          'extraction did not match the schema after one repair: claims: Invalid input: expected array, received null',
          'schema_violation_after_repair',
          false,
        ),
    );

    const strictRun = flakes.filter((error) => classifyFailure(error) !== 'malformed').length;

    expect(strictRun).toBe(0);
  });

  it('counts a mixed run of failures somewhere, so alternating kinds still terminate', () => {
    const mixed = [
      new ModelError('429', 'provider_rate_limited', true, 51, 429),
      new ModelError('bad json', 'schema_violation_after_repair', false),
      new ModelError('429', 'provider_rate_limited', true, 51, 429),
      new ModelError('bad json', 'schema_violation_after_repair', false),
    ];

    const backstopRun = mixed.filter((error) => classifyFailure(error) !== undefined).length;
    expect(backstopRun).toBe(mixed.length);

    const strictRun = mixed.filter((error) => classifyFailure(error) !== 'malformed').length;
    expect(strictRun).toBe(2);
  });
});
