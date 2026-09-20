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
    reasoningDepth: answers.reasoning_depth.score,
    verificationDepth: answers.verification_depth.choice,
    additionalJevProbability: answers.additional_jev.bool,
  };
}

export function formatPolicy(receipt) {
  const guidance = receipt.signals ? [
    `- Decision mode: ${receipt.signals.decisionMode}.`,
    `- Reasoning depth: ${receipt.signals.reasoningDepth}.`,
    `- Verification depth: ${receipt.signals.verificationDepth}.`,
    `- Additional Jev checkpoint probability: ${receipt.signals.additionalJevProbability}.`,
  ] : [`- Preflight unavailable: ${receipt.fallbackReason}; continue with current-agent reasoning under the configured fallback.`];
  return [
    'Jev judgment policy for this prompt:',
    `- Preflight backend: ${receipt.backend}${receipt.model ? ` (${receipt.model})` : ''}.`,
    ...guidance,
    '- Use Jev for one evidence-based bounded question at a time: classification, candidate selection, rubric scoring or a boolean condition.',
    '- Split multi-factor design and risk questions into atomic checks; combine their results using explicit reasoning and rules.',
    '- Enforce mode checks for a completed checkpoint before the first edit, write or bash call. Choice and score checkpoints require confidence of at least 0.5; boolean checkpoints record the supplied probability.',
    '- Service failures follow the configured continue or block policy. User authorisation and OMP tool permissions govern each action.',
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
        action: config.mode === 'enforce' ? 'policy_injected' : 'observed'
      };
    } catch (error) {
      failure = event.signal?.aborted ? event.signal.reason ?? error : error;
      outcome = {
        backend: 'fallback', fallbackReason: event.signal?.aborted ? 'cancelled' : error?.code ?? 'typesafe_request_failed',
        action: event.signal?.aborted ? 'cancelled' : `unavailable_${config.fallback}`
      };
    }
    if (turn !== current) throw Object.assign(new Error('The preflight belongs to an earlier turn.'), { code: 'stale_preflight' });
    const receipt = {
      version: 1, sessionId: current.sessionId, turnId: current.id,
      promptDigest: digest(prompt), recordedAt: new Date().toISOString(),
      mode: config.mode, fallback: config.fallback, ...outcome
    };
    pi.appendEntry(PREFLIGHT_STATE_TYPE, receipt);
    if (failure && (config.fallback === 'block' || event.signal?.aborted)) {
      current.status = 'blocked';
      if (!event.signal?.aborted) ctx.abort?.();
      throw failure;
    }
    if (failure) recordDisposition(current, 'degraded_continue', receipt);
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
      if (config.mode !== 'enforce') return undefined;
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
    if (turn?.sessionId === sessionId(ctx) && (turn.status === 'judged' ||
      (turn.status === 'degraded_continue' && config.fallback === 'continue'))) return undefined;
    return { block: true, reason: 'Jev checkpoint required before edit, write or bash: gather the relevant evidence, call jev-judge, then retry. Choice and score judgments require confidence >= 0.5. User settings /jev-gate control the policy.' };
  });

  pi.on('agent_end', clearPreparation);
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch', 'session_shutdown']) pi.on(event, clearPreparation);

  function captureTurn(ctx) {
    if (!turn || turn.sessionId !== sessionId(ctx)) turn = newTurn(ctx);
    return turn.id;
  }

  function markJudged(turnId, receipt) {
    if (!turn || turn.id !== turnId || turn.sessionId !== receipt.sessionId) return false;
    if (isJudged(receipt)) recordDisposition(turn, 'judged', receipt);
    else if (receipt.action === 'unavailable_continue' && receipt.fallback === 'continue') recordDisposition(turn, 'degraded_continue', receipt);
    return turn.status === 'judged';
  }

  return { clearPreparation, captureTurn, markJudged };
}
