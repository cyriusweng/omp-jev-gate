# OMP Jev Gate

OMP Jev Gate is a standalone OMP plugin for bounded semantic judgments through TypeSafe Jev. It provides prompt-level preflight, an explicit `jev-judge` tool, a global advisory policy in guide mode and a first-tool checkpoint in enforce mode. It uses OMP's public extension API and records auditable session receipts.

## Judgment layers

OMP ships a built-in typed judgment engine (`@oh-my-pi/pi-ai` `judgment`, surfaced to agents as the eval `judge(state, questions)` helper). It answers `choice`, `bool` and `score` questions over one state and selects a backend through `providers.judgmentProvider`: TypeSafe Jev when a credential is available, otherwise an online LLM chain or a local model. OMP features such as automatic thinking-level selection, unexpected-stop detection and AI-assisted git staging call this engine with their own built-in triggers. That engine answers questions it is given; it decides nothing about when the main agent should ask one.

Jev Gate is the global policy and gatekeeping layer above that engine. It applies to every task domain — code, research, writing, file organisation, data analysis, design and delivery review — and teaches the main agent when a bounded Jev judgment is due, records the resulting checkpoints, and enforces them in `enforce` mode. Formal gate records come from this plugin's `jev-judge` tool, which talks to TypeSafe directly; the eval `judge()` helper remains available for OMP's internal features and lightweight side questions under the LLM fallback chain.

## Where Jev fits

Jev is useful when the agent has gathered relevant evidence and can ask one focused question: classify a request, select among defined candidates, score a property against ordered criteria or estimate whether the supplied evidence supports a statement. Independent questions can share the same input state. Good inputs identify the evidence, define the labels and keep the judgment small enough to inspect.

The main agent owns investigation, calculations, implementation, permissions and outcome verification. Multi-factor architecture, risk and delivery decisions benefit from several atomic checks followed by explicit reasoning or deterministic rules. TypeSafe's Jev 1.13 documentation identifies weaknesses in numerical precision, date arithmetic, multi-hop indirection, distracting context and adversarial input. Tests, authoritative sources and direct measurements provide the corresponding factual checks.

Confidence describes the answer distribution. The plugin uses 0.5 as an initial checkpoint threshold for choice and score answers; applications should calibrate decision thresholds against their own costs and evidence. A boolean answer is a probability of yes and has its own interpretation. A completed checkpoint records that a valid judgment occurred. User authorisation and OMP permissions continue to govern actions, and the agent evaluates what the answer means for the task.

## When the main agent calls Jev

The injected policy names four conditions that must all hold before calling `jev-judge`: the step is a selection, scoring or evidence-sufficiency judgment; the question fits `choice`, `bool` or `score`; the gathered evidence forms a clear state; and the answer would materially change the path, scope, risk handling, verification depth or delivery conclusion. Direct paths stay direct: exact facts come from files, code and sources, numbers from computation and tests, user-owned scope and permission choices from the user, and a settled plan continues while its evidence holds. For open-ended work the agent forms candidates first and judges when a material choice emerges.

Answers are read by kind: a `choice` selects the strongest-supported candidate pending fact and permission checks; a `score` places the property on ordered levels applied per project rules; a `bool` probability measures support for the statement, so low support on an evidence-sufficiency question calls for more evidence before the dependent action. A fresh checkpoint is due when new evidence changes the candidates, a failure opens a retry path or the user changes scope; an unchanged object, plan and evidence may reuse a completed checkpoint.

Automatic preflight supplies entry signals for each prompt — decision mode with its confidence, apparent complexity, verification scope and the likelihood of a later checkpoint. Guide and enforce inject the resulting global policy. In enforce mode a `direct_action` prompt with confidence at least 0.5 and checkpoint probability below 0.5 also records a `direct_continue` disposition that governs the initial guarded-tool call, while later material choices still follow the agent's checkpoint policy. The main agent holds the full session history and newly gathered evidence, so it discovers the actual checkpoints; short follow-up instructions such as 「继续」 or 「去看看」 reconnect to the running task through that history.

## Coverage and enforcement

Four modes govern automatic preflight. `off` skips it. `observe` records TypeSafe entry signals while preserving the system prompt, and an automatic preflight failure records a degraded observation and continues, so `fallback: block` never aborts an observing session. `guide` injects the same global policy so the main agent applies the four trigger conditions itself while `edit`, `write` and `bash` stay free; a failure keeps the injected policy and marks the observation degraded. `enforce` adds the guarded-tool checkpoint described below and blocks on automatic preflight failure under `block`. Explicit `jev-judge` calls keep the configured `continue` or `block` fallback in every mode.

In enforce mode, those tool calls require a completed checkpoint for the current turn, an audited degraded disposition permitted by `continue`, or a `direct_continue` disposition recorded when preflight classifies the prompt as `direct_action` with choice confidence at least 0.5 and additional-checkpoint probability below 0.5. A choice or score checkpoint requires a valid TypeSafe answer with confidence at least 0.5. A boolean checkpoint requires a valid probability in the range 0–1. Once the turn is unlocked, subsequent guarded calls proceed; an explicit judgment can upgrade a direct turn to judged. A fresh explicit judgment moves the turn back to pending while it runs, so a direct or judged turn blocks again until the judgment resolves, and failure, cancellation or low confidence under `block` keeps it blocked. Turn completion and session navigation reset the disposition; asynchronous answers retain their originating session and turn association.

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
/jev-gate guide continue
/jev-gate enforce continue
/jev-gate enforce block
/jev-gate off
```

Choose `guide` to let the main agent self-apply the trigger policy before introducing interception, and `enforce block` when service availability and a completed first checkpoint are required for guarded work. On a credential, request or response-validation failure, `block` records the failure and stops the affected explicit judgment; a failed automatic preflight requests turn cancellation in enforce mode only, while observe and guide record a degraded observation and continue. A pending checkpoint continues to block guarded calls. `continue` records an explicit `degraded_continue` disposition and permits the current agent to proceed using its own reasoning. Cancellation propagates under both policies. Low-confidence choice and score answers leave a pending checkpoint unresolved.

Configuration is stored atomically with mode `0600` at `~/.omp/agent/jev-gate.json`. Set `OMP_JEV_GATE_CONFIG` for another path. The historical `jev` fallback value loads as `block`; an explicit settings save persists the supported value. Authentication uses `TYPESAFE_API_KEY` when present, followed by OMP's native token store:

```sh
omp /login typesafe
```

## Explicit judgment

`jev-judge` accepts `checkpoint`, `kind`, `state`, `question` and optional `labels`. Its receipts are the formal semantic-judgment records of the gate; preflight supplies only entry signals and turn dispositions such as `direct_continue` and `degraded_continue`. Checkpoints are domain-neutral: `problem_framing`, `approach_selection`, `candidate_filtering`, `evidence_sufficiency`, `risk`, `verification_scope`, `delivery_readiness` and `other`. The earlier coding-oriented names `architecture`, `implementation_path`, `test_coverage` and `delivery_preflight` remain valid for continuity with existing receipts. Choice supports 2–20 distinct labels. Score supports 2–10 ordered levels. Boolean questions use `kind: "bool"`, which the client encodes using TypeSafe's native `noul` probability type. The client validates answer type, ranges, labels, probability vectors and score consistency before accepting a receipt.

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

## Troubleshooting

TypeSafe answers are validated against the native response contract: answer type, required fields, finite probabilities in the 0–1 range, allowed choice labels and in-range scores. This matches OMP's built-in Judgment parsing. The plugin derives no consistency requirements from rounded probability fields, so a valid native answer whose probabilities sum to 0.999 or whose chosen label differs from what local arithmetic would rank first is accepted. Genuinely malformed answers keep the `typesafe_answer_invalid` code and follow the configured fallback.

If you upgrade or edit the plugin while a session is running, restart the session or reload the plugin before judging its behaviour; the previously loaded code keeps serving the current process. With `enforce block`, an unavailable or invalid TypeSafe response stops the affected turn — check `/jev-gate status`, the credential and recent preflight receipts before attributing the stop to the network.

## Verification and references

Requires Node.js 22 or later. The tests cover native API decoding, registered-tool execution, confidence boundaries, the global trigger policy, mode-specific preflight failure handling, malformed responses, both failure policies, cancellation, asynchronous session changes, turn resets and interactive settings.

```sh
npm test
npm run check
omp --no-extensions -e ./src/index.mjs
```

The role and API contract follow TypeSafe's [introduction](https://docs.typesafe.ai/introduction), [API documentation](https://docs.typesafe.ai/api.md), [confidence guidance](https://docs.typesafe.ai/confidence) and [Jev 1.13 model characteristics](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md).
