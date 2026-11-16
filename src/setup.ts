import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { resolveProjectMemoryIdentity, type ProjectMemoryIdentityStatus } from './identity.js';
import { ProjectMemoryStore } from './store.js';

const SETUP_SCHEMA_VERSION = 1 as const;
const BLOCK_START = '<!-- prooflore:managed:start -->';
const BLOCK_END = '<!-- prooflore:managed:end -->';
const TOML_START = '# prooflore:managed:start';
const TOML_END = '# prooflore:managed:end';
const WORKFLOW_PATH = '.prooflore/AGENT_WORKFLOW.md';
const STATE_PATH = '.prooflore/setup.json';
const LEGACY_OWNERSHIP_KEYS = new Map([
  ['AGENTS.md#project-memory', 'AGENTS.md#prooflore'],
  ['CLAUDE.md#project-memory', 'CLAUDE.md#prooflore'],
  ['.codex/config.toml#project-memory', '.codex/config.toml#prooflore'],
  ['.mcp.json#mcpServers.project_memory', '.mcp.json#mcpServers.prooflore'],
  ['.cursor/mcp.json#mcpServers.project_memory', '.cursor/mcp.json#mcpServers.prooflore'],
]);
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
const LEGACY_RULE_BROWSING = '- Use prooflore_rules to browse titles and statuses, or filter to pending for approval and availability requests. Report an empty list. For one pending candidate with no next page, offer review on an availability request or open it on an explicit review request. Honor a valid prior selection. Otherwise show numbered titles and ask which to review.';
const RULE_CATALOG_FILTERS = '- For requests to list rules by programming language, tag, or test type, call prooflore_rules with state approved and the requested language, tag, or testType filters. Combine filters when requested and use the same table. Libraries and tools are tags, while unit and e2e are test types. If no rules match, say so in the chat language.';
const ACTIVE_RULE_TABLE = '- For a general request to list rules, call prooflore_rules with state approved. Show only active rules in a Markdown table with Rule, Tags, Programming languages, and Test types columns localized to the chat. Translate each stored rule summary faithfully into the chat language for display. If the user asks for the original, reproduce the stored summary verbatim without translating or paraphrasing. Listing never changes stored text. Use the effective catalog tags and classification.languages and classification.testTypes. Use a dash for missing tags and indicate any language when languages is empty. Use a dash when test types are empty. If there are no approved rules, say there are no active rules in the language of the latest user message and stop (for Ukrainian: Немає чинних затверджених правил). Include pending, revoked, rejected or replaced rules only when explicitly requested.';
const PENDING_RULE_REVIEW = '- Filter to pending for approval and availability requests. Report an empty list. For one pending candidate with no next page, offer review on an availability request or open it on an explicit review request. Honor a valid prior selection. Otherwise show numbered titles and ask which to review.';
const LEGACY_REVIEW_PRESENTATION = 'The form shows the translation followed by the stored original.';
const REVIEW_PRESENTATION = 'Translate each rule referenced in supersedes as well and pass translatedReplacements with each stored ID and its translated summary. The form displays only the localized text when translations are supplied.';
const WORKFLOW_WORDING_MIGRATIONS = new Map([
  ['8050e47e936a4e65d8dd4776d05643fe2d98f0299ce553a2b21e95b20ff945e9', '9916b700a5b6dc20860cd42dcc78cda3ede9456079790be3c491e5a25e96730c'],
  ['5d33e387df89cee524686b193c0344934163bb57e34e80529d3104dd6a9fe43a', '12767dfb7d92f38c6a4f11f18f9907012d9b071e8030abe373d04f1eb7278599'],
  ['a265096a97e574beda2a0003e3f2cb9b3b8c85af1ffcf68c979e8372b76badb2', '045ccc1326c8f539b43e8deca784e9bb190a73d97ee19b72c0fd852a2be9df6a'],
  ['0b5ba4086222afa76c9136e6e3ca85b88b3dc914a08b11c35c4453b3636b3285', 'ed4f6f9ac4a719a9ed9b159f81e62071335f0a0ca61a4cfef4259580f9956d79'],
  ['dbc0a6b1b8651250c5c126af51710d8a55ccc7d92fc9f58cc5d5dae3989f83aa', 'a265096a97e574beda2a0003e3f2cb9b3b8c85af1ffcf68c979e8372b76badb2'],
  ['c1a922f47db635e4f22617b5783d806315b68f79b9416dc46ddf5471595e4742', 'fdc446125314f603ad81005ac54e59d90e71fd1ff18cdce5fe18d476845b0791'],
  ['8603e26854c78e3ee25fda9fb127708887a9a96c86bff8397571852a8aaeb7b0', 'fdc446125314f603ad81005ac54e59d90e71fd1ff18cdce5fe18d476845b0791'],
  ['fe1a887378e00cf376f08596d6883016a065d481740fbe3811ff49d6f82c0417', '038ecdf0a2da44726ac7da22b626a2ee1205dcb7c80e83e440fd2c31a5d40c82'],
  ['4ceeaafed916bb3526fbc5613753609393f7df775bf8014950a261c397d04b28', '18e508df2abf22d9f70f8c09eefb12bc846ab1d7150f3155b953df07b1bcd103'],
  ['c3b1e51f8f56faf0c9ab42a97d0f73b4c3ffb626094e29c078967890694fd6f2', '67272a5faeceda7318b772c39342260a16b4e5c1dae3acbfedf2ed5ca05fb8db'],
  ['df095213183cc73e78a03e89fe99a2929773f285ab9be912af47c9a4f00c4e5c', '7bb9e06ad8d0e8ec23cbd06634b8aab5105b294ab187cb71044311d602f840fe'],
  ['7890769bbf7131243cd6852f28e05d1f65fc11de8381e80640eadb69bd4a4769', '4ceeaafed916bb3526fbc5613753609393f7df775bf8014950a261c397d04b28'],
  ['beea08a38dc3334b8b2d8455f729440e1d8157daedc83b8324f83452279495a1', 'c3b1e51f8f56faf0c9ab42a97d0f73b4c3ffb626094e29c078967890694fd6f2'],
  ['43fd7cf336fe9df9565c94f14ae932a68a44f0faf6e302422b6ec14ed34fe489', '0b5ba4086222afa76c9136e6e3ca85b88b3dc914a08b11c35c4453b3636b3285'],
  ['bd6f42f64a58cf67926e7791d5df26695269f1c48b4a20be4dc289a5f9309c49', 'c2ffcad68f7ff4787a1da45770f1a5a19633692ae91601dffa3a4f11098b2591'],
  ['c88d186c05793a90643086176a13ed72d937f0ffb7523d3f13beceb7064a2af7', 'b50cb6e999a25273682071640b8bb490ac6dfc705981a298b4a7d2899cdae940'],
  ['dfbc3f0e734f987d101911d6081a6f62b4d7b2a98003933eee69d11d3ac0fb61', 'b50cb6e999a25273682071640b8bb490ac6dfc705981a298b4a7d2899cdae940'],
  ['165426fa603611f26ac705b98c3b97865e39f30cf1f668258d6220ccd3726ac4', '0acb4c2284a608231e0475190901c7856a55d6aa63c2b1fa5b08099ca5e838cf'],
  ['cc41b7ea2f656c441720dbe6602e9e8accbbc8dcf7d7070efce724e22eb33afb', 'a0781a0b173b446624e0c1e5a551c75ce9a6bada7dcfabe831d0dbed0a5073e5'],
  ['6f9afc11e217073cab64aa0146e6016e0b190ef019ea7a0e2ea6fe730a50fd18', 'c2ffcad68f7ff4787a1da45770f1a5a19633692ae91601dffa3a4f11098b2591'],
  ['28b3f4bd7a056d77d67f81f145788ffc9167226f291eb72734a19b66ad2760de', 'c2ffcad68f7ff4787a1da45770f1a5a19633692ae91601dffa3a4f11098b2591'],
  ['0f95c4fa07a9a5df57e93cfc7a6ab58b0837dbf93d89630b5d706d238c9d4d8c', '8050e47e936a4e65d8dd4776d05643fe2d98f0299ce553a2b21e95b20ff945e9'],
  ['722e6774c01d3217aa55ad7be7b44a7caaaa17bd3005087529cca8b18ab7648b', 'df095213183cc73e78a03e89fe99a2929773f285ab9be912af47c9a4f00c4e5c'],
  ['feb1767332544d879120836bd0155dbfe7e465a2e2eae2a11c51371f9679819e', 'ae6bd125560c547882e5418cf8ecb0343f6e8070460f042b9518c3a3ff2797ec'],
  ['50e2f34a1b9ac687d2489c919754695d8942e9cb681cfdbb3eb81a17d15e1cf8', 'ae6bd125560c547882e5418cf8ecb0343f6e8070460f042b9518c3a3ff2797ec'],
  ['04781757e13780d66afedf1f3e6f5db95c0772f4d07535ce81aaf63e72fa63a3', 'c3b1e51f8f56faf0c9ab42a97d0f73b4c3ffb626094e29c078967890694fd6f2'],
  ['f029c88cdeca16666fbfb18fdfa8a3343580acc43db8147b3884b12a16ecc5bd', '5d33e387df89cee524686b193c0344934163bb57e34e80529d3104dd6a9fe43a'],
  ['523a4993684c0cfa517e208c5eeca303f1a196c19212c2ac625f0bcc9e8f3f74', 'a0781a0b173b446624e0c1e5a551c75ce9a6bada7dcfabe831d0dbed0a5073e5'],
  ['ca968c4b197fd5f736b55e3b8c727a0a87f92e28b058914aa971265d7f71afd9', 'c2ffcad68f7ff4787a1da45770f1a5a19633692ae91601dffa3a4f11098b2591'],
  ['c38fe36a89fb457aa0c7fe8e61ac890bb84e9318c838c299e144ba225dad609c', 'c2ffcad68f7ff4787a1da45770f1a5a19633692ae91601dffa3a4f11098b2591'],
  ['9f610e948ea8c77dfd185896c858f491ab41e8b9a45076c2de07988803bda9cf', 'c2ffcad68f7ff4787a1da45770f1a5a19633692ae91601dffa3a4f11098b2591'],
  ['f663d6a46d73b6274c6f828a92d61f2b92a01093044a0f4a4068880a5bbd22a0', '8050e47e936a4e65d8dd4776d05643fe2d98f0299ce553a2b21e95b20ff945e9'],
  ['d97b78e36344c9b14ee818a409501dea2960bd4845a8dd57029eb4d0260543ca', 'df095213183cc73e78a03e89fe99a2929773f285ab9be912af47c9a4f00c4e5c'],
  ['943d3ffaab7f073f4ddddcb43ae2578540086fdf40f77a76e56cadd88e7ae84d', 'ae6bd125560c547882e5418cf8ecb0343f6e8070460f042b9518c3a3ff2797ec'],
  ['a4fafd18e2c764f9529883ca5c37270d3742e6482b9b0d215440e4b987639696', 'ae6bd125560c547882e5418cf8ecb0343f6e8070460f042b9518c3a3ff2797ec'],
  ['9b5216ddf6be166ede3e8fa6505dfa186b7a17913f38d192163dc22480ae04d5', 'c3b1e51f8f56faf0c9ab42a97d0f73b4c3ffb626094e29c078967890694fd6f2'],
  ['40b1fe40cce4eaa6a32321f76a15bab4905f318f2e07d955eb33b1a9faea3af1', 'c3b1e51f8f56faf0c9ab42a97d0f73b4c3ffb626094e29c078967890694fd6f2'],
  ['e9a19f76f88e081903aded0e7c01c932fd6639c30c69c85306e8d59ba0eb89ac', '1bb84225c421f918e87443d5e5e8f1e7b87a243921f80e28038d26387153b33e'],
  ['28fba6556fef2f8e1fbad775871beb4b278d40ae3aa0deb9b0fcd885daabfc55', '5d33e387df89cee524686b193c0344934163bb57e34e80529d3104dd6a9fe43a'],
]);
const REQUIRED_WORKFLOW_SAFEGUARDS = [
  'Before planning or editing code',
  'Treat `approvedRules` as project rules',
  'advisory evidence that must be checked against current code',
  'Relay each ProofLore setup notice to the user at most once per conversation',
  'only a human may approve',
  'Classify rules with namespaced tags',
  'Use one stable `rule-key:`',
  'Pending replacements do not deactivate approved rules',
  'Use the server-bound developer identity',
  'human-confirmed classification is authoritative',
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
  identity: ProjectMemoryIdentityStatus;
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
  const hashes = new Map<string, string>();
  for (const [key, digest] of Object.entries(value.hashes)) {
    const canonicalKey = LEGACY_OWNERSHIP_KEYS.get(key) ?? key;
    const previous = hashes.get(canonicalKey);
    if (previous !== undefined && previous !== digest) {
      throw new Error(`Conflicting ProofLore ownership hashes for ${canonicalKey}`);
    }
    hashes.set(canonicalKey, digest);
  }
  return { ...value as ManagedState, hashes: Object.fromEntries(hashes) };
}

function managedMarkdownBlock(): string {
  return `${BLOCK_START}\n## ProofLore\n\nRead and follow [the ProofLore workflow](${WORKFLOW_PATH}) before planning or editing.\n${BLOCK_END}`;
}

/** Shared chat workflow for generated instructions and MCP clients. */
export const PROJECT_MEMORY_CHAT_WORKFLOW = [
  '- For a localized review, resolve the exact candidate from the catalog and translate its stored summary before opening the form. Call prooflore_review_rule once with that ID, the chat locale (uk for Ukrainian), and translatedSummary. Supply translatedReplacements only for actual superseded rules. Let the user choose the verdict in the form and report the returned result. Only finalize a translation when the form returns approved_pending_translation with an approved verdict.',
  '- For rule browsing or review, use the catalog before answering. Treat approval slang such as «хочу заапрувити правило» as a ProofLore review request. Query prooflore_rules with state pending before asking which rule. For multiple candidates, show their numbered titles in the chat language and wait for a number before opening a form. For one candidate on an availability question, name it and end with a direct invitation to open or review it.',
  '- When a check never ran or no evidence supports the claimed behavior, save the wrap-up outcome with ruleAssessment disposition insufficient_evidence. State the verification gap. Do not turn evidence gaps or suggestions for future checks into rule candidates. An explicit user-confirmed convention may be assessed separately.',
  '- An approved rule limited to one feature remains narrower when the same practice is verified on another feature. Before finishing, ask explicitly whether to extend that rule to both features or to the supported class. This offer is required even with zero new candidates and after recording existing_rule.',
  '- When verified work applies a practice to a new feature outside the scope of an approved rule, offer to broaden that rule to cover the new feature. Compare the exact wording and scope. Even when the steps match, broader applicability is a concrete extension. Record existing_rule and ask for consent in the final reply without creating a candidate.',
  '- For a request to diagnose ProofLore storage health or corruption, call prooflore_status as the first ProofLore tool. Report its diagnostics and leave storage untouched. Skip prooflore_context for storage-only diagnosis because it needs a readable rule store.',
  '- A verified new requirement for the same approved rule is an extension. Read the current approved rule and preserve its existing requirements. Record the completed follow-up with prooflore_record, kind outcome, and ruleAssessment disposition existing_rule with the current approved rule ID. In the final reply, state the specific new requirement and explicitly ask whether to add it to the approved rule, even though no candidate was created. Wait for consent before proposing a replacement or opening review.',
  '- To wrap up completed, verified work, save supported candidates first. After prooflore_propose_rule returns created: true, call prooflore_record with kind outcome and ruleAssessment.candidateIds referencing the saved candidates. Do this before inviting review, including when the user reports verified work and asks for wrap-up without further code edits. A correction record does not satisfy this step.',
  '- Before editing under an approved rule, inspect the affected code for explicit exceptions and apply the default only where no exception matches. When the rule exempts recursive helpers, identify self-calls, preserve their named declarations and recursion, and convert eligible non-recursive helpers. When asked to update code to the project style, make the required edits in the file. Before replying, reread the diff and confirm eligible helpers use arrow syntax and exempt helpers retain the required form.',
  '- After every completed code edit, including a one-off typo, save a prooflore_record with kind outcome and ruleAssessment. A correction record does not replace that outcome. For a one-off with no reusable practice, use no_reusable_practice with an internal reason, create no candidate, and report only the change and checks. Plan-only requests remain read-only.',
  '- A plan-only request is read-only for the entire turn. You may read files and call read-only context tools. Return the plan without editing files, recording an outcome or assessment, proposing a rule, or opening a review. Reading or verifying facts for the plan does not authorize a write.',
  '- Before work, call prooflore_context with task and paths. Do not apply conflicting rules. Warn once about ruleBudget. If ruleBudget reports omitted rules, fetch the listed omittedRuleIds with prooflore_get before writing a plan or editing. If more IDs were omitted than listed, use prooflore_explain_context or a narrower context query to find the additional relevant rules. Read their full text before proceeding. A budget warning or exclusion reason alone does not recover a rule.',
  '- After substantive work, record a verified outcome with ruleAssessment. Compare reusable guidance against pending and approved rules, including paraphrases. Save only concrete, transferable candidates grounded in verified behavior or explicit user corrections. Keep assessment, duplicates and reasons internal unless explicitly asked. With no new candidate, omit the entire rule section and any sentence saying no rule was proposed, even when asked to finish in ProofLore. Report only work and verification. Confirm an explicitly requested outcome write or report a failed write. An approved-rule extension offer is the exception.',
  '- On a verified follow-up, check pending drafts before deciding the practice is already covered. If a pending draft is narrower or lacks a newly verified requirement, call prooflore_propose_rule with mergePendingId and complete combined English wording, preserving prior requirements. Save the outcome with the merged candidate ID. An offer to extend without writing is for approved rules. Compare exact wording and scope against another applicable feature. A rule limited to the original feature does not cover a verified second feature. For a narrower approved rule, show the concrete broader wording and ask whether to extend it even when no candidate was saved. Record existing_rule with its ID and wait for consent. Use supersedes for confirmed replacements. Keep history and require human approval.',
  '- Use server-bound identity. Mark personal records local before writing. Keep secrets and transcripts out. Store rules in English. Translate only for display or when finalizing the exact human-submitted edit using the returned approval token. Respect client denial and report success only after the write.',
  '- Capture a reusable convention explicitly given during a verified edit as a pending rule if absent. After saving the outcome for any newly saved candidate (created: true), end the final reply with a direct question in the chat language inviting the user to review that candidate. For several candidates, show numbered titles and ask which to review. On confirmation, open the form for the selected candidate. Use numbered pending lists, refresh before opening a numbered selection, and never remap stale numbers. If the selected ID is gone, name the remaining candidates from the refreshed catalog in a numbered list, even when only one remains, then end with a separate direct question asking the user to choose from the new numbering. For one remaining rule, explicitly ask whether to review rule 1. Open no form on that stale turn. Browsing and opening forms do not record task outcomes. Use human forms for verdicts. If asked to approve without a human verdict, look up pending rules read-only and explain that approval requires human review. Do not open a form or write a verdict in response to a bypass request.',
  '- Route by intent in any language: a standalone request about available project rules opens the ProofLore catalog even without the brand name. Rules mentioned as part of product behavior, business logic, or code are task context, not a catalog request. Use normal task context for that work.',
  '- For a standalone question about what project rules exist, including a brief question without a product name, first call prooflore_rules with state approved and render the localized table. Use pending only when the request concerns approval or availability for review.',
  ACTIVE_RULE_TABLE, RULE_CATALOG_FILTERS, PENDING_RULE_REVIEW,
  '- For imports, preview without writing when requested. Compare against pending and approved rules, preserve scope and exceptions, and save only distinct actionable candidates. For each rule imported from a file, put its exact project-relative source path in evidence.path and describe the source in evidence.note. Omit evidence.revision unless explicitly verified for that source. Do not claim tests or verification that did not happen. Leave the source file intact.',
].join('\n');

function workflow(version: string): string {
  const content = `<!-- Generated by ProofLore ${version}. Put project-specific instructions outside this file. -->\n# ProofLore workflow\n\nBefore planning or editing code, call \`prooflore_context\` with the task and affected paths.\n\n- Treat \`approvedRules\` as project rules.\n- Treat \`relevantHistory\` as advisory evidence that must be checked against current code.\n- Relay each ProofLore setup notice to the user at most once per conversation; do not edit \`package.json\` unless asked.\n- Never turn an agent claim, repeated observation or successful build into an approved rule.\n- After verified work, record durable decisions, corrections, outcomes or exemplars with evidence and the responsible developer ID.\n- Propose reusable rules with \`prooflore_propose_rule\`; only a human may approve them.\n- Classify rules with namespaced tags for test type and, where applicable, programming language. Add a language tag and name the language in the rule text only when the practice depends on that language. File extensions alone do not establish a language requirement.\n- Use one stable \`rule-key:\` tag for mutually exclusive policy versions, and list every replaced rule in \`supersedes\`.\n- Pending replacements do not deactivate approved rules; only human approval makes a replacement authoritative.\n- Use the server-bound developer identity for agent writes; never infer or supply \`developerId\`.\n- Treat agent classification as a proposal; the human-confirmed classification is authoritative.\n- When asked, open \`prooflore_review_rule\` for a candidate. The connected client must collect the human verdict; never infer or supply it.\n- Revoked rules remain in immutable history and only a later human approval may restore them.\n- Treat review conflicts as non-authoritative until a later human verdict merges the branches.\n- Never store secrets, credentials, raw transcripts, personal data or unsupported claims.\n`;
  for (const safeguard of REQUIRED_WORKFLOW_SAFEGUARDS) {
    if (!content.includes(safeguard)) throw new Error(`Generated workflow is missing safeguard: ${safeguard}`);
  }
  return `${content}\n${PROJECT_MEMORY_CHAT_WORKFLOW}\n`;
}

function assertNoWorkflowRuleRemoval(existing: string | undefined, desired: string, accepted: boolean): void {
  if (!existing) return;
  const desiredRules = new Set(desired.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('- ')));
  const desiredHashes = new Set([...desiredRules].map(hash));
  const removed = existing.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('- ') && !desiredRules.has(line)
      && !desiredHashes.has(WORKFLOW_WORDING_MIGRATIONS.get(hash(line)) ?? ''));
  if (removed.length > 0 && !accepted) {
    throw new Error('Managed workflow update would remove or rewrite a prior rule; explicit migration is required');
  }
}

function codexBlock(): string {
  return `${TOML_START}\n[mcp_servers.prooflore]\ncommand = "npm"\nargs = ["exec", "--offline", "--", "prooflore-mcp"]\nenv = { PROOFLORE_ROOT = ".", PROOFLORE_PROVIDER = "codex" }\n${TOML_END}`;
}

function mcpServer(provider: 'claude' | 'cursor'): Record<string, unknown> {
  return {
    command: 'npm',
    args: ['exec', '--offline', '--', 'prooflore-mcp'],
    env: { PROOFLORE_ROOT: '.', PROOFLORE_PROVIDER: provider },
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
  const branded = extractBlock(current, start, end);
  const legacy = extractBlock(current, start.replace('prooflore:', 'project-memory:'), end.replace('prooflore:', 'project-memory:'));
  if (branded && legacy) throw new Error('Both ProofLore and legacy managed blocks exist');
  const block = branded ?? legacy;
  if (start === TOML_START && /^\s*\[mcp_servers\.(?:prooflore|project_memory)\]/mu.test(
    block ? current.slice(0, block.from) + current.slice(block.to) : current,
  )) throw new Error('Existing unmanaged MCP configuration conflicts with ProofLore');
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

function mergeJsonServer(content: string | undefined, provider: 'claude' | 'cursor'): {
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
  if (Object.hasOwn(servers, 'prooflore') && Object.hasOwn(servers, 'project_memory')) {
    throw new Error('Both ProofLore and legacy MCP entries exist');
  }
  const existing = servers.prooflore ?? servers.project_memory;
  delete servers.project_memory;
  const desired = mcpServer(provider);
  servers.prooflore = desired;
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
    return 'Existing unmanaged ProofLore configuration differs';
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
  const hashes = { ...(state?.hashes ?? {}) };

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
      hashes[ownershipKey] = hash(next.ownedContent);
      if (original === next.content) unchanged.push(relativePath);
      else writes.push({ path, content: next.content, original });
    } catch (error) {
      conflicts.push({ path: relativePath, reason: error instanceof Error ? error.message : String(error) });
    }
  };

  await plan(WORKFLOW_PATH, WORKFLOW_PATH, (content) => {
    const desired = workflow(version);
    assertNoWorkflowRuleRemoval(content?.replaceAll('project_memory_', 'prooflore_')
      .replace(LEGACY_REVIEW_PRESENTATION, REVIEW_PRESENTATION)
      .replace(/Use a dash when test types are empty\. (?:If there are no approved rules, say there are no active rules and stop\. )?Include pending/u,
        'Use a dash when test types are empty. If there are no approved rules, say there are no active rules in the language of the latest user message and stop (for Ukrainian: Немає чинних затверджених правил). Include pending')
      .replace('columns localized to the chat. Use the effective catalog tags',
        'columns localized to the chat. Translate each stored rule summary faithfully into the chat language for display. If the user asks for the original, reproduce the stored summary verbatim without translating or paraphrasing. Listing never changes stored text. Use the effective catalog tags')
      .replace(LEGACY_RULE_BROWSING, () => [ACTIVE_RULE_TABLE, PENDING_RULE_REVIEW].join('\n')), desired, options.acceptRuleMigration === true);
    return { content: desired, ownedContent: desired, existingOwned: content };
  });
  await plan(IGNORE_PATH, IGNORE_PATH, (content) => ({
    content: IGNORE_CONTENT,
    ownedContent: IGNORE_CONTENT,
    existingOwned: content,
  }));
  if (providers.includes('codex') || providers.includes('cursor')) {
    await plan('AGENTS.md', 'AGENTS.md#prooflore', (content) => replaceOrAppendBlock(
      content, managedMarkdownBlock(), BLOCK_START, BLOCK_END,
    ));
  }
  if (providers.includes('claude')) {
    await plan('CLAUDE.md', 'CLAUDE.md#prooflore', (content) => replaceOrAppendBlock(
      content, managedMarkdownBlock(), BLOCK_START, BLOCK_END,
    ));
    await plan('.mcp.json', '.mcp.json#mcpServers.prooflore', (content) => mergeJsonServer(content, 'claude'));
  }
  if (providers.includes('codex')) {
    await plan('.codex/config.toml', '.codex/config.toml#prooflore', (content) => replaceOrAppendBlock(
      content, codexBlock(), TOML_START, TOML_END,
    ));
  }
  if (providers.includes('cursor')) {
    await plan('.cursor/mcp.json', '.cursor/mcp.json#mcpServers.prooflore', (content) => mergeJsonServer(content, 'cursor'));
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
  const identity = await resolveProjectMemoryIdentity(root);
  let setup: SetupResult | undefined;
  let setupCheckFailed = false;
  try {
    setup = await checkProjectMemorySetup(root);
  } catch {
    setupCheckFailed = true;
  }
  const notices: string[] = [];
  if (!identity.configured) {
    notices.push('Tell the user once in this conversation that ProofLore developer identity is not configured. Suggest setting the repository Git user.name or running `npx prooflore identity set DEVELOPER_ID`. Agent writes remain blocked until identity is configured.');
  }
  if (setupCheckFailed || setup?.ok === false) {
    notices.push('Tell the user once in this conversation that ProofLore setup requires synchronization. Suggest running `npx prooflore sync`. Do not enforce newly packaged rules until synchronization succeeds.');
  }
  return { lifecycle, identity, setup, setupCheckFailed, notices };
}
