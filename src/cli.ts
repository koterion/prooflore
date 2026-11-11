#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { buildMemoryContext, listRuleCandidates } from './context.js';
import { runProjectMemoryMcp } from './mcp.js';
import {
  checkProjectMemorySetup,
  SETUP_PROVIDERS,
  setupProjectMemory,
  type SetupProvider,
} from './setup.js';
import { ProjectMemoryStore } from './store.js';
import type { ReviewVerdict } from './types.js';
import { parseRecordInput, stringValue } from './validation.js';

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage(): never {
  throw new Error('Usage: prooflore setup|update|sync [--project ID] [--provider codex|claude|cursor] [--dry-run|--check] [--accept-rule-migration] | init --project ID | doctor | context TASK [--path PATH] | candidates [--cursor ID] [--limit N] | record --file JSON | review ID approved|rejected|superseded --reason TEXT --developer ID | mcp');
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
  if (command === 'doctor') {
    const status = await store.status();
    if (status.corruptedRecords.length > 0) throw new Error(`Corrupted records: ${status.corruptedRecords.join(', ')}`);
    const setup = await checkProjectMemorySetup(root);
    return { ok: status.reviewConflicts === 0 && (setup?.ok ?? true), ...status, setup };
  }
  if (command === 'candidates') {
    const limitValue = option(args, '--limit');
    const limit = limitValue === undefined ? 20 : Number(limitValue);
    return listRuleCandidates(store, option(args, '--cursor'), limit);
  }
  if (command === 'context') {
    const task = args[1] ?? usage();
    const paths = args.flatMap((value, index) => value === '--path' && args[index + 1] ? [args[index + 1]] : []);
    return buildMemoryContext(store, task, paths);
  }
  if (command === 'record') {
    const file = option(args, '--file') ?? usage();
    return store.record(parseRecordInput(JSON.parse(await readFile(file, 'utf8'))), 'human');
  }
  if (command === 'review') {
    const targetId = args[1] ?? usage();
    const verdict = args[2] as ReviewVerdict;
    if (!['approved', 'rejected', 'superseded'].includes(verdict)) usage();
    return store.review(
      targetId,
      verdict,
      stringValue(option(args, '--reason'), 'reason', 2000),
      stringValue(option(args, '--developer'), 'developer', 128),
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
