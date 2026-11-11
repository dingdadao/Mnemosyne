# Mnemosyne 设计复盘：对着 Hindsight 的 coding-agents 集成，我们哪一步走反了

> 分析对象：`vectorize-io/hindsight` → `hindsight-integrations/coding-agents`（v0.8.6，60k★，2026-11-10 仍在日更）
> 对照对象：本仓库 `plugin/index.js`、`server/search.js`、`server/db.js`、`SKILLS.md`
> 结论先行，证据在后。所有 Hindsight 引用都标了源码位置，可以自己复核。

---

## 0. 一句话结论

**产品定位没错，默认路径选反了。**

现在的默认是「Agent 自己想起来去查」——要求模型有元认知，能意识到"我该翻旧账了"。
Hindsight 的默认是「开工前把结论塞到眼前」——只要求检索别太差。

前者听起来高级（Pull, not Push），实际上是**把产品的成败押在模型的自觉性上**。而模型的默认行为是直接干活。
Hindsight 在 AMB sdebench（61 个真实仓库任务 × 3 次）上量的不是准确率——两边都 60/61——而是：

| Agent | 纠错次数/任务 | 成本/任务 |
|---|---|---|
| Claude Code | 0.85 → **0.36** | $0.445 → **$0.338** |
| Codex CLI | 1.34 → **0.47** | $0.577 → **$0.276** |
| opencode | 1.20 → **0.80** | $0.634 → **$0.553** |

**记忆产品的成本不是注入的那几百 token，是纠错回合。** 一次纠错 = 一轮 token + 一轮人的注意力。
我们 README 里那张「灵枢 70,000 token vs 我们 150 token」的表，省的是小钱，代价是把纠错次数留在了 0.85 那一侧。

---

## 1. 两个产品在解不同的题

| | Mnemosyne（现在） | Hindsight |
|---|---|---|
| 谁写入 | Agent 自觉调 `memory_save` | 后台自动：git 历史 + 会话转写 + 一次性勘察 |
| 谁触发检索 | 关键词启发式 → 给 Agent 一条提示 | 会话首轮结构化召回 → 直接注入结论 |
| 冷启动 | 空库，等 Agent 施舍第一条记忆 | 首次会话自动播种（git log + 代码库勘察） |
| 注入位置 | `systemPrompt.section` | 用户消息（user turn），且首轮一次 |
| 失败模式 | 静默：没注入 = 看起来"省了 token" | 静默降级为无记忆回合 + `diag.jsonl` 留证 |
| 可证明的价值 | 回归探针（检索质量） | usage/credit rate + 公开 benchmark |

差别不在技术栈，在**"记忆存在的默认状态"**。我们的默认状态是"没有"，他们的默认状态是"有，而且会自己长"。

---

## 2. 现在这套的四处硬伤（带行号）

### 2.1 插件从来不检索——"预测式召回"实际是"预测式提醒"

`plugin/index.js:233-258`（节选）：

```js
const query = originalText.slice(0, 100);
// We don't inject the result directly - we add a hint that suggests searching
if (ctx.systemPrompt?.section && state.hintsGiven < maxHintsPerSession) {
  ctx.systemPrompt.section({ ... text: `> [Mnemosyne] This seems like a continuation. Consider calling memory_search with query: "${query}"` });
}
```

`state.autoRecallsDone++` 加了，但**全程没有一次 `fetch(/memory/search)`**。
所谓 HIGH 置信度 auto-recall，产出物是一条「你可以去搜一下」的提示。整个会话里，唯一真的碰到记忆的路径是 Agent 自愿调工具。

这不是实现 bug，是设计选择——但选错了：**我们把"检索"这件事外包给了一个不知道库里有啥的模型。**

### 2.2 提示是税，不是红利

一条 hint ≈ 50 token + 一次工具调用 + 一次往返等待。收益只有在 Agent 真的去查、查到有用的、并且用上时兑现。
三段串联的成功率，乘起来很低。而「把结论直接放眼前」的成功率只取决于检索质量这一段。

我们省下的是注入 token，付出的是**每一轮都可能发生的重复解释**。

更糟的是这套提示还"一次性"：`errorHintsGiven` / `decisionHintsGiven` / `continuationHintsGiven` 一旦置真就永久放弃，而且**一次失败或一次空检索都会把整个会话的记忆判死**。Hindsight 那边是"失败 2 次、空结果 5 次，且都不缓存成'本会话无记忆'"（`hook.ts:102-124`）——同一个问题，两种处理方式。

### 2.3 冷启动死锁

链路是：`Agent 主动 save` → `库里有东西` → `search 才有价值` → `hint 才有意义`。
第一环在真实会话里发生频率极低（模型没有理由主动存档），于是后面三环全部归零。
Hindsight 把第一环改成自动的，整条链才转起来。

顺带一个真 bug：**话题切换分支只烧配额不干活**（`plugin/index.js:277-300`）——`state.hintsGiven++` 后只打了 log，没有 `systemPrompt.section` 调用。三次配额里有一次是纯浪费。

### 2.4 注入通道选错，且没有仓库维度

- 注入走 `systemPrompt.section`，而且内容每轮变化 → 破坏 provider 的前缀缓存。Hindsight 在 `runtime.ts:236-246` 把这条写成了硬约束（#5914）：注入必须进 user turn，且首轮一次，让 system prompt 和早期历史保持字节不变。
- `workspace` 默认写死 `'default'`（`plugin/index.js:70`），所有仓库共用一锅。远端那个 `workspace` 参数是配置常量，不是从 git root 推导的。

---

## 3. 该抄的七个机制

### 3.1 自动沉淀：git 种子 + 逐提交增量 + 会话回写

`deepen.ts`（后台引擎，每次会话启动时被 detached spawn）+ `core/retain-cursor.ts` + `core/git.ts`。

机制要点：
- **文档 id 决定幂等**：`gitlog:<repo>`、`survey-baseline:<sha>`、每提交一个文档。重跑只做缺的活。
- **游标而不是全量**：`gitlog-head:<sha>` 标签记录已消化的提交，新提交只 append 增量；一旦记录的 sha 不再是 HEAD 的祖先（rebase / force-push），或新增超过 `seedLimit`（默认 300），才整篇重写。
- **无客户端节流**：`runtime.ts:266-280` 明确写了不做客户端批处理——批处理要把 turn 存在一个随时会被关掉的进程里；改成服务端 fold（同一文档的排队 retain 合并成一次抽取）。这条经验对我们直接可用：我们的插件跑在 dsh 进程里，进程随时可能退出。
- **顺序也是设计**：`deepen.ts:169` 注释——会话先于 git 灌入，因为"会话少，但正是它们携带了让记忆变得必要的那些决策，绝不能被 git 的洪流饿死"。
- **只报告最缺的活**：`listDocumentIds(tag, "all_strict")` 分页 500/页，用来算"哪些提交还没有 `git:<sha>` 文档"，而不是信任本地状态。
- **live 回写用指纹决定 append 还是 replace**：`retain-cursor.ts:171-184`，指纹 = 轮数 + 每轮 JSON 的 sha1；明确拒绝"只取首尾采样"，因为中间被改写时首尾都没变。所有不确定情况一律 `replace`。

**我们的改法**：加 `documents` 表 + `ingest_cursors` 表；插件在 turn 结束（`agent/turn-stopping`）把本轮 user+assistant 文本 POST 回写；服务端按 `doc_id = sha1(workspace|session|turn_index)` 去重。

### 3.2 冷启动要三态，不是布尔

`session-start.ts:13` 注释：布尔值会把「冷库」和「服务器连不上」压成同一个 `false/true`，结果是服务器抖一下就被当成空库，反复重新播种。

他们的解：`cold: true | false | undefined`（undefined = 没查成），只有**确认空**才触发播种。

**我们的改法**：`GET /health` 扩成 `{ ok, bank: { docs, pages, seeded_at }, cold: bool }`；播种逻辑只在 `cold === true` 时跑。

### 3.3 一次性代码库勘察，产出四篇固定文档

`survey.ts:57-64`：

```ts
export const SURVEY_DOC_IDS = [
  "repository-component-map",
  "repository-core-concepts",
  "repository-conventions-and-patterns",
  "repository-tech-stack-and-features",
] as const;
```

配套三个细节，都是踩过坑写下来的：
- 勘察跑在**只读沙箱 agent** 里（`SURVEY_AGENT_CONFIG`：`*: deny`，只 allow `read/grep/glob` + 一个 ingest 工具），因为勘察要读不可信仓库内容，是 prompt injection 面。
- 用 **lease** 防并发（`survey-lease.ts`），`survey-baseline:<sha>` 文档记录起点，但不作为"已完成"的证据——**只有四篇 findings 全部落地才算完成**（`docs-freshness` 同理）。
- 重跑节奏 `surveyRefreshCommits`（默认 20 个提交），基线有 marker 无 findings 会自动重试，最多三次（`SURVEY_MAX_ATTEMPTS`，本地 `attempts-<hash>.json` 计数）。
- 勘察 prompt **明令禁止读 `CLAUDE.md` / `AGENTS.md` / `.cursorrules`**（`survey.ts:157-180`）——那些是别的 agent 写给自己的指令，读进来就等于把别人的 prompt 抄进我们的记忆。

**我们的改法**：这个用 dsh 自己的 headless 跑，或者干脆用模板抽取（读 package.json / 目录树 / 测试文件命名 / CI 配置）生成前三篇的 60%——不需要 LLM 也能出可用的约定文档。

### 3.4 注入的是结论，不是提示——而且渲染规则要写死

`inject.ts:10-35` 的 `buildReflectQuery` 是整个仓库最值得抄的一段。它约束的不是"检索什么"，而是"怎么说"：

- 只允许陈述句、过去时、带日期与 commit/PR id 的归因事实；
- **禁止祈使句**（`"you should" / "remove" / "update…"`）——因为一句"你应该删掉 X"在接收端和 prompt injection 无法区分；
- 映射/集合/字面值表必须**完整逐字复现**，不许摘要、不许举例（"摘要掉的正是读者需要的那些值"）；
- 不许把无关事件缝成一个连贯叙事；
- 库里没有就说没有，一句话结束。

作者注里写了触发这次修订的事故：0.8.6 那版 reflect 把真实但无关的历史熔成一段祈使句叙事，模型直接整块丢弃。

**我们的改法**：`server/brief.js`（已写，见下）就是这套规则的抽取式实现——模板负责语气，记忆只负责内容。**不引入 LLM 也能拿到 80% 的收益**，因为大部分要注入的东西本来就是"某年某月定了某条规则"这种陈述。

配套的两个"预算"语义（`hook.ts:102-141`），比措辞更容易被忽略：

- **失败与空结果分开计数**：一次失败最多重试 2 轮，一次"检索跑通了但没命中"最多 5 轮。理由写在注释里——空检索很便宜，而且首句"hi"匹配不到任何东西，并不能说明真实问题找不到。
- **两种结果都不许缓存成"本会话没有记忆"**：首次提示超时（#4607）或首次提示恰好没命中（#5082），都曾让整个会话失去记忆。
- **查询要按 token 截断**（500），否则长 prompt 或非拉丁文会被服务端 400（#5476）；英文按半 token 估、非 ASCII 按字节估。
- 注入路径用 `budget: "low"`，Agent 主动调的 `hindsight_reflect` 才用 `high`——**自动注入要便宜，手动深挖才贵**。
- **只有超时 / 5xx 才降级**（先知识页、再原始 recall），"检索成功但没命中"不降级——那是检索真的没东西，换条路也只是把噪音换个形状搬上来。
- 客户端**不截断**正文：长度由上游控制（reflect 输出、recall `max_tokens: 2000`、`pageSearchLimit` 命中数）。这条我们不能照抄——我们没有服务端 token 预算，所以 `brief.js` 必须自己按字符预算截，而且**整条丢弃而不是切断**。

### 3.5 注入包装要"校准"，不是"强推"

`inject.ts:82-120` 的 `<hindsight_memory>` 包装做了四件事：说明来源（"本仓库记忆库，启发式检索，可能不相关"）、**显式授权忽略**、声明这是过去记录不是任务、要求引用时标注来源、发现记忆错了就写一条 `Correction: <topic>` 回写。

理由写在注释里：过度自信的包装（"这解释了你的问题，必须精确应用"）遇到跑偏的记忆，读起来和注入攻击一模一样，谨慎的模型会正确地丢掉整条通道。

**我们的改法**：`brief.js` 的开头就是这段校准文本的中文改写，包含"忽略"授权和 Correction 回写协议。

### 3.6 知识页 + 索引行（反直觉结论）

`knowledge-injection.ts:40-52` 记录了一个实测：把知识页标题全列出来（3 页时 40 轮里 0 次 search；12 页时仍然 0 次），因为**标题一列出来，检索就没必要了**——模型直接从列表里挑 id 去 read。
但这是错的交易：标题说的是"这页讲什么"，检索返回的是"这轮真正相关的那段"。

所以他们的做法是只报数量和入口：

```
3 knowledge pages cover this repository — architecture, conventions, past decisions and
in-flight initiatives. They are deliberately NOT listed here: call
hindsight_search_knowledge_pages(query) ...
```

**我们的改法**：加 `pages` 表（title / kind / body / links / updated_at），首轮只报 `N 篇`，搜索按 passage 返回。目前我们连"页"这个概念都没有，`entities + timeline` 是数据，不是可读的知识。

### 3.7 观测作用域与 provenance

- `README.md:1072-1109`：同一个仓库被两个 agent 用过，如果按 tag 分组做 consolidation，会长出两套互不相见的信念——**谁在打字不改变某条约定是否成立**。所以默认 `observationScopes: "shared"`（每个 bank 一套），`per_source` 才按 `source:git` / `source:chat` 分轴。
- `README.md:1022-1046`：`retainTags` / `retainMetadata` 支持 `{gitProject}` `{harness}` `{sessionId}` 模板，共享 bank 时靠 tag 保留出处；`source:` 和 `harness:` 是保留命名空间，用户不许覆盖。

**我们的改法**：`memories` 表已经有 `source_session` / `source_agent`，但检索时没用来分组或过滤。v4 里 `tags` 升格为查询维度，`source:` 前缀保留。

---

### 3.8 参数与教训：把"调过的值"直接拿过来

这些是从 `config.ts` 的默认值里扒出来的，不是文档里给用户看的推荐值：

| 参数 | 值 | 为什么是这个数 |
|---|---|---|
| `injectTimeoutMs` | 7000 | 注入必须比一次会话启动更快，否则用户感到卡顿 |
| `reflectTimeoutMs` | 20000 | 首轮综合的等待上限 |
| `maxParallelRetains` | 10 | 回写并发；再高对单机 SQLite 无益 |
| 单请求硬超时 | 15s | `AbortSignal.timeout`，不依赖 undici 自己的超时 |
| `seedLimit` | 300 | git 种子窗口（实际取 `limit/2 ~ limit` 之间） |
| 每批 diff | 50 / 目标 300 | 一次会话只补一小段，不追求一次补完 |
| `surveyRefreshCommits` | 20 | 每 20 个提交重勘察一次（0 = 只冷启动勘察） |
| 抽取模式 | `concise` | `verbose` 曾让一个活跃会话跑到 **$150/小时** |

五条直接可用的教训：

1. **append 失败绝不能降级成 replace**（`retain-cursor.ts:31`）：一次网络抖动会让此后每次 Stop 都全量重抽。
2. **顺序决定增量**：`gitlog` 旧→新排列 + 窗口按半数步进，新提交才能纯 append；先前的"新→旧"排法让每条新提交都移动全文、全量重抽（#5003）。
3. **别信本地状态，回服务端问缺什么**：`listDocumentIds` 比本地 cursor 可靠，cursor 只用来省一次请求。
4. **`git log` 会被 `log.showSignature` 污染 stdout**（#5269），解析前强制关掉；`GIT_NO_LAZY_FETCH=1` 防止 partial clone 在只读 sha 时去拉远端（#5606）。
5. **长驻进程里的 token 会过期**：401 时重读 token 并只重放一次（#3600）——我们的插件也是长驻的，这条会踩到。

---

### 3.9 dsh 侧的五个具体接法（他们已经在 `src/dsh.ts` 里趟过）

我们的插件也跑在 dsh 上，所以这段可以直接照抄结构：

1. **绑事件，不装 hook**：`agent/session-start` → 冷启动检查；`agent/pre-step`（`{ prepend: true }`）→ 召回；`agent/turn-stopping` → 回写；`agent/disposed` → 清理。工具用 `ctx.inject(["tools"])` 注册。理由写在 `dsh.ts:1-25`：hook 桥接要多一层进程，还拿不到 transcript 和 session id。
2. **一个 dsh 进程服务多个工作区**：`session.header.cwd` 每个会话不同，所以 RuntimeCore 必须**按工作区根缓存**，不能按进程建。我们的插件现在正好反着来——`workspace` 是进程级常量。
3. **召回在关键路径上**：`preStep` 里 `await core.onPrompt(...)`，注入块随本轮 user turn 一起进模型；`seedIfCold` 则是 fire-and-forget（`dsh.ts:197-199`）。
4. **注入块要从转写里剥掉**：`MEMORY_TAG_RE` 会剔除 `<hindsight_memory>` 段（`inject.ts:74-77`），否则"回写 → 抽取 → 注入 → 再回写"形成自激环。**我们的 P0-2 一旦同时开了注入和回写，这就是必须做的第一件事。**
5. **首轮才发知识页前言**：`turns === 1` 时拼 preamble（名单在本会话现取，不用进程启动时的快照——#4607 的教训是"进程比页面活得久"）。

### 3.10 他们自己的文档也会漂移

`pageSearchLimit` README 写 3、代码是 10；reflect 超时 README 写 120s、代码是 20s（注入）/330s（工具）。所以他们才有 `docs-freshness.test.ts`：**字段能从配置文件读到但没在 README 里出现，就测试失败**。我们的 `SKILLS.md` 是手写的，等于没有任何防腐层。

---

## 4. 三个别抄

| 机制 | 为什么不抄 |
|---|---|
| 服务端 LLM 抽取管线（missions + chunking + entity labels + consolidation） | 成本、延迟、供应商三重绑定。我们用「抽取式渲染 + 可选 LLM 精炼」替代，先拿到 80% |
| 20+ harness 矩阵 / 118KB `installer.ts` / 40 个 bin 入口 | 维护地狱。dsh 插件 + MCP 两个入口，覆盖我们全部真实场景 |
| cloud / self-hosted / daemon 三模式 + npm 自动更新 | 对个人/小团队产品是纯负担。我们本来就是"一台服务器 + token" |

另外别抄的是「reflect 每次会话都跑」——他们能跑是因为云上有模型池。我们的等价物是**首轮一次 brief + 按需 search**，不做每轮推理。

---

## 5. 目标架构：v4 四层

```
  git log / 会话转写 / 勘察   ──►  documents（原始，去重靠 doc_id）
                                        │  抽取（规则 + 可选 LLM）
                                        ▼
                                   memories（事实，带 kind/有效区间/出处）
                                        │  合并（同主题归并、冲突取最新）
                                        ▼
                                 observations（信念，按仓库一套）
                                        │  策展（人/Agent 显式确认）
                                        ▼
                                    pages（架构/约定/在办/决策页）
```

- **两条写入**：自动（git、transcript、survey）+ 显式（`memory_save`）。
- **两条读出**：`brief`（首轮，字节稳定，进 user turn）+ `search`（按需，含 pages）。
- **一条回流**：Agent 发现记忆错了 → 写 `Correction:` 记忆 → 老的进 `superseded`（我们 v3.2 的信念修订已经有一半了，缺的是自动触发）。

表结构增量（`server/db.js`）：

```sql
CREATE TABLE documents (
  id TEXT PRIMARY KEY,          -- 确定性 id：gitlog:<repo> / commit:<sha> / sess:<id>:<n>
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,         -- git | chat | survey | manual
  content TEXT NOT NULL,
  meta TEXT DEFAULT '{}',       -- {sha, files, harness, session, turn}
  ingested_at INTEGER,
  extracted_at INTEGER
);
CREATE TABLE pages (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, -- architecture|convention|initiative|decision
  body TEXT NOT NULL, links TEXT DEFAULT '[]', tags TEXT DEFAULT '[]',
  version INTEGER DEFAULT 1, updated_at INTEGER, updated_by TEXT
);
CREATE TABLE ingest_cursors (workspace_id TEXT PRIMARY KEY, gitlog_head TEXT, survey_baseline TEXT, updated_at INTEGER);
```

API 增量（沿用现有 `/memory/*` 风格）：

```
POST /memory/brief        { workspace, goal, budget? }     → { text, stats }   // 首轮注入，可能返回 ""
POST /ingest/document     { workspace, docId, source, content, meta }           // 幂等 upsert
POST /ingest/session      { workspace, sessionId, turns: [{role,text,ts}] }     // 会话回写
GET  /pages/search?q=&kind=                               → [{ id, title, snippet }]
GET  /pages/:id                                            → { id, title, kind, body, links }
POST /pages/capture       { workspace, title, kind, body, links? }              // initiative / 决策页
GET  /health                                              → { ok, bank: { docs, pages, cold } }
```

---

## 6. 落地顺序（按性价比排序）

### P0-1 首轮 brief 通道（✅ 已完成）

实现（三处，均已跑通）：

| 位置 | 内容 |
|---|---|
| `server/brief.js` | 渲染器：候选排序（相关度 0.6 / 类型 0.25 / 重要度 0.1 / 新鲜度 0.05）、词面覆盖度过滤、预算内整条截断、空则返回 `""`。`node server/brief.js --demo` 自检 |
| `server/index.js` | `POST /memory/brief { workspace, goal, budget, owner }`：可见性过滤与 `/memory/search` 一致 → 检索 → `buildBrief()` → 审计日志 `brief` |
| `plugin/index.js` | `agent/pre-step`（`prepend:true`）→ `await next()` → 取本批 `source.kind === 'user'` 的文本 → 请求 brief → 追加一条 `source.kind = plugin:dsh-mnemosyne`、`form: 'recall'` 的 user 消息 |

刻意的取舍，每条都有理由：

- **进 user turn，不进 system prompt**：每轮变化的 system prompt 会打断 provider 的前缀缓存；这块内容本来也是"这一轮的输入"。
- **首轮一次 + `memory_brief` 工具**：自动部分要便宜，深挖由 agent 自己决定。`briefEveryTurn` 可开，但内容相同就不重复堆叠。
- **失败静默**：超时/5xx/空文本一律降级成无记忆的一轮，只写日志，绝不抛回宿主。
- **词面覆盖度默认只挡"零重叠"**：实测 `限流现在是多少来着` 只命中"限流"一个 bigram（覆盖度 0.125），阈值设 0.15 会把正确答案丢掉；而"无关"这种词又能让垃圾 query 拿到 0.083。词面判不了语义，所以只清噪音大头，剩下的交给注入块里的"无关就忽略"授权。

测试：
- `node --test plugin/` — 11 条，覆盖首轮注入、工具续跑不注入、同会话去重、空简报、连接失败、HTTP 500、reject 决策、`enableBrief=false`、`memory_brief` 工具参数。
- `deploy/smoke-test.sh` 增加两条探针：相关 goal 必须产出非空简报；无关 goal 必须不注入。

**部署顺序**：先更新服务器（`server/index.js` + `server/brief.js`，重启 systemd），再更新插件。
反过来的话，插件每个会话会打一次 404，然后静默降级——不报错，但也没有简报。

### P0-2 自动回写 + git 播种（1-2 人日）

- 插件在 `agent/turn-stopping` 把 (user, assistant) 文本 + session id POST `/ingest/session`，服务端 `doc_id = sha1(ws|session|turn_seq)` 去重。
- `mnemosyne gitseed <repo>`：`git log -n 300 --pretty=%H%x00%cI%x00%s%x00%b`，每提交一个 document；再按 `kind=decision` 抽规则（正则：`fix|revert|决定|改成|必须是`），其余进 `episode`。
- 游标 `ingest_cursors.gitlog_head`，新提交只 append；非祖先（rebase）时整段重播。

验收：新仓库首次 `gitseed` 后，`memory_search("为什么限流是 2000")` 能命中对应提交。

### P0-3 仓库维度（半人日）

`workspace` 不再写死：插件从 `session.header.cwd` 往上找 `.git`，取 `basename(git rev-parse --show-toplevel)` 作为 workspace key（worktree 要解析到主仓）。MCP 侧用 `MNEMOSYNE_WORKSPACE` 覆盖。

### P1-1 勘察四篇（1 人日，可无 LLM）

`repository-component-map` / `core-concepts` / `conventions-and-patterns` / `tech-stack-and-features`，固定 doc id，落 `pages`。无 LLM 版：目录树 + `package.json` + 测试文件名 + CI 配置 + `git log` 主题聚类。

### P1-2 pages + 索引行（1 人日）

工具：`page_search` / `page_read` / `page_capture_initiative`。首轮只报"本仓有 N 篇知识页，用 page_search 找"。**不要列标题**（3.6 的实测）。

### P2 观测合并 + 遥测

- 定时任务：同 subject 的 memories 归并成 observation，冲突按 `valid_from` 取最新、老的置 `superseded`（复用现有信念修订）。
- `diag.jsonl` + `usage.jsonl`：每次 brief 记 `{ms, chars, hits, query}`；每轮记引用了记忆没有（`> 🧠 Mnemosyne`）。`mnemosyne stats` 汇总。
- 没有这两行日志，P0 的效果永远只能靠感觉。

---

## 7. 验收基准：自建 mini-sdebench

Hindsight 敢公布数字，是因为它先有测量。我们照抄这个方法论，规模缩小：

- 12 个任务：从自己仓库的 git 历史里挑 12 个真实 bugfix（有提交、有"为什么"的那种），把提交回滚成任务描述。
- 每个任务 × 3 次 × {记忆开, 记忆关}。
- 指标：纠错次数（人打断的轮数）、总 token、首次命中率、credit rate。
- 通过线：纠错次数下降 ≥ 30%，token 不上升超过 10%。

这比任何设计文档都有说服力，也是唯一能证伪"pull not push"的方式。

---

## 8. 我的保留意见

1. **注入式 brief 有"污染"风险**：往 user turn 塞内容会让模型误以为是用户说的。Hindsight 用 `<hindsight_memory>` 标签 + 明确来源声明解决，我们照做，但要在 dsh 的渲染里确认标签不会被吞。
2. **自动回写涉及隐私**：会话文本进服务器。至少要 `optInPaths` 这种"只在这些目录开记忆"的开关（他们 README:603 的做法），默认关闭回写、按目录白名单。
3. **别把 brief 做成第二个 system prompt**：一旦它开始写"你应该先做 X"，就退化成我们想摆脱的那种注入。

---

## 附：本仓库改动

- 新增 `server/brief.js`：v4 首轮简报渲染器（抽取式、预算内截断、空则返回空串），带 `--demo` 自检。
- 本文档：`docs/design-review-hindsight.md`。
