export const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

function combinedSignal(signal, timeout) {
  const timeoutSignal = AbortSignal.timeout(timeout);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function safeUsage(usage) {
  return {
    inputTokens: Number.isInteger(usage?.input_tokens) ? usage.input_tokens : undefined,
    outputTokens: Number.isInteger(usage?.output_tokens) ? usage.output_tokens : undefined,
  };
}

function requestFailure(error, signal) {
  if (signal?.aborted) throw signal.reason ?? error;
  const wrapped = new Error(error?.name === 'TimeoutError' || error?.name === 'AbortError'
    ? 'TypeSafe request timed out.'
    : 'TypeSafe request failed.');
  wrapped.code = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    ? 'typesafe_timeout'
    : 'typesafe_request_failed';
  wrapped.cause = error;
  return wrapped;
}

function encodeQuestion(question) {
  if (question.type === 'bool') {
    return {
      type: 'choice',
      instructions: question.instructions,
      criteria: {
        yes: question.criteria?.true ?? 'The proposition is supported.',
        no: question.criteria?.false ?? 'The proposition has insufficient support.',
      },
    };
  }
  if (question.type === 'score') {
    return {
      type: 'choice',
      instructions: question.instructions,
      criteria: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])),
    };
  }
  return question;
}

function probabilityOf(raw, label) {
  const direct = raw?.probabilities?.[label];
  if (Number.isFinite(direct)) return direct;
  if (raw?.choice === label) return Number.isFinite(raw.confidence) ? raw.confidence : 1;
  if (Number.isFinite(raw?.confidence)) return 1 - raw.confidence;
  return 0;
}

function decodeAnswer(question, raw) {
  if (question.type === 'bool') {
    return { type: 'bool', bool: probabilityOf(raw, 'yes') };
  }
  if (question.type === 'score') {
    const levels = question.criteria.map((_, index) => String(index));
    const probabilities = Object.fromEntries(levels.map(label => [label, probabilityOf(raw, label)]));
    const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
    const score = total > 0
      ? levels.reduce((sum, label) => sum + Number(label) * probabilities[label], 0) / total
      : Number(raw?.choice);
    return { type: 'score', score, probabilities, confidence: raw?.confidence };
  }
  return raw;
}

function encodeQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, encodeQuestion(question)]));
}

function decodeAnswers(questions, answers) {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, decodeAnswer(question, answers[id])]));
}


export function createJevClient(pi, options = {}) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const ompBin = options.ompBin ?? process.env.OMP_BIN ?? 'omp';
  const requestTimeout = options.typesafeTimeout ?? 8_000;
  const commandTimeout = options.commandTimeout ?? 5_000;
  let cachedKey;

  async function exec(args, signal) {
    if (typeof options.exec === 'function') return options.exec(ompBin, args, { signal, timeout: commandTimeout });
    if (typeof pi.exec === 'function') return pi.exec(ompBin, args, { signal, timeout: commandTimeout });
    return { code: 127, stdout: '', stderr: '', killed: false };
  }

  async function credential(signal) {
    const environmentKey = process.env.TYPESAFE_API_KEY?.trim();
    if (environmentKey) return { key: environmentKey, source: 'environment' };
    if (cachedKey) return { key: cachedKey, source: 'omp-token-store' };
    try {
      const result = await exec(['token', 'typesafe'], signal);
      const key = result.code === 0 ? result.stdout.trim() : '';
      if (key.length >= 10) {
        cachedKey = key;
        return { key, source: 'omp-token-store' };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    return { key: undefined, source: 'absent' };
  }

  async function judge(state, questions, signal) {
    signal?.throwIfAborted();
    const auth = await credential(signal);
    if (!auth.key) {
      const error = new Error('TypeSafe credential is unavailable.');
      error.code = 'typesafe_credential_unavailable';
      throw error;
    }

    let response;
    try {
      response = await fetchFn(options.endpoint ?? TYPESAFE_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${auth.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'jev-latest', state, questions: encodeQuestions(questions) }),
        signal: combinedSignal(signal, requestTimeout),
      });
    } catch (error) {
      throw requestFailure(error, signal);
    }

    if (!response.ok) {
      const error = new Error(`TypeSafe returned HTTP ${response.status}.`);
      error.code = `typesafe_http_${response.status}`;
      throw error;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const wrapped = new Error('TypeSafe returned invalid JSON.');
      wrapped.code = 'typesafe_json_invalid';
      wrapped.cause = error;
      throw wrapped;
    }
    if (!payload || typeof payload !== 'object' || !payload.answers || typeof payload.answers !== 'object') {
      const error = new Error('TypeSafe returned an invalid judgment response.');
      error.code = 'typesafe_response_invalid';
      throw error;
    }

    return {
      backend: 'typesafe',
      model: typeof payload.model === 'string' ? payload.model : 'jev-latest',
      answers: decodeAnswers(questions, payload.answers),
      usage: safeUsage(payload.usage),
      credentialSource: auth.source,
    };
  }

  return { judge };
}
