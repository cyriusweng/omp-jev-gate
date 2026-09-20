import { createHash } from 'node:crypto';
import { CONFIG_PATH, loadConfig } from './configuration.mjs';

export const PREFLIGHT_STATE_TYPE = 'omp-jev-gate-preflight-v1';
export const GATED_TOOLS = new Set(['edit', 'write', 'bash']);
export const WAIVER_PHRASES = ['waive jev', 'skip jev', '跳过 jev'];

function hasWaiver(prompt) {
  const text = prompt.toLowerCase();
  return WAIVER_PHRASES.some(phrase => text.includes(phrase));
}

export const PREFLIGHT_QUESTIONS = {
  decision_mode: {
    type: 'choice',
    instructions: 'Choose the interaction mode with the highest expected reliability for this prompt.',
    criteria: {
      direct_action: 'Existing evidence and instructions support immediate execution.',
      compare_options: 'Several materially distinct approaches merit comparison before selection.',
      clarify_user: 'A user-owned choice materially changes scope, cost, external effects or recovery.',
    },
  },
  reasoning_depth: {
    type: 'score',
    instructions: 'Score the reasoning depth needed for a reliable result.',
    criteria: [
      'Routine and local.',
      'Several connected considerations.',
      'Complex design, uncertainty or risk.',
      'Exceptional complexity or consequence.',
    ],
  },
  verification_depth: {
    type: 'choice',
    instructions: 'Choose the smallest verification depth that can establish the requested outcome.',
    criteria: {
      light: 'One direct check covers the changed behaviour.',
      targeted: 'Several focused checks cover the affected paths and associations.',
      broad: 'Cross-cutting impact requires a wider suite or end-to-end scenario.',
    },
  },
  additional_jev: {
    type: 'bool',
    instructions: 'Would later bounded decisions in this turn benefit materially from explicit Jev checkpoints?',
    criteria: {
      true: 'One or more material choices remain after the preflight.',
      false: 'The prompt and evidence determine a direct path.',
    },
  },
};

export function digest(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sessionId(ctx) {
  return ctx.sessionManager?.getSessionId?.() ?? 'unknown-session';
}

function validChoice(answer, choices, fallback) {
  return answer?.type === 'choice' && choices.includes(answer.choice) ? answer.choice : fallback;
}

function validScore(answer, fallback) {
  return answer?.type === 'score' && Number.isFinite(answer.score) ? answer.score : fallback;
}

function validBool(answer, fallback) {
  return answer?.type === 'bool' && Number.isFinite(answer.bool) ? answer.bool : fallback;
}

export function normalizePreflight(answers = {}) {
  return {
    decisionMode: validChoice(answers.decision_mode, ['direct_action', 'compare_options', 'clarify_user'], 'direct_action'),
    reasoningDepth: validScore(answers.reasoning_depth, 1),
    verificationDepth: validChoice(answers.verification_depth, ['light', 'targeted', 'broad'], 'targeted'),
    additionalJevProbability: validBool(answers.additional_jev, 0.5),
  };
}

export function formatPolicy(receipt) {
  const signals = receipt.signals;
  return [
    'Jev judgment policy for this prompt:',
    `- Preflight backend: ${receipt.backend}${receipt.model ? ` (${receipt.model})` : ''}.`,
    `- Decision mode: ${signals.decisionMode}.`,
    `- Reasoning depth: ${signals.reasoningDepth}.`,
    `- Verification depth: ${signals.verificationDepth}.`,
    `- Additional Jev checkpoint probability: ${signals.additionalJevProbability}.`,
    '- Call the jev-judge tool before committing to a material bounded choice in architecture, implementation path, candidate filtering, risk, test coverage or delivery readiness when multiple viable choices remain.',
    '- Apply direct user instructions, authoritative evidence and permission boundaries to the final action.',
  ].join('\n');
}

export function fallbackSignal(question, signal) {
  return {
    checkpoint: question.checkpoint,
    kind: question.kind,
    questionDigest: digest(question.question),
    answer: question.kind === 'bool' ? { value: false }
      : question.kind === 'score' ? { value: 1 }
        : { value: signal.labels[0] },
    backend: 'deterministic-fallback',
    fallbackReason: signal.reason,
    recordedAt: new Date().toISOString(),
  };
}

export function isJudged(judgment) {
  return Boolean(judgment) && judgment.answer !== undefined &&
    (!Number.isFinite(judgment.confidence) || judgment.confidence >= 0.5);
}

function fallbackReceipt(error) {
  return {
    backend: 'fallback',
    model: undefined,
    usage: undefined,
    fallbackReason: error?.code ?? 'typesafe_request_failed',
    signals: normalizePreflight(),
  };
}

export function installJevGate(pi, { client, configPath = CONFIG_PATH } = {}) {
  if (!client) throw new Error('Jev Gate requires a TypeSafe client.');
  let prepared;
  let turnJudged = false;
  let turnWaived = false;

  function clearPreparation() {
    prepared = undefined;
    turnJudged = false;
    turnWaived = false;
  }

  async function prepare(event, ctx, config) {
    const prompt = event.prompt?.trim() || '[Image-only user prompt]';
    let outcome;
    try {
      const response = await client.judge({
        prompt: prompt.slice(0, 12_000),
        policy: 'Answer each question independently. User instructions and established evidence remain authoritative.',
      }, PREFLIGHT_QUESTIONS);
      outcome = {
        backend: response.backend,
        model: response.model,
        usage: response.usage,
        fallbackReason: undefined,
        signals: normalizePreflight(response.answers),
      };
    } catch (error) {
      if (config.fallback === 'block') {
        ctx.abort?.();
        throw error;
      }
      outcome = fallbackReceipt(error);
    }

    const receipt = {
      version: 1,
      sessionId: sessionId(ctx),
      promptDigest: digest(prompt),
      recordedAt: new Date().toISOString(),
      mode: config.mode,
      fallback: config.fallback,
      action: config.mode === 'enforce' ? 'policy_injected' : 'observed',
      ...outcome,
    };
    pi.appendEntry(PREFLIGHT_STATE_TYPE, receipt);
    return receipt;
  }

  pi.on('before_agent_start', async (event, ctx) => {
    const config = await loadConfig(configPath);
    if (config.mode === 'off') return undefined;

    const prompt = event.prompt?.trim() || '[Image-only user prompt]';
    turnWaived = hasWaiver(prompt);
    turnJudged = false;
    const key = `${sessionId(ctx)}:${digest(prompt)}:${config.mode}:${config.fallback}`;
    if (prepared?.key !== key) prepared = { key, promise: prepare(event, ctx, config) };

    try {
      const receipt = await prepared.promise;
      if (config.mode !== 'enforce') return undefined;
      return { systemPrompt: [...(event.systemPrompt ?? []), formatPolicy(receipt)] };
    } catch (error) {
      if (prepared?.key === key) prepared = undefined;
      throw error;
    }
  });

  pi.on('tool_call', async (event, ctx) => {
    const config = await loadConfig(configPath);
    if (config.mode !== 'enforce') return undefined;
    if (!GATED_TOOLS.has(event.toolName)) return undefined;
    if (turnWaived || turnJudged) return undefined;
    return {
      block: true,
      reason: 'Enforce mode: call the jev-judge tool for this material choice first, then retry. A user waiver ("waive jev", "skip jev", 「跳过 jev」) in the prompt also unblocks the turn.',
    };
  });

  pi.on('agent_end', clearPreparation);
  for (const event of ['session_start', 'session_switch', 'session_tree', 'session_branch', 'session_shutdown']) {
    pi.on(event, clearPreparation);
  }

  return { clearPreparation, markJudged: receipt => { turnJudged = isJudged(receipt); } };
}
