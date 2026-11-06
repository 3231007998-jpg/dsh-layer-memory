/**
 * Self-test for the Layer Memory plugin. Runs on plain Node (no Harness
 * runtime): exercises the store, the prompt digest, the JSON-Schema subset
 * accepted by the tool registry, the four tool definitions, and the
 * automatic memory extractor.
 *
 *   node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { apply as applyPlugin, createRelevanceListener } from '../index.js';
import { ATOMIC_MAX, splitAtomic } from '../lib/atomic.js';
import { rankEntries, tokenize } from '../lib/relevance.js';
import {
  SESSION_FILE_SUFFIX,
  buildTranscript,
  chunkIntoHandoffEntries,
  decodeSessionBuffer,
  describeLlm,
  extractSessionMemories,
  extractiveHandoffEntries,
  extractiveSummary,
  findSessionFile,
  importSessionCandidates,
  listSessions,
  llmSummary,
  parseHandoffEntries,
  readSessionMessages,
  resolveDefaultModel,
  summarizeSession,
} from '../lib/sessions.js';
import { collectCandidates, extractCandidates, extractMessageText } from '../lib/autocapture.js';
import { DASHBOARD_ROUTE_PATH, autoCaptureEnabled, buildDashboardState } from '../lib/dashboard.js';
import {
  DEFAULT_LAYER,
  DEFAULTS,
  LAYERS,
  LayerMemoryStore,
  entryToJson,
  entryWeight,
  isExpired,
  normalizeLayer,
  normalizeTags,
  parseTtl,
  renderDigest,
  resolveDataRoot,
} from '../lib/store.js';
import { createMemoryTools } from '../lib/tools.js';

const tempRoots = [];
function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `layer-memory-${label}-`));
  tempRoots.push(root);
  return root;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`FAIL ${name}\n     ${error instanceof Error ? error.stack?.split('\n').slice(0, 4).join('\n     ') : String(error)}\n`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal stand-in for the Cordis context used by `apply`. It records the
 * event listeners the plugin registers so tests can fire `agent/pre-step`
 * payloads directly.
 */
function createFakeCtx() {
  const listeners = new Map();
  const remember = (event, listener) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
    return () => {
      const current = listeners.get(event) ?? [];
      const remaining = current.filter((item) => item !== listener);
      if (remaining.length > 0) listeners.set(event, remaining);
      else listeners.delete(event);
    };
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on(event, listener) {
      return remember(event, listener);
    },
    effect(fn) {
      return fn();
    },
    inject(services, callback) {
      return callback(ctx);
    },
    get() {
      return undefined;
    },
    tools: {
      register() {
        return () => {};
      },
    },
  };
  // `getListener` returns the first registered listener for an event (the
  // auto-capture one for `agent/pre-step`); `listeners` keeps every registration.
  const getListener = (event) => (listeners.get(event) ?? [])[0];
  const allListeners = (event) => listeners.get(event) ?? [];
  return { ctx, listeners, getListener, allListeners };
}

async function withMemoryEnv(dir, auto, fn) {
  const previousDir = process.env.DSH_LAYER_MEMORY_DIR;
  const previousAuto = process.env.DSH_LAYER_MEMORY_AUTO;
  if (dir === undefined) delete process.env.DSH_LAYER_MEMORY_DIR;
  else process.env.DSH_LAYER_MEMORY_DIR = dir;
  if (auto === undefined) delete process.env.DSH_LAYER_MEMORY_AUTO;
  else process.env.DSH_LAYER_MEMORY_AUTO = auto;
  try {
    return await fn();
  } finally {
    if (previousDir === undefined) delete process.env.DSH_LAYER_MEMORY_DIR;
    else process.env.DSH_LAYER_MEMORY_DIR = previousDir;
    if (previousAuto === undefined) delete process.env.DSH_LAYER_MEMORY_AUTO;
    else process.env.DSH_LAYER_MEMORY_AUTO = previousAuto;
  }
}

// ---------------------------------------------------------------------------
// JSON-Schema subset the Harness tool registry accepts.
// ---------------------------------------------------------------------------
const ALLOWED_KEYWORDS = new Set([
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'description',
  'title',
  'default',
  'examples',
]);
const ALLOWED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function validateSchema(node, at, errors) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    errors.push(`${at}: must be a schema object`);
    return;
  }
  for (const keyword of Object.keys(node)) {
    if (!ALLOWED_KEYWORDS.has(keyword)) errors.push(`${at}: unsupported keyword "${keyword}"`);
  }
  if ('type' in node) {
    if (typeof node.type !== 'string') errors.push(`${at}.type: must be a single string`);
    else if (!ALLOWED_TYPES.has(node.type)) errors.push(`${at}.type: unsupported type "${node.type}"`);
  }
  if ('properties' in node) {
    if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      errors.push(`${at}.properties: must be an object map`);
    } else {
      for (const [name, schema] of Object.entries(node.properties)) {
        validateSchema(schema, `${at}.properties.${name}`, errors);
      }
    }
  }
  if ('items' in node) validateSchema(node.items, `${at}.items`, errors);
  if ('oneOf' in node) {
    if (!Array.isArray(node.oneOf) || node.oneOf.length === 0) errors.push(`${at}.oneOf: must be a non-empty array`);
    else node.oneOf.forEach((branch, index) => validateSchema(branch, `${at}.oneOf[${index}]`, errors));
  }
  if ('required' in node) {
    if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
      errors.push(`${at}.required: must be an array of strings`);
    }
  }
  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    errors.push(`${at}.additionalProperties: only booleans are supported`);
  }
}

// ---------------------------------------------------------------------------
// Store behaviours.
// ---------------------------------------------------------------------------
await test('resolveDataRoot honours env override and DSH_HOME', () => {
  const override = resolveDataRoot({ DSH_LAYER_MEMORY_DIR: '  C:\\custom-memory  ' });
  assert.equal(override, path.resolve('C:\\custom-memory'));
  const fromHome = resolveDataRoot({ DSH_LAYER_MEMORY_DIR: '', DSH_HOME: 'C:\\fake-home' });
  assert.equal(fromHome, path.join(path.resolve('C:\\fake-home'), 'layer-memory'));
});

await test('normalizeLayer / normalizeTags validate and de-duplicate', () => {
  assert.equal(normalizeLayer(' PERSONA '), 'persona');
  assert.equal(normalizeLayer(undefined), DEFAULT_LAYER);
  assert.throws(() => normalizeLayer('short-term'), /type must be one of/);
  assert.deepEqual(normalizeTags([' A ', 'a', 'B', '']), ['a', 'b']);
  assert.throws(() => normalizeTags('a'), /array of strings/);
});

await test('store upserts by (layer, key) and layers coexist', async () => {
  const store = new LayerMemoryStore({ dataRoot: tempRoot('upsert') });
  const first = await store.store({ key: 'user-name', value: 'Alice', type: 'persona', tags: ['profile'] });
  assert.equal(first.entry.type, 'persona');
  assert.equal(first.archived.length, 0);

  const second = await store.store({ key: 'user-name', value: 'Alice Wang', type: 'persona', tags: ['default', 'profile'] });
  assert.equal(second.entry.value, 'Alice Wang');
  assert.deepEqual(second.entry.tags, ['profile', 'default']);
  assert.equal(second.entry.createdAt, first.entry.createdAt);
  assert.ok(second.entry.updatedAt >= first.entry.updatedAt);

  await store.store({ key: 'user-name', value: 'Alice (fact record)', type: 'fact' });
  assert.equal(store.snapshot().counts.persona, 1);
  assert.equal(store.snapshot().counts.fact, 1);

  const reloaded = new LayerMemoryStore({ dataRoot: store.dataRoot }).loadSync();
  assert.equal(reloaded.totalEntries(), 2);
  assert.equal(reloaded.entries('persona')[0].value, 'Alice Wang');
});

await test('recall filters terms, layers, tags, limit and bumps hits', async () => {
  const root = tempRoot('recall');
  const store = new LayerMemoryStore({ dataRoot: root });
  await store.store({ key: 'user-name', value: 'Alice Wang', type: 'persona', tags: ['profile'] });
  await store.store({ key: 'project-stack', value: 'DeepSeek Harness plugin built with Cordis', type: 'fact', tags: ['project', 'tech'] });
  await store.store({ key: 'scratch', value: 'try Cordis effect cleanup', type: 'working' });

  const byValue = await store.recall({ query: 'alice' });
  assert.deepEqual(byValue.entries.map((entry) => entry.key), ['user-name']);

  const byType = await store.recall({ query: 'cordis', type: 'fact' });
  assert.deepEqual(byType.entries.map((entry) => entry.key), ['project-stack']);
  assert.equal(byType.entries[0].hits, 1);

  const byTags = await store.recall({ tags: ['project'] });
  assert.deepEqual(byTags.entries.map((entry) => entry.key), ['project-stack']);

  const none = await store.recall({ query: 'alice cordis' });
  assert.equal(none.entries.length, 0);

  const limited = await store.recall({ limit: 1 });
  assert.equal(limited.entries.length, 1);
  assert.equal(limited.total, 3);

  await assert.rejects(() => store.recall({ limit: 51 }), /at most 50/);

  const reloaded = new LayerMemoryStore({ dataRoot: root }).loadSync();
  assert.ok(reloaded.entries('fact')[0].hits >= 2);
});

await test('working overflow archives the oldest entry into fact', async () => {
  const root = tempRoot('evict');
  const store = new LayerMemoryStore({ dataRoot: root, workingCap: 2 });
  await store.store({ key: 'first', value: 'remember me', type: 'working' });
  await sleep(5);
  await store.store({ key: 'second', value: 'keep me', type: 'working' });
  await sleep(5);
  await store.store({ key: 'third', value: 'newest', type: 'working' });

  const snapshot = store.snapshot();
  assert.equal(snapshot.counts.working, 2);
  assert.equal(snapshot.counts.fact, 1);
  assert.deepEqual(store.entries('fact').map((entry) => entry.key), ['first']);

  const reloaded = new LayerMemoryStore({ dataRoot: root }).loadSync();
  assert.deepEqual(reloaded.entries('fact').map((entry) => entry.key), ['first']);
});

await test('export produces Markdown that a fresh store can import back', async () => {
  const root = tempRoot('export');
  const store = new LayerMemoryStore({ dataRoot: root });
  await store.store({ key: 'bio', value: 'line one\nline two', type: 'persona', tags: ['profile'] });
  await store.store({ key: 'decision', value: 'use Cordis', type: 'fact', tags: ['project'] });
  await store.store({ key: 'note', value: 'temporary', type: 'working' });

  const exported = await store.exportTo({});
  assert.ok(exported.path.startsWith(path.join(root, 'exports')));
  const text = fs.readFileSync(exported.path, 'utf8');
  assert.ok(text.includes('<!-- layer-memory:entry -->'));
  assert.ok(text.includes('line one\nline two'));

  const targetRoot = tempRoot('import');
  const target = new LayerMemoryStore({ dataRoot: targetRoot }).loadSync();
  const imported = await target.importFrom({ inputPath: exported.path });
  assert.equal(imported.imported, 3);
  assert.equal(imported.skipped, 0);
  assert.equal(target.totalEntries(), 3);
  assert.equal(target.entries('persona')[0].value, 'line one\nline two');
  assert.deepEqual(target.entries('fact')[0].tags, ['project']);
  assert.equal(new LayerMemoryStore({ dataRoot: targetRoot }).loadSync().totalEntries(), 3);
});

await test('import replace clears layers, merge keeps them', async () => {
  const sourceRoot = tempRoot('replace-source');
  const source = new LayerMemoryStore({ dataRoot: sourceRoot });
  await source.store({ key: 'kept', value: 'from export', type: 'fact' });
  const exported = await source.exportTo({ outputPath: path.join(sourceRoot, 'export.md') });

  const targetRoot = tempRoot('replace-target');
  const target = new LayerMemoryStore({ dataRoot: targetRoot });
  await target.store({ key: 'old', value: 'should disappear', type: 'persona' });
  const replaced = await target.importFrom({ inputPath: exported.path, mode: 'replace' });
  assert.equal(replaced.mode, 'replace');
  assert.equal(replaced.imported, 1);
  assert.deepEqual(target.entries('persona'), []);
  assert.deepEqual(target.entries('fact').map((entry) => entry.key), ['kept']);
});

await test('import reads JSON arrays and JSONL files', async () => {
  const root = tempRoot('import-formats');
  const store = new LayerMemoryStore({ dataRoot: root });
  const jsonPath = path.join(root, 'entries.json');
  fs.writeFileSync(
    jsonPath,
    JSON.stringify([
      { key: 'json-a', value: 'from json array', type: 'fact' },
      { key: 'json-b', value: 'also json', type: 'persona', tags: ['import'] },
    ]),
    'utf8',
  );
  const jsonResult = await store.importFrom({ inputPath: jsonPath });
  assert.equal(jsonResult.imported, 2);

  const jsonlPath = path.join(root, 'entries.jsonl');
  fs.writeFileSync(
    jsonlPath,
    `${JSON.stringify({ key: 'line-a', value: 'from jsonl', type: 'fact' })}\n${JSON.stringify({ key: 'line-b', value: 'second line', type: 'working' })}\n`,
    'utf8',
  );
  const jsonlResult = await store.importFrom({ inputPath: jsonlPath });
  assert.equal(jsonlResult.imported, 2);
  assert.equal(store.totalEntries(), 4);
});

await test('corrupt JSONL lines are warned about, not fatal', async () => {
  const root = tempRoot('corrupt');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'fact.jsonl'),
    `${JSON.stringify({ key: 'good', value: 'valid', type: 'fact', tags: [] })}\nthis is not json\n`,
    'utf8',
  );
  const store = new LayerMemoryStore({ dataRoot: root }).loadSync();
  assert.equal(store.totalEntries(), 1);
  assert.ok(store.warnings.length >= 1);
  assert.match(store.warnings[0], /fact\.jsonl line 2/);
});

await test('renderDigest is budgeted, ordered persona-first, and empty when empty', async () => {
  const empty = new LayerMemoryStore({ dataRoot: tempRoot('digest-empty') });
  assert.equal(renderDigest(empty), '');

  const store = new LayerMemoryStore({ dataRoot: tempRoot('digest') });
  await store.store({ key: 'pref-style', value: 'prefers concise Chinese answers with code blocks', type: 'persona', tags: ['profile'] });
  await store.store({ key: 'project', value: 'a DeepSeek Harness layered memory plugin', type: 'fact', tags: ['project'] });
  await store.store({ key: 'scratch', value: 'current task is self-test', type: 'working' });

  const digest = renderDigest(store, { budget: 300 });
  assert.ok(digest.startsWith('Layer memory'));
  assert.ok(digest.includes('<layer-memory>'));
  assert.ok(digest.trimEnd().endsWith('</layer-memory>'));
  assert.ok(digest.length <= 300, `digest length ${digest.length} exceeds budget 300`);

  const wide = renderDigest(store, { budget: 1000 });
  assert.ok(wide.length > digest.length);
  for (const label of ['[persona]', '[working]', '[fact]']) {
    assert.ok(wide.includes(label), `wide digest misses ${label}`);
  }
  assert.ok(wide.indexOf('[persona]') < wide.indexOf('[working]'));
  assert.ok(wide.indexOf('[working]') < wide.indexOf('[fact]'));
  assert.equal(entryToJson(store.entries('persona')[0]).id, 'persona:pref-style');
});

// ---------------------------------------------------------------------------
// Settings dashboard projection.
// ---------------------------------------------------------------------------
await test('dashboard state projects layers newest-first with digest and counts', async () => {
  const root = tempRoot('dashboard');
  const store = new LayerMemoryStore({ dataRoot: root });
  await store.store({ key: 'old-note', value: 'older scratch', type: 'working' });
  await sleep(5);
  await store.store({ key: 'new-note', value: 'newer scratch', type: 'working' });
  await store.store({ key: 'pref', value: 'likes concise answers', type: 'persona' });
  await store.store({ key: 'decision', value: 'use Cordis', type: 'fact' });

  const state = buildDashboardState(store, { env: {} });
  assert.equal(state.ok, true);
  assert.equal(DASHBOARD_ROUTE_PATH, '/layer-memory/api/state');
  assert.equal(state.total, 4);
  assert.deepEqual(state.counts, { working: 2, persona: 1, fact: 1, retro: 0 });
  assert.deepEqual(state.layers.working.map((entry) => entry.key), ['new-note', 'old-note']);
  assert.deepEqual(state.layers.persona.map((entry) => entry.key), ['pref']);
  assert.ok(state.chars > 0);
  assert.match(state.digest, /<layer-memory>/);
  assert.equal(state.autoCapture, true);
  assert.equal(state.dataRoot, root);
  assert.match(state.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

await test('dashboard autoCapture follows DSH_LAYER_MEMORY_AUTO', () => {
  assert.equal(autoCaptureEnabled({}), true);
  assert.equal(autoCaptureEnabled({ DSH_LAYER_MEMORY_AUTO: '0' }), false);
  assert.equal(autoCaptureEnabled({ DSH_LAYER_MEMORY_AUTO: 'OFF' }), false);
  assert.equal(autoCaptureEnabled({ DSH_LAYER_MEMORY_AUTO: 'yes' }), true);
});

// ---------------------------------------------------------------------------
// Tool definitions.
// ---------------------------------------------------------------------------
await test('all tool schemas stay inside the accepted JSON-Schema subset', () => {
  const root = tempRoot('schema');
  const tools = createMemoryTools(new LayerMemoryStore({ dataRoot: root }));
  assert.deepEqual(tools.map((tool) => tool.name), ['memory_store', 'memory_recall', 'memory_export', 'memory_import', 'memory_retro']);
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string');
    const errors = [];
    validateSchema(tool.parameters, `${tool.name}.parameters`, errors);
    validateSchema(tool.output.schema, `${tool.name}.output.schema`, errors);
    assert.deepEqual(errors, []);
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
  }
});

await test('tools execute end-to-end and render text blocks', async () => {
  const root = tempRoot('tools');
  const store = new LayerMemoryStore({ dataRoot: root });
  const tools = Object.fromEntries(createMemoryTools(store).map((tool) => [tool.name, tool]));

  const stored = await tools.memory_store.execute({ key: 'fav-color', value: 'blue', type: 'persona', tags: ['prefs'] });
  assert.match(stored, /Stored entry "fav-color" in the persona layer/);
  assert.deepEqual(tools.memory_store.output.render({}, stored), [{ type: 'text', text: stored }]);

  const archived = await tools.memory_store.execute({ key: 'temp', value: 'scratch', type: 'working' });
  assert.match(archived, /working layer/);

  const recalled = await tools.memory_recall.execute({ query: 'blue' });
  assert.match(recalled, /fav-color/);
  assert.match(recalled, /\[persona\]/);

  const missing = await tools.memory_recall.execute({ query: 'nothing-here' });
  assert.match(missing, /No memory entries found/);

  const exported = await tools.memory_export.execute({});
  const exportPath = /to "(.+?)"/.exec(exported)?.[1];
  assert.ok(exportPath && fs.existsSync(exportPath));

  const imported = await tools.memory_import.execute({ inputPath: exportPath, mode: 'merge' });
  assert.match(imported, /Imported 2 entries/);

  await assert.rejects(() => tools.memory_store.execute({ value: 'missing key' }), /key must be a string/);
  await assert.rejects(() => tools.memory_store.execute({ key: 'x', value: 'y', type: 'unknown' }), /type must be one of/);
  await assert.rejects(() => tools.memory_import.execute({ inputPath: '' }), /non-empty/);
});

// ---------------------------------------------------------------------------
// Retrospectives.
// ---------------------------------------------------------------------------
await test('retrospectives are recorded, listed and excluded from the prompt digest', async () => {
  const root = tempRoot('retro');
  const store = new LayerMemoryStore({ dataRoot: root });
  const tools = Object.fromEntries(createMemoryTools(store).map((tool) => [tool.name, tool]));

  const recorded = await tools.memory_retro.execute({
    action: 'record',
    title: 'waterfall crash',
    symptom: 'turn failed: Cannot read properties of undefined (reading kind)',
    rootCause: 'pre-step listener returned undefined instead of calling next()',
    fix: 'return next() from the waterfall listener',
    lesson: 'waterfall listeners must return next()',
    prevention: 'regression test asserts the decision is passed through',
    timeCost: '30m + 2 restarts',
  });
  assert.match(recorded, /Recorded retrospective "waterfall crash"/);
  assert.match(recorded, /excluded from the automatic digest/);

  const stored = store.entries('fact');
  assert.equal(stored.length, 1);
  assert.ok(stored[0].tags.includes('retro'));
  assert.match(stored[0].value, /根因：pre-step listener/);

  assert.doesNotMatch(renderDigest(store), /waterfall crash|【复盘】/);

  const recalled = await tools.memory_recall.execute({ query: 'waterfall' });
  assert.match(recalled, /waterfall crash/);

  const listed = await tools.memory_retro.execute({ action: 'list' });
  assert.match(listed, /Found 1 retrospective/);
  assert.match(listed, /waterfall crash/);
  assert.match(listed, /根因：/);

  const state = buildDashboardState(store);
  assert.equal(state.counts.retro, 1);
  assert.equal(state.retros.length, 1);
  assert.equal(state.retros[0].title, 'waterfall crash');
  assert.match(state.retros[0].rootCause, /pre-step listener/);

  await assert.rejects(
    () => tools.memory_retro.execute({ action: 'record', title: 'empty' }),
    /at least one of symptom/,
  );
  await assert.rejects(() => tools.memory_retro.execute({ action: 'bogus' }), /action must be one of/);
});

// ---------------------------------------------------------------------------
// Automatic memory extraction.
// ---------------------------------------------------------------------------
await test('auto capture extracts explicit remember statements into facts', () => {
  const chinese = extractCandidates('记住：项目部署在 3000 端口。其他都不重要。');
  assert.equal(chinese.length, 1);
  assert.equal(chinese[0].type, 'fact');
  assert.match(chinese[0].value, /项目部署在 3000 端口/);
  assert.ok(chinese[0].tags.includes('auto'));
  assert.match(chinese[0].key, /^auto-[0-9a-f]{10}$/);

  const english = extractCandidates('Remember that the deploy key is in .env.local.');
  assert.equal(english.length, 1);
  assert.equal(english[0].type, 'fact');
  assert.match(english[0].value, /deploy key/);
});

await test('auto capture extracts persona preferences and self-descriptions', () => {
  const name = extractCandidates('我叫小林');
  assert.equal(name.length, 1);
  assert.equal(name[0].type, 'persona');

  const style = extractCandidates('以后都用中文回答');
  assert.equal(style.length, 1);
  assert.equal(style[0].type, 'persona');

  // A bare language instruction is a preference too, even without 请/以后.
  const bare = extractCandidates('用中文回答');
  assert.equal(bare.length, 1);
  assert.equal(bare[0].type, 'persona');
  assert.equal(bare[0].value, '用中文回答');
  assert.equal(extractCandidates('用英文回答').length, 1);

  const rememberPreference = extractCandidates('请记住我偏好简洁的 TypeScript 回答');
  assert.equal(rememberPreference.length, 1);
  assert.equal(rememberPreference[0].type, 'persona');
  assert.match(rememberPreference[0].value, /偏好简洁/);
});

await test('auto capture ignores questions, chatter and duplicate sentences', () => {
  assert.equal(extractCandidates('你记住了吗？').length, 0);
  assert.equal(extractCandidates('今天天气不错，我们去吃饭吧。').length, 0);
  assert.equal(extractCandidates('我该不该用中文回答？').length, 0);

  const duplicated = extractCandidates('记住：部署在 3000 端口。记住：部署在 3000 端口。');
  assert.equal(duplicated.length, 1);

  assert.equal(extractMessageText({ role: 'user', content: [{ type: 'text', text: '记住：A' }] }), '记住：A');
  assert.equal(extractMessageText({ role: 'user', text: '记住：B' }), '记住：B');
  const fromPayload = collectCandidates({
    messages: [
      { role: 'user', content: '记住：项目代号 C' },
      { role: 'assistant', content: '记住：项目代号 D' },
      { role: 'user', content: 'x'.repeat(5000) + '记住：项目代号 E' },
    ],
  });
  assert.equal(fromPayload.length, 1);
  assert.match(fromPayload[0].value, /项目代号 C/);
});

await test('apply wires auto capture into agent/pre-step and stores entries', async () => {
  const root = tempRoot('auto-apply');
  await withMemoryEnv(root, undefined, async () => {
    const { ctx, getListener } = createFakeCtx();
    applyPlugin(ctx);
    const listener = getListener('agent/pre-step');
    assert.equal(typeof listener, 'function');
    assert.equal(listener, getListener('agent/pre-step'), 'auto capture listener must be stable');

    const decision = { kind: 'enter', messages: [] };
    let nextCalls = 0;
    const result = listener(
      { messages: [{ role: 'user', content: '记住：上线前跑通 selftest。以后都用中文回答。' }], turn: 1, step: 1 },
      async () => {
        nextCalls += 1;
        return decision;
      },
    );
    assert.equal(await result, decision, 'the waterfall decision must be passed through');
    assert.equal(nextCalls, 1, 'the pre-step listener must call next() exactly once');
    await sleep(150);

    const store = new LayerMemoryStore({ dataRoot: root }).loadSync();
    assert.ok(store.entries('fact').some((entry) => entry.value.includes('selftest')));
    assert.ok(store.entries('persona').some((entry) => entry.value.includes('中文')));
    assert.ok(store.entries('fact')[0].tags.includes('auto'));
  });
});

await test('pre-step listener still delegates to next() when capture throws', async () => {
  const root = tempRoot('auto-next-error');
  await withMemoryEnv(root, undefined, async () => {
    const { ctx, getListener } = createFakeCtx();
    applyPlugin(ctx);
    const listener = getListener('agent/pre-step');
    const payload = {};
    Object.defineProperty(payload, 'messages', {
      get() {
        throw new Error('boom');
      },
    });
    const decision = { kind: 'enter', messages: [] };
    const result = await listener(payload, async () => decision);
    assert.equal(result, decision, 'capture failures must not break the waterfall');
  });
});

await test('DSH_LAYER_MEMORY_AUTO=0 disables the auto capture listener', async () => {
  const root = tempRoot('auto-off');
  const previousGate = process.env.DSH_LAYER_MEMORY_RECALL_GATE;
  process.env.DSH_LAYER_MEMORY_RECALL_GATE = '0';
  try {
    await withMemoryEnv(root, '0', () => {
      const { ctx, getListener } = createFakeCtx();
      applyPlugin(ctx);
      assert.equal(getListener('agent/pre-step'), undefined);
    });
  } finally {
    if (previousGate === undefined) delete process.env.DSH_LAYER_MEMORY_RECALL_GATE;
    else process.env.DSH_LAYER_MEMORY_RECALL_GATE = previousGate;
  }
});

await test('store snapshot exposes data root and counts', () => {
  const store = new LayerMemoryStore({ dataRoot: tempRoot('snapshot') });
  const snapshot = store.snapshot();
  assert.equal(snapshot.total, 0);
  assert.deepEqual(snapshot.counts, { working: 0, persona: 0, fact: 0 });
  assert.ok(snapshot.dataRoot.length > 0);
  assert.deepEqual(LAYERS, ['working', 'persona', 'fact']);
  assert.equal(DEFAULTS.recallLimit, 5);
});

await test('apply registers the management API and serves dashboard JSON', async () => {
  const root = tempRoot('dashboard-route');
  await withMemoryEnv(root, undefined, async () => {
    const seeded = new LayerMemoryStore({ dataRoot: root });
    await seeded.store({ key: 'route-check', value: 'served over http', type: 'fact' });

    const routes = new Map();
    const ctx = {
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      on() {
        return () => {};
      },
      effect(fn) {
        return fn();
      },
      inject(services, callback) {
        assert.ok(Array.isArray(services) && services.includes('webServer'));
        callback(ctx);
      },
      tools: {
        register() {
          return () => {};
        },
      },
      get(service) {
        if (service === 'webServer') {
          return {
            register(spec) {
              routes.set(spec.path, spec);
              return () => {};
            },
          };
        }
        return undefined;
      },
    };
    applyPlugin(ctx);

    assert.equal(routes.size, 8, 'expected eight management routes');
    for (const spec of routes.values()) {
      assert.equal(spec.kind, 'exact');
    }
    assert.deepEqual([...routes.keys()].sort(), [
      '/layer-memory/api/entry',
      '/layer-memory/api/maintenance',
      '/layer-memory/api/sessions',
      '/layer-memory/api/sessions/extract',
      '/layer-memory/api/sessions/import',
      '/layer-memory/api/sessions/summarize',
      '/layer-memory/api/settings',
      '/layer-memory/api/state',
    ]);

    const call = (routePath, method, url, body) =>
      new Promise((resolve, reject) => {
        const route = routes.get(routePath);
        assert.ok(route, `route ${routePath} was not registered`);
        const res = {
          statusCode: 0,
          headers: {},
          body: '',
          writeHead(code, headers) {
            this.statusCode = code;
            this.headers = headers ?? {};
          },
          end(payload) {
            this.body = payload === undefined ? '' : String(payload);
            resolve(res);
          },
        };
        const req = {
          method,
          url,
          on(event, handler) {
            if (event === 'data' && body !== undefined) handler(Buffer.from(JSON.stringify(body)));
            if (event === 'end') handler();
            return req;
          },
          destroy() {},
        };
        try {
          route.handler(req, res);
        } catch (error) {
          reject(error);
        }
      });

    const ok = await call('/layer-memory/api/state', 'GET', '/layer-memory/api/state');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['cache-control'], 'no-store');
    const payload = JSON.parse(ok.body);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.layers.fact.map((entry) => entry.key), ['route-check']);

    const head = await call('/layer-memory/api/state', 'HEAD', '/layer-memory/api/state');
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, '');

    const created = await call('/layer-memory/api/entry', 'POST', '/layer-memory/api/entry', {
      op: 'store',
      key: 'via-api',
      value: 'created over the settings API',
      type: 'fact',
      ttl: '7d',
    });
    assert.equal(created.statusCode, 200);
    const createdPayload = JSON.parse(created.body);
    assert.equal(createdPayload.ok, true);
    assert.deepEqual(createdPayload.state.layers.fact.map((entry) => entry.key).sort(), [
      'route-check',
      'via-api',
    ]);
    assert.ok(createdPayload.state.layers.fact.every((entry) => typeof entry.weight === 'number'));

    const scenario = await call('/layer-memory/api/settings', 'POST', '/layer-memory/api/settings', {
      activeScopes: ['coding'],
    });
    assert.equal(scenario.statusCode, 200);
    assert.deepEqual(JSON.parse(scenario.body).settings.activeScopes, ['coding']);

    const budget = await call('/layer-memory/api/settings', 'POST', '/layer-memory/api/settings', {
      digestBudget: 1800,
    });
    assert.equal(budget.statusCode, 200);
    assert.equal(JSON.parse(budget.body).settings.digestBudget, 1800);
    assert.equal(JSON.parse(budget.body).state.settings.digestBudget, 1800);

    const maintenance = await call('/layer-memory/api/maintenance', 'POST', '/layer-memory/api/maintenance', {});
    assert.equal(maintenance.statusCode, 200);
    assert.equal(typeof JSON.parse(maintenance.body).report.expired, 'number');

    const sessionsRoot = tempRoot('api-sessions');
    fs.mkdirSync(sessionsRoot, { recursive: true });
    writeFakeSession(sessionsRoot, 'session-api-test', ['记住：API 导入的代号是 Borealis']);
    const previousSessionsRoot = process.env.DSH_LAYER_MEMORY_SESSIONS_DIR;
    process.env.DSH_LAYER_MEMORY_SESSIONS_DIR = sessionsRoot;
    try {
      const listed = await call('/layer-memory/api/sessions', 'GET', '/layer-memory/api/sessions');
      assert.equal(listed.statusCode, 200);
      assert.equal(JSON.parse(listed.body).sessions.length, 1);
      assert.equal(JSON.parse(listed.body).llm.available, false);

      const extracted = await call('/layer-memory/api/sessions/extract', 'POST', '/layer-memory/api/sessions/extract', {
        sessionId: 'session-api-test',
      });
      assert.equal(extracted.statusCode, 200);
      const extractedPayload = JSON.parse(extracted.body);
      assert.ok(extractedPayload.candidates.length >= 1);

      const imported = await call('/layer-memory/api/sessions/import', 'POST', '/layer-memory/api/sessions/import', {
        entries: extractedPayload.candidates,
      });
      assert.equal(imported.statusCode, 200);
      assert.ok(JSON.parse(imported.body).imported >= 1);

      const summarized = await call('/layer-memory/api/sessions/summarize', 'POST', '/layer-memory/api/sessions/summarize', {
        sessionId: 'session-api-test',
      });
      assert.equal(summarized.statusCode, 200);
      const summarizedPayload = JSON.parse(summarized.body);
      assert.equal(summarizedPayload.ok, true);
      assert.equal(summarizedPayload.mode, 'extractive');
      assert.ok(summarizedPayload.summary.text.includes('测试对话'));
      assert.ok(summarizedPayload.candidate.key.startsWith('summary-'));
      assert.equal(summarizedPayload.candidate.type, 'fact');

      const llmAttempt = await call('/layer-memory/api/sessions/summarize', 'POST', '/layer-memory/api/sessions/summarize', {
        sessionId: 'session-api-test',
        mode: 'llm',
      });
      assert.equal(llmAttempt.statusCode, 200);
      const llmFallbackPayload = JSON.parse(llmAttempt.body);
      assert.equal(llmFallbackPayload.ok, true);
      assert.equal(llmFallbackPayload.mode, 'extractive');
      assert.equal(llmFallbackPayload.fallback, 'extractive');
      assert.equal(typeof llmFallbackPayload.warning, 'string');
      assert.ok(llmFallbackPayload.warning.length > 0);
      assert.ok(llmFallbackPayload.summary.text.includes('测试对话'));

      const progressSummary = await call('/layer-memory/api/sessions/summarize', 'POST', '/layer-memory/api/sessions/summarize', {
        sessionId: 'session-api-test',
        mode: 'extractive',
        kind: 'progress',
      });
      assert.equal(progressSummary.statusCode, 200);
      const progressPayload = JSON.parse(progressSummary.body);
      assert.equal(progressPayload.kind, 'progress');
      assert.ok(progressPayload.summary.text.includes('工作进度摘要'));
      assert.ok(progressPayload.candidate.key.startsWith('progress-'));
      assert.ok(progressPayload.candidate.tags.includes('progress'));

      writeFakeSession(
        sessionsRoot,
        'session-handoff-test',
        ['请把示例项目申请书改成多目标题目并准备答辩', '还缺 18 天数据需要补齐'],
        [
          {
            type: 'todo/write',
            seq: 60,
            time: Date.now(),
            data: {
              todos: [
                { content: '改申请书', status: 'completed' },
                { content: '补数据缺口', status: 'pending' },
              ],
            },
          },
          {
            type: 'tool/call',
            seq: 61,
            time: Date.now(),
            data: {
              turn: 1,
              step: 1,
              callId: 'call-handoff-api',
              name: 'write',
              arguments: JSON.stringify({ file_path: 'C:\\proj\\handoff\\大纲.md' }),
            },
          },
        ],
      );
      const handoffSummary = await call(
        '/layer-memory/api/sessions/summarize',
        'POST',
        '/layer-memory/api/sessions/summarize',
        { sessionId: 'session-handoff-test', mode: 'extractive', kind: 'handoff' },
      );
      assert.equal(handoffSummary.statusCode, 200);
      const handoffPayload = JSON.parse(handoffSummary.body);
      assert.equal(handoffPayload.kind, 'handoff');
      assert.ok(Array.isArray(handoffPayload.candidates));
      assert.ok(handoffPayload.candidates.length >= 3);
      assert.ok(handoffPayload.candidates.every((entry) => entry.value.length <= 180));
      assert.ok(handoffPayload.candidates.every((entry) => entry.tags.includes('handoff')));

      const handoffLlmFallback = await call(
        '/layer-memory/api/sessions/summarize',
        'POST',
        '/layer-memory/api/sessions/summarize',
        { sessionId: 'session-handoff-test', mode: 'llm', kind: 'handoff' },
      );
      assert.equal(handoffLlmFallback.statusCode, 200);
      const handoffLlmPayload = JSON.parse(handoffLlmFallback.body);
      assert.equal(handoffLlmPayload.fallback, 'extractive');
      assert.equal(typeof handoffLlmPayload.warning, 'string');
      assert.ok(Array.isArray(handoffLlmPayload.candidates));
      assert.ok(handoffLlmPayload.candidates.length >= 3);
      assert.ok(handoffLlmPayload.candidates.every((entry) => entry.key.startsWith('handoff-')));
      assert.ok(handoffLlmPayload.candidates.every((entry) => !entry.value.startsWith('[')));

      const missingSession = await call(
        '/layer-memory/api/sessions/extract',
        'POST',
        '/layer-memory/api/sessions/extract',
        { sessionId: 'session-does-not-exist' },
      );
      assert.equal(missingSession.statusCode, 404);
    } finally {
      if (previousSessionsRoot === undefined) delete process.env.DSH_LAYER_MEMORY_SESSIONS_DIR;
      else process.env.DSH_LAYER_MEMORY_SESSIONS_DIR = previousSessionsRoot;
    }

    const missing = await call('/layer-memory/api/state', 'GET', '/layer-memory/api/nope');
    assert.equal(missing.statusCode, 404);

    const notAllowed = await call('/layer-memory/api/state', 'PUT', '/layer-memory/api/state');
    assert.equal(notAllowed.statusCode, 405);
  });
});

// ---------------------------------------------------------------------------
// v1.4: importing memories from other conversation logs.
// ---------------------------------------------------------------------------

function writeFakeSession(sessionsRoot, sessionId, messages, extraEvents = []) {
  const workspaceDir = path.join(sessionsRoot, 'workspace-test');
  const sessionDir = path.join(workspaceDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const events = [
    {
      type: 'session',
      version: 4,
      id: sessionId,
      createdAt: Date.now(),
      cwd: 'C:\\tmp',
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: 'standard',
    },
    ...messages.map((message, index) => ({
      type: 'user/message',
      seq: index + 2,
      time: Date.now(),
      data: {
        content: [{ type: 'text', text: typeof message === 'string' ? message : message.text }],
        source: { kind: typeof message === 'string' ? 'user' : (message.kind ?? 'user') },
      },
    })),
    ...extraEvents,
    { type: 'session/title', seq: 50, time: Date.now(), data: { title: '测试对话' } },
  ];
  const body = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const filePath = path.join(sessionDir, `session.v4${SESSION_FILE_SUFFIX}`);
  fs.writeFileSync(filePath, zlib.zstdCompressSync(Buffer.from(body)));
  return filePath;
}

await test('session logs decode every zstd frame and tolerate a partial tail', () => {
  const first = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"frame-one"}\n'));
  const second = zlib.zstdCompressSync(Buffer.from('{"type":"session/title","data":{"title":"frame-two"}}\n'));
  const decoded = decodeSessionBuffer(Buffer.concat([first, second]));
  assert.equal(decoded.frames, 2);
  assert.equal(decoded.decoded, 2);
  assert.match(decoded.text, /frame-one/);
  assert.match(decoded.text, /frame-two/);
  const partial = decodeSessionBuffer(Buffer.concat([first, second.subarray(0, 6)]));
  assert.equal(partial.frames, 2);
  assert.equal(partial.decoded, 1);
});

await test('other conversations can be listed, mined and imported', async () => {
  const sessionsRoot = tempRoot('sessions');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  writeFakeSession(sessionsRoot, 'session-import-test', [
    '记住：项目代号是 Aurora',
    '以后都用中文回答',
    { text: '记住：这行来自运行时上下文，不应导入', kind: 'runtime-context' },
  ]);

  const listing = await listSessions({ sessionsRoot });
  assert.equal(listing.sessions.length, 1);
  assert.equal(listing.sessions[0].id, 'session-import-test');
  assert.equal(listing.sessions[0].title, '测试对话');
  assert.equal(typeof listing.sessions[0].sizeBytes, 'number');

  const filePath = await findSessionFile('session-import-test', { sessionsRoot });
  assert.equal(filePath, path.join(sessionsRoot, 'workspace-test', 'session-import-test', 'session.v4.jsonl.zstd'));

  const store = new LayerMemoryStore({ dataRoot: tempRoot('sessions-store') });
  const extracted = await extractSessionMemories(store, filePath);
  assert.ok(extracted.candidates.length >= 2);
  const values = extracted.candidates.map((candidate) => candidate.value);
  assert.ok(values.some((value) => value.includes('Aurora')));
  assert.ok(values.some((value) => value.includes('中文')));
  assert.ok(values.every((value) => !value.includes('运行时上下文')), 'injected context must not be mined');
  assert.ok(extracted.candidates.every((candidate) => candidate.source?.sessionId === 'session-import-test'));

  const result = await importSessionCandidates(store, extracted.candidates);
  assert.equal(result.imported, extracted.candidates.length);
  assert.equal(result.skipped, 0);
  assert.ok(store.entries('fact').some((entry) => entry.value.includes('Aurora')));
  assert.ok(store.entries('persona').some((entry) => entry.tags.includes('import')));

  const secondExtract = await extractSessionMemories(store, filePath);
  assert.equal(secondExtract.candidates.length, 0, 'already stored candidates are skipped as duplicates');
});

// ---------------------------------------------------------------------------
// v1.3: TTL, decay, scopes, merge and the extended dashboard projection.
// ---------------------------------------------------------------------------
await test('TTL entries expire into the archive during maintenance', async () => {
  const root = tempRoot('ttl');
  const store = new LayerMemoryStore({ dataRoot: root });
  await store.store({ key: 'temporary', value: 'only for today', type: 'fact', ttl: '1d' });
  await store.store({ key: 'durable', value: 'keep me forever', type: 'fact' });
  const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
  const expired = await store.expireNow(later);
  assert.equal(expired.length, 1);
  assert.equal(expired[0].key, 'temporary');
  assert.deepEqual(store.entries('fact').map((entry) => entry.key), ['durable']);
  const archiveDir = path.join(root, 'archive');
  assert.ok(fs.existsSync(archiveDir));
  const archived = fs.readdirSync(archiveDir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(archived.length, 1);
  assert.match(fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8'), /temporary/);
});

await test('parseTtl understands durations and ttl entries carry expiresAt', async () => {
  assert.equal(parseTtl('7d'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseTtl('12h'), 12 * 60 * 60 * 1000);
  assert.equal(parseTtl('30m'), 30 * 60 * 1000);
  assert.equal(parseTtl('2w'), 14 * 24 * 60 * 60 * 1000);
  assert.equal(parseTtl('3天'), 3 * 24 * 60 * 60 * 1000);
  assert.equal(parseTtl('never'), null);
  assert.equal(parseTtl(''), null);
  assert.throws(() => parseTtl('7 years'), /ttl/);

  const store = new LayerMemoryStore({ dataRoot: tempRoot('ttl-store') });
  const stored = await store.store({ key: 'ttl-entry', value: 'temporary preference', type: 'persona', ttl: '2h' });
  assert.ok(stored.entry.ttlMs > 0);
  assert.ok(isExpired(stored.entry, Date.now() + stored.entry.ttlMs + 1000));
  assert.ok(!isExpired(stored.entry, Date.now() + 1000));
});

await test('entry weights decay with age while hits boost them', () => {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const fresh = { hits: 0, type: 'persona', lastHitAt: new Date(now).toISOString() };
  const stale = { hits: 0, type: 'persona', lastHitAt: new Date(now - 800 * day).toISOString() };
  const busy = { hits: 4, type: 'persona', lastHitAt: new Date(now).toISOString() };
  assert.ok(entryWeight(fresh, now) > entryWeight(stale, now));
  assert.ok(entryWeight(busy, now) > entryWeight(fresh, now));
  assert.ok(entryWeight(stale, now) < DEFAULTS.digestWeightFloor);
});

await test('scenario scopes filter the prompt digest', async () => {
  const store = new LayerMemoryStore({ dataRoot: tempRoot('scopes') });
  await store.store({ key: 'coding-pref', value: 'always write TypeScript in strict mode', type: 'persona', scopes: ['coding'] });
  await store.store({ key: 'global-pref', value: 'prefers short answers', type: 'persona' });

  await store.updateSettings({ activeScopes: ['chat'] });
  const chatDigest = renderDigest(store);
  assert.ok(chatDigest.includes('global-pref'));
  assert.ok(!chatDigest.includes('coding-pref'));

  await store.updateSettings({ activeScopes: ['coding'] });
  const codingDigest = renderDigest(store);
  assert.ok(codingDigest.includes('coding-pref'));
  assert.ok(codingDigest.includes('global-pref'));

  await store.updateSettings({ activeScopes: [] });
  const allDigest = renderDigest(store);
  assert.ok(allDigest.includes('coding-pref'));
  assert.ok(allDigest.includes('global-pref'));
});

await test('prompt digest budget is configurable from settings', async () => {
  const store = new LayerMemoryStore({ dataRoot: tempRoot('digest-budget') });
  for (let index = 0; index < 6; index += 1) {
    await store.store({ key: `budget-${index}`, value: `偏好陈述 ${index}：保持简洁并优先给出结论`, type: 'fact' });
  }
  const wide = renderDigest(store);
  assert.ok(wide.length > 300);

  await store.updateSettings({ digestBudget: 300 });
  assert.equal(store.settings.digestBudget, 300);
  assert.equal(store.digestBudget, 300);
  const narrow = renderDigest(store);
  assert.ok(narrow.length > 0);
  assert.ok(narrow.length <= 320);
  assert.ok(narrow.length < wide.length);
  assert.equal(renderDigest(store, { budget: store.settings.digestBudget }), narrow);

  await store.updateSettings({ digestBudget: 10 });
  assert.equal(store.settings.digestBudget, 200);
  await store.updateSettings({ digestBudget: 999999 });
  assert.equal(store.settings.digestBudget, 8000);
});

await test('merge candidates surface near-duplicates and merging combines them', async () => {
  const store = new LayerMemoryStore({ dataRoot: tempRoot('merge') });
  await store.store({ key: 'lang-a', value: '用户主要使用中文沟通，偶尔需要英文', type: 'persona', tags: ['language'] });
  await store.store({ key: 'lang-b', value: '用户主要使用中文沟通，偶尔需要英文回复', type: 'persona', tags: ['language', 'auto'] });
  const candidates = store.mergeCandidates();
  assert.ok(candidates.length >= 1, 'expected at least one merge candidate');
  const candidate = candidates[0];
  assert.equal(candidate.layer, 'persona');
  assert.ok(candidate.similarity >= DEFAULTS.candidateThreshold);

  const merged = await store.mergeEntries('persona', candidate.keys, {
    value: '用户主要使用中文沟通，偶尔需要英文回复',
  });
  assert.equal(store.entries('persona').length, 1);
  assert.ok(candidate.keys.includes(merged.key));
  assert.equal(merged.value, '用户主要使用中文沟通，偶尔需要英文回复');
  assert.ok(merged.tags.includes('language'));
  assert.ok(merged.tags.includes('auto'));
});

await test('dashboard exposes working usage, weight, stats and merge candidates', async () => {
  const store = new LayerMemoryStore({ dataRoot: tempRoot('dashboard-v13') });
  await store.store({ key: 'note', value: 'a scratch note', type: 'working' });
  await store.store({ key: 'pref-a', value: 'likes concise answers in Chinese', type: 'persona' });
  await store.store({ key: 'pref-b', value: 'likes concise answers in Chinese with code samples', type: 'persona' });
  await store.recall({ query: 'scratch' });

  const payload = buildDashboardState(store);
  assert.equal(payload.ok, true);
  assert.equal(typeof payload.working.entryPercent, 'number');
  assert.equal(typeof payload.working.charPercent, 'number');
  assert.equal(payload.stats.working.count, 1);
  assert.equal(typeof payload.stats.persona.maxWeight, 'number');
  assert.ok(payload.stats.working.hits >= 1);
  assert.ok(Array.isArray(payload.candidates));
  assert.ok(payload.candidates.length >= 1);
  assert.ok(payload.layers.working.every((entry) => typeof entry.weight === 'number'));
  assert.ok(payload.digest.includes('<layer-memory>'));
  assert.deepEqual(payload.settings.activeScopes, []);
});

// ---------------------------------------------------------------------------
// v1.5: conversation summaries.
// ---------------------------------------------------------------------------
await test('conversations can be summarized heuristically and the summary imported', async () => {
  const sessionsRoot = tempRoot('summaries');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  writeFakeSession(sessionsRoot, 'session-summary-test', [
    '以后都用中文回答，记住项目代号是 Orion',
    '我喜欢简洁的解释，偏好先给结论',
    '请帮我看看部署脚本的问题',
  ]);
  const filePath = await findSessionFile('session-summary-test', { sessionsRoot });
  const messages = await readSessionMessages(filePath);
  assert.ok(messages.length >= 3);
  assert.equal(messages[0].role, 'user');
  const transcript = buildTranscript(messages);
  assert.match(transcript, /用户：/);
  assert.ok(transcript.includes('Orion'));

  const store = new LayerMemoryStore({ dataRoot: tempRoot('summaries-store') });
  const summarized = await summarizeSession(store, filePath);
  assert.equal(summarized.mode, 'extractive');
  assert.ok(summarized.summary.text.includes('测试对话'));
  assert.ok(summarized.summary.text.includes('偏好与要求'));
  assert.ok(Array.isArray(summarized.summary.keywords));
  assert.ok(summarized.candidate.key.startsWith('summary-session-summary-test'));
  assert.equal(summarized.candidate.type, 'fact');
  assert.ok(summarized.candidate.tags.includes('summary'));

  const imported = await importSessionCandidates(store, [summarized.candidate]);
  assert.equal(imported.imported, 1);
  assert.ok(store.entries('fact').some((entry) => entry.key === summarized.candidate.key));
});

await test('llm summaries stream text deltas through the harness llm service', async () => {
  const fakeLlm = {
    listProviders() {
      return [{ id: 'deepseek-account', name: 'DeepSeek' }];
    },
    async listModels(provider) {
      return [{ provider, id: 'deepseek-flash', name: 'Flash' }];
    },
    stream(options) {
      assert.equal(options.provider, 'deepseek-account');
      assert.equal(options.model, 'deepseek-flash');
      assert.equal(options.messages[0].role, 'user');
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '用户主要使用中文沟通，' };
        yield { type: 'text-delta', index: 0, text: '偏好简洁结论。' };
        yield { type: 'finish', reason: 'stop' };
      })();
    },
  };
  const available = describeLlm(fakeLlm);
  assert.equal(available.available, true);
  assert.equal(available.providers[0].id, 'deepseek-account');
  assert.equal(describeLlm(undefined).available, false);

  const resolved = await resolveDefaultModel(fakeLlm);
  assert.equal(resolved.provider, 'deepseek-account');
  assert.equal(resolved.model, 'deepseek-flash');

  const summary = await llmSummary(fakeLlm, { transcript: '用户：以后都用中文回答', title: '测试对话' });
  assert.equal(summary.mode, 'llm');
  assert.equal(summary.text, '用户主要使用中文沟通，偏好简洁结论。');
  assert.equal(summary.provider, 'deepseek-account');
  assert.equal(summary.model, 'deepseek-flash');

  const progressSummary = await llmSummary(fakeLlm, {
    transcript: '用户：继续完成插件',
    title: '测试对话',
    kind: 'progress',
    progressContext: '待办清单：\n- [进行中] 写测试\n最近工具动作：\n- 编辑文件：test.mjs',
  });
  assert.equal(progressSummary.kind, 'progress');
  assert.equal(progressSummary.text, '用户主要使用中文沟通，偏好简洁结论。');
});

await test('handoff kind asks the model for atomic JSON entries', async () => {
  const handoffLlm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'Flash' }],
    stream(options) {
      assert.equal(options.maxTokens, 3000);
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield {
          type: 'text-delta',
          index: 0,
          text:
            '[{"key":"handoff-task","value":"任务：完成多目标申请书","type":"fact"},' +
            '{"key":"handoff-done","value":"已完成：PPT 大纲 15 页","type":"fact"},' +
            '{"key":"handoff-next","value":"下一步：补充数据缺口说明","type":"fact"}]',
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const summary = await llmSummary(handoffLlm, {
    transcript: '用户：把示例项目申请书改成多目标题目',
    title: '测试对话',
    kind: 'handoff',
  });
  assert.equal(summary.kind, 'handoff');
  assert.ok(Array.isArray(summary.entries));
  assert.equal(summary.entries.length, 3);
  assert.ok(summary.entries.every((entry) => entry.value.length <= 180));
});

await test('handoff summaries reject unstructured model output instead of slicing JSON', async () => {
  const messyLlm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'Flash' }],
    stream() {
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield {
          type: 'text-delta',
          index: 0,
          text: '好的，以下是示例项目项目的交接信息：{"key": "handoff-goal", "value": "任务目标：…"',
        };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  await assert.rejects(
    () => llmSummary(messyLlm, { transcript: '用户：测试', title: '测试对话', kind: 'handoff' }),
    /did not return a valid JSON array of handoff entries/,
  );
});

await test('llm mode falls back clearly when the service is unavailable', async () => {
  const sessionsRoot = tempRoot('summaries-llm-fallback');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  writeFakeSession(sessionsRoot, 'session-llm-fallback', ['记住：回退测试的代号是 Vega']);
  const filePath = await findSessionFile('session-llm-fallback', { sessionsRoot });
  const store = new LayerMemoryStore({ dataRoot: tempRoot('summaries-llm-store') });
  await assert.rejects(
    () => summarizeSession(store, filePath, { mode: 'llm', llm: undefined }),
    /llm service is unavailable/,
  );
});

await test('stream failures are surfaced instead of reported as empty summaries', async () => {
  const failingLlm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'Flash' }],
    stream: () =>
      (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { code: 'EMPTY_RESPONSE', message: 'the provider returned no content' },
          },
        };
      })(),
  };
  await assert.rejects(
    () => llmSummary(failingLlm, { transcript: '用户：测试' }),
    /model call failed \[EMPTY_RESPONSE\]: the provider returned no content/,
  );

  const abortedLlm = {
    ...failingLlm,
    stream: () =>
      (async function* () {
        yield { type: 'finish', reason: { kind: 'aborted' } };
      })(),
  };
  await assert.rejects(
    () => llmSummary(abortedLlm, { transcript: '用户：测试' }),
    /the model call was aborted/,
  );
});

await test('llm summaries recover text from completed blocks and explain reasoning-only replies', async () => {
  let requestedMaxTokens = null;
  const blockEndLlm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }],
    listModels: async (provider) => [{ provider, id: 'deepseek-flash', name: 'Flash' }],
    stream: (options) => {
      requestedMaxTokens = options.maxTokens;
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', index: 0, text: ' 块结束时的完整摘要 ' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  const blockSummary = await llmSummary(blockEndLlm, { transcript: '用户：测试' });
  assert.equal(blockSummary.text, '块结束时的完整摘要');
  assert.equal(requestedMaxTokens, 1200);

  const reasoningLlm = {
    ...blockEndLlm,
    stream: () =>
      (async function* () {
        yield { type: 'reasoning-delta', index: 0, text: '这里是模型的长推理过程' };
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      })(),
  };
  await assert.rejects(
    () => llmSummary(reasoningLlm, { transcript: '用户：测试' }),
    /produced \d+ characters of reasoning but no summary text/,
  );
});

// ---------------------------------------------------------------------------
// v1.6: work-progress summaries.
// ---------------------------------------------------------------------------
await test('work progress summaries extract todos, actions and files', async () => {
  const sessionsRoot = tempRoot('progress');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const extraEvents = [
    {
      type: 'todo/write',
      seq: 60,
      time: Date.now(),
      data: {
        todos: [
          { content: '设计方案', status: 'completed' },
          { content: '实现接口', status: 'in_progress' },
          { content: '补充测试', status: 'pending' },
        ],
      },
    },
    {
      type: 'tool/call',
      seq: 61,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        callId: 'call-progress-1',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'C:\\tmp\\plugin\\index.js', content: '…' }),
      },
    },
    {
      type: 'tool/call',
      seq: 62,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        callId: 'call-progress-2',
        name: 'pwsh',
        arguments: JSON.stringify({ command: 'node --check index.js' }),
      },
    },
    {
      type: 'assistant/message',
      seq: 63,
      time: Date.now(),
      data: {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: '已实现接口，正在补充测试。' }] },
      },
    },
  ];
  writeFakeSession(
    sessionsRoot,
    'session-progress-test',
    ['帮我完成 layer-memory 插件的接口改造', '偏好先给结论'],
    extraEvents,
  );
  const filePath = await findSessionFile('session-progress-test', { sessionsRoot });
  const store = new LayerMemoryStore({ dataRoot: tempRoot('progress-store') });
  const summarized = await summarizeSession(store, filePath, { kind: 'progress' });
  assert.equal(summarized.kind, 'progress');
  assert.equal(summarized.mode, 'extractive');
  const text = summarized.summary.text;
  assert.match(text, /【工作进度摘要】/);
  assert.match(text, /任务：帮我完成 layer-memory 插件的接口改造/);
  assert.match(text, /待办进度：完成 1 · 进行中 1 · 待办 1/);
  assert.match(text, /已完成：\n- 设计方案/);
  assert.match(text, /进行中：\n- 实现接口/);
  assert.match(text, /下一步：实现接口/);
  assert.ok(text.includes('index.js'));
  assert.ok(text.includes('node --check'));
  assert.ok(text.includes('已实现接口'));
  assert.equal(summarized.candidate.key, 'progress-session-progress-test');
  assert.ok(summarized.candidate.tags.includes('progress'));
  const imported = await importSessionCandidates(store, [summarized.candidate]);
  assert.equal(imported.imported, 1);
});

await test('handoff summaries produce atomic, noise-free memory entries', async () => {
  const sessionsRoot = tempRoot('handoff');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  const extraEvents = [
    {
      type: 'todo/write',
      seq: 60,
      time: Date.now(),
      data: {
        todos: [
          { content: '抽取申请书正文', status: 'completed' },
          { content: '生成 15 页 PPT 大纲', status: 'completed' },
          { content: '补充数据缺口说明', status: 'pending' },
        ],
      },
    },
    {
      type: 'tool/call',
      seq: 61,
      time: Date.now(),
      data: {
        turn: 1,
        step: 1,
        callId: 'call-handoff-1',
        name: 'write',
        arguments: JSON.stringify({ file_path: 'C:\\proj\\示例项目\\申请书v4\\PPT大纲.md' }),
      },
    },
    {
      type: 'assistant/message',
      seq: 62,
      time: Date.now(),
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Token 生效了（余额 382,509 credits），本轮把额度打到底了。' }],
        },
      },
    },
  ];
  writeFakeSession(
    sessionsRoot,
    'session-handoff-test',
    ['请把示例项目申请书改成多目标题目，并准备 PPT 和答辩', '还缺 18 天 示例数据 数据需要补齐', '偏好：先给结论，再给依据'],
    extraEvents,
  );
  const filePath = await findSessionFile('session-handoff-test', { sessionsRoot });
  const store = new LayerMemoryStore({ dataRoot: tempRoot('handoff-store') });
  const summarized = await summarizeSession(store, filePath, { kind: 'handoff' });
  assert.equal(summarized.kind, 'handoff');
  assert.equal(summarized.mode, 'extractive');
  assert.ok(Array.isArray(summarized.candidates));
  assert.ok(summarized.candidates.length >= 4);
  assert.ok(summarized.candidates.every((entry) => entry.value.length <= 180));
  assert.ok(summarized.candidates.every((entry) => entry.key.startsWith('handoff-')));
  assert.ok(summarized.candidates.every((entry) => entry.tags.includes('handoff')));
  const taskEntry = summarized.candidates.find((entry) => entry.key === 'handoff-task');
  assert.ok(taskEntry, 'missing handoff-task entry');
  assert.match(taskEntry.value, /多目标/);
  const doneEntry = summarized.candidates.find((entry) => entry.key === 'handoff-done');
  assert.ok(doneEntry, 'missing handoff-done entry');
  assert.match(doneEntry.value, /已完成（2\/3）/);
  assert.ok(
    summarized.candidates.some((entry) => entry.value.includes('数据侧待补')),
    'missing data-gap entry',
  );
  assert.ok(
    summarized.candidates.every((entry) => !/余额|credits/.test(entry.value)),
    'transient noise leaked into handoff entries',
  );
  const imported = await importSessionCandidates(store, summarized.candidates);
  assert.equal(imported.imported, summarized.candidates.length);
});

await test('model handoff output is parsed into validated atomic entries', () => {
  const long = '长'.repeat(220);
  const text = [
    '```json',
    JSON.stringify([
      { key: 'handoff-task', value: '任务：完成多目标申请书与答辩', type: 'fact', tags: ['task'] },
      { key: 'handoff-noise', value: 'Token 余额 382,509 credits', type: 'fact' },
      { key: 'handoff-done', value: long, type: 'persona' },
      { key: 'handoff-next', value: '下一步：补 18 天数据', type: 'not-a-layer' },
    ]),
    '```',
  ].join('\n');
  const entries = parseHandoffEntries(text);
  assert.ok(entries !== null);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.value.length <= 180));
  const done = entries.find((entry) => entry.key === 'handoff-done');
  assert.equal(done.type, 'persona');
  const next = entries.find((entry) => entry.key === 'handoff-next');
  assert.equal(next.type, 'fact');
  assert.equal(parseHandoffEntries('not json at all'), null);
});

await test('plain text summaries can be chunked into atomic handoff entries', () => {
  const text = ['任务：完成多目标申请书', '- 已完成：PPT 大纲 15 页', 'Token 余额 382,509 credits', '下一步：补数据缺口'].join(
    '\n',
  );
  const entries = chunkIntoHandoffEntries(text);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.value.length <= 180));
  assert.equal(entries[0].key, 'handoff-01');
  assert.ok(entries.every((entry) => !/余额|credits/.test(entry.value)));
});

await test('client bundle registers the settings page and locale dictionaries', async () => {
  let captured = null;
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec;
      },
    },
  };
  const registeredLocales = [];
  const registeredSlots = [];
  try {
    await import('../client.js');
    assert.ok(captured, 'client bundle did not call window.__ModuleLoader__.load');
    assert.equal(captured.id, 'dsh-layer-memory');

    const fakeReact = {
      createElement() {
        throw new Error('render is not expected in this test');
      },
    };
    const browserModule = captured.factory((name) => {
      if (name === 'react') return fakeReact;
      throw new Error(`unexpected browser require: ${name}`);
    });
    assert.deepEqual(browserModule.inject, ['slots']);

    const ctx = {
      get(service) {
        if (service !== 'locale') return undefined;
        return {
          register(ns, locale, dict) {
            registeredLocales.push({ ns, locale, dict });
            return () => {};
          },
          bind(ns) {
            return (key) => `${ns}:${key}`;
          },
        };
      },
      effect(fn) {
        return fn();
      },
      slots: {
        inject(owner, callback) {
          return callback();
        },
        register(registration, component) {
          registeredSlots.push({ registration, component });
          return () => {};
        },
      },
    };
    browserModule.apply(ctx);

    assert.equal(registeredLocales.length, 2);
    assert.equal(registeredLocales[0].ns, 'layer-memory');
    assert.ok(registeredLocales[0].dict.sectionLabel);
    assert.ok(registeredLocales[1].dict.sectionLabel);

    assert.equal(registeredSlots.length, 1);
    const [{ registration, component }] = registeredSlots;
    assert.equal(registration.name, 'settings.section');
    assert.equal(registration.id, 'layer-memory');
    assert.equal(registration.order, 25);
    assert.equal(typeof registration.label(), 'string');
    assert.equal(typeof component, 'function');
  } finally {
    delete globalThis.window;
  }
});

// ---------------------------------------------------------------------------
// D2 / D4 prototypes (relevance gate + atomic structuring).
// ---------------------------------------------------------------------------
await test('relevance gate prefers discriminative matches and ignores generic overlap', () => {
  const entries = [
    { type: 'fact', key: 'deploy-port', value: '用户服务部署端口是 9091，上线前必须检查', tags: ['deploy'] },
    { type: 'fact', key: 'db-name', value: '数据库名 airport_db，连接串保密', tags: ['db'] },
    { type: 'fact', key: 'chit-chat', value: '今天天气不错，我们去吃饭吧', tags: [] },
  ];
  const ranked = rankEntries(entries, '用户服务的部署端口是多少？', { limit: 3, minCoverage: 0.3, maxDf: 0.6 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].entry.key, 'deploy-port');
  assert.ok(ranked[0].relevance >= 0.3);
  assert.ok(tokenize('用户服务 9091').includes('9091'));

  // A query made only of generic words must not pull anything in.
  assert.deepEqual(rankEntries(entries, '现在怎么样？'), []);
});

await test('atomic splitter keeps every character and memory_store writes atomic entries', async () => {
  const long = '第一句记录数据库配置。第二句记录缓存前缀。第三句记录部署端口。'.repeat(8);
  const parts = splitAtomic(long, 180);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), long);
  assert.ok(parts.every((part) => part.length <= ATOMIC_MAX));

  const root = tempRoot('atomic-write');
  const store = new LayerMemoryStore({ dataRoot: root });
  const tools = Object.fromEntries(createMemoryTools(store).map((tool) => [tool.name, tool]));
  const output = await tools.memory_store.execute({ key: 'long-note', value: long, type: 'fact', tags: ['doc'] });
  assert.match(output, /Saved as \d+ atomic entries/);
  assert.match(output, /long-note·1/);

  const reloaded = new LayerMemoryStore({ dataRoot: root }).loadSync();
  const atomic = reloaded.entries('fact').filter((entry) => entry.key.startsWith('long-note·'));
  assert.equal(atomic.length, parts.length);
  for (const entry of atomic) {
    assert.ok(entry.value.length <= ATOMIC_MAX);
    assert.ok(entry.tags.includes('atomic'));
    assert.ok(entry.tags.includes('doc'));
  }
});

await test('pre-step relevance listener injects once, passes the waterfall and skips unrelated prompts', async () => {
  const root = tempRoot('relevance-inject');
  const store = new LayerMemoryStore({ dataRoot: root });
  store.loadSync();
  await store.store({ key: 'deploy-port', value: '用户服务部署端口是 9091，上线前必须检查', type: 'fact' });
  const listener = createRelevanceListener({ logger: { warn() {} } }, store);
  const decision = { kind: 'enter', messages: [] };
  const payload = {
    agent: { session: { header: { id: 'session-relevance-1' } } },
    messages: [{ role: 'user', content: [{ type: 'text', text: '用户服务的部署端口是多少？' }] }],
  };

  let nextCalls = 0;
  const first = await listener(payload, async () => {
    nextCalls += 1;
    return decision;
  });
  assert.equal(nextCalls, 1, 'the listener must call next() exactly once');
  assert.equal(first.kind, 'enter');
  assert.equal(first.messages.length, 1);
  const injected = first.messages[0];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'plugin:layer-memory');
  assert.match(injected.content[0].text, /9091/);

  const second = await listener(payload, async () => decision);
  assert.equal(second.messages.length, 0, 'the same prompt must not be injected twice');

  const unrelated = await listener(
    {
      agent: { session: { header: { id: 'session-relevance-1' } } },
      messages: [{ role: 'user', content: [{ type: 'text', text: '今天天气怎么样？' }] }],
    },
    async () => decision,
  );
  assert.equal(unrelated.messages.length, 0, 'unrelated prompts must not trigger injection');
});

// ---------------------------------------------------------------------------
for (const root of tempRoots) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
