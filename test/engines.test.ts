import { describe, expect, it } from 'vitest';
import {
  enginesConfigPath,
  loadEnginesFile,
  parseJsonc,
  resolveEngines,
  validateEnginesFile,
} from '../src/engines.ts';
import { AlloyError } from '../src/errors.ts';

describe('parseJsonc', () => {
  it('parses plain JSON', () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips // comments', () => {
    expect(parseJsonc('{\n // hi\n "a": 1\n}')).toEqual({ a: 1 });
  });
  it('tolerates BOM', () => {
    expect(parseJsonc('\uFEFF{"a":1}')).toEqual({ a: 1 });
  });
});

describe('validateEnginesFile', () => {
  const good = {
    engineA: { module: '/x/a', entry: 'e.js', version: '1.0.0' },
    engineB: { workspace: '/x/b', entry: 'e.js' },
  };
  it('accepts a valid file', () => {
    expect(validateEnginesFile(good)).toEqual(good);
  });
  it('rejects non-absolute module', () => {
    expect(() =>
      validateEnginesFile({ ...good, engineA: { module: 'rel/a', entry: 'e.js', version: '1' } }),
    ).toThrowError(AlloyError);
  });
  it('rejects missing engineB', () => {
    expect(() => validateEnginesFile({ engineA: good.engineA })).toThrowError(AlloyError);
  });
  it('rejects empty entry', () => {
    expect(() =>
      validateEnginesFile({ ...good, engineB: { workspace: '/x/b', entry: '' } }),
    ).toThrowError(AlloyError);
  });
});

describe('enginesConfigPath', () => {
  it('explicit wins', () => {
    expect(enginesConfigPath('/tmp/x.json')).toBe('/tmp/x.json');
  });
  it('env var second', () => {
    process.env['ALLOY_ENGINES_CONFIG'] = '/tmp/env.json';
    expect(enginesConfigPath()).toBe('/tmp/env.json');
    delete process.env['ALLOY_ENGINES_CONFIG'];
  });
});

describe('loadEnginesFile + resolveEngines', () => {
  it('missing file → CONFIG_MISSING', () => {
    expect(() => loadEnginesFile('/nonexistent/nope.json')).toThrowError(/CONFIG_MISSING|not found/);
  });
  it('resolves import URLs', () => {
    const f = validateEnginesFile({
      engineA: { module: '/tmp/eng-a', entry: 'dist/i.js', version: '1.0.0' },
      engineB: { workspace: '/tmp/eng-b-root', entry: 'pkg/d/i.js' },
    });
    const r = resolveEngines(f);
    expect(r.engineA.importUrl).toContain('file:///tmp/eng-a/dist/i.js');
    expect(r.engineB.importUrl).toContain('file:///tmp/eng-b-root/pkg/d/i.js');
  });
});
