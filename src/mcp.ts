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
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildMemoryContext, listRuleCandidates } from './context.js';
import { inspectProjectMemoryIntegration, projectMemoryPackageVersion } from './setup.js';
import { ProjectMemoryStore } from './store.js';
import type { MemoryRecord, ReviewVerdict } from './types.js';
import { parseRecordInput, relativeProjectPath, stringArray, stringValue } from './validation.js';

const SERVER_INSTRUCTIONS = 'Before changing code, call project_memory_context with the task and affected paths. Treat only approvedRules as rules; history is advisory evidence. After verified work, record durable decisions, corrections or outcomes. Propose reusable rules as candidates. Chat review requires client-mediated human elicitation; agents cannot approve candidates. Never store secrets, raw transcripts or unsupported claims.';

export type ProjectMemoryRuntimeIdentity = {
  developerId?: string;
  provider?: string;
  model?: string;
  sessionId?: string;
};

export type ProjectMemoryHumanReview = (
  candidate: MemoryRecord,
) => Promise<{ verdict: ReviewVerdict; reason: string; developerId: string } | undefined>;

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
const recordOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    id: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    projectId: { type: 'string' },
    kind: { type: 'string' },
    summary: { type: 'string' },
    rationale: { type: 'string' },
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
    name: 'project_memory_context',
    description: 'Retrieve bounded project decisions, corrections, outcomes and human-approved rules before planning or editing.',
    inputSchema: {
      ...objectSchema,
      properties: {
        task: { type: 'string', minLength: 1, maxLength: 4000 },
        paths: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 12 },
      },
      required: ['task'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        query: { type: 'string' },
        approvedRules: { type: 'array', items: recordOutputSchema },
        relevantHistory: { type: 'array', items: recordOutputSchema },
        conflicts: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
        notices: { type: 'array', items: { type: 'string' } },
      },
      required: [
        'projectId', 'query', 'approvedRules', 'relevantHistory', 'conflicts', 'truncated', 'notices',
      ],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'project_memory_get',
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
    name: 'project_memory_status',
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
        reviewConflicts: { type: 'integer' },
        storeDigest: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        contributors: { type: 'array', items: { type: 'object' } },
        corruptedRecords: { type: 'array', items: { type: 'string' } },
        integration: { type: 'object' },
      },
      required: [
        'projectId', 'records', 'candidates', 'approvedRules', 'rejectedRules', 'reviewConflicts',
        'storeDigest', 'contributors', 'corruptedRecords', 'integration',
      ],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'project_memory_candidates',
    description: 'List rule candidates and their pending, reviewed or conflict state for chat review.',
    inputSchema: {
      ...objectSchema,
      properties: {
        cursor: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
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
    name: 'project_memory_record',
    description: 'Record a verified decision, convention, correction, outcome or exemplar with developer and agent provenance. Exact retries deduplicate.',
    inputSchema: {
      ...objectSchema,
      properties: {
        kind: { type: 'string', enum: ['decision', 'convention', 'correction', 'outcome', 'exemplar'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        scope: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        evidence: { type: 'array', maxItems: 20, items: evidenceSchema },
        developerId: { type: 'string', minLength: 1, maxLength: 128 },
        provider: { type: 'string', minLength: 1, maxLength: 64 },
        model: { type: 'string', minLength: 1, maxLength: 128 },
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
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
    name: 'project_memory_propose_rule',
    description: 'Propose a reusable coding rule with evidence. The proposal remains advisory until a human reviews it through client elicitation or the CLI fallback.',
    inputSchema: {
      ...objectSchema,
      properties: {
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        rationale: { type: 'string', minLength: 1, maxLength: 4000 },
        tags: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 64 } },
        scope: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 256 } },
        evidence: { type: 'array', minItems: 1, maxItems: 20, items: evidenceSchema },
        developerId: { type: 'string', minLength: 1, maxLength: 128 },
        provider: { type: 'string', minLength: 1, maxLength: 64 },
        model: { type: 'string', minLength: 1, maxLength: 128 },
        sessionId: { type: 'string', minLength: 1, maxLength: 128 },
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
    name: 'project_memory_review_rule',
    description: 'Ask the connected client to show a human confirmation form for one rule candidate. Verdict, reason and developer ID come only from MCP elicitation, never tool arguments.',
    inputSchema: {
      ...objectSchema,
      properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' } },
      required: ['id'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        reviewed: { type: 'boolean' },
        review: { type: 'object' },
        reason: { type: 'string' },
      },
      required: ['reviewed'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
  },
];

function result(value: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
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
  const runtimeIdentity = Object.fromEntries(Object.entries(options.identity ?? {})
    .filter(([, value]) => value !== undefined));
  if (name === 'project_memory_context') {
    const task = stringValue(args.task, 'task', 4000);
    const paths = stringArray(args.paths, 'paths', 30, 256)
      .map((path, index) => relativeProjectPath(path, `paths[${index}]`));
    const limit = args.limit === undefined ? 12 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) throw new Error('limit must be an integer from 1 to 30');
    const context = await buildMemoryContext(store, task, paths, limit);
    const integration = await inspectProjectMemoryIntegration(store.root);
    return result({ ...context, notices: integration.notices });
  }
  if (name === 'project_memory_get') return result(await store.readRecord(stringValue(args.id, 'id', 64)));
  if (name === 'project_memory_status') {
    return result({ ...await store.status(), integration: await inspectProjectMemoryIntegration(store.root) });
  }
  if (name === 'project_memory_candidates') {
    const cursor = args.cursor === undefined ? undefined : stringValue(args.cursor, 'cursor', 64);
    const limit = args.limit === undefined ? 20 : Number(args.limit);
    return result(await listRuleCandidates(store, cursor, limit));
  }
  if (name === 'project_memory_record') {
    const input = parseRecordInput({ ...args, ...runtimeIdentity });
    if (input.kind === 'rule_candidate') throw new Error('Use project_memory_propose_rule for rule candidates');
    return result(await store.record(input, 'agent'));
  }
  if (name === 'project_memory_propose_rule') {
    return result(await store.record(parseRecordInput({
      ...args, ...runtimeIdentity, kind: 'rule_candidate',
    }), 'agent'));
  }
  if (name === 'project_memory_review_rule') {
    const id = stringValue(args.id, 'id', 64);
    const candidate = await store.readRecord(id);
    if (candidate.kind !== 'rule_candidate') throw new Error('Only rule candidates can be reviewed');
    if (!options.humanReview) throw new Error('Chat review requires a client with MCP form elicitation support');
    const decision = await options.humanReview(candidate);
    if (!decision) return result({ reviewed: false, reason: 'Human declined or cancelled review' });
    const review = await store.review(id, decision.verdict, decision.reason, decision.developerId);
    return result({ reviewed: true, ...review });
  }
  throw new Error(`Unknown tool: ${name}`);
}

/** Starts the stdio MCP server rooted at the caller's project. */
export async function runProjectMemoryMcp(root = process.env.PROJECT_MEMORY_ROOT ?? process.cwd()): Promise<void> {
  const store = new ProjectMemoryStore(root);
  await store.readConfig();
  const version = await projectMemoryPackageVersion();
  const integration = await inspectProjectMemoryIntegration(root);
  const instructions = [SERVER_INSTRUCTIONS, ...integration.notices].join(' ');
  const server = new Server(
    { name: 'project-memory', version },
    { capabilities: { tools: {}, resources: {} }, instructions },
  );
  const identity: ProjectMemoryRuntimeIdentity = {
    developerId: process.env.PROJECT_MEMORY_DEVELOPER_ID,
    provider: process.env.PROJECT_MEMORY_PROVIDER,
    model: process.env.PROJECT_MEMORY_MODEL,
    sessionId: process.env.PROJECT_MEMORY_SESSION_ID,
  };
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: PROJECT_MEMORY_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await callProjectMemoryTool(store, request.params.name, request.params.arguments, {
        identity,
        humanReview: async (candidate) => {
          if (!server.getClientCapabilities()?.elicitation) {
            throw new Error('Connected client does not support MCP form elicitation; use the CLI fallback');
          }
          const elicited = await server.elicitInput({
            mode: 'form',
            message: `Review project rule ${candidate.id}: ${candidate.summary}`,
            requestedSchema: {
              type: 'object',
              properties: {
                verdict: {
                  type: 'string',
                  title: 'Verdict',
                  oneOf: [
                    { const: 'approved', title: 'Approve' },
                    { const: 'rejected', title: 'Reject' },
                    { const: 'superseded', title: 'Supersede' },
                  ],
                },
                reason: { type: 'string', title: 'Reason', minLength: 1, maxLength: 2000 },
                developerId: { type: 'string', title: 'Developer ID', minLength: 1, maxLength: 128 },
              },
              required: ['verdict', 'reason', 'developerId'],
            },
          });
          if (elicited.action !== 'accept' || !elicited.content) return undefined;
          const verdict = stringValue(elicited.content.verdict, 'verdict', 16) as ReviewVerdict;
          if (!['approved', 'rejected', 'superseded'].includes(verdict)) throw new Error('Invalid human verdict');
          return {
            verdict,
            reason: stringValue(elicited.content.reason, 'reason', 2000),
            developerId: stringValue(elicited.content.developerId, 'developerId', 128),
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
      { uri: 'project-memory://instructions', name: 'Project memory instructions', mimeType: 'text/markdown' },
      { uri: 'project-memory://status', name: 'Project memory status', mimeType: 'application/json' },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === 'project-memory://instructions') {
      return { contents: [{ uri: request.params.uri, mimeType: 'text/markdown', text: instructions }] };
    }
    if (request.params.uri === 'project-memory://status') {
      return {
        contents: [{
          uri: request.params.uri,
          mimeType: 'application/json',
          text: JSON.stringify({ ...await store.status(), integration: await inspectProjectMemoryIntegration(root) }),
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
