/**
 * Projection of the layered memory used by the settings page (Web UI).
 *
 * The Host serves this document over HTTP (see `installManagementRoutes` in
 * `index.js`); the browser-side `client.js` only renders it. Keeping the
 * projection here makes the shape testable without the Harness runtime.
 */
import { DEFAULT_SCOPES, LAYERS, entryWeight, isExpired, renderDigest } from './store.js';
import { listRetros } from './retro.js';

/**
 * Exact HTTP path the dashboard client reads.
 *
 * Deliberately outside the Harness-owned `/api` fence: that prefix is owned by
 * the web carrier's own exact routes, and the browser auth fence rejects
 * unregistered `/api/*` paths.
 */
export const DASHBOARD_ROUTE_PATH = '/layer-memory/api/state';

/** Prefix under which the management API is mounted. */
export const API_PREFIX = '/layer-memory/api/';

/** @returns {boolean} false when DSH_LAYER_MEMORY_AUTO is off. */
export function autoCaptureEnabled(env = process.env) {
  const flag = String(env.DSH_LAYER_MEMORY_AUTO ?? '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Snapshot consumed by the settings page: layer entries with lifecycle and
 * decay metadata, hit statistics, working-layer pressure, maintenance state,
 * merge candidates and the exact digest injected into the system prompt.
 */
export function buildDashboardState(store, options = {}) {
  store.ensureLoaded();
  const now = options.now ?? Date.now();
  const activeScopes = options.activeScopes ?? store.settings?.activeScopes ?? [];
  const layers = {};
  const counts = { working: 0, persona: 0, fact: 0 };
  const stats = {};
  const totals = { entries: 0, hits: 0, disabled: 0, expired: 0, chars: 0 };
  const scopes = new Set(DEFAULT_SCOPES);

  for (const layer of LAYERS) {
    const raw = store.entries(layer, { now, includeExpired: true });
    let hits = 0;
    let chars = 0;
    const entries = raw.map((entry) => {
      const weight = entryWeight(entry, now);
      const expired = isExpired(entry, now);
      hits += entry.hits;
      chars += String(entry.value ?? '').length;
      if (entry.enabled === false) totals.disabled += 1;
      if (expired) totals.expired += 1;
      for (const scope of entry.scopes ?? []) scopes.add(scope);
      return {
        key: entry.key,
        value: entry.value,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        scopes: Array.isArray(entry.scopes) ? entry.scopes : [],
        hits: entry.hits ?? 0,
        weight,
        enabled: entry.enabled !== false,
        expired,
        ttlMs: entry.ttlMs ?? null,
        expiresAt: entry.expiresAt ?? null,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastHitAt: entry.lastHitAt,
      };
    });
    const enabledCount = entries.filter((entry) => entry.enabled && !entry.expired).length;
    const weights = entries.filter((entry) => entry.enabled && !entry.expired).map((entry) => entry.weight);
    layers[layer] = entries;
    counts[layer] = entries.length;
    stats[layer] = {
      count: entries.length,
      enabled: enabledCount,
      hits,
      chars,
      maxWeight: weights.length > 0 ? round2(Math.max(...weights)) : 0,
      avgWeight: weights.length > 0 ? round2(weights.reduce((sum, weight) => sum + weight, 0) / weights.length) : 0,
    };
    totals.entries += entries.length;
    totals.hits += hits;
    totals.chars += chars;
  }

  let candidates = [];
  try {
    candidates = store.mergeCandidates({ now, activeScopes });
  } catch {
    candidates = [];
  }

  // Retrospectives are surfaced on the dashboard but never injected into the
  // automatic digest (see renderDigest / isRetroEntry).
  let retros = [];
  let retroCount = 0;
  try {
    const allRetros = listRetros(store, { limit: 50 });
    retros = allRetros.slice(0, 8);
    retroCount = allRetros.length;
  } catch {
    retros = [];
    retroCount = 0;
  }
  counts.retro = retroCount;

  let digest = '';
  try {
    digest = renderDigest(store, { activeScopes });
  } catch {
    digest = '';
  }

  const settings = {
    activeScopes: [...(store.settings?.activeScopes ?? [])],
    digestBudget: store.settings?.digestBudget ?? null,
    maintenanceIntervalMs: store.settings?.maintenanceIntervalMs ?? null,
    lastMaintenanceAt: store.settings?.lastMaintenanceAt ?? null,
    lastMaintenance: store.settings?.lastMaintenance ?? null,
  };

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    dataRoot: store.dataRoot,
    counts,
    total: totals.entries,
    chars: totals.chars,
    hits: totals.hits,
    disabled: totals.disabled,
    expired: totals.expired,
    autoCapture: autoCaptureEnabled(options.env),
    settings,
    scopes: [...scopes],
    working: store.workingUsage(),
    stats,
    candidates,
    retros,
    digest,
    layers,
  };
}
