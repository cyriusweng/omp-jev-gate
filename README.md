# OMP Jev Gate

OMP Jev Gate is a standalone OMP plugin for bounded semantic judgments through TypeSafe Jev. It provides prompt-level preflight, an explicit `jev-judge` tool and a first-tool checkpoint in enforce mode. It uses OMP's public extension API and records auditable session receipts.

## Where Jev fits

Jev is useful when the agent has gathered relevant evidence and can ask one focused question: classify a request, select among defined candidates, score a property against ordered criteria or estimate whether the supplied evidence supports a statement. Independent questions can share the same input state. Good inputs identify the evidence, define the labels and keep the judgment small enough to inspect.

The main agent owns investigation, calculations, implementation, permissions and outcome verification. Multi-factor architecture, risk and delivery decisions benefit from several atomic checks followed by explicit reasoning or deterministic rules. TypeSafe's Jev 1.13 documentation identifies weaknesses in numerical precision, date arithmetic, multi-hop indirection, distracting context and adversarial input. Tests, authoritative sources and direct measurements provide the corresponding factual checks.

Confidence describes the answer distribution. The plugin uses 0.5 as an initial checkpoint threshold for choice and score answers; applications should calibrate decision thresholds against their own costs and evidence. A boolean answer is a probability of yes and has its own interpretation. A completed checkpoint records that a valid judgment occurred. User authorisation and OMP permissions continue to govern actions, and the agent evaluates what the answer means for the task.

## Coverage and enforcement

Automatic preflight asks four independent questions about the prompt: interaction mode, apparent complexity, verification scope and the likelihood of a later evidence-dependent choice. `off` skips automatic preflight. `observe` records its result while preserving the system prompt. `enforce` also adds compact guidance and checks tool calls named exactly `edit`, `write` and `bash`.

In enforce mode, those tool calls require a qualifying explicit checkpoint for the current turn, or an audited degraded disposition permitted by `continue`. A choice or score checkpoint requires a valid TypeSafe answer with confidence at least 0.5. A boolean checkpoint requires a valid probability in the range 0–1. Once this first checkpoint is complete, subsequent guarded calls in the turn proceed. Turn completion and session navigation reset the checkpoint; asynchronous answers retain their originating session and turn association.

The enforcement boundary is the first call through those three tool names. Later decisions, internal reasoning and actions through other tool names follow the agent's checkpoint instructions. The plugin supplies a procedural checkpoint with that defined scope. Factual accuracy, overall task safety and meaningful interpretation remain responsibilities of the executing agent and its surrounding controls.

## Install and configure

Install directly from GitHub:

```sh
omp plugin install github:cyriusweng/omp-jev-gate
```

Local development can use a link:

```sh
omp plugin link /path/to/omp-jev-gate
```

The default is `off` with `continue` fallback. Run `/jev-gate` to open the interactive mode and fallback selectors. The command form supports:

```text
/jev-gate
/jev-gate status
/jev-gate observe continue
/jev-gate enforce continue
/jev-gate enforce block
/jev-gate off
```

Choose `enforce block` when service availability and a completed first checkpoint are required for guarded work. On a credential, request or response-validation failure, `block` records the failure and stops the affected judgment; a failed automatic preflight also requests turn cancellation. A pending checkpoint continues to block guarded calls. `continue` records an explicit `degraded_continue` disposition and permits the current agent to proceed using its own reasoning. Cancellation propagates under both policies. Low-confidence choice and score answers leave a pending checkpoint unresolved.

Configuration is stored atomically with mode `0600` at `~/.omp/agent/jev-gate.json`. Set `OMP_JEV_GATE_CONFIG` for another path. The historical `jev` fallback value loads as `block`; an explicit settings save persists the supported value. Authentication uses `TYPESAFE_API_KEY` when present, followed by OMP's native token store:

```sh
omp /login typesafe
```

## Explicit judgment

`jev-judge` accepts `checkpoint`, `kind`, `state`, `question` and optional `labels`. Choice supports 2–20 distinct labels. Score supports 2–10 ordered levels. Boolean questions use `kind: "bool"`, which the client encodes using TypeSafe's native `noul` probability type. The client validates answer type, ranges, labels, probability vectors and score consistency before accepting a receipt.

A focused evidence check can use:

```json
{
  "checkpoint": "test_coverage",
  "kind": "bool",
  "state": "Changed behaviour: a failed token refresh clears the cached token. Existing tests exercise successful refresh and expiry; their assertions check token replacement and expiry time.",
  "question": "Do the listed test assertions directly exercise cache clearing after a failed refresh?"
}
```

The agent interprets the returned probability and adds the appropriate test. Each broader decision can use several such focused checks with its own evidence and criteria.

## Privacy and receipts

Automatic preflight sends the prompt text, limited to 12,000 characters, to TypeSafe's SystemOne API. Explicit calls send their supplied state, question and criteria. Use these features with information authorised for that provider. The plugin's added receipts store digests, checkpoint names, accepted answers, probabilities, model metadata, usage and failure reasons; raw prompt text, raw state and credentials are excluded from these receipts. OMP's ordinary conversation and tool-history retention applies separately.

Unavailable judgments have a fallback backend and an unavailable action with the relevant reason. Receipts distinguish successful TypeSafe answers, unresolved low-confidence judgments, degraded continuation and cancellation. Checkpoint-disposition entries identify their session, turn and guarded-tool scope.

## Verification and references

Requires Node.js 22 or later. The tests cover native API decoding, registered-tool execution, confidence boundaries, malformed responses, both failure policies, cancellation, asynchronous session changes, turn resets and interactive settings.

```sh
npm test
npm run check
omp --no-extensions -e ./src/index.mjs
```

The role and API contract follow TypeSafe's [introduction](https://docs.typesafe.ai/introduction), [API documentation](https://docs.typesafe.ai/api.md), [confidence guidance](https://docs.typesafe.ai/confidence) and [Jev 1.13 model characteristics](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).
