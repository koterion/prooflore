import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  PROJECT_MEMORY_SCHEMA_VERSION,
  type MemoryActor,
  type MemoryRecord,
  type MemoryStatus,
  type ProjectMemoryConfig,
  type RecordMemoryInput,
  type ReviewRecord,
  type ReviewVerdict,
  type RuleClassification,
  type StoredRecord,
} from './types.js';
import {
  assertNoSecrets,
  objectValue,
  parseRuleClassification,
  parseRecordInput,
  recordIdValue,
  stringArray,
  stringValue,
} from './validation.js';

const STORE_DIRECTORY = '.prooflore';
const RECORD_DIRECTORY = 'records';
const CONFIG_FILE = 'config.json';
const IGNORE_FILE = '.gitignore';
const IGNORE_CONTENT = `# ProofLore local-only data
/cache/
/local/
/sessions/
/tmp/
/traces/
/transcripts/
*.log
*.tmp
.DS_Store
`;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS = 10_000;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

async function atomicJsonCreate(path: string, value: unknown): Promise<boolean> {
  return atomicFileCreate(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicFileCreate(path: string, content: string): Promise<boolean> {
  const temporary = join(resolve(path, '..'), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    try {
      await link(temporary, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') return false;
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(code)) throw error;
      try {
        await copyFile(temporary, path, constants.COPYFILE_EXCL);
      } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw copyError;
      }
    }
    try {
      const directory = await open(resolve(path, '..'), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }
    return true;
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function parseStoredRecord(value: unknown): StoredRecord {
  const record = objectValue(value, 'stored record');
  if (record.schemaVersion !== PROJECT_MEMORY_SCHEMA_VERSION) throw new Error('Unsupported stored record schema');
  const id = stringValue(record.id, 'stored record id', 64);
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid stored record id');
  const projectId = stringValue(record.projectId, 'stored projectId', 128);
  const createdAt = stringValue(record.createdAt, 'stored createdAt', 64);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error('Invalid stored record timestamp');
  const actorValue = objectValue(record.actor, 'stored actor');
  const actor: MemoryActor = {
    kind: stringValue(actorValue.kind, 'stored actor kind', 16) as MemoryActor['kind'],
    developerId: stringValue(actorValue.developerId, 'stored developerId', 128),
    provider: actorValue.provider === undefined ? undefined : stringValue(actorValue.provider, 'stored provider', 64),
    model: actorValue.model === undefined ? undefined : stringValue(actorValue.model, 'stored model', 128),
    sessionId: actorValue.sessionId === undefined ? undefined : stringValue(actorValue.sessionId, 'stored sessionId', 128),
  };
  if (!['human', 'agent'].includes(actor.kind)) throw new Error('Invalid stored actor kind');
  if (record.kind === 'review') {
    if (actor.kind !== 'human') throw new Error('A review must have a human actor');
    const review: ReviewRecord = {
      schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
      id,
      projectId,
      kind: 'review',
      targetId: recordIdValue(record.targetId, 'stored targetId'),
      previousReviewId: record.previousReviewId === undefined
        ? undefined : recordIdValue(record.previousReviewId, 'stored previousReviewId'),
      previousReviewIds: record.previousReviewIds === undefined
        ? undefined : stringArray(record.previousReviewIds, 'stored previousReviewIds', 20, 64)
          .map((parentId, index) => recordIdValue(parentId, `stored previousReviewIds[${index}]`)),
      verdict: stringValue(record.verdict, 'stored verdict', 16) as ReviewVerdict,
      reason: stringValue(record.reason, 'stored review reason', 2000),
      classification: record.classification === undefined
        ? undefined : parseRuleClassification(record.classification, 'stored classification'),
      actor: { ...actor, kind: 'human' },
      createdAt,
    };
    if (!['approved', 'rejected', 'revoked', 'superseded'].includes(review.verdict)) {
      throw new Error('Invalid stored verdict');
    }
    if (digest(reviewContent(review)) !== id) throw new Error('Stored review digest mismatch');
    return review;
  }
  const input = parseRecordInput({
    ...record,
    developerId: actor.developerId,
    provider: actor.provider,
    model: actor.model,
    sessionId: actor.sessionId,
  });
  const memory: MemoryRecord = {
    schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
    id,
    projectId,
    kind: input.kind,
    summary: input.summary,
    rationale: input.rationale,
    tags: input.tags ?? [],
    scope: input.scope ?? [],
    evidence: input.evidence ?? [],
    actor,
    supersedes: input.supersedes ?? [],
    createdAt,
  };
  if (digest(memoryContent(memory)) !== id) throw new Error('Stored memory digest mismatch');
  return memory;
}

function memoryContent(record: Omit<MemoryRecord, 'schemaVersion' | 'id' | 'createdAt'>): unknown {
  return {
    projectId: record.projectId,
    kind: record.kind,
    summary: record.summary,
    rationale: record.rationale,
    tags: record.tags,
    scope: record.scope,
    evidence: record.evidence,
    actor: record.actor,
    supersedes: record.supersedes,
  };
}

function reviewContent(record: Omit<ReviewRecord, 'schemaVersion' | 'id' | 'createdAt'>): unknown {
  return {
    projectId: record.projectId,
    kind: 'review',
    targetId: record.targetId,
    previousReviewId: record.previousReviewId,
    previousReviewIds: record.previousReviewIds,
    verdict: record.verdict,
    reason: record.reason,
    classification: record.classification,
    actor: record.actor,
  };
}

function invalidReviewRelations(records: StoredRecord[]): Set<string> {
  const byId = new Map(records.map((record) => [record.id, record]));
  const invalid = new Set<string>();
  for (const review of records.filter((record): record is ReviewRecord => record.kind === 'review')) {
    const target = byId.get(review.targetId);
    if (!target || target.kind !== 'rule_candidate') {
      invalid.add(review.id);
      continue;
    }
    const parentIds = [
      ...(review.previousReviewId ? [review.previousReviewId] : []),
      ...(review.previousReviewIds ?? []),
    ];
    if (parentIds.some((parentId) => {
      const parent = byId.get(parentId);
      return !parent || parent.kind !== 'review' || parent.targetId !== review.targetId;
    })) invalid.add(review.id);
  }
  return invalid;
}

/** Stores immutable, merge-friendly project knowledge with human-controlled rule promotion. */
export class ProjectMemoryStore {
  readonly root: string;
  readonly directory: string;
  readonly recordsDirectory: string;
  private readonly recordCache = new Map<string, { signature: string; record: StoredRecord }>();

  constructor(root: string) {
    this.root = resolve(root);
    this.directory = join(this.root, STORE_DIRECTORY);
    this.recordsDirectory = join(this.directory, RECORD_DIRECTORY);
  }

  private async assertSafeDirectory(path: string): Promise<void> {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Unsafe project memory directory: ${path}`);
  }

  private async assertStoreDirectories(): Promise<void> {
    await this.assertSafeDirectory(this.directory);
    await this.assertSafeDirectory(this.recordsDirectory);
  }

  /** Initializes a project store without overwriting an existing configuration. */
  async initialize(projectId: string): Promise<ProjectMemoryConfig> {
    const normalizedId = stringValue(projectId, 'projectId', 128);
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(normalizedId)) {
      throw new Error('projectId must use lowercase letters, numbers, dot, underscore or hyphen');
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.assertSafeDirectory(this.directory);
    await mkdir(this.recordsDirectory, { recursive: true, mode: 0o700 });
    await this.assertSafeDirectory(this.recordsDirectory);
    await atomicFileCreate(join(this.directory, IGNORE_FILE), IGNORE_CONTENT);
    const existing = await this.readConfig().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      if (existing.projectId !== normalizedId) throw new Error(`Store already belongs to ${existing.projectId}`);
      return existing;
    }
    const config: ProjectMemoryConfig = {
      schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
      projectId: normalizedId,
      createdAt: new Date().toISOString(),
      maxContextCharacters: 6000,
    };
    const created = await atomicJsonCreate(join(this.directory, CONFIG_FILE), config);
    return created ? config : this.readConfig();
  }

  /** Reads and validates the project store configuration. */
  async readConfig(): Promise<ProjectMemoryConfig> {
    await this.assertStoreDirectories();
    const path = join(this.directory, CONFIG_FILE);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) {
      throw new Error('Unsafe project memory configuration');
    }
    const raw = await readFile(path, 'utf8');
    const value = objectValue(JSON.parse(raw), 'config');
    if (value.schemaVersion !== PROJECT_MEMORY_SCHEMA_VERSION) throw new Error('Unsupported project memory schema');
    const projectId = stringValue(value.projectId, 'projectId', 128);
    const createdAt = stringValue(value.createdAt, 'createdAt', 64);
    const maxContextCharacters = Number(value.maxContextCharacters);
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(projectId)) throw new Error('Invalid configured projectId');
    if (Number.isNaN(Date.parse(createdAt))) throw new Error('Invalid configured timestamp');
    if (!Number.isInteger(maxContextCharacters) || maxContextCharacters < 1000 || maxContextCharacters > 20_000) {
      throw new Error('maxContextCharacters must be an integer from 1000 to 20000');
    }
    return { schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION, projectId, createdAt, maxContextCharacters };
  }

  /** Appends an immutable record and deduplicates identical retries by content hash. */
  async record(input: RecordMemoryInput, source: 'agent' | 'human'): Promise<{ record: MemoryRecord; created: boolean }> {
    const config = await this.readConfig();
    if (input.kind === 'rule_candidate' && (!input.rationale || (input.evidence?.length ?? 0) === 0)) {
      throw new Error('Rule candidates require rationale and evidence');
    }
    const actor: MemoryActor = {
      kind: source,
      developerId: input.developerId,
      provider: input.provider,
      model: input.model,
      sessionId: input.sessionId,
    };
    const content: Omit<MemoryRecord, 'schemaVersion' | 'id' | 'createdAt'> = {
      projectId: config.projectId,
      kind: input.kind,
      summary: input.summary,
      rationale: input.rationale,
      tags: [...new Set(input.tags ?? [])].sort(),
      scope: [...new Set(input.scope ?? [])].sort(),
      evidence: input.evidence ?? [],
      actor,
      supersedes: [...new Set(input.supersedes ?? [])].sort(),
    };
    const id = digest(memoryContent(content));
    const path = join(this.recordsDirectory, `${id}.json`);
    const prior = await this.readRecord(id).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (prior) {
      if (prior.kind === 'review') throw new Error('Record id collision');
      return { record: prior, created: false };
    }
    const record: MemoryRecord = {
      schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
      id,
      ...content,
      createdAt: new Date().toISOString(),
    };
    const created = await atomicJsonCreate(path, record);
    if (!created) {
      const existing = await this.readRecord(id);
      if (existing.kind === 'review') throw new Error('Record id collision');
      return { record: existing, created: false };
    }
    return { record, created: true };
  }

  /** Records a human verdict; agents have no MCP operation that can approve their own candidates. */
  async review(
    targetId: string,
    verdict: ReviewVerdict,
    reason: string,
    developerId: string,
    classification?: RuleClassification,
  ): Promise<{ review: ReviewRecord; created: boolean }> {
    const target = await this.readRecord(targetId);
    if (target.kind !== 'rule_candidate') throw new Error('Only rule candidates can be reviewed');
    const existingRecords = await this.listRecords();
    const reviewState = resolveReviewStates(existingRecords
      .filter((record): record is ReviewRecord => record.kind === 'review'));
    const conflictHeads = reviewState.conflicts.get(targetId);
    if (conflictHeads && !reviewState.mergeableConflicts.has(targetId)) {
      throw new Error('Rule candidate review history is incomplete or cyclic');
    }
    const actor: MemoryActor & { kind: 'human' } = {
      kind: 'human',
      developerId: stringValue(developerId, 'developerId', 128),
    };
    assertNoSecrets(actor.developerId, 'developerId');
    const validatedReason = stringValue(reason, 'reason', 2000);
    assertNoSecrets(validatedReason, 'reason');
    if (!['approved', 'rejected', 'revoked', 'superseded'].includes(verdict)) {
      throw new Error('Invalid review verdict');
    }
    const latestReview = reviewState.latest.get(targetId);
    if (verdict === 'revoked' && latestReview?.verdict !== 'approved') {
      throw new Error('Only an approved rule can be revoked');
    }
    const content: Omit<ReviewRecord, 'schemaVersion' | 'id' | 'createdAt'> = {
      projectId: target.projectId,
      kind: 'review' as const,
      targetId,
      previousReviewIds: conflictHeads ?? (reviewState.latest.get(targetId)
        ? [reviewState.latest.get(targetId)!.id] : undefined),
      verdict,
      reason: validatedReason,
      classification: classification === undefined
        ? latestReview?.classification : parseRuleClassification(classification),
      actor,
    };
    const id = digest(reviewContent(content));
    const prior = await this.readRecord(id).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (prior) {
      if (prior.kind !== 'review') throw new Error('Review id collision');
      return { review: prior, created: false };
    }
    const review: ReviewRecord = {
      schemaVersion: PROJECT_MEMORY_SCHEMA_VERSION,
      id,
      ...content,
      createdAt: new Date().toISOString(),
    };
    const created = await atomicJsonCreate(join(this.recordsDirectory, `${id}.json`), review);
    if (!created) {
      const existing = await this.readRecord(id);
      if (existing.kind !== 'review') throw new Error('Review id collision');
      return { review: existing, created: false };
    }
    return { review, created: true };
  }

  private async readRecordUnchecked(id: string): Promise<StoredRecord> {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid record id');
    const path = join(this.recordsDirectory, `${id}.json`);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_RECORD_BYTES) {
      throw new Error(`Invalid record file: ${id}`);
    }
    const signature = [metadata.dev, metadata.ino, metadata.mode, metadata.size, metadata.mtimeMs, metadata.ctimeMs]
      .join(':');
    const cached = this.recordCache.get(id);
    if (cached?.signature === signature) return structuredClone(cached.record);
    const record = parseStoredRecord(JSON.parse(await readFile(path, 'utf8')));
    if (record.id !== id) throw new Error(`Record content id mismatch: ${id}`);
    this.recordCache.set(id, { signature, record: structuredClone(record) });
    return structuredClone(record);
  }

  /** Reads a content-addressed record by stable identifier within this exact project. */
  async readRecord(id: string): Promise<StoredRecord> {
    const config = await this.readConfig();
    const record = await this.readRecordUnchecked(id);
    if (record.projectId !== config.projectId) throw new Error(`Foreign project record: ${id}`);
    if (record.kind === 'review') {
      const target = await this.readRecordUnchecked(record.targetId).catch(() => undefined);
      if (!target || target.projectId !== config.projectId || target.kind !== 'rule_candidate') {
        throw new Error(`Invalid review target: ${record.id}`);
      }
      for (const parentId of [
        ...(record.previousReviewId ? [record.previousReviewId] : []),
        ...(record.previousReviewIds ?? []),
      ]) {
        const parent = await this.readRecordUnchecked(parentId).catch(() => undefined);
        if (!parent || parent.projectId !== config.projectId || parent.kind !== 'review'
          || parent.targetId !== record.targetId) throw new Error(`Invalid review parent: ${record.id}`);
      }
    }
    return record;
  }

  /** Lists bounded immutable records and fails closed on malformed persisted data. */
  async listRecords(): Promise<StoredRecord[]> {
    const config = await this.readConfig();
    const names = (await readdir(this.recordsDirectory)).filter((name) => name.endsWith('.json')).sort();
    if (names.length > MAX_RECORDS) throw new Error(`Record limit exceeded: ${names.length}`);
    const invalidName = names.find((name) => !/^[a-f0-9]{64}\.json$/u.test(name));
    if (invalidName) throw new Error(`Invalid record file: ${invalidName}`);
    const currentIds = new Set(names.map((name) => name.slice(0, -5)));
    for (const id of this.recordCache.keys()) if (!currentIds.has(id)) this.recordCache.delete(id);
    const records: StoredRecord[] = [];
    for (let index = 0; index < names.length; index += 32) {
      const batch = await Promise.all(names.slice(index, index + 32)
        .map((name) => this.readRecordUnchecked(name.slice(0, -5))));
      const foreign = batch.find((record) => record.projectId !== config.projectId);
      if (foreign) throw new Error(`Foreign project record: ${foreign.id}`);
      records.push(...batch);
    }
    const invalidRelations = invalidReviewRelations(records);
    if (invalidRelations.size > 0) {
      throw new Error(`Invalid review relation: ${[...invalidRelations].sort()[0]}`);
    }
    return records;
  }

  /** Returns the immutable human review history for one rule in chronological order. */
  async ruleHistory(targetId: string): Promise<ReviewRecord[]> {
    const target = await this.readRecord(targetId);
    if (target.kind !== 'rule_candidate') throw new Error('Only rule candidates have review history');
    return (await this.listRecords())
      .filter((record): record is ReviewRecord => record.kind === 'review' && record.targetId === targetId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  /** Computes a health summary without silently treating corrupted records as valid context. */
  async status(): Promise<MemoryStatus> {
    const config = await this.readConfig();
    const names = (await readdir(this.recordsDirectory)).filter((name) => name.endsWith('.json')).sort();
    const records: StoredRecord[] = [];
    const corruptedRecords: string[] = [];
    if (names.length > MAX_RECORDS) corruptedRecords.push(`record-limit-exceeded:${names.length}`);
    for (const name of names.slice(0, MAX_RECORDS + 1)) {
      try {
        const record = await this.readRecordUnchecked(name.slice(0, -5));
        if (record.projectId !== config.projectId) throw new Error('Foreign project record');
        records.push(record);
      } catch {
        corruptedRecords.push(name);
      }
    }
    const invalidRelations = invalidReviewRelations(records);
    for (const id of invalidRelations) corruptedRecords.push(`${id}.json`);
    const trustedRecords = records.filter((record) => !invalidRelations.has(record.id));
    const memory = trustedRecords.filter((record): record is MemoryRecord => record.kind !== 'review');
    const reviews = trustedRecords.filter((record): record is ReviewRecord => record.kind === 'review');
    const reviewState = resolveReviewStates(reviews);
    const latest = reviewState.latest;
    const contributors = new Map<string, {
      developerId: string;
      humanRecords: number;
      agentRecords: number;
      providers: Set<string>;
    }>();
    for (const record of trustedRecords) {
      const contributor = contributors.get(record.actor.developerId) ?? {
        developerId: record.actor.developerId,
        humanRecords: 0,
        agentRecords: 0,
        providers: new Set<string>(),
      };
      if (record.actor.kind === 'human') contributor.humanRecords += 1;
      else contributor.agentRecords += 1;
      if (record.actor.provider) contributor.providers.add(record.actor.provider);
      contributors.set(record.actor.developerId, contributor);
    }
    return {
      projectId: config.projectId,
      records: memory.length,
      candidates: memory.filter((record) => record.kind === 'rule_candidate').length,
      approvedRules: [...latest.values()].filter((review) => review.verdict === 'approved').length,
      rejectedRules: [...latest.values()].filter((review) => review.verdict === 'rejected').length,
      revokedRules: [...latest.values()].filter((review) => review.verdict === 'revoked').length,
      reviewConflicts: reviewState.conflicts.size,
      storeDigest: digest(trustedRecords.map((record) => record.id).sort()),
      contributors: [...contributors.values()]
        .sort((left, right) => left.developerId.localeCompare(right.developerId))
        .map((contributor) => ({ ...contributor, providers: [...contributor.providers].sort() })),
      corruptedRecords: [...new Set(corruptedRecords)].sort(),
    };
  }
}

/** Resolves the latest authoritative human verdict for every candidate. */
export function resolveReviewStates(reviews: ReviewRecord[]): {
  latest: Map<string, ReviewRecord>;
  conflicts: Map<string, string[]>;
  mergeableConflicts: Set<string>;
} {
  const latest = new Map<string, ReviewRecord>();
  const conflicts = new Map<string, string[]>();
  const mergeableConflicts = new Set<string>();
  const grouped = new Map<string, ReviewRecord[]>();
  for (const review of reviews) grouped.set(review.targetId, [...(grouped.get(review.targetId) ?? []), review]);
  for (const [targetId, targetReviews] of grouped) {
    const byId = new Map(targetReviews.map((review) => [review.id, review]));
    const parents = (review: ReviewRecord): string[] => [
      ...(review.previousReviewId ? [review.previousReviewId] : []),
      ...(review.previousReviewIds ?? []),
    ];
    const referenced = new Set(targetReviews.flatMap(parents));
    const invalidParent = targetReviews.some((review) => parents(review).some((parent) => !byId.has(parent)));
    const heads = targetReviews.filter((review) => !referenced.has(review.id));
    if (invalidParent || heads.length === 0) {
      conflicts.set(targetId, heads.map((review) => review.id).sort());
      continue;
    }
    const visited = new Set<string>();
    const visiting = new Set<string>();
    let cycle = false;
    const visit = (review: ReviewRecord): void => {
      if (visiting.has(review.id)) {
        cycle = true;
        return;
      }
      if (visited.has(review.id)) return;
      visiting.add(review.id);
      for (const parent of parents(review)) visit(byId.get(parent)!);
      visiting.delete(review.id);
      visited.add(review.id);
    };
    for (const head of heads) visit(head);
    if (cycle || visited.size !== targetReviews.length) {
      conflicts.set(targetId, heads.map((review) => review.id).sort());
      continue;
    }
    if (heads.length > 1) {
      conflicts.set(targetId, heads.map((review) => review.id).sort());
      mergeableConflicts.add(targetId);
      continue;
    }
    latest.set(targetId, heads[0]);
  }
  return { latest, conflicts, mergeableConflicts };
}

/** Resolves only unambiguous human verdicts; conflicting branches grant no authority. */
export function latestReviews(reviews: ReviewRecord[]): Map<string, ReviewRecord> {
  return resolveReviewStates(reviews).latest;
}
