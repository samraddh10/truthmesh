import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

export class StorageError extends Error {
  override readonly name = 'StorageError';
}

export function contentHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function documentStorageKey(hash: string, extension = '.pdf'): string {
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new StorageError(`expected a hex SHA-256 digest, got ${JSON.stringify(hash)}`);
  }
  return `documents/${hash.slice(0, 2)}/${hash}${extension}`;
}

export function pageImageStorageKey(hash: string, physicalPage: number, extension = '.png'): string {
  if (!Number.isInteger(physicalPage) || physicalPage < 0) {
    throw new StorageError(`physicalPage must be a non-negative integer, got ${physicalPage}`);
  }
  return `pages/${hash.slice(0, 2)}/${hash}/${String(physicalPage).padStart(4, '0')}${extension}`;
}

export function resolvePath(root: string, key: string): string {
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, key);
  const rel = relative(absoluteRoot, target);

  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    throw new StorageError(`storage key escapes the storage root: ${JSON.stringify(key)}`);
  }
  return target;
}

export async function ensureStorage(root: string): Promise<void> {
  await mkdir(resolve(root), { recursive: true });
}

export async function writeObject(root: string, key: string, bytes: Uint8Array): Promise<string> {
  const target = resolvePath(root, key);
  await mkdir(dirname(target), { recursive: true });

  const temporary = `${target}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw new StorageError(`could not write ${key}: ${(cause as Error).message}`, { cause });
  }
  return target;
}

export async function readObject(root: string, key: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(resolvePath(root, key)));
  } catch (cause) {
    if (cause instanceof StorageError) throw cause;
    throw new StorageError(`could not read ${key}: ${(cause as Error).message}`, { cause });
  }
}

export async function objectExists(root: string, key: string): Promise<boolean> {
  try {
    const info = await stat(resolvePath(root, key));
    return info.isFile();
  } catch {
    return false;
  }
}

export interface StorageHealth {
  readonly root: string;
  readonly writable: boolean;
  readonly detail: string | null;
}

export async function checkStorageHealth(root: string): Promise<StorageHealth> {
  const absoluteRoot = resolve(root);
  const probe = join(absoluteRoot, `.health-${process.pid}`);

  try {
    await mkdir(absoluteRoot, { recursive: true });
    await writeFile(probe, 'ok');
    await rm(probe, { force: true });
    return { root: absoluteRoot, writable: true, detail: null };
  } catch (cause) {
    return { root: absoluteRoot, writable: false, detail: (cause as Error).message };
  }
}
