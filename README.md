# OMP Jev Gate

OMP Jev Gate is a standalone OMP plugin that gives TypeSafe Jev a defined role in local conversation judgments. It runs an optional typed preflight before each user prompt and provides an essential `jev-judge` tool for bounded decisions during a turn. It works through the public extension API and keeps OMP source unchanged.

> [!IMPORTANT]
> **Jev Gate adds an independent, typed judgment layer to OMP.** It gives the agent a compact second opinion before material choices and records the result as an auditable session receipt.

## Why use it

Agent work often turns on a few consequential choices: selecting an architecture, filtering candidates, deciding whether evidence is sufficient, choosing test coverage or checking delivery readiness. Jev Gate sends the relevant state and a bounded choice, score or boolean question to TypeSafe Jev, then returns probabilities and confidence in a stable schema. This makes the checkpoint explicit, reviewable and reusable by the current agent.

The plugin supports two complementary levels. Automatic preflight evaluates each user prompt and supplies decision mode, reasoning depth and verification guidance. The `jev-judge` tool handles focused checkpoints during a turn, after the agent has gathered the evidence that matters. `observe` mode records guidance, `enforce` mode applies it to the agent instructions, and deterministic fallback policy defines how work proceeds when the service is unavailable.

This design is useful for teams that want consistent judgment policy, visible decision provenance and a controlled place for an independent model opinion while keeping the extension installable as a standalone OMP plugin.

## Judgment contract

The preflight asks Jev for four independent signals: decision mode, reasoning depth, verification depth and the value of additional Jev checkpoints. Enforce mode appends these signals to the system prompt and directs the agent to call `jev-judge` before material bounded choices in architecture, implementation path, candidate filtering, risk, test coverage and delivery preflight. Observe mode records the same preflight receipt while preserving the current system prompt. Off mode skips automatic preflight; the explicit tool remains available.

The plugin sends the current prompt or explicit tool state to the TypeSafe SystemOne API. Session receipts contain prompt and state digests, checkpoint names, selected answers, probabilities, model metadata, usage and fallback reasons. They exclude prompt text, tool state and credentials.

Coverage consists of prompt-level preflight and explicitly registered `jev-judge` checkpoints. Latent model reasoning has no extension event and remains outside observable plugin coverage.

## Install and configure

Install directly from GitHub:

```sh
omp plugin install github:cyriusweng/omp-jev-gate
```

Local development can use a link:

```sh
omp plugin link /path/to/omp-jev-gate
```

The plugin starts in `off` mode. Run `/jev-gate` in an interactive OMP conversation to open the graphical mode and fallback selectors. The command form remains available for scripts:

```text
/jev-gate
/jev-gate status
/jev-gate observe continue
/jev-gate enforce continue
/jev-gate enforce block
/jev-gate off
```

`continue` records a deterministic fallback receipt and lets the current agent complete the judgment when TypeSafe is unavailable. `block` pauses the affected automatic preflight or explicit judgment call. Configuration is stored atomically with mode `0600` at `~/.omp/agent/jev-gate.json`. Set `OMP_JEV_GATE_CONFIG` to use another path.

Authentication uses `TYPESAFE_API_KEY` when present, followed by OMP's native token store:

```sh
omp /login typesafe
```

## Explicit judgment tool

`jev-judge` accepts a checkpoint, typed question, compact state and optional labels. Choice questions use two or more labels. Score questions use two or more ordered levels. Boolean questions use Jev's probability of yes. Each call produces a compact audit receipt in the session.

## Local verification

```sh
npm test
npm run check
omp --no-extensions -e ./src/index.mjs
```
