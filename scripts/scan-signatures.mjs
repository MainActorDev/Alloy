#!/usr/bin/env node
/**
 * Signature scan: the repo must contain ZERO references to the underlying engine
 * projects — no names, package ids, file paths, or vendor strings. CI gate.
 * Exit 1 on any hit. Intentionally naive substring scan across all text files.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'coverage']);
// This script necessarily contains the signature patterns themselves; it is the one
// file exempt from its own scan.
const SELF = fileURLToPath(import.meta.url);

// Engine signature patterns. Kept in this script ONLY (never in src/).
const PATTERNS = [
  /argent/gi,
  /agent[-_]?device/gi,
  /callstack/gi,
  /swmansion/gi,
  /software[-_]?mansion/gi,
  /thatswiftdev/gi,
];

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonc', '.md', '.txt', '.yaml', '.yml',
  '.sh', '.html', '.css', '.example', '',
]);

function* walk(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const p = join(dir, ent.name);
    if (ent.isDirectory()) yield* walk(p);
    else if (ent.isFile()) yield p;
  }
}

const hits = [];
for (const file of walk(root)) {
  if (file === SELF) continue;
  const dot = file.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.slice(dot);
  if (!TEXT_EXT.has(ext)) continue;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(text);
    if (m) {
      const before = text.slice(0, m.index).split('\n').length;
      hits.push(`${relative(root, file)}:${before}: ${re.source}`);
      break;
    }
  }
}

if (hits.length > 0) {
  console.error(`SIGNATURE SCAN FAILED — ${hits.length} hit(s):`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('signature scan: CLEAN');
