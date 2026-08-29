# Alloy

> **Your app. Proven.**

Alloy gives AI agents a single pair of hands and eyes on real mobile devices — routing
every task to the engine that does it best.

One MCP server. One tool surface (`alloy_*`). One error taxonomy. Two specialized
automation engines underneath, chosen per task by a deterministic routing table:
token-lean exploration and device control from one, dense measurement, declarative
flows, and validated evidence from the other.

## Status

Phase 0 (scaffold) — see [PLAN.md](./PLAN.md) for the full architecture, routing
table, and phase gates. Brand/positioning reference: [BRANDING.md](./BRANDING.md).

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
