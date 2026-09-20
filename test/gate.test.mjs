import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateConfig } from '../src/configuration.mjs';
import { GATED_TOOLS, PREFLIGHT_STATE_TYPE, installJevGate, normalizePreflight } from '../src/gate.mjs';

async function setup(config, client) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-jev-gate-'));
  const configPath = join(directory, 'config.json');
  await updateConfig(config, { path: configPath });
  const handlers = new Map();
  const entries = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { entries.push({ type, data }); },
  };
  const gate = installJevGate(pi, { client, configPath });
  let aborted = 0;
  const ctx = {
    sessionManager: { getSessionId: () => 'session-1' },
    abort() { aborted += 1; },
  };
  return { directory, handlers, entries, ctx, gate, get aborted() { return aborted; } };
}

function successClient(counter = { calls: 0 }) {
  return {
    async judge() {
      counter.calls += 1;
      return {
        backend: 'typesafe',
        model: 'jev-test',
        usage: { inputTokens: 10, outputTokens: 4 },
        answers: {
          decision_mode: { type: 'choice', choice: 'compare_options', confidence: 0.8, probabilities: { direct_action: 0.1, compare_options: 0.8, clarify_user: 0.1 } },
          reasoning_depth: { type: 'score', score: 2.4, confidence: 0.8, probabilities: { 0: 0, 1: 0, 2: 0.6, 3: 0.4 } },
          verification_depth: { type: 'choice', choice: 'broad', confidence: 0.8, probabilities: { light: 0.1, targeted: 0.1, broad: 0.8 } },
          additional_jev: { type: 'bool', bool: 0.9 },
        },
      };
    },
  };
}

// Real explicit-judgment receipts as produced by runExplicitJudgment.
const JUDGED_CHOICE = {
  backend: 'typesafe',
  kind: 'choice', sessionId: 'session-1',
  answer: { type: 'choice', value: 'proceed', confidence: 0.9, probabilities: { proceed: 0.9, hold: 0.1 } },
};
const LOW_CONFIDENCE_CHOICE = {
  backend: 'typesafe',
  kind: 'choice', sessionId: 'session-1',
  answer: { type: 'choice', value: 'proceed', confidence: 0.02, probabilities: { proceed: 0.51, hold: 0.49 } },
};
const JUDGED_BOOL = {
  backend: 'typesafe',
  kind: 'bool', sessionId: 'session-1',
  answer: { type: 'bool', value: 0.97 },
};
const DEGRADED = {
  backend: 'fallback',
  fallbackReason: 'typesafe_timeout',
  answer: undefined,
};

test('off mode skips automatic preflight', async t => {
  const counter = { calls: 0 };
  const fixture = await setup({ mode: 'off', fallback: 'continue' }, successClient(counter));
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const result = await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: 'base' }, fixture.ctx);
  assert.equal(result, undefined);
  assert.equal(counter.calls, 0);
  assert.deepEqual(fixture.entries, []);
});

test('observe mode records one receipt across hook re-entry', async t => {
  const counter = { calls: 0 };
  const fixture = await setup({ mode: 'observe', fallback: 'continue' }, successClient(counter));
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const event = { prompt: 'task', systemPrompt: 'base' };
  assert.equal(await fixture.handlers.get('before_agent_start')(event, fixture.ctx), undefined);
  assert.equal(await fixture.handlers.get('before_agent_start')(event, fixture.ctx), undefined);
  assert.equal(counter.calls, 1);
  assert.equal(fixture.entries.length, 1);
  assert.equal(fixture.entries[0].type, PREFLIGHT_STATE_TYPE);
  assert.equal(fixture.entries[0].data.action, 'observed');
  assert.equal(fixture.entries[0].data.prompt, undefined);
});

test('enforce mode injects stable Jev policy preserving a string prompt', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const result = await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: 'base policy' }, fixture.ctx);
  assert.deepEqual(result.systemPrompt, ['base policy', result.systemPrompt[1]]);
  assert.match(result.systemPrompt[1], /Decision mode: compare_options/);
  assert.match(result.systemPrompt[1], /Verification depth: broad/);
  assert.equal(fixture.entries[0].data.action, 'policy_injected');
});

test('continue fallback records a degraded preflight without signals fabrication', async t => {
  const error = Object.assign(new Error('offline'), { code: 'typesafe_timeout' });
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, { async judge() { throw error; } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const result = await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: ['base'] }, fixture.ctx);
  assert.match(result.systemPrompt[1], /Preflight backend: fallback/);
  assert.equal(fixture.entries[0].data.fallbackReason, 'typesafe_timeout');
  assert.equal(fixture.entries[0].data.action, 'unavailable_continue');
  assert.equal(fixture.entries[0].data.signals, undefined);
  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'edit' }, fixture.ctx), undefined);
});

test('block fallback propagates the TypeSafe failure', async t => {
  const error = Object.assign(new Error('offline'), { code: 'typesafe_timeout' });
  const fixture = await setup({ mode: 'enforce', fallback: 'block' }, { async judge() { throw error; } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(
    fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: 'base' }, fixture.ctx),
    candidate => candidate === error,
  );
  assert.equal(fixture.aborted, 1);
  assert.equal(fixture.entries[0].data.action, 'unavailable_block');
  assert.equal(fixture.entries[0].data.signals, undefined);
});

test('incomplete preflight answers raise a typed validation failure', () => {
  assert.throws(() => normalizePreflight({}), error => error.code === 'typesafe_answer_invalid');
});

test('enforce blocks the first mutating tool call before judgment', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: [] }, fixture.ctx);

  const blocked = await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e1' }, fixture.ctx);
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /jev-judge/);

  const readResult = await fixture.handlers.get('tool_call')({ toolName: 'read', toolCallId: 'r1' }, fixture.ctx);
  assert.equal(readResult, undefined);
  assert.deepEqual([...GATED_TOOLS].sort(), ['bash', 'edit', 'write']);
});

test('quoted waiver text keeps the gate closed', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')(
    { prompt: 'the phrase "waive jev" must never unlock anything', systemPrompt: [] },
    fixture.ctx,
  );
  const blocked = await fixture.handlers.get('tool_call')({ toolName: 'write', toolCallId: 'w1' }, fixture.ctx);
  assert.equal(blocked?.block, true);
});

test('judged turn unlocks mutating calls until the turn ends', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const event = { prompt: 'task', systemPrompt: [] };
  await fixture.handlers.get('before_agent_start')(event, fixture.ctx);
  const turnId = fixture.gate.captureTurn(fixture.ctx);

  assert.equal(fixture.gate.markJudged(turnId, JUDGED_CHOICE), true);
  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'b1' }, fixture.ctx), undefined);
  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e1' }, fixture.ctx), undefined);

  await fixture.handlers.get('agent_end')({}, fixture.ctx);
  const blockedAfterTurn = await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e2' }, fixture.ctx);
  assert.equal(blockedAfterTurn?.block, true);
});

test('bool receipts with valid probability unlock the gate', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: [] }, fixture.ctx);
  const turnId = fixture.gate.captureTurn(fixture.ctx);

  assert.equal(fixture.gate.markJudged(turnId, JUDGED_BOOL), true);
  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'write', toolCallId: 'w1' }, fixture.ctx), undefined);
});

test('low-confidence and degraded receipts keep the gate closed', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: [] }, fixture.ctx);
  const turnId = fixture.gate.captureTurn(fixture.ctx);

  assert.equal(fixture.gate.markJudged(turnId, LOW_CONFIDENCE_CHOICE), false);
  assert.equal((await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e2' }, fixture.ctx))?.block, true);

  assert.equal(fixture.gate.markJudged(turnId, DEGRADED), false);
  assert.equal((await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e3' }, fixture.ctx))?.block, true);

  assert.equal(fixture.gate.markJudged('other-turn', JUDGED_CHOICE), false);
  assert.equal((await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e4' }, fixture.ctx))?.block, true);
});

test('stale async judgment cannot unlock a newer turn', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')({ prompt: 'first task', systemPrompt: [] }, fixture.ctx);
  const staleTurnId = fixture.gate.captureTurn(fixture.ctx);

  await fixture.handlers.get('before_agent_start')({ prompt: 'second task', systemPrompt: [] }, fixture.ctx);

  assert.equal(fixture.gate.markJudged(staleTurnId, JUDGED_CHOICE), false);
  assert.equal((await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e5' }, fixture.ctx))?.block, true);
});

test('session navigation clears turn judgment', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: [] }, fixture.ctx);
  const turnId = fixture.gate.captureTurn(fixture.ctx);
  assert.equal(fixture.gate.markJudged(turnId, JUDGED_CHOICE), true);

  await fixture.handlers.get('session_switch')({}, fixture.ctx);
  assert.equal((await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e6' }, fixture.ctx))?.block, true);
});

test('observe mode never intercepts tool calls', async t => {
  const fixture = await setup({ mode: 'observe', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: [] }, fixture.ctx);

  const result = await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e7' }, fixture.ctx);
  assert.equal(result, undefined);
});
