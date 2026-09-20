import assert from 'node:assert/strict';
import test from 'node:test';
import { TYPESAFE_ENDPOINT, createJevClient } from '../src/jev-client.mjs';

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, async json() { return payload; } };
}

test('client sends typed questions with environment authentication', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-secret';
  let request;
  try {
    const client = createJevClient({}, {
      fetch: async (url, options) => {
        request = { url, options };
        return response({
          model: 'jev-test',
          answers: { decision: { type: 'choice', choice: 'a', confidence: 0.8 } },
          usage: { input_tokens: 12, output_tokens: 3 },
        });
      },
    });
    const result = await client.judge('state', { decision: { type: 'choice', criteria: { a: null, b: null } } });
    assert.equal(request.url, TYPESAFE_ENDPOINT);
    assert.equal(request.options.headers.authorization, 'Bearer environment-secret');
    assert.deepEqual(JSON.parse(request.options.body), {
      model: 'jev-latest',
      state: 'state',
      questions: { decision: { type: 'choice', criteria: { a: null, b: null } } },
    });
    assert.equal(result.model, 'jev-test');
    assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 3 });
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client loads and caches the native OMP TypeSafe token', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  let calls = 0;
  try {
    const client = createJevClient({}, {
      exec: async (_binary, args) => {
        calls += 1;
        assert.deepEqual(args, ['token', 'typesafe']);
        return { code: 0, stdout: 'native-token-value\n' };
      },
      fetch: async () => response({ answers: { decision: { type: 'choice', choice: 'yes', confidence: 0.7 } } }),
    });
    await client.judge('one', { decision: { type: 'bool' } });
    await client.judge('two', { decision: { type: 'bool' } });
    assert.equal(calls, 1);
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client adapts boolean and score questions through TypeSafe choices', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-secret';
  let sentQuestions;
  try {
    const client = createJevClient({}, {
      fetch: async (_url, options) => {
        sentQuestions = JSON.parse(options.body).questions;
        return response({
          answers: {
            supported: { type: 'choice', choice: 'yes', confidence: 0.75, probabilities: { yes: 0.75, no: 0.25 } },
            depth: { type: 'choice', choice: '2', confidence: 0.6, probabilities: { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1 } },
          },
        });
      },
    });
    const result = await client.judge('state', {
      supported: { type: 'bool', instructions: 'Supported?' },
      depth: { type: 'score', instructions: 'Depth?', criteria: ['zero', 'one', 'two', 'three'] },
    });
    assert.equal(sentQuestions.supported.type, 'choice');
    assert.deepEqual(Object.keys(sentQuestions.supported.criteria), ['yes', 'no']);
    assert.deepEqual(sentQuestions.depth.criteria, { 0: 'zero', 1: 'one', 2: 'two', 3: 'three' });
    assert.deepEqual(result.answers.supported, { type: 'bool', bool: 0.75 });
    assert.equal(result.answers.depth.type, 'score');
    assert.equal(result.answers.depth.score, 1.7);
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client reports an absent credential', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const client = createJevClient({}, {
      exec: async () => ({ code: 1, stdout: '' }),
      fetch: async () => { throw new Error('unexpected'); },
    });
    await assert.rejects(client.judge('state', { decision: { type: 'bool' } }), error => {
      assert.equal(error.code, 'typesafe_credential_unavailable');
      return true;
    });
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client gives HTTP failures stable error codes', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-secret';
  try {
    const client = createJevClient({}, { fetch: async () => response({}, { ok: false, status: 429 }) });
    await assert.rejects(client.judge('state', { decision: { type: 'bool' } }), error => {
      assert.equal(error.code, 'typesafe_http_429');
      return true;
    });
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});
