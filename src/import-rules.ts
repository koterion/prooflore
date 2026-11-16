import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { LANGUAGE_TEST_RULE_TAG, listRules } from './context.js';
import { resolveProjectMemoryIdentity } from './identity.js';
import type { ProjectMemoryStore } from './store.js';
import { parseRecordInput, relativeProjectPath } from './validation.js';

/** Extracts explicit Markdown list entries while ignoring examples and managed setup. */
function markdownRules(source: string): string[] {
  const rules: string[] = [];
  let fence: string | undefined;
  let managed = false;
  for (const line of source.split(/\r?\n/u)) {
    const marker = line.trim().match(/^(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker.startsWith(fence) && line.trim() === marker) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^\s*<!--\s*(?:prooflore|project-memory):managed:start\s*-->/u.test(line)) managed = true;
    if (/^\s*<!--\s*(?:prooflore|project-memory):managed:end\s*-->/u.test(line)) managed = false;
    if (managed) continue;
    const entry = line.match(/^(?:[-*+]|\d+[.)])\s+(.+)$/u)?.[1];
    if (entry) rules.push(entry.trim());
    else if (/^ {2,}\S/u.test(line) && rules.length && !/^\s+(?:[-*+]|\d+[.)])\s/u.test(line)) {
      rules[rules.length - 1] += ' ' + line.trim();
    }
  }
  return rules;
}

/** Previews or imports curated project Markdown rules as pending candidates. */
export async function importRules(store: ProjectMemoryStore, file: string, apply: boolean, localOnly: boolean) {
  const source = relativeProjectPath(file, 'source file');
  const root = await realpath(store.root);
  const path = await realpath(join(root, source));
  const resolved = relativeProjectPath(relative(root, path), 'resolved source file');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > 64 * 1024 || !/\.md$/iu.test(resolved)
    || resolved === '.prooflore' || resolved.startsWith('.prooflore/')) {
    throw new Error('Import expects a project Markdown file outside .prooflore, up to 64 KiB');
  }
  const rules = markdownRules(await readFile(path, 'utf8'));
  if (!rules.length || rules.length > 100) throw new Error('Import expects 1 to 100 top-level Markdown list items');
  const identity = await resolveProjectMemoryIdentity(root);
  if (apply && !identity.developerId) throw new Error('Configure your ProofLore identity before importing rules');
  const key = (summary: string) => summary.trim().replace(/\s+/gu, ' ').toLowerCase();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await listRules(store, {}, cursor);
    for (const rule of page.items) if (Boolean(rule.localOnly) === localOnly) seen.add(key(rule.summary));
    cursor = page.nextCursor;
  } while (cursor);
  const planned = rules.map((summary) => {
    const input = parseRecordInput({
      kind: 'rule_candidate', summary, rationale: 'Imported from existing project guidance.',
      developerId: identity.developerId ?? 'import-preview', localOnly,
      tags: [LANGUAGE_TEST_RULE_TAG], evidence: [{ path: source }],
    });
    const normalized = key(input.summary);
    const duplicate = seen.has(normalized);
    seen.add(normalized);
    return { input, duplicate };
  });
  const items = [];
  for (const { input, duplicate } of planned) {
    if (duplicate || !apply) {
      items.push({ summary: input.summary, status: duplicate ? 'duplicate' : 'pending-preview' });
    } else {
      const { record, created } = await store.record(input, 'human');
      items.push({ summary: input.summary, status: created ? 'pending' : 'duplicate', id: record.id });
    }
  }
  return { source, mode: apply ? 'apply' : 'preview', localOnly, items };
}
