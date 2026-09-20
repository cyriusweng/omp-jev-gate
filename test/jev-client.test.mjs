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
          answers: {
            decision: {
              type: 'choice',
              choice: 'a',
              confidence: 0.8,
              probabilities: { a: 0.8, b: 0.2 },
            },
          },
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
    assert.equal(result.answers.decision.choice, 'a');
    assert.equal(result.answers.decision.confidence, 0.8);
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
      fetch: async () => response({ answers: { decision: { type: 'noul', noul: 0.7 } } }),
    });
    await client.judge('one', { decision: { type: 'noul', instructions: 'one' } });
    await client.judge('two', { decision: { type: 'noul', instructions: 'two' } });
    assert.equal(calls, 1);
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client sends native noul and score questions and preserves native answers', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-secret';
  let sentQuestions;
  try {
    const client = createJevClient({}, {
      fetch: async (_url, options) => {
        sentQuestions = JSON.parse(options.body).questions;
        return response({
          answers: {
            supported: { type: 'noul', noul: 0.75 },
            depth: {
              type: 'score',
              score: 1.7,
              legend: { 0: 'zero', 1: 'one', 2: 'two', 3: 'three' },
              probabilities: { 0: 0.1, 1: 0.2, 2: 0.6, 3: 0.1 },
              confidence: 0.6,
            },
          },
        });
      },
    });
    const result = await client.judge('state', {
      supported: { type: 'bool', instructions: 'Supported?' },
      depth: { type: 'score', instructions: 'Depth?', criteria: ['zero', 'one', 'two', 'three'] },
    });
    assert.equal(sentQuestions.supported.type, 'noul');
    assert.deepEqual(sentQuestions.depth.criteria, ['zero', 'one', 'two', 'three']);
    assert.deepEqual(result.answers.supported, { type: 'bool', bool: 0.75 });
    assert.equal(result.answers.depth.score, 1.7);
    assert.equal(result.answers.depth.confidence, 0.6);
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client rejects malformed answers with a stable code', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-secret';
  const cases = [
    { answers: {} },
    { answers: { decision: { type: 'noul', noul: 1.4 } } },
    { answers: { decision: { type: 'choice', choice: 'unknown', confidence: 0.9, probabilities: { a: 0.5, b: 0.5 } } } },
    { answers: { decision: { type: 'choice', choice: 'a', confidence: 0.9, probabilities: { a: 0.9 } } } },
    { answers: { decision: { type: 'choice', choice: 'a', confidence: 1.4, probabilities: { a: 0.9, b: 0.1 } } } },
    { answers: { decision: { type: 'score', score: 9, confidence: 0.9, probabilities: { 0: 0.5, 1: 0.5 } } } },
    { answers: { decision: { type: 'noul', noul: 'high' } } },
  ];
  try {
    for (const payload of cases) {
      const client = createJevClient({}, { fetch: async () => response(payload) });
      await assert.rejects(
        client.judge('state', { decision: { type: 'noul', instructions: 'q' } }),
        error => error.code === 'typesafe_answer_invalid',
        `expected rejection for ${JSON.stringify(payload)}`,
      );
    }
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});

test('client accepts native answers without deriving consistency from rounded fields', async () => {
  const prior = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = 'environment-secret';
  try {
    const client = createJevClient({}, {
      fetch: async () => response({
        answers: {
          near: { type: 'choice', choice: 'a', confidence: 0.7, probabilities: { a: 0.334, b: 0.333, c: 0.332 } },
          other: { type: 'choice', choice: 'b', confidence: 0.55, probabilities: { a: 0.501, b: 0.499 } },
          depth: { type: 'score', score: 0.9, confidence: 0.6, probabilities: { 0: 0.3, 1: 0.4, 2: 0.3 } },
        },
      }),
    });
    const result = await client.judge('state', {
      near: { type: 'choice', instructions: 'n', criteria: { a: null, b: null, c: null } },
      other: { type: 'choice', instructions: 'o', criteria: { a: null, b: null } },
      depth: { type: 'score', instructions: 'd', criteria: ['low', 'mid', 'high'] },
    });
    assert.equal(result.answers.near.choice, 'a');
    assert.equal(result.answers.other.choice, 'b');
    assert.equal(result.answers.depth.score, 0.9);
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
    await assert.rejects(client.judge('state', { decision: { type: 'noul', instructions: 'q' } }), error => {
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
    await assert.rejects(client.judge('state', { decision: { type: 'noul', instructions: 'q' } }), error => {
      assert.equal(error.code, 'typesafe_http_429');
      return true;
    });
  } finally {
    if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = prior;
  }
});
