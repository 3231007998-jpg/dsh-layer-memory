/**
 * Tool definitions for the layer memory plugin.
 *
 * The tools follow Layer Memory's original MCP surface:
 *   memory_store, memory_recall, memory_export, memory_import,
 *   plus memory_retro for incident / inefficiency retrospectives.
 *
 * Parameters stay inside the closed JSON-Schema subset accepted by the
 * Harness tool registry: a single `type` string (never an array), `oneOf`
 * instead of unions, and no minimum/maximum/pattern/$ref keywords.
 */
import { LAYERS, DEFAULT_LAYER } from './store.js';
import { ATOMIC_MAX, splitAtomic } from './atomic.js';
import { listRetros, recordRetro } from './retro.js';

const LAYER_HINT =
  'working = short-term scratch notes that are automatically archived into fact when the working layer is full; ' +
  'persona = durable user preferences, traits, and communication style; ' +
  'fact = durable factual knowledge, decisions, and project context.';

const MAX_RECALL_VALUE_CHARS = 900;

function truncate(value, maxLength) {
  const text = typeof value === 'string' ? value : String(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function formatTags(entry) {
  return entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
}

function formatStoreResult(result) {
  const lines = [`Stored entry "${result.entry.key}" in the ${result.entry.type} layer.`];
  lines.push(`Tags: ${result.entry.tags.length > 0 ? result.entry.tags.join(', ') : '(none)'}`);
  if (result.entry.scopes.length > 0) lines.push(`Scopes: ${result.entry.scopes.join(', ')}`);
  if (result.entry.expiresAt) lines.push(`Expires: ${result.entry.expiresAt} (TTL ${result.entry.ttlMs} ms)`);
  if (result.archived.length > 0) {
    lines.push(
      `Working layer was full: archived ${result.archived.length} oldest working ${result.archived.length === 1 ? 'entry' : 'entries'} into the fact layer (${result.archived.join(', ')}).`,
    );
  }
  return lines.join('\n');
}

function formatRecallResult(result) {
  const scope = result.type === null ? 'all layers' : `the ${result.type} layer`;
  if (result.entries.length === 0) {
    const filters = [];
    if (result.query !== '') filters.push(`query "${result.query}"`);
    if (result.tags.length > 0) filters.push(`tags ${result.tags.join(', ')}`);
    const suffix = filters.length > 0 ? ` for ${filters.join(' and ')}` : '';
    return `No memory entries found in ${scope}${suffix}.`;
  }
  const header = `Found ${result.total} matching entr${result.total === 1 ? 'y' : 'ies'} in ${scope}; showing ${result.entries.length}:`;
  const rows = result.entries.map((entry) => {
    const created = entry.createdAt.slice(0, 10);
    const body = truncate(entry.value.replace(/\s+/g, ' ').trim(), MAX_RECALL_VALUE_CHARS);
    return `- [${entry.type}] ${entry.key}${formatTags(entry)} (updated ${entry.updatedAt.slice(0, 10)}, created ${created}, hits ${entry.hits}): ${body}`;
  });
  return [header, ...rows].join('\n');
}

function formatExportResult(result) {
  return `Exported ${result.entries} memory ${result.entries === 1 ? 'entry' : 'entries'} to "${result.path}" (${result.bytes} bytes).`;
}

function formatImportResult(result) {
  const lines = [
    `Imported ${result.imported} ${result.imported === 1 ? 'entry' : 'entries'} from "${result.path}" (mode: ${result.mode}, skipped: ${result.skipped}).`,
  ];
  if (result.warnings.length > 0) {
    lines.push(`Warnings (${result.warnings.length}):`);
    for (const warning of result.warnings.slice(0, 10)) lines.push(`- ${warning}`);
    if (result.warnings.length > 10) lines.push(`- …and ${result.warnings.length - 10} more`);
  }
  return lines.join('\n');
}

/**
 * Build the four tool definitions for a store.
 * @param {import('./store.js').LayerMemoryStore} store
 * @returns {Array<Record<string, unknown>>}
 */
function formatRetroList(retros) {
  if (retros.length === 0) return 'No retrospectives recorded yet.';
  const lines = [`Found ${retros.length} retrospective(s):`];
  for (const retro of retros) {
    const header = `- [${retro.date || 'unknown'}] ${retro.title}${retro.timeCost ? `（耗时 ${retro.timeCost}）` : ''}`;
    lines.push(header);
    if (retro.rootCause) lines.push(`  根因：${truncate(retro.rootCause, 200)}`);
    if (retro.lesson) lines.push(`  教训：${truncate(retro.lesson, 200)}`);
  }
  return lines.join('\n');
}

export function createMemoryTools(store) {
  const storeTool = {
    name: 'memory_store',
    description:
      'Save a durable entry in the layered memory system so it can be recalled in later turns and sessions. ' +
      `${LAYER_HINT} ` +
      'Storing an existing key in the same layer updates that entry (the value is replaced and tags are merged). ' +
      'Use short, stable keys such as "user-name" or "project-stack". ' +
      `Values longer than ${ATOMIC_MAX} characters are automatically split into atomic entries stored under "<key>·1…<key>·N" and tagged "atomic" so they stay retrievable and visible in the prompt digest. ` +
      'Set ttl for temporary memories (e.g. "7d", "12h", "30m"); set scopes to gate an entry to scenarios such as "coding" or "chat".',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable, short identifier of the memory entry.' },
        value: { type: 'string', description: 'The memory content to persist.' },
        type: {
          type: 'string',
          enum: [...LAYERS],
          default: DEFAULT_LAYER,
          description: `Memory layer. ${LAYER_HINT}`,
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short tags used to filter recall results.',
        },
        scopes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional scenario scopes (e.g. ["coding", "chat"]). An entry with scopes is only injected in those scenarios; leave empty to always inject.',
        },
        ttl: {
          type: 'string',
          description: 'Optional time to live such as "7d", "12h", "30m"; omit for a durable entry.',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const value = String(input.value ?? '');
      const parts = splitAtomic(value, ATOMIC_MAX);
      if (parts.length <= 1) {
        const result = await store.store({
          key: input.key,
          value: input.value,
          type: input.type,
          tags: input.tags,
          scopes: input.scopes,
          ttl: input.ttl,
        });
        return formatStoreResult(result);
      }
      // D4 prototype: structured write path. Oversized values are split into
      // atomic entries (deterministic, no characters lost) so that each entry is
      // visible in the digest and retrievable on its own.
      const baseKey = typeof input.key === 'string' ? input.key.trim() : '';
      if (baseKey === '') throw new Error('key must be a string');
      const extraTags = Array.isArray(input.tags) ? input.tags : [];
      const stored = [];
      const archived = [];
      for (let index = 0; index < parts.length; index += 1) {
        const result = await store.store({
          key: `${baseKey}·${index + 1}`,
          value: parts[index],
          type: input.type,
          tags: [...extraTags, 'atomic'],
          scopes: input.scopes,
          ttl: input.ttl,
        });
        stored.push(result.entry.key);
        archived.push(...result.archived);
      }
      const lines = [
        `Saved as ${stored.length} atomic entries (${stored.join(', ')}); each value is at most ${ATOMIC_MAX} characters and tagged "atomic".`,
      ];
      if (archived.length > 0) {
        lines.push(
          `Working layer was full: archived ${archived.length} oldest working ${archived.length === 1 ? 'entry' : 'entries'} into the fact layer (${archived.join(', ')}).`,
        );
      }
      return lines.join('\n');
    },
  };

  const recallTool = {
    name: 'memory_recall',
    description:
      'Search the layered memory system before asking the user to repeat information or when prior context may matter. ' +
      'Every whitespace-separated term of the query must appear in an entry key, value, or tags; results are ranked by key/tag match, usage, and recency. ' +
      'Omit query to list the most relevant entries of the selected layers; narrow the search with type and tags.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional search terms; all terms must match.' },
        type: {
          type: 'string',
          enum: [...LAYERS],
          description: 'Optional layer filter; omit to search all layers.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags that must all be present on a matching entry.',
        },
        limit: {
          type: 'integer',
          default: 5,
          description: 'Maximum number of entries to return (default 5, maximum 50).',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const result = await store.recall({
        query: input.query,
        type: input.type,
        tags: input.tags,
        limit: input.limit,
      });
      return formatRecallResult(result);
    },
  };

  const exportTool = {
    name: 'memory_export',
    description:
      'Export every memory layer to one Markdown document that memory_import and humans can read. ' +
      'Use it to back up memory or move it to another machine.',
    parameters: {
      type: 'object',
      properties: {
        outputPath: {
          type: 'string',
          description:
            'Optional destination path. Relative paths resolve under the memory data directory; defaults to exports/layer-memory-<timestamp>.md.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const result = await store.exportTo({ outputPath: input.outputPath });
      return formatExportResult(result);
    },
  };

  const importTool = {
    name: 'memory_import',
    description:
      'Import memory entries from a file produced by memory_export (Markdown), or from a JSON array / JSONL file of entries. ' +
      'mode "merge" keeps existing entries and overwrites same-key entries; mode "replace" clears all layers first.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: {
          type: 'string',
          description:
            'Path to the file to import. Relative paths resolve under the memory data directory.',
        },
        mode: {
          type: 'string',
          enum: ['merge', 'replace'],
          default: 'merge',
          description: 'merge keeps existing entries; replace clears all layers before importing.',
        },
      },
      required: ['inputPath'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const result = await store.importFrom({ inputPath: input.inputPath, mode: input.mode });
      return formatImportResult(result);
    },
  };

  const retroTool = {
    name: 'memory_retro',
    description:
      'Record or review a project retrospective (postmortem): what broke or slowed you down, the root cause, the fix, the reusable lesson and how to prevent it. ' +
      'Retrospectives are stored as fact entries tagged "retro" and are deliberately excluded from the automatic prompt digest, so they never crowd out durable facts; read them back with memory_retro action "list", memory_recall, or the settings dashboard. ' +
      'Record one after any non-trivial bug, incident or inefficient workflow (for example: "waited a long time opening new conversations just to verify a plugin change").',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['record', 'list'],
          description: 'record a new retrospective, or list the existing ones.',
        },
        title: {
          type: 'string',
          description: 'Short title of the incident or inefficiency; also used as the list query when action is "list".',
        },
        symptom: { type: 'string', description: 'What was observed (error text, wasted time, wrong behavior).' },
        rootCause: { type: 'string', description: 'Why it happened, as precisely as possible.' },
        fix: { type: 'string', description: 'What fixed it.' },
        lesson: { type: 'string', description: 'The reusable lesson.' },
        prevention: { type: 'string', description: 'A concrete check or habit that prevents recurrence.' },
        timeCost: { type: 'string', description: 'Optional time cost, e.g. "约 40 分钟 + 2 次重启".' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional extra tags; retro and incident are added automatically.',
        },
        limit: {
          type: 'integer',
          default: 10,
          description: 'For action "list": maximum number of retrospectives to return (max 50).',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {};
      const action = String(input.action ?? 'list').trim().toLowerCase();
      if (action === 'record') {
        const { retro, entry } = await recordRetro(store, input);
        const cost = retro.timeCost ? `（耗时 ${retro.timeCost}）` : '';
        return `Recorded retrospective "${retro.title}"${cost} as fact entry "${entry?.key ?? ''}". It is excluded from the automatic digest and can be recalled later.`;
      }
      if (action === 'list') {
        return formatRetroList(listRetros(store, { limit: input.limit, query: input.title }));
      }
      throw new Error('action must be one of: record, list');
    },
  };

  return [storeTool, recallTool, exportTool, importTool, retroTool];
}
