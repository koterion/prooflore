import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { assertNoSecrets, objectValue, stringValue } from './validation.js';

const IDENTITY_SCHEMA_VERSION = 1 as const;
const IDENTITY_PATH = '.prooflore/local/identity.json';
const MAX_IDENTITY_BYTES = 4 * 1024;

export type ProjectMemoryLocalIdentity = {
  schemaVersion: typeof IDENTITY_SCHEMA_VERSION;
  developerId: string;
  updatedAt: string;
};

export type ProjectMemoryIdentityStatus = {
  configured: boolean;
  developerId?: string;
  source: 'environment' | 'local' | 'missing';
};

function validatedDeveloperId(value: unknown): string {
  const developerId = stringValue(value, 'developerId', 128);
  assertNoSecrets(developerId, 'developerId');
  return developerId;
}

function parseIdentity(value: unknown): ProjectMemoryLocalIdentity {
  const input = objectValue(value, 'local identity');
  const unexpected = Object.keys(input).filter((key) => !['schemaVersion', 'developerId', 'updatedAt'].includes(key));
  if (unexpected.length > 0) throw new Error(`Local identity contains unsupported fields: ${unexpected.join(', ')}`);
  if (input.schemaVersion !== IDENTITY_SCHEMA_VERSION) throw new Error('Unsupported local identity schema');
  const updatedAt = stringValue(input.updatedAt, 'updatedAt', 64);
  if (Number.isNaN(Date.parse(updatedAt))) throw new Error('Invalid local identity timestamp');
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    developerId: validatedDeveloperId(input.developerId),
    updatedAt,
  };
}

async function readLocalIdentity(root: string): Promise<ProjectMemoryLocalIdentity | undefined> {
  const path = join(resolve(root), IDENTITY_PATH);
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_IDENTITY_BYTES) {
      throw new Error('Unsafe local identity file');
    }
    return parseIdentity(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeLocalDirectory(root: string): Promise<string> {
  const store = join(root, '.prooflore');
  const storeMetadata = await lstat(store);
  if (!storeMetadata.isDirectory() || storeMetadata.isSymbolicLink()) {
    throw new Error('Unsafe project memory directory');
  }
  const local = join(store, 'local');
  await mkdir(local, { recursive: true, mode: 0o700 });
  const localMetadata = await lstat(local);
  if (!localMetadata.isDirectory() || localMetadata.isSymbolicLink()) {
    throw new Error('Unsafe local identity directory');
  }
  return local;
}

/** Stores a mutable per-developer identity in ProofLore's ignored local directory. */
export async function setProjectMemoryIdentity(
  root: string,
  developerIdValue: unknown,
): Promise<ProjectMemoryLocalIdentity> {
  const resolvedRoot = resolve(root);
  const local = await assertSafeLocalDirectory(resolvedRoot);
  const identity: ProjectMemoryLocalIdentity = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    developerId: validatedDeveloperId(developerIdValue),
    updatedAt: new Date().toISOString(),
  };
  const path = join(local, basename(IDENTITY_PATH));
  try {
    const target = await lstat(path);
    if (!target.isFile() || target.isSymbolicLink()) throw new Error('Unsafe local identity file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return identity;
}

/** Resolves the server-bound developer identity, with environment taking precedence. */
export async function resolveProjectMemoryIdentity(
  root: string,
  environmentDeveloperId = process.env.PROJECT_MEMORY_DEVELOPER_ID,
): Promise<ProjectMemoryIdentityStatus> {
  if (environmentDeveloperId !== undefined && environmentDeveloperId.trim() !== '') {
    return {
      configured: true,
      developerId: validatedDeveloperId(environmentDeveloperId),
      source: 'environment',
    };
  }
  const local = await readLocalIdentity(root);
  if (local) return { configured: true, developerId: local.developerId, source: 'local' };
  return { configured: false, source: 'missing' };
}
