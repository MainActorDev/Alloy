import { describe, expect, it } from 'vitest';
import { routingTable, routingToolNames, getRoutingRow } from '../src/routing.ts';

describe('routing table invariants (§12.1)', () => {
  it('every row has tool/engine/lease/summary/schema', () => {
    for (const r of routingTable) {
      expect(r.tool, 'tool name').toBeTruthy();
      expect(['A', 'B']).toContain(r.engine);
      expect(['per-call', 'held']).toContain(r.lease);
      expect(r.summary.length).toBeGreaterThan(10);
      expect(r.schema).toBeDefined();
    }
  });
  it('tool names are unique and alloy_-prefixed', () => {
    const names = routingTable.map((r) => r.tool);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.startsWith('alloy_')).toBe(true);
  });
  it('getRoutingRow finds every listed name', () => {
    for (const n of routingToolNames) expect(getRoutingRow(n)).toBeDefined();
  });
  it('alloy_health exists and is per-call', () => {
    const h = getRoutingRow('alloy_health');
    expect(h?.lease).toBe('per-call');
    expect(h?.engine).toBe('A');
  });
  it('held tools are exactly the known set', () => {
    const held = routingTable.filter((r) => r.lease === 'held').map((r) => r.tool);
    expect(held.sort()).toEqual(['alloy_apps', 'alloy_flow']);
  });
});
