/**
 * Freshness gate at the build seam (PLAN Phase 5a). Before installing an artifact,
 * Alloy can verify the artifact is not older than the newest source file. Stale
 * installs return a typed STALE_ARTIFACT error instead of silently verifying the
 * wrong binary (recorded pitfall: "verify MTIME > src EVERY build").
 */
import { statSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { AlloyError } from './errors.ts';

const MAX_FILES = 20_000;
const SKIP_DIRS = new Set([
  'node_modules', '.build', 'DerivedData', '.git', '.DS_Store',
  'dist', 'build', 'Pods', '.swiftpm', '.venv',
]);

export interface FreshnessResult {
  fresh: boolean;
  artifactMtime: number;
  newestSourceMtime: number;
  newestSourcePath: string;
}

/** Newest source mtime under root, bounded; throws on unreadable/oversized trees. */
export function newestSourceMtime(root: string): { mtime: number; path: string } {
  let newest = { mtime: 0, path: '' };
  let visited = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as Dirent[];
    } catch (err) {
      throw new AlloyError('INVALID_ARGS', `srcPath walk failed at ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const ent of entries) {
      if (ent.name === '.DS_Store') continue;
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        visited++;
        stack.push(p);
      } else if (ent.isFile()) {
        visited++;
        let mtimeMs: number;
        try {
          mtimeMs = statSync(p).mtimeMs;
        } catch {
          continue; // raced deletion — not a freshness signal
        }
        if (mtimeMs > newest.mtime) newest = { mtime: mtimeMs, path: p };
      }
      if (visited > MAX_FILES) {
        throw new AlloyError('INVALID_ARGS', `srcPath tree too large (>${MAX_FILES} entries under ${root}); narrow the srcPath`);
      }
    }
  }
  if (newest.mtime === 0) {
    throw new AlloyError('INVALID_ARGS', `no source files found under ${root}`);
  }
  return newest;
}

/** Compare artifact vs newest source. Throws STALE_ARTIFACT when stale. */
export function assertFreshArtifact(artifactPath: string, srcRoot: string): FreshnessResult {
  let artifactMtime: number;
  try {
    artifactMtime = statSync(artifactPath).mtimeMs;
  } catch (err) {
    throw new AlloyError('INVALID_ARGS', `artifact not found at ${artifactPath}`, { cause: err });
  }
  const newest = newestSourceMtime(srcRoot);
  if (newest.mtime > artifactMtime) {
    throw new AlloyError('STALE_ARTIFACT', `artifact predates source changes — rebuild before installing`, {
      details: {
        artifactMtime,
        newestSourceMtime: newest.mtime,
        newestSourcePath: newest.path,
        hint: 'rebuild the artifact, then retry install',
        retriable: true,
      },
    });
  }
  return {
    fresh: true,
    artifactMtime,
    newestSourceMtime: newest.mtime,
    newestSourcePath: newest.path,
  };
}
