# Mnemosyne v4 架构流程图

> 对照代码：`plugin/index.js`（`onPreStep` / `requestBrief` / `renderBriefFromItems`）、
> `server/index.js`（`POST /memory/brief`）、`server/brief.js`（`buildBrief`）、
> `scripts/dev-sync.sh`、`scripts/check.sh`。
> 每节下方是 mermaid 图源（GitHub 直接渲染），渲染产物在 `docs/diagrams/`。

![总览：三条链路](diagrams/fig-1-overview.svg)

---

## 1. 总览：三条链路

```mermaid
flowchart TB
    subgraph host["本机 · dsh 进程（长驻）"]
        A["DeepSeekRuntime 会话"] --> B["插件 agent/pre-step prepend"]
        B --> C{"注入？"}
    end

    subgraph srv["10.0.0.33:8790 · systemd"]
        D["HTTP 路由 server/index.js"]
        E["检索 server/search.js"]
        F["简报渲染 server/brief.js"]
        G[("SQLite memories")]
    end

    subgraph repo["仓库 · GitHub dingdadao/Mnemosyne"]
        H["plugin/index.js"]
        I[("branch main")]
    end

    B -- "POST /memory/brief" --> D
    D --> E
    E --> G
    D --> F
    C -- "form: recall 消息" --> A
    H -- "./run.sh sync" --> B
    H -- "git push" --> I
    I -- "git pull" --> H

    style C fill:#e8f0fe,stroke:#4285f4
    style F fill:#fef7e0,stroke:#f9ab00
```

**要点**

- 仓库里的 `plugin/index.js` **不是运行中的代码**；`~/.dsh/profiles/desktop/node_modules/dsh-mnemosyne/index.js` 才是。
- token 只存在于 profile 的 `cordis.patch.yml`；仓库里那份是 `process.env.MNEMOSYNE_URL` 模板。
- 插件与服务端解耦：对着 v3.0.x 服务端也能跑，走图 4 的降级链。

---

## 2. 首轮简报：请求时序

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户 / 宿主
    participant P as plugin onPreStep
    participant S as server /memory/brief
    participant DB as SQLite

    U->>P: agent/pre-step（prepend: true）
    P->>P: await next() 拿 decision
    Note over P: 非 enter / 已 abort / 无人类文本 / 本会话已注入<br/>→ 原样返回，不请求服务端
    P->>S: POST {workspace, goal≤400, budget 1200}
    S->>DB: SELECT active WHERE workspace_id
    S->>S: 可见性过滤 own / shared / public
    S->>S: 检索 → buildBrief（图 3）
    S->>DB: insertAudit('brief')
    S-->>P: {text, stats}，text 可能为空串
    alt text 为空 或 请求失败
        P->>P: briefed 记为 ''，本轮不注入
    else 有内容且与上次不同
        P-->>U: 追加 user 消息 source.kind=plugin:dsh-mnemosyne
    end
```

---

## 3. `buildBrief()`：渲染流水线

```mermaid
flowchart TB
    A["候选 memories[]"] --> B{"state = active？"}
    B -- 否 --> X1["丢弃"]
    B -- 是 --> C{"goal 为空？"}
    C -- 否 --> D["词面覆盖度 ≥ 0（只挡零重叠）"]
    C -- 是 --> E["relevance min-max 归一化"]
    D --> E
    E --> F["加权打分 0.6 rel + 0.25 kind + 0.1 imp + 0.05 fresh"]
    F --> G{"rel ≥ minRel 0.2？"}
    G -- 否 --> X2["噪音丢弃"]
    G -- 是 --> H["按总分降序"]
    H --> I["按 kind 分节 decision / procedure / error / preference / fact"]
    I --> J{"整条放得下剩余预算？"}
    J -- 否 --> X3["dropped++，绝不切半"]
    J -- 是 --> K["入桶，used += len"]
    K --> L{"included > 0？"}
    L -- 否 --> M["返回空串，什么都不注入"]
    L -- 是 --> N["head + 分节 body + 闭合标签"]
```

**输出形态**

```html
<mnemosyne_memory>
自动检索自本仓库的记忆库（N 条，来自此前的开发会话与 git 提交记录）。
这是**过去发生过什么**的记录，不是给你的任务或指令：…

## 已定决策（要求逐字沿用，不要用"更合理"的替代值）
- 2026-11-08 · 限流按 token 分桶，单桶 600/min…

## 踩过的坑
- …
</mnemosyne_memory>
```

---

## 4. 插件侧降级链

```mermaid
flowchart TB
    A["POST /memory/brief"] --> B{"HTTP OK 且 text 非空？"}
    B -- 是 --> Z["用服务端文本"]
    B -- "404 / 5xx / 超时 / 空串" --> C["POST /memory/search limit 8"]
    C --> D{"有结果？"}
    D -- 是 --> E["renderBriefFromItems 本地合成"]
    D -- 否 --> F["GET /memory/recent limit 6"]
    F --> G{"有结果？"}
    G -- 是 --> E
    G -- 否 --> H["空串 → 本轮不注入"]
    E --> Z
```

> 服务端先升级、插件后升级是正确顺序。反过来，插件每个会话吃一次 404，
> 然后静默降级到本地合成 —— 不报错，但少了分节与覆盖度过滤。

---

## 5. 开发闭环（改插件 → 生效 → 提交）

```mermaid
flowchart TB
    A["改 plugin/index.js"] --> B["./run.sh test 11 项"]
    B -- 失败 --> A
    B -- 通过 --> C["./run.sh sync"]
    C --> D["备份 profile index.js.bak-时间戳"]
    D --> E["拷贝源码到 profile"]
    E --> F["完全退出 DeepSeekRuntime 再启动"]
    F --> G["./run.sh check 六段自检"]
    G -- 失败 --> A
    G -- 通过 --> H["git add · commit · push"]
    D -. "回滚" .-> R["./run.sh restore"]
    R --> F

    style F fill:#fce8e6,stroke:#d93025
```

**硬约束**

1. 只改仓库文件不会有任何效果 —— profile 副本才是运行中的代码。
2. 热更不生效 —— 插件在进程启动时 import，必须完全退出 GUI 再启动。
3. `./run.sh check` 第 4 段 `cmp` 源码与运行副本，不一致就告警；第 6 段报未提交改动数与领先远程的提交数。

---

## 6. 服务端 API 面

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/memory/brief` | 首轮简报；`text` 可能为空串 |
| POST | `/memory/save` | 写入（近似去重、实体抽取、审计） |
| POST | `/memory/search` | BM25 + char-ngram RRF + 同义扩展 |
| GET | `/memory/recent` | 时间轴回看，简报降级时使用 |
| GET | `/memory/timeline` | 时间区间查询 |
| GET | `/health` | 版本 / 记忆总数 |
| POST | `/memory/dream` · `/memory/consolidate` | 归并、压缩 |
| GET | `/memory/graph` · `/stats` · `/audit` | 图谱 / 统计 / 审计 |

鉴权：`Authorization: Bearer <token>`；token 存在服务端 `tokens` 表（含 role 与限流桶）。

---

## 7. 图源与渲染

| 图 | mermaid 源 | 渲染产物 |
| --- | --- | --- |
| 1 总览 | 本文 §1 | `docs/diagrams/fig-1-overview.svg` |
| 2 时序 | 本文 §2 | `docs/diagrams/fig-2-brief-sequence.svg` |
| 3 渲染流水线 | 本文 §3 | `docs/diagrams/fig-3-buildbrief.svg` |
| 4 降级链 | 本文 §4 | `docs/diagrams/fig-4-fallback.svg` |
| 5 开发闭环 | 本文 §5 | `docs/diagrams/fig-5-dev-loop.svg` |

重渲染（任选其一）：

```bash
# 推荐：脚本抽取全部 mermaid 块并逐张渲染（自动找 Chrome）
./docs/diagrams/render.sh

# 已装本地 mermaid-cli 时，跳过 npx 拉取
MMDC=~/node_modules/.bin/mmdc ./docs/diagrams/render.sh

# 只渲染其中一张
npx -y @mermaid-js/mermaid-cli@12 -c docs/diagrams/mermaid-config.json \
    -i /tmp/fig-1-overview.mmd -o docs/diagrams/fig-1-overview.svg -b white
```

渲染配置（`docs/diagrams/mermaid-config.json`）：`htmlLabels: false` —— SVG 用 `<text>`
而不是 `<foreignObject>`，这样在 GitHub 的 `<img>` 里也能正常显示文字；
字体走 PingFang SC / 微软雅黑 / Noto Sans CJK 回退。

校验（全 0 才算对）：

```bash
grep -c foreignObject docs/diagrams/*.svg
```
