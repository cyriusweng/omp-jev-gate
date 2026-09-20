import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultConfig, loadConfig, updateConfig, validateConfig } from '../src/configuration.mjs';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'omp-jev-gate-'));
  return { directory, path: join(directory, 'jev-gate.json') };
}

test('missing configuration defaults to an opt-in-safe state', async t => {
  const item = await fixture();
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  assert.deepEqual(await loadConfig(item.path), { mode: 'off', fallback: 'continue' });
  assert.deepEqual(defaultConfig(), { mode: 'off', fallback: 'continue' });
});

test('configuration is persisted atomically with owner-only permissions', async t => {
  const item = await fixture();
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  const saved = await updateConfig({ mode: 'enforce', fallback: 'block' }, { path: item.path });
  assert.deepEqual(saved, { mode: 'enforce', fallback: 'block' });
  assert.deepEqual(JSON.parse(await readFile(item.path, 'utf8')), saved);
  assert.equal((await stat(item.path)).mode & 0o777, 0o600);
});

test('invalid configuration is rejected', async t => {
  const item = await fixture();
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  await writeFile(item.path, '{"mode":"always","fallback":"continue"}\n');
  await assert.rejects(loadConfig(item.path), /valid mode and fallback/);
  assert.throws(() => validateConfig({ mode: 'off', fallback: 'guess' }), /valid mode and fallback/);
});

test('stale writers are rejected', async t => {
  const item = await fixture();
  t.after(() => rm(item.directory, { recursive: true, force: true }));
  const original = await updateConfig({ mode: 'observe', fallback: 'continue' }, { path: item.path });
  await updateConfig({ mode: 'enforce', fallback: 'continue' }, { path: item.path });
  await assert.rejects(
    updateConfig({ mode: 'off', fallback: 'continue' }, { path: item.path, expectedConfig: original }),
    /changed in another session/,
  );
});
