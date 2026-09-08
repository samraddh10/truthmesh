import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface DotEnvResult {
  readonly loaded: boolean;
  readonly path: string;
  readonly reason: string | null;
}

export function loadDotEnvFile(path = '.env'): DotEnvResult {
  const absolute = resolve(path);

  if (!existsSync(absolute)) {
    return { loaded: false, path: absolute, reason: 'no .env file present' };
  }

  const before = new Set(Object.keys(process.env));

  try {
    process.loadEnvFile(absolute);
  } catch (error) {
    return { loaded: false, path: absolute, reason: (error as Error).message };
  }

  for (const key of before) {
    const original = originalValues.get(key);
    if (original !== undefined) process.env[key] = original;
  }

  return { loaded: true, path: absolute, reason: null };
}

const originalValues = new Map<string, string>(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);
