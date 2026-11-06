/**
 * Layer Memory — a Host-only DeepSeek Harness plugin.
 *
 * Provides the layered memory store (`working`, `persona`, `fact`), the four
 * memory tools, automatic memory extraction from user messages, a system
 * prompt digest, and a small same-origin HTTP API used by the settings page.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { installAutoCapture } from './lib/autocapture.js';
import { extractMessageText } from './lib/autocapture.js';
import { API_PREFIX, DASHBOARD_ROUTE_PATH, autoCaptureEnabled, buildDashboardState } from './lib/dashboard.js';
import { injectionMessage, promptHash, rankEntries, renderRecallBlock } from './lib/relevance.js';
import { LAYERS, LayerMemoryStore, renderDigest, resolveDataRoot } from './lib/store.js';
import {
  describeLlm,
  extractSessionMemories,
  findSessionFile,
  importSessionCandidates,
  listSessions,
  resolveSessionsRoot,
  summarizeSession,
} from './lib/sessions.js';
import { createMemoryTools } from './lib/tools.js';

export const name = 'layer-memory';
export const inject = ['tools'];

const GUIDANCE_TEXT = [
  'Layer memory is enabled for this profile. It persists across sessions in three layers:',
  '- persona: durable user preferences, traits, and communication style;',
  '- working: short-term scratch notes that are archived into fact when the layer is full;',
  '- fact: durable factual knowledge, decisions, and project context.',
  'Use memory_store to save something worth remembering (options: type, tags, scopes, ttl) and memory_recall to look things up before asking the user to repeat them.',
  'A query-aware recall gate injects a small "<layer-memory-recall>" block into the prompt when current messages clearly match durable entries; it prefers identifier/CJK discriminator matches over generic word overlap and never injects the same block twice for the same prompt (set DSH_LAYER_MEMORY_RECALL_GATE=0 to disable).',
  'Entries may carry a TTL (e.g. "7d") for temporary preferences, and scenario scopes (e.g. ["coding", "chat"]) so they are only injected in matching scenarios.',
  'After a non-trivial bug, incident or slow workflow, record a retrospective with memory_retro (symptom, root cause, fix, lesson, prevention, time cost). Retrospectives are excluded from the automatic digest so they never crowd out durable facts; read them back with memory_retro action "list" or the settings dashboard.',
].join('\n');

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, JSON_HEADERS);
  res.end(body);
}

function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('request body too large'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('request body must be valid JSON'));
      }
    });
  });
}

async function applyEntryAction(store, body) {
  const op = String(body?.op ?? '').trim();
  if (op === 'store') {
    return store.store({
      key: body.key,
      value: body.value,
      type: body.type,
      tags: body.tags,
      scopes: body.scopes,
      ttl: body.ttl,
    });
  }
  if (op === 'update') {
    return store.updateEntry(body.type, body.key, {
      value: body.value,
      tags: body.tags,
      scopes: body.scopes,
      ttl: body.ttl,
      enabled: body.enabled,
    });
  }
  if (op === 'delete') {
    return { removed: await store.remove(body.type, body.key) };
  }
  if (op === 'toggle') {
    return store.setEnabled(body.type, body.key, body.enabled !== false);
  }
  if (op === 'merge') {
    return store.mergeEntries(body.layer ?? body.type, body.keys, { value: body.value });
  }
  throw new Error(`unknown op "${op}"`);
}

/** Best-effort diagnostic snapshot; a failed route registration must leave a trace on disk. */
async function recordDashboardStatus(store, patch) {
  try {
    if (!store.dataRoot) return;
    const payload = {
      at: new Date().toISOString(),
      pid: process.pid,
      routePath: DASHBOARD_ROUTE_PATH,
      ...patch,
    };
    await mkdir(store.dataRoot, { recursive: true });
    await writeFile(join(store.dataRoot, '.dashboard-status.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Diagnostics must never break activation.
  }
}

/**
 * Register the management HTTP API. Routes are registered from within
 * `ctx.inject(['webServer'])`: tree-external (profile) plugins cannot see the
 * web carrier service through `ctx.get()` during the synchronous part of
 * `apply`. Each endpoint is registered as its own `exact` route (the same
 * shape proven by the previous release); a single prefix route was not
 * matched by the web server in practice.
 */
function installManagementRoutes(ctx, store) {
  ctx.inject(['webServer'], (hostCtx) => {
    const webServer = hostCtx.get('webServer');
    if (webServer === undefined) {
      void recordDashboardStatus(store, { injectFired: true, webServer: 'unavailable' });
      hostCtx.logger?.info?.('[layer-memory] webServer service unavailable; settings dashboard disabled');
      return;
    }
    const handler = (req, res) => {
      void handleRequest(store, req, res, hostCtx.logger, { getLlm: () => hostCtx.get('llm') });
    };
    const paths = [
      DASHBOARD_ROUTE_PATH,
      `${API_PREFIX}entry`,
      `${API_PREFIX}maintenance`,
      `${API_PREFIX}settings`,
      `${API_PREFIX}sessions`,
      `${API_PREFIX}sessions/extract`,
      `${API_PREFIX}sessions/import`,
      `${API_PREFIX}sessions/summarize`,
    ];
    const registered = [];
    const failures = [];
    hostCtx.effect(() => {
      const disposers = [];
      for (const routePath of paths) {
        try {
          disposers.push(webServer.register({ kind: 'exact', path: routePath, handler }));
          registered.push(routePath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ path: routePath, message });
          hostCtx.logger?.warn?.(`[layer-memory] failed to register ${routePath}: ${message}`);
        }
      }
      void recordDashboardStatus(store, { injectFired: true, registered: [...registered], failures });
      return () => {
        for (const dispose of disposers) dispose?.();
      };
    }, 'layer-memory: management routes');
    hostCtx.logger?.info?.(
      `[layer-memory] management API ready (${registered.join(', ') || 'no routes'}; state: ${DASHBOARD_ROUTE_PATH})`,
    );
  });
}

async function handleRequest(store, req, res, logger, services = {}) {
  const method = String(req.method ?? 'GET').toUpperCase();
  let path;
  try {
    path = new URL(String(req.url ?? '/'), 'http://localhost').pathname;
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad request url' });
    return;
  }
  try {
    if (method === 'GET' || method === 'HEAD') {
      if (path === DASHBOARD_ROUTE_PATH) {
        store.loadSync();
        const payload = JSON.stringify(buildDashboardState(store));
        res.writeHead(200, JSON_HEADERS);
        res.end(method === 'HEAD' ? undefined : payload);
        return;
      }
      if (path === `${API_PREFIX}sessions`) {
        const listing = await listSessions({ sessionsRoot: resolveSessionsRoot(process.env) });
        sendJson(res, 200, { ok: true, ...listing, llm: describeLlm(services.getLlm?.()) });
        return;
      }
      sendJson(res, 404, { ok: false, error: `unknown path ${path}` });
      return;
    }
    if (method !== 'POST') {
      res.writeHead(405, { ...JSON_HEADERS, allow: 'GET, HEAD, POST' });
      res.end(JSON.stringify({ ok: false, error: 'method not allowed' }));
      return;
    }
    const body = await readJsonBody(req);
    if (path === `${API_PREFIX}entry`) {
      const result = await applyEntryAction(store, body);
      sendJson(res, 200, { ok: true, result, state: buildDashboardState(store) });
      return;
    }
    if (path === `${API_PREFIX}maintenance`) {
      const report = await store.runMaintenance();
      sendJson(res, 200, { ok: true, report, state: buildDashboardState(store) });
      return;
    }
    if (path === `${API_PREFIX}settings`) {
      const settings = await store.updateSettings(body ?? {});
      sendJson(res, 200, { ok: true, settings, state: buildDashboardState(store) });
      return;
    }
    if (path === `${API_PREFIX}sessions/extract`) {
      const sessionId = String(body?.sessionId ?? '').trim();
      if (sessionId === '') throw new Error('sessionId is required');
      const sessionsRoot = resolveSessionsRoot(process.env);
      const filePath = await findSessionFile(sessionId, { sessionsRoot });
      if (filePath === null) {
        sendJson(res, 404, { ok: false, error: `session not found: ${sessionId}` });
        return;
      }
      const extracted = await extractSessionMemories(store, filePath);
      sendJson(res, 200, { ok: true, ...extracted });
      return;
    }
    if (path === `${API_PREFIX}sessions/import`) {
      const imported = await importSessionCandidates(store, body?.entries);
      sendJson(res, 200, { ok: true, ...imported, state: buildDashboardState(store) });
      return;
    }
    if (path === `${API_PREFIX}sessions/summarize`) {
      const sessionId = String(body?.sessionId ?? '').trim();
      if (sessionId === '') throw new Error('sessionId is required');
      const mode = body?.mode === 'llm' ? 'llm' : 'extractive';
      const kind =
        body?.kind === 'progress' ? 'progress' : body?.kind === 'handoff' ? 'handoff' : 'conversation';
      const sessionsRoot = resolveSessionsRoot(process.env);
      const filePath = await findSessionFile(sessionId, { sessionsRoot });
      if (filePath === null) {
        sendJson(res, 404, { ok: false, error: `session not found: ${sessionId}` });
        return;
      }
      try {
        const summarized = await summarizeSession(store, filePath, {
          mode,
          kind,
          llm: services.getLlm?.(),
          provider: typeof body?.provider === 'string' ? body.provider : undefined,
          model: typeof body?.model === 'string' ? body.model : undefined,
          maxTokens: Number.isInteger(body?.maxTokens) && body.maxTokens > 0 ? body.maxTokens : undefined,
        });
        sendJson(res, 200, { ok: true, ...summarized, llm: describeLlm(services.getLlm?.()) });
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        if (mode === 'llm') {
          // A model failure should never leave the editor empty: fall back to
          // the deterministic local summary and report the reason instead.
          try {
            const fallback = await summarizeSession(store, filePath, { mode: 'extractive', kind });
            sendJson(res, 200, {
              ok: true,
              ...fallback,
              fallback: 'extractive',
              warning: failure,
              llm: describeLlm(services.getLlm?.()),
            });
            return;
          } catch {
            // Fall through and surface the original model error.
          }
        }
        throw error;
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: `unknown path ${path}` });
  } catch (error) {
    logger?.warn?.(`[layer-memory] management request failed: ${error instanceof Error ? error.message : String(error)}`);
    sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

/** Run one maintenance pass shortly after activation, then on an interval. */
function installMaintenanceLoop(ctx, store) {
  const run = () => {
    void store
      .runMaintenance()
      .then((report) => {
        if (report.expired > 0 || report.merged > 0) {
          ctx.logger.info?.(`[layer-memory] maintenance: expired ${report.expired}, merged ${report.merged}`);
        }
      })
      .catch((error) => {
        ctx.logger.warn?.(`[layer-memory] maintenance failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  };
  const initial = setTimeout(run, 5_000);
  initial.unref?.();
  let timer = null;
  const schedule = () => {
    const interval = Math.max(60_000, Number(store.settings.maintenanceIntervalMs) || 3_600_000);
    timer = setInterval(run, interval);
    timer.unref?.();
  };
  schedule();
  ctx.effect(
    () => () => {
      clearTimeout(initial);
      if (timer !== null) clearInterval(timer);
    },
    'layer-memory: maintenance loop',
  );
}

/**
 * D2 prototype: query-aware recall injection.
 *
 * `agent/pre-step` is a waterfall, so the listener must call and return
 * `next()`. When the current prompt clearly matches durable entries we append a
 * plugin-sourced user message with the top few relevant memories; the same
 * (session, prompt, keys) tuple is injected at most once to avoid repeating it
 * on every step. Failures never break the turn — the original decision is
 * returned unchanged.
 */
export function createRelevanceListener(ctx, store) {
  const logger = ctx?.logger;
  const lastInjected = new Map();
  const SEEN_LIMIT = 64;
  return async (payload, next) => {
    const decision = await next();
    try {
      if (!decision || decision.kind !== 'enter') return decision;
      const messages = Array.isArray(payload?.messages) ? payload.messages : [];
      const prompt = messages
        .map((message) => extractMessageText(message))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (prompt.length < 4) return decision;
      const sessionId =
        payload?.agent?.session?.header?.id ?? payload?.agent?.session?.id ?? payload?.agent?.id ?? 'default';
      const entries = LAYERS.flatMap((layer) => store.visibleEntries(layer));
      if (entries.length === 0) return decision;
      const ranked = rankEntries(entries, prompt, {
        limit: 3,
        minCoverage: 0.3,
        minRelevance: 0.3,
        maxDf: 0.6,
        requireDiscriminative: true,
      });
      if (ranked.length === 0) return decision;
      const hash = `${sessionId}\u0000${promptHash(prompt)}\u0000${ranked.map((item) => `${item.entry.type}:${item.entry.key}`).join(',')}`;
      if (lastInjected.get(sessionId) === hash) return decision;
      lastInjected.set(sessionId, hash);
      if (lastInjected.size > SEEN_LIMIT) {
        const oldest = lastInjected.keys().next().value;
        if (oldest !== undefined) lastInjected.delete(oldest);
      }
      const block = renderRecallBlock(ranked, { maxChars: 900, entryChars: 180 });
      return { ...decision, messages: [...(decision.messages ?? []), injectionMessage(block)] };
    } catch (error) {
      logger?.warn?.(`[layer-memory] relevance injection failed: ${error instanceof Error ? error.message : String(error)}`);
      return decision;
    }
  };
}

export function apply(ctx) {
  const dataRoot = resolveDataRoot(process.env);
  const store = new LayerMemoryStore({ dataRoot });
  store.loadSync();
  if (store.warnings.length > 0) {
    for (const warning of store.warnings) ctx.logger.warn?.(`[layer-memory] ${warning}`);
  }
  ctx.logger.info?.(
    `[layer-memory] ${store.totalEntries()} memories loaded from ${store.dataRoot} (auto capture ${
      autoCaptureEnabled(process.env) ? 'on' : 'off'
    })`,
  );

  ctx.effect(() => {
    const disposers = createMemoryTools(store).map((tool) => ctx.tools.register(tool));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'layer-memory: tools');

  ctx.effect(() => installAutoCapture(ctx, store), 'layer-memory: auto capture');

  const recallGate = (process.env.DSH_LAYER_MEMORY_RECALL_GATE ?? '1').trim().toLowerCase();
  if (!['0', 'false', 'off', 'no'].includes(recallGate)) {
    ctx.effect(
      () => ctx.on('agent/pre-step', createRelevanceListener(ctx, store)),
      'layer-memory: relevance injection',
    );
  }

  installManagementRoutes(ctx, store);
  installMaintenanceLoop(ctx, store);

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(
      () => systemPrompt.section({ name: 'layer-memory:guidance', order: 118, text: () => GUIDANCE_TEXT }),
      'layer-memory: guidance',
    );
    ctx.effect(
      () =>
        systemPrompt.context({
          name: 'layer-memory:digest',
          order: 118,
          text: () => {
            try {
              return renderDigest(store);
            } catch {
              return '';
            }
          },
        }),
      'layer-memory: digest',
    );
  }
}

export default { name, inject, apply };
