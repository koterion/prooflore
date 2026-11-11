import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ProjectMemoryStore } from './store.js';

const SETUP_SCHEMA_VERSION = 1 as const;
const BLOCK_START = '<!-- project-memory:managed:start -->';
const BLOCK_END = '<!-- project-memory:managed:end -->';
const TOML_START = '# project-memory:managed:start';
const TOML_END = '# project-memory:managed:end';
const WORKFLOW_PATH = '.prooflore/AGENT_WORKFLOW.md';
const STATE_PATH = '.prooflore/setup.json';
const IGNORE_PATH = '.prooflore/.gitignore';
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
const REQUIRED_WORKFLOW_SAFEGUARDS = [
  'Before planning or editing code',
  'Treat `approvedRules` as project rules',
  'advisory evidence that must be checked against current code',
  'Relay each ProofLore setup notice to the user at most once per conversation',
  'only a human may approve',
  'never infer or supply it',
  'Never store secrets, credentials, raw transcripts, personal data or unsupported claims',
] as const;

export const SETUP_PROVIDERS = ['codex', 'claude', 'cursor'] as const;
export type SetupProvider = typeof SETUP_PROVIDERS[number];

type ManagedState = {
  schemaVersion: typeof SETUP_SCHEMA_VERSION;
  packageVersion: string;
  providers: SetupProvider[];
  hashes: Record<string, string>;
};

type PlannedWrite = {
  path: string;
  content: string;
  original?: string;
  ownershipKey: string;
  ownedContent: string;
};

export type SetupResult = {
  ok: boolean;
  mode: 'apply' | 'dry-run' | 'check';
  projectId: string;
  packageVersion: string;
  providers: SetupProvider[];
  changes: string[];
  unchanged: string[];
  conflicts: Array<{ path: string; reason: string }>;
  restartRequired: boolean;
};

export type ProjectMemoryLifecycleStatus = {
  applicable: boolean;
  postinstallConfigured: boolean;
  expectedCommand: 'prooflore sync';
};

export type ProjectMemoryIntegrationStatus = {
  lifecycle: ProjectMemoryLifecycleStatus;
  setup?: SetupResult;
  setupCheckFailed: boolean;
  notices: string[];
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedProjectId(value: string): string {
  const normalized = value.toLocaleLowerCase().replace(/^@/u, '').replaceAll('/', '-')
    .replace(/[^a-z0-9._-]+/gu, '-').replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/gu, '');
  if (!normalized) throw new Error('Could not infer a valid project ID; pass --project ID');
  return normalized.slice(0, 128);
}

async function optionalRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function assertSafeTarget(root: string, path: string): Promise<void> {
  const relativePath = relative(root, path);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Setup target is outside the project: ${path}`);
  }
  const parts = relativePath.split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) throw new Error(`Setup refuses symlinked path: ${current}`);
      if (index < parts.length - 1 && !metadata.isDirectory()) {
        throw new Error(`Setup parent is not a directory: ${current}`);
      }
      if (index === parts.length - 1 && !metadata.isFile()) {
        throw new Error(`Setup target is not a file: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** Reads the installed package version used to bind managed setup state. */
export async function projectMemoryPackageVersion(): Promise<string> {
  const value = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof value.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value.version)) {
    throw new Error('Invalid package version');
  }
  return value.version;
}

async function inferProjectId(root: string): Promise<string> {
  const packageJson = await optionalRead(join(root, 'package.json'));
  if (packageJson) {
    try {
      const name = (JSON.parse(packageJson) as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim()) return normalizedProjectId(name);
    } catch {
      throw new Error('Cannot infer project ID from malformed package.json; pass --project ID');
    }
  }
  return normalizedProjectId(basename(root));
}

function parseState(raw: string | undefined): ManagedState | undefined {
  if (!raw) return undefined;
  const value = JSON.parse(raw) as Partial<ManagedState>;
  if (value.schemaVersion !== SETUP_SCHEMA_VERSION || typeof value.packageVersion !== 'string'
    || !Array.isArray(value.providers)
    || !value.providers.every((item) => typeof item === 'string'
      && SETUP_PROVIDERS.includes(item as SetupProvider))
    || !value.hashes || typeof value.hashes !== 'object' || Array.isArray(value.hashes)
    || !Object.values(value.hashes).every((item) => typeof item === 'string' && /^[a-f0-9]{64}$/u.test(item))) {
    throw new Error('Invalid ProofLore setup state');
  }
  return value as ManagedState;
}

function managedMarkdownBlock(): string {
  return `${BLOCK_START}\n## Project memory\n\nRead and follow [the project-memory workflow](${WORKFLOW_PATH}) before planning or editing.\n${BLOCK_END}`;
}

function workflow(version: string): string {
  const content = `<!-- Generated by ProofLore ${version}. Put project-specific instructions outside this file. -->\n# Project memory workflow\n\nBefore planning or editing code, call \`project_memory_context\` with the task and affected paths.\n\n- Treat \`approvedRules\` as project rules.\n- Treat \`relevantHistory\` as advisory evidence that must be checked against current code.\n- Relay each ProofLore setup notice to the user at most once per conversation; do not edit \`package.json\` unless asked.\n- Never turn an agent claim, repeated observation or successful build into an approved rule.\n- After verified work, record durable decisions, corrections, outcomes or exemplars with evidence and the responsible developer ID.\n- Propose reusable rules with \`project_memory_propose_rule\`; only a human may approve them.\n- When asked, open \`project_memory_review_rule\` for a candidate. The connected client must collect the human verdict; never infer or supply it.\n- Treat review conflicts as non-authoritative until a later human verdict merges the branches.\n- Never store secrets, credentials, raw transcripts, personal data or unsupported claims.\n`;
  for (const safeguard of REQUIRED_WORKFLOW_SAFEGUARDS) {
    if (!content.includes(safeguard)) throw new Error(`Generated workflow is missing safeguard: ${safeguard}`);
  }
  return content;
}

function assertNoWorkflowRuleRemoval(existing: string | undefined, desired: string, accepted: boolean): void {
  if (!existing) return;
  const desiredRules = new Set(desired.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- ')));
  const removed = existing.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && !desiredRules.has(line));
  if (removed.length > 0 && !accepted) {
    throw new Error('Managed workflow update would remove or rewrite a prior rule; explicit migration is required');
  }
}

function codexBlock(): string {
  return `${TOML_START}\n[mcp_servers.project_memory]\ncommand = "npm"\nargs = ["exec", "--offline", "--", "prooflore-mcp"]\nenv = { PROJECT_MEMORY_ROOT = "." }\n${TOML_END}`;
}

function mcpServer(): Record<string, unknown> {
  return {
    command: 'npm',
    args: ['exec', '--offline', '--', 'prooflore-mcp'],
    env: { PROJECT_MEMORY_ROOT: '.' },
  };
}

function extractBlock(content: string, start: string, end: string): { value: string; from: number; to: number } | undefined {
  const from = content.indexOf(start);
  if (from < 0) return undefined;
  if (content.indexOf(start, from + start.length) >= 0) throw new Error('Duplicate managed block start marker');
  const endIndex = content.indexOf(end, from + start.length);
  if (endIndex < 0 || content.indexOf(end, endIndex + end.length) >= 0) throw new Error('Invalid managed block markers');
  const to = endIndex + end.length;
  return { value: content.slice(from, to), from, to };
}

function replaceOrAppendBlock(content: string | undefined, desired: string, start: string, end: string): {
  content: string;
  ownedContent: string;
  existingOwned?: string;
} {
  const current = content ?? '';
  const block = extractBlock(current, start, end);
  if (block) {
    return {
      content: `${current.slice(0, block.from)}${desired}${current.slice(block.to)}`,
      ownedContent: desired,
      existingOwned: block.value,
    };
  }
  const separator = current.length === 0 ? '' : current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  return { content: `${current}${separator}${desired}\n`, ownedContent: desired };
}

function mergeJsonServer(content: string | undefined): {
  content: string;
  ownedContent: string;
  existingOwned?: string;
} {
  let root: Record<string, unknown> = {};
  if (content !== undefined) {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP config root must be an object');
    root = parsed as Record<string, unknown>;
  }
  const existingServers = root.mcpServers;
  if (existingServers !== undefined && (!existingServers || typeof existingServers !== 'object' || Array.isArray(existingServers))) {
    throw new Error('mcpServers must be an object');
  }
  const servers = { ...(existingServers as Record<string, unknown> | undefined) };
  const existing = servers.project_memory;
  const desired = mcpServer();
  servers.project_memory = desired;
  root.mcpServers = servers;
  return {
    content: `${JSON.stringify(root, null, 2)}\n`,
    ownedContent: JSON.stringify(desired),
    existingOwned: existing === undefined ? undefined : JSON.stringify(existing),
  };
}

async function atomicWrite(root: string, path: string, content: string, expected?: string): Promise<void> {
  await assertSafeTarget(root, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const current = await optionalRead(path);
  if (current !== expected) throw new Error(`File changed during setup: ${path}`);
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const existingMode = expected === undefined ? 0o600 : (await lstat(path)).mode & 0o777;
  const handle = await open(temporary, 'wx', existingMode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function checkOwnership(
  state: ManagedState | undefined,
  ownershipKey: string,
  existingOwned: string | undefined,
  desiredOwned: string,
): string | undefined {
  const priorHash = state?.hashes[ownershipKey];
  if (priorHash) {
    if (existingOwned === undefined) return 'Previously managed content was removed';
    if (hash(existingOwned) !== priorHash) return 'Managed content was edited; preserving the user version';
    return undefined;
  }
  if (existingOwned !== undefined && existingOwned !== desiredOwned) {
    return 'Existing unmanaged project_memory configuration differs';
  }
  return undefined;
}

/** Safely installs or reconciles project-local memory configuration without touching global agent settings. */
export async function setupProjectMemory(options: {
  root?: string;
  projectId?: string;
  providers?: SetupProvider[];
  dryRun?: boolean;
  check?: boolean;
  acceptRuleMigration?: boolean;
} = {}): Promise<SetupResult> {
  const root = await realpath(resolve(options.root ?? process.cwd()));
  const version = await projectMemoryPackageVersion();
  const projectId = normalizedProjectId(options.projectId ?? await inferProjectId(root));
  await assertSafeTarget(root, join(root, STATE_PATH));
  const stateRaw = await optionalRead(join(root, STATE_PATH));
  const state = parseState(stateRaw);
  const providers = [...new Set(options.providers ?? state?.providers ?? SETUP_PROVIDERS)].sort() as SetupProvider[];
  if (providers.length === 0 || !providers.every((provider) => SETUP_PROVIDERS.includes(provider))) {
    throw new Error(`providers must be one or more of: ${SETUP_PROVIDERS.join(', ')}`);
  }
  const writes: PlannedWrite[] = [];
  const conflicts: SetupResult['conflicts'] = [];
  const unchanged: string[] = [];

  const plan = async (
    relativePath: string,
    ownershipKey: string,
    transform: (content: string | undefined) => { content: string; ownedContent: string; existingOwned?: string },
  ): Promise<void> => {
    const path = join(root, relativePath);
    try {
      await assertSafeTarget(root, path);
      const original = await optionalRead(path);
      const next = transform(original);
      const conflict = checkOwnership(state, ownershipKey, next.existingOwned, next.ownedContent);
      if (conflict) {
        conflicts.push({ path: relativePath, reason: conflict });
        return;
      }
      if (original === next.content) unchanged.push(relativePath);
      else writes.push({ path, content: next.content, original, ownershipKey, ownedContent: next.ownedContent });
    } catch (error) {
      conflicts.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  await plan(WORKFLOW_PATH, WORKFLOW_PATH, (content) => {
    const desired = workflow(version);
    assertNoWorkflowRuleRemoval(content, desired, options.acceptRuleMigration === true);
    return { content: desired, ownedContent: desired, existingOwned: content };
  });
  await plan(IGNORE_PATH, IGNORE_PATH, (content) => ({
    content: IGNORE_CONTENT,
    ownedContent: IGNORE_CONTENT,
    existingOwned: content,
  }));
  if (providers.includes('codex') || providers.includes('cursor')) {
    await plan('AGENTS.md', 'AGENTS.md#project-memory', (content) => replaceOrAppendBlock(
      content, managedMarkdownBlock(), BLOCK_START, BLOCK_END,
    ));
  }
  if (providers.includes('claude')) {
    await plan('CLAUDE.md', 'CLAUDE.md#project-memory', (content) => replaceOrAppendBlock(
      content, managedMarkdownBlock(), BLOCK_START, BLOCK_END,
    ));
    await plan('.mcp.json', '.mcp.json#mcpServers.project_memory', mergeJsonServer);
  }
  if (providers.includes('codex')) {
    await plan('.codex/config.toml', '.codex/config.toml#project-memory', (content) => replaceOrAppendBlock(
      content, codexBlock(), TOML_START, TOML_END,
    ));
  }
  if (providers.includes('cursor')) {
    await plan('.cursor/mcp.json', '.cursor/mcp.json#mcpServers.project_memory', mergeJsonServer);
  }

  const mode: SetupResult['mode'] = options.check ? 'check' : options.dryRun ? 'dry-run' : 'apply';
  const store = new ProjectMemoryStore(root);
  let storeMissing = false;
  try {
    const config = await store.readConfig();
    if (config.projectId !== projectId) conflicts.push({
      path: '.prooflore/config.json', reason: `Store belongs to ${config.projectId}, not ${projectId}`,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') storeMissing = true;
    else conflicts.push({
      path: '.prooflore/config.json', reason: error instanceof Error ? error.message : String(error),
    });
  }
  const changes = [...(storeMissing ? ['.prooflore/config.json'] : []),
    ...writes.map((write) => relative(root, write.path).split(sep).join('/'))];
  const hashes = { ...(state?.hashes ?? {}) };
  for (const write of writes) hashes[write.ownershipKey] = hash(write.ownedContent);
  for (const relativePath of unchanged) {
    if (relativePath === WORKFLOW_PATH) hashes[relativePath] = hash(workflow(version));
    else if (relativePath === IGNORE_PATH) hashes[relativePath] = hash(IGNORE_CONTENT);
    else if (relativePath === 'AGENTS.md') hashes['AGENTS.md#project-memory'] = hash(managedMarkdownBlock());
    else if (relativePath === 'CLAUDE.md') hashes['CLAUDE.md#project-memory'] = hash(managedMarkdownBlock());
    else if (relativePath === '.codex/config.toml') hashes['.codex/config.toml#project-memory'] = hash(codexBlock());
    else if (relativePath === '.mcp.json') hashes['.mcp.json#mcpServers.project_memory'] = hash(JSON.stringify(mcpServer()));
    else if (relativePath === '.cursor/mcp.json') hashes['.cursor/mcp.json#mcpServers.project_memory'] = hash(JSON.stringify(mcpServer()));
  }
  const nextState: ManagedState = {
    schemaVersion: SETUP_SCHEMA_VERSION,
    packageVersion: version,
    providers,
    hashes,
  };
  const nextStateContent = `${JSON.stringify(nextState, null, 2)}\n`;
  if (stateRaw !== nextStateContent) changes.push(STATE_PATH);
  if (conflicts.length > 0 || mode !== 'apply') {
    return {
      ok: conflicts.length === 0 && (mode !== 'check' || changes.length === 0),
      mode,
      projectId,
      packageVersion: version,
      providers,
      changes: [...new Set(changes)],
      unchanged,
      conflicts,
      restartRequired: changes.some((path) => path !== STATE_PATH && path !== '.prooflore/config.json'),
    };
  }

  if (storeMissing) await store.initialize(projectId);
  for (const write of writes) {
    const relativePath = relative(root, write.path).split(sep).join('/');
    if (storeMissing && relativePath === IGNORE_PATH && write.original === undefined) continue;
    await atomicWrite(root, write.path, write.content, write.original);
  }
  if (stateRaw !== nextStateContent) {
    await atomicWrite(root, join(root, STATE_PATH), nextStateContent, stateRaw);
  }
  return {
    ok: true,
    mode,
    projectId,
    packageVersion: version,
    providers,
    changes: [...new Set(changes)],
    unchanged,
    conflicts: [],
    restartRequired: changes.some((path) => path !== STATE_PATH && path !== '.prooflore/config.json'),
  };
}

/** Checks a previously managed setup and returns undefined for legacy/manual installations. */
export async function checkProjectMemorySetup(root = process.cwd()): Promise<SetupResult | undefined> {
  const resolvedRoot = await realpath(resolve(root));
  await assertSafeTarget(resolvedRoot, join(resolvedRoot, STATE_PATH));
  if (!await optionalRead(join(resolvedRoot, STATE_PATH))) return undefined;
  return setupProjectMemory({ root: resolvedRoot, check: true });
}

/** Detects whether the consuming project explicitly enabled automatic lifecycle synchronization. */
export async function projectMemoryLifecycleStatus(root = process.cwd()): Promise<ProjectMemoryLifecycleStatus> {
  const resolvedRoot = await realpath(resolve(root));
  const packageJson = await optionalRead(join(resolvedRoot, 'package.json'));
  if (!packageJson) {
    return { applicable: false, postinstallConfigured: false, expectedCommand: 'prooflore sync' };
  }
  try {
    const value = JSON.parse(packageJson) as { scripts?: unknown };
    const scripts = value.scripts && typeof value.scripts === 'object' && !Array.isArray(value.scripts)
      ? value.scripts as Record<string, unknown> : {};
    const postinstall = typeof scripts.postinstall === 'string' ? scripts.postinstall : '';
    return {
      applicable: true,
      postinstallConfigured: /(?:^|[\s;&|])prooflore\s+sync(?:\s|$)/u.test(postinstall),
      expectedCommand: 'prooflore sync',
    };
  } catch {
    return { applicable: true, postinstallConfigured: false, expectedCommand: 'prooflore sync' };
  }
}

/** Produces non-mutating setup diagnostics and bounded instructions an agent can relay to its user. */
export async function inspectProjectMemoryIntegration(root = process.cwd()): Promise<ProjectMemoryIntegrationStatus> {
  const lifecycle = await projectMemoryLifecycleStatus(root);
  let setup: SetupResult | undefined;
  let setupCheckFailed = false;
  try {
    setup = await checkProjectMemorySetup(root);
  } catch {
    setupCheckFailed = true;
  }
  const notices: string[] = [];
  if (lifecycle.applicable && !lifecycle.postinstallConfigured) {
    notices.push('Tell the user once in this conversation that automatic ProofLore updates are not configured. Suggest adding "postinstall": "prooflore sync" to package.json. Do not edit package.json unless the user asks.');
  }
  if (setupCheckFailed || setup?.ok === false) {
    notices.push('Tell the user once in this conversation that ProofLore setup requires synchronization. Suggest running `npx prooflore sync`. Do not enforce newly packaged rules until synchronization succeeds.');
  }
  return { lifecycle, setup, setupCheckFailed, notices };
}
