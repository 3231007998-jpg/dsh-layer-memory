# Layer Memory（分层记忆）

给 DeepSeek Harness 智能体用的本地分层长期记忆插件。纯 Host 插件、零运行时依赖、不联网，所有记忆保存在本机 JSONL / Markdown 文件里。

## 三层记忆

| 层 | 语义 | 生命周期 |
| --- | --- | --- |
| `working` | 工作记忆：当前任务的临时要点、中间结论 | 有容量上限；写满后把最旧条目自动归档进 `fact` 层（不丢数据） |
| `persona` | 人格画像：用户偏好、习惯、沟通风格、稳定设定 | 长期保留，优先注入系统提示 |
| `fact` | 事实知识：项目事实、决定、约定、可复用知识 | 长期保留 |

同一个层内以 `key` 为主键做 upsert：重复写入同一 key 会替换 value、合并 tags 并刷新 `updatedAt`。跨层同 key 互不影响。

## 工具

插件注册四个工具（沿用 layer-memory 原始 MCP 工具名）：

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `memory_store` | `key`（必填）、`value`（必填）、`type`（`working`/`persona`/`fact`，默认 `working`）、`tags`（字符串数组）、`scopes`（场景数组，如 `["coding"]`）、`ttl`（临时有效期，如 `7d`/`12h`/`30m`） | 新增或更新一条记忆 |
| `memory_recall` | `query`、`type`、`tags`、`limit`（默认 5，最大 50） | 检索记忆；query 按空白分词，所有词都必须命中 key/value/tags；按 key 精确命中、tag、value、使用次数、衰减权重与新鲜度排序；命中会累计 `hits` 并刷新 `lastHitAt` |
| `memory_export` | `outputPath`（可选） | 把三层导出为一个可读 Markdown 文件（默认 `exports/layer-memory-<时间戳>.md`） |
| `memory_import` | `inputPath`（必填）、`mode`（`merge`/`replace`，默认 `merge`） | 从 Markdown 导出、JSON 数组或 JSONL 导入 |

`memory_import` 支持读取本插件导出的 Markdown、纯 JSON 数组、以及每行一个 entry 的 JSONL；`replace` 会先清空三层再导入。

## 自动注入

插件激活后向系统提示注入两部分（可选服务，缺失时自动跳过）：

1. **用法指引**：告诉模型何时该 `memory_store` / `memory_recall`。
2. **记忆摘要**：每个模型 step 渲染一次 `<layer-memory>` 摘要（persona → working → fact），默认预算 1400 字符，超预算自动裁剪；预算可在设置页顶部「注入预算」下拉或 `settings.json` 的 `digestBudget`（200–8000）里调整。

## 记忆生命周期：TTL、衰减与维护

- **TTL（过期时间）**：`memory_store` 可传 `ttl`（如 `7d`、`12h`、`30m`、`2w`、`3天`；`null`/`never` 表示永不过期）。过期条目不会进入注入摘要与 recall，并在维护任务中被删除、归档到 `archive/expired-<日期>.jsonl`，数据不丢。自动抽取里带“今天/这次/临时/暂时…”等临时语义的句子会自动加 `1d` TTL。
- **衰减权重**：每条记忆的注入权重 `weight = (1 + 0.5 × min(hits, 20)) × 0.5^(距上次命中的天数 / 半衰期)`，半衰期 working=2 天、fact=30 天、persona=180 天。权重低于 `0.15` 的条目不进入摘要（但仍可被 recall 与在设置页看到），命中会刷新 `lastHitAt` 让权重回升。
- **维护任务**：插件启动约 5 秒后跑一次、之后默认每小时一次（`settings.json` 可调 `maintenanceIntervalMs`，最小 60 秒）。维护会①清理过期条目；②对同层、相似度 ≥ 0.78 且无冲突的条目自动合并（保留命中多/更新的那条，value 去重合并、tags/scopes 并集、hits 求和）。

## 场景作用域与启用开关

- **场景 scopes**：条目可打场景标签（默认 `coding`、`chat`、`writing`、`work`）。`scopes` 为空表示全局生效；设置页顶部可以切换“当前场景”，切换后注入摘要只包含匹配场景或无场景的条目，避免写代码的偏好串到闲聊里。
- **全局生效开关**：每条记忆都可以单独启用/禁用（禁用后不注入、不参与 recall 命中，但保留在设置页可随时恢复）。

## 去重合并

设置页的「合并候选」区会列出同层语义相近的条目（相似度 ≥ 0.45）：无冲突的候选可一键合并；检测到冲突（如“中文/英文”“喜欢/讨厌”“开启/关闭”）时提供「保留左项 / 保留右项」两个选择，不会自动替你决定。相似度基于字符二元组 Jaccard + 关键词冲突检测，零依赖、不调用模型；更智能的语义合并（LLM 总结）留作后续扩展。

## 自动抽取记忆

插件在每一步模型开始前（`agent/pre-step`）扫描本步的用户消息，自动抽取两类**明确表达**，不需要用户手动调工具：

| 用户说的话 | 抽取到 | 示例 |
| --- | --- | --- |
| 显式要求记住 | `fact` | “记住：部署在 3000 端口”“记一下，项目代号是 Skyline”“remember that the key is in .env.local” |
| 稳定偏好 / 自我描述 | `persona` | “我叫小林”“我喜欢简洁的中文回答”“以后都用中文回答”“用英文回答”“prefer TypeScript”“call me Lin” |

抽到的条目：

- 带 `auto` 标签（`tags: ["auto", "remember"]` 或 `["auto", "preference"]`），用 `memory_recall` 能一眼认出；
- 立即进入下一次系统提示的记忆摘要；
- key 由内容哈希生成（`auto-<sha1 前10位>`），同一句话重复出现只会更新同一条，不会膨胀。

自动抽取只处理明确语句：疑问句、普通闲聊、过长的消息（>4000 字符，可能是粘贴的上下文或子智能体任务描述）都会跳过，不做猜测式记忆。想关闭时设置环境变量 `DSH_LAYER_MEMORY_AUTO=0`（或 `false`/`off`/`no`）。

## 数据位置与格式

默认数据目录：`$DSH_HOME/layer-memory`（通常为 `$DSH_HOME\layer-memory`）。

```
layer-memory/
├── working.jsonl      # 每行一个 JSON entry
├── persona.jsonl
├── fact.jsonl
├── settings.json      # 当前场景 activeScopes、注入预算 digestBudget、维护间隔、上次维护报告
├── archive/           # 过期条目归档（expired-<日期>.jsonl）
└── exports/
    └── layer-memory-2026-01-01T00-00-00-000Z.md
```

entry 结构：

```json
{"key":"user-name","value":"Alice","type":"persona","tags":["profile"],"scopes":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z","lastHitAt":"2026-01-01T00:00:00.000Z","hits":3,"enabled":true,"ttlMs":null,"expiresAt":null}
```

旧版本导出的 entry（缺少 `enabled`/`lastHitAt`/`scopes` 等新字段）在加载时会自动补默认值，向后兼容。

写入使用临时文件 + rename 原子替换，并串行化，避免并发写损坏文件。启动时若 JSONL 有损坏行，会跳过该行并在日志里告警，不会让插件加载失败。

## 配置

不声明插件 Config，无需在 `cordis.patch.yml` 里配置。可用的环境变量：

- `DSH_LAYER_MEMORY_DIR`：覆盖数据目录（绝对路径或相对路径）。
- `DSH_LAYER_MEMORY_AUTO`：自动抽取记忆开关，设为 `0` / `false` / `off` / `no` 时关闭；默认开启。

## 安装

```powershell
# 用 plugin_manager 安装本目录（绝对路径）
plugin_manager action=install_bundle target="<repo>"
```

安装后 bundle 行 id 为 `layer-memory`。工具与提示注入在新会话或刷新后生效；已打开会话若看不到工具，先刷新页面 / 新开会话。

## Web 界面

插件在 Harness 设置里注册一个「分层记忆」页面（`settings.section`，order 25），可以直接查看并**管理**记忆：

- **概览**：数据目录、总条数/字符数、累计命中、禁用/过期条数、自动抽取状态、上次维护时间；顶部可切换当前场景（全局 / coding / chat / writing / work）、调整**注入预算**（1000/1400/1800/2400/3200 字符，并显示当前注入摘要已用字符数）并手动「运行维护」。
- **working 进度条**：working 层容量使用率（条目数、字符数两条进度条），直观看到还有多少空间。
- **三层卡片**：每层条目数、命中数、条目列表（key、value、tags、场景、TTL/过期时间、命中次数、衰减权重条、更新时间）；支持逐条**编辑 / 删除 / 启用停用**、改 TTL、改场景。
- **新增记忆**：页面内表单直接新增（key、value、层、tags、TTL、场景）。
- **合并候选**：语义相近条目列表，显示相似度与冲突状态，支持一键合并、保留左/右项或忽略。
- **注入摘要**：当前实际注入系统提示的 `<layer-memory>` 摘要原文，可展开查看。

页面数据由 Host 的 `/layer-memory/api/` 提供：`GET /layer-memory/api/state` 返回完整投影 JSON；`POST /layer-memory/api/entry`（`op: store|update|delete|toggle|merge`）、`POST /layer-memory/api/maintenance`、`POST /layer-memory/api/settings`（如 `{"activeScopes":["coding"]}`、`{"digestBudget":1800}`）执行管理操作，均返回最新 state；`GET /layer-memory/api/sessions` 列出本机其他对话、`POST /layer-memory/api/sessions/extract`（`{"sessionId":"..."}`）提取候选、`POST /layer-memory/api/sessions/import`（`{"entries":[...]}`）导入所选条目并返回最新 state、`POST /layer-memory/api/sessions/summarize`（`{"sessionId":"...","mode":"extractive"|"llm","kind":"conversation"|"progress"|"handoff","provider?":"...","model?":"..."}`）生成对话摘要、工作进度摘要或项目交接原子条目（`llm` 模式需要模型服务可用）。浏览器端只负责渲染，不直接读文件系统。打开方式：设置 → 分层记忆（中文界面）或 Settings → Layer Memory（英文界面）；界面文案通过 Client locale 服务本地化。

## 从其他对话导入记忆

设置页底部有「从其他对话导入记忆」区块：先「扫描其他对话」，选中一个对话后「提取候选」，勾选想要的条目，再「导入所选」。导入的条目会带上 `import`、`session` 标签，并立即进入当前记忆。

- 只读解析本机 `$DSH_HOME/sessions/<workspace>/<session>/session.v4.jsonl.zstd` 里用户消息的文本，不会修改或上传任何对话数据；解析用 Node 自带的 zstd 解压，零依赖。
- 候选规则与自动抽取一致（显式“记住…”→ fact，稳定偏好/自述 → persona），并会跳过已存在或语义高度相似的条目、跳过疑问句与 subagent 样板消息。
- 单条对话日志超过 64 MB 时跳过；结果按最近修改时间列出（默认最近 20 个）。
- 这是启发式“挑句子”，不是 LLM 式整段总结；需要理解的摘录可后续接模型服务再做。

## 对话摘要式导入

设置页「从其他对话导入记忆」区块里，每个对话还多了一个「生成摘要」按钮：生成后会在下方出现可编辑的摘要文本框与「导入层级」选择，点「导入这条摘要」即可保存为 fact 或 persona 条目。

- 默认使用**本地启发式摘要**（不联网、零依赖）：从日志里提取对话标题、更新时间、消息规模、高频关键词、偏好/要求句与最近请求，拼成固定格式的中文摘要，内容完全可编辑。
- 勾选 **「用模型总结（消耗模型额度）」** 后，会调用 Harness 的 `llm` 服务（`ctx.get('llm')` → `stream()`，流式聚合 `text-delta`）生成更自然的摘要；默认取 `deepseek-account` / `deepseek-flash`，也可在请求体里传 `provider`/`model` 指定。模型调用失败时（服务不可用、鉴权/额度问题、模型返回空内容等），接口会**自动回退到本地启发式摘要**并返回 `fallback: "extractive"` 与 `warning`（真实失败原因，如 `EMPTY_RESPONSE`），界面提示原因并展示本地摘要，不会留下空文本框。
- 模型摘要只在用户勾选并点击时调用一次，不会在后台自动消耗额度。

## 工作进度摘要（交接用）

摘要类型除「对话摘要」外，还可选 **「工作进度（交接）」**——它更关心“这个对话做到了哪一步”，方便在另一个对话里接着干：

- 本地启发式（默认）：从会话日志里提取 **任务目标**（首条用户请求）、**待办清单进度**（解析 `todo/write` 事件：已完成 / 进行中 / 待办，并列出条目）、**最近动作**（最近的工具调用，如“写文件：…/index.js”“执行命令：…”）、**涉及文件**、**下一步**（优先取进行中/待办项）与关键词。
- 勾选「用模型总结」时，会把对话文本 + 待办清单 + 最近工具动作一起交给 Harness 模型，生成「任务目标 / 已完成 / 当前状态 / 下一步 / 涉及文件」式摘要；系统提示词也换成工作交接角色。
- 生成后同样可编辑、选择导入层级（默认 fact），点「导入这条摘要」保存；接口仍为 `POST /layer-memory/api/sessions/summarize`，新增可选 `"kind": "progress"`（默认 `"conversation"`）。

## 项目交接：原子条目（生成层改法）

摘要类型再增加 **「项目交接（原子条目）」**，从**生成这一层**就解决“摘要太长被截断、含临时噪声、前后矛盾”的问题，而不是事后人工拆分：

- 输出单位不再是整段摘要，而是一组 **≤180 字的原子记忆条目**（正好等于系统提示里每条记忆的展示上限），因此每一条都会完整出现在后续对话的自动注入摘要里。
- **模型模式**：系统提示词换成“项目交接记忆工程师”，要求模型只输出**单行、紧凑、可被 `JSON.parse` 直接解析**的 JSON 数组（每条 ≤150 字，禁止代码块/注释/尾逗号），必须覆盖任务目标、最终产物的完整路径、已完成事项、下一步、数据缺口与偏好；并明确禁止 token 余额/额度/耗时/重试/临时目录/API key 等噪声，要求区分「交付物已完成」与「数据侧待补」，不得自相矛盾或编造。返回后会被解析、校验（去噪、截断、非法 type 归 fact、上限 12 条）。模型模式默认给 3000 maxTokens（推理型模型的思考也会占额度）。
- **本地启发式模式**（不联网）：直接从会话日志生成原子条目：`handoff-task`（任务）、`handoff-artifacts`（涉及文件）、`handoff-done`（已完成 n/总数）、`handoff-next`（下一步）、`handoff-data-gaps`（“数据侧待补：…”）、`handoff-preferences`、`handoff-keywords`；含 token 余额等噪声的行会被丢弃。
- 若模型输出不是合法 JSON 数组（含被截断的半截 JSON、带解释文字的“伪 JSON”），**不会**再把原始文本切片导入（那样会得到一堆 JSON 碎片），而是抛错并由接口**自动回退到本地启发式原子条目**，同时返回 `fallback: "extractive"` 与 `warning`（真实原因），界面提示后展示干净的本地条目。
- 生成后界面会列出每条候选：可勾选、逐条编辑（textarea 限 180 字）、全选/全不选，再「导入所选」；建议导入 **fact 层**（半衰期 30 天）而不是 working 层。
- 接口：`POST /layer-memory/api/sessions/summarize` 增加 `"kind": "handoff"`；返回 `candidates` 数组（每条 `{key, value, type, tags}`），可整体交给 `POST /layer-memory/api/sessions/import`（`{"entries":[...]}`）导入。

Host 端 JS 与浏览器端模块图都需要重启 DSH 后才会加载新版本，更新插件代码后请完全退出并重启应用再查看。

## 复盘（retro，v1.8.0）

用 `memory_retro` 记录事故与低效环节，把“踩过的坑”变成可检索的经验，避免重复浪费：

- `record`：`title`、`symptom`（现象）、`rootCause`（根因）、`fix`（修复）、`lesson`（教训）、`prevention`（预防）、`timeCost`（耗时，如“约 40 分钟 + 2 次重启”）。
- `list`：按时间倒序列出；可用 `title` 作为关键字过滤。
- 复盘存为 `fact` 层条目并打 `retro` 标签，**故意不进入自动注入摘要**（不占用 digest 预算），需要时用 `memory_recall` 或设置页「复盘（事故与低效记录）」卡片查看。
- 适合记录的时机：修完一个非平凡 bug、排查超时、重复绕路验证（例如“为了验证插件改动反复开新对话等待”）、以及“本来可以更快”的工作流。
- 接口层没有单独路由：面板数据里的 `retros` 与 `counts.retro` 由 `lib/retro.js` 投影，写入走工具调用（模型侧）。

## D2 / D4 原型（v1.9.0）

依据 RAG 五缺陷权重试验（`first-principles-eval/rag-defects-phase3`）的优先级结论（**D2 相关性 34.6%、D4 结构化 26.4%** 最高），在 layer-memory 里落地了两个可开关的原型：

- **D2 相关性门控**（`lib/relevance.js`）：
  - 检索/注入前把 query 与条目都归一化为检索 token（CJK 二元组 + ASCII 词，去停用词），ASCII 标识符（端口、库名、版本号）权重更高；
  - 要求至少命中一个「判别性 token」（在候选集里 rarity 足够低，或含数字），仅靠“通用词重叠”（例如“现在/怎么/使用”）不会把条目拉进上下文；
  - 自动注入侧：`agent/pre-step`（waterfall，先 `await next()` 再追加）在用户消息与记忆明显匹配时才注入一小段 `<layer-memory-recall>` 块（最多 3 条、每条 180 字），同一 session + prompt 只注入一次；失败不影响本轮对话；
  - **开关**：环境变量 `DSH_LAYER_MEMORY_RECALL_GATE=0`（或 false/off/no）关闭；`memory_recall` 的关键词召回也复用同一套重排（`input.relevance === false` 可跳过）。
- **D4 结构化写入**（`lib/atomic.js`）：`memory_store` 的 value 超过 **180 字**时自动按句读边界切成多条原子条目，存为 `<key>·1…<key>·N` 并打 `atomic` 标签（`join('') === 原文`，不丢字）。这样每条都能进自动摘要（digest 每条最多 180 字）且可单独检索，而不是被截断成不可见的半截。
- 预期效果（与试验设置一致）：明显相关但用词不同的记忆能被召回，而只是共享通用词的条目不会被误注入；长笔记不再在摘要里“隐身”。
- 注意：这是**启发式**原型——D2 不用向量/模型，D4 不重写语义；对精确实体（路径、代号、版本）最有效。

## 自测

工作区自带一个纯 Node 自测脚本（不依赖 Harness 运行时）：

```powershell
$node = "$DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node scripts/selftest.mjs
```

覆盖（47 项）：三层 store/upsert、关键词与标签 recall（含 limit 校验与命中计数）、working 溢出归档、export→import 回读、replace 模式、摘要预算与 persona 优先、损坏 JSONL 告警、工具 JSON Schema 子集校验、五个工具 execute/render 直调、复盘记录/列表/检索/不进入注入摘要/面板投影与校验、自动抽取规则（显式“记住”/偏好/疑问句与闲聊跳过/去重/环境变量关闭/pre-step waterfall 透传）、设置页数据投影（层计数/倒序/digest/autoCapture 开关/working 使用率/权重/统计/合并候选）、TTL 解析与过期归档、衰减权重、场景 scopes 过滤摘要、可配置注入预算（settings 写入/上下限钳制/摘要随预算变化）、合并候选与合并、管理 API（state GET/HEAD、entry/settings/maintenance/sessions/summarize POST、404/405）、其他对话日志多帧 zstd 解码与半帧容错、对话列表/候选抽取/重复过滤/导入、对话摘要（启发式摘要生成/摘要导入/llmSummary 流式聚合/模型不可用回退/流式失败透传/块结束文本回退与仅推理截断判定）、工作进度摘要（待办进度/最近动作/涉及文件/下一步/进度候选导入）、项目交接原子条目（启发式原子条目与噪声过滤/数据缺口条目/导入、模型 JSON 输出解析与校验去噪、非 JSON 模型输出拒绝切片并回退、纯文本按行兜底切分工具、模型 kind=handoff 提示词与 maxTokens、API 层 llm 失败自动回退本地原子条目）、D2 相关性门控（判别性 token 召回/泛词查询不误召回）、D4 原子写入（切分不丢字/超长值落为 `key·N` 且打 atomic 标签）、query-aware recall 注入（pre-step 透传/注入一次/无关 prompt 不注入）。

## 限制

- recall 是确定性的关键词/标签匹配，不做向量检索或模糊拼写纠正。query 用词尽量选 key/tag 中的词。
- 自动抽取是启发式规则（零依赖、不调用模型）：只抓“记住…”这类明确语句和稳定偏好，不会理解式地总结整段对话；需要理解式总结时，可在设置页用「生成摘要 + 用模型总结」按需调用模型。
- 合并也是启发式的：高相似度 + 无冲突才自动合并；语义相近但用词差异大的条目需要人工在设置页确认，**没有**做 LLM 语义总结（本轮刻意避免引入模型调用与费用；后续可接 Harness 的 llm 服务实现）。
- 假设单机单进程访问同一个数据目录；多进程同时写同一目录未做文件锁。
- 导出文件含全部记忆内容，注意不要提交到公开仓库。

## 目录结构

```
dsh-layer-memory/
├── package.json
├── cordis.patch.yml
├── index.js            # 插件入口：注册工具 + 提示注入 + 自动抽取 + 设置页 HTTP 数据通道
├── client.js           # 浏览器端：设置里的「分层记忆」页面
├── lib/
│   ├── store.js        # 分层存储、检索、导入导出、摘要渲染
│   ├── tools.js        # 五个 ToolDefinition（含 memory_retro）
│   ├── retro.js        # 复盘条目：记录、解析、列表、注入摘要排除
│   ├── relevance.js    # D2 原型：token 化、判别性匹配、条目重排、注入消息与 recall 块
│   ├── atomic.js       # D4 原型：长值按句读边界切成 ≤180 字原子条目
│   ├── autocapture.js  # agent/pre-step 上的启发式自动抽取
│   ├── sessions.js     # 读取其他对话日志：候选抽取、对话摘要、工作进度摘要、项目交接原子条目（导入功能）
│   └── dashboard.js    # 设置页只读数据投影（HTTP route 使用）
├── locale/{en,zh}.json # 展示用标题与描述
├── icon.svg            # 原创图标
├── scripts/selftest.mjs
└── README.md
```
