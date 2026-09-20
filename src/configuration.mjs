import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.omp', 'agent');

export const CONFIG_PATH = process.env.OMP_JEV_GATE_CONFIG || join(agentDir, 'jev-gate.json');
export const MODES = new Set(['off', 'observe', 'enforce']);
export const FALLBACKS = new Set(['continue', 'block', 'jev']);

export function defaultConfig() {
  return { mode: 'off', fallback: 'continue' };
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
    !MODES.has(config.mode) || !FALLBACKS.has(config.fallback)) {
    throw new Error('Jev Gate configuration requires valid mode and fallback settings.');
  }
  return { mode: config.mode, fallback: config.fallback };
}

export async function loadConfig(path = CONFIG_PATH) {
  try {
    return validateConfig(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultConfig();
    throw error;
  }
}

async function saveConfig(config, path) {
  const validated = validateConfig(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, path);
  return validated;
}

export async function updateConfig(settings, { path = CONFIG_PATH, expectedConfig } = {}) {
  const current = await loadConfig(path);
  if (expectedConfig && JSON.stringify(current) !== JSON.stringify(expectedConfig)) {
    throw new Error('Jev Gate configuration changed in another session, please retry.');
  }
  return saveConfig(settings, path);
}
