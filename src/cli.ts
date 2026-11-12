#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  buildMemoryContext,
  classifyRule,
  explainMemoryContext,
  inspectRuleTaxonomy,
  listRuleCandidates,
  listRules,
} from './context.js';
import { resolveProjectMemoryIdentity, setProjectMemoryIdentity } from './identity.js';
import { runProjectMemoryMcp } from './mcp.js';
import {
  checkProjectMemorySetup,
  SETUP_PROVIDERS,
  setupProjectMemory,
  type SetupProvider,
} from './setup.js';
import { ProjectMemoryStore, resolveReviewStates } from './store.js';
import type { ReviewRecord, ReviewVerdict, RuleCandidateState } from './types.js';
import { parseRecordInput, parseRuleClassification, stringValue } from './validation.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function facetOption(args: string[], name: string, fallback: string[]): string[] {
  const value = option(args, name);
  if (value === undefined) return fallback;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  const globalItems = items.filter((item) => ['global', '*'].includes(item.toLocaleLowerCase()));
  if (globalItems.length > 0) {
    if (items.length === 1) return [];
    throw new Error(`${name} cannot combine global with named facets`);
  }
  return items;
}

function validateReviewArguments(args: string[]): void {
  const allowed = new Set(['--reason', '--developer', '--area', '--language', '--test-type']);
  const seen = new Set<string>();
  for (let index = 3; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.has(name) || seen.has(name) || !value || value.startsWith('--')) usage();
    seen.add(name);
  }
  if (args.length > 3 && (args.length - 3) % 2 !== 0) usage();
}

function usage(): never {
  throw new Error('Usage: prooflore setup|update|sync [--project ID] [--provider codex|claude|cursor] [--dry-run|--check] [--accept-rule-migration] | init --project ID | identity set DEVELOPER_ID | identity show | doctor | context TASK [--path PATH] | explain-context TASK [--path PATH] [--limit N] | candidates [--cursor ID] [--limit N] | rules [--state STATE] [--area AREA] [--language LANGUAGE] [--test-type TYPE] [--cursor ID] [--limit N] | history ID | record --file JSON | review ID approved|rejected|revoked|superseded --reason TEXT --developer ID [--area A,B|global] [--language L|global] [--test-type T|global] | mcp');
}

/** Runs the ProofLore administration CLI. */
export async function runCli(args = process.argv.slice(2), root = process.cwd()): Promise<unknown> {
  const command = args[0];
  const store = new ProjectMemoryStore(root);
  if (command === 'setup' || command === 'update' || command === 'sync') {
    const providers: SetupProvider[] = [];
    let projectId: string | undefined;
    let dryRun = false;
    let check = false;
    let acceptRuleMigration = false;
    for (let index = 1; index < args.length; index += 1) {
      const value = args[index];
      if (value === '--provider') {
        const provider = args[index + 1] as SetupProvider | undefined;
        if (!provider || !SETUP_PROVIDERS.includes(provider)) usage();
        providers.push(provider);
        index += 1;
      } else if (value === '--project') {
        if (projectId !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) usage();
        projectId = args[index + 1];
        index += 1;
      } else if (value === '--dry-run') dryRun = true;
      else if (value === '--check') check = true;
      else if (value === '--accept-rule-migration') acceptRuleMigration = true;
      else usage();
    }
    if (dryRun && check) usage();
    return setupProjectMemory({
      root,
      projectId,
      providers: providers.length > 0 ? providers : undefined,
      dryRun,
      check,
      acceptRuleMigration,
    });
  }
  if (command === 'init') return store.initialize(option(args, '--project') ?? usage());
  if (command === 'identity') {
    if (args[1] === 'set' && args.length === 3) {
      const identity = await setProjectMemoryIdentity(root, args[2]);
      return { configured: true, developerId: identity.developerId, source: 'local' };
    }
    if (args[1] === 'show' && args.length === 2) return resolveProjectMemoryIdentity(root);
    return usage();
  }
  if (command === 'doctor') {
    const status = await store.status();
    if (status.corruptedRecords.length > 0) throw new Error(`Corrupted records: ${status.corruptedRecords.join(', ')}`);
    const setup = await checkProjectMemorySetup(root);
    const taxonomyWarnings = await inspectRuleTaxonomy(store);
    const identity = await resolveProjectMemoryIdentity(root);
    return {
      ok: status.reviewConflicts === 0 && identity.configured && (setup?.ok ?? true),
      ...status,
      identity,
      taxonomyWarnings,
      setup,
    };
  }
  if (command === 'candidates') {
    const limitValue = option(args, '--limit');
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    return listRuleCandidates(store, option(args, '--cursor'), limit);
  }
  if (command === 'rules') {
    const limitValue = option(args, '--limit');
    const limit = limitValue === undefined ? 50 : Number(limitValue);
    return listRules(store, {
      state: option(args, '--state') as RuleCandidateState | undefined,
      area: option(args, '--area'),
      language: option(args, '--language'),
      testType: option(args, '--test-type'),
    }, option(args, '--cursor'), limit);
  }
  if (command === 'context') {
    const task = args[1] ?? usage();
    const paths = args.flatMap((value, index) => value === '--path' && args[index + 1] ? [args[index + 1]] : []);
    return buildMemoryContext(store, task, paths);
  }
  if (command === 'explain-context') {
    const task = args[1] ?? usage();
    const paths = args.flatMap((value, index) => value === '--path' && args[index + 1] ? [args[index + 1]] : []);
    const limitValue = option(args, '--limit');
    return explainMemoryContext(store, task, paths, limitValue === undefined ? 100 : Number(limitValue));
  }
  if (command === 'history') return store.ruleHistory(args[1] ?? usage());
  if (command === 'record') {
    const file = option(args, '--file') ?? usage();
    return store.record(parseRecordInput(JSON.parse(await readFile(file, 'utf8'))), 'human');
  }
  if (command === 'review') {
    const targetId = args[1] ?? usage();
    const verdict = args[2] as ReviewVerdict;
    if (!['approved', 'rejected', 'revoked', 'superseded'].includes(verdict)) usage();
    validateReviewArguments(args);
    const candidate = await store.readRecord(targetId);
    if (candidate.kind !== 'rule_candidate') throw new Error('Only rule candidates can be reviewed');
    const reviewState = resolveReviewStates((await store.ruleHistory(targetId))
      .filter((record): record is ReviewRecord => record.kind === 'review'));
    const current = reviewState.latest.get(targetId)?.classification ?? classifyRule(candidate);
    const classification = parseRuleClassification({
      areas: facetOption(args, '--area', current.areas),
      languages: facetOption(args, '--language', current.languages),
      testTypes: facetOption(args, '--test-type', current.testTypes),
    });
    return store.review(
      targetId,
      verdict,
      stringValue(option(args, '--reason'), 'reason', 2000),
      stringValue(option(args, '--developer'), 'developer', 128),
      classification,
    );
  }
  if (command === 'mcp') return runProjectMemoryMcp(root);
  return usage();
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await runCli();
    if (output !== undefined) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (output && typeof output === 'object' && 'ok' in output && output.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
