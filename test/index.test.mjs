import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import jevGateExtension, { JUDGMENT_STATE_TYPE } from '../src/index.mjs';

function chain() {
  return { min() { return this; }, max() { return this; }, optional() { return this; } };
}

async function setup(client) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-jev-gate-index-'));
  const configPath = join(directory, 'config.json');
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  const pi = {
    zod: {
      object(value) { return value; },
      enum() { return chain(); },
      string() { return chain(); },
      array() { return chain(); },
    },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { entries.push({ type, data }); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  jevGateExtension(pi, { client, configPath });
  const ctx = {
    sessionManager: { getSessionId: () => 'session-1' },
    ui: { notify(message, level) { notices.push({ message, level }); } },
  };
  return { directory, configPath, handlers, tools, commands, entries, notices, ctx };
}

test('plugin registers an essential typed judgment tool', async t => {
  const fixture = await setup({
    async judge() {
      return {
        backend: 'typesafe',
        model: 'jev-test',
        usage: {},
        answers: { decision: { type: 'choice', choice: 'safe', confidence: 0.88, probabilities: { safe: 0.88, fast: 0.12 } } },
      };
    },
  });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const tool = fixture.tools.get('jev-judge');
  assert.equal(tool.loadMode, 'essential');
  assert.equal(tool.approval, 'read');
  const result = await tool.execute('call-1', {
    checkpoint: 'risk',
    kind: 'choice',
    state: 'relevant state',
    question: 'Which path?',
    labels: ['safe', 'fast'],
  }, undefined, undefined, fixture.ctx);
  assert.match(result.content[0].text, /safe/);
  assert.equal(result.details.answer.value, 'safe');
  assert.equal(fixture.entries[0].type, JUDGMENT_STATE_TYPE);
  assert.equal(fixture.entries[0].data.state, undefined);
});

test('explicit judgment uses configured continue fallback', async t => {
  const fixture = await setup({ async judge() { throw Object.assign(new Error('offline'), { code: 'typesafe_timeout' }); } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const result = await fixture.tools.get('jev-judge').execute('call-1', {
    checkpoint: 'delivery_preflight',
    kind: 'bool',
    state: 'state',
    question: 'Ready?',
  }, undefined, undefined, fixture.ctx);
  assert.equal(result.details.backend, 'fallback');
  assert.equal(result.details.fallbackReason, 'typesafe_timeout');
});

test('command configures enforce mode and reports disclosure', async t => {
  const fixture = await setup({ async judge() { throw new Error('unused'); } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await fixture.commands.get('jev-gate').handler('enforce block', fixture.ctx);
  assert.equal(fixture.notices.at(-1).level, 'info');
  assert.match(fixture.notices.at(-1).message, /mode: enforce; fallback: block/);
  assert.match(fixture.notices.at(-1).message, /sends prompt text to TypeSafe/);
  await fixture.commands.get('jev-gate').handler('status', fixture.ctx);
  assert.match(fixture.notices.at(-1).message, /mode: enforce/);
});

test('choice and score judgments require distinct labels', async t => {
  const fixture = await setup({ async judge() { throw new Error('unexpected'); } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(
    fixture.tools.get('jev-judge').execute('call-1', {
      checkpoint: 'architecture',
      kind: 'choice',
      state: 'state',
      question: 'Choose?',
      labels: ['one', 'one'],
    }, undefined, undefined, fixture.ctx),
    /at least two distinct labels/,
  );
});
