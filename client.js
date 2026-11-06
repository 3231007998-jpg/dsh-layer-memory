/**
 * Layer Memory — browser-side settings page.
 *
 * Registers one page in the Harness Settings sidebar ("Layer Memory") that
 * visualizes the three memory layers and manages them: add / edit / delete /
 * enable-disable entries, edit TTL and scenario scopes, run maintenance, and
 * resolve merge candidates. Data comes from the Host management API mounted by
 * `index.js` under `/layer-memory/api/`; the browser never touches the
 * filesystem itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-layer-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const STATE_ROUTE = '/layer-memory/api/state';
    const API = '/layer-memory/api/';
    const SCOPE_KEYS = ['coding', 'chat', 'writing', 'work'];
    const LAYERS = ['working', 'persona', 'fact'];

    // -- locale dictionaries ------------------------------------------------

    const DICT_ZH = {
      sectionLabel: '分层记忆',
      title: '分层记忆',
      subtitle: '跨会话的本地记忆：working · persona · fact，零依赖、不联网。',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '正在读取记忆…',
      retry: '重试',
      errorPrefix: '读取失败：',
      layerWorking: 'working · 工作记忆',
      layerPersona: 'persona · 用户画像',
      layerFact: 'fact · 事实知识',
      hintWorking: '短期草稿；写满后会把最旧的条目归档到 fact 层。',
      hintPersona: '跨会话的稳定偏好、习惯与沟通风格。',
      hintFact: '持久的事实、决策与项目上下文。',
      empty: '（空）',
      retroTitle: '复盘（事故与低效记录）',
      retroHint: '记录 bug/事故或低效环节：现象、根因、修复、教训与预防。复盘不占用自动注入摘要，可通过检索或本面板查看。',
      retroEmpty: '还没有复盘记录。可以让模型用 memory_retro 记录一次事故处理或低效环节。',
      retroRootCause: '根因',
      retroLesson: '教训',
      retroPrevention: '预防',
      retroTimeCost: '耗时',
      digestTitle: '注入到系统提示的记忆摘要',
      digestHint: '模型每一步实际看到的 <layer-memory> 文本；受场景与衰减权重过滤。',
      digestEmpty: '当前没有被注入的条目。',
      hits: '命中',
      weight: '权重',
      updated: '更新',
      lastHit: '最近命中',
      expires: '过期于',
      noTtl: '永久',
      disabled: '已停用',
      enabledLabel: '启用',
      scopes: '场景',
      allScopes: '全部场景',
      scopeCoding: '编码',
      scopeChat: '聊天',
      scopeWriting: '写作',
      scopeWork: '工作',
      addTitle: '新增记忆',
      addKey: '键名',
      addValue: '内容',
      addType: '层级',
      addTags: '标签（逗号分隔）',
      addTtl: 'TTL（如 7d、12h；留空为永久）',
      addSubmit: '保存新记忆',
      edit: '编辑',
      delete: '删除',
      save: '保存',
      cancel: '取消',
      confirmDelete: '确认删除？',
      mergeTitle: '合并候选',
      mergeHint: '相似条目可合并为一条；相互冲突的条目需要你选择保留哪一条。',
      merge: '合并',
      keepLeft: '保留左项',
      keepRight: '保留右项',
      ignore: '忽略',
      similarity: '相似度',
      conflict: '冲突',
      noCandidates: '暂无合并候选。',
      maintenance: '运行维护',
      maintenanceRunning: '维护中…',
      maintenanceDone: '维护完成：过期 {expired} 条，合并 {merged} 条。',
      lastMaintenance: '上次维护',
      never: '从未',
      autoOn: '自动抽取：开',
      autoOff: '自动抽取：关',
      dataDir: '数据目录',
      total: '总条数',
      totalHits: '总命中',
      chars: '字符数',
      progressEntries: '条目占用',
      progressChars: '字符占用',
      activeScopes: '当前场景',
      digestBudgetLabel: '注入预算',
      digestChars: '注入摘要',
      noticeRefreshed: '已刷新。',
      entryCount: '条',
      typeWorking: 'working',
      typePersona: 'persona',
      typeFact: 'fact',
      importTitle: '从其他对话导入记忆',
      importHint: '扫描本机其他对话日志，用与自动抽取相同的规则挑出候选记忆；确认后写入选中的层级。数据不会离开本机。',
      scanSessions: '扫描其他对话',
      scanning: '扫描中…',
      noSessions: '没有找到其他对话。',
      sessionUntitled: '未命名对话',
      extractCandidates: '提取候选',
      extracting: '提取中…',
      candidatesTitle: '候选记忆',
      candidatesHint: '勾选要导入的条目；导入后会带上 import / session 标签。',
      candidatesEmpty: '这段对话里没有新的可导入记忆。',
      selectAll: '全选',
      selectNone: '全不选',
      importSelected: '导入所选',
      importing: '导入中…',
      importDone: '已导入 {imported} 条，跳过 {skipped} 条。',
      summaryTitle: '对话摘要',
      progressTitle: '工作进度摘要',
      summaryKindLabel: '摘要类型',
      kindConversation: '对话摘要',
      kindProgress: '工作进度（交接）',
      kindHandoff: '项目交接（原子条目）',
      handoffTitle: '项目交接条目',
      handoffHint: '模型把对话整理成多条 ≤180 字的原子记忆（任务 / 产物路径 / 已完成 / 下一步 / 数据缺口 / 偏好），每条都能完整出现在新对话的自动摘要里。',
      progressHint: '从对话里提取任务、待办、最近动作与下一步，适合跨对话交接继续工作。',
      generateSummary: '生成摘要',
      generatingSummary: '生成中…',
      useModelSummary: '用模型总结（消耗模型额度）',
      modelUnavailable: '模型服务不可用，将使用本地启发式摘要。',
      summaryHint: '摘要默认由本地规则生成；勾选“用模型总结”会调用 Harness 模型服务。生成后可编辑，再导入为 fact 或 persona。',
      summaryTypeLabel: '导入层级',
      importSummary: '导入这条摘要',
      summaryDone: '摘要已导入。',
      summaryFallback: '模型总结失败（{reason}），已改用本地摘要。',
      dismiss: '关闭',
    };

    const DICT_EN = {
      sectionLabel: 'Layer Memory',
      title: 'Layer Memory',
      subtitle: 'Cross-session local memory: working · persona · fact. Zero dependencies, offline.',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Loading memory…',
      retry: 'Retry',
      errorPrefix: 'Failed to load: ',
      layerWorking: 'working · scratch',
      layerPersona: 'persona · user model',
      layerFact: 'fact · knowledge',
      hintWorking: 'Short-term scratch; the oldest entries are archived into fact when the layer is full.',
      hintPersona: 'Stable preferences, habits and communication style across sessions.',
      hintFact: 'Durable facts, decisions and project context.',
      empty: '(empty)',
      retroTitle: 'Retrospectives (incidents & inefficiencies)',
      retroHint: 'Record bugs, incidents or slow workflows with symptom, root cause, fix, lesson and prevention. Retrospectives never take digest budget; browse them here or look them up through recall.',
      retroEmpty: 'No retrospectives yet. Ask the agent to record one with memory_retro after an incident or a slow workflow.',
      retroRootCause: 'Root cause',
      retroLesson: 'Lesson',
      retroPrevention: 'Prevention',
      retroTimeCost: 'Time cost',
      digestTitle: 'Memory digest injected into the system prompt',
      digestHint: 'The exact <layer-memory> text the model sees each step, filtered by scenario and decay weight.',
      digestEmpty: 'No entries are currently injected.',
      hits: 'hits',
      weight: 'weight',
      updated: 'updated',
      lastHit: 'last hit',
      expires: 'expires',
      noTtl: 'forever',
      disabled: 'disabled',
      enabledLabel: 'enabled',
      scopes: 'scopes',
      allScopes: 'All scenarios',
      scopeCoding: 'coding',
      scopeChat: 'chat',
      scopeWriting: 'writing',
      scopeWork: 'work',
      addTitle: 'New memory',
      addKey: 'Key',
      addValue: 'Value',
      addType: 'Layer',
      addTags: 'Tags (comma separated)',
      addTtl: 'TTL (e.g. 7d, 12h; empty = forever)',
      addSubmit: 'Save memory',
      edit: 'Edit',
      delete: 'Delete',
      save: 'Save',
      cancel: 'Cancel',
      confirmDelete: 'Delete this entry?',
      mergeTitle: 'Merge candidates',
      mergeHint: 'Similar entries can be merged; conflicting entries need you to pick which one to keep.',
      merge: 'Merge',
      keepLeft: 'Keep left',
      keepRight: 'Keep right',
      ignore: 'Ignore',
      similarity: 'similarity',
      conflict: 'conflict',
      noCandidates: 'No merge candidates.',
      maintenance: 'Run maintenance',
      maintenanceRunning: 'Maintaining…',
      maintenanceDone: 'Maintenance done: {expired} expired, {merged} merged.',
      lastMaintenance: 'Last maintenance',
      never: 'never',
      autoOn: 'Auto capture: on',
      autoOff: 'Auto capture: off',
      dataDir: 'Data directory',
      total: 'Entries',
      totalHits: 'Hits',
      chars: 'Characters',
      progressEntries: 'Entries',
      progressChars: 'Characters',
      activeScopes: 'Scenario',
      digestBudgetLabel: 'Prompt budget',
      digestChars: 'Digest',
      noticeRefreshed: 'Refreshed.',
      entryCount: 'entries',
      typeWorking: 'working',
      typePersona: 'persona',
      typeFact: 'fact',
      importTitle: 'Import from other conversations',
      importHint: 'Scan this machine\u2019s other conversation logs and extract candidate memories with the same heuristics as auto capture; confirm before anything is written. Data never leaves the machine.',
      scanSessions: 'Scan conversations',
      scanning: 'Scanning…',
      noSessions: 'No other conversations found.',
      sessionUntitled: 'Untitled conversation',
      extractCandidates: 'Extract candidates',
      extracting: 'Extracting…',
      candidatesTitle: 'Candidate memories',
      candidatesHint: 'Pick the entries to import; imported entries get import / session tags.',
      candidatesEmpty: 'No new memory candidates in this conversation.',
      selectAll: 'Select all',
      selectNone: 'Select none',
      importSelected: 'Import selected',
      importing: 'Importing…',
      importDone: 'Imported {imported}, skipped {skipped}.',
      summaryTitle: 'Conversation summary',
      progressTitle: 'Work progress summary',
      summaryKindLabel: 'Summary type',
      kindConversation: 'Conversation summary',
      kindProgress: 'Work progress (handoff)',
      kindHandoff: 'Project handoff (atomic entries)',
      handoffTitle: 'Project handoff entries',
      handoffHint: 'The model turns the conversation into several atomic memories of at most 180 characters each (task / artifact paths / done / next step / data gaps / preferences); every entry fits the automatic digest of a new conversation.',
      progressHint: 'Extracts the task, todos, recent actions and next steps from a conversation so another session can pick up where it left off.',
      generateSummary: 'Generate summary',
      generatingSummary: 'Generating…',
      useModelSummary: 'Summarize with the model (uses model quota)',
      modelUnavailable: 'The model service is unavailable; a local heuristic summary will be used.',
      summaryHint: 'Summaries are generated locally by default; ticking “Summarize with the model” calls the Harness model service. Edit the text before importing it as a fact or persona entry.',
      summaryTypeLabel: 'Import as',
      importSummary: 'Import this summary',
      summaryDone: 'Summary imported.',
      summaryFallback: 'Model summary failed ({reason}); the local heuristic summary was used instead.',
      dismiss: 'Close',
    };

    let translate = (key) => DICT_ZH[key] ?? key;
    const scopeLabel = (scope) => translate(`scope${scope.charAt(0).toUpperCase()}${scope.slice(1)}`) || scope;

    // -- small helpers ------------------------------------------------------

    function splitList(value) {
      return String(value ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }

    function fmtDate(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return String(iso);
      const pad = (value) => String(value).padStart(2, '0');
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    function clampPercent(value) {
      return Math.max(0, Math.min(100, Math.round(value)));
    }

    /** Render a millisecond TTL as the human string accepted by the API. */
    function ttlToInput(ms) {
      const value = Number(ms) || 0;
      if (value <= 0) return '';
      const day = 24 * 60 * 60 * 1000;
      const hour = 60 * 60 * 1000;
      const minute = 60 * 1000;
      if (value % day === 0) return `${value / day}d`;
      if (value % hour === 0) return `${value / hour}h`;
      if (value % minute === 0) return `${value / minute}m`;
      return `${Math.round(value / 1000)}s`;
    }

    async function requestJson(url, options) {
      const response = await fetch(url, { cache: 'no-store', ...(options ?? {}) });
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || (payload && payload.ok === false)) {
        const message = (payload && payload.error) || `HTTP ${response.status}`;
        throw new Error(message);
      }
      return payload ?? {};
    }

    // -- styles -------------------------------------------------------------

    const cardStyle = {
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      borderRadius: 12,
      padding: 14,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      boxSizing: 'border-box',
    };
    const subtleText = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 };
    const buttonStyle = {
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 8,
      padding: '5px 10px',
      cursor: 'pointer',
      fontSize: 12,
      whiteSpace: 'nowrap',
    };
    const primaryButtonStyle = {
      ...buttonStyle,
      border: '1px solid var(--dsw-alias-brand-primary)',
      background: 'var(--dsw-alias-brand-primary)',
      color: 'var(--dsw-alias-bg-base)',
      fontWeight: 600,
    };
    const inputStyle = {
      background: 'var(--dsw-alias-bg-base)',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-primary)',
      borderRadius: 8,
      padding: '6px 8px',
      fontSize: 13,
      width: '100%',
      boxSizing: 'border-box',
    };
    const chipStyle = (active, color) => {
      const accent = color || 'var(--dsw-alias-brand-primary)';
      return {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        border: `1px solid ${active ? accent : 'var(--dsw-alias-border-l1)'}`,
        background: active ? `color-mix(in srgb, ${accent} 22%, transparent)` : 'transparent',
        color: active ? accent : 'var(--dsw-alias-label-secondary)',
        borderRadius: 999,
        padding: '1px 8px',
        fontSize: 11,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
      };
    };
    const dangerStyle = { ...buttonStyle, color: 'var(--dsw-alias-state-error-primary)' };

    function scopeColor(scope) {
      if (scope === 'coding') return 'var(--dsw-alias-state-success-primary)';
      if (scope === 'chat') return 'var(--dsw-alias-state-idle-primary)';
      if (scope === 'writing') return 'var(--dsw-alias-state-warn-primary)';
      return 'var(--dsw-alias-brand-primary)';
    }

    function layerColor(layer) {
      if (layer === 'working') return 'var(--dsw-alias-brand-primary)';
      if (layer === 'persona') return 'var(--dsw-alias-state-success-primary)';
      return 'var(--dsw-alias-state-warn-primary)';
    }

    // -- small components ---------------------------------------------------

    function WeightBar({ weight }) {
      const width = clampPercent((Number(weight) || 0) * 20);
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 96 } },
        h(
          'div',
          {
            style: {
              flex: 1,
              height: 6,
              borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${width}%`,
              height: '100%',
              background: 'var(--dsw-alias-brand-primary)',
            },
          }),
        ),
        h('span', { style: { ...subtleText, fontSize: 11, minWidth: 28, textAlign: 'right' } }, Number(weight).toFixed(2)),
      );
    }

    function Progress({ label, percent, detail, color }) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', gap: 8, ...subtleText } },
          h('span', null, label),
          h('span', null, detail),
        ),
        h(
          'div',
          {
            style: {
              height: 8,
              borderRadius: 999,
              background: 'var(--dsw-alias-bg-layer-2)',
              overflow: 'hidden',
            },
          },
          h('div', {
            style: {
              width: `${clampPercent(percent)}%`,
              height: '100%',
              background: color,
            },
          }),
        ),
      );
    }

    function ScopesEditor({ scopes, onChange, disabled }) {
      return h(
        'div',
        { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
        SCOPE_KEYS.map((scope) =>
          h(
            'button',
            {
              key: scope,
              type: 'button',
              disabled,
              onClick: () => {
                const next = scopes.includes(scope) ? scopes.filter((item) => item !== scope) : [...scopes, scope];
                onChange(next);
              },
              style: chipStyle(scopes.includes(scope), scopeColor(scope)),
            },
            scopeLabel(scope),
          ),
        ),
      );
    }

    function EntryRow({
      layer,
      entry,
      editing,
      pendingDelete,
      busy,
      onUpdateEdit,
      onCancelEdit,
      onSaveEdit,
      onToggle,
      onStartEdit,
      onRequestDelete,
      onConfirmDelete,
      onCancelDelete,
    }) {
      const card = { borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 5 };
      if (editing) {
        return h(
          'div',
          { style: { ...card, gap: 8 } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: 8 } },
            h('strong', { style: { fontSize: 13 } }, entry.key),
            h('span', { style: subtleText }, entry.expired ? translate('disabled') : ''),
          ),
          h('textarea', {
            value: editing.value,
            rows: 3,
            onChange: (event) => onUpdateEdit({ ...editing, value: event.target.value }),
            style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit' },
          }),
          h('input', {
            value: editing.tags,
            placeholder: translate('addTags'),
            onChange: (event) => onUpdateEdit({ ...editing, tags: event.target.value }),
            style: inputStyle,
          }),
          h('input', {
            value: editing.ttl,
            placeholder: translate('addTtl'),
            onChange: (event) => onUpdateEdit({ ...editing, ttl: event.target.value }),
            style: inputStyle,
          }),
          h(ScopesEditor, {
            scopes: editing.scopes,
            onChange: (next) => onUpdateEdit({ ...editing, scopes: next }),
          }),
          h(
            'div',
            { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
            h('button', { type: 'button', onClick: onCancelEdit, style: buttonStyle }, translate('cancel')),
            h('button', { type: 'button', onClick: onSaveEdit, style: primaryButtonStyle }, translate('save')),
          ),
        );
      }
      return h(
        'div',
        { style: card },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 13, opacity: entry.enabled ? 1 : 0.55 } }, entry.key),
          entry.expired ? h('span', { style: chipStyle(true, 'var(--dsw-alias-state-error-primary)') }, translate('expires')) : null,
          entry.ttlMs && !entry.expired
            ? h('span', { style: chipStyle(false) }, `${translate('expires')} ${fmtDate(entry.expiresAt)}`)
            : null,
          ...(entry.scopes ?? []).map((scope) => h('span', { key: scope, style: chipStyle(true, scopeColor(scope)) }, scopeLabel(scope))),
          h('span', { style: { flex: 1 } }),
          h(WeightBar, { weight: entry.weight }),
          h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 4, ...subtleText } },
            h('input', {
              type: 'checkbox',
              checked: entry.enabled !== false,
              onChange: () => onToggle(entry),
            }),
            translate('enabledLabel'),
          ),
          h('button', { type: 'button', onClick: () => onStartEdit(entry), style: buttonStyle }, translate('edit')),
          pendingDelete
            ? h(
                'span',
                { style: { display: 'inline-flex', gap: 4 } },
                h('button', { type: 'button', onClick: () => onConfirmDelete(entry), style: dangerStyle }, translate('confirmDelete')),
                h('button', { type: 'button', onClick: onCancelDelete, style: buttonStyle }, translate('cancel')),
              )
            : h('button', { type: 'button', onClick: () => onRequestDelete(entry), style: dangerStyle }, translate('delete')),
        ),
        h('div', {
          style: {
            fontSize: 13,
            color: entry.enabled ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            opacity: entry.expired ? 0.6 : 1,
          },
        }, entry.value),
        h(
          'div',
          { style: { display: 'flex', gap: 10, flexWrap: 'wrap', ...subtleText } },
          h('span', null, `${translate('hits')} ${entry.hits}`),
          h('span', null, `${translate('updated')} ${fmtDate(entry.updatedAt)}`),
          entry.lastHitAt ? h('span', null, `${translate('lastHit')} ${fmtDate(entry.lastHitAt)}`) : null,
          entry.tags && entry.tags.length > 0 ? h('span', null, entry.tags.join(', ')) : null,
        ),
      );
    }

    function LayerCard({ layer, entries, busy, editing, pendingDelete, actions }) {
      const color = layerColor(layer);
      const labelKey = layer === 'working' ? 'layerWorking' : layer === 'persona' ? 'layerPersona' : 'layerFact';
      const hintKey = layer === 'working' ? 'hintWorking' : layer === 'persona' ? 'hintPersona' : 'hintFact';
      const hits = entries.reduce((sum, entry) => sum + (entry.hits ?? 0), 0);
      return h(
        'section',
        { style: cardStyle },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { width: 10, height: 10, borderRadius: 999, background: color, flex: '0 0 auto' } }),
          h('strong', { style: { fontSize: 14 } }, translate(labelKey)),
          h('span', { style: { ...subtleText, marginLeft: 'auto' } },
            `${entries.length} ${translate('entryCount')} · ${translate('hits')} ${hits}`),
        ),
        h('div', { style: subtleText }, translate(hintKey)),
        entries.length === 0
          ? h('div', { style: subtleText }, translate('empty'))
          : entries.map((entry) =>
              h(EntryRow, {
                key: `${entry.key}:${entry.updatedAt}`,
                layer,
                entry,
                busy,
                editing: editing && editing.layer === layer && editing.key === entry.key ? editing : null,
                pendingDelete: pendingDelete && pendingDelete.layer === layer && pendingDelete.key === entry.key,
                onUpdateEdit: actions.updateEdit,
                onCancelEdit: actions.cancelEdit,
                onSaveEdit: actions.saveEdit,
                onToggle: (item) => actions.toggle(layer, item),
                onStartEdit: (item) => actions.startEdit(layer, item),
                onRequestDelete: (item) => actions.requestDelete(layer, item),
                onConfirmDelete: (item) => actions.confirmDelete(layer, item),
                onCancelDelete: actions.cancelDelete,
              }),
            ),
      );
    }

    function AddEntryForm({ draft, setDraft, onSubmit, busy }) {
      return h(
        'section',
        { style: cardStyle },
        h('strong', { style: { fontSize: 14 } }, translate('addTitle')),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 8 } },
          h('input', { value: draft.key, placeholder: translate('addKey'), onChange: (event) => setDraft({ ...draft, key: event.target.value }), style: inputStyle }),
          h(
            'select',
            { value: draft.type, onChange: (event) => setDraft({ ...draft, type: event.target.value }), style: inputStyle },
            LAYERS.map((layer) => h('option', { key: layer, value: layer }, layer)),
          ),
          h('input', { value: draft.tags, placeholder: translate('addTags'), onChange: (event) => setDraft({ ...draft, tags: event.target.value }), style: inputStyle }),
          h('input', { value: draft.ttl, placeholder: translate('addTtl'), onChange: (event) => setDraft({ ...draft, ttl: event.target.value }), style: inputStyle }),
        ),
        h('textarea', {
          value: draft.value,
          rows: 2,
          placeholder: translate('addValue'),
          onChange: (event) => setDraft({ ...draft, value: event.target.value }),
          style: { ...inputStyle, resize: 'vertical', fontFamily: 'inherit' },
        }),
        h(ScopesEditor, { scopes: draft.scopes, onChange: (next) => setDraft({ ...draft, scopes: next }) }),
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end' } },
          h('button', { type: 'button', disabled: busy, onClick: onSubmit, style: primaryButtonStyle }, translate('addSubmit')),
        ),
      );
    }

    function MergeCandidates({ candidates, ignored, busy, onMerge, onIgnore }) {
      const visible = candidates.filter((candidate) => !ignored.has(candidate.keys.join('\u0000')));
      return h(
        'section',
        { style: cardStyle },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8 } },
          h('strong', { style: { fontSize: 14 } }, translate('mergeTitle')),
          h('span', { style: subtleText }, translate('mergeHint')),
        ),
        visible.length === 0
          ? h('div', { style: subtleText }, translate('noCandidates'))
          : visible.map((candidate) => {
              const id = candidate.keys.join('\u0000');
              return h(
                'div',
                {
                  key: id,
                  style: {
                    borderTop: '1px solid var(--dsw-alias-border-l1)',
                    paddingTop: 8,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                  },
                },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('strong', { style: { fontSize: 12 } }, candidate.layer),
                  h('span', { style: chipStyle(false) }, `${translate('similarity')} ${Math.round(candidate.similarity * 100)}%`),
                  candidate.conflict
                    ? h('span', { style: chipStyle(true, 'var(--dsw-alias-state-warn-primary)') }, translate('conflict'))
                    : null,
                  h('span', { style: { flex: 1 } }),
                  candidate.conflict
                    ? h(
                        'span',
                        { style: { display: 'inline-flex', gap: 4 } },
                        h('button', { type: 'button', disabled: busy, onClick: () => onMerge(candidate, candidate.left.value), style: buttonStyle }, `${translate('keepLeft')}: ${candidate.left.key}`),
                        h('button', { type: 'button', disabled: busy, onClick: () => onMerge(candidate, candidate.right.value), style: buttonStyle }, `${translate('keepRight')}: ${candidate.right.key}`),
                      )
                    : h('button', { type: 'button', disabled: busy, onClick: () => onMerge(candidate), style: primaryButtonStyle }, translate('merge')),
                  h('button', { type: 'button', onClick: () => onIgnore(candidate), style: buttonStyle }, translate('ignore')),
                ),
                h('div', { style: { ...subtleText, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                  `${candidate.left.key}: ${candidate.left.value}  ⇄  ${candidate.right.key}: ${candidate.right.value}`),
              );
            }),
      );
    }

    // -- import memories from other conversations ---------------------------

    function SessionImport({ act, setNotice }) {
      const [phase, setPhase] = useState('idle');
      const [sessions, setSessions] = useState([]);
      const [error, setError] = useState(null);
      const [extractingId, setExtractingId] = useState(null);
      const [extracted, setExtracted] = useState(null);
      const [checked, setChecked] = useState(() => new Set());
      const [llm, setLlm] = useState(null);
      const [useModel, setUseModel] = useState(false);
      const [summaryKind, setSummaryKind] = useState('conversation');
      const [summarySessionId, setSummarySessionId] = useState(null);
      const [summary, setSummary] = useState(null);
      const [summaryText, setSummaryText] = useState('');
      const [summaryType, setSummaryType] = useState('fact');
      const [handoffEntries, setHandoffEntries] = useState(null);
      const [handoffChecked, setHandoffChecked] = useState(() => new Set());

      const scan = useCallback(async () => {
        setPhase('scanning');
        setError(null);
        setExtracted(null);
        try {
          const result = await requestJson(`${API}sessions`);
          setSessions(Array.isArray(result.sessions) ? result.sessions : []);
          setLlm(result.llm ?? null);
          setPhase('ready');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase('error');
        }
      }, []);

      const extract = useCallback(
        async (session) => {
          setExtractingId(session.id);
          setError(null);
          try {
            const result = await act('sessions/extract', { sessionId: session.id });
            if (result === null) return;
            const candidates = Array.isArray(result.candidates) ? result.candidates : [];
            setExtracted({ session: result.session ?? session, candidates });
            setChecked(new Set(candidates.map((_candidate, index) => index)));
          } finally {
            setExtractingId(null);
          }
        },
        [act],
      );

      const toggle = useCallback((index) => {
        setChecked((current) => {
          const next = new Set(current);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      }, []);

      const selectAll = useCallback(
        (value) => {
          setChecked(() => {
            if (!value) return new Set();
            const count = extracted?.candidates?.length ?? 0;
            return new Set(Array.from({ length: count }, (_item, index) => index));
          });
        },
        [extracted],
      );

      const doImport = useCallback(async () => {
        if (extracted === null) return;
        const entries = extracted.candidates.filter((_candidate, index) => checked.has(index));
        if (entries.length === 0) return;
        const result = await act('sessions/import', { entries });
        if (result === null) return;
        setNotice(
          translate('importDone')
            .replace('{imported}', String(result.imported ?? 0))
            .replace('{skipped}', String(result.skipped ?? 0)),
        );
        setExtracted(null);
        setChecked(new Set());
        setPhase('idle');
      }, [act, checked, extracted, setNotice]);

      const summarize = useCallback(
        async (session) => {
          setSummarySessionId(session.id);
          setError(null);
          try {
            const result = await act('sessions/summarize', {
              sessionId: session.id,
              mode: useModel ? 'llm' : 'extractive',
              kind: summaryKind,
            });
            if (result === null) return;
            if (Array.isArray(result.candidates) && result.candidates.length > 0 && result.kind === 'handoff') {
              setHandoffEntries(result.candidates.map((candidate) => ({ ...candidate, tags: candidate.tags ?? [] })));
              setHandoffChecked(new Set(result.candidates.map((_candidate, index) => index)));
            } else {
              setHandoffEntries(null);
              setHandoffChecked(new Set());
            }
            setSummary(result);
            setSummaryText(result.candidate?.value ?? result.summary?.text ?? '');
            setSummaryType(result.candidate?.type ?? 'fact');
            if (result.fallback === 'extractive' && typeof result.warning === 'string' && result.warning !== '') {
              setNotice(translate('summaryFallback').replace('{reason}', result.warning));
            }
          } finally {
            setSummarySessionId(null);
          }
        },
        [act, setNotice, useModel, summaryKind],
      );

      const importSummary = useCallback(async () => {
        if (summary === null) return;
        const result = await act('sessions/import', {
          entries: [
            {
              key: summary.candidate?.key,
              value: summaryText,
              type: summaryType,
              tags: summary.candidate?.tags ?? ['import', 'session', 'summary'],
            },
          ],
        });
        if (result === null) return;
        setNotice(translate('summaryDone'));
        setSummary(null);
        setSummaryText('');
        setHandoffEntries(null);
        setHandoffChecked(new Set());
      }, [act, summary, summaryText, summaryType, setNotice]);

      const updateHandoffEntry = useCallback((index, value) => {
        setHandoffEntries((current) =>
          (current ?? []).map((entry, entryIndex) => (entryIndex === index ? { ...entry, value } : entry)),
        );
      }, []);

      const toggleHandoffEntry = useCallback((index) => {
        setHandoffChecked((current) => {
          const next = new Set(current);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      }, []);

      const importHandoff = useCallback(async () => {
        if (handoffEntries === null) return;
        const entries = handoffEntries
          .filter((_entry, index) => handoffChecked.has(index))
          .map((entry) => ({
            key: entry.key,
            value: String(entry.value ?? '').trim(),
            type: LAYERS.includes(entry.type) ? entry.type : 'fact',
            tags: entry.tags ?? ['import', 'session', 'handoff'],
          }))
          .filter((entry) => entry.value !== '');
        if (entries.length === 0) return;
        const result = await act('sessions/import', { entries });
        if (result === null) return;
        setNotice(
          translate('importDone')
            .replace('{imported}', String(result.imported ?? entries.length))
            .replace('{skipped}', String(result.skipped ?? 0)),
        );
        setSummary(null);
        setSummaryText('');
        setHandoffEntries(null);
        setHandoffChecked(new Set());
      }, [act, handoffChecked, handoffEntries, setNotice]);

      const candidates = extracted?.candidates ?? [];
      return h(
        'section',
        { style: cardStyle },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('strong', { style: { fontSize: 14 } }, translate('importTitle')),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void scan(),
              disabled: phase === 'scanning' || extractingId !== null,
              style: buttonStyle,
            },
            phase === 'scanning' ? translate('scanning') : translate('scanSessions'),
          ),
          h(
            'label',
            { style: { ...subtleText, display: 'flex', alignItems: 'center', gap: 6 } },
            translate('summaryKindLabel'),
            h(
              'select',
              {
                value: summaryKind,
                onChange: (event) => setSummaryKind(event.target.value),
                style: { ...inputStyle, width: 'auto', padding: '2px 6px', fontSize: 12 },
              },
              h('option', { value: 'conversation' }, translate('kindConversation')),
              h('option', { value: 'progress' }, translate('kindProgress')),
              h('option', { value: 'handoff' }, translate('kindHandoff')),
            ),
          ),
          llm !== null && llm.available
            ? h(
                'label',
                { style: { ...subtleText, display: 'flex', alignItems: 'center', gap: 6 } },
                h('input', {
                  type: 'checkbox',
                  checked: useModel,
                  onChange: (event) => setUseModel(event.target.checked),
                }),
                translate('useModelSummary'),
              )
            : null,
          llm !== null && !llm.available
            ? h('span', { style: subtleText }, translate('modelUnavailable'))
            : null,
        ),
        h('div', { style: subtleText }, translate('importHint')),
        error
          ? h(
              'div',
              { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } },
              `${translate('errorPrefix')}${error}`,
            )
          : null,
        phase === 'ready' && sessions.length === 0 ? h('div', { style: subtleText }, translate('noSessions')) : null,
        sessions.length > 0
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              sessions.map((session) =>
                h(
                  'div',
                  {
                    key: session.id,
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 8,
                      padding: '6px 8px',
                    },
                  },
                  h(
                    'div',
                    { style: { flex: '1 1 240px', minWidth: 0 } },
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 13,
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        },
                      },
                      session.title || translate('sessionUntitled'),
                    ),
                    h(
                      'div',
                      { style: { ...subtleText, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      `${fmtDate(session.updatedAt)} · ${session.id}`,
                    ),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => void extract(session),
                      disabled: extractingId !== null,
                      style: primaryButtonStyle,
                    },
                    extractingId === session.id ? translate('extracting') : translate('extractCandidates'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => void summarize(session),
                      disabled: extractingId !== null || summarySessionId === session.id,
                      style: buttonStyle,
                    },
                    summarySessionId === session.id
                      ? translate('generatingSummary')
                      : translate('generateSummary'),
                  ),
                ),
              ),
            )
          : null,
        extracted !== null
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: 13 } }, translate('candidatesTitle')),
                h('span', { style: subtleText }, translate('candidatesHint')),
                h('button', { type: 'button', onClick: () => selectAll(true), style: buttonStyle }, translate('selectAll')),
                h('button', { type: 'button', onClick: () => selectAll(false), style: buttonStyle }, translate('selectNone')),
                h(
                  'button',
                  { type: 'button', onClick: () => void doImport(), disabled: checked.size === 0, style: primaryButtonStyle },
                  translate('importSelected'),
                ),
              ),
              candidates.length === 0
                ? h('div', { style: subtleText }, translate('candidatesEmpty'))
                : h(
                    'div',
                    { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    candidates.map((candidate, index) =>
                      h(
                        'label',
                        {
                          key: `${candidate.key}:${index}`,
                          style: {
                            display: 'flex',
                            gap: 8,
                            alignItems: 'flex-start',
                            padding: '6px 8px',
                            borderRadius: 8,
                            border: '1px solid var(--dsw-alias-border-l1)',
                            cursor: 'pointer',
                          },
                        },
                        h('input', {
                          type: 'checkbox',
                          checked: checked.has(index),
                          onChange: () => toggle(index),
                          style: { marginTop: 3 },
                        }),
                        h(
                          'div',
                          { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
                          h(
                            'div',
                            { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                            h(
                              'span',
                              {
                                style: chipStyle(
                                  true,
                                  layerColor(LAYERS.includes(candidate.type) ? candidate.type : 'persona'),
                                ),
                              },
                              candidate.type ?? '',
                            ),
                            h('span', { style: { ...subtleText, fontFamily: 'monospace' } }, candidate.key ?? ''),
                          ),
                          h(
                            'div',
                            { style: { fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } },
                            candidate.value ?? '',
                          ),
                          h(
                            'div',
                            { style: subtleText },
                            candidate.source?.title || candidate.source?.sessionId || '',
                          ),
                        ),
                      ),
                    ),
                  ),
            )
          : null,
        handoffEntries !== null
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 8,
                  padding: 10,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: 13 } }, translate('handoffTitle')),
                h(
                  'span',
                  { style: subtleText },
                  `${summary?.session?.title || translate('sessionUntitled')} · ${summary?.mode ?? ''}`,
                ),
                h('span', { style: subtleText }, translate('handoffHint')),
              ),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => setHandoffChecked(new Set(handoffEntries.map((_entry, index) => index))),
                    style: buttonStyle,
                  },
                  translate('selectAll'),
                ),
                h(
                  'button',
                  { type: 'button', onClick: () => setHandoffChecked(new Set()), style: buttonStyle },
                  translate('selectNone'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void importHandoff(),
                    disabled: handoffChecked.size === 0,
                    style: primaryButtonStyle,
                  },
                  translate('importSelected'),
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                handoffEntries.map((entry, index) =>
                  h(
                    'div',
                    {
                      key: `${entry.key}:${index}`,
                      style: {
                        display: 'flex',
                        gap: 8,
                        alignItems: 'flex-start',
                        padding: '6px 8px',
                        borderRadius: 8,
                        border: '1px solid var(--dsw-alias-border-l1)',
                      },
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: handoffChecked.has(index),
                      onChange: () => toggleHandoffEntry(index),
                      style: { marginTop: 3 },
                    }),
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 } },
                      h(
                        'div',
                        { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                        h(
                          'span',
                          { style: chipStyle(true, layerColor(LAYERS.includes(entry.type) ? entry.type : 'fact')) },
                          entry.type ?? 'fact',
                        ),
                        h('span', { style: { ...subtleText, fontFamily: 'monospace' } }, entry.key ?? ''),
                        h('span', { style: subtleText }, `${String(entry.value ?? '').length}/180`),
                      ),
                      h('textarea', {
                        value: entry.value ?? '',
                        maxLength: 180,
                        rows: 2,
                        onChange: (event) => updateHandoffEntry(index, event.target.value),
                        style: {
                          ...inputStyle,
                          width: '100%',
                          resize: 'vertical',
                          fontFamily: 'inherit',
                          fontSize: 12,
                        },
                      }),
                    ),
                  ),
                ),
              ),
            )
          : null,
        summary !== null && handoffEntries === null
          ? h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 8,
                  padding: 10,
                },
              },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('strong', { style: { fontSize: 13 } }, translate(summary.kind === 'progress' ? 'progressTitle' : 'summaryTitle')),
                h(
                  'span',
                  { style: subtleText },
                  `${summary.session?.title || translate('sessionUntitled')} · ${summary.mode}`,
                ),
                h('span', { style: subtleText }, translate(summary.kind === 'progress' ? 'progressHint' : 'summaryHint')),
              ),
              h('textarea', {
                value: summaryText,
                onChange: (event) => setSummaryText(event.target.value),
                style: { ...inputStyle, width: '100%', minHeight: 130, resize: 'vertical', fontFamily: 'inherit' },
              }),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: subtleText }, translate('summaryTypeLabel')),
                h(
                  'select',
                  {
                    value: summaryType,
                    onChange: (event) => setSummaryType(event.target.value),
                    style: { ...inputStyle, width: 'auto' },
                  },
                  LAYERS.map((layer) => h('option', { key: layer, value: layer }, layer)),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => void importSummary(),
                    disabled: summaryText.trim() === '',
                    style: primaryButtonStyle,
                  },
                  translate('importSummary'),
                ),
              ),
            )
          : null,
      );
    }

    // -- the page -----------------------------------------------------------

    function RetroCard({ retros }) {
      return h(
        'section',
        { style: cardStyle },
        h('strong', { style: { fontSize: 14 } }, translate('retroTitle')),
        h('div', { style: subtleText }, translate('retroHint')),
        retros.length === 0
          ? h('div', { style: subtleText }, translate('retroEmpty'))
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
              retros.map((retro, index) =>
                h(
                  'div',
                  {
                    key: retro.key ?? `retro-${index}`,
                    style: {
                      border: '1px solid var(--dsw-alias-border-l1)',
                      borderRadius: 10,
                      padding: '10px 12px',
                      background: 'var(--dsw-alias-bg-base)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h('strong', { style: { fontSize: 13 } }, retro.title ?? retro.key ?? ''),
                    retro.date ? h('span', { style: subtleText }, retro.date) : null,
                    retro.timeCost
                      ? h(
                          'span',
                          { style: { ...subtleText, color: 'var(--dsw-alias-state-warn-primary)' } },
                          `${translate('retroTimeCost')}: ${retro.timeCost}`,
                        )
                      : null,
                  ),
                  retro.rootCause
                    ? h(
                        'div',
                        { style: { fontSize: 12, color: 'var(--dsw-alias-label-primary)' } },
                        `${translate('retroRootCause')}: ${retro.rootCause}`,
                      )
                    : null,
                  retro.lesson
                    ? h(
                        'div',
                        { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                        `${translate('retroLesson')}: ${retro.lesson}`,
                      )
                    : null,
                  retro.prevention
                    ? h(
                        'div',
                        { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                        `${translate('retroPrevention')}: ${retro.prevention}`,
                      )
                    : null,
                ),
              ),
            ),
      );
    }

    function LayerMemorySection() {
      const [phase, setPhase] = useState('loading');
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(null);
      const [pendingDelete, setPendingDelete] = useState(null);
      const [ignored, setIgnored] = useState(() => new Set());
      const [draft, setDraft] = useState({ key: '', value: '', type: 'persona', tags: '', ttl: '', scopes: [] });

      const load = useCallback(async () => {
        setPhase((current) => (current === 'ready' ? current : 'loading'));
        try {
          const state = await requestJson(STATE_ROUTE);
          setData(state);
          setError(null);
          setPhase('ready');
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setPhase('error');
        }
      }, []);

      useEffect(() => {
        void load();
      }, [load]);

      const act = useCallback(async (path, payload) => {
        setBusy(true);
        setNotice(null);
        try {
          const result = await requestJson(`${API}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload ?? {}),
          });
          if (result.state) setData(result.state);
          if (path === 'maintenance' && result.report) {
            setNotice(
              translate('maintenanceDone')
                .replace('{expired}', String(result.report.expired ?? 0))
                .replace('{merged}', String(result.report.merged ?? 0)),
            );
          }
          return result;
        } catch (cause) {
          setNotice(translate('errorPrefix') + (cause instanceof Error ? cause.message : String(cause)));
          return null;
        } finally {
          setBusy(false);
        }
      }, []);

      const startEdit = useCallback((layer, entry) => {
        setEditing({
          layer,
          key: entry.key,
          value: entry.value,
          tags: (entry.tags ?? []).join(', '),
          ttl: ttlToInput(entry.ttlMs),
          scopes: [...(entry.scopes ?? [])],
        });
      }, []);

      const updateEdit = useCallback((patch) => setEditing(patch), []);

      const cancelEdit = useCallback(() => {
        setEditing(null);
      }, []);

      const cancelDelete = useCallback(() => {
        setPendingDelete(null);
      }, []);

      const requestDelete = useCallback((layer, entry) => {
        setPendingDelete({ layer, key: entry.key });
      }, []);

      const saveEdit = useCallback(async () => {
        if (!editing) return;
        const result = await act('entry', {
          op: 'update',
          type: editing.layer,
          key: editing.key,
          value: editing.value,
          tags: splitList(editing.tags),
          ttl: editing.ttl,
          scopes: editing.scopes,
        });
        if (result) setEditing(null);
      }, [act, editing]);

      const submitDraft = useCallback(async () => {
        if (String(draft.key).trim() === '' || String(draft.value).trim() === '') {
          setNotice(translate('addKey') + ' / ' + translate('addValue'));
          return;
        }
        const result = await act('entry', {
          op: 'store',
          key: draft.key,
          value: draft.value,
          type: draft.type,
          tags: splitList(draft.tags),
          ttl: draft.ttl,
          scopes: draft.scopes,
        });
        if (result) setDraft({ key: '', value: '', type: 'persona', tags: '', ttl: '', scopes: [] });
      }, [act, draft]);

      const maintenance = useCallback(() => act('maintenance', {}), [act]);
      const setScenario = useCallback((scope) => act('settings', { activeScopes: scope === '' ? [] : [scope] }), [act]);
      const setDigestBudget = useCallback((value) => act('settings', { digestBudget: Number(value) }), [act]);
      const mergeCandidate = useCallback(
        (candidate, value) =>
          act('entry', {
            op: 'merge',
            layer: candidate.layer,
            keys: candidate.keys,
            ...(value === undefined ? {} : { value }),
          }),
        [act],
      );
      const ignoreCandidate = useCallback((candidate) => {
        setIgnored((current) => new Set([...current, candidate.keys.join('\u0000')]));
      }, []);
      const toggleEntry = useCallback(
        (layer, entry) => act('entry', { op: 'toggle', type: layer, key: entry.key, enabled: entry.enabled === false }),
        [act],
      );
      const deleteEntry = useCallback(
        async (layer, entry) => {
          const result = await act('entry', { op: 'delete', type: layer, key: entry.key });
          if (result) setPendingDelete(null);
        },
        [act],
      );

      const confirmDelete = useCallback(
        (layer, entry) => {
          void deleteEntry(layer, entry);
        },
        [deleteEntry],
      );

      if (phase === 'loading') {
        return h('div', { style: { padding: 8, ...subtleText } }, translate('loading'));
      }
      if (phase === 'error') {
        return h(
          'div',
          { style: { ...cardStyle, borderColor: 'var(--dsw-alias-state-error-primary)' } },
          h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, `${translate('errorPrefix')}${error ?? ''}`),
          h(
            'div',
            { style: { display: 'flex', justifyContent: 'flex-end' } },
            h('button', { type: 'button', onClick: () => void load(), style: primaryButtonStyle }, translate('retry')),
          ),
        );
      }

      const state = data ?? {};
      const layers = state.layers ?? {};
      const settings = state.settings ?? {};
      const activeScopes = settings.activeScopes ?? [];
      const working = state.working ?? {};
      const candidates = state.candidates ?? [];
      const budgetOptions = [1000, 1400, 1800, 2400, 3200];
      const currentBudget = Number(settings.digestBudget) || 1400;
      const actions = {
        startEdit,
        updateEdit,
        cancelEdit,
        saveEdit,
        toggle: toggleEntry,
        requestDelete,
        confirmDelete,
        cancelDelete,
      };

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14, width: '100%', boxSizing: 'border-box' } },
        h(
          'header',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 240px' } },
            h('h2', { style: { margin: 0, fontSize: 20 } }, translate('title')),
            h('div', { style: subtleText }, translate('subtitle')),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
            h(
              'select',
              {
                value: activeScopes.length > 0 ? activeScopes[0] : '',
                onChange: (event) => void setScenario(event.target.value),
                style: { ...inputStyle, width: 'auto', minWidth: 120 },
                title: translate('activeScopes'),
              },
              h('option', { value: '' }, translate('allScopes')),
              SCOPE_KEYS.map((scope) => h('option', { key: scope, value: scope }, scopeLabel(scope))),
            ),
            h(
              'select',
              {
                value: String(currentBudget),
                onChange: (event) => void setDigestBudget(event.target.value),
                style: { ...inputStyle, width: 'auto', minWidth: 110 },
                title: translate('digestBudgetLabel'),
              },
              budgetOptions.includes(currentBudget)
                ? null
                : h('option', { key: 'custom', value: String(currentBudget) }, String(currentBudget)),
              budgetOptions.map((value) =>
                h('option', { key: value, value: String(value) }, String(value)),
              ),
            ),
            h('button', { type: 'button', onClick: () => void load(), disabled: busy, style: buttonStyle }, translate('refresh')),
            h('button', { type: 'button', onClick: () => void maintenance(), disabled: busy, style: buttonStyle }, busy ? translate('maintenanceRunning') : translate('maintenance')),
          ),
        ),
        error ? h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, `${translate('errorPrefix')}${error}`) : null,
        notice ? h('div', { style: { ...subtleText, color: 'var(--dsw-alias-state-success-primary)' } }, notice) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 14, flexWrap: 'wrap', ...subtleText } },
          h('span', null, `${translate('dataDir')}: ${state.dataRoot ?? ''}`),
          h('span', null, `${translate('total')}: ${state.total ?? 0}`),
          h('span', null, `${translate('chars')}: ${state.chars ?? 0}`),
          h('span', null, `${translate('digestChars')}: ${(state.digest ?? '').length} / ${currentBudget}`),
          h('span', null, `${translate('totalHits')}: ${state.hits ?? 0}`),
          h('span', null, state.autoCapture ? translate('autoOn') : translate('autoOff')),
          h('span', null, `${translate('lastMaintenance')}: ${settings.lastMaintenanceAt ? fmtDate(settings.lastMaintenanceAt) : translate('never')}`),
          state.disabled > 0 ? h('span', null, `${translate('disabled')}: ${state.disabled}`) : null,
          state.expired > 0 ? h('span', null, `${translate('expires')}: ${state.expired}`) : null,
        ),
        h(
          'section',
          { style: cardStyle },
          h('strong', { style: { fontSize: 14 } }, 'working'),
          h(Progress, {
            label: translate('progressEntries'),
            percent: working.entryPercent ?? 0,
            detail: `${working.entries ?? 0} / ${working.entriesCap ?? 0}`,
            color: layerColor('working'),
          }),
          h(Progress, {
            label: translate('progressChars'),
            percent: working.charPercent ?? 0,
            detail: `${working.chars ?? 0} / ${working.charsCap ?? 0}`,
            color: 'var(--dsw-alias-state-idle-primary)',
          }),
        ),
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 } },
          LAYERS.map((layer) =>
            h(LayerCard, {
              key: layer,
              layer,
              entries: layers[layer] ?? [],
              busy,
              editing,
              pendingDelete,
              actions,
            }),
          ),
        ),
        h(AddEntryForm, { draft, setDraft, onSubmit: submitDraft, busy }),
        h(MergeCandidates, { candidates, ignored, busy, onMerge: mergeCandidate, onIgnore: ignoreCandidate }),
        h(SessionImport, { act, setNotice }),
        h(RetroCard, { retros: state.retros ?? [] }),
        h(
          'section',
          { style: cardStyle },
          h('strong', { style: { fontSize: 14 } }, translate('digestTitle')),
          h('div', { style: subtleText }, translate('digestHint')),
          state.digest
            ? h('pre', {
                style: {
                  margin: 0,
                  padding: 10,
                  background: 'var(--dsw-alias-bg-base)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontFamily: 'monospace',
                },
              }, state.digest)
            : h('div', { style: subtleText }, translate('digestEmpty')),
        ),
      );
    }

    // -- plugin entry -------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        if (locale !== undefined) {
          ctx.effect(() => locale.register('layer-memory', 'zh', DICT_ZH), 'layer-memory: locale zh');
          ctx.effect(() => locale.register('layer-memory', 'en', DICT_EN), 'layer-memory: locale en');
          try {
            translate = locale.bind('layer-memory');
          } catch {
            translate = (key) => DICT_ZH[key] ?? key;
          }
        }
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'layer-memory', order: 25, label: () => translate('sectionLabel') },
            LayerMemorySection,
          ),
        );
      },
    };
  },
});
