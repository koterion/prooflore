import { posix } from 'node:path';

import {
  MEMORY_KINDS,
  type MemoryEvidence,
  type MemoryKind,
  type RecordMemoryInput,
  type RuleClassification,
} from './types.js';

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*[^\s,;]{8,}/iu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/u,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_]{16,}/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
];
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const RECORD_ID = /^[a-f0-9]{64}$/u;
export const KNOWN_RULE_LANGUAGES = [
  'c', 'cpp', 'csharp', 'css', 'go', 'html', 'java', 'javascript', 'kotlin', 'php',
  'python', 'ruby', 'rust', 'scss', 'swift', 'typescript', 'vue',
] as const;
export const KNOWN_RULE_TEST_TYPES = [
  'automated', 'contract', 'e2e', 'integration', 'performance', 'security', 'unit', 'visual',
] as const;
const CLASSIFICATION_ALIASES: Readonly<Record<'languages' | 'testTypes', Readonly<Record<string, string>>>> = {
  languages: {
    js: 'javascript', jsx: 'javascript', node: 'javascript', nodejs: 'javascript',
    ts: 'typescript', tsx: 'typescript', py: 'python', rs: 'rust', golang: 'go',
    'c#': 'csharp', 'c++': 'cpp',
  },
  testTypes: {
    'unit-test': 'unit', 'integration-test': 'integration', 'contract-test': 'contract',
    'end-to-end': 'e2e', snapshot: 'visual', benchmark: 'performance', perf: 'performance',
  },
};

/** Narrows an unknown value to a plain object. */
export function objectValue(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Validates a bounded non-empty string. */
export function stringValue(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${name} contains unsupported control characters`);
  return value.trim();
}

/** Validates a bounded array of unique strings. */
export function stringArray(value: unknown, name: string, limit: number, itemMax: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${name} must contain at most ${limit} items`);
  const items = value.map((item, index) => stringValue(item, `${name}[${index}]`, itemMax));
  return [...new Set(items)];
}

/** Ensures project-relative scope and evidence paths cannot escape the project. */
export function relativeProjectPath(value: string, name: string): string {
  const portable = value.replaceAll('\\', '/');
  const normalized = posix.normalize(portable);
  if (portable.startsWith('/') || /^[a-zA-Z]:\//u.test(portable)
    || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`${name} must remain inside the project`);
  }
  return normalized;
}

/** Rejects likely credentials before durable storage. */
export function assertNoSecrets(value: string, name: string): void {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${name} appears to contain a credential; store a reference instead`);
  }
}

/** Validates an immutable content-addressed record reference. */
export function recordIdValue(value: unknown, name: string): string {
  const id = stringValue(value, name, 64);
  if (!RECORD_ID.test(id)) throw new Error(`${name} must be a SHA-256 record ID`);
  return id;
}

/** Canonicalizes one classification facet while preserving open-ended project areas. */
export function normalizeRuleFacet(key: keyof RuleClassification, value: string): string {
  const normalized = value.trim().toLocaleLowerCase().replace(/[\s_]+/gu, '-');
  if (key === 'areas') return normalized;
  return CLASSIFICATION_ALIASES[key][normalized] ?? normalized;
}

/** Validates normalized human-confirmed rule applicability facets. */
export function parseRuleClassification(value: unknown, name = 'classification'): RuleClassification {
  const input = objectValue(value, name);
  const unexpected = Object.keys(input).filter((key) => !['areas', 'languages', 'testTypes'].includes(key));
  if (unexpected.length > 0) throw new Error(`${name} contains unsupported fields: ${unexpected.join(', ')}`);
  const facet = (key: keyof RuleClassification): string[] => stringArray(input[key], `${name}.${key}`, 20, 64)
    .map((item) => normalizeRuleFacet(key, item))
    .map((item) => {
      if (item === 'global') throw new Error(`${name}.${key} must use an empty list for global applicability`);
      if (!/^[a-z0-9][a-z0-9.-]*$/u.test(item)) throw new Error(`${name}.${key} contains an invalid facet`);
      return item;
    })
    .sort();
  return { areas: facet('areas'), languages: facet('languages'), testTypes: facet('testTypes') };
}

/** Parses untrusted MCP or CLI input into the portable memory contract. */
export function parseRecordInput(value: unknown): RecordMemoryInput {
  const input = objectValue(value, 'record');
  const kind = stringValue(input.kind, 'kind', 32) as MemoryKind;
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`Unsupported memory kind: ${kind}`);
  const summary = stringValue(input.summary, 'summary', 4000);
  const rationale = input.rationale === undefined ? undefined : stringValue(input.rationale, 'rationale', 4000);
  const tags = stringArray(input.tags, 'tags', 20, 64).map((tag) => tag.toLocaleLowerCase());
  const scope = stringArray(input.scope, 'scope', 30, 256)
    .map((path, index) => relativeProjectPath(path, `scope[${index}]`));
  const supersedes = stringArray(input.supersedes, 'supersedes', 20, 64)
    .map((id, index) => recordIdValue(id, `supersedes[${index}]`));
  const evidenceRaw = input.evidence === undefined ? [] : input.evidence;
  if (!Array.isArray(evidenceRaw) || evidenceRaw.length > 20) throw new Error('evidence must contain at most 20 items');
  const evidence = evidenceRaw.map((item, index): MemoryEvidence => {
    const entry = objectValue(item, `evidence[${index}]`);
    const path = entry.path === undefined ? undefined
      : relativeProjectPath(stringValue(entry.path, `evidence[${index}].path`, 256), `evidence[${index}].path`);
    const revision = entry.revision === undefined ? undefined
      : stringValue(entry.revision, `evidence[${index}].revision`, 128);
    const note = entry.note === undefined ? undefined : stringValue(entry.note, `evidence[${index}].note`, 1000);
    if (!path && !revision && !note) throw new Error(`evidence[${index}] must not be empty`);
    return { path, revision, note };
  });

  [summary, rationale, ...tags, ...scope,
    ...evidence.flatMap((entry) => [entry.path, entry.note, entry.revision]),
    input.developerId, input.provider, input.model, input.sessionId]
    .filter((entry): entry is string => Boolean(entry))
    .forEach((entry, index) => assertNoSecrets(entry, `record text[${index}]`));

  return {
    kind,
    summary,
    rationale,
    tags,
    scope,
    evidence,
    developerId: stringValue(input.developerId, 'developerId', 128),
    provider: input.provider === undefined ? undefined : stringValue(input.provider, 'provider', 64),
    model: input.model === undefined ? undefined : stringValue(input.model, 'model', 128),
    sessionId: input.sessionId === undefined ? undefined : stringValue(input.sessionId, 'sessionId', 128),
    supersedes,
  };
}
