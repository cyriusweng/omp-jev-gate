import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import jevGateExtension, { JUDGMENT_STATE_TYPE } from '../src/index.mjs';

function chain() {
  return { min() { return this; }, max() { return this; }, optional() { return this; } };
}

async function setup(client, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'omp-jev-gate-index-'));
  const configPath = join(directory, 'config.json');
  if (options.configFile) {
    await writeFile(configPath, JSON.stringify(options.configFile));
  }
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const entries = [];
  const notices = [];
  const selections = [...(options.selections ?? [])];
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
    hasUI: options.hasUI ?? false,
    sessionManager: { getSessionId: () => 'session-1' },
    ui: {
      notify(message, level) { notices.push({ message, level }); },
      async select(title, selectOptions, dialog) {
        assert.ok(selections.length, `Unexpected selector: ${title}`);
        const selection = selections.shift();
        return typeof selection === 'function'
          ? selection({ title, options: selectOptions, dialog })
          : selection;
      },
    },
  };
  return { directory, configPath, handlers, tools, commands, entries, notices, selections, ctx };
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

test('registered tool execution unlocks the gate through the shared handlers', async t => {
  const fixture = await setup({
    async judge() {
      return {
        backend: 'typesafe',
        model: 'jev-test',
        usage: {},
        answers: { decision: { type: 'choice', choice: 'safe', confidence: 0.88, probabilities: { safe: 0.88, fast: 0.12 } } },
      };
    },
  }, { configFile: { mode: 'enforce', fallback: 'continue' } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  assert.equal(
    (await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e1' }, fixture.ctx))?.block,
    true,
  );

  await fixture.tools.get('jev-judge').execute('call-1', {
    checkpoint: 'risk',
    kind: 'choice',
    state: 'relevant state',
    question: 'Which path?',
    labels: ['safe', 'fast'],
  }, undefined, undefined, fixture.ctx);

  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e2' }, fixture.ctx), undefined);
  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'bash', toolCallId: 'b1' }, fixture.ctx), undefined);
});

test('a fresh explicit judgment suspends a judged turn until it resolves', async t => {
  let fail = false;
  const fixture = await setup({
    async judge() {
      if (fail) throw Object.assign(new Error('offline'), { code: 'typesafe_timeout' });
      return {
        backend: 'typesafe',
        model: 'jev-test',
        usage: {},
        answers: { decision: { type: 'choice', choice: 'safe', confidence: 0.9, probabilities: { safe: 0.9, fast: 0.1 } } },
      };
    },
  }, { configFile: { mode: 'enforce', fallback: 'block' } });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const params = { checkpoint: 'risk', kind: 'choice', state: 'relevant state', question: 'Which path?', labels: ['safe', 'fast'] };
  await fixture.tools.get('jev-judge').execute('call-1', params, undefined, undefined, fixture.ctx);
  assert.equal(await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e1' }, fixture.ctx), undefined);
  fail = true;
  await assert.rejects(fixture.tools.get('jev-judge').execute('call-2', params, undefined, undefined, fixture.ctx));
  assert.equal((await fixture.handlers.get('tool_call')({ toolName: 'edit', toolCallId: 'e2' }, fixture.ctx))?.block, true);
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

test('explicit judgment with continue fallback records a degraded disposition without an answer', async t => {
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
  assert.equal(result.details.answer, undefined);
  assert.match(result.content[0].text, /degraded disposition/);
});

test('explicit judgment with block fallback stops the call', async t => {
  const fixture = await setup(
    { async judge() { throw Object.assign(new Error('offline'), { code: 'typesafe_timeout' }); } },
    { configFile: { mode: 'enforce', fallback: 'block' } },
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(
    fixture.tools.get('jev-judge').execute('call-1', {
      checkpoint: 'delivery_preflight',
      kind: 'bool',
      state: 'state',
      question: 'Ready?',
    }, undefined, undefined, fixture.ctx),
    error => error.code === 'typesafe_timeout',
  );
  assert.equal(fixture.entries.length, 1);
  assert.equal(fixture.entries[0].data.action, 'unavailable_block');
  assert.equal(fixture.entries[0].data.answer, undefined);
});

test('explicit judgment keeps the configured block fallback in guide mode', async t => {
  const fixture = await setup(
    { async judge() { throw Object.assign(new Error('offline'), { code: 'typesafe_timeout' }); } },
    { configFile: { mode: 'guide', fallback: 'block' } },
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(
    fixture.tools.get('jev-judge').execute('call-1', {
      checkpoint: 'risk',
      kind: 'bool',
      state: 'state',
      question: 'Ready?',
    }, undefined, undefined, fixture.ctx),
    error => error.code === 'typesafe_timeout',
  );
  assert.equal(fixture.entries[0].data.action, 'unavailable_block');
});

test('malformed service answers follow the configured fallback without fabrication', async t => {
  const fixture = await setup({
    async judge() {
      return {
        backend: 'typesafe',
        model: 'jev-test',
        answers: {
          decision: { type: 'choice', choice: 'safe', confidence: 0.9, probabilities: { wrong: 0.9, fast: 0.1 } },
        },
      };
    },
  });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const result = await fixture.tools.get('jev-judge').execute('call-1', {
    checkpoint: 'risk',
    kind: 'choice',
    state: 'state',
    question: 'Which path?',
    labels: ['safe', 'fast'],
  }, undefined, undefined, fixture.ctx);
  assert.equal(result.details.backend, 'fallback');
  assert.equal(result.details.fallbackReason, 'typesafe_answer_invalid');
  assert.equal(result.details.answer, undefined);
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

test('empty interactive command opens graphical mode and fallback settings', async t => {
  const fixture = await setup(
    { async judge() { throw new Error('unused'); } },
    {
      hasUI: true,
      selections: [
        ({ title, options, dialog }) => {
          assert.equal(title, 'Jev Gate Mode');
          assert.deepEqual(options.map(option => option.label), ['off', 'observe', 'guide', 'enforce']);
          assert.equal(dialog.initialIndex, 0);
          return 'enforce';
        },
        ({ title, options, dialog }) => {
          assert.equal(title, 'Jev Gate Fallback');
          assert.deepEqual(options.map(option => option.label), ['continue', 'block']);
          assert.equal(dialog.initialIndex, 0);
          return 'block';
        },
      ],
    },
  );
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));

  await fixture.commands.get('jev-gate').handler('', fixture.ctx);
  assert.match(fixture.notices.at(-1).message, /mode: enforce; fallback: block/);
  assert.equal(fixture.selections.length, 0);
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

test('domain-neutral and legacy checkpoints both record receipts', async t => {
  const fixture = await setup({
    async judge() {
      return {
        backend: 'typesafe',
        model: 'jev-test',
        usage: {},
        answers: { decision: { type: 'bool', bool: 0.82 } },
      };
    },
  });
  t.after(() => rm(fixture.directory, { recursive: true, force: true }));
  const tool = fixture.tools.get('jev-judge');
  const modern = await tool.execute('call-1', {
    checkpoint: 'evidence_sufficiency',
    kind: 'bool',
    state: 'Test results',
    question: 'Do the listed assertions exercise the changed behaviour?',
  }, undefined, undefined, fixture.ctx);
  assert.equal(modern.details.checkpoint, 'evidence_sufficiency');
  assert.equal(modern.details.answer.value, 0.82);
  assert.match(modern.content[0].text, /0\.82/);
  const legacy = await tool.execute('call-2', {
    checkpoint: 'architecture',
    kind: 'bool',
    state: 'state',
    question: 'Does the condition hold?',
  }, undefined, undefined, fixture.ctx);
  assert.equal(legacy.details.checkpoint, 'architecture');
  assert.match(tool.description, /all four hold/);
});
