#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildMemoryContext,
  classifyRuleForReview,
  classifyTask,
  explainMemoryContext,
  inspectRuleTaxonomy,
  LANGUAGE_TEST_RULE_TAG,
  listReviewFacets,
  listRuleCandidates,
  listRules,
  supersededRecordIds,
} from './context.js';
import { resolveProjectMemoryIdentity } from './identity.js';
import { inspectProjectMemoryIntegration, PROJECT_MEMORY_CHAT_WORKFLOW, projectMemoryPackageVersion } from './setup.js';
import { ProjectMemoryStore, resolveReviewStates } from './store.js';
import { PENDING_MERGE_TAG } from './types.js';
import type {
  MemoryRecord,
  RecordMemoryInput,
  ReviewVerdict,
  RuleCandidateState,
  RuleClassification,
} from './types.js';
import {
  assertNoSecrets,
  normalizeRuleFacet,
  parseRecordInput,
  parseRuleClassification,
  relativeProjectPath,
  stringArray,
  stringValue,
} from './validation.js';

const SERVER_INSTRUCTIONS = 'Before changing code, call prooflore_context with the task and affected paths. Treat only approvedRules as rules; history is advisory evidence. After verified work, record durable decisions, corrections or outcomes. Agent writes use the server-bound developer identity; never infer or supply developerId. Propose reusable rules as candidates and classify them with language: and test: tags when applicable. Chat review requires client-mediated human elicitation; agents cannot approve, revoke or restore rules. Revoked rules remain in immutable history and may be restored only by a later human approval. Never store secrets, raw transcripts or unsupported claims. Report optional postinstall configuration only when the user asks about it.';

export type ProjectMemoryRuntimeIdentity = {
  developerId?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
};

export type ProjectMemoryHumanReview = (
  candidate: MemoryRecord,
  classification: RuleClassification,
  allowedVerdicts: readonly ReviewVerdict[],
  presentation?: { locale: string; translatedSummary?: string; replacedSummaries?: string[]; tags?: string[] },
) => Promise<{
  confirmed: true;
  verdict: ReviewVerdict;
  reason: string;
  classification?: RuleClassification;
  tags?: string[];
  localOnly?: boolean;
  editedSummary?: string;
} | undefined>;
type PendingRuleEdit = { originalId: string; reviewId?: string; input: RecordMemoryInput; classification: RuleClassification; tags?: string[]; reason: string };

export const HUMAN_REVIEW_TIMEOUT_MS = 2_147_483_647;

/** Builds deterministic, prefilled review values from server-bound identity and classification. */
export function projectMemoryReviewDefaults(
  developerId: string,
  classification: RuleClassification,
): {
  developerId: string;
  reason: string;
  areas: string;
  languages: string;
  testTypes: string;
} {
  const facet = (values: string[]): string => values.length > 0 ? values.join(', ') : 'global';
  return {
    developerId,
    reason: `Evidence and applicability reviewed by ${developerId}.`,
    areas: classification.areas.join(', '),
    languages: classification.languages.join(', '),
    testTypes: classification.testTypes.join(', '),
  };
}

const objectSchema = { type: 'object', additionalProperties: false } as const;
const evidenceSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', maxLength: 256 },
    revision: { type: 'string', maxLength: 128 },
    note: { type: 'string', maxLength: 1000 },
  },
};
const ruleAssessmentSchema = {
  ...objectSchema,
  description: 'For each completed task, provide candidateIds for newly saved rules with evidence, or a specific reason why no new rule is warranted.',
  properties: {
    disposition: { type: 'string', enum: ['no_reusable_practice', 'insufficient_evidence', 'existing_rule'], description: 'Required with reason. Existing implementation or outcome history is not an existing rule.' },
    existingRuleId: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Required for existing_rule. Reference the pending or approved rule that already covers the practice or that you offered to extend.' },
    reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'For no_reusable_practice, name the strongest practice considered and explain why it would not help a similar future change. For insufficient_evidence, identify the missing verification and assess any independently verified parts separately.' },
    candidateIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
  },
} as const;
const recordOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    projectId: { type: 'string' },
    kind: { type: 'string' },
    localOnly: { type: 'boolean', const: true },
    summary: { type: 'string' },
    rationale: { type: 'string' },
    ruleAssessment: ruleAssessmentSchema,
    tags: { type: 'array', items: { type: 'string' } },
    scope: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: evidenceSchema },
    actor: { type: 'object' },
    supersedes: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
  },
  required: ['schemaVersion', 'id', 'projectId', 'kind', 'summary', 'tags', 'scope', 'evidence', 'actor', 'supersedes', 'createdAt'],
} as const;

/** Stable MCP tool catalog shared by stdio runtime and contract tests. */
export const PROJECT_MEMORY_TOOLS: Tool[] = [
  {
    name: 'prooflore_context',
    description: 'Retrieve bounded project context and automatically select compatible human-approved rules from the task and affected paths.',
    inputSchema: {
      ...objectSchema,
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 4000 },
        paths: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        limit: { type: 'integer', minimum: 1, default: 12, description: 'Requested entry count. The server returns at most 30 entries within the context character budget.' },
      },
      required: ['task'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string' },
        classification: { type: 'object' },
        approvedRules: { type: 'array', items: recordOutputSchema },
        ruleBudget: { type: 'object' },
        ruleMatches: { type: 'array', items: { type: 'object' } },
        relevantHistory: { type: 'array', items: recordOutputSchema },
        conflicts: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
        notices: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'projectId', 'query', 'classification', 'approvedRules', 'ruleMatches',
        'relevantHistory', 'conflicts', 'truncated', 'notices',
      ],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_explain_context',
    description: 'Explain why approved rules were selected or excluded for a task without changing project state.',
    inputSchema: {
      ...objectSchema,
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 4000 },
        paths: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['task'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        context: { type: 'object' },
        decisions: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
      },
      required: ['context', 'decisions', 'truncated'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_get',
    description: 'Read one immutable project-memory record by its stable SHA-256 identifier.',
    inputSchema: {
      ...objectSchema,
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      required: ['id'],
    },
    outputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_status',
    description: 'Inspect project-memory health, record counts and human review state.',
    inputSchema: { ...objectSchema, properties: {} },
    outputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        records: { type: 'integer' },
        candidates: { type: 'integer' },
        approvedRules: { type: 'integer' },
        rejectedRules: { type: 'integer' },
        revokedRules: { type: 'integer' },
        reviewConflicts: { type: 'integer' },
        storeDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        contributors: { type: 'array', items: { type: 'object' } },
        corruptedRecords: { type: 'array', items: { type: 'string' } },
        taxonomyWarnings: { type: 'array', items: { type: 'string' } },
        identity: { type: 'object' },
        integration: { type: 'object' },
      },
      required: [
        'projectId', 'records', 'candidates', 'approvedRules', 'rejectedRules', 'revokedRules', 'reviewConflicts',
        'storeDigest', 'contributors', 'corruptedRecords', 'taxonomyWarnings', 'identity', 'integration',
      ],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_candidates',
    description: 'List rule candidates and their pending, reviewed or conflict state for chat review.',
    inputSchema: {
      ...objectSchema,
      properties: {
        cursor: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        limit: { type: 'integer', minimum: 1, default: 20, description: 'Requested page size. The server returns at most 50 items. Use nextCursor for further pages.' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        nextCursor: { type: 'string' },
      },
      required: ['items'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_rules',
    description: 'List rules sorted by area, language and test type, with optional classification and lifecycle filters. For a request to list rules in chat, pass state approved unless another status is requested. Pass language, tag, and testType for the requested filters and combine them when asked. Use tags for tools such as Maestro and testType for categories such as unit or e2e. For a general or filtered request, show a table with Rule, Tags, Programming languages, and Test types. Translate rule summaries into the chat language by default. When asked for the original, show the exact stored summary without translation or paraphrase. If the approved catalog is empty, say that there are no active rules in the language of the latest user message (Ukrainian: Немає чинних затверджених правил) and end the answer. Include pending candidates or historical versions only if the user explicitly requests them. Omit state only when all statuses are needed.',
    inputSchema: {
      ...objectSchema,
      properties: {
        state: {
          type: 'string',
          enum: ['pending', 'approved', 'rejected', 'revoked', 'superseded', 'conflict'],
        },
        tag: { type: 'string', minLength: 1, maxLength: 64, description: 'Exact catalog tag, case-insensitive.' },
        area: { type: 'string', minLength: 1, maxLength: 64 },
        language: { type: 'string', minLength: 1, maxLength: 64 },
        testType: { type: 'string', minLength: 1, maxLength: 64 },
        cursor: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        limit: { type: 'integer', minimum: 1, default: 50, description: 'Requested page size. The server returns at most 50 items. Use nextCursor for further pages.' },
      },
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object' } },
        nextCursor: { type: 'string' },
        total: { type: 'integer' },
        filters: { type: 'object' },
        message: { type: 'string', description: 'Display this empty-state message in the chat language when present.' },
      },
      required: ['items', 'total', 'filters'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_rule_history',
    description: 'Read the immutable human review history for one rule, including revocation, restoration, reviewer, reason and date.',
    inputSchema: {
      ...objectSchema,
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } } },
      required: ['items'],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_record',
    description: 'Record a verified decision, convention, correction, outcome or exemplar with developer and agent provenance. Exact retries deduplicate. To finish a task, record an outcome with ruleAssessment. Save supported candidates first and reference their IDs, or save a concrete reason in the internal ruleAssessment. When there is no candidate, confirm a requested outcome write without mentioning ruleAssessment or its reason unless explicitly asked about the assessment.',
    inputSchema: {
      ...objectSchema,
      properties: {
        localOnly: { type: 'boolean', description: 'Keep this record on this machine and out of the shared Git directory.' },
        ruleAssessment: ruleAssessmentSchema,
        kind: { type: 'string', enum: ['decision', 'convention', 'correction', 'outcome', 'exemplar'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        scope: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        evidence: { type: 'array', maxItems: 20, items: evidenceSchema },
        supersedes: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      },
      required: ['kind', 'summary'],
    },
    outputSchema: {
      type: 'object',
      properties: { record: recordOutputSchema, created: { type: 'boolean' } },
      required: ['record', 'created'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_propose_rule',
    description: 'Propose a distinct practice that transfers to similar tasks, with concrete evidence. Call prooflore_rules before saving a standalone candidate to check both pending and approved rules. prooflore_context alone does not cover pending candidates. If an unreviewed pending draft needs a supported addition, call with mergePendingId and the complete combined English summary. Preserve prior requirements and exceptions. If the matching rule is approved, offer an extension and wait before writing. Reuse equivalent rules without writing. Write the summary and rationale in English. Add a language tag and name that language in the rule text only when applicability depends on it. A source or test file extension does not establish a language requirement. Use only language and test type for applicability. For a personal rule, set localOnly before saving the candidate. The proposal remains advisory until a human reviews it through client elicitation or the CLI fallback.',
    inputSchema: {
      ...objectSchema,
      properties: {
        mergePendingId: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'Pending draft to consolidate. Supply the complete combined summary and new evidence.' },
        localOnly: { type: 'boolean', description: 'Keep this record on this machine and out of the shared Git directory.' },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        scope: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        evidence: { type: 'array', minItems: 1, maxItems: 20, items: evidenceSchema },
        supersedes: { type: 'array', maxItems: 20, items: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      },
      required: ['summary', 'rationale', 'evidence'],
    },
    outputSchema: {
      type: 'object',
      properties: { record: recordOutputSchema, created: { type: 'boolean' } },
      required: ['record', 'created'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_review_rule',
    description: 'Ask the connected client to show a human confirmation form. For non-English chats, pass the chat locale and faithful translations of the stored summary and each replaced version. For a numbered pending selection, refresh the pending catalog and pass expectedState pending. The connected client collects the human verdict. If a localized edit is approved, the result contains the exact submitted text and a recovery token for the agent to translate. The server supplies reviewer identity and review metadata.',
    inputSchema: {
      ...objectSchema,
      properties: {
        id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        expectedState: { type: 'string', const: 'pending', description: 'Guard a selection from the pending catalog.' },
        locale: { type: 'string', maxLength: 64, description: 'Chat language as a BCP 47 tag, for example uk.' },
        translatedSummary: { type: 'string', minLength: 1, maxLength: 6000, description: 'Faithful display-only translation of the stored rule summary into the chat language.' },
        translatedReplacements: {
          type: 'array', maxItems: 20, description: 'Display-only translations keyed by the IDs in supersedes.',
          items: {
            ...objectSchema,
            properties: {
              id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
              summary: { type: 'string', minLength: 1, maxLength: 6000 },
            },
            required: ['id', 'summary'],
          },
        },
      },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['approved_pending_translation'] },
        approval: {
          type: 'object',
          properties: {
            source: { const: 'mcp_form' },
            verdict: { const: 'approved' },
            ruleId: { type: 'string' },
          },
          required: ['source', 'verdict', 'ruleId'],
        },
        translation: { type: 'object' },
        reviewed: { type: 'boolean' },
        review: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['reviewed'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'prooflore_finish_rule_edit',
    description: 'Complete a human-approved localized rule edit using the recovery token from prooflore_review_rule. Translate only the submitted text into English and preserve constraints. Writes an immutable successor and the existing human decision to the local project store, preserving the visibility chosen in the form. The same request can safely be retried. Respect client approval checks and report any refusal.',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    inputSchema: {
      ...objectSchema,
      properties: {
        token: { type: 'string', maxLength: 36 },
        englishSummary: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['token', 'englishSummary'],
    },
  },
];

function result(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

/** Combines checked options with new entries and validates the selected values. */
function selectedReviewFacets(
  content: Record<string, unknown>,
  key: 'languages' | 'testTypes',
  options: string[],
  defaults: string[],
): string[] {
  const selected = options.length === 0 || content[key] === undefined
    ? defaults : stringArray(content[key], key, 20, 64);
  if (selected.some((value) => !options.includes(value))) {
    throw new Error(`${key} contains a value outside the offered choices`);
  }
  const extra = content[`${key}New`];
  if (extra !== undefined && typeof extra !== 'string') throw new Error(`${key}New must be text`);
  if (typeof extra === 'string' && extra.length > 1320) throw new Error(`${key}New is too long`);
  const additions = (extra ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return [...new Set([...selected, ...additions].map((value) => normalizeRuleFacet(key, value)))];
}

function boundAgentIdentity(identity: ProjectMemoryRuntimeIdentity | undefined): Record<string, string> {
  if (!identity?.developerId) {
    throw new Error('ProofLore developer identity is not configured; set the repository Git user.name or run `npx prooflore identity set DEVELOPER_ID`');
  }
  return Object.fromEntries(Object.entries(identity)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0));
}

/** Caps a positive result count at the endpoint limit. */
function boundedResultLimit(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const limit = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value) : value;
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('limit must be a positive integer');
  }
  return Math.min(limit, maximum);
}

const RULE_COMPARISON_STOP_WORDS = new Set(
  'about after all also and are before each for from has have its only should that the their them then these this use using when where which will with'.split(' '),
);

/** Extracts significant terms for a conservative duplicate check without a model call. */
function ruleComparisonTerms(summary: string): Set<string> {
  return new Set((summary.toLowerCase().match(/[a-z]{3,}/gu) ?? [])
    .filter((word) => !RULE_COMPARISON_STOP_WORDS.has(word))
    .map((word) => word.replace(/(?:ation|ing|ed|s)$/u, '').replace(/e$/u, '')));
}

/** Finds an existing rule with substantial shared wording before an unlinked write. */
async function overlappingRule(store: ProjectMemoryStore, input: RecordMemoryInput, pendingId?: string) {
  const proposed = ruleComparisonTerms(input.summary);
  let cursor: string | undefined;
  do {
    const page = await listRules(store, pendingId ? { state: 'approved' } : {}, cursor);
    const overlap = page.items.find((item) => {
      if (item.id === pendingId || item.localOnly !== input.localOnly || input.supersedes?.includes(item.id)
        || (item.state !== 'approved' && item.state !== 'pending')) return false;
      if (item.summary.trim().toLowerCase() === input.summary.trim().toLowerCase()) return true;
      const existing = ruleComparisonTerms(item.summary);
      const shared = [...existing].filter((word) => proposed.has(word)).length;
      return shared >= 5 && shared / Math.min(existing.size, proposed.size) >= 0.65;
    });
    if (overlap) return overlap;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

/** Reports a confirmed form verdict while the edited rule awaits its English text. */
function pendingRuleEditResult(token: string, edit: PendingRuleEdit): CallToolResult {
  return result({
    reviewed: false,
    status: 'approved_pending_translation',
    approval: { source: 'mcp_form', verdict: 'approved', ruleId: edit.originalId },
    translation: { token, text: edit.input.summary },
  });
}

/** Saves the edited text as a human-authored successor and records the submitted approval. */
async function saveApprovedRuleEdit(store: ProjectMemoryStore, edit: PendingRuleEdit, summary: string): Promise<CallToolResult> {
  let input = parseRecordInput({ ...edit.input, summary });
  const history = resolveReviewStates(await store.ruleHistory(edit.originalId));
  if (history.conflicts.has(edit.originalId) || history.latest.get(edit.originalId)?.id !== edit.reviewId) {
    throw new Error('The original rule changed after the form opened. Refresh the catalog.');
  }
  const claim = { edit, summary };
  if (!await store.writeEditRecovery(edit.originalId, claim)) {
    const saved = await store.readEditRecovery(edit.originalId) as typeof claim | undefined;
    if (!saved || JSON.stringify(saved.edit) !== JSON.stringify(edit)) {
      throw new Error('This rule already has a different approved edit. Refresh the catalog.');
    }
    input = parseRecordInput({ ...edit.input, summary: saved.summary });
  }
  const { record } = await store.record(input, 'human');
  const review = await store.review(record.id, 'approved', edit.reason, input.developerId, edit.classification, edit.tags, true);
  return result({ reviewed: true, ...review });
}

/** Executes one validated provider-neutral memory tool against a project root. */
export async function callProjectMemoryTool(
  store: ProjectMemoryStore,
  name: string,
  argumentsValue: unknown,
  options: {
    identity?: ProjectMemoryRuntimeIdentity;
    humanReview?: ProjectMemoryHumanReview;
  } = {},
): Promise<CallToolResult> {
  const args = argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown> : {};
  if (name === 'prooflore_context') {
    const task = stringValue(args.task, 'task', 4000);
    const paths = stringArray(args.paths, 'paths', 30, 256)
      .map((path, index) => relativeProjectPath(path, `paths[${index}]`));
    const limit = boundedResultLimit(args.limit, 12, 30);
    const context = await buildMemoryContext(store, task, paths, limit);
    const integration = await inspectProjectMemoryIntegration(store.root);
    const budget = context.ruleBudget;
    const notices = [...integration.notices];
    if (budget && budget.omitted > 0) {
      notices.push(`ProofLore: ${budget.omitted} of ${budget.applicable} applicable rules exceeded the context budget. Retrieve the omitted rules relevant to the task before proceeding.`);
    } else if (budget) {
      notices.push(`ProofLore: the rule catalog is large or near its context budget (${budget.active} active, ${budget.applicable} applicable). Review overlapping rules for possible consolidation.`);
    }
    return result({ ...context, notices });
  }
  if (name === 'prooflore_explain_context') {
    const task = stringValue(args.task, 'task', 4000);
    const paths = stringArray(args.paths, 'paths', 30, 256)
      .map((path, index) => relativeProjectPath(path, `paths[${index}]`));
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    return result(await explainMemoryContext(store, task, paths, limit));
  }
  if (name === 'prooflore_get') return result(await store.readRecord(stringValue(args.id, 'id', 64)));
  if (name === 'prooflore_status') {
    const integration = await inspectProjectMemoryIntegration(store.root);
    const status = await store.status();
    return result({
      ...status,
      taxonomyWarnings: status.corruptedRecords.length ? [] : await inspectRuleTaxonomy(store),
      identity: integration.identity,
      integration,
    });
  }
  if (name === 'prooflore_candidates') {
    const cursor = args.cursor === undefined ? undefined : stringValue(args.cursor, 'cursor', 64);
    const limit = boundedResultLimit(args.limit, 20, 50);
    return result(await listRuleCandidates(store, cursor, limit));
  }
  if (name === 'prooflore_rules') {
    const limit = boundedResultLimit(args.limit, 50, 50);
    const page = await listRules(store, {
      state: args.state === undefined ? undefined : stringValue(args.state, 'state', 16) as RuleCandidateState,
      area: args.area === undefined ? undefined : stringValue(args.area, 'area', 64),
      language: args.language === undefined ? undefined : stringValue(args.language, 'language', 64),
      tag: args.tag === undefined ? undefined : stringValue(args.tag, 'tag', 64),
      testType: args.testType === undefined ? undefined : stringValue(args.testType, 'testType', 64),
    }, args.cursor === undefined ? undefined : stringValue(args.cursor, 'cursor', 64), limit);
    return result(page.filters.state === 'approved' && page.total === 0
      ? { ...page, message: 'No active approved rules.' }
      : page);
  }
  if (name === 'prooflore_rule_history') {
    return result({ items: await store.ruleHistory(stringValue(args.id, 'id', 64)) });
  }
  if (name === 'prooflore_record') {
    const runtimeIdentity = boundAgentIdentity(options.identity);
    const input = parseRecordInput({ ...args, ...runtimeIdentity });
    if (input.kind === 'rule_candidate') throw new Error('Use prooflore_propose_rule for rule candidates');
    if (input.kind === 'outcome' && !input.ruleAssessment) {
      throw new Error('A task outcome requires ruleAssessment: save supported candidates and supply candidateIds, or explain why no new rule is warranted in reason.');
    }
    if (input.kind === 'outcome' && input.ruleAssessment && 'reason' in input.ruleAssessment) {
      const { disposition, existingRuleId } = input.ruleAssessment;
      if (!disposition) throw new Error('A no-rule assessment requires a disposition and a specific reason');
      if (disposition === 'existing_rule') {
        let cursor: string | undefined;
        let found = false;
        do {
          const page = await listRules(store, {}, cursor);
          found = page.items.some(rule => rule.id === existingRuleId
            && (rule.state === 'pending' || rule.state === 'approved'));
          cursor = page.nextCursor;
        } while (!found && cursor);
        if (!found) throw new Error('existingRuleId must refer to a pending or approved rule, not an outcome');
      }
    }
    if (input.ruleAssessment && 'candidateIds' in input.ruleAssessment) {
      for (const id of input.ruleAssessment.candidateIds) {
        const candidate = await store.readRecord(id);
        if (candidate.kind !== 'rule_candidate' || !candidate.evidence.length
          || candidate.actor.developerId !== runtimeIdentity.developerId) {
          throw new Error('ruleAssessment.candidateIds must refer to supported rule candidates from the current developer');
        }
      }
    }
    const saved = await store.record(input, 'agent');
    if (input.kind === 'outcome' && input.ruleAssessment && 'reason' in input.ruleAssessment) {
      const { ruleAssessment: _internalAssessment, ...record } = saved.record;
      return result({ ...saved, record });
    }
    return result(saved);
  }
  if (name === 'prooflore_propose_rule') {
    const runtimeIdentity = boundAgentIdentity(options.identity);
    const tags = stringArray(args.tags, 'tags', 20, 64)
      .filter((tag) => !/^(?:area|domain):/iu.test(tag) && tag !== LANGUAGE_TEST_RULE_TAG
        && tag.toLowerCase() !== PENDING_MERGE_TAG);
    const input = parseRecordInput({
      ...args, ...runtimeIdentity, kind: 'rule_candidate',
      tags: [...tags, LANGUAGE_TEST_RULE_TAG],
    });
    if (args.mergePendingId !== undefined) {
      const id = stringValue(args.mergePendingId, 'mergePendingId', 64);
      const target = await store.readRecord(id);
      if (target.kind !== 'rule_candidate' || Boolean(input.localOnly) !== Boolean(target.localOnly)) {
        throw new Error('A draft merge requires a rule candidate with the same visibility.');
      }
      if (input.supersedes?.length) throw new Error('Use mergePendingId by itself for a draft merge.');
      if (!input.evidence?.length) throw new Error('A draft merge requires new evidence.');
      const records = await store.listRecords();
      const memory = records.filter((record): record is MemoryRecord => record.kind !== 'review');
      const states = resolveReviewStates(records.filter((record) => record.kind === 'review'));
      if (states.latest.has(id) || states.conflicts.has(id)) {
        throw new Error('Only unreviewed pending rules can be merged. Offer to extend approved rules.');
      }
      if (target.summary.trim().toLowerCase() === input.summary.trim().toLowerCase()) {
        return result({ record: target, created: false });
      }
      const rationale = [...new Set([target.rationale, input.rationale].filter(Boolean))].join('\n\n');
      const evidence = [...new Map([...target.evidence, ...input.evidence]
        .map((item) => [JSON.stringify(item), item])).values()];
      if (target.supersedes.length && !target.tags.includes(PENDING_MERGE_TAG)) {
        throw new Error('This draft already proposes a replacement. Review that replacement before consolidating it.');
      }
      const merged = parseRecordInput({
        ...input, rationale, evidence,
        scope: [...new Set([...target.scope, ...(input.scope ?? [])])],
        tags: [...new Set([...target.tags.filter((tag) => tag !== PENDING_MERGE_TAG), ...tags,
          LANGUAGE_TEST_RULE_TAG, PENDING_MERGE_TAG])],
        supersedes: [id],
      });
      const existing = memory.find((record) => record.tags.includes(PENDING_MERGE_TAG) && record.supersedes[0] === id
        && record.summary === merged.summary && record.actor.developerId === input.developerId);
      if (existing) return result({ record: existing, created: false });
      if (supersededRecordIds(memory, states.latest, states.conflicts).has(id)) {
        throw new Error('The draft already has a newer version. Refresh the pending catalog before merging.');
      }
      const overlap = await overlappingRule(store, merged, id);
      if (overlap) {
        throw new Error(`Possible overlap with existing approved rule ${overlap.id}: ${overlap.summary}. Offer to extend it and wait before writing.`);
      }
      return result(await store.record(merged, 'agent'));
    }
    const overlap = await overlappingRule(store, input);
    if (overlap) {
      throw new Error(`Possible overlap with existing rule ${overlap.id}: ${overlap.summary} Compare both rules. If this is a broader version, offer to extend the existing rule and record existing_rule. Wait for the user's decision before saving a replacement.`);
    }
    return result(await store.record(input, 'agent'));
  }
  if (name === 'prooflore_finish_rule_edit') {
    const identity = boundAgentIdentity(options.identity);
    const token = stringValue(args.token, 'token', 36);
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(token)) throw new Error('Invalid edit token');
    const edit = await store.readEditRecovery(token) as PendingRuleEdit | undefined;
    if (!edit || edit.input.developerId !== identity.developerId) {
      throw new Error('No pending human-approved edit for this token');
    }
    const summary = stringValue(args.englishSummary, 'englishSummary', 4000);
    if (/[^\p{Script=Latin}\P{L}]/u.test(summary)) throw new Error('Provide the English translation');
    return saveApprovedRuleEdit(store, edit, summary);
  }

  if (name === 'prooflore_review_rule') {
    const reviewerIdentity = boundAgentIdentity(options.identity);
    const id = stringValue(args.id, 'id', 64);
    const candidate = await store.readRecord(id);
    if (candidate.kind !== 'rule_candidate') throw new Error('Only rule candidates can be reviewed');
    const reviewState = resolveReviewStates(await store.ruleHistory(id));
    const latest = reviewState.latest.get(id);
    if (args.expectedState !== undefined && (args.expectedState !== 'pending' || latest || reviewState.conflicts.has(id))) {
      throw new Error('The selected rule is no longer pending. Refresh the pending catalog.');
    }
    const priorEdit = await store.readEditRecovery(id) as { edit: PendingRuleEdit; summary: string } | undefined;
    if (priorEdit?.edit.input.developerId === reviewerIdentity.developerId) {
      return saveApprovedRuleEdit(store, priorEdit.edit, priorEdit.summary);
    }
    const pending = await store.readEditRecovery(`pending-${id}`) as { token: string; edit: PendingRuleEdit; locale?: string } | undefined;
    if (pending?.edit.input.developerId === reviewerIdentity.developerId && pending.edit.reviewId === latest?.id) {
      await store.writeEditRecovery(pending.token, pending.edit);
      return pendingRuleEditResult(pending.token, pending.edit);
    }
    const records = await store.listRecords();
    const states = resolveReviewStates(records.filter((record) => record.kind === 'review'));
    if (!states.latest.has(id) && supersededRecordIds(records.filter((record) => record.kind !== 'review'),
      states.latest, states.conflicts).has(id)) {
      throw new Error('This pending draft has been replaced. Open the current version for review.');
    }
    if (!options.humanReview) throw new Error('Chat review requires a client with MCP form elicitation support');
    const classification = latest?.classification ?? classifyRuleForReview(candidate);
    const allowedVerdicts: readonly ReviewVerdict[] = latest?.verdict === 'approved'
      ? ['approved', 'revoked', 'superseded']
      : ['approved', 'rejected'];
    const locale = args.locale === undefined ? 'en' : new Intl.Locale(stringValue(args.locale, 'locale', 64)).language;
    const displayText = (value: unknown, field: string): string =>
      stringValue(value, field, 6000).replace(/[\p{Bidi_Control}]/gu, '').replace(/\s+/gu, ' ').trim();
    const translatedSummary = args.translatedSummary === undefined ? undefined
      : displayText(args.translatedSummary, 'translatedSummary');
    const translations = new Map<string, string>();
    if (locale !== 'en' && args.translatedReplacements !== undefined) {
      const entries = args.translatedReplacements;
      if (!Array.isArray(entries) || entries.length > 20) throw new Error('Invalid replacement translations');
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') throw new Error('Invalid replacement translation');
        const id = stringValue(entry.id, 'replacement ID', 64);
        const summary = displayText(entry.summary, 'replacement summary');
        if (!candidate.supersedes.includes(id) || translations.has(id) || !summary) {
          throw new Error('Replacement translations must match the stored rule versions');
        }
        translations.set(id, summary);
      }
    }
    const localized = locale !== 'en' && Boolean(translatedSummary);
    const replacedSummaries: string[] = [];
    for (const targetId of candidate.supersedes) {
      const target = await store.readRecord(targetId).catch((error: unknown) => {
        if (latest && !latest.localOnly && latest.verdict !== 'rejected'
          && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (!target) continue;
      if (target.kind !== 'rule_candidate') throw new Error('A replacement must reference an existing rule');
      const translated = translations.get(targetId);
      if (localized && !translated) throw new Error('Translate each replaced rule before opening the localized form');
      replacedSummaries.push(localized && translated ? translated : target.summary);
    }
    const decision = await options.humanReview(candidate, classification, allowedVerdicts, {
      locale,
      replacedSummaries,
      tags: latest?.tags ?? candidate.tags.filter((tag) => !tag.includes(':')),
      translatedSummary: locale !== 'en' ? translatedSummary : undefined,
    });
    if (!decision) return result({ reviewed: false, reason: 'Human declined or cancelled review' });
    if (decision.confirmed !== true) throw new Error('Explicit human confirmation is required');
    if (!allowedVerdicts.includes(decision.verdict)) throw new Error('Verdict is unavailable for this rule');
    const reviewedClassification = parseRuleClassification(decision.classification ?? classification);
    const reason = stringValue(decision.reason, 'reason', 2000);
    assertNoSecrets(reason, 'reason');
    const tags = decision.tags === undefined ? undefined : stringArray(decision.tags, 'review tags', 20, 64);
    tags?.forEach((tag) => assertNoSecrets(tag, 'review tag'));
    if (decision.verdict === 'approved' && decision.editedSummary !== undefined) {
      const edited = stringValue(decision.editedSummary, 'editedSummary', 4000);
      const displayed = localized ? translatedSummary! : candidate.summary;
      if (edited !== displayed && edited !== candidate.summary) {
        const input = parseRecordInput({
          ...candidate,
          kind: 'rule_candidate',
          developerId: reviewerIdentity.developerId,
          summary: edited,
          localOnly: candidate.localOnly || decision.localOnly,
          supersedes: [...new Set([...candidate.supersedes, id])],
        });
        const edit = { originalId: id, reviewId: latest?.id, input, classification: reviewedClassification, tags,
          reason: 'Rule text edited and approved through the ProofLore review form.' };
        if (locale !== 'en' || /[^\p{Script=Latin}\P{L}]/u.test(edited)) {
          const token = randomUUID();
          if (!await store.writeEditRecovery(`pending-${id}`, { token, edit, locale: locale === 'en' ? 'und' : locale })) {
            throw new Error('This rule already has an approved edit. Reopen the same rule to recover it.');
          }
          await store.writeEditRecovery(token, edit);
          return pendingRuleEditResult(token, edit);
        }
        return saveApprovedRuleEdit(store, edit, edited);
      }
    }
    let targetId = id;
    if (decision.localOnly && !candidate.localOnly) {
      if (decision.verdict !== 'approved') throw new Error('Local-only storage is available when approving a rule');
      const { record } = await store.record(parseRecordInput({
        ...candidate,
        ...candidate.actor,
        kind: 'rule_candidate',
        localOnly: true,
        supersedes: [...candidate.supersedes, id],
      }), candidate.actor.kind);
      targetId = record.id;
    }
    const review = await store.review(
      targetId,
      decision.verdict,
      reason,
      reviewerIdentity.developerId,
      reviewedClassification,
      tags,
    );
    return result({ reviewed: true, ...review });
  }
  throw new Error(`Unknown tool: ${name}`);
}

/** Starts the stdio MCP server rooted at the caller's project. */
export async function runProjectMemoryMcp(root = process.env.PROOFLORE_ROOT ?? process.env.PROJECT_MEMORY_ROOT ?? process.cwd()): Promise<void> {
  const store = new ProjectMemoryStore(root);
  await store.readConfig();
  const version = await projectMemoryPackageVersion();
  const integration = await inspectProjectMemoryIntegration(root);
  const instructions = [SERVER_INSTRUCTIONS, PROJECT_MEMORY_CHAT_WORKFLOW, ...integration.notices].join('\n\n');
  const server = new Server(
    { name: 'prooflore', version },
    { capabilities: { tools: {}, resources: {} }, instructions },
  );
  const resolvedIdentity = await resolveProjectMemoryIdentity(root);
  const identity: ProjectMemoryRuntimeIdentity = {
    developerId: resolvedIdentity.developerId,
    provider: process.env.PROOFLORE_PROVIDER ?? process.env.PROJECT_MEMORY_PROVIDER,
    model: process.env.PROOFLORE_MODEL ?? process.env.PROJECT_MEMORY_MODEL,
    sessionId: process.env.PROOFLORE_SESSION_ID ?? process.env.PROJECT_MEMORY_SESSION_ID,
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PROJECT_MEMORY_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callProjectMemoryTool(store, request.params.name, request.params.arguments, {
        identity,
        humanReview: async (candidate, classification, allowedVerdicts, presentation) => {
          if (!server.getClientCapabilities()?.elicitation) {
            throw new Error('Connected client does not support MCP form elicitation; use the CLI fallback');
          }
          const reviewDefaults = projectMemoryReviewDefaults(
            boundAgentIdentity(identity).developerId,
            classification,
          );
          const ukrainian = presentation?.locale === 'uk';
          const labels = ukrainian ? {
            title: 'Перегляд правила', replacementTitle: 'Заміна правила', current: 'НОВА ВЕРСІЯ', previous: 'ПОПЕРЕДНІ ВЕРСІЇ', reviewer: 'Рецензент',
            verdict: 'Рішення',
            languages: 'Мови програмування', testTypes: 'Типи тестів',
            languagesHelp: 'Мови коду, наприклад typescript, javascript. Додавайте через кому, якщо потрібних мов немає в списку.',
            testTypesHelp: 'Наприклад unit, integration, e2e. Додавайте через кому, якщо потрібних типів немає в списку.',
            approved: 'Затвердити', rejected: 'Відхилити', revoked: 'Відкликати', superseded: 'Замінити',
          } : {
            title: 'Review rule', replacementTitle: 'Replace rule', current: 'NEW VERSION', previous: 'PREVIOUS VERSIONS', reviewer: 'Reviewer',
            verdict: 'Verdict',
            languages: 'Programming languages', testTypes: 'Test types',
            languagesHelp: 'Code languages, such as typescript or javascript. Separate values with commas. Add values missing from the list.',
            testTypesHelp: 'For example, unit, integration, or e2e. Separate values with commas. Add values missing from the list.',
            approved: 'Approve', rejected: 'Reject', revoked: 'Revoke', superseded: 'Supersede',
          };
          const knownFacets = await listReviewFacets(store);
          const showTestTypes = classification.testTypes.length > 0
            || classifyTask(candidate.summary, []).testTypes.length > 0
            || /\bmaestro\b/iu.test(candidate.summary);
          const options = {
            languages: [...new Set([...classification.languages, ...knownFacets.languages])].sort(),
            testTypes: showTestTypes ? [...new Set([...classification.testTypes, ...knownFacets.testTypes])].sort() : [],
          };
          const facetChoices = (key: 'languages' | 'testTypes') => options[key].length > 0 ? {
            [key]: {
              type: 'array' as const,
              title: labels[key],
              description: ukrainian ? 'Можна вибрати кілька. Без вибору й нових значень обмеження немає.'
                : 'Select any that apply. Leave both fields empty for no restriction.',
              items: { type: 'string' as const, enum: options[key] },
              default: classification[key],
              maxItems: 20,
            },
          } : {};
          const languagesNew = ukrainian ? 'Нові мови програмування' : 'New programming languages';
          const testTypesNew = ukrainian ? 'Нові типи тестів' : 'New test types';
          const ruleText = presentation?.translatedSummary || candidate.summary;
          const replacedSummaries = presentation?.replacedSummaries ?? [];
          const isReplacement = replacedSummaries.length > 0;
          const previousVersions = replacedSummaries.map(summary => `• ${summary}`).join('\n\n');
          const historyNote = ukrainian
            ? 'Після затвердження попередні версії залишаться в історії.'
            : 'After approval, prior versions remain in history.';
          const body = isReplacement
            ? `${labels.current}\n\n${ruleText}\n\n${labels.previous}\n\n${previousVersions}\n\n${historyNote}`
            : ruleText;
          const reviewer = ukrainian
            ? `${labels.reviewer}: ${reviewDefaults.developerId} (визначено сервером).`
            : `${labels.reviewer}: ${reviewDefaults.developerId} (server-bound).`;
          const visibility = candidate.localOnly
            ? ukrainian ? '\n\nТільки локально. Правило та рішення зберігаються на цьому комп’ютері.' : '\n\nLocal only. The rule and decision stay on this computer.'
            : '';
          const elicited = await server.elicitInput({
            mode: 'form',
            message: `${isReplacement ? labels.replacementTitle : labels.title}\n\n${body}\n\n${reviewer}${visibility}`,
            requestedSchema: {
              type: 'object',
              properties: {
                aRuleText: {
                  type: 'string',
                  title: ukrainian ? 'Правило' : 'Rule',
                  description: ukrainian ? 'Зміни зберігаються після затвердження.' : 'Edits are saved on approval.',
                  default: ruleText,
                  maxLength: Math.max(4000, ruleText.length),
                },
                tags: {
                  type: 'string',
                  title: ukrainian ? 'Теги' : 'Tags',
                  description: ukrainian ? 'Необов’язково. Бібліотеки, інструменти або інші мітки через кому, наприклад maestro, jest.'
                    : 'Optional. Enter libraries, tools, or other labels separated by commas, such as maestro, jest.',
                  maxLength: 1320,
                  default: presentation?.tags?.join(', ') ?? '',
                },
                ...facetChoices('languages'),
                languagesNew: {
                  type: 'string', title: languagesNew, description: labels.languagesHelp, maxLength: 1320,
                },
                ...(showTestTypes ? {
                  ...facetChoices('testTypes'),
                  testTypesNew: {
                    type: 'string' as const, title: testTypesNew, description: labels.testTypesHelp, maxLength: 1320,
                  },
                } : {}),
                ...(!candidate.localOnly ? {
                  uLocalOnly: {
                    type: 'boolean' as const,
                    title: ukrainian ? 'Залишити тільки локально' : 'Keep only on this computer',
                    description: ukrainian ? 'Схвалена версія та рішення залишаться на цьому комп’ютері.'
                      : 'The approved version and decision stay on this computer.',
                    default: false,
                  },
                } : {}),
                verdict: {
                  type: 'string',
                  title: labels.verdict,
                  oneOf: allowedVerdicts.map(verdict => ({ const: verdict, title: labels[verdict] })),
                },
              },
              required: (['languages', 'testTypes'] as const).filter((key) => options[key].length > 0),
            },
          }, { timeout: HUMAN_REVIEW_TIMEOUT_MS });
          if (elicited.action !== 'accept' || !elicited.content) return undefined;
          const choice = elicited.content.verdict;
          const verdict = allowedVerdicts.find(allowed => allowed === choice);
          if (!verdict) throw new Error('Select a verdict before accepting the form');
          const localOnly = elicited.content.uLocalOnly;
          const submittedRule = elicited.content.aRuleText;
          if (localOnly !== undefined && typeof localOnly !== 'boolean') throw new Error('Local-only selection must be a boolean');
          const submittedTags = elicited.content.tags;
          if (submittedTags !== undefined && (typeof submittedTags !== 'string' || submittedTags.length > 1320)) {
            throw new Error('Tags must be comma-separated text up to 1320 characters');
          }
          const tags = submittedTags === undefined ? undefined
            : submittedTags.split(',').map((tag) => tag.trim()).filter(Boolean);
          return {
            confirmed: true,
            verdict,
            editedSummary: typeof submittedRule === 'string' && submittedRule.trim() !== ruleText
              ? submittedRule : undefined,
            localOnly,
            tags,
            reason: 'Decision submitted through the ProofLore review form.',
            classification: parseRuleClassification({
              areas: classification.areas,
              languages: selectedReviewFacets(elicited.content, 'languages', options.languages, classification.languages),
              testTypes: showTestTypes
                ? selectedReviewFacets(elicited.content, 'testTypes', options.testTypes, classification.testTypes)
                : classification.testTypes,
            }),
          };
        },
      });
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'prooflore://instructions', name: 'Project memory instructions', mimeType: 'text/markdown' },
      { uri: 'prooflore://status', name: 'Project memory status', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'prooflore://instructions') {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: instructions }] };
    }
    if (request.params.uri === 'prooflore://status') {
      const currentIntegration = await inspectProjectMemoryIntegration(root);
      const status = await store.status();
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: 'application/json',
          text: JSON.stringify({
            ...status,
            taxonomyWarnings: status.corruptedRecords.length ? [] : await inspectRuleTaxonomy(store),
            identity: currentIntegration.identity,
            integration: currentIntegration,
          }),
        }],
      };
    }
    throw new Error(`Unknown resource: ${request.params.uri}`);
  });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runProjectMemoryMcp();
}
