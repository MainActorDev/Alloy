# PLAN — Alloy: unified mobile automation facade

**Status: DRAFT v4 — self-reviewed; awaiting human approval before any build work.**
Date: 2026-08-29 · Location: `ai/alloy/` · Changelog: v4 = self-review amendments (§5 lease model, §8 test/bench protocol, §12 enforcement) + fixes F1–F10.

## 1. Goal

One MCP server exposing the best-of-breed capability for every mobile-automation job,
routing to the stronger engine per capability. Agents (any MCP client) see a single
coherent `alloy_*` tool surface; engines stay swappable underneath.

**Naming constraint (user-mandated):** this repo and its code carry NO references to
the underlying engine projects — no project names, package names, file paths, URLs, or
ecosystem vocabulary. Engines are referred to as **Engine A** and **Engine B** in all
first-party code and docs. Their concrete identities exist only in a gitignored
`engines.local.json` (resolved at runtime) and in engine repos themselves (outside this
repo). The public identity is: **Alloy** — general-purpose, brand-free.

## 2. Engines (abstracted)

| Codename | Role in Alloy | Why |
|---|---|---|
| **Engine A** | device control daemon: sessions, device claims, typed errors, token-lean snapshots, `--settle` action diffs, diagnostics (network/logs/perf), settings/push/alerts, replay scripts | broadest surface, claim-arbitrated, measured 30× cold-start advantage, failsafe ambiguity candidates |
| **Engine B** | tool registry over HTTP: complete-coordinate measurement trees, native view hierarchy + hit-testing, declarative flow engine with launch-arg preconditions, validated video capture, compact screenshot diffing, deep JS runtime introspection | measurement density (3.6KB complete coords vs 25–80KB), flow engine with per-AC fragments, moov-validated MP4s |

Both engines are consumed **in-process**: Engine A via its published client library
(daemon auto-spawned), Engine B via its tools-client launcher (shared persistent HTTP
tool server). No subprocess-per-call for either; no forks; exact version pins.

## 3. Architecture

### 3.1 Tech-stack decision record

**Hard constraint — adapter layer is Node/TypeScript, not a choice.** Both engines are
consumed in-process through their published client libraries (Engine A: daemon client;
Engine B: tools-client over HTTP). Rust/Go/zig would force subprocess-per-call (slower,
no shared daemon state) or protocol reimplementation (fragile, high drift risk). TS
gives compile-time checks against both engines' exported contract types — the cheapest
correctness we can buy.

| Layer | Choice | Why (robust / testable / reliable / fast) |
|---|---|---|
| Language | **TypeScript (strict)** | compile-time contract checking against both engines' exported types; unified error taxonomy derives from engine A's typed codes |
| Runtime | **Node.js 24.x** (nvm-managed, exact major matching the engine installs) | required by both engines' client libs; version-major parity avoids daemon skew |
| MCP SDK | **`@modelcontextprotocol/sdk`** (pin minor) | the SDK both engines themselves use — protocol behavior parity, single stdio implementation to trust |
| Schema/validation | **zod** | Engine B's tools are zod-native (`zodSchema` per tool); validation errors map into `AlloyError.details` |
| Test runner | **vitest** | same runner both engines use; contract/golden/unit/live tiers all in one |
| Live app target | **System Settings.app on the Apple simulator** | Hermetic-ish live tests need no app build, no bundle id, no credentials — run the full alloy surface against a first-party OS app |
| Lint/format | **oxlint** | fast, zero-config baseline |
| Build | **tsdown** (build-only, no runtime bundling) | library-grade ESM/CJS output; server stays a plain node process |
| Transport (internal) | Engine A daemon (auto-spawned) + Engine B HTTP tool server (spawned+reused via its launcher) | both persistent — per-call overhead is one in-process function call + one HTTP/daemon round-trip; no process spawn per tool call |
| Package mgr | **pnpm** | workspace protocol; engine B workspace resolves via `file:` links without publishing |

**Why not Rust/Go/Bun:** Bun's runtime differences under native deps and daemons are a
risk class we don't need; Rust/Go can't import the engines' client libraries at all.
Where raw speed matters (snapshot text rendering, diff computation, JSON transforms),
those are O(node count) render/transform functions — micro-optimizable in TS without
changing the stack. The genuine hot path is the engines themselves (daemon round-trips);
the facade adds µs-scale overhead by design (thin routing, no re-serialization).

**Performance budget (enforced by benchmarks, §8.4):** facade overhead per tool call
≤ 15ms p95; snapshot text output byte-size within ±10% of engine A's own rendering; no
added process spawns at steady state.

### 3.2 Topology

```
                    ┌──────────────────────────────┐
  any MCP client ──▶│  alloy (Node/TS, stdio MCP)  │
                    │  ─ routing table (data, 1src) │
                    │  ─ dispatch choke point       │
                    │  ─ engine adapters (2)        │
                    │  ─ lease state machine        │
                    │  ─ engine resolution (runtime)│
                    └───────┬──────────────┬───────┘
                            │              │
              EngineAAdapter│              │EngineBAdapter
              (client lib)  │              │(tools-client)
                            ▼              ▼
                   Engine A daemon      Engine B tool server
                   (auto-spawned)       (spawned+reused, HTTP)
```

**Engine resolution (the no-signature mechanism):**
- `engines.local.json` (gitignored, path via `ALLOY_ENGINES_CONFIG` env or default
  `~/.alloy/engines.local.json`) maps `engineA` / `engineB` to concrete install paths:
  `{ "engineA": { "module": "<abs path to installed package>", "version": "0.20.11" },
     "engineB": { "workspace": "<abs path to Engine B monorepo root>" } }`
- Adapters import through these resolved paths at startup. The repo's `package.json`
  dependencies contain only neutral infra (`@modelcontextprotocol/sdk`, `zod`, `tsx`).
  Engine module names never appear in source, lockfile, or docs.
- **Resolution prerequisites (checked by `alloy_health`, fail-closed with neutral
  errors):** engine A path must have its own installed dependency tree and match the
  pinned version; engine B workspace must be built (dist present) with its dependency
  tree installed. Missing prerequisites → degraded mode (§12.6).

## 4. Capability routing table

| Alloy tool | Engine | Lease | Rationale |
|---|---|---|---|
| `alloy_snapshot` (explore, token-lean) | A | per-call | off-screen collapse, small payloads, discovery hints |
| `alloy_act` (press/click/fill/scroll/longpress + settle diff; zod discriminated union, one variant = one code path) | A | per-call | post-action UI diff loop, failsafe ambiguity |
| `alloy_find` | A | per-call | candidates + typed errors |
| `alloy_measure` (parity/layout) | B | per-call | complete coords for ALL elements incl. below-fold at ~3.6KB |
| `alloy_native_tree` (view hierarchy, hit-test) | B | per-call | no Engine A equivalent |
| `alloy_flow` (E2E from ticket ACs) | B | **held for run** | flow engine: launch-args, optional steps, tiered tap targeting |
| `alloy_flow_record` | B | held for recording | flow recording tools |
| `alloy_flow_report` | B | per-call | structured per-AC report |
| `alloy_video` | B | per-call pair (start→stop) | validated video capture (playable-artifact guarantee) |
| `alloy_screenshot_diff` | B | per-call | compact visual diff |
| `alloy_network` | A | per-call | parsed request dump |
| `alloy_logs` | A | per-call | mark/capture, session-scoped |
| `alloy_perf` | A | per-call | frames/memory samples |
| `alloy_js_debug` | B | per-call | deep runtime introspection (eval, fiber/commit trees) — contract-fixture coverage only until an RN test app exists (F7) |
| `alloy_settings` | A | per-call | permissions, airplane mode |
| `alloy_push` | A | per-call | push payload delivery |
| `alloy_alert` | A | per-call | typed alert handling |
| `alloy_apps` (open/install/reinstall, launch-args) | A | **held until release** | parity verified on real app |
| `alloy_devices` (boot/list/claims) | A | per-call | claim model |
| `alloy_release` (end session / release device lease) | A | — | explicit release path (F2) |
| `alloy_replay` | A | held for run | recorded exploration replay |
| `alloy_health` | both | — | engine resolution, versions, warm/cold state, claim state |

Routing is a static table (data) with per-tool `engine` + `lease` fields; overrides via
`~/.alloy/routing.json` (gitignored) are **validated at startup against the table —
unknown tool names or engines fail closed** (F11).

## 5. Session & device arbitration

1. **Lease model (v4, replaces "batch" wording — F1):** the lease map `{udid → engine}`
   is driven by a pure state machine with exactly two held-lease producers —
   `alloy_apps` (open) and `alloy_flow`/`alloy_flow_record`/`alloy_replay` (run scope).
   Everything else takes a **per-call lease**: acquire → dispatch → auto-release inside
   `dispatch()`. Held leases release via `alloy_release`, run completion, or error path
   (release-on-error is mandatory and tested).
2. **One active engine per device.** A held lease blocks the other engine's dispatch on
   that udid with `LEASE_HELD` (structured, includes holder + release hint). Handoff =
   release-then-acquire; both engines' per-device helpers are designed to coexist
   (verified in the 2026-08-29 benchmark where both drove one simulator), so handoff
   needs no teardown beyond lease transition.
3. **Engine A device claims are authoritative** for its sessions (host-global, typed
   conflict reasons). Alloy surfaces claim conflicts verbatim with recovery hints;
   never force-deletes claims. Alloy's own lease map is *advisory on top* — Engine A
   claims remain the hard boundary.
4. **Engine B side**: shared singleton tool server (HTTP) is concurrency-safe; per-UDID
   device subprocesses are not. Dispatch serializes Engine B mutations per-UDID via an
   in-process queue.
5. **Refs never cross engines.** Element refs are engine-local; alloy tools reject
   foreign ref shapes with a neutral error.
6. **Coexist-window caveat (F5):** during dogfood, raw engine MCP entries remain
   enabled. Engine A is protected against bypass (host-global claims catch any raw
   call); Engine B has no equivalent — so the rule for agents is *one engine surface
   (alloy OR raw) per verification run*. Alloy cannot enforce this for raw B calls;
   documented, not hidden.

## 6. Normalized contracts

- `AlloyError = { code, message, details?: {hint?, retriable?, reason?, candidates?}, engine }`
  — superset of Engine A typed errors (default branch for unknown codes); Engine B
  structured failure shapes map in (`error_code` → `code`; zod issues → `details`).
- `AlloySnapshot` (explore): Engine A node list verbatim (rect optional).
- `AlloyMeasurement`: Engine B measurement tree verbatim — golden comparison is
  **canonical-JSON byte-identical modulo the one documented delta: artifact handles map
  to `{artifactId, engine, url, mimeType}`** (F3). No other transformation permitted;
  enforced by the golden differ which whitelists exactly this key set.
- Artifacts: both engines' artifact handles → `{artifactId, engine, url, mimeType}`.

## 7. Phases (each gate = named tests green in CI — F10)

**Phase 0 — scaffold (½ day)**
`ai/alloy/` TypeScript project: `@modelcontextprotocol/sdk`, `zod`, `tsx`, vitest,
oxlint, tsdown. Engine resolution + prerequisites check + `alloy_health`. Degraded-mode
listing. CI pipeline skeleton (typecheck → lint+signature-scan → unit).
*Gate: `test/unit/resolution.test.ts`, `test/unit/health.test.ts` green; MCP test client
connects; health reports both engines resolved + versions + prerequisites.*

**Phase 1 — exploration surface (1–2 days)**
`alloy_snapshot`, `alloy_act`, `alloy_find`, `alloy_apps`, `alloy_devices`,
`alloy_release`, `alloy_alert`, `alloy_settings`. Lease state machine + dispatch choke
point. Error normalization.
*Gate: `test/unit/lease-machine.test.ts` (exhaustive transitions), `test/contract/*.test.ts`
(fixtures for every Phase-1 tool), `test/live/pilot.test.ts` — drives Settings.app
home→search through alloy tools only, auto-skips without simulator.*

**Phase 2 — measurement & flows (1–2 days)**
`alloy_measure`, `alloy_native_tree`, `alloy_flow`, `alloy_flow_record`,
`alloy_flow_report`, `alloy_video`, `alloy_screenshot_diff`. Handoff enforcement.
*Gate: `test/contract/measure-golden.test.ts` (canonical-JSON identity vs recorded
engine output), `test/live/flow.test.ts` — real flow with launch-arg precondition +
validated MP4 artifact on Settings.app or the consumer app.*

**Phase 3 — diagnostics (1 day)**
`alloy_network`, `alloy_logs`, `alloy_perf`, `alloy_js_debug` (fixture-only), 
`alloy_push`, `alloy_replay`.
*Gate: `test/live/diagnostics.test.ts` — network dump + logs captured during a replay
run; `test/contract/js-debug.test.ts` fixtures.*

**Phase 4 — integration (½ day)**
Hermes wrapper + `hermes mcp add alloy`; skill update (routing + arbitration + rule
5.6); raw engine entries stay enabled.
*Gate: fresh Hermes session lists alloy tools; bench baseline committed.*

**Phase 5 — deferred**: Android lane, CI replay, Maestro export, remote/cloud. Revisit
after dogfood.

**Phase 5a — freshness gate at the build seam (specified Aug 2026, after dogfood demo)**

*Problem (measured in practice, recorded in ios-agentic-testing pitfalls):* the
build→install seam fails silently — an agent installs a stale `.app` whose mtime
predates source changes and verifies the wrong binary. Manual mtime checks are the
current workaround ("xcbuddy STALE-BINARY: verify MTIME > src EVERY build"). This is
exactly the silent-seam failure class Alloy eliminates elsewhere; the fix is a
structured gate, not a lane merger (build stays outside Alloy — different aging
curve, Apple-specific toolchain vs engine-agnostic brand).

*Design:*
- `alloy_apps` `action:'install'` (and `reinstall`) gains optional `srcPath`.
- When `srcPath` is present, dispatch walks the source tree (respecting `.gitignore`
  via a bounded ignore matcher), finds the newest mtime, and compares against the
  artifact's mtime **before** calling the engine's install.
- Stale (source newer than artifact) → typed error **`STALE_ARTIFACT`**
  `{details: {artifactMtime, newestSourceMtime, newestSourcePath, hint: 'rebuild and retry'}}`,
  retriable: true. Install does NOT run. Fresh → install proceeds.
- New error code enters `ALLOY_ERROR_CODES`; normalization maps no engine code to it
  (it is alloy-originated, like `LEASE_HELD`).
- Scope guard: srcPath walk is bounded (max 20k files, skip node_modules/.build/
  DerivedData/.git) and errors on unreadable trees rather than silently passing.

*Deliberately NOT in 5a:* auto-rebuild on stale (shelling to a configured build
command). The gate ships first; automation is a separate decision after dogfood
evidence (it couples Alloy to build toolchains, the exact coupling §1 avoids).

*Tests:* unit (mtime comparison, ignore-matching, bound) + contract (fake engine
refuses to see install when stale; sees it when fresh) + live gate
(`STALE_ARTIFACT` on a touched source file; success after artifact mtime bump).

*Acceptance:* the recorded pitfall's failure mode is impossible through Alloy when
srcPath is provided — stale installs return a typed error instead of verifying a
stale binary.

## 8. Testing & performance

**Tiers, all vitest, tagged for selective runs:**

1. **Unit** — routing-table completeness invariants (§12.1), error normalization maps,
   lease state machine (exhaustive transitions incl. error paths), config resolution +
   override validation, degraded-mode logic. No engines needed. Every commit.
2. **Contract/golden (recorded fixtures)** — generated `test.each(routingTable)`: every
   table row must have a fixture with a provenance stamp (engine version + recorder
   script hash); hand-edited fixtures fail the stamp check. `alloy_measure` golden uses
   the canonical-JSON differ with the artifact-delta whitelist. Every commit.
3. **Live (Settings.app)** — pilot path: snapshot → act → find → measure → flow w/
   launch-args → video → network → logs → replay; lease handoff transitions exercised.
   `describe.skipIf` without simulator; never blocks CI on host hardware.
4. **Benchmarks** — `bench/` with **paired interleaved protocol (F4)**: facade call and
   direct engine call alternate A/B/A/B on the same settled screen, N≥30 pairs, warmup
   discarded, metric = median of per-pair deltas; committed `bench/baseline.json`; CI
   fails on p95-overhead > baseline + tolerance. Byte-size parity and steady-state
   process count checked in the same run.

**Reliability invariants (asserted):**
- Every alloy tool validates input with zod before dispatch; unknown keys rejected.
- Every engine error path yields a structured AlloyError — never a raw string throw.
- Lease transitions serialized; release-on-error mandatory.
- `alloy_health` fails closed on missing config / engine skew / dead daemon /
  unresolved prerequisites.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Engine A 0.x churn, no compat obligation | exact pin in `engines.local.json`; fixture re-record + typecheck + re-baseline on bump; `alloy_health` reports skew, warns in responses until resolved |
| Engine A daemon version-skew (client lib ≠ daemon) | single install path; adapters use resolved module only |
| Ref frame expiry on shared sessions | rule 5.5: refs engine-local; re-snapshot semantics documented |
| Stale Engine A claims → false blocks | surface typed reason + recovery command; manual recovery only |
| Engine B tool-server singleton under concurrent workers | same sharing model as its CLI today — no regression; per-UDID queue added |
| Engine B fork drift | resolution points at local fork workspace; engine bumps require rebuild + typecheck + fixture re-record (CI-able) |
| Engine B measurement cold-start (~6s first call per device) | `alloy_health` pre-warm option + reports warm/cold state (F6) |
| Raw-B bypass during coexist window | rule 5.6 — convention documented; Engine A side enforced by claims |
| Signed-runner first-launch stall | `node -e 0` warm-up inside `alloy_health` |

## 10. Locked decisions

1. Name: **Alloy** (general, brand-free). Public tool prefix `alloy_*`.
2. Location: `ai/alloy/`.
3. Raw engine MCP entries stay enabled during dogfood.
4. No engine signatures anywhere in this repo — runtime engine resolution via gitignored
   config; neutral Engine A/B vocabulary in all first-party material.
5. Stack: TypeScript strict / Node 24.x (match engines) / `@modelcontextprotocol/sdk` /
   zod / vitest / pnpm / oxlint / tsdown (rationale: §3.1; constraint: in-process
   engine clients).

## 11. Open items (non-blocking)

- `engines.local.example.json` template (neutral, committed) + `.gitignore` entry.
- RN test app choice for `alloy_js_debug` live coverage (deferred with Phase 5).
- npm publish under `@alloy/mcp` (defer; not needed for dogfood).

## 12. Enforcement architecture (how the implementation gets it right)

Principle: **instructions get skipped; structure doesn't.** Every invariant below is a
gate, not a guideline.

1. **Routing table = single source of truth.** `src/routing.ts` exports one typed,
   frozen table (`tool → {engine, lease, schema, adapterBinding, docs}`). MCP
   registration, contract tests, docs generation, and dispatch all derive from it.
   Unit test asserts table completeness: every row has zod schema, adapter binding,
   fixture, doc string. A half-added tool fails CI.
2. **One dispatch choke point.** All calls flow through
   `dispatch(tool, input)`: zod-validate → lease check → adapter invoke →
   error-normalize → telemetry. Tools register ONLY via the `defineTool()` helper; a
   static source check rejects exported tools constructed any other way. No second path
   to an engine exists.
3. **Lease state machine = pure function.** Transitions
   `(state, action) → state | refusal` exhaustively unit-tested (acquire, release,
   per-call auto-release, handoff, conflict, error-path release). Adapters cannot
   bypass: dispatch calls through the machine; wrong-engine-while-leased is
   unrepresentable.
4. **Contract tests are generated from the table.** `test.each(routingTable)` requires
   a fixture per row; fixtures are machine-recorded (recorder script + provenance
   stamp: engine version + script hash); hand edits fail the stamp. Golden differ
   whitelists exactly the documented artifact-delta keys.
5. **CI gates, in order**: strict typecheck → oxlint + **signature scan** (CI script:
   any engine name/package/path/string anywhere in repo = fail; the manual grep becomes
   a gate) → unit → contract/golden → live (self-skipping) → bench-vs-baseline. Phase
   gates (§7) are named test files; a phase is done when its file is green, not when it
   looks done.
6. **Fail-closed degraded mode.** Startup health check: if config missing, version
   skewed, prerequisites unmet, or engines dead → the MCP server lists ONLY
   `alloy_health`. Broken tools are unreachable rather than present-and-flaky.
7. **Engine bumps are a command, not an edit.** `pnpm bump:engines` = re-resolve,
   typecheck, fixture re-record, bench re-baseline. Skew between pinned and installed
   versions stamps a warning into every response until reconciled.
