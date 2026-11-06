/**
 * Relevance gating (D2 prototype).
 *
 * The RAG weight experiment ranked "similarity != task relevance" (D2) as one of
 * the two highest-priority defects. Keyword retrieval happily returns entries
 * that share surface words with the query but belong to a different subject
 * ("数据库配置" vs "前端配置"). This module scores query/entry relevance with
 * three ideas:
 *
 *  1. tokenize both sides (CJK bigrams + ASCII words, stop words removed);
 *  2. compute coverage of the query tokens by the entry, weighting ASCII
 *     identifiers (ports, db names, versions) higher than CJK bigrams;
 *  3. require at least one *discriminative* token match when the query has any —
 *     a token that is rare among candidate entries or looks like an identifier.
 *     Generic word overlap alone is not enough to pull an entry into context.
 *
 * `rankEntries` is used by the query-aware prompt injection in index.js and by
 * `memory_recall` scoring. `injectionMessage` builds the injected user message
 * (same shape as the first-principles plugin: a plugin-sourced user message).
 */
import { createHash, randomUUID } from 'node:crypto';

/** Query tokens that carry no retrieval signal on their own. */
const GENERIC_WORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '一个', '两个', '一下', '现在',
  '怎么', '如何', '什么', '为什么', '是否', '可以', '需要', '应该', '能够', '还是', '已经',
  '因为', '所以', '但是', '如果', '然后', '而且', '并且', '不过', '只是', '其实', '可能',
  '大概', '必须', '进行', '使用', '知道', '记得', '告诉', '帮我', '看看', '请问', '谢谢',
  '问题', '东西', '情况', '时候', '地方', '一些', '还有', '就是', '不是', '没有', '一直',
  '时间', '内容', '信息', '注意', '一下', '我们', '大家', '自己', '别人', '怎么', '怎样',
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'how', 'why', 'you', 'your',
  'are', 'was', 'were', 'have', 'has', 'can', 'could', 'should', 'would', 'about', 'into',
]);

const CJK_RUN = /\p{Script=Han}+/gu;
const ASCII_WORD = /[a-z0-9][a-z0-9._:\-/]*/g;

/** Tokenize a query or entry text into deduplicated retrieval tokens. */
export function tokenize(text) {
  const lower = String(text ?? '').toLowerCase();
  const tokens = new Set();
  for (const match of lower.matchAll(CJK_RUN)) {
    const run = match[0];
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2);
      if (!GENERIC_WORDS.has(bigram)) tokens.add(bigram);
    }
  }
  for (const match of lower.matchAll(ASCII_WORD)) {
    const word = match[0];
    if (word.length >= 2 && !GENERIC_WORDS.has(word)) tokens.add(word);
  }
  return [...tokens];
}

function tokenWeight(token) {
  // ASCII identifiers (ports, db names, versions) are much more specific than a
  // CJK bigram, which frequently appears in unrelated entries.
  return /^[a-z0-9]/.test(token) ? 2 : 1;
}

function entryText(entry) {
  const parts = [entry.key ?? '', entry.value ?? '', ...(entry.tags ?? [])];
  return parts.join(' ').toLowerCase();
}

/** Clip a string for compact display (used by the injected recall block). */
export function clip(text, max = 180) {
  const value = String(text ?? '');
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Rank candidate entries against a query, filtering out entries whose only
 * overlap is generic surface vocabulary.
 *
 * options:
 *   limit                max results (default 5)
 *   minCoverage          weighted coverage floor, 0..1 (default 0.34)
 *   minRelevance         alias/stronger threshold applied to the final score
 *   maxDf                max document frequency for a token to count as
 *                        discriminative (default 0.6)
 *   requireDiscriminative when the query has discriminative tokens, require at
 *                        least one match (default true)
 *   allowEmptyQuery      when true, an empty/stopword-only query returns []
 *                        instead of throwing (default true)
 */
export function rankEntries(entries, query, options = {}) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const tokens = tokenize(query);
  const allowEmpty = options.allowEmptyQuery !== false;
  if (tokens.length === 0) return allowEmpty ? [] : list.map((entry) => ({ entry, relevance: 0, coverage: 0, matched: [] }));
  const total = list.length || 1;
  const df = new Map();
  for (const token of tokens) df.set(token, 0);
  for (const entry of list) {
    const text = entryText(entry);
    for (const token of tokens) {
      if (text.includes(token)) df.set(token, (df.get(token) ?? 0) + 1);
    }
  }
  const maxDf = options.maxDf ?? 0.6;
  const discriminative = tokens.filter((token) => {
    const freq = (df.get(token) ?? 0) / total;
    // A token that appears in no candidate entry is useless as a gate: it can
    // never be matched, so requiring it would reject every entry.
    if (freq === 0) return false;
    return freq <= maxDf || /\d/.test(token);
  });
  const totalWeight = tokens.reduce((sum, token) => sum + tokenWeight(token), 0);
  const minCoverage = options.minCoverage ?? 0.34;
  const requireDisc = options.requireDiscriminative !== false && discriminative.length > 0;
  const ranked = [];
  for (const entry of list) {
    const text = entryText(entry);
    const matched = tokens.filter((token) => text.includes(token));
    if (matched.length === 0) continue;
    const coverage = matched.reduce((sum, token) => sum + tokenWeight(token), 0) / totalWeight;
    if (coverage < minCoverage) continue;
    const discMatched = discriminative.filter((token) => matched.includes(token));
    if (requireDisc && discMatched.length === 0) continue;
    const relevance = coverage;
    ranked.push({ entry, relevance, coverage, matched, discriminative: discMatched });
  }
  const minRelevance = options.minRelevance ?? 0;
  const filtered = ranked.filter((item) => item.relevance >= minRelevance);
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 5;
  filtered.sort((left, right) => right.relevance - left.relevance);
  return filtered.slice(0, limit);
}

/** Injected user message for query-aware recall (plugin-sourced, like first-principles). */
export function injectionMessage(text, form = 'recall') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:layer-memory', form },
  };
}

/** Short stable hash used to deduplicate injections per session + prompt. */
export function promptHash(text) {
  return createHash('sha1').update(String(text ?? '')).digest('hex').slice(0, 16);
}

/** Render the injected recall block for the given ranked entries. */
export function renderRecallBlock(ranked, options = {}) {
  const maxChars = options.maxChars ?? 900;
  const lines = ['<layer-memory-recall>', 'Potentially relevant durable memories for the current request:'];
  for (const item of ranked) {
    lines.push(`- [${item.entry.type ?? 'fact'}] ${item.entry.key}: ${clip(item.entry.value, options.entryChars ?? 180)}`);
  }
  lines.push('</layer-memory-recall>');
  const text = lines.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
