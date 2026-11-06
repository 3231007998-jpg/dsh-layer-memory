/**
 * Layered memory store.
 *
 * Three layers (`working`, `persona`, `fact`) are kept as one JSONL file per
 * layer under the data root. Entries carry lifecycle metadata on top of the
 * original shape:
 *
 *   { key, value, type, tags, createdAt, updatedAt, hits, lastHitAt,
 *     enabled, ttlMs, expiresAt, scopes }
 *
 * The store also owns the digest that is injected into the system prompt
 * (`renderDigest`) and the maintenance pass that expires TTL entries and
 * merges near-duplicate entries. Everything is local and dependency free.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isRetroEntry } from './retro.js';
import { rankEntries } from './relevance.js';

export const LAYERS = ['working', 'persona', 'fact'];
export const DEFAULT_LAYER = 'working';
export const DATA_ROOT_ENV = 'DSH_LAYER_MEMORY_DIR';
export const SETTINGS_FILE = 'settings.json';

/** Half life, in days, used to decay an entry's recall weight. */
export const HALF_LIFE_DAYS = {
  working: 2,
  persona: 180,
  fact: 30,
};

/** Scopes a memory entry can be gated on. Free-form tags are also allowed. */
export const DEFAULT_SCOPES = ['coding', 'chat', 'writing', 'work'];

export const DEFAULTS = {
  workingCap: 40,
  workingCharCap: 8000,
  digestBudget: 1400,
  recallLimit: 5,
  maxRecallLimit: 50,
  /** Entries whose decayed weight drops below this are omitted from the digest. */
  digestWeightFloor: 0.15,
  /** Same-layer pair similarity that is auto-merged by maintenance. */
  autoMergeThreshold: 0.78,
  /** Same-layer pair similarity that is surfaced as a merge candidate. */
  candidateThreshold: 0.45,
  /** Default TTL for entries that are explicitly temporary. */
  temporaryTtlDays: 7,
  maintenanceIntervalMs: 60 * 60 * 1000,
  archive: true,
};

export const DEFAULT_SETTINGS = {
  activeScopes: [],
  digestBudget: DEFAULTS.digestBudget,
  maintenanceIntervalMs: DEFAULTS.maintenanceIntervalMs,
  lastMaintenanceAt: null,
  lastMaintenance: null,
};

const DEFAULT_DIGEST_HEADER =
  'Layer memory (persistent across sessions). Save durable entries with memory_store; look up prior knowledge with memory_recall.';

const ENTRY_TOUCH_KEYS = new Set(['key', 'value', 'type', 'tags', 'createdAt', 'updatedAt']);

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

export function resolveDataRoot(env = process.env) {
  const override = String(env?.[DATA_ROOT_ENV] ?? '').trim();
  if (override !== '') return path.resolve(override);
  const home = String(env?.DSH_HOME ?? '').trim();
  if (home !== '') return path.join(path.resolve(home), 'layer-memory');
  return path.join(os.homedir(), '.dsh', 'layer-memory');
}

export function normalizeLayer(layer, fallback = DEFAULT_LAYER) {
  if (layer === undefined || layer === null || layer === '') return fallback;
  const value = String(layer).trim().toLowerCase();
  if (!LAYERS.includes(value)) {
    throw new Error(`type must be one of: ${LAYERS.join(', ')} (got "${String(layer)}")`);
  }
  return value;
}

export function normalizeTags(tags) {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new Error('tags must be an array of strings');
  const seen = new Set();
  const result = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new Error('tags must be an array of strings');
    const value = tag.trim().toLowerCase();
    if (value === '') continue;
    if (value.length > 64) throw new Error('each tag must be at most 64 characters');
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= 20) break;
  }
  return result;
}

export function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null) return [];
  if (!Array.isArray(scopes)) throw new Error('scopes must be an array of strings');
  const result = [];
  for (const scope of scopes) {
    if (typeof scope !== 'string') throw new Error('scopes must be an array of strings');
    const value = scope.trim().toLowerCase();
    if (value !== '' && !result.includes(value)) result.push(value);
    if (result.length >= 8) break;
  }
  return result;
}

const DURATION_UNITS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Parse a TTL spec. Accepts `"7d"`, `"12h"`, `"30m"`, `"10s"`, `"2w"`,
 * `"3天"`, `"2小时"`, `"30分钟"`, or a positive number of days.
 * Returns milliseconds, or null for "no TTL".
 */
export function parseTtl(ttl) {
  if (ttl === undefined || ttl === null || ttl === '') return null;
  if (typeof ttl === 'number') {
    if (!Number.isFinite(ttl) || ttl <= 0) throw new Error('ttl must be a positive duration like "7d"');
    return Math.round(ttl * DURATION_UNITS.d);
  }
  const text = String(ttl).trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'never' || text === '0') return null;
  const chinese = /^(\d+(?:\.\d+)?)\s*(毫秒|秒|分钟|小时|天|周)$/.exec(text);
  if (chinese) {
    const amount = Number(chinese[1]);
    const unit = { 毫秒: 'ms', 秒: 's', 分钟: 'm', 小时: 'h', 天: 'd', 周: 'w' }[chinese[2]];
    return Math.round(amount * DURATION_UNITS[unit]);
  }
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(text);
  if (!match) throw new Error(`ttl must look like "7d", "12h", "30m", or a number of days (got "${String(ttl)}")`);
  return Math.round(Number(match[1]) * DURATION_UNITS[match[2]]);
}

export function formatTtl(ms) {
  if (!ms) return '';
  if (ms % DURATION_UNITS.w === 0) return `${ms / DURATION_UNITS.w}w`;
  if (ms % DURATION_UNITS.d === 0) return `${ms / DURATION_UNITS.d}d`;
  if (ms % DURATION_UNITS.h === 0) return `${ms / DURATION_UNITS.h}h`;
  if (ms % DURATION_UNITS.m === 0) return `${ms / DURATION_UNITS.m}m`;
  return `${Math.round(ms / 1000)}s`;
}

function parseTime(value) {
  const time = Date.parse(String(value ?? ''));
  return Number.isFinite(time) ? time : null;
}

function clip(value, maxLength) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function tokenizeForSimilarity(value) {
  const text = String(value ?? '').toLowerCase();
  const tokens = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []) tokens.add(word);
  for (const char of text.match(/[\u3400-\u9fff]/g) ?? []) tokens.add(char);
  const cjkRuns = text.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  for (const run of cjkRuns) {
    for (let index = 0; index + 1 < run.length; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

/** Jaccard similarity between two entry values in [0, 1]. */
export function similarity(left, right) {
  const a = tokenizeForSimilarity(left);
  const b = tokenizeForSimilarity(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Token groups whose members contradict each other when they differ. */
const CONFLICT_GROUPS = [
  ['中文', '英文', '汉语', '英语'],
  ['喜欢', '讨厌', '不喜欢', '偏好'],
  ['要', '不要', '别', '无需'],
  ['开启', '关闭', '启用', '禁用'],
  ['简体', '繁体'],
  ['always', 'never'],
  ['love', 'hate'],
  ['enable', 'disable'],
];

/** Detect whether two memories state contradictory preferences. */
export function conflicts(left, right) {
  const a = String(left ?? '').toLowerCase();
  const b = String(right ?? '').toLowerCase();
  for (const group of CONFLICT_GROUPS) {
    const leftHit = group.find((token) => a.includes(token));
    const rightHit = group.find((token) => b.includes(token));
    if (leftHit && rightHit && leftHit !== rightHit) return true;
  }
  return false;
}

/** Round to two decimals for stable JSON output. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Decayed recall weight of an entry. Hits raise the base, staleness lowers it
 * with a per-layer half life.
 */
export function entryWeight(entry, now = Date.now()) {
  const base = 1 + 0.5 * Math.min(Math.max(entry.hits ?? 0, 0), 20);
  const lastSeen = parseTime(entry.lastHitAt) ?? parseTime(entry.updatedAt) ?? now;
  const ageDays = Math.max(0, (now - lastSeen) / (24 * 60 * 60 * 1000));
  const halfLife = HALF_LIFE_DAYS[entry.type] ?? HALF_LIFE_DAYS.fact;
  return round2(base * 0.5 ** (ageDays / halfLife));
}

export function isExpired(entry, now = Date.now()) {
  const expiresAt = parseTime(entry.expiresAt);
  return expiresAt !== null && expiresAt <= now;
}

/** Scope gate: an entry with scopes is only visible when one is active. */
export function scopeVisible(scopes, activeScopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  if (!Array.isArray(activeScopes) || activeScopes.length === 0) return true;
  return scopes.some((scope) => activeScopes.includes(scope));
}

// ---------------------------------------------------------------------------
// Entry normalization / serialization.
// ---------------------------------------------------------------------------

export function coerceEntry(raw, fallback = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('memory entry must be an object');
  }
  const key = String(raw.key ?? '').trim();
  if (key === '') throw new Error('key must be a string');
  if (key.length > 512) throw new Error('key must be at most 512 characters');
  const value = typeof raw.value === 'string' ? raw.value : String(raw.value ?? '');
  if (value.trim() === '') throw new Error('value must be a non-empty string');
  const type = normalizeLayer(raw.type ?? fallback.type);
  const createdAt = parseTime(raw.createdAt) ?? Date.parse(String(fallback.createdAt ?? new Date().toISOString()));
  const updatedAt = parseTime(raw.updatedAt) ?? Date.parse(String(fallback.updatedAt ?? new Date(createdAt).toISOString()));
  const lastHitAt = parseTime(raw.lastHitAt) ?? updatedAt;
  const hits = Number.isFinite(Number(raw.hits)) ? Math.max(0, Math.floor(Number(raw.hits))) : 0;
  const tags = normalizeTags(raw.tags ?? fallback.tags);
  const scopes = normalizeScopes(raw.scopes ?? fallback.scopes);
  const ttlMs = raw.ttlMs === null || raw.ttlMs === undefined ? parseTtl(raw.ttl) : Math.max(0, Number(raw.ttlMs) || 0) || null;
  let expiresAt = parseTime(raw.expiresAt);
  if (expiresAt === null && ttlMs) expiresAt = updatedAt + ttlMs;
  const enabled = raw.enabled === undefined ? true : raw.enabled !== false;
  return {
    key,
    value,
    type,
    tags,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
    hits,
    lastHitAt: new Date(lastHitAt).toISOString(),
    enabled,
    ttlMs: ttlMs ?? null,
    expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    scopes,
    _createdMs: createdAt,
    _updatedMs: updatedAt,
    _lastHitMs: lastHitAt,
    _expiresMs: expiresAt,
  };
}

function stripInternal(entry, now = Date.now()) {
  return {
    key: entry.key,
    value: entry.value,
    type: entry.type,
    tags: [...entry.tags],
    scopes: [...entry.scopes],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    hits: entry.hits,
    lastHitAt: entry.lastHitAt,
    enabled: entry.enabled,
    ttlMs: entry.ttlMs,
    expiresAt: entry.expiresAt,
    weight: entryWeight(entry, now),
    expired: isExpired(entry, now),
  };
}

export function entryToJson(entry, now = Date.now()) {
  return { id: `${entry.type}:${entry.key}`, ...stripInternal(entry, now) };
}

// ---------------------------------------------------------------------------
// Import parsing.
// ---------------------------------------------------------------------------

/**
 * Parse memories from the Markdown export, a JSON array, or JSONL. Returns
 * `{ entries, warnings }`; invalid records are collected as warnings.
 */
export function parseImport(text) {
  const raw = String(text ?? '');
  const warnings = [];
  const entries = [];
  const trimmed = raw.trim();

  const collect = (record, at) => {
    try {
      entries.push(coerceEntry(record));
    } catch (error) {
      warnings.push(`${at}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  if (trimmed === '') return { entries, warnings };

  if (trimmed.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      warnings.push(`JSON parse failed: ${error instanceof Error ? error.message : String(error)}`);
      return { entries, warnings };
    }
    if (!Array.isArray(parsed)) {
      warnings.push('JSON import must be an array of memory entries');
      return { entries, warnings };
    }
    parsed.forEach((record, index) => collect(record, `entry ${index + 1}`));
    return { entries, warnings };
  }

  if (raw.includes('<!-- layer-memory:entry -->')) {
    const blocks = raw.split('<!-- layer-memory:entry -->').slice(1);
    blocks.forEach((block, index) => {
      const end = block.indexOf('<!-- /layer-memory:entry -->');
      const body = end >= 0 ? block.slice(0, end) : block;
      const separator = body.indexOf('\n---');
      const headerText = separator >= 0 ? body.slice(0, separator) : '';
      const value = separator >= 0 ? body.slice(separator + 4).trim() : body.trim();
      const record = { value };
      for (const line of headerText.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const field = line.slice(colon + 1).trim();
        if (name === 'key') record.key = field;
        else if (name === 'type') record.type = field;
        else if (name === 'tags') record.tags = field === '' ? [] : field.split(',').map((tag) => tag.trim()).filter(Boolean);
        else if (name === 'scopes') record.scopes = field === '' ? [] : field.split(',').map((scope) => scope.trim()).filter(Boolean);
        else if (name === 'created') record.createdAt = field;
        else if (name === 'updated') record.updatedAt = field;
        else if (name === 'hits') record.hits = Number(field);
        else if (name === 'last-hit') record.lastHitAt = field;
        else if (name === 'enabled') record.enabled = field !== 'false';
        else if (name === 'ttl') record.ttlMs = parseTtl(field) ?? null;
        else if (name === 'expires-at') record.expiresAt = field;
      }
      if (record.key === undefined) warnings.push(`entry ${index + 1}: missing key`);
      else collect(record, `entry ${index + 1} ("${record.key}")`);
    });
    return { entries, warnings };
  }

  // JSONL fallback.
  const lines = raw.split('\n');
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text === '' || text.startsWith('#')) return;
    if (!text.startsWith('{')) {
      warnings.push(`line ${index + 1}: not a JSON object`);
      return;
    }
    try {
      collect(JSON.parse(text), `line ${index + 1}`);
    } catch (error) {
      warnings.push(`line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { entries, warnings };
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

/** Serialize one entry into the Markdown export block. */
function serializeEntry(entry) {
  const lines = [
    '<!-- layer-memory:entry -->',
    `key: ${entry.key}`,
    `type: ${entry.type}`,
    `tags: ${entry.tags.join(', ')}`,
    `scopes: ${entry.scopes.join(', ')}`,
    `created: ${entry.createdAt}`,
    `updated: ${entry.updatedAt}`,
    `hits: ${entry.hits}`,
    `last-hit: ${entry.lastHitAt}`,
    `enabled: ${entry.enabled ? 'true' : 'false'}`,
    `ttl: ${entry.ttlMs ? formatTtl(entry.ttlMs) : ''}`,
    `expires-at: ${entry.expiresAt ?? ''}`,
    '---',
    entry.value,
    '<!-- /layer-memory:entry -->',
  ];
  return lines.join('\n');
}

export class LayerMemoryStore {
  constructor(options = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? resolveDataRoot());
    this.workingCap = options.workingCap ?? DEFAULTS.workingCap;
    this.workingCharCap = options.workingCharCap ?? DEFAULTS.workingCharCap;
    this.digestBudget = options.digestBudget ?? DEFAULTS.digestBudget;
    this.digestBudgetOverride = Number.isFinite(options.digestBudget) ? options.digestBudget : null;
    this.recallLimit = options.recallLimit ?? DEFAULTS.recallLimit;
    this.autoMergeThreshold = options.autoMergeThreshold ?? DEFAULTS.autoMergeThreshold;
    this.candidateThreshold = options.candidateThreshold ?? DEFAULTS.candidateThreshold;
    this.digestWeightFloor = options.digestWeightFloor ?? DEFAULTS.digestWeightFloor;
    this.archive = options.archive ?? DEFAULTS.archive;
    this.layers = Object.fromEntries(LAYERS.map((layer) => [layer, new Map()]));
    this.warnings = [];
    this.settings = { ...DEFAULT_SETTINGS };
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  // -- paths ---------------------------------------------------------------

  layerFile(layer) {
    return path.join(this.dataRoot, `${normalizeLayer(layer)}.jsonl`);
  }

  settingsFile() {
    return path.join(this.dataRoot, SETTINGS_FILE);
  }

  archiveDir() {
    return path.join(this.dataRoot, 'archive');
  }

  exportsDir() {
    return path.join(this.dataRoot, 'exports');
  }

  // -- loading -------------------------------------------------------------

  loadSync() {
    this.warnings = [];
    this.entries = this.entries ?? {};
    for (const layer of LAYERS) {
      const map = new Map();
      const file = this.layerFile(layer);
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          this.layers[layer] = map;
          continue;
        }
        this.warnings.push(`${layer}.jsonl: cannot read: ${error instanceof Error ? error.message : String(error)}`);
        this.layers[layer] = map;
        continue;
      }
      const lines = text.split('\n');
      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === '') return;
        try {
          const entry = coerceEntry(JSON.parse(trimmed), { type: layer });
          map.set(entry.key, entry);
        } catch (error) {
          this.warnings.push(`${layer}.jsonl line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
        }
      });
      this.layers[layer] = map;
    }
    try {
      const text = fs.readFileSync(this.settingsFile(), 'utf8');
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.settings = { ...DEFAULT_SETTINGS, ...parsed };
        if (!Array.isArray(this.settings.activeScopes)) this.settings.activeScopes = [];
        const parsedBudget = Number(this.settings.digestBudget);
        this.settings.digestBudget = Number.isFinite(parsedBudget)
          ? Math.min(8000, Math.max(200, Math.round(parsedBudget)))
          : DEFAULTS.digestBudget;
        if (this.digestBudgetOverride !== null) this.settings.digestBudget = this.digestBudgetOverride;
        this.digestBudget = this.settings.digestBudget;
      }
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) {
        this.warnings.push(`settings.json: cannot read: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.loaded = true;
    return this;
  }

  ensureLoaded() {
    if (!this.loaded) this.loadSync();
    return this;
  }

  // -- persistence ---------------------------------------------------------

  enqueue(task) {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => {});
    return next;
  }

  writeFileAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  }

  saveLayerSync(layer) {
    const map = this.layers[normalizeLayer(layer)];
    const text = [...map.values()]
      .sort((left, right) => left._createdMs - right._createdMs)
      .map((entry) => JSON.stringify(stripInternal(entry, entry._updatedMs)))
      .join('\n');
    this.writeFileAtomic(this.layerFile(layer), text === '' ? '' : `${text}\n`);
  }

  saveLayer(layer) {
    return this.enqueue(() => this.saveLayerSync(layer));
  }

  saveSettingsSync() {
    this.writeFileAtomic(this.settingsFile(), `${JSON.stringify(this.settings, null, 2)}\n`);
  }

  saveSettings() {
    return this.enqueue(() => this.saveSettingsSync());
  }

  archiveEntries(entries, reason = 'expired', now = Date.now()) {
    if (!this.archive || entries.length === 0) return;
    const stamp = new Date(now).toISOString().slice(0, 10);
    const file = path.join(this.archiveDir(), `${reason}-${stamp}.jsonl`);
    const text = entries
      .map((entry) => JSON.stringify({ ...stripInternal(entry, now), archivedAt: new Date(now).toISOString(), reason }))
      .join('\n');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text}\n`, 'utf8');
  }

  // -- reads ---------------------------------------------------------------

  entries(layer, options = {}) {
    const map = this.layers[normalizeLayer(layer)];
    const now = options.now ?? Date.now();
    let values = [...map.values()];
    if (options.includeExpired !== true) values = values.filter((entry) => !isExpired(entry, now));
    if (options.enabledOnly === true) values = values.filter((entry) => entry.enabled !== false);
    values.sort((left, right) => right._updatedMs - left._updatedMs);
    return values;
  }

  totalEntries() {
    return LAYERS.reduce((total, layer) => total + this.layers[layer].size, 0);
  }

  snapshot() {
    const counts = Object.fromEntries(LAYERS.map((layer) => [layer, this.layers[layer].size]));
    return {
      dataRoot: this.dataRoot,
      counts,
      total: this.totalEntries(),
      chars: LAYERS.reduce(
        (total, layer) => total + [...this.layers[layer].values()].reduce((sum, entry) => sum + entry.value.length, 0),
        0,
      ),
      warnings: [...this.warnings],
    };
  }

  workingUsage() {
    const working = this.layers.working;
    const chars = [...working.values()].reduce((sum, entry) => sum + entry.value.length, 0);
    const percent = (value, cap) => (cap > 0 ? Math.min(100, Math.round((value / cap) * 100)) : 0);
    return {
      entries: working.size,
      entriesCap: this.workingCap,
      entryPercent: percent(working.size, this.workingCap),
      chars,
      charsCap: this.workingCharCap,
      charPercent: percent(chars, this.workingCharCap),
    };
  }

  /** Entries that should reach the system prompt / digest for this state. */
  visibleEntries(layer, options = {}) {
    const now = options.now ?? Date.now();
    const activeScopes = options.activeScopes ?? this.settings.activeScopes ?? [];
    const floor = options.weightFloor ?? this.digestWeightFloor;
    return this.entries(layer, { now, enabledOnly: true })
      .filter((entry) => !isExpired(entry, now))
      .filter((entry) => scopeVisible(entry.scopes, activeScopes))
      .filter((entry) => entryWeight(entry, now) >= floor)
      .sort((left, right) => entryWeight(right, now) - entryWeight(left, now));
  }

  // -- mutations -----------------------------------------------------------

  async store(input = {}) {
    this.ensureLoaded();
    const now = Date.now();
    const type = normalizeLayer(input.type);
    const tags = normalizeTags(input.tags);
    const scopes = normalizeScopes(input.scopes);
    const ttlMs = 'ttl' in input ? parseTtl(input.ttl) : parseTtl(input.ttlMs);
    const key = String(input.key ?? '').trim();
    const value = String(input.value ?? '');
    if (key === '') throw new Error('key must be a string');
    if (key.length > 512) throw new Error('key must be at most 512 characters');
    if (value.trim() === '') throw new Error('value must be a non-empty string');
    if (value.length > 20000) throw new Error('value must be at most 20000 characters');

    const map = this.layers[type];
    const existing = map.get(key);
    const entry = coerceEntry(
      {
        key,
        value,
        type,
        tags: existing ? [...new Set([...existing.tags, ...tags])] : tags,
        scopes: existing ? [...new Set([...existing.scopes, ...scopes])] : scopes,
        createdAt: existing ? existing.createdAt : new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        lastHitAt: new Date(now).toISOString(),
        hits: existing ? existing.hits : 0,
        enabled: input.enabled === undefined ? (existing ? existing.enabled : true) : input.enabled !== false,
        ttlMs: ttlMs ?? null,
        expiresAt: ttlMs ? new Date(now + ttlMs).toISOString() : null,
      },
      { type },
    );
    map.set(key, entry);

    const archived = [];
    if (type === 'working') {
      while (map.size > this.workingCap || this.workingChars() > this.workingCharCap) {
        const oldest = [...map.values()].sort((left, right) => left._createdMs - right._createdMs)[0];
        if (!oldest) break;
        map.delete(oldest.key);
        const factMap = this.layers.fact;
        const prior = factMap.get(oldest.key);
        const archivedEntry = coerceEntry(
          {
            ...stripInternal(oldest, now),
            type: 'fact',
            tags: [...new Set([...(prior?.tags ?? []), ...oldest.tags, 'archived'])],
            createdAt: oldest.createdAt,
            updatedAt: new Date(now).toISOString(),
            ...(prior ? { value: prior.value, hits: prior.hits } : {}),
          },
          { type: 'fact' },
        );
        factMap.set(oldest.key, archivedEntry);
        archived.push(archivedEntry.key);
        await this.saveLayer('fact');
      }
    }

    await this.saveLayer(type);
    return { entry, archived };
  }

  workingChars() {
    return [...this.layers.working.values()].reduce((sum, entry) => sum + entry.value.length, 0);
  }

  findEntry(layer, key) {
    return this.layers[normalizeLayer(layer)].get(String(key ?? '').trim()) ?? null;
  }

  async updateEntry(layer, key, patch = {}) {
    this.ensureLoaded();
    const type = normalizeLayer(layer);
    const map = this.layers[type];
    const existing = map.get(String(key ?? '').trim());
    if (!existing) throw new Error(`no entry "${String(key)}" in the ${type} layer`);
    const now = Date.now();
    const value = patch.value === undefined ? existing.value : String(patch.value);
    if (value.trim() === '') throw new Error('value must be a non-empty string');
    const tags = patch.tags === undefined ? existing.tags : normalizeTags(patch.tags);
    const scopes = patch.scopes === undefined ? existing.scopes : normalizeScopes(patch.scopes);
    const ttlSpecified = 'ttl' in patch;
    const ttlMs = ttlSpecified ? parseTtl(patch.ttl) : existing.ttlMs;
    const entry = coerceEntry(
      {
        ...stripInternal(existing, now),
        value,
        tags,
        scopes,
        enabled: patch.enabled === undefined ? existing.enabled : patch.enabled !== false,
        updatedAt: new Date(now).toISOString(),
        lastHitAt: existing.lastHitAt,
        ttlMs: ttlMs ?? null,
        expiresAt: ttlSpecified ? (ttlMs ? new Date(now + ttlMs).toISOString() : null) : existing.expiresAt,
      },
      { type },
    );
    map.set(entry.key, entry);
    await this.saveLayer(type);
    return entry;
  }

  async setEnabled(layer, key, enabled) {
    return this.updateEntry(layer, key, { enabled: enabled !== false });
  }

  async remove(layer, key) {
    this.ensureLoaded();
    const type = normalizeLayer(layer);
    const removed = this.layers[type].delete(String(key ?? '').trim());
    if (removed) await this.saveLayer(type);
    return removed;
  }

  async clearLayer(layer) {
    this.ensureLoaded();
    const type = normalizeLayer(layer);
    this.layers[type].clear();
    await this.saveLayer(type);
  }

  async touch(entries) {
    this.ensureLoaded();
    const list = Array.isArray(entries) ? entries : [];
    const changed = new Set();
    const now = Date.now();
    for (const item of list) {
      const entry = typeof item === 'string' ? null : item;
      if (!entry) continue;
      const found = this.findEntry(entry.type, entry.key);
      if (!found) continue;
      found.hits += 1;
      found._lastHitMs = now;
      found.lastHitAt = new Date(now).toISOString();
      changed.add(found.type);
    }
    for (const layer of changed) await this.saveLayer(layer);
  }

  async recall(input = {}) {
    this.ensureLoaded();
    const now = Date.now();
    const query = String(input.query ?? '').trim().toLowerCase();
    const type = input.type === undefined || input.type === null || input.type === '' ? null : normalizeLayer(input.type);
    const filterTags = normalizeTags(input.tags);
    const rawLimit = input.limit === undefined ? this.recallLimit : Number(input.limit);
    if (!Number.isFinite(rawLimit) || rawLimit < 1) throw new Error('limit must be a positive integer');
    if (rawLimit > DEFAULTS.maxRecallLimit) throw new Error(`limit must be at most ${DEFAULTS.maxRecallLimit}`);
    const limit = Math.floor(rawLimit);
    const activeScopes = input.activeScopes ?? this.settings.activeScopes ?? [];
    const layers = type ? [type] : LAYERS;
    const terms = query === '' ? [] : query.split(/\s+/).filter(Boolean);
    const scored = [];

    for (const layer of layers) {
      for (const entry of this.layers[layer].values()) {
        if (entry.enabled === false || isExpired(entry, now)) continue;
        if (!scopeVisible(entry.scopes, activeScopes)) continue;
        if (filterTags.length > 0 && !filterTags.every((tag) => entry.tags.includes(tag))) continue;
        let score = 0;
        const keyLower = entry.key.toLowerCase();
        const valueLower = entry.value.toLowerCase();
        const tagText = entry.tags.join(' ');
        let matched = terms.length === 0;
        if (terms.length > 0) {
          matched = true;
          for (const term of terms) {
            const inKey = keyLower.includes(term);
            const inValue = valueLower.includes(term);
            const inTags = tagText.includes(term);
            if (!inKey && !inValue && !inTags) {
              matched = false;
              break;
            }
          }
        }
        if (!matched) continue;
        if (terms.length === 0) {
          score = entry.hits * 2 + entryWeight(entry, now);
        } else {
          for (const term of terms) {
            if (keyLower === term) score += 24;
            else if (keyLower.includes(term)) score += 12;
            else if (tagText.includes(term)) score += 5;
            else if (valueLower.includes(term)) score += 3;
          }
          score += entryWeight(entry, now);
        }
        scored.push({ entry, score });
      }
    }

    // D2 prototype: relevance gate. Keyword recall only requires every term to
    // appear somewhere, so entries sharing generic words but discussing a
    // different subject slip through. Re-rank with token coverage plus a
    // discriminative-token requirement, then fold the relevance back into the
    // score. If the gate would drop everything, keep the keyword results.
    let gated = scored;
    if (terms.length > 0 && input.relevance !== false) {
      const ranked = rankEntries(
        scored.map((hit) => hit.entry),
        query,
        { maxDf: 1, requireDiscriminative: true, minCoverage: 0.3 },
      );
      if (ranked.length > 0) {
        const relevanceByKey = new Map(
          ranked.map((hit) => [`${hit.entry.type}\u0000${hit.entry.key}`, hit.relevance]),
        );
        gated = scored
          .filter((hit) => relevanceByKey.has(`${hit.entry.type}\u0000${hit.entry.key}`))
          .map((hit) => ({
            entry: hit.entry,
            score: hit.score + (relevanceByKey.get(`${hit.entry.type}\u0000${hit.entry.key}`) ?? 0) * 20,
          }));
      }
    }
    const ordered = gated;
    ordered.sort((left, right) => right.score - left.score || right.entry._updatedMs - left.entry._updatedMs);
    const hits = ordered.slice(0, limit);
    for (const hit of hits) {
      hit.entry.hits += 1;
      hit.entry._lastHitMs = now;
      hit.entry.lastHitAt = new Date(now).toISOString();
    }
    const changedLayers = new Set(hits.map((hit) => hit.entry.type));
    for (const layer of changedLayers) await this.saveLayer(layer);
    return {
      entries: hits.map((hit) => hit.entry),
      query,
      type,
      tags: filterTags,
      total: scored.length,
    };
  }

  // -- merge / maintenance -------------------------------------------------

  /** Candidate near-duplicate pairs per layer, newest first. */
  mergeCandidates(options = {}) {
    this.ensureLoaded();
    const now = options.now ?? Date.now();
    const threshold = options.threshold ?? this.candidateThreshold;
    const activeScopes = options.activeScopes ?? this.settings.activeScopes ?? [];
    const candidates = [];
    for (const layer of LAYERS) {
      const values = this.entries(layer, { now, enabledOnly: true }).filter((entry) =>
        scopeVisible(entry.scopes, activeScopes),
      );
      for (let left = 0; left < values.length; left += 1) {
        for (let right = left + 1; right < values.length; right += 1) {
          const a = values[left];
          const b = values[right];
          const score = similarity(a.value, b.value);
          if (score < threshold) continue;
          candidates.push({
            layer,
            keys: [a.key, b.key],
            similarity: round2(score),
            conflict: conflicts(a.value, b.value),
            autoMergeable: score >= this.autoMergeThreshold && !conflicts(a.value, b.value),
            left: { key: a.key, value: a.value, hits: a.hits, updatedAt: a.updatedAt },
            right: { key: b.key, value: b.value, hits: b.hits, updatedAt: b.updatedAt },
          });
        }
      }
    }
    candidates.sort((left, right) => right.similarity - left.similarity);
    return candidates.slice(0, 50);
  }

  /** Merge several same-layer entries into one survivor. */
  async mergeEntries(layer, keys, options = {}) {
    this.ensureLoaded();
    const type = normalizeLayer(layer);
    const map = this.layers[type];
    const entries = [...new Set((keys ?? []).map((key) => String(key)))].map((key) => map.get(key)).filter(Boolean);
    if (entries.length < 2) throw new Error('merging needs at least two existing entries in the same layer');
    const now = Date.now();
    const survivor = [...entries].sort(
      (left, right) => right.hits - left.hits || right._updatedMs - left._updatedMs,
    )[0];
    const uniqueValues = [...new Set(entries.map((entry) => entry.value.trim()))];
    const value = options.value === undefined ? uniqueValues.join('；') : String(options.value);
    if (value.trim() === '') throw new Error('merged value must be a non-empty string');
    const merged = coerceEntry(
      {
        key: survivor.key,
        value,
        type,
        tags: [...new Set(entries.flatMap((entry) => entry.tags))],
        scopes: [...new Set(entries.flatMap((entry) => entry.scopes))],
        createdAt: new Date(Math.min(...entries.map((entry) => entry._createdMs))).toISOString(),
        updatedAt: new Date(now).toISOString(),
        lastHitAt: new Date(Math.max(...entries.map((entry) => entry._lastHitMs))).toISOString(),
        hits: entries.reduce((sum, entry) => sum + entry.hits, 0),
        enabled: entries.some((entry) => entry.enabled !== false),
        ttlMs: survivor.ttlMs,
        expiresAt: survivor.expiresAt,
      },
      { type },
    );
    for (const entry of entries) map.delete(entry.key);
    map.set(merged.key, merged);
    await this.saveLayer(type);
    return merged;
  }

  /** Remove entries whose TTL has elapsed; archived so nothing is lost. */
  async expireNow(now = Date.now()) {
    this.ensureLoaded();
    const expired = [];
    for (const layer of LAYERS) {
      const map = this.layers[layer];
      for (const [key, entry] of [...map.entries()]) {
        if (!isExpired(entry, now)) continue;
        map.delete(key);
        expired.push(entry);
      }
    }
    if (expired.length > 0) {
      try {
        this.archiveEntries(expired);
      } catch (error) {
        this.warnings.push(`archive failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const layer of LAYERS) await this.saveLayer(layer);
    }
    return expired.map((entry) => entryToJson(entry, now));
  }

  /** One maintenance pass: expire, then auto-merge safe duplicates. */
  async runMaintenance(now = Date.now()) {
    this.ensureLoaded();
    const expired = await this.expireNow(now);
    const before = this.mergeCandidates({ now });
    const merged = [];
    for (const candidate of before) {
      if (!candidate.autoMergeable) continue;
      try {
        const survivor = await this.mergeEntries(candidate.layer, candidate.keys);
        merged.push({ layer: candidate.layer, key: survivor.key, value: survivor.value });
      } catch (error) {
        this.warnings.push(`auto-merge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const report = {
      at: new Date(now).toISOString(),
      expired: expired.length,
      merged: merged.length,
      candidates: this.mergeCandidates({ now }).length,
    };
    this.settings.lastMaintenanceAt = report.at;
    this.settings.lastMaintenance = report;
    await this.saveSettings();
    return report;
  }

  // -- settings ------------------------------------------------------------

  updateSettings(patch = {}) {
    this.ensureLoaded();
    if (patch.activeScopes !== undefined) {
      this.settings.activeScopes = normalizeScopes(patch.activeScopes);
    }
    if (patch.digestBudget !== undefined) {
      const value = Number(patch.digestBudget);
      if (Number.isFinite(value)) {
        this.settings.digestBudget = Math.min(8000, Math.max(200, Math.round(value)));
        this.digestBudget = this.settings.digestBudget;
      }
    }
    if (patch.maintenanceIntervalMs !== undefined) {
      const value = Number(patch.maintenanceIntervalMs);
      if (Number.isFinite(value) && value >= 60_000) this.settings.maintenanceIntervalMs = Math.round(value);
    }
    return this.saveSettings().then(() => this.settings);
  }

  // -- export / import -----------------------------------------------------

  async exportTo(input = {}) {
    this.ensureLoaded();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputPath = input.outputPath
      ? path.resolve(String(input.outputPath))
      : path.join(this.exportsDir(), `layer-memory-${stamp}.md`);
    const blocks = [];
    for (const layer of LAYERS) {
      for (const entry of this.entries(layer, { includeExpired: true })) blocks.push(serializeEntry(entry));
    }
    const header = [
      '# Layer Memory export',
      '',
      `- exportedAt: ${new Date().toISOString()}`,
      `- dataRoot: ${this.dataRoot}`,
      `- entries: ${blocks.length}`,
      '',
      '<!-- Each block below is one memory entry (Markdown import format). -->',
      '',
    ].join('\n');
    const text = `${header}${blocks.join('\n\n')}\n`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, text, 'utf8');
    return { path: outputPath, entries: blocks.length, bytes: Buffer.byteLength(text, 'utf8') };
  }

  async importFrom(input = {}) {
    this.ensureLoaded();
    const inputPath = String(input.inputPath ?? '').trim();
    if (inputPath === '') throw new Error('inputPath must be a non-empty string');
    const file = path.resolve(inputPath);
    const text = fs.readFileSync(file, 'utf8');
    const mode = String(input.mode ?? 'merge').toLowerCase() === 'replace' ? 'replace' : 'merge';
    if (mode === 'replace') {
      for (const layer of LAYERS) this.layers[layer].clear();
    }
    const { entries, warnings } = parseImport(text);
    let imported = 0;
    let skipped = 0;
    const now = Date.now();
    for (const entry of entries) {
      const map = this.layers[entry.type];
      if (map.has(entry.key)) {
        if (mode === 'replace') map.set(entry.key, entry);
        else {
          const existing = map.get(entry.key);
          const merged = coerceEntry(
            {
              ...stripInternal(existing, now),
              tags: [...new Set([...existing.tags, ...entry.tags])],
              scopes: [...new Set([...existing.scopes, ...entry.scopes])],
              updatedAt: entry.updatedAt,
              lastHitAt: entry.lastHitAt,
              hits: existing.hits + entry.hits,
              ttlMs: entry.ttlMs ?? existing.ttlMs,
              expiresAt: entry.expiresAt ?? existing.expiresAt,
              enabled: existing.enabled,
            },
            { type: entry.type },
          );
          map.set(entry.key, merged);
        }
        imported += 1;
      } else {
        map.set(entry.key, entry);
        imported += 1;
      }
    }
    for (const layer of LAYERS) await this.saveLayer(layer);
    return { path: file, imported, skipped, mode, warnings };
  }
}

// ---------------------------------------------------------------------------
// Prompt digest.
// ---------------------------------------------------------------------------

/**
 * Render the `<layer-memory>` digest injected as a system-prompt context.
 * Returns '' when no entry is visible under the current scenario/weight gate.
 */
export function renderDigest(store, options = {}) {
  store.ensureLoaded();
  const now = options.now ?? Date.now();
  const budget = Math.max(
    120,
    options.budget ?? store.settings?.digestBudget ?? store.digestBudget ?? DEFAULTS.digestBudget,
  );
  const activeScopes = options.activeScopes ?? store.settings.activeScopes ?? [];
  const sections = [];
  for (const layer of ['persona', 'working', 'fact']) {
    // Retrospectives are retrievable but never auto-injected: they would eat
    // the injection budget that durable facts need.
    const entries = store
      .visibleEntries(layer, { now, activeScopes, weightFloor: options.weightFloor })
      .filter((entry) => !isRetroEntry(entry));
    if (entries.length === 0) continue;
    sections.push({ layer, entries });
  }
  if (sections.length === 0) return '';

  const header = options.header ?? DEFAULT_DIGEST_HEADER;
  const opening = '<layer-memory>';
  const closing = '</layer-memory>';
  const body = [`[${sections[0].layer}]`];
  // Budget: header + tags + newlines, then sections in order.
  let used = header.length + opening.length + closing.length + 2 + body[0].length + 1;
  for (let sectionIndex = 0; sectionIndex < sections.length; sectionIndex += 1) {
    const section = sections[sectionIndex];
    const label = `[${section.layer}]`;
    if (sectionIndex > 0) {
      const cost = label.length + 1;
      if (used + cost > budget) break;
      body.push(label);
      used += cost;
    }
    for (const entry of section.entries) {
      const line = `- ${clip(entry.key, 60)}: ${clip(entry.value, 180)}`;
      if (used + line.length + 1 > budget) break;
      body.push(line);
      used += line.length + 1;
    }
  }
  if (body.length === 0) return '';
  return [header, opening, ...body, closing].join('\n');
}

// Backwards-compatible alias used by older call sites.
export { stripInternal as entryView };
