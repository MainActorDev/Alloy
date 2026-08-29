# Alloy

> **Your app. Proven.**

Alloy gives AI agents a single pair of hands and eyes on real mobile devices —
routing every task to the engine that does it best.

One MCP server. One tool surface (`alloy_*`). One error taxonomy. Two specialized
automation engines underneath, chosen per task by a deterministic routing table:
token-lean exploration and device control from one, dense measurement, declarative
flows, and validated evidence from the other.

## Why

Every mobile automation tool is strong somewhere and weak elsewhere. Teams bolt two
together and the agent pays for the seam: two vocabularies, two error shapes, refs
that die at tool boundaries, devices fought over with no arbitration, and
wrong-tool-for-the-job costs of 7–22× tokens per screen (measured on a real app).

Alloy absorbs the seam. The agent states the job — explore, act, measure, verify,
diagnose — and Alloy dispatches to the strongest engine, normalizes every failure
into one structured taxonomy, arbitrates device access with an explicit lease
model, and guarantees artifact integrity (validated video, byte-stable
measurements). Engines are swappable underneath; workflows never change.

## The surface (21 tools)

| Job | Tool | Notes |
|---|---|---|
| explore | `alloy_snapshot` | token-lean visible tree, stable refs, off-screen collapse |
| act | `alloy_act` | press / fill / scroll / long-press with post-action settle diff |
| find | `alloy_find` | by text/label/role/id; fails safe with candidates |
| measure | `alloy_measure` | complete-coordinate tree, verbatim passthrough (golden-tested byte-identical) |
| inspect views | `alloy_native_tree` | UIKit hierarchy, find-views, hit-test at point |
| verify E2E | `alloy_flow` | declarative flows w/ launch-arg preconditions, per-step reports |
| evidence | `alloy_video`, `alloy_screenshot_diff` | playable-artifact-validated MP4, compact visual diff |
| diagnose | `alloy_network`, `alloy_logs`, `alloy_perf`, `alloy_js_debug` | parsed traffic, session logs, frames/memory/cpu, JS runtime |
| system | `alloy_apps`, `alloy_devices`, `alloy_alert`, `alloy_settings`, `alloy_push` | lifecycle + system control |
| replay | `alloy_replay` | deterministic recorded-session replay |
| ops | `alloy_health`, `alloy_release` | engine resolution/skew/claims; lease release |

## Quick start

```bash
pnpm install
cp engines.local.example.jsonc ~/.alloy/engines.local.json  # fill real engine paths
pnpm check          # typecheck + lint + signature scan + tests
pnpm start          # stdio MCP server
```

Engine identities never live in this repo — each machine keeps a gitignored
`~/.alloy/engines.local.json` (or points `ALLOY_ENGINES_CONFIG` at it). If anything
is wrong at startup, the server degrades to listing only `alloy_health`: broken
tools are unreachable, never flaky.

## Design invariants

- **Routing table is the single source of truth** — registration, contract tests,
  docs, and dispatch all derive from one frozen table.
- **One dispatch choke point** — zod-validate → lease → adapter → normalize, for
  every call, with no second path to an engine.
- **One engine per device** — leases are explicit (`alloy_apps open`, flows, replay
  hold; per-call tools auto-release; cross-engine dispatch returns `LEASE_HELD`).
- **Structured errors everywhere** — typed codes with a default branch for unknown
  engine codes; never a raw throw.
- **No engine names in this repo** — CI-enforced signature scan; identities resolve
  at runtime from gitignored config.
- **Fail-closed** — unhealthy engines degrade the surface to `alloy_health` only.

## Performance

Facade overhead vs direct engine calls (paired-interleaved protocol, N=30):
**median 0.2 ms, p95 4.5 ms** — budget 15 ms. Persistent processes only; no
per-call spawns. See `scripts/bench.mjs` and `bench/baseline.json`.

## Status

**Phases 0–4 complete — dogfood-ready.** Live-verified against both engines:
53 unit/contract tests; on-device gates — exploration 8/8, measurement+flows+video
10/10 (incl. golden byte-identity and moov-validated MP4), diagnostics 12/12.
Architecture, phases, and enforcement design: [PLAN.md](./PLAN.md).

## What it is not

Not a test framework (complements XCTest/Maestro-class suites), not a device farm,
not an agent — it's the hands-and-eyes execution layer beneath agents.

## License

MIT — see [LICENSE](./LICENSE).
