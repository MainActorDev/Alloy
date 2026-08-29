# Alloy

> **Your app. Proven.**

Alloy gives AI agents a single pair of hands and eyes on real mobile devices — routing
every task to the engine that does it best.

One MCP server. One tool surface (`alloy_*`). One error taxonomy. Two specialized
automation engines underneath, chosen per task by a deterministic routing table:
token-lean exploration and device control from one, dense measurement, declarative
flows, and validated evidence from the other.

## Status

**Phases 0–4 complete — dogfood-ready.** 21 tools, live-verified against both
engines (unit/contract 53 tests; on-device gates: exploration 8/8, measurement+
flows+video 10/10, diagnostics 12/12). Facade overhead: median 0.2ms / p95 4.5ms
vs direct engine calls (budget 15ms). Architecture and phase gates:
[PLAN.md](./PLAN.md) · Brand: [BRANDING.md](./BRANDING.md) · Bench protocol:
`scripts/bench.mjs` + `bench/baseline.json`.

## Quick start

```bash
pnpm install
cp engines.local.example.jsonc ~/.alloy/engines.local.json  # fill real engine paths
pnpm check          # typecheck + lint + signature scan + tests
pnpm start          # stdio MCP server
```

Engine identities never live in this repo — each machine keeps a gitignored
`~/.alloy/engines.local.json` (or point `ALLOY_ENGINES_CONFIG` at it). If anything is
wrong at startup, the server degrades to listing only `alloy_health`.

## Design invariants

- Routing table is the single source of truth; registration, tests, docs derive from it.
- One dispatch choke point: zod-validate → lease → adapter → normalize errors.
- One active engine per device; leases are explicit, release-on-error mandatory.
- No engine names anywhere in this repo (CI-enforced signature scan).
- Fail-closed: broken engines are unreachable, never flaky.

## License

MIT (see LICENSE file when published).
