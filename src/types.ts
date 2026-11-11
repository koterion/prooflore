export const PROJECT_MEMORY_SCHEMA_VERSION = 1 as const;

export const MEMORY_KINDS = [
  'decision',
  'convention',
  'correction',
  'outcome',
  'exemplar',
  'rule_candidate',
] as const;

export type MemoryKind = typeof MEMORY_KINDS[number];
export type ReviewVerdict = 'approved' | 'rejected' | 'superseded';

export type ProjectMemoryConfig = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION;
  projectId: string;
  createdAt: string;
  maxContextCharacters: number;
};

export type MemoryEvidence = {
  path?: string;
  revision?: string;
  note?: string;
};

export type MemoryActor = {
  kind: 'human' | 'agent';
  developerId: string;
  provider?: string;
  model?: string;
  sessionId?: string;
};

export type MemoryRecord = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION;
  id: string;
  projectId: string;
  kind: MemoryKind;
  summary: string;
  rationale?: string;
  tags: string[];
  scope: string[];
  evidence: MemoryEvidence[];
  actor: MemoryActor;
  supersedes: string[];
  createdAt: string;
};

export type ReviewRecord = {
  schemaVersion: typeof PROJECT_MEMORY_SCHEMA_VERSION;
  id: string;
  projectId: string;
  kind: 'review';
  targetId: string;
  previousReviewId?: string;
  previousReviewIds?: string[];
  verdict: ReviewVerdict;
  reason: string;
  actor: MemoryActor & { kind: 'human' };
  createdAt: string;
};

export type StoredRecord = MemoryRecord | ReviewRecord;

export type RecordMemoryInput = {
  kind: MemoryKind;
  summary: string;
  rationale?: string;
  tags?: string[];
  scope?: string[];
  evidence?: MemoryEvidence[];
  developerId: string;
  provider?: string;
  model?: string;
  sessionId?: string;
  supersedes?: string[];
};

export type MemoryContext = {
  projectId: string;
  query: string;
  approvedRules: MemoryRecord[];
  relevantHistory: MemoryRecord[];
  conflicts: Array<{ recordId: string; reason: string }>;
  truncated: boolean;
};

export type MemoryStatus = {
  projectId: string;
  records: number;
  candidates: number;
  approvedRules: number;
  rejectedRules: number;
  reviewConflicts: number;
  storeDigest: string;
  contributors: Array<{
    developerId: string;
    humanRecords: number;
    agentRecords: number;
    providers: string[];
  }>;
  corruptedRecords: string[];
};

export type RuleCandidateState = 'pending' | ReviewVerdict | 'conflict';

export type RuleCandidateSummary = {
  id: string;
  summary: string;
  scope: string[];
  evidenceCount: number;
  proposedBy: MemoryActor;
  createdAt: string;
  state: RuleCandidateState;
  latestReviewId?: string;
};

export type RuleCandidatePage = {
  items: RuleCandidateSummary[];
  nextCursor?: string;
};
