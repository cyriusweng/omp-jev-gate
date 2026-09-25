import { randomUUID } from 'node:crypto';
import { CONFIG_PATH, FALLBACKS, MODES, loadConfig, updateConfig } from './configuration.mjs';
import { digest, installJevGate } from './gate.mjs';
import { createJevClient, validateAnswer } from './jev-client.mjs';

export const JUDGMENT_STATE_TYPE = 'omp-jev-gate-judgment-v1';
export const CHECKPOINTS = [
  'problem_framing',
  'approach_selection',
  'candidate_filtering',
  'evidence_sufficiency',
  'risk',
  'verification_scope',
  'delivery_readiness',
  'architecture',
  'implementation_path',
  'test_coverage',
  'delivery_preflight',
  'other',
];

function sessionId(ctx) {
  return ctx.sessionManager?.getSessionId?.() ?? 'unknown-session';
}

function normalizedLabels(kind, values) {
  if (kind === 'bool') return [];
  const labels = [...new Set((values ?? []).map(value => value.trim()).filter(Boolean))];
  if (labels.length < 2) throw new Error(`${kind} judgments require at least two distinct labels.`);
  if (kind === 'score' && labels.length > 10) throw new Error('Score judgments support 2 to 10 ordered levels.');
  return labels;
}

function buildQuestion(kind, question, labels) {
  if (kind === 'choice') {
    return { type: 'choice', instructions: question, criteria: Object.fromEntries(labels.map(label => [label, null])) };
  }
  if (kind === 'score') return { type: 'score', instructions: question, criteria: labels };
  return { type: 'bool', instructions: question };
}

function normalizeAnswer(kind, raw, labels) {
  validateAnswer(buildQuestion(kind, '', labels), raw);
  return {
    type: kind,
    value: kind === 'choice' ? raw.choice : kind === 'score' ? raw.score : raw.bool,
    confidence: raw.confidence,
    probabilities: raw.probabilities,
  };
}

export async function runExplicitJudgment(pi, client, params, ctx, signal, configPath = CONFIG_PATH) {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const judgmentId = randomUUID();
  let traceId = judgmentId;
  pi.events?.emit('cyrius:chain-trace:v1', { ctx, accept(id) { traceId = id; } });
  const originatingSessionId = sessionId(ctx);
  const config = await loadConfig(configPath);
  signal?.throwIfAborted();
  const kind = params.kind;
  const labels = normalizedLabels(kind, params.labels);
  const state = params.state.trim().slice(0, 12_000);
  const question = params.question.trim().slice(0, 2_000);
  let result;
  let failure;

  try {
    const response = await client.judge(state, {
      decision: buildQuestion(kind, question, labels),
    }, signal);
    signal?.throwIfAborted();
    if (response.backend !== 'typesafe') throw Object.assign(new Error('A TypeSafe judgment answer is required.'), { code: 'typesafe_answer_invalid' });
    result = {
      backend: response.backend,
      model: response.model,
      usage: response.usage,
      fallbackReason: undefined,
      action: 'judged',
      answer: normalizeAnswer(kind, response.answers?.decision, labels),
    };
  } catch (error) {
    failure = signal?.aborted ? signal.reason ?? error : error;
    result = {
      backend: 'fallback',
      model: undefined,
      usage: undefined,
      fallbackReason: signal?.aborted ? 'cancelled' : error?.code ?? 'typesafe_request_failed',
      action: signal?.aborted ? 'cancelled' : `unavailable_${config.fallback}`,
      answer: undefined,
    };
  }

  const receipt = {
    version: 1,
    sessionId: originatingSessionId,
    recordedAt: new Date().toISOString(),
    traceId, judgmentId, startedAt, durationMs: Math.round(performance.now() - started),
    checkpoint: params.checkpoint,
    kind,
    stateDigest: digest(state),
    questionDigest: digest(question),
    mode: config.mode,
    fallback: config.fallback,
    ...result,
  };
  if (sessionId(ctx) === originatingSessionId) pi.appendEntry(JUDGMENT_STATE_TYPE, receipt);
  if (failure && (config.fallback === 'block' || signal?.aborted)) throw failure;
  return receipt;
}

function formatJudgment(receipt) {
  if (receipt.backend === 'fallback') {
    return `Jev checkpoint ${receipt.checkpoint} is unavailable (${receipt.fallbackReason}); fallback ${receipt.fallback} records a degraded disposition and continues with current-agent reasoning.`;
  }
  const answer = receipt.answer;
  if (answer?.type === 'bool') {
    return `Jev checkpoint ${receipt.checkpoint}: yes-probability ${answer.value}; model ${receipt.model}.`;
  }
  const confidence = Number.isFinite(answer?.confidence)
    ? `; confidence ${Math.round(answer.confidence * 100)}%`
    : '';
  return `Jev checkpoint ${receipt.checkpoint}: ${String(answer?.value)}${confidence}; model ${receipt.model}.`;
}

function formatStatus(config) {
  const fallbackDescription = config.fallback === 'block'
    ? 'the affected judgment stops and guarded tools stay blocked'
    : 'a degraded receipt is recorded and the current agent reasoning continues';
  return `Jev Gate mode: ${config.mode}; fallback: ${config.fallback} (${fallbackDescription}). Automatic preflight sends prompt text to TypeSafe in observe, guide and enforce modes and never aborts an observing or guiding session; enforce blocks on automatic preflight failure. Guide injects the same global policy while edit, write and bash stay free. Enforce checks the first edit, write or bash call for a completed checkpoint, a direct preflight disposition or an audited continue disposition. Choice and score judgments require confidence >= 0.5; boolean judgments record their probability. Explicit jev-judge calls send their supplied state and question and move the turn to pending until a disposition resolves.`;
}

const MODE_DESCRIPTIONS = {
  off: 'Skip automatic prompt preflight',
  observe: 'Record Jev entry signals while preserving the current system prompt',
  guide: 'Inject the global policy without intercepting guarded tools',
  enforce: 'Apply preflight guidance and check the first edit, write or bash call',
};

const FALLBACK_DESCRIPTIONS = {
  continue: 'Record a degraded receipt and continue with the current agent',
  block: 'Stop the affected judgment when TypeSafe is unavailable',
};

async function pickSettings(ctx, current) {
  const modes = [...MODES];
  const mode = await ctx.ui.select(
    'Jev Gate Mode',
    modes.map(label => ({ label, description: MODE_DESCRIPTIONS[label] })),
    { initialIndex: Math.max(0, modes.indexOf(current.mode)), helpText: 'Use arrow keys to navigate, Enter to select, Escape to cancel.' },
  );
  if (mode === undefined) return undefined;
  if (!MODES.has(mode)) throw new Error('Select a Jev Gate mode from the menu.');

  const fallbacks = [...FALLBACKS];
  const fallback = await ctx.ui.select(
    'Jev Gate Fallback',
    fallbacks.map(label => ({ label, description: FALLBACK_DESCRIPTIONS[label] })),
    { initialIndex: Math.max(0, fallbacks.indexOf(current.fallback)), helpText: 'Use arrow keys to navigate, Enter to select, Escape to cancel.' },
  );
  if (fallback === undefined) return undefined;
  if (!FALLBACKS.has(fallback)) throw new Error('Select a Jev Gate fallback from the menu.');
  return { mode, fallback };
}

export default function jevGateExtension(pi, options = {}) {
  const configPath = options.configPath ?? CONFIG_PATH;
  const client = options.client ?? createJevClient(pi, options);
  const gate = installJevGate(pi, { client, configPath });

  pi.registerTool({
    name: 'jev-judge',
    label: 'Jev Judgment',
    loadMode: 'essential',
    approval: 'read',
    description: 'Ask TypeSafe Jev one bounded choice, score or boolean question at a material judgment checkpoint in any task domain. Call it when all four hold: the step is a selection, scoring or evidence-sufficiency judgment; the question fits choice, bool or score; the gathered evidence forms a clear state; and the answer would materially change the path, scope, risk handling, verification depth or delivery conclusion. Deterministic facts, computations, user-owned permission choices and settled plans proceed directly.',
    parameters: pi.zod.object({
      checkpoint: pi.zod.enum(CHECKPOINTS),
      kind: pi.zod.enum(['choice', 'bool', 'score']),
      state: pi.zod.string().min(1).max(12_000),
      question: pi.zod.string().min(1).max(2_000),
      labels: pi.zod.array(pi.zod.string().min(1).max(120)).max(20).optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const turnId = gate.captureTurn(ctx);
      gate.beginJudgment(turnId);
      const receipt = await runExplicitJudgment(pi, client, params, ctx, signal, configPath);
      gate.markJudged(turnId, receipt);
      return { content: [{ type: 'text', text: formatJudgment(receipt) }], details: receipt };
    },
  });

  pi.registerCommand('jev-gate', {
    description: 'Configure automatic Jev preflight: status, off, observe, guide or enforce, with continue or block fallback.',
    async handler(args, ctx) {
      try {
        const tokens = args.trim().split(/\s+/).filter(Boolean);
        const current = await loadConfig(configPath);
        if (tokens.length === 0 && ctx.hasUI) {
          const settings = await pickSettings(ctx, current);
          if (!settings) return;
          const saved = await updateConfig(settings, { path: configPath, expectedConfig: current });
          ctx.ui.notify(formatStatus(saved), 'info');
          return;
        }
        const action = tokens[0] ?? 'status';
        if (action === 'status') {
          ctx.ui.notify(formatStatus(current), 'info');
          return;
        }
        if (!MODES.has(action)) throw new Error('Use /jev-gate status|off|observe|guide|enforce [continue|block].');
        const fallback = tokens[1] ?? current.fallback;
        if (!FALLBACKS.has(fallback) || tokens.length > 2) {
          throw new Error('Use fallback continue or block.');
        }
        const saved = await updateConfig({ mode: action, fallback }, { path: configPath, expectedConfig: current });
        ctx.ui.notify(formatStatus(saved), 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  return { client };
}
