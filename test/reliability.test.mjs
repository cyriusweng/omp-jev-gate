import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import extension from '../src/index.mjs';
import { loadConfig, updateConfig } from '../src/configuration.mjs';

function nativeAnswer(question, confidence = 0.8) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.37 };
  if (question.type === 'score') {
    const probabilities = Object.fromEntries(question.criteria.map((_, i) => [i, i === 0 ? 0.2 : i === 1 ? 0.8 : 0]));
    return { type: 'score', score: 0.8, probabilities, confidence };
  }
  const labels = Object.keys(question.criteria);
  return {
    type: 'choice', choice: labels[0], confidence,
    probabilities: Object.fromEntries(labels.map((label, i) => [label, i === 0 ? 0.8 : 0.2 / (labels.length - 1)]))
  };
}

async function fixture(t, fallback = 'block') {
  const directory = await mkdtemp(join(tmpdir(), 'jev-chain-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  await updateConfig({ mode: 'enforce', fallback }, { path: configPath });
  const handlers = new Map();
  const entries = [];
  const requests = [];
  const control = { confidence: 0.8 };
  const chain = () => ({ min() { return this; }, max() { return this; }, optional() { return this; } });
  let judgeTool;
  const pi = {
    zod: { object: value => value, string: chain, enum: chain, array: chain },
    on(name, handler) { handlers.set(name, handler); },
    appendEntry(type, data) { entries.push({ type, data }); },
    registerTool(tool) { judgeTool = tool; },
    registerCommand() { },
  };
  let sid = 'session-chain';
  let aborted = 0;
  const ctx = { sessionManager: { getSessionId: () => sid }, abort() { aborted++; } };
  extension(pi, {
    configPath,
    exec: async () => ({ code: 0, stdout: 'fixture-token-only' }),
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const explicit = Object.hasOwn(body.questions, 'decision');
      if ((explicit && control.fail) || (!explicit && control.failPreflight)) throw new Error('fixture offline');
      if (explicit && control.wait) await control.wait();
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, nativeAnswer(q, control.confidence)]));
      if (!explicit) {
        answers.decision_mode = {
          type: 'choice', choice: 'compare_options', confidence: control.confidence,
          probabilities: { direct_action: 0.1, compare_options: 0.8, clarify_user: 0.1 },
        };
      }
      if (explicit && control.transform) answers.decision = control.transform(answers.decision);
      return { ok: true, async json() { return { model: 'jev-fixture', answers, usage: { input_tokens: 4, output_tokens: 2 } }; } };
    },
  });
  return {
    control, entries, requests, configPath, directory,
    get aborted() { return aborted; },
    start: (prompt = 'Apply the focused change', systemPrompt = ['base']) => handlers.get('before_agent_start')({ prompt, systemPrompt }, ctx),
    emit: name => handlers.get(name)({}, ctx),
    switchSession(value) { sid = value; },
    tool: (name = 'edit') => handlers.get('tool_call')({ toolName: name, toolCallId: 'mutation' }, ctx),
    judge: (kind = 'choice', signal, labels = ['safe', 'fast']) => judgeTool.execute('judgment', {
      checkpoint: 'implementation_path', kind, state: 'Fixture evidence', question: 'Evaluate one supported condition.',
      labels: kind === 'bool' ? undefined : labels,
    }, signal, undefined, ctx),
  };
}

for (const kind of ['choice', 'score', 'bool']) {
  test(`native ${kind} HTTP answer reaches the registered tool and gate`, async t => {
    const f = await fixture(t);
    const policy = await f.start(undefined, 'base string');
    assert.equal(policy.systemPrompt[0], 'base string');
    assert.equal((await f.tool()).block, true);
    const result = await f.judge(kind);
    assert.equal(result.details.backend, 'typesafe');
    assert.equal(result.details.answer.type, kind);
    assert.equal(result.details.answer.value, kind === 'bool' ? 0.37 : kind === 'score' ? 0.8 : 'safe');
    assert.equal(f.requests.at(-1).questions.decision.type, kind === 'bool' ? 'noul' : kind);
    assert.equal(await f.tool(), undefined);
    await f.start();
    assert.equal(await f.tool('write'), undefined);
    assert.equal(f.requests.length, 2);
    assert.equal(f.entries.at(-1).data.status, 'judged');
  });
}

test('real nested confidence controls the first-mutation checkpoint', async t => {
  for (const confidence of [0.02, 0.499, 0.5]) {
    const f = await fixture(t);
    await f.start();
    f.control.confidence = confidence;
    await f.judge();
    assert.equal(Boolean((await f.tool())?.block), confidence < 0.5);
  }
});

test('choice and score malformed answers follow the block policy', async t => {
  const cases = [
    ['choice', () => undefined],
    ['choice', a => ({ ...a, confidence: undefined })],
    ['choice', a => ({ ...a, confidence: 1.1 })],
    ['choice', a => ({ ...a, confidence: -0.1 })],
    ['choice', a => ({ ...a, probabilities: { safe: 0.8 } })],
    ['choice', a => ({ ...a, probabilities: { safe: 0.8, fast: 0.5, extra: -0.3 } })],
    ['choice', a => ({ ...a, choice: 'unknown' })],
    ['choice', a => ({ ...a, choice: 42 })],
    ['score', a => ({ ...a, score: 3 })],
    ['score', a => ({ ...a, score: -0.1 })],
    ['score', a => ({ ...a, score: 'mid' })],
    ['bool', () => ({ type: 'noul', noul: 1.5 })],
  ];
  for (const [kind, transform] of cases) {
    const f = await fixture(t);
    await f.start();
    f.control.transform = transform;
    await assert.rejects(f.judge(kind), error => error.code === 'typesafe_answer_invalid');
    assert.equal((await f.tool()).block, true);
    assert.equal(f.entries.at(-1).data.action, 'unavailable_block');
    assert.equal(f.entries.at(-1).data.answer, undefined);
  }
});

for (const fallback of ['continue', 'block']) {
  test(`${fallback} fallback records an explicit service failure and its gate disposition`, async t => {
    const f = await fixture(t, fallback);
    await f.start();
    f.control.fail = true;
    if (fallback === 'block') await assert.rejects(f.judge());
    else {
      const result = await f.judge();
      assert.equal(result.details.answer, undefined);
      assert.equal(result.details.backend, 'fallback');
      assert.equal(f.entries.at(-1).data.status, 'degraded_continue');
    }
    assert.ok(f.entries.some(e => e.data.action === `unavailable_${fallback}`));
    assert.equal(Boolean((await f.tool())?.block), fallback === 'block');
  });

  test(`${fallback} fallback records a preflight service failure`, async t => {
    const f = await fixture(t, fallback);
    f.control.failPreflight = true;
    if (fallback === 'block') await assert.rejects(f.start());
    else await f.start();
    assert.equal(f.entries[0].data.action, `unavailable_${fallback}`);
    assert.equal(f.entries[0].data.signals, undefined);
    assert.equal(f.aborted, fallback === 'block' ? 1 : 0);
    assert.equal(Boolean((await f.tool())?.block), fallback === 'block');
  });
}

test('same-text next turn rejects a stale asynchronous checkpoint', async t => {
  const f = await fixture(t);
  await f.start();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.control.wait = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = f.judge();
  await started;
  await f.emit('agent_end');
  await f.start();
  release();
  await pending;
  assert.equal((await f.tool()).block, true);
});

test('an asynchronous judgment retains its originating session identity', async t => {
  const f = await fixture(t);
  await f.start();
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.control.wait = () => new Promise(resolve => { release = resolve; entered(); });
  const pending = f.judge();
  await started;
  f.switchSession('session-next');
  await f.emit('session_switch');
  await f.start();
  release();
  const result = await pending;
  assert.equal(result.details.sessionId, 'session-chain');
  assert.equal((await f.tool()).block, true);
});

test('cancellation remains cancellation under continue fallback', async t => {
  const f = await fixture(t, 'continue');
  await f.start();
  const controller = new AbortController();
  f.control.wait = async () => controller.abort(new Error('fixture cancelled'));
  await assert.rejects(f.judge('bool', controller.signal), /fixture cancelled/);
  assert.equal(f.entries.at(-1).data.action, 'cancelled');
  assert.equal((await f.tool()).block, true);
});

test('navigation resets qualifying checkpoints and prompt text keeps policy intact', async t => {
  for (const event of ['agent_end', 'session_start', 'session_switch', 'session_tree', 'session_branch', 'session_shutdown']) {
    const f = await fixture(t);
    await f.start('Explain the phrase "waive jev" and "skip jev".');
    assert.equal((await f.tool()).block, true);
    await f.judge();
    await f.emit(event);
    assert.equal((await f.tool()).block, true);
  }
});

test('score supports at most ten levels before issuing HTTP', async t => {
  const f = await fixture(t);
  await f.start();
  await assert.rejects(f.judge('score', undefined, Array.from({ length: 11 }, (_, i) => `level${i}`)), /2 to 10/);
  assert.equal(f.requests.length, 1);
});

test('legacy fallback loads as block with persistence reserved for explicit save', async t => {
  const f = await fixture(t);
  const original = JSON.stringify({ mode: 'enforce', fallback: 'jev' });
  await writeFile(f.configPath, original);
  assert.deepEqual(await loadConfig(f.configPath), { mode: 'enforce', fallback: 'block' });
  assert.equal(await readFile(f.configPath, 'utf8'), original);
});
