import { CONFIG_PATH, FALLBACKS, MODES, loadConfig, updateConfig } from './configuration.mjs';
import { digest, installJevGate } from './gate.mjs';
import { createJevClient } from './jev-client.mjs';

export const JUDGMENT_STATE_TYPE = 'omp-jev-gate-judgment-v1';
export const CHECKPOINTS = [
  'architecture',
  'implementation_path',
  'candidate_filtering',
  'risk',
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
  if (kind === 'choice' && raw?.type === 'choice' && labels.includes(raw.choice)) {
    return { value: raw.choice, confidence: raw.confidence, probabilities: raw.probabilities };
  }
  if (kind === 'score' && raw?.type === 'score' && Number.isFinite(raw.score)) {
    return { value: raw.score, confidence: raw.confidence, probabilities: raw.probabilities };
  }
  if (kind === 'bool' && raw?.type === 'bool' && Number.isFinite(raw.bool)) {
    return { value: raw.bool, confidence: undefined, probabilities: undefined };
  }
  const error = new Error('TypeSafe returned an invalid answer for the requested judgment type.');
  error.code = 'typesafe_answer_invalid';
  throw error;
}

export async function runExplicitJudgment(pi, client, params, ctx, signal, configPath = CONFIG_PATH) {
  const config = await loadConfig(configPath);
  const kind = params.kind;
  const labels = normalizedLabels(kind, params.labels);
  const state = params.state.trim().slice(0, 12_000);
  const question = params.question.trim().slice(0, 2_000);
  let result;

  try {
    const response = await client.judge(state, {
      decision: buildQuestion(kind, question, labels),
    }, signal);
    result = {
      backend: response.backend,
      model: response.model,
      usage: response.usage,
      fallbackReason: undefined,
      answer: normalizeAnswer(kind, response.answers.decision, labels),
    };
  } catch (error) {
    if (config.fallback === 'block') throw error;
    result = {
      backend: 'fallback',
      model: undefined,
      usage: undefined,
      fallbackReason: error?.code ?? 'typesafe_request_failed',
      answer: undefined,
    };
  }

  const receipt = {
    version: 1,
    sessionId: sessionId(ctx),
    recordedAt: new Date().toISOString(),
    checkpoint: params.checkpoint,
    kind,
    stateDigest: digest(state),
    questionDigest: digest(question),
    mode: config.mode,
    fallback: config.fallback,
    ...result,
  };
  pi.appendEntry(JUDGMENT_STATE_TYPE, receipt);
  return receipt;
}

function formatJudgment(receipt) {
  if (receipt.backend === 'fallback') {
    return `Jev checkpoint ${receipt.checkpoint} used fallback ${receipt.fallbackReason}; continue with current agent reasoning and preserve this receipt.`;
  }
  const confidence = Number.isFinite(receipt.answer?.confidence)
    ? `; confidence ${Math.round(receipt.answer.confidence * 100)}%`
    : '';
  return `Jev checkpoint ${receipt.checkpoint}: ${String(receipt.answer?.value)}${confidence}; model ${receipt.model}.`;
}

function formatStatus(config) {
  return `Jev Gate mode: ${config.mode}; fallback: ${config.fallback}. Automatic preflight sends prompt text to TypeSafe in observe and enforce modes. Explicit jev-judge calls send their supplied state and question.`;
}

const MODE_DESCRIPTIONS = {
  off: 'Skip automatic prompt preflight',
  observe: 'Record Jev guidance while preserving the current system prompt',
  enforce: 'Apply Jev guidance to the current system prompt',
};

const FALLBACK_DESCRIPTIONS = {
  continue: 'Record a fallback receipt and continue with the current agent',
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
  installJevGate(pi, { client, configPath });

  pi.registerTool({
    name: 'jev-judge',
    label: 'Jev Judgment',
    loadMode: 'essential',
    approval: 'read',
    description: 'Ask TypeSafe Jev one bounded choice, score or boolean question. Use it at material judgment checkpoints after gathering the relevant state.',
    parameters: pi.zod.object({
      checkpoint: pi.zod.enum(CHECKPOINTS),
      kind: pi.zod.enum(['choice', 'bool', 'score']),
      state: pi.zod.string().min(1).max(12_000),
      question: pi.zod.string().min(1).max(2_000),
      labels: pi.zod.array(pi.zod.string().min(1).max(120)).max(20).optional(),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const receipt = await runExplicitJudgment(pi, client, params, ctx, signal, configPath);
      return { content: [{ type: 'text', text: formatJudgment(receipt) }], details: receipt };
    },
  });

  pi.registerCommand('jev-gate', {
    description: 'Configure automatic Jev preflight: status, off, observe or enforce, with continue or block fallback.',
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
        if (!MODES.has(action)) throw new Error('Use /jev-gate status|off|observe|enforce [continue|block].');
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
