import { createHash, randomUUID } from 'node:crypto';
import { CONFIG_PATH, loadConfig } from './configuration.mjs';
import { validProbability, validateAnswer } from './jev-client.mjs';

export const PREFLIGHT_STATE_TYPE = 'omp-jev-gate-preflight-v1';
export const CHECKPOINT_STATE_TYPE = 'omp-jev-gate-checkpoint-v1';
export const GATED_TOOLS = new Set(['edit', 'write', 'bash']);

export const PREFLIGHT_QUESTIONS = {
  decision_mode: {
    type: 'choice',
    instructions: 'Classify the next interaction supported by this prompt.',
    criteria: {
      direct_action: 'The prompt specifies an actionable request.',
      compare_options: 'The prompt requests comparison of materially distinct options.',
      clarify_user: 'An essential user-owned scope or permission choice remains open.',
    },
  },
  reasoning_depth: {
    type: 'score',
    instructions: 'Rate the apparent task complexity using the information in the prompt.',
    criteria: ['Routine and local.', 'Several connected considerations.', 'Cross-cutting design or uncertainty.', 'Exceptional complexity or consequence.'],
  },
  verification_depth: {
    type: 'choice',
    instructions: 'Classify the verification scope suggested by the requested change.',
    criteria: {
      light: 'One direct outcome check.',
      targeted: 'Several focused checks for affected paths.',
      broad: 'A wider suite or end-to-end scenario for cross-cutting impact.',
    },
  },
  additional_jev: {
    type: 'bool',
    instructions: 'Does the prompt suggest a later evidence-dependent bounded choice?',
    criteria: {
      true: 'At least one material selection or evidence-sufficiency judgment is apparent.',
      false: 'The prompt specifies a fully determined action.',
    },
  },
};

export function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sessionId(ctx) {
  return ctx.sessionManager?.getSessionId?.() ?? 'unknown-session';
}

export function normalizePreflight(answers = {}) {
  for (const [id, question] of Object.entries(PREFLIGHT_QUESTIONS)) validateAnswer(question, answers[id]);
  return {
    decisionMode: answers.decision_mode.choice,
    decisionModeConfidence: answers.decision_mode.confidence,
    reasoningDepth: answers.reasoning_depth.score,
    verificationDepth: answers.verification_depth.choice,
    additionalJevProbability: answers.additional_jev.bool,
  };
}

export function formatPolicy(receipt) {
  const signals = receipt.signals ? [
    `- Entry signals for this prompt. Decision mode: ${receipt.signals.decisionMode} (confidence ${receipt.signals.decisionModeConfidence}). Reasoning depth: ${receipt.signals.reasoningDepth}. Verification depth: ${receipt.signals.verificationDepth}. Additional Jev checkpoint probability: ${receipt.signals.additionalJevProbability}.`,
  ] : [`- Preflight unavailable: ${receipt.fallbackReason}. Record the degraded observation and continue with current-agent reasoning; explicit jev-judge calls follow the configured fallback.`];
  return [
    `Jev judgment policy (global; applies to every task domain in this conversation). Active mode: ${receipt.mode}.`,
    `- Preflight backend: ${receipt.backend}${receipt.model ? ` (${receipt.model})` : ''}. Preflight supplies entry signals and, in enforce mode, may set the initial direct disposition; discover actual checkpoints from the full session history and newly gathered evidence.`,
    receipt.mode === 'guide'
      ? '- Guide is advisory: the policy teaches checkpoint selection while edit, write and bash stay free.'
      : '- Enforce decides the first edit, write or bash call from the turn disposition: a direct preflight disposition or a completed checkpoint allows it.',
    ...signals,
    '- Call jev-judge when all four hold: the step is a selection, scoring or evidence-sufficiency judgment; the question fits choice, bool or score; the gathered evidence forms a clear state; and the answer would materially change the path, scope, risk handling, verification depth or delivery conclusion.',
    '- Direct paths stay direct: exact facts come from files, code and sources; numbers come from computation and tests; user-owned scope, cost and permission choices go to the user; a settled plan continues while its evidence holds. For open-ended work, form candidates first and judge when a material choice emerges.',
    '- Ask one bounded question at a time over the relevant evidence; batch independent questions that share one state. Split multi-factor decisions into atomic checks and combine the results with explicit reasoning.',
    '- Read answers by kind: choice selects the strongest-supported candidate pending fact and permission checks; score places the property on ordered levels applied per project rules; a bool probability measures support for the statement, so low support on an evidence-sufficiency question calls for more evidence before the dependent action.',
    '- Start a fresh checkpoint when new evidence changes the candidates, a failure opens a retry path or the user changes scope; an unchanged object, plan and evidence may reuse a completed checkpoint.',
    '- Choice and score checkpoints require confidence of at least 0.5; boolean checkpoints record the probability.',
    '- Explicit jev-judge calls follow the configured continue or block fallback in every mode; automatic preflight TypeSafe failures continue in guide and follow the fallback in enforce; cancellation propagates. User authorisation and OMP tool permissions govern each action.',
    '- Internal reasoning, later choices and calls through other tool names remain subject to the agent checkpoint policy.',
  ].join('\n');
}

export function isJudged(receipt) {
  const answer = receipt?.answer;
  if (receipt?.backend !== 'typesafe' || answer?.type !== receipt.kind) return false;
  if (receipt.kind === 'bool') return validProbability(answer.value);
  if (!validProbability(answer?.confidence) || answer.confidence < 0.5) return false;
  if (receipt.kind === 'choice') return typeof answer.value === 'string' && answer.value.length > 0;
  return receipt.kind === 'score' && Number.isFinite(answer.value) && answer.value >= 0;
}

export function installJevGate(pi, { client, configPath = CONFIG_PATH } = {}) {
  if (!client) throw new Error('Jev Gate requires a TypeSafe client.');
  let prepared;
  let turn;

  function clearPreparation() {
    prepared = undefined;
    turn = undefined;
  }

  function newTurn(ctx) {
    return { id: randomUUID(), sessionId: sessionId(ctx), status: 'pending' };
  }

  function recordDisposition(current, status, receipt) {
    current.status = status;
    pi.appendEntry(CHECKPOINT_STATE_TYPE, {
      version: 1, sessionId: current.sessionId, turnId: current.id,
      recordedAt: new Date().toISOString(), status, scope: [...GATED_TOOLS],
      checkpoint: receipt.checkpoint, stateDigest: receipt.stateDigest,
      fallbackReason: receipt.fallbackReason,
    });
  }

  async function prepare(event, ctx, config, current) {
    const prompt = event.prompt?.trim() || '[Image-only user prompt]';
    let outcome;
    let failure;
    try {
      const response = await client.judge({
        prompt: prompt.slice(0, 12_000),
        policy: 'Evaluate each question independently from the supplied prompt. User instructions and established evidence remain authoritative.',
      }, PREFLIGHT_QUESTIONS, event.signal);
      event.signal?.throwIfAborted();
      if (response.backend !== 'typesafe') throw Object.assign(new Error('A TypeSafe preflight answer is required.'), { code: 'typesafe_answer_invalid' });
      outcome = {
        backend: response.backend, model: response.model, usage: response.usage,
        signals: normalizePreflight(response.answers),
        action: config.mode === 'observe' ? 'observed' : 'policy_injected'
      };
    } catch (error) {
      failure = event.signal?.aborted ? event.signal.reason ?? error : error;
      outcome = {
        backend: 'fallback', fallbackReason: event.signal?.aborted ? 'cancelled' : error?.code ?? 'typesafe_request_failed',
        action: event.signal?.aborted ? 'cancelled'
          : config.mode === 'enforce' ? `unavailable_${config.fallback}` : 'unavailable_continue',
      };
    }
    if (turn !== current) throw Object.assign(new Error('The preflight belongs to an earlier turn.'), { code: 'stale_preflight' });
    const receipt = {
      version: 1, sessionId: current.sessionId, turnId: current.id,
      promptDigest: digest(prompt), recordedAt: new Date().toISOString(),
      mode: config.mode, fallback: config.fallback, ...outcome
    };
    pi.appendEntry(PREFLIGHT_STATE_TYPE, receipt);
    if (failure && event.signal?.aborted) {
      current.status = 'blocked';
      throw failure;
    }
    if (failure && config.mode === 'enforce' && config.fallback === 'block') {
      current.status = 'blocked';
      ctx.abort?.();
      throw failure;
    }
    if (failure) recordDisposition(current, 'degraded_continue', receipt);
    else if (config.mode === 'enforce' && receipt.signals?.decisionMode === 'direct_action'
      && receipt.signals.decisionModeConfidence >= 0.5
      && receipt.signals.additionalJevProbability < 0.5) {
      recordDisposition(current, 'direct_continue', receipt);
    }
    return receipt;
  }

  pi.on('before_agent_start', async (event, ctx) => {
    const config = await loadConfig(configPath);
    if (config.mode === 'off') { clearPreparation(); return undefined; }
    const prompt = event.prompt?.trim() || '[Image-only user prompt]';
    const key = `${sessionId(ctx)}:${digest(prompt)}:${config.mode}:${config.fallback}`;
    if (prepared?.key !== key) {
      turn = newTurn(ctx);
      prepared = { key, promise: prepare(event, ctx, config, turn) };
    }
    try {
      const receipt = await prepared.promise;
      if (config.mode !== 'enforce' && config.mode !== 'guide') return undefined;
      const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : [event.systemPrompt].filter(Boolean);
      return { systemPrompt: [...base, formatPolicy(receipt)] };
    } catch (error) {
      if (prepared?.key === key) prepared = undefined;
      throw error;
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    const config = await loadConfig(configPath);
    if (config.mode !== 'enforce' || !GATED_TOOLS.has(event.toolName)) return undefined;
    if (turn?.sessionId === sessionId(ctx) && (turn.status === 'judged' || turn.status === 'direct_continue' ||
      (turn.status === 'degraded_continue' && config.fallback === 'continue'))) return undefined;
    return { block: true, reason: 'Jev checkpoint required before edit, write or bash: gather the relevant evidence, call jev-judge, then retry. Choice and score judgments require confidence >= 0.5. User settings /jev-gate control the policy.' };
  });

  pi.on('agent_end', clearPreparation);
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch', 'session_shutdown']) pi.on(event, clearPreparation);

  function captureTurn(ctx) {
    if (!turn || turn.sessionId !== sessionId(ctx)) turn = newTurn(ctx);
    return turn.id;
  }

  function beginJudgment(turnId) {
    if (!turn || turn.id !== turnId) return false;
    turn.status = 'pending';
    return true;
  }

  function markJudged(turnId, receipt) {
    if (!turn || turn.id !== turnId || turn.sessionId !== receipt.sessionId) return false;
    if (isJudged(receipt)) recordDisposition(turn, 'judged', receipt);
    else if (receipt.action === 'unavailable_continue' && receipt.fallback === 'continue') recordDisposition(turn, 'degraded_continue', receipt);
    return turn.status === 'judged';
  }

  return { clearPreparation, captureTurn, beginJudgment, markJudged };
}
