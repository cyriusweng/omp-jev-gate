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

export function validProbability(value) {
 return Number.isFinite(value) && value >= 0 && value <= 1;
}

function invalidAnswer() {
 return Object.assign(new Error('TypeSafe returned an invalid judgment answer.'), {
  code: 'typesafe_answer_invalid',
 });
}

function encodeQuestion(question) {
 if (question.type === 'bool') return { ...question, type: 'noul' };
 if (question.type === 'score' && (!Array.isArray(question.criteria) ||
  question.criteria.length < 2 || question.criteria.length > 10)) {
  throw new Error('Score questions require 2 to 10 ordered levels.');
 }
 if (!['choice', 'score', 'noul'].includes(question.type)) {
  throw new Error('Use a choice, score or boolean question.');
 }
 return question;
}

export function validateAnswer(question, raw) {
 if (raw?.type !== question.type) throw invalidAnswer();
 if (question.type === 'bool' || question.type === 'noul') {
  if (!validProbability(raw[question.type])) throw invalidAnswer();
  return raw;
 }
 const labels = question.type === 'choice'
  ? Object.keys(question.criteria)
  : question.criteria.map((_, index) => String(index));
 const probabilities = raw.probabilities;
 if (!validProbability(raw.confidence) || !probabilities ||
  typeof probabilities !== 'object' || Array.isArray(probabilities) ||
  Object.keys(probabilities).length !== labels.length ||
  labels.some(label => !Object.hasOwn(probabilities, label) || !validProbability(probabilities[label]))) {
  throw invalidAnswer();
 }
 if (question.type === 'choice') {
  if (!labels.includes(raw.choice)) throw invalidAnswer();
 } else {
  if (!Number.isFinite(raw.score) || raw.score < 0 || raw.score > labels.length - 1) throw invalidAnswer();
 }
 return raw;
}

function encodeQuestions(questions) {
 return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, encodeQuestion(question)]));
}

function decodeAnswers(questions, answers) {
 return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
  const raw = answers[id];
  if (question.type === 'bool') {
   validateAnswer({ ...question, type: 'noul' }, raw);
   return [id, { type: 'bool', bool: raw.noul }];
  }
  return [id, validateAnswer(question, raw)];
 }));
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
  const encodedQuestions = encodeQuestions(questions);
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
    body: JSON.stringify({ model: 'jev-latest', state, questions: encodedQuestions }),
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
   signal?.throwIfAborted();
  } catch (error) {
   if (signal?.aborted) throw signal.reason ?? error;
   const wrapped = new Error('TypeSafe returned invalid JSON.');
   wrapped.code = 'typesafe_json_invalid';
   wrapped.cause = error;
   throw wrapped;
  }
  if (!payload || typeof payload !== 'object' || !payload.answers ||
   typeof payload.answers !== 'object' || Array.isArray(payload.answers)) {
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
