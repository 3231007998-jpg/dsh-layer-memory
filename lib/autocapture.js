/**
 * Automatic memory extraction from user messages (heuristic, zero-dependency).
 *
 * The Harness emits `agent/pre-step` at the start of every model step with the
 * user messages of that step. We scan those messages for explicit memory
 * signals only, so the extractor never guesses beyond what the user actually
 * said:
 *
 *   - explicit remember directives ("记住…", "记一下…", "remember that…")
 *     are captured into the fact layer;
 *   - durable self-statements and preferences ("我叫…", "我喜欢/偏好…",
 *     "以后都用中文回答", "prefer…", "call me…") are captured into the
 *     persona layer.
 *
 * Captured entries carry the `auto` tag, appear in the injected memory digest
 * immediately, and can be reviewed with memory_recall. Questions and ordinary
 * chat are ignored. Set DSH_LAYER_MEMORY_AUTO=0 (or false/off) to disable.
 */
import crypto from 'node:crypto';

export const AUTO_CAPTURE_ENV = 'DSH_LAYER_MEMORY_AUTO';
export const AUTO_TAG = 'auto';

const MAX_MESSAGE_CHARS = 4000;
const MAX_SCAN_CHARS = 8000;
const MAX_VALUE_CHARS = 600;
const MAX_SEGMENT_CHARS = 2000;
const MAX_PERSONA_SEGMENT_CHARS = 240;
const MAX_CANDIDATES_PER_MESSAGE = 5;
const MAX_CANDIDATES_PER_STEP = 8;
const SEEN_LIMIT = 4096;

const REMEMBER_RE =
  /(?:请|还|务必)?记住|记一下|记下来|别忘了?|备忘(?:一下)?|牢记|remember(?:\s+that)?|keep\s+in\s+mind(?:\s+that)?|don'?t\s+forget(?:\s+that)?|note\s+that/i;

const PERSONA_PATTERNS = [
  /我叫/,
  /我的(?:名字|昵称|称呼)/,
  /我(?:更)?(?:喜欢|偏好|习惯|讨厌|不喜欢)/,
  /我更希望/,
  /以后(?:都|请|就|一直)/,
  /从现在开始/,
  /今后(?:都|请|就)/,
  /(?:请|以后)(?:都|就)?(?:用|使用)?(?:中文|英文|简体中文|繁体中文)(?:回答|回复|交流|说话|解释|回复我)/,
  /(?:回答|回复|交流|说话|解释)(?:时|的时候)?(?:请|要|都|就)?(?:用|使用)(?:中文|英文|简体中文|繁体中文)/,
  /^(?:请|以后|今后)?(?:都|就)?(?:用|使用)(?:中文|英文|简体中文|繁体中文)(?:回答|回复|交流|说话|解释)/,
  /(?:不要|别)(?:再)?(?:用|使用)(?:中文|英文|简体中文|繁体中文)/,
  /(?:talk|speak|reply|respond)\s+(?:to\s+me\s+)?in\s+(?:chinese|english)/i,
  /prefer/i,
  /i\s+(?:like|love|hate|prefer|usually|always)/i,
  /call\s+me\s+\S+/i,
  /from\s+now\s+on/i,
  /my\s+name\s+is/i,
];

const QUESTION_RE = /[?？]\s*$|吗[。！!]?\s*$/;

/** Subagent delegation prompts are user messages too; do not harvest them. */
const SUBAGENT_BOILERPLATE_RE =
  /you are (?:an? )?(?:ai )?(?:subagent|assistant)|你是(?:一个)?(?:子|副)智能体/i;

/** Statements that describe something temporary get a short TTL. */
const TEMPORARY_RE =
  /今天|今晚|这次|此次|临时|暂时|先这样|就这一次|for today|tonight|this time|temporar(?:y|ily)/i;

/** Key words that suggest the entry belongs to one scenario only. */
const SCOPE_RULES = [
  { scope: 'coding', pattern: /代码|编程|程序|函数|接口|数据库|debug|bug|code|coding|typescript|javascript|python|rust|sql/i },
  { scope: 'chat', pattern: /聊天|闲聊|对话|chat|conversation/i },
  { scope: 'writing', pattern: /写作|文案|文章|报告|翻译|writing|article|report/i },
];

function inferScopes(value) {
  const text = String(value ?? '');
  const scopes = [];
  for (const rule of SCOPE_RULES) {
    if (rule.pattern.test(text) && !scopes.includes(rule.scope)) scopes.push(rule.scope);
  }
  return scopes;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDisabled(value) {
  const flag = String(value ?? '')
    .trim()
    .toLowerCase();
  return flag === '0' || flag === 'false' || flag === 'off' || flag === 'no';
}

function clip(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function cleanValue(raw) {
  const text = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text
    .replace(/^[\s，,、:：;；。.!！?？\-–—]+/, '')
    .replace(/[\s，,、:：;；。.!！?？\-–—]+$/, '');
}

/** Stable identifier derived from the captured content. */
function keyFor(content) {
  const normalized = content.toLowerCase().replace(/\s+/g, ' ').trim();
  const digest = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  return `auto-${digest}`;
}

function extractTextBlock(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const pieces = [];
    for (const block of content) {
      if (typeof block === 'string') pieces.push(block);
      else if (block && typeof block === 'object' && typeof block.text === 'string') pieces.push(block.text);
    }
    return pieces.join('\n');
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

/** Extract plain text from a Harness message-like object of unknown shape. */
export function extractMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  for (const candidate of [message.content, message.text, message.message]) {
    const text = extractTextBlock(candidate);
    if (text.trim() !== '') return text;
  }
  return '';
}

function splitSegments(text) {
  const source = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const segments = [];
  for (const line of source.split(/\r?\n+/)) {
    if (line.trim() === '') continue;
    for (const part of line.split(/(?<=[。！？!?；;])\s*/)) {
      const trimmed = part.trim();
      if (trimmed !== '') segments.push(trimmed);
    }
  }
  return segments;
}

function classifySegment(segment) {
  const remember = REMEMBER_RE.exec(segment);
  const persona = PERSONA_PATTERNS.some((pattern) => pattern.test(segment));
  if (remember === null && !persona) return null;
  if (QUESTION_RE.test(segment)) return null;
  if (remember === null && segment.length > MAX_PERSONA_SEGMENT_CHARS) return null;
  if (segment.length > MAX_SEGMENT_CHARS) return null;

  let content;
  if (remember !== null) {
    const before = segment.slice(0, remember.index).trim();
    const after = segment.slice(remember.index + remember[0].length).trim();
    content = cleanValue(after.length >= 2 ? after : before.length >= 2 ? before : segment);
  } else {
    content = cleanValue(segment);
  }
  if (content.length < 2) return null;

  const scopes = inferScopes(content);
  const temporary = TEMPORARY_RE.test(segment);

  return {
    key: keyFor(content),
    value: clip(content, MAX_VALUE_CHARS),
    type: persona ? 'persona' : 'fact',
    tags: remember !== null ? [AUTO_TAG, 'remember'] : [AUTO_TAG, 'preference'],
    ...(temporary ? { ttl: '1d' } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
  };
}

/** Turn one user message into zero or more memory candidates. */
export function extractCandidates(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];
  const candidates = [];
  const seen = new Set();
  for (const segment of splitSegments(text)) {
    const candidate = classifySegment(segment);
    if (candidate === null) continue;
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    candidates.push(candidate);
    if (candidates.length >= MAX_CANDIDATES_PER_MESSAGE) break;
  }
  return candidates;
}

/** Collect candidates from the `agent/pre-step` payload. */
export function collectCandidates(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  const candidates = [];
  const seen = new Set();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.role === 'string' && message.role !== 'user') continue;
    const text = extractMessageText(message);
    if (text.trim() === '') continue;
    if (text.length > MAX_MESSAGE_CHARS) continue;
    if (SUBAGENT_BOILERPLATE_RE.test(text)) continue;
    for (const candidate of extractCandidates(text)) {
      if (seen.has(candidate.key)) continue;
      seen.add(candidate.key);
      candidates.push(candidate);
      if (candidates.length >= MAX_CANDIDATES_PER_STEP) return candidates;
    }
  }
  return candidates;
}

async function captureAsync(store, logger, candidates) {
  for (const candidate of candidates) {
    try {
      const result = await store.store({
        key: candidate.key,
        value: candidate.value,
        type: candidate.type,
        tags: candidate.tags,
        scopes: candidate.scopes,
        ttl: candidate.ttl,
      });
      logger?.info?.(`[layer-memory] auto-captured ${result.entry.type} entry "${result.entry.key}"`);
    } catch (error) {
      logger?.warn?.(`[layer-memory] auto capture failed: ${messageOf(error)}`);
    }
  }
}

/**
 * Install the `agent/pre-step` hook. This event is a waterfall: every listener
 * must call `next()` and return its decision, otherwise downstream listeners
 * (and the Harness itself) receive `undefined` and the turn fails. The capture
 * work is started fire-and-forget so the waterfall is never delayed by disk IO.
 *
 * Returns the event disposer (or a no-op when auto capture is disabled through
 * the environment).
 */
export function installAutoCapture(ctx, store, options = {}) {
  const env = options.env ?? process.env;
  if (isDisabled(env[AUTO_CAPTURE_ENV])) {
    ctx.logger?.info?.(`[layer-memory] auto capture disabled by ${AUTO_CAPTURE_ENV}`);
    return () => {};
  }
  const logger = options.logger ?? ctx.logger;
  const seen = new Set();
  const handle = (payload, next) => {
    try {
      const candidates = collectCandidates(payload);
      const fresh = candidates.filter((candidate) => {
        const id = `${candidate.type}\u0000${candidate.key}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      if (seen.size > SEEN_LIMIT) seen.clear();
      if (fresh.length > 0) void captureAsync(store, logger, fresh);
    } catch (error) {
      logger?.warn?.(`[layer-memory] auto capture scan failed: ${messageOf(error)}`);
    }
    return typeof next === 'function' ? next() : undefined;
  };
  logger?.info?.('[layer-memory] auto capture enabled (set DSH_LAYER_MEMORY_AUTO=0 to disable)');
  return ctx.on('agent/pre-step', handle);
}
