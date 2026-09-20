import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { updateConfig } from '../src/configuration.mjs';
import { PREFLIGHT_STATE_TYPE, installJevGate, normalizePreflight } from '../src/gate.mjs';

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
  installJevGate(pi, { client, configPath });
  let aborted = 0;
  const ctx = {
    sessionManager: { getSessionId: () => 'session-1' },
    abort() { aborted += 1; },
  };
  return { directory, handlers, entries, ctx, get aborted() { return aborted; } };
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
          decision_mode: { type: 'choice', choice: 'compare_options' },
          reasoning_depth: { type: 'score', score: 2.4 },
          verification_depth: { type: 'choice', choice: 'broad' },
          additional_jev: { type: 'bool', bool: 0.9 },
        },
      };
    },
  };
}

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

test('enforce mode injects stable Jev policy', async t => {
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, successClient());
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const event = { prompt: 'task', systemPrompt: ['base policy', 'second policy'] };
  const result = await fixture.handlers.get('before_agent_start')(event, fixture.ctx);
  assert.deepEqual(result.systemPrompt.slice(0, 2), ['base policy', 'second policy']);
  assert.match(result.systemPrompt[2], /Decision mode: compare_options/);
  assert.match(result.systemPrompt[2], /Verification depth: broad/);
  assert.equal(fixture.entries[0].data.action, 'policy_injected');
});

test('continue fallback injects deterministic signals and an audit reason', async t => {
  const error = Object.assign(new Error('offline'), { code: 'typesafe_timeout' });
  const fixture = await setup({ mode: 'enforce', fallback: 'continue' }, { async judge() { throw error; } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const result = await fixture.handlers.get('before_agent_start')({ prompt: 'task', systemPrompt: ['base'] }, fixture.ctx);
  assert.match(result.systemPrompt[1], /Preflight backend: fallback/);
  assert.equal(fixture.entries[0].data.fallbackReason, 'typesafe_timeout');
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
});

test('preflight answer normalization supplies stable defaults', () => {
  assert.deepEqual(normalizePreflight({}), {
    decisionMode: 'direct_action',
    reasoningDepth: 1,
    verificationDepth: 'targeted',
    additionalJevProbability: 0.5,
  });
});
