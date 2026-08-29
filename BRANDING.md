# Alloy — Brand & Positioning Reference

Single source of truth for how Alloy is described. Keep all public copy (README, MCP
server description, tool descriptions, docs) consistent with this file. Neutral
vocabulary only — no engine names, ever (see PLAN.md §1 naming constraint).

## One-liner

> Alloy gives AI agents a single pair of hands and eyes on real mobile devices —
> routing every task to the engine that does it best.

## Elevator (30s)

Alloy is one MCP server that unifies mobile app automation, verification, and evidence
capture. Underneath sit two specialized engines; Alloy's routing table sends each task
to whichever engine measurably does it best — token-lean exploration and device
control to one, dense measurement, declarative flows, and validated evidence to the
other. Agents see one coherent toolset, one error taxonomy, one session model. Engines
are swappable without touching a single workflow.

## Category

Agent infrastructure — the hands-and-eyes layer beneath AI agents (coding, QA, review
agents), exposed as an MCP server over swappable automation engines.

## The problem

Every mobile automation tool is strong somewhere and weak elsewhere — that's physics,
not flaws. Fast explorers can't measure precisely or run declarative flows. Precise
measurers burn tokens on exploration and start cold. Teams bolt two tools together and
the agent pays for the seam:

- two command vocabularies to learn, two error shapes to parse, two session models
- refs and state that leak (or die) at tool boundaries
- devices fought over by concurrent agents with no arbitration
- wrong-tool-for-the-job costs 7–22× token waste per screen (measured, real app)
- per-call process spawn: ~170–250ms pure overhead (measured)
- cold-start penalty up to 30× on first interaction (measured)

## The solution

The agent never picks an engine. It states the job — explore, act, measure, verify,
diagnose — and Alloy dispatches to the strongest engine, normalizes errors into one
taxonomy, arbitrates device access with an explicit lease model, and guarantees
artifact integrity (validated video, byte-stable measurement contracts). Fail-closed
health: when anything is wrong, the broken surface is unreachable, never flaky.

## Purpose

Close the loop between "the agent wrote the code" and "the app actually works."
Alloy exists so any agent can operate a real app on a real device with the fewest
tokens, the fewest mistakes, and the fastest feedback — while producing evidence a
human can trust: screenshots, measurements, video, logs.

## What it is NOT

- Not a test framework — it complements scripted suites (XCTest/Maestro-class), it
  does not replace them.
- Not a device farm or cloud — local-first; remote targets are an extension, not the
  identity.
- Not an agent — no test intelligence inside; the agent decides, Alloy executes.

## Name rationale

An alloy fuses metals so the result is stronger than any constituent — each metal
contributing its best property. That is the architecture. Short, general,
pronounceable, no ecosystem ties.

## Taglines

1. **Primary: "Your app. Proven."** — logo-line brevity; declares the outcome (trust,
   certainty) without explaining the machine. Use everywhere: README header, CLI
   banner, npm/registry description.
2. Secondary (body copy, where a sentence fits): "It just works. And proves it."
3. Architecture-facing contexts only: "Two engines. One pair of hands."

## Voice

Engineering-grade, precise, neutral. Claims carry numbers from measured benchmarks —
never superlatives without a figure. No vendor names, no hype adjectives, no
exclamation marks. Written for the developer equipping an agent, and for the agent
itself.

## Canonical capability verbs (use in tool docs)

explore · act · measure · verify · diagnose — never engine-specific jargon in
first-party docs.
