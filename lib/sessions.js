/**
 * Read other DeepSeek Harness conversations ("sessions") and extract memory
 * candidates from their user messages.
 *
 * Session logs live under `$DSH_HOME/sessions/<workspace>/<uuid>/session.v4.jsonl.zstd`.
 * Each file is a concatenation of zstd frames (one frame per append batch), so
 * decoding scans for frame boundaries and decompresses one frame at a time.
 * Everything here is zero-dependency and read-only.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import zlib from 'node:zlib';

import { extractCandidates } from './autocapture.js';
import { LAYERS, normalizeLayer, normalizeScopes, normalizeTags, similarity } from './store.js';

export const SESSIONS_ROOT_ENV = 'DSH_LAYER_MEMORY_SESSIONS_DIR';
export const SESSION_FILE_SUFFIX = '.jsonl.zstd';
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const PREFIX_SCAN_BYTES = 256 * 1024;
const MAX_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_CANDIDATES = 40;
const DUPLICATE_SIMILARITY = 0.92;
const SUBAGENT_BOILERPLATE_RE = /you are[\s\S]{0,80}subagent|你是[\s\S]{0,40}子智能体/i;

function dshHome(env) {
  const override = env.DSH_HOME;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(homedir(), '.dsh');
}

/** Directory that stores every conversation log for this Harness home. */
export function resolveSessionsRoot(env = process.env) {
  const override = env[SESSIONS_ROOT_ENV];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  return join(dshHome(env), 'sessions');
}

function frameOffsets(buffer) {
  const offsets = [];
  let index = 0;
  while (index <= buffer.length - 4) {
    const found = buffer.indexOf(ZSTD_MAGIC, index);
    if (found < 0) break;
    offsets.push(found);
    index = found + 4;
  }
  return offsets;
}

/** Decompress every zstd frame in `buffer`; broken/partial trailing frames are ignored. */
export function decodeSessionBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { text: '', frames: 0, decoded: 0, failed: 0 };
  }
  if (typeof zlib.zstdDecompressSync !== 'function') {
    throw new Error('this Node.js runtime does not support zstd decompression');
  }
  const offsets = frameOffsets(buffer);
  const parts = [];
  let decoded = 0;
  let failed = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index];
    const end = index + 1 < offsets.length ? offsets[index + 1] : buffer.length;
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(start, end)));
      decoded += 1;
    } catch {
      failed += 1;
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, decoded, failed };
}

function parseJsonl(text) {
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch {
      // A torn trailing line is expected while the owning session is appending.
    }
  }
  return events;
}

async function readEvents(filePath) {
  const info = await stat(filePath);
  if (info.size > MAX_SESSION_BYTES) {
    throw new Error(`session log is too large to import (${info.size} bytes)`);
  }
  const buffer = await readFile(filePath);
  return { events: parseJsonl(decodeSessionBuffer(buffer).text), info };
}

function sessionHeader(events) {
  return events.find((event) => event.type === 'session') ?? null;
}

function sessionTitle(events) {
  let title = '';
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      title = event.data.title.trim();
    }
  }
  return title;
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) {
    if (content && typeof content.text === 'string') return content.text;
    return '';
  }
  const pieces = [];
  for (const block of content) {
    if (typeof block === 'string') pieces.push(block);
    else if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      pieces.push(block.text);
    }
  }
  return pieces.join('\n').trim();
}

async function readPrefixEvents(filePath, size) {
  const length = Math.min(size, PREFIX_SCAN_BYTES);
  if (length <= 0) return [];
  const handle = await readFile(filePath);
  const prefix = handle.subarray(0, length);
  return parseJsonl(decodeSessionBuffer(prefix).text);
}

function sessionIdOf(filePath, header) {
  if (typeof header?.id === 'string' && header.id !== '') return header.id;
  return basename(dirname(filePath));
}

function workspaceOf(filePath) {
  return basename(dirname(dirname(filePath)));
}

function metaOf(filePath, header, title, info) {
  return {
    id: sessionIdOf(filePath, header),
    title,
    cwd: typeof header?.cwd === 'string' ? header.cwd : '',
    createdAt: typeof header?.createdAt === 'number' ? new Date(header.createdAt).toISOString() : null,
    updatedAt: info ? new Date(info.mtimeMs).toISOString() : null,
    sizeBytes: info ? info.size : 0,
    workspace: workspaceOf(filePath),
  };
}

/** Scan `sessionsRoot` and return recent conversations, newest first. */
export async function listSessions(options = {}) {
  const sessionsRoot = options.sessionsRoot ?? resolveSessionsRoot(options.env ?? process.env);
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 20;
  let workspaces;
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return { sessionsRoot, sessions: [] };
  }
  const files = [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(sessionsRoot, workspace.name);
    let entries;
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = join(workspaceDir, entry.name);
      let names;
      try {
        names = await readdir(sessionDir);
      } catch {
        continue;
      }
      const fileName = names.find((name) => name.endsWith(SESSION_FILE_SUFFIX));
      if (fileName === undefined) continue;
      const filePath = join(sessionDir, fileName);
      try {
        const info = await stat(filePath);
        files.push({ filePath, info });
      } catch {
        continue;
      }
    }
  }
  files.sort((left, right) => right.info.mtimeMs - left.info.mtimeMs);
  const sessions = [];
  for (const { filePath, info } of files.slice(0, limit)) {
    let header = null;
    let title = '';
    try {
      const events = await readPrefixEvents(filePath, info.size);
      header = sessionHeader(events);
      title = sessionTitle(events);
    } catch {
      // Metadata is best effort; the id still comes from the directory name.
    }
    sessions.push(metaOf(filePath, header, title, info));
  }
  return { sessionsRoot, sessions };
}

/** Locate the session log for `sessionId` (accepts the id or the directory name). */
export async function findSessionFile(sessionId, options = {}) {
  const sessionsRoot = options.sessionsRoot ?? resolveSessionsRoot(options.env ?? process.env);
  const wanted = String(sessionId ?? '').trim();
  if (wanted === '') return null;
  let workspaces;
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = join(sessionsRoot, workspace.name);
    let entries;
    try {
      entries = await readdir(workspaceDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.includes(wanted)) continue;
      const sessionDir = join(workspaceDir, entry.name);
      let names;
      try {
        names = await readdir(sessionDir);
      } catch {
        continue;
      }
      const fileName = names.find((name) => name.endsWith(SESSION_FILE_SUFFIX));
      if (fileName !== undefined) return join(sessionDir, fileName);
    }
  }
  return null;
}

function isDuplicate(store, layer, candidate) {
  let entries;
  try {
    entries = store.entries(layer);
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.key === candidate.key) return true;
    if (typeof entry.value === 'string' && entry.value.trim().toLowerCase() === candidate.value.trim().toLowerCase()) {
      return true;
    }
    if (typeof entry.value === 'string' && similarity(entry.value, candidate.value) >= DUPLICATE_SIMILARITY) {
      return true;
    }
  }
  return false;
}

/** Extract memory candidates from one conversation log. */
export async function extractSessionMemories(store, filePath, options = {}) {
  const { events, info } = await readEvents(filePath);
  const header = sessionHeader(events);
  const title = sessionTitle(events);
  const session = metaOf(filePath, header, title, info);
  const maxCandidates =
    Number.isInteger(options.maxCandidates) && options.maxCandidates > 0 ? options.maxCandidates : MAX_CANDIDATES;
  const candidates = [];
  const seen = new Set();
  let userMessages = 0;
  let skippedDuplicates = 0;
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    // Real user messages carry `source.kind: 'user'`; the Harness also records
    // injected context blocks (runtime-context, time-context, plugin:*, ...) as
    // user messages — those must never be mined for memories.
    const sourceKind = event.data?.source?.kind;
    if (typeof sourceKind === 'string' && sourceKind !== 'user') continue;
    const text = messageText(event.data?.content).trim();
    if (text.length < 2) continue;
    userMessages += 1;
    if (text.length > MAX_MESSAGE_CHARS) continue;
    if (SUBAGENT_BOILERPLATE_RE.test(text)) continue;
    const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : null;
    for (const candidate of extractCandidates(text)) {
      if (seen.has(candidate.key)) continue;
      const layer = normalizeLayer(candidate.type);
      if (isDuplicate(store, layer, candidate)) {
        skippedDuplicates += 1;
        continue;
      }
      seen.add(candidate.key);
      candidates.push({
        ...candidate,
        source: {
          sessionId: session.id,
          title: session.title,
          updatedAt: session.updatedAt,
          messageAt: at,
          preview: text.slice(0, 200),
        },
      });
      if (candidates.length >= maxCandidates) break;
    }
    if (candidates.length >= maxCandidates) break;
  }
  return {
    session,
    candidates,
    scanned: { events: events.length, userMessages, skippedDuplicates },
  };
}

function importKey(value) {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();
  return `import-${createHash('sha1').update(normalized).digest('hex').slice(0, 10)}`;
}

/** Apply user-selected extracted candidates to the memory store. */
export async function importSessionCandidates(store, entries) {
  const list = Array.isArray(entries) ? entries : [];
  let imported = 0;
  let skipped = 0;
  const failures = [];
  for (const entry of list) {
    const value = typeof entry?.value === 'string' ? entry.value.trim() : '';
    if (value.length < 2) {
      skipped += 1;
      continue;
    }
    const layer = normalizeLayer(entry.type);
    const tags = normalizeTags(['import', 'session', ...(Array.isArray(entry.tags) ? entry.tags : [])]);
    const scopes = normalizeScopes(entry.scopes);
    const key =
      typeof entry.key === 'string' && entry.key.trim() !== '' ? entry.key.trim() : importKey(value);
    try {
      await store.store({ key, value, type: layer, tags, ...(scopes.length > 0 ? { scopes } : {}), ...(entry.ttl ? { ttl: entry.ttl } : {}) });
      imported += 1;
    } catch (error) {
      skipped += 1;
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { imported, skipped, failures };
}

// ---------------------------------------------------------------------------
// v1.5: conversation summaries ("对话摘要式导入").
// ---------------------------------------------------------------------------

const SUMMARY_MAX_MESSAGES = 80;
const SUMMARY_MAX_CHARS = 12_000;
const SUMMARY_KEYWORD_COUNT = 8;
const SUMMARY_PREFERENCE_LINES = 5;
const SUMMARY_RECENT_REQUESTS = 3;

const SUMMARY_STOPWORDS = new Set([
  '我们', '你们', '他们', '这个', '那个', '这些', '那些', '可以', '就是', '什么', '因为', '所以',
  '然后', '现在', '一个', '没有', '不是', '还是', '需要', '这样', '已经', '如果', '但是', '而且',
  '或者', '以及', '还有', '一下', '一些', '的话', '自己', '其实', '可能', '应该', '知道', '觉得',
  '希望', '谢谢', '好的', '嗯嗯', '就是', '这这', '那个', '怎么', '为什么', '看看', '试着', '帮我',
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'are', 'was', 'but', 'not', 'have', 'from',
]);

function sessionMessagesFromEvents(events, options = {}) {
  const maxMessages =
    Number.isInteger(options.maxMessages) && options.maxMessages > 0 ? options.maxMessages : SUMMARY_MAX_MESSAGES;
  const messages = [];
  for (const event of events) {
    const at = typeof event.time === 'number' ? new Date(event.time).toISOString() : null;
    if (event.type === 'user/message') {
      // Skip injected context blocks (runtime-context, time-context, plugin:* …).
      const sourceKind = event.data?.source?.kind;
      if (typeof sourceKind === 'string' && sourceKind !== 'user') continue;
      const text = messageText(event.data?.content).trim();
      if (text.length < 2) continue;
      if (SUBAGENT_BOILERPLATE_RE.test(text)) continue;
      messages.push({ role: 'user', text, at });
    } else if (event.type === 'assistant/message') {
      // Only visible text blocks; reasoning and tool calls are not part of a summary.
      const text = messageText(event.data?.message?.content).trim();
      if (text.length < 2) continue;
      messages.push({ role: 'assistant', text, at });
    }
  }
  return messages.length > maxMessages ? messages.slice(-maxMessages) : messages;
}

/** Read the visible messages (user + assistant text) of one conversation log. */
export async function readSessionMessages(filePath, options = {}) {
  const { events } = await readEvents(filePath);
  return sessionMessagesFromEvents(events, options);
}

/** Build a bounded `用户：… / 助手：…` transcript, keeping the most recent turns. */
export function buildTranscript(messages, options = {}) {
  const maxChars =
    Number.isInteger(options.maxChars) && options.maxChars > 0 ? options.maxChars : SUMMARY_MAX_CHARS;
  const pieces = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const text = message.text.length > 2000 ? `${message.text.slice(0, 2000)}…` : message.text;
    const line = `${message.role === 'user' ? '用户' : '助手'}：${text}`;
    if (total + line.length + 2 > maxChars && pieces.length > 0) break;
    pieces.push(line);
    total += line.length + 2;
  }
  return pieces.reverse().join('\n\n');
}

const KEYWORD_RE = /[\u4e00-\u9fff]{2,6}|[A-Za-z][A-Za-z0-9_-]{2,}/g;
const PREFERENCE_RE = /(喜欢|偏好|习惯|以后|今后|请用|不要|别用|记住|我的|我是|叫我|用中文|用英文|回答|回复)/;
const SENTENCE_SPLIT_RE = /[\n。；;]/;

function collectKeywords(messages) {
  const counts = new Map();
  for (const message of messages) {
    const matches = String(message.text).match(KEYWORD_RE) ?? [];
    for (const match of matches) {
      const word = match.trim();
      if (word.length < 2) continue;
      const lower = word.toLowerCase();
      if (SUMMARY_STOPWORDS.has(lower)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])
    .slice(0, SUMMARY_KEYWORD_COUNT)
    .map(([word]) => word);
}

function collectPreferenceLines(messages) {
  const lines = [];
  const seen = new Set();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    for (const piece of String(message.text).split(SENTENCE_SPLIT_RE)) {
      const line = piece.trim();
      if (line.length < 2 || line.length > 240) continue;
      if (!PREFERENCE_RE.test(line)) continue;
      const key = line.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line.length > 120 ? `${line.slice(0, 120)}…` : line);
      if (lines.length >= SUMMARY_PREFERENCE_LINES) return lines;
    }
  }
  return lines;
}

function recentUserRequests(messages) {
  const requests = [];
  for (let index = messages.length - 1; index >= 0 && requests.length < SUMMARY_RECENT_REQUESTS; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const first = String(message.text).split('\n')[0].trim();
    if (first === '') continue;
    requests.push(first.length > 160 ? `${first.slice(0, 160)}…` : first);
  }
  return requests.reverse();
}

/** Heuristic, zero-dependency summary of one conversation. */
export function extractiveSummary({ session, messages }) {
  const userMessages = messages.filter((message) => message.role === 'user').length;
  const assistantMessages = messages.filter((message) => message.role === 'assistant').length;
  const keywords = collectKeywords(messages);
  const preferences = collectPreferenceLines(messages);
  const requests = recentUserRequests(messages);
  const lines = [`【对话摘要】${session?.title || '未命名对话'}`];
  lines.push(`更新时间：${session?.updatedAt || '未知'}`);
  lines.push(`规模：${userMessages} 条用户消息、${assistantMessages} 条助手回复`);
  lines.push(`关键词：${keywords.length > 0 ? keywords.join('、') : '（无）'}`);
  lines.push('偏好与要求：');
  if (preferences.length === 0) lines.push('- （未识别到明确偏好）');
  else for (const line of preferences) lines.push(`- ${line}`);
  lines.push('最近请求：');
  if (requests.length === 0) lines.push('- （无）');
  else for (const line of requests) lines.push(`- ${line}`);
  return {
    mode: 'extractive',
    text: lines.join('\n'),
    keywords,
    stats: { userMessages, assistantMessages, messages: messages.length },
  };
}

// ---------------------------------------------------------------------------
// v1.6: work-progress summaries ("工作进度摘要").
// ---------------------------------------------------------------------------

const PROGRESS_MAX_ACTIONS = 8;
const PROGRESS_MAX_FILES = 8;
const PROGRESS_MAX_TODOS = 6;

const TOOL_VERBS = new Map([
  ['write', '写文件'],
  ['edit', '编辑文件'],
  ['read', '读取'],
  ['read_image', '读取图片'],
  ['bash', '执行命令'],
  ['pwsh', '执行命令'],
  ['glob', '查找文件'],
  ['grep', '搜索内容'],
  ['memory_store', '写入记忆'],
  ['memory_recall', '检索记忆'],
  ['memory_export', '导出记忆'],
  ['memory_import', '导入记忆'],
  ['todo_write', '更新待办计划'],
  ['present', '交付文件'],
  ['web_search', '搜索网页'],
  ['web_fetch', '抓取网页'],
  ['compress', '整理上下文'],
  ['decompress', '还原上下文'],
  ['subagent', '派发子任务'],
  ['subagent_fork', '派发子任务'],
  ['workflow', '运行工作流'],
  ['spawn_teammate', '创建协作代理'],
  ['send_message', '发送协作消息'],
]);

const TOOL_ARG_FIELDS = [
  'file_path',
  'path',
  'filePath',
  'command',
  'query',
  'pattern',
  'url',
  'key',
  'name',
  'title',
  'inputPath',
  'outputPath',
];

/** Argument fields that actually reference a file or directory (not commands/queries). */
const PATH_FIELDS = ['file_path', 'path', 'filePath', 'inputPath', 'outputPath'];

function parseToolArguments(value) {
  if (typeof value !== 'string' || value.trim() === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function looksLikePath(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value);
}

function describeToolAction(call) {
  const name = typeof call?.data?.name === 'string' && call.data.name !== '' ? call.data.name : 'tool';
  const args = parseToolArguments(call?.data?.arguments);
  const verb = TOOL_VERBS.get(name) ?? name;
  let detail = '';
  for (const field of TOOL_ARG_FIELDS) {
    const value = args[field];
    if (typeof value === 'string' && value.trim() !== '') {
      detail = value.trim();
      break;
    }
  }
  let file = null;
  for (const field of PATH_FIELDS) {
    const value = args[field];
    if (looksLikePath(value)) {
      file = value;
      break;
    }
  }
  return {
    name,
    verb,
    detail: detail.length > 120 ? `${detail.slice(0, 120)}…` : detail,
    file,
    at: typeof call?.time === 'number' ? new Date(call.time).toISOString() : null,
  };
}

function collectProgress(events) {
  const calls = [];
  let todos = null;
  let firstUserText = null;
  const userRequests = [];
  const assistantTexts = [];
  for (const event of events) {
    if (event?.type === 'tool/call') {
      calls.push(event);
    } else if (event?.type === 'todo/write' && Array.isArray(event?.data?.todos)) {
      todos = event.data.todos.filter(
        (todo) => todo !== null && typeof todo === 'object' && typeof todo.content === 'string',
      );
    } else if (event?.type === 'user/message') {
      const sourceKind = event.data?.source?.kind;
      if (typeof sourceKind === 'string' && sourceKind !== 'user') continue;
      const text = messageText(event.data?.content).trim();
      if (text.length < 2 || SUBAGENT_BOILERPLATE_RE.test(text)) continue;
      if (firstUserText === null) firstUserText = text;
      userRequests.push(text);
    } else if (event?.type === 'assistant/message') {
      const text = messageText(event.data?.message?.content).trim();
      if (text.length >= 2) assistantTexts.push(text);
    }
  }
  const files = [];
  for (const call of calls.slice(-40)) {
    const args = parseToolArguments(call?.data?.arguments);
    for (const field of PATH_FIELDS) {
      const value = args[field];
      if (looksLikePath(value) && !files.includes(value)) files.push(value);
    }
    if (files.length >= PROGRESS_MAX_FILES) break;
  }
  return {
    actions: calls.slice(-PROGRESS_MAX_ACTIONS).map(describeToolAction),
    totalToolCalls: calls.length,
    todos,
    firstUserText,
    userRequests: userRequests.slice(-3),
    lastAssistantText: assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] : null,
    files: files.slice(0, PROGRESS_MAX_FILES),
  };
}

function todoGroups(todos) {
  const groups = { completed: [], inProgress: [], pending: [], other: [] };
  for (const todo of todos ?? []) {
    const content = String(todo?.content ?? '').trim();
    if (content === '') continue;
    const status = typeof todo?.status === 'string' ? todo.status : '';
    if (status === 'completed') groups.completed.push(content);
    else if (status === 'in_progress' || status === 'in-progress') groups.inProgress.push(content);
    else if (status === 'pending') groups.pending.push(content);
    else groups.other.push(content);
  }
  return groups;
}

function firstLineClip(value, max) {
  const line = String(value).split('\n')[0].trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Heuristic, zero-dependency work-progress summary of one conversation. */
export function extractiveProgressSummary({ session, events, messages }) {
  const visible = Array.isArray(messages) ? messages : sessionMessagesFromEvents(events);
  const progress = collectProgress(events);
  const groups = todoGroups(progress.todos);
  const totalTodos =
    groups.completed.length + groups.inProgress.length + groups.pending.length + groups.other.length;
  const keywords = collectKeywords(visible);
  const preferences = collectPreferenceLines(visible);
  const userMessages = visible.filter((message) => message.role === 'user').length;
  const lines = [`【工作进度摘要】${session?.title || '未命名对话'}`];
  lines.push(`更新时间：${session?.updatedAt || '未知'}`);
  lines.push(
    `规模：${userMessages} 条用户消息、${progress.totalToolCalls} 次工具调用` +
      (totalTodos > 0 ? `、待办 ${groups.completed.length}/${totalTodos} 完成` : ''),
  );
  lines.push(`任务：${progress.firstUserText !== null ? firstLineClip(progress.firstUserText, 160) : session?.title || '（未识别）'}`);
  if (totalTodos === 0) {
    lines.push('待办进度：（本对话没有待办清单记录）');
  } else {
    lines.push(
      `待办进度：完成 ${groups.completed.length} · 进行中 ${groups.inProgress.length} · 待办 ${groups.pending.length}`,
    );
    if (groups.completed.length > 0) {
      lines.push('已完成：');
      for (const item of groups.completed.slice(0, PROGRESS_MAX_TODOS)) lines.push(`- ${item}`);
    }
    if (groups.inProgress.length > 0) {
      lines.push('进行中：');
      for (const item of groups.inProgress.slice(0, PROGRESS_MAX_TODOS)) lines.push(`- ${item}`);
    }
    if (groups.pending.length > 0) {
      lines.push('待办：');
      for (const item of groups.pending.slice(0, PROGRESS_MAX_TODOS)) lines.push(`- ${item}`);
    }
  }
  lines.push('最近动作：');
  const seenActions = new Set();
  const recentActions = [];
  for (const action of [...progress.actions].reverse()) {
    const actionKey = `${action.verb}\u0000${action.detail}`;
    if (seenActions.has(actionKey)) continue;
    seenActions.add(actionKey);
    recentActions.push(action);
    if (recentActions.length >= PROGRESS_MAX_ACTIONS) break;
  }
  recentActions.reverse();
  if (recentActions.length === 0) lines.push('- （无）');
  else for (const action of recentActions) lines.push(`- ${action.verb}${action.detail !== '' ? `：${action.detail}` : ''}`);
  lines.push('涉及文件：');
  if (progress.files.length === 0) lines.push('- （无）');
  else for (const file of progress.files) lines.push(`- ${file}`);
  const allDone = totalTodos > 0 && groups.completed.length === totalTodos;
  const next =
    groups.inProgress[0] ??
    groups.pending[0] ??
    (allDone
      ? `待办已全部完成（${groups.completed.length}/${totalTodos}），可复核产物并进入下一阶段`
      : progress.lastAssistantText !== null
        ? firstLineClip(progress.lastAssistantText, 160)
        : '继续当前任务');
  lines.push(`下一步：${next}`);
  if (progress.lastAssistantText !== null) lines.push(`最近进展：${firstLineClip(progress.lastAssistantText, 180)}`);
  lines.push('偏好与要求：');
  if (preferences.length === 0) lines.push('- （未识别到明确偏好）');
  else for (const line of preferences) lines.push(`- ${line}`);
  lines.push(`关键词：${keywords.length > 0 ? keywords.join('、') : '（无）'}`);
  return {
    mode: 'extractive',
    kind: 'progress',
    text: lines.join('\n'),
    keywords,
    todos: {
      completed: groups.completed.length,
      inProgress: groups.inProgress.length,
      pending: groups.pending.length,
      total: totalTodos,
    },
    stats: { userMessages, toolCalls: progress.totalToolCalls, files: progress.files.length },
  };
}

function buildProgressContext(events) {
  const progress = collectProgress(events);
  const groups = todoGroups(progress.todos);
  const lines = [];
  const todoCount =
    groups.completed.length + groups.inProgress.length + groups.pending.length + groups.other.length;
  if (todoCount > 0) {
    lines.push('待办清单：');
    for (const item of groups.completed) lines.push(`- [已完成] ${item}`);
    for (const item of groups.inProgress) lines.push(`- [进行中] ${item}`);
    for (const item of groups.pending) lines.push(`- [待办] ${item}`);
    for (const item of groups.other) lines.push(`- ${item}`);
  }
  if (progress.actions.length > 0) {
    lines.push('最近工具动作：');
    for (const action of progress.actions) {
      lines.push(`- ${action.verb}${action.detail !== '' ? `：${action.detail}` : ''}`);
    }
  }
  if (progress.files.length > 0) {
    lines.push('涉及文件：');
    for (const file of progress.files) lines.push(`- ${file}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// v1.7: atomic handoff entries ("项目交接条目").
//
// The digest injected into every conversation clips each entry to 180
// characters, so one long handoff summary is mostly invisible in a fresh
// conversation. The generation layer therefore emits *many short entries*
// instead: every entry fits the clip and survives into later conversations.
// The model prompt also bans transient noise (token balances, retries, timings)
// and requires separating "deliverables are done" from "data collection gaps".
// ---------------------------------------------------------------------------

const HANDOFF_MAX_ENTRY_CHARS = 180;
const HANDOFF_MAX_ENTRIES = 12;
const HANDOFF_NOISE_RE = /(余额|credits?|token\s*(?:额度|余额|有效期)|重试|retry|耗时\s*\d|took\s+\d+)/i;
const HANDOFF_DATA_GAP_RE = /(缺口|缺\s*\d+\s*天|缺数据|未完成|待补|待采集|额度耗尽|采集中断)/;

function clipChars(value, max) {
  const text = String(value ?? '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function handoffEntry(key, value, tags = []) {
  const text = clipChars(value, HANDOFF_MAX_ENTRY_CHARS);
  if (text === '' || HANDOFF_NOISE_RE.test(text)) return null;
  return {
    key,
    value: text,
    type: 'fact',
    tags: ['import', 'session', 'handoff', ...tags],
  };
}

/** Deterministic atomic handoff entries (used when the model is unavailable). */
export function extractiveHandoffEntries({ session, events, messages }) {
  const visible = Array.isArray(messages) ? messages : sessionMessagesFromEvents(events);
  const progress = collectProgress(events);
  const groups = todoGroups(progress.todos);
  const totalTodos =
    groups.completed.length + groups.inProgress.length + groups.pending.length + groups.other.length;
  const entries = [];
  const push = (key, value, tags) => {
    const entry = handoffEntry(key, value, tags);
    if (entry === null) return;
    if (entries.some((candidate) => candidate.key === entry.key)) return;
    entries.push(entry);
  };
  const title = session?.title || '未命名对话';
  push(
    'handoff-task',
    `任务：${progress.firstUserText !== null ? firstLineClip(progress.firstUserText, 150) : title}`,
    ['task'],
  );
  if (progress.files.length > 0) {
    push('handoff-artifacts', `涉及文件：${progress.files.slice(0, 5).join('；')}`, ['files']);
  }
  if (groups.completed.length > 0) {
    push(
      'handoff-done',
      `已完成（${groups.completed.length}/${totalTodos}）：${groups.completed.slice(0, 5).join('；')}`,
      ['done'],
    );
  }
  const allDone = totalTodos > 0 && groups.completed.length === totalTodos;
  const next = groups.inProgress[0] ?? groups.pending[0] ?? (allDone ? '交付物已产出，可复核并进入下一阶段' : null);
  if (next !== null) push('handoff-next', `下一步：${firstLineClip(next, 150)}`, ['next']);
  const gapLines = [];
  for (const message of visible) {
    if (message.role !== 'user') continue;
    for (const piece of String(message.text).split(SENTENCE_SPLIT_RE)) {
      const line = piece.trim();
      if (line.length < 4 || line.length > 180) continue;
      if (!HANDOFF_DATA_GAP_RE.test(line)) continue;
      if (HANDOFF_NOISE_RE.test(line)) continue;
      if (gapLines.includes(line)) continue;
      gapLines.push(line);
      if (gapLines.length >= 2) break;
    }
    if (gapLines.length >= 2) break;
  }
  if (gapLines.length > 0) push('handoff-data-gaps', `数据侧待补：${gapLines.join('；')}`, ['data']);
  const preferences = collectPreferenceLines(visible).slice(0, 3);
  if (preferences.length > 0) push('handoff-preferences', `偏好与要求：${preferences.join('；')}`, ['preference']);
  const keywords = collectKeywords(visible).slice(0, 6);
  if (keywords.length > 0) push('handoff-keywords', `关键词：${keywords.join('、')}`, ['keywords']);
  return entries.slice(0, HANDOFF_MAX_ENTRIES);
}

/** Split a plain-text summary into atomic entries when no structured output exists. */
export function chunkIntoHandoffEntries(text, prefix = 'handoff') {
  const pieces = String(text ?? '')
    .split(/\n+/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line !== '' && !HANDOFF_NOISE_RE.test(line));
  const entries = [];
  for (const piece of pieces) {
    let rest = piece;
    while (rest !== '') {
      const chunk = clipChars(rest, HANDOFF_MAX_ENTRY_CHARS);
      entries.push({
        key: `${prefix}-${String(entries.length + 1).padStart(2, '0')}`,
        value: chunk,
        type: 'fact',
        tags: ['import', 'session', 'handoff'],
      });
      rest = rest.slice(chunk.length).trim();
      if (entries.length >= HANDOFF_MAX_ENTRIES) return entries;
    }
  }
  return entries;
}

function extractJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** Parse the model's JSON array of atomic handoff entries; returns null if malformed. */
export function parseHandoffEntries(text) {
  const raw = extractJsonArray(String(text ?? ''));
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries = [];
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue;
    const value = clipChars(typeof item.value === 'string' ? item.value : '', HANDOFF_MAX_ENTRY_CHARS);
    if (value === '' || HANDOFF_NOISE_RE.test(value)) continue;
    const type = LAYERS.includes(item.type) ? item.type : 'fact';
    const key =
      typeof item.key === 'string' && item.key.trim() !== ''
        ? item.key.trim().slice(0, 60)
        : `handoff-${String(entries.length + 1).padStart(2, '0')}`;
    const tags = Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string') : [];
    entries.push({ key, value, type, tags: ['import', 'session', 'handoff', ...tags] });
    if (entries.length >= HANDOFF_MAX_ENTRIES) break;
  }
  return entries;
}

const HANDOFF_SYSTEM_PROMPT =
  '你是 DeepSeek Harness 的项目交接记忆工程师。你把一段工作对话提炼成一组可长期保存、能被后续对话直接复用的原子记忆。你只输出紧凑、合法的 JSON 数组，不输出任何推理过程或解释文字。';

const HANDOFF_PROMPT_TAIL = `要求：
1. 只输出一个 JSON 数组，不要 Markdown 代码块、不要解释性文字。数组每项格式：
   {"key": "handoff-task 之类的短键", "value": "一条记忆正文", "type": "fact", "tags": ["task"]}
2. 必须是能被 JSON.parse 直接解析的合法 JSON：单行紧凑输出，不要换行缩进、不要注释、不要尾逗号，字符串统一用英文双引号。
3. 输出 4 到 8 条，每条 value 不超过 150 个字符（含路径和数字；超过 180 字符会在自动注入摘要里被截断）。
4. 必须覆盖（有就写、没有就省略）：任务目标；最终产物与文件路径（从对话里找已经交付的 docx/pptx/xlsx/pdf/csv/png 等完整路径）；已完成（合并成一条）；下一步/待办（合并成一条）；数据或外部依赖的状态与缺口；用户偏好与约束（合并成一条）。
5. 严禁写入易变或无关信息：token/余额/额度/耗时/重试/日志/临时目录/API key 等。
6. 必须区分「交付物已完成」与「数据采集还有缺口」：数据侧问题写成“数据侧待补：…”，不要因此写成整个项目“未完成/未做完”；全篇不得自相矛盾。
7. 不要编造对话中没有出现过的信息；没有把握的路径不要写。`;

/** Pick the first usable provider/model pair advertised by the Harness llm service. */
export async function resolveDefaultModel(llm) {
  if (llm === undefined || llm === null) throw new Error('llm service is unavailable');
  const providers = llm.listProviders();
  if (!Array.isArray(providers) || providers.length === 0) throw new Error('no LLM provider is configured');
  const provider = providers.find((candidate) => candidate?.id === 'deepseek-account') ?? providers[0];
  if (typeof provider?.id !== 'string' || provider.id === '') throw new Error('no usable LLM provider');
  const models = await llm.listModels(provider.id);
  if (!Array.isArray(models) || models.length === 0) throw new Error(`no models for provider ${provider.id}`);
  const model = models.find((candidate) => candidate?.id === 'deepseek-flash') ?? models[0];
  if (typeof model?.id !== 'string' || model.id === '') throw new Error(`no usable model for provider ${provider.id}`);
  return { provider: provider.id, model: model.id, providerName: provider.name ?? provider.id, modelName: model.name ?? model.id };
}

const SUMMARY_SYSTEM_PROMPT =
  '你是 DeepSeek Harness 的记忆整理助手，会把一段对话压缩成简洁、准确、可长期保存的中文记忆摘要。';
const SUMMARY_PROMPT_TAIL = `要求：
1. 用中文，只输出摘要正文，不要标题、不要 Markdown 代码块。
2. 概括对话主题、用户身份与偏好、已达成的决定与结论、未完成事项。
3. 不超过 220 字；不要编造对话中没有出现过的信息。`;

const PROGRESS_SYSTEM_PROMPT =
  '你是 DeepSeek Harness 的工作交接助手，会把一段对话整理成便于接手继续工作的中文进度摘要。';
const PROGRESS_PROMPT_TAIL = `要求：
1. 用中文，只输出摘要正文，不要标题、不要 Markdown 代码块。
2. 按「任务目标 / 已完成 / 当前状态与进行中 / 下一步 / 涉及文件或关键决定」的顺序组织，尽量短。
3. 不要编造对话中没有出现过的信息；没有涉及的项可以省略。`;

/** Ask the Harness llm service for a summarized memory of one conversation. */
export async function llmSummary(llm, options = {}) {
  if (llm === undefined || llm === null) throw new Error('llm service is unavailable');
  const transcript = typeof options.transcript === 'string' ? options.transcript.trim() : '';
  if (transcript === '') throw new Error('transcript is empty');
  const kind =
    options.kind === 'progress' ? 'progress' : options.kind === 'handoff' ? 'handoff' : 'conversation';
  let provider = typeof options.provider === 'string' && options.provider.trim() !== '' ? options.provider.trim() : null;
  let model = typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : null;
  if (provider === null || model === null) {
    const resolved = await resolveDefaultModel(llm);
    provider = provider ?? resolved.provider;
    model = model ?? resolved.model;
  }
  const maxTokens =
    Number.isInteger(options.maxTokens) && options.maxTokens > 0
      ? options.maxTokens
      : kind === 'handoff'
        ? 3000
        : kind === 'progress'
          ? 1600
          : 1200;
  const context =
    (kind === 'progress' || kind === 'handoff') &&
    typeof options.progressContext === 'string' &&
    options.progressContext.trim() !== ''
      ? `\n参考信息（从会话日志自动提取，可能不完整）：\n${options.progressContext.trim()}\n`
      : '';
  const prompt =
    kind === 'handoff'
      ? `请把下面这段对话整理成一组项目交接用的原子记忆。\n\n对话标题：${options.title || '未命名对话'}\n${context}\n${HANDOFF_PROMPT_TAIL}\n\n对话内容：\n${transcript}`
      : kind === 'progress'
        ? `请把下面这段对话整理成一份工作进度与交接摘要。\n\n对话标题：${options.title || '未命名对话'}\n${context}\n${PROGRESS_PROMPT_TAIL}\n\n对话内容：\n${transcript}`
        : `请把下面这段对话整理成一条记忆摘要。\n\n对话标题：${options.title || '未命名对话'}\n\n${SUMMARY_PROMPT_TAIL}\n\n对话内容：\n${transcript}`;
  const chunks = [];
  const blockTexts = [];
  let reasoningChars = 0;
  let usage = null;
  let finish = null;
  for await (const chunk of llm.stream({
    provider,
    model,
    system:
      kind === 'handoff'
        ? HANDOFF_SYSTEM_PROMPT
        : kind === 'progress'
          ? PROGRESS_SYSTEM_PROMPT
          : SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens,
    temperature: 0.2,
    ...(options.signal ? { signal: options.signal } : {}),
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text);
    else if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length;
    else if (
      chunk?.type === 'block-end' &&
      chunk.block?.type === 'text' &&
      typeof chunk.block.text === 'string' &&
      chunk.block.text !== ''
    ) {
      blockTexts.push(chunk.block.text);
    } else if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage;
    else if (chunk?.type === 'finish') finish = chunk;
  }
  // The llm service reports adapter/dispatch failures as a terminal `finish`
  // chunk instead of throwing, so surface that reason before looking at text.
  const reason = finish?.reason ?? null;
  if (reason?.kind === 'error') {
    const failure = reason.failure ?? {};
    const code = typeof failure.code === 'string' && failure.code !== '' ? ` [${failure.code}]` : '';
    const message =
      typeof failure.message === 'string' && failure.message !== '' ? failure.message : 'the model call failed';
    throw new Error(`model call failed${code}: ${message}`);
  }
  if (reason?.kind === 'aborted') throw new Error('the model call was aborted');
  const streamed = chunks.join('');
  const text = (streamed.trim() === '' && blockTexts.length > 0 ? blockTexts.join('') : streamed).trim();
  if (text === '') {
    if (reasoningChars > 0) {
      throw new Error(
        `the model produced ${reasoningChars} characters of reasoning but no summary text; try a larger maxTokens or a non-reasoning model`,
      );
    }
    if (reason?.kind === 'max-tokens') throw new Error('the model hit its token limit before producing a summary');
    throw new Error('the model returned an empty summary');
  }
  if (kind === 'handoff') {
    const entries = parseHandoffEntries(text);
    if (entries === null || entries.length === 0) {
      throw new Error(
        'the model did not return a valid JSON array of handoff entries; retry the model summary or use the local heuristic',
      );
    }
    return {
      mode: 'llm',
      kind,
      text,
      entries,
      provider,
      model,
      ...(usage !== null ? { usage } : {}),
    };
  }
  return { mode: 'llm', kind, text, provider, model, ...(usage !== null ? { usage } : {}) };
}

/** Summarize one conversation: heuristic by default, or via the llm service on request. */
export async function summarizeSession(store, filePath, options = {}) {
  const { events, info } = await readEvents(filePath);
  const header = sessionHeader(events);
  const title = sessionTitle(events);
  const session = metaOf(filePath, header, title, info);
  const messages = sessionMessagesFromEvents(events);
  const mode = options.mode === 'llm' ? 'llm' : 'extractive';
  const kind =
    options.kind === 'progress' ? 'progress' : options.kind === 'handoff' ? 'handoff' : 'conversation';
  let summary;
  if (mode === 'llm') {
    const transcript = buildTranscript(messages);
    if (transcript === '') throw new Error('this conversation has no readable messages');
    summary = await llmSummary(options.llm, {
      kind,
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens,
      transcript,
      title: session.title,
      progressContext: kind === 'progress' || kind === 'handoff' ? buildProgressContext(events) : '',
      signal: options.signal,
    });
  } else if (kind === 'handoff') {
    const entries = extractiveHandoffEntries({ session, events, messages });
    summary = {
      mode: 'extractive',
      kind: 'handoff',
      text: entries.map((entry) => `${entry.key}: ${entry.value}`).join('\n'),
      entries,
      keywords: collectKeywords(messages),
    };
  } else {
    summary =
      kind === 'progress'
        ? extractiveProgressSummary({ session, events, messages })
        : extractiveSummary({ session, messages });
  }
  if (kind === 'handoff') {
    const entries =
      Array.isArray(summary.entries) && summary.entries.length > 0
        ? summary.entries.slice(0, HANDOFF_MAX_ENTRIES)
        : null;
    if (entries === null) {
      // Never slice raw model text into entries: JSON fragments are useless as memories.
      // The caller (HTTP layer) falls back to the deterministic local entries instead.
      throw new Error('handoff entries are unavailable');
    }
    summary = { ...summary, entries };
    const candidates = entries;
    return {
      session,
      mode: summary.mode,
      kind,
      summary,
      candidate: candidates[0],
      candidates,
    };
  }
  const candidate = {
    key: `${kind === 'progress' ? 'progress' : 'summary'}-${session.id}`,
    value: summary.text,
    type: 'fact',
    tags: ['import', 'session', kind === 'progress' ? 'progress' : 'summary'],
  };
  return { session, mode: summary.mode, kind, summary, candidate, candidates: [candidate] };
}

/** Report whether a usable llm service (and which providers) is available right now. */
export function describeLlm(llm) {
  if (llm === undefined || llm === null) return { available: false, providers: [] };
  try {
    const providers = (llm.listProviders() ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
    }));
    return { available: providers.length > 0, providers };
  } catch (error) {
    return { available: false, providers: [], error: error instanceof Error ? error.message : String(error) };
  }
}
