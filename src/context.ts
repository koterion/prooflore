import type {
  MemoryContext,
  MemoryContextExplanation,
  MemoryRecord,
  ReviewRecord,
  RuleCandidatePage,
  RuleCandidateState,
  RuleCatalogFilters,
  RuleCatalogPage,
  RuleClassification,
} from './types.js';
import { ProjectMemoryStore, resolveReviewStates } from './store.js';
import {
  KNOWN_RULE_LANGUAGES,
  KNOWN_RULE_TEST_TYPES,
  normalizeRuleFacet,
} from './validation.js';

function terms(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]+/gu) ?? [])
    .filter((term) => term.length >= 2));
}

function relevance(record: MemoryRecord, queryTerms: Set<string>, paths: string[]): number {
  const summary = terms(`${record.summary} ${record.rationale ?? ''}`);
  const tagHits = record.tags.filter((tag) => queryTerms.has(tag.toLocaleLowerCase())).length;
  const textHits = [...queryTerms].filter((term) => summary.has(term)).length;
  const scopedPaths = [...record.scope, ...record.evidence.flatMap((entry) => entry.path ? [entry.path] : [])];
  const pathHits = scopedPaths.filter((scope) => paths.some((path) => path === scope
    || path.startsWith(`${scope}/`) || scope.startsWith(`${path}/`))).length;
  return (tagHits * 5) + (pathHits * 4) + (textHits * 2);
}

function serializedCharacters(records: MemoryRecord[]): number {
  return records.reduce((total, record) => total + JSON.stringify(record).length, 0);
}

const LANGUAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', html: 'html',
  java: 'java', js: 'javascript', jsx: 'javascript', kt: 'kotlin', kts: 'kotlin',
  php: 'php', py: 'python', rb: 'ruby', rs: 'rust', scss: 'scss', swift: 'swift',
  ts: 'typescript', tsx: 'typescript', vue: 'vue',
};
const AREA_ROOTS = new Set(['app', 'apps', 'lib', 'libs', 'package', 'packages', 'src', 'test', 'tests', '__tests__']);
const TEST_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['e2e', /(^|[/.\-_])e2e([/.\-_]|$)/u],
  ['integration', /(^|[/.\-_])integration([/.\-_]|$)/u],
  ['contract', /(^|[/.\-_])contract([/.\-_]|$)/u],
  ['visual', /(^|[/.\-_])(snapshot|visual)([/.\-_]|$)/u],
  ['performance', /(^|[/.\-_])(benchmark|perf|performance)([/.\-_]|$)/u],
  ['security', /(^|[/.\-_])security([/.\-_]|$)/u],
  ['unit', /(^|[/.\-_])unit([/.\-_]|$)/u],
  ['automated', /(^|[/.\-_])(__tests__|spec|test|tests)([/.\-_]|$)/u],
];
const LANGUAGE_QUERY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['typescript', /(^|[^a-z0-9])(typescript|tsx?|тайпскрипт)([^a-z0-9]|$)/u],
  ['javascript', /(^|[^a-z0-9])(javascript|jsx?|джаваскрипт)([^a-z0-9]|$)/u],
  ['python', /(^|[^a-z0-9])(python|py|пайтон)([^a-z0-9]|$)/u],
  ['rust', /(^|[^a-z0-9])(rust|rs)([^a-z0-9]|$)/u],
  ['go', /(^|[^a-z0-9])golang([^a-z0-9]|$)/u],
  ['java', /(^|[^a-z0-9])java([^a-z0-9]|$)/u],
  ['kotlin', /(^|[^a-z0-9])kotlin([^a-z0-9]|$)/u],
  ['swift', /(^|[^a-z0-9])swift([^a-z0-9]|$)/u],
  ['php', /(^|[^a-z0-9])php([^a-z0-9]|$)/u],
  ['ruby', /(^|[^a-z0-9])ruby([^a-z0-9]|$)/u],
  ['csharp', /(^|[^a-z0-9])(c#|csharp)([^a-z0-9]|$)/u],
  ['cpp', /(^|[^a-z0-9])(c\+\+|cpp)([^a-z0-9]|$)/u],
];
const TEST_QUERY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['e2e', /(^|[^\p{L}\p{N}])(e2e|end-to-end)([^\p{L}\p{N}]|$)/u],
  ['integration', /(^|[^\p{L}\p{N}])(integration|integration-test|інтеграційн\p{L}*)([^\p{L}\p{N}]|$)/u],
  ['contract', /(^|[^\p{L}\p{N}])(contract|contract-test|контрактн\p{L}*)([^\p{L}\p{N}]|$)/u],
  ['visual', /(^|[^\p{L}\p{N}])(visual|snapshot|візуальн\p{L}*)([^\p{L}\p{N}]|$)/u],
  ['performance', /(^|[^\p{L}\p{N}])(benchmark|performance|perf|продуктивн\p{L}*)([^\p{L}\p{N}]|$)/u],
  ['security', /(^|[^\p{L}\p{N}])(security|безпек\p{L}*)([^\p{L}\p{N}]|$)/u],
  ['unit', /(^|[^\p{L}\p{N}])(unit|unit-test|юніт|модульн\p{L}*)([^\p{L}\p{N}]|$)/u],
  ['automated', /(^|[^\p{L}\p{N}])(test|tests|testing|spec|тест\p{L}*)([^\p{L}\p{N}]|$)/u],
];

function normalizedFacet(value: string): string | undefined {
  const normalized = value.trim().toLocaleLowerCase().replace(/[\s_]+/gu, '-');
  return /^[a-z0-9][a-z0-9.-]*$/u.test(normalized) ? normalized : undefined;
}

function normalizedClassificationFilter(
  key: keyof RuleClassification,
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeRuleFacet(key, value);
  return /^[a-z0-9][a-z0-9.-]*$/u.test(normalized) ? normalized : undefined;
}

function taggedFacets(
  tags: string[],
  prefixes: string[],
  key: keyof RuleClassification = 'areas',
): string[] {
  const values = tags.flatMap((tag) => {
    const normalizedTag = tag.toLocaleLowerCase();
    const prefix = prefixes.find((candidate) => normalizedTag.startsWith(candidate));
    if (!prefix) return [];
    const value = normalizeRuleFacet(key, tag.slice(prefix.length));
    return /^[a-z0-9][a-z0-9.-]*$/u.test(value) ? [value] : [];
  });
  return [...new Set(values)].sort();
}

function pathClassification(paths: string[]): RuleClassification {
  const areas = paths.flatMap((path) => {
    const segments = path.split('/').filter(Boolean);
    const directories = segments.filter((item, index) => index < segments.length - 1
      && !AREA_ROOTS.has(item.toLocaleLowerCase()));
    const fallback = segments.at(-1)?.includes('.') ? segments.at(-1)?.replace(/\..*$/u, '') : segments.at(-1);
    return (directories.length > 0 ? directories : fallback ? [fallback] : [])
      .flatMap((segment) => {
        const value = normalizedFacet(segment);
        return value ? [value] : [];
      });
  });
  const languages = paths.flatMap((path) => {
    const extension = path.toLocaleLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
    return extension && LANGUAGE_EXTENSIONS[extension] ? [LANGUAGE_EXTENSIONS[extension]] : [];
  });
  const testTypes = paths.flatMap((path) => {
    const matches = TEST_PATTERNS
      .filter(([, pattern]) => pattern.test(path.toLocaleLowerCase()))
      .map(([name]) => name);
    const specific = matches.filter((name) => name !== 'automated');
    return specific.length > 0 ? specific : matches;
  });
  return {
    areas: [...new Set(areas)].sort(),
    languages: [...new Set(languages)].sort(),
    testTypes: [...new Set(testTypes)].sort(),
  };
}

/** Classifies a task from its description, affected paths and known project rule areas. */
export function classifyTask(query: string, paths: string[], knownAreas: string[] = []): RuleClassification {
  const fromPaths = pathClassification(paths);
  const queryValue = query.toLocaleLowerCase();
  const queryTerms = terms(queryValue);
  const mentionedAreas = knownAreas.filter((area) => queryTerms.has(area));
  const mentionedLanguages = LANGUAGE_QUERY_PATTERNS
    .filter(([, pattern]) => pattern.test(queryValue)).map(([language]) => language);
  const mentionedTestTypes = TEST_QUERY_PATTERNS
    .filter(([, pattern]) => pattern.test(queryValue)).map(([testType]) => testType);
  const specificQueryTests = mentionedTestTypes.filter((testType) => testType !== 'automated');
  const specificPathTests = fromPaths.testTypes.filter((testType) => testType !== 'automated');
  const testTypes = specificQueryTests.length > 0 ? specificQueryTests
    : specificPathTests.length > 0 ? specificPathTests
      : [...fromPaths.testTypes, ...mentionedTestTypes];
  return {
    areas: [...new Set([...fromPaths.areas, ...mentionedAreas])].sort(),
    languages: [...new Set([...fromPaths.languages, ...mentionedLanguages])].sort(),
    testTypes: [...new Set(testTypes)].sort(),
  };
}

/** Derives rule applicability from explicit tags and scope; evidence never narrows applicability. */
export function classifyRule(record: MemoryRecord): RuleClassification {
  const explicitAreas = taggedFacets(record.tags, ['area:', 'domain:']);
  const inferred = pathClassification(record.scope);
  const explicitLanguages = taggedFacets(record.tags, ['language:', 'lang:'], 'languages');
  const explicitTestTypes = taggedFacets(record.tags, ['test-type:', 'test:'], 'testTypes');
  return {
    areas: explicitAreas.length > 0 ? explicitAreas : inferred.areas,
    languages: explicitLanguages.length > 0
      ? explicitLanguages
      : inferred.languages,
    testTypes: explicitTestTypes.length > 0
      ? explicitTestTypes
      : inferred.testTypes,
  };
}

function facetMatches(ruleValues: string[], taskValues: string[], automatedWildcard = false): string[] {
  if (automatedWildcard && taskValues.includes('automated')) return ruleValues;
  if (automatedWildcard && ruleValues.includes('automated')) return taskValues;
  return ruleValues.filter((value) => taskValues.includes(value));
}

function ruleMatch(
  rule: RuleClassification,
  task: RuleClassification,
): { compatible: boolean; areas: string[]; languages: string[]; testTypes: string[] } {
  const areas = facetMatches(rule.areas, task.areas);
  const languages = facetMatches(rule.languages, task.languages);
  const testTypes = facetMatches(rule.testTypes, task.testTypes, true);
  const compatible = (rule.areas.length === 0 || task.areas.length === 0 || areas.length > 0)
    && (rule.languages.length === 0 || task.languages.length === 0 || languages.length > 0)
    && (rule.testTypes.length === 0 || (task.testTypes.length > 0 && testTypes.length > 0));
  return { compatible, areas, languages, testTypes };
}

function ruleKey(record: MemoryRecord): string | undefined {
  return taggedFacets(record.tags, ['rule-key:'])[0];
}

function supersededRecordIds(
  memory: MemoryRecord[],
  reviews: Map<string, ReviewRecord>,
): Set<string> {
  const byId = new Map(memory.map((record) => [record.id, record]));
  const superseded = new Set<string>();
  for (const record of memory) {
    for (const targetId of record.supersedes) {
      const target = byId.get(targetId);
      if (!target) continue;
      if (target.kind !== 'rule_candidate'
        || (record.kind === 'rule_candidate' && reviews.get(record.id)?.verdict === 'approved')) {
        superseded.add(targetId);
      }
    }
  }
  for (const review of reviews.values()) if (review.verdict === 'superseded') superseded.add(review.targetId);
  return superseded;
}

function candidateSummary(
  record: MemoryRecord,
  reviewState: ReturnType<typeof resolveReviewStates>,
): RuleCandidatePage['items'][number] {
  const review = reviewState.latest.get(record.id);
  const state: RuleCandidateState = reviewState.conflicts.has(record.id)
    ? 'conflict' : review?.verdict ?? 'pending';
  return {
    id: record.id,
    summary: record.summary,
    scope: record.scope,
    evidenceCount: record.evidence.length,
    proposedBy: record.actor,
    createdAt: record.createdAt,
    state,
    latestReviewId: review?.id,
    latestReview: review ? {
      verdict: review.verdict,
      reason: review.reason,
      reviewedBy: review.actor.developerId,
      createdAt: review.createdAt,
    } : undefined,
    classification: review?.classification ?? classifyRule(record),
  };
}

/** Builds bounded provider-neutral context with approved rules separated from advisory history. */
export async function buildMemoryContext(
  store: ProjectMemoryStore,
  query: string,
  paths: string[] = [],
  limit = 12,
): Promise<MemoryContext> {
  const config = await store.readConfig();
  const records = await store.listRecords();
  const memory = records.filter((record): record is MemoryRecord => record.kind !== 'review');
  const reviewState = resolveReviewStates(records
    .filter((record): record is ReviewRecord => record.kind === 'review'));
  const reviews = reviewState.latest;
  const superseded = supersededRecordIds(memory, reviews);
  const queryTerms = terms(query);
  const ruleClassifications = new Map(memory
    .filter((record) => record.kind === 'rule_candidate')
    .map((record) => [record.id, reviews.get(record.id)?.classification ?? classifyRule(record)]));
  const knownAreas = [...new Set([...ruleClassifications.values()].flatMap((item) => item.areas))];
  const classification = classifyTask(query, paths, knownAreas);
  const ranked = memory
    .filter((record) => !superseded.has(record.id))
    .map((record) => {
      const match = ruleClassifications.has(record.id)
        ? ruleMatch(ruleClassifications.get(record.id)!, classification) : undefined;
      const applicableRule = record.kind === 'rule_candidate'
        && reviews.get(record.id)?.verdict === 'approved' && match?.compatible === true;
      const score = relevance(record, queryTerms, paths)
        + ((match?.areas.length ?? 0) * 12)
        + ((match?.languages.length ?? 0) * 8)
        + ((match?.testTypes.length ?? 0) * 10);
      return { record, score, match, applicableRule };
    })
    .filter(({ score, applicableRule }) => score > 0 || queryTerms.size === 0 || applicableRule)
    .sort((left, right) => right.score - left.score
      || right.record.createdAt.localeCompare(left.record.createdAt)
      || left.record.id.localeCompare(right.record.id));
  const applicableEntries = ranked.filter(({ applicableRule }) => applicableRule);
  const keyedRules = new Map<string, string[]>();
  for (const { record } of applicableEntries) {
    const key = ruleKey(record);
    if (key) keyedRules.set(key, [...(keyedRules.get(key) ?? []), record.id]);
  }
  const ruleKeyConflicts = new Map<string, string>();
  for (const [key, ids] of keyedRules) {
    if (ids.length > 1) for (const id of ids) ruleKeyConflicts.set(id, key);
  }
  const approvedRules = applicableEntries
    .filter(({ record }) => !ruleKeyConflicts.has(record.id))
    .map(({ record }) => record);
  const history = ranked
    .filter(({ record }) => record.kind !== 'rule_candidate')
    .map(({ record }) => record);
  const selectedRules: MemoryRecord[] = [];
  const selectedHistory: MemoryRecord[] = [];
  let truncated = false;
  for (const record of [...approvedRules, ...history]) {
    const target = record.kind === 'rule_candidate' ? selectedRules : selectedHistory;
    if (selectedRules.length + selectedHistory.length >= Math.min(Math.max(limit, 1), 30)
      || serializedCharacters([...selectedRules, ...selectedHistory, record]) > config.maxContextCharacters) {
      truncated = true;
      continue;
    }
    target.push(record);
  }
  const conflicts = memory
    .filter((record) => superseded.has(record.id))
    .map((record) => ({ recordId: record.id, reason: 'superseded' }));
  for (const [recordId] of reviewState.conflicts) conflicts.push({ recordId, reason: 'review-conflict' });
  for (const [recordId, key] of ruleKeyConflicts) {
    conflicts.push({ recordId, reason: `rule-key-conflict:${key}` });
  }
  return {
    projectId: config.projectId,
    query,
    classification,
    approvedRules: selectedRules,
    ruleMatches: selectedRules.map((record) => {
      const match = ranked.find((entry) => entry.record.id === record.id)?.match;
      return {
        recordId: record.id,
        areas: match?.areas ?? [],
        languages: match?.languages ?? [],
        testTypes: match?.testTypes ?? [],
      };
    }),
    relevantHistory: selectedHistory,
    conflicts,
    truncated,
  };
}

function incompatibilityReason(rule: RuleClassification, task: RuleClassification): string | undefined {
  if (rule.areas.length > 0 && task.areas.length > 0
    && facetMatches(rule.areas, task.areas).length === 0) return 'area-mismatch';
  if (rule.languages.length > 0 && task.languages.length > 0
    && facetMatches(rule.languages, task.languages).length === 0) return 'language-mismatch';
  if (rule.testTypes.length > 0 && task.testTypes.length === 0) return 'test-rule-for-non-test-task';
  if (rule.testTypes.length > 0 && task.testTypes.length > 0
    && facetMatches(rule.testTypes, task.testTypes, true).length === 0) return 'test-type-mismatch';
  return undefined;
}

/** Explains selected and excluded rules without changing the bounded agent context. */
export async function explainMemoryContext(
  store: ProjectMemoryStore,
  query: string,
  paths: string[] = [],
  limit = 100,
): Promise<MemoryContextExplanation> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be an integer from 1 to 200');
  const context = await buildMemoryContext(store, query, paths);
  const records = await store.listRecords();
  const memory = records.filter((record): record is MemoryRecord => record.kind !== 'review');
  const reviewState = resolveReviewStates(records
    .filter((record): record is ReviewRecord => record.kind === 'review'));
  const superseded = supersededRecordIds(memory, reviewState.latest);
  const selected = new Set(context.approvedRules.map((record) => record.id));
  const conflicts = new Map(context.conflicts.map((conflict) => [conflict.recordId, conflict.reason]));
  const decisions = memory
    .filter((record) => record.kind === 'rule_candidate')
    .map((record) => {
      const review = reviewState.latest.get(record.id);
      const state: RuleCandidateState = reviewState.conflicts.has(record.id)
        ? 'conflict' : review?.verdict ?? 'pending';
      const classification = review?.classification ?? classifyRule(record);
      let reason = selected.has(record.id) ? 'selected' : conflicts.get(record.id);
      if (!reason && superseded.has(record.id)) reason = 'superseded';
      if (!reason && state !== 'approved') reason = state;
      if (!reason) reason = incompatibilityReason(classification, context.classification)
        ?? 'context-limit-or-lower-relevance';
      return {
        recordId: record.id,
        summary: record.summary,
        state,
        classification,
        outcome: selected.has(record.id) ? 'selected' as const : 'excluded' as const,
        reason,
      };
    })
    .sort((left, right) => Number(right.outcome === 'selected') - Number(left.outcome === 'selected')
      || compareCatalogText(left.summary, right.summary)
      || compareCatalogText(left.recordId, right.recordId));
  return { context, decisions: decisions.slice(0, limit), truncated: decisions.length > limit };
}

/** Lists rule candidates with cursor pagination and fail-closed review-conflict state. */
export async function listRuleCandidates(
  store: ProjectMemoryStore,
  cursor?: string,
  limit = 20,
): Promise<RuleCandidatePage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50');
  const records = await store.listRecords();
  const reviewState = resolveReviewStates(records
    .filter((record): record is ReviewRecord => record.kind === 'review'));
  const candidates = records
    .filter((record): record is MemoryRecord => record.kind === 'rule_candidate')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  const start = cursor ? candidates.findIndex((record) => record.id === cursor) + 1 : 0;
  if (cursor && start === 0) throw new Error('Unknown candidate cursor');
  const page = candidates.slice(start, start + limit);
  const items = page.map((record) => candidateSummary(record, reviewState));
  return {
    items,
    nextCursor: start + limit < candidates.length ? page.at(-1)?.id : undefined,
  };
}

/** Reports noncanonical or suspicious rule taxonomy without mutating immutable records. */
export async function inspectRuleTaxonomy(store: ProjectMemoryStore): Promise<string[]> {
  const records = await store.listRecords();
  const reviewState = resolveReviewStates(records
    .filter((record): record is ReviewRecord => record.kind === 'review'));
  const warnings: string[] = [];
  for (const record of records.filter((item): item is MemoryRecord => item.kind === 'rule_candidate')) {
    const classification = reviewState.latest.get(record.id)?.classification ?? classifyRule(record);
    for (const language of classification.languages) {
      if (!(KNOWN_RULE_LANGUAGES as readonly string[]).includes(language)) {
        warnings.push(`unknown-language:${language}:rule:${record.id}`);
      }
    }
    for (const testType of classification.testTypes) {
      if (!(KNOWN_RULE_TEST_TYPES as readonly string[]).includes(testType)) {
        warnings.push(`unknown-test-type:${testType}:rule:${record.id}`);
      }
    }
    for (const tag of record.tags.filter((value) => /^(area|domain|language|lang|test|test-type):/u.test(value))) {
      const prefix = tag.slice(0, tag.indexOf(':'));
      const key: keyof RuleClassification = ['language', 'lang'].includes(prefix)
        ? 'languages' : ['test', 'test-type'].includes(prefix) ? 'testTypes' : 'areas';
      const value = normalizeRuleFacet(key, tag.slice(tag.indexOf(':') + 1));
      if (!/^[a-z0-9][a-z0-9.-]*$/u.test(value)) {
        warnings.push(`invalid-classification-tag:${tag}:rule:${record.id}`);
      }
    }
    const keys = taggedFacets(record.tags, ['rule-key:']);
    if (keys.length > 1) warnings.push(`multiple-rule-keys:${record.id}`);
  }
  return [...new Set(warnings)].sort();
}

function catalogSortValue(values: string[]): string {
  return values[0] ?? '\uffff';
}

function compareCatalogText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Lists all rules in a deterministic area, language, test-type and summary order. */
export async function listRules(
  store: ProjectMemoryStore,
  filters: RuleCatalogFilters = {},
  cursor?: string,
  limit = 50,
): Promise<RuleCatalogPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit must be an integer from 1 to 50');
  if (filters.state && !['pending', 'approved', 'rejected', 'revoked', 'superseded', 'conflict']
    .includes(filters.state)) throw new Error('Invalid rule state filter');
  const normalizedFilters: RuleCatalogFilters = {
    state: filters.state,
    area: normalizedClassificationFilter('areas', filters.area),
    language: normalizedClassificationFilter('languages', filters.language),
    testType: normalizedClassificationFilter('testTypes', filters.testType),
  };
  if (filters.area && !normalizedFilters.area) throw new Error('Invalid area filter');
  if (filters.language && !normalizedFilters.language) throw new Error('Invalid language filter');
  if (filters.testType && !normalizedFilters.testType) throw new Error('Invalid testType filter');
  const records = await store.listRecords();
  const reviewState = resolveReviewStates(records
    .filter((record): record is ReviewRecord => record.kind === 'review'));
  const items = records
    .filter((record): record is MemoryRecord => record.kind === 'rule_candidate')
    .map((record) => candidateSummary(record, reviewState))
    .filter((item) => !normalizedFilters.state || item.state === normalizedFilters.state)
    .filter((item) => !normalizedFilters.area || item.classification.areas.includes(normalizedFilters.area))
    .filter((item) => !normalizedFilters.language
      || item.classification.languages.includes(normalizedFilters.language))
    .filter((item) => !normalizedFilters.testType
      || item.classification.testTypes.includes(normalizedFilters.testType))
    .sort((left, right) => compareCatalogText(
      catalogSortValue(left.classification.areas), catalogSortValue(right.classification.areas),
    ) || compareCatalogText(
      catalogSortValue(left.classification.languages), catalogSortValue(right.classification.languages),
    ) || compareCatalogText(
      catalogSortValue(left.classification.testTypes), catalogSortValue(right.classification.testTypes),
    ) || compareCatalogText(left.summary, right.summary) || compareCatalogText(left.id, right.id));
  const start = cursor ? items.findIndex((item) => item.id === cursor) + 1 : 0;
  if (cursor && start === 0) throw new Error('Unknown rule cursor');
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextCursor: start + limit < items.length ? page.at(-1)?.id : undefined,
    total: items.length,
    filters: normalizedFilters,
  };
}
