import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertFreshArtifact, newestSourceMtime } from '../src/freshness.ts';
import { AlloyError } from '../src/errors.ts';

let dir: string;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'alloy-fresh-'));
  mkdirSync(join(dir, 'Sources'));
  mkdirSync(join(dir, 'node_modules')); // must be skipped
  writeFileSync(join(dir, 'Sources', 'A.swift'), 'let a = 1\n');
  writeFileSync(join(dir, 'node_modules', 'junk.js'), 'x'.repeat(100));
  return dir;
}

beforeEach(setup);
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T0 = Date.parse('2026-01-01T00:00:00Z') / 1000;
const T1 = Date.parse('2026-02-01T00:00:00Z') / 1000;

describe('newestSourceMtime', () => {
  it('finds the newest file, skipping ignore dirs', () => {
    utimesSync(join(dir, 'Sources', 'A.swift'), T1, T1);
    utimesSync(join(dir, 'node_modules', 'junk.js'), T1 + 9999, T1 + 9999); // newer but skipped
    const r = newestSourceMtime(dir);
    expect(r.path).toContain('A.swift');
  });
  it('throws on empty tree', () => {
    const empty = mkdtempSync(join(tmpdir(), 'alloy-empty-'));
    expect(() => newestSourceMtime(empty)).toThrowError(AlloyError);
    rmSync(empty, { recursive: true, force: true });
  });
  it('throws on missing root', () => {
    expect(() => newestSourceMtime('/nonexistent/nowhere')).toThrowError(AlloyError);
  });
});

describe('assertFreshArtifact', () => {
  it('fresh artifact passes', () => {
    const art = join(dir, 'App.app');
    writeFileSync(art, 'binary');
    utimesSync(art, T1, T1); // artifact newer than source
    utimesSync(join(dir, 'Sources', 'A.swift'), T0, T0);
    const r = assertFreshArtifact(art, dir);
    expect(r.fresh).toBe(true);
  });
  it('stale artifact throws STALE_ARTIFACT with evidence', () => {
    const art = join(dir, 'App.app');
    writeFileSync(art, 'binary');
    utimesSync(art, T0, T0); // artifact OLDER than source
    utimesSync(join(dir, 'Sources', 'A.swift'), T1, T1);
    try {
      assertFreshArtifact(art, dir);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AlloyError);
      const e = err as AlloyError;
      expect(e.code).toBe('STALE_ARTIFACT');
      expect(e.details?.newestSourcePath).toContain('A.swift');
      expect(e.details?.retriable).toBe(true);
      expect(typeof e.details?.artifactMtime).toBe('number');
    }
  });
  it('missing artifact throws INVALID_ARGS', () => {
    expect(() => assertFreshArtifact(join(dir, 'nope.app'), dir)).toThrowError(AlloyError);
  });
});
