/**
 * Retrospectives (复盘): small incident / inefficiency records stored as
 * fact-layer entries tagged `retro`.
 *
 * Design notes:
 * - The entry is a normal fact entry, so recall, export/import, merge and the
 *   management dashboard all keep working unchanged.
 * - Retro entries are excluded from the automatic prompt digest (see
 *   `renderDigest` in `store.js`): a postmortem is valuable when looked up, but
 *   it would otherwise eat the injection budget that durable facts need.
 * - The value is a small Markdown block with fixed section labels so it stays
 *   readable both in the dashboard and in a plain `memory_recall` result.
 */

export const RETRO_TAG = 'retro';
export const INCIDENT_TAG = 'incident';
export const RETRO_KEY_PREFIX = 'retro-';

const MAX_TEXT = 400;
const MAX_TITLE = 120;
const MAX_DATE = 32;
const MAX_TIME_COST = 80;
const MAX_TAGS = 8;

function clip(value, maxLength) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function slugify(title) {
  const slug = String(title ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'item';
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const text = String(tag ?? '').trim().toLowerCase();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** Build a stable key such as `retro-2026-11-02-waterfall-crash`. */
export function retroKey(input = {}, now = Date.now()) {
  const rawDate = String(input.date ?? '').trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : new Date(now).toISOString().slice(0, 10);
  return `${RETRO_KEY_PREFIX}${date}-${slugify(input.title)}`;
}

/** True for entries that carry the retrospective tag. */
export function isRetroEntry(entry) {
  return Array.isArray(entry?.tags) && entry.tags.includes(RETRO_TAG);
}

/** Validate and normalize a retrospective record. */
export function coerceRetro(input = {}) {
  const title = clip(input.title, MAX_TITLE);
  if (title.length < 2) throw new Error('retro title must be a string with at least 2 characters');
  const record = {
    title,
    date: clip(input.date, MAX_DATE) || new Date().toISOString().slice(0, 10),
    symptom: clip(input.symptom, MAX_TEXT),
    rootCause: clip(input.rootCause, MAX_TEXT),
    fix: clip(input.fix, MAX_TEXT),
    lesson: clip(input.lesson, MAX_TEXT),
    prevention: clip(input.prevention, MAX_TEXT),
    timeCost: clip(input.timeCost, MAX_TIME_COST),
  };
  if (record.symptom === '' && record.rootCause === '' && record.lesson === '') {
    throw new Error('retro needs at least one of symptom, rootCause or lesson');
  }
  return record;
}

/** Render the record as the Markdown value stored in the fact layer. */
export function buildRetroValue(retro) {
  const lines = [`【复盘】${retro.title}`, `日期：${retro.date}`];
  if (retro.symptom) lines.push(`现象：${retro.symptom}`);
  if (retro.rootCause) lines.push(`根因：${retro.rootCause}`);
  if (retro.fix) lines.push(`修复：${retro.fix}`);
  if (retro.lesson) lines.push(`教训：${retro.lesson}`);
  if (retro.prevention) lines.push(`预防：${retro.prevention}`);
  if (retro.timeCost) lines.push(`耗时：${retro.timeCost}`);
  return lines.join('\n');
}

const FIELD_BY_LABEL = {
  日期: 'date',
  现象: 'symptom',
  根因: 'rootCause',
  修复: 'fix',
  教训: 'lesson',
  预防: 'prevention',
  耗时: 'timeCost',
};

/** Parse a stored retro value back into structured fields. */
export function parseRetroValue(value) {
  const retro = {
    title: '',
    date: '',
    symptom: '',
    rootCause: '',
    fix: '',
    lesson: '',
    prevention: '',
    timeCost: '',
  };
  const lines = String(value ?? '').split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    const header = /^【复盘】(.+)$/.exec(line);
    if (header !== null) {
      retro.title = header[1].trim();
      continue;
    }
    const match = /^([^：:]{1,4})[：:](.*)$/.exec(line);
    if (match === null) {
      if (retro.symptom === '') retro.symptom = line;
      continue;
    }
    const field = FIELD_BY_LABEL[match[1]];
    if (field !== undefined) retro[field] = match[2].trim();
    else if (retro.symptom === '') retro.symptom = line;
  }
  if (retro.title === '') retro.title = retro.symptom.slice(0, MAX_TITLE) || '复盘';
  return retro;
}

/**
 * Record a retrospective as a fact entry.
 *
 * @param {import('./store.js').LayerMemoryStore} store
 * @param {object} input fields: title, symptom, rootCause, fix, lesson, prevention, timeCost, date, tags, key
 * @returns {Promise<{retro: object, entry: object}>}
 */
export async function recordRetro(store, input = {}) {
  const retro = coerceRetro(input);
  const key = String(input.key ?? '').trim() || retroKey(retro);
  const stored = await store.store({
    key,
    value: buildRetroValue(retro),
    type: 'fact',
    tags: [RETRO_TAG, INCIDENT_TAG, ...normalizeTags(input.tags)],
  });
  return { retro, entry: stored.entry ?? stored };
}

/** Project one stored entry into dashboard / tool friendly fields. */
export function retroView(entry) {
  const fields = parseRetroValue(entry.value);
  return {
    key: entry.key,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    enabled: entry.enabled !== false,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...fields,
  };
}

/**
 * List retrospectives newest first. Read-only: never bumps hit counters.
 *
 * @returns {object[]} projected retro records
 */
export function listRetros(store, options = {}) {
  store.ensureLoaded();
  const now = options.now ?? Date.now();
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 20));
  const query = String(options.query ?? '').trim().toLowerCase();
  const all = store.entries('fact', { now, includeExpired: true }).filter(isRetroEntry);
  const filtered = query === ''
    ? all
    : all.filter((entry) => `${entry.key}\n${entry.value}`.toLowerCase().includes(query));
  filtered.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  return filtered.slice(0, limit).map(retroView);
}
