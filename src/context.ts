import type {
  MemoryContext,
  MemoryRecord,
  ReviewRecord,
  RuleCandidatePage,
  RuleCandidateState,
} from './types.js';
import { ProjectMemoryStore, resolveReviewStates } from './store.js';

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
  const superseded = new Set(memory.flatMap((record) => record.supersedes));
  for (const review of reviews.values()) if (review.verdict === 'superseded') superseded.add(review.targetId);
  const queryTerms = terms(query);
  const ranked = memory
    .filter((record) => !superseded.has(record.id))
    .map((record) => ({ record, score: relevance(record, queryTerms, paths) }))
    .filter(({ score }) => score > 0 || queryTerms.size === 0)
    .sort((left, right) => right.score - left.score
      || right.record.createdAt.localeCompare(left.record.createdAt)
      || left.record.id.localeCompare(right.record.id));
  const approvedRules = ranked
    .filter(({ record }) => record.kind === 'rule_candidate' && reviews.get(record.id)?.verdict === 'approved')
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
  return {
    projectId: config.projectId,
    query,
    approvedRules: selectedRules,
    relevantHistory: selectedHistory,
    conflicts,
    truncated,
  };
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
  const items = page.map((record) => {
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
    };
  });
  return {
    items,
    nextCursor: start + limit < candidates.length ? page.at(-1)?.id : undefined,
  };
}
