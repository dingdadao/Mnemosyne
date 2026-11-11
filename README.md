# Mnemosyne (谟涅摩绪涅)

> 记忆女神 —— 首轮简报 + 按需检索。结论先行，深挖再说。

> 📖 **AI 智能体使用指南**: [SKILLS.md](./SKILLS.md) — 任何 AI 读完即可一键使用
> 
> 🔧 **快速接入**: 设置 `MNEMOSYNE_URL` 和 `MNEMOSYNE_TOKEN` 环境变量即可

---

## 为什么不用灵枢（dsh-memory）？

| 问题 | 灵枢 | Mnemosyne |
|------|------|-----------|
| 注入频率 | **每步注入**（44 步 = 44 次） | **首轮一次** + 按需检索 |
| 每会话注入量 | ~70,000 token | **≤1200 字符（≈350 token）**，无关时不注入 |
| 跨工具共享 | 仅 DSH | **任何 MCP 工具** |
| 中心化 | 不支持 | **原生支持** |
| 存储 | 本地 JSONL | **SQLite + 时间轴 + 关系图谱** |

## 架构

```
┌──────────────────────────────────────────────────────┐
│               你的服务器 / VPS / 本地机器               │
│                                                      │
│  mnemosyne-server (Node.js + SQLite WAL)             │
│  - REST API                                          │
│  - Bearer Token Auth                                 │
│  - Timeline + Relations + Entities                   │
│  - One-command backup                                │
│                                                      │
└──────────────────┬───────────────────────────────────┘
                   │ HTTP + Bearer Token
         ┌─────────┼─────────┬──────────┐
         ▼         ▼         ▼          ▼
      ┌──────┐ ┌──────┐ ┌──────┐  ┌──────────┐
      │ DSH  │ │Claude│ │Cursor│  │ 其他工具  │
      │Plugin│ │ MCP  │ │ MCP  │  │  MCP     │
      │首轮  │ │      │ │      │  │          │
      │简报  │ │按需  │ │按需  │  │  按需    │
      │+按需 │ │调用  │ │调用  │  │  调用    │
      └──────┘ └──────┘ └──────┘  └──────────┘
```

完整的 v4 流程图（5 张：总览 / 首轮简报时序 / `buildBrief` 流水线 / 降级链 / 开发闭环）：[docs/architecture-flow.md](./docs/architecture-flow.md)，渲染好的 SVG 在 [docs/diagrams/](./docs/diagrams/)。

## 快速开始

### 1. 部署中心化服务器（一键）

```bash
# 在服务器上（如 VM、VPS、本地机器）
curl -sSL https://raw.githubusercontent.com/YOUR_REPO/Mnemosyne/main/deploy/install-server.sh | bash

# 或者从本地仓库运行
./deploy/install-server.sh --port 8790 --data-dir /data/mnemosyne
```

部署完成后会显示连接信息和 token。

### 2. 安装 DSH 插件（一键）

```bash
# 方式一：安装脚本
./deploy/install-plugin.sh \
  --server $MNEMOSYNE_URL \
  --token $MNEMOSYNE_TOKEN \
  --profile desktop

# 方式二：手动配置
# 在 ~/.dsh/profiles/desktop/cordis.patch.yml 中添加：

- insert:
    - id: mnemosyne
      name: 'dsh-mnemosyne'
      config:
        mnemosyneUrl: $MNEMOSYNE_URL
        mnemosyneToken: $MNEMOSYNE_TOKEN
        maxHintsPerSession: 3
        enableAutoRecall: true
```

然后重启 DSH。

### 3. Claude Code / Cursor 等其他工具

```json
// .mcp.json (Claude Code)
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "mnemosyne-mcp"],
      "env": {
        "MNEMOSYNE_URL": "your-server-url",
        "MNEMOSYNE_TOKEN": "your-token"
      }
    }
  }
}
```

### 4. 任何 AI 智能体

读 [SKILLS.md](./SKILLS.md)，设置 `MNEMOSYNE_URL` 和 `MNEMOSYNE_TOKEN`，开始用。

## 首轮简报（v4）

旧版本是"提示式召回"：检测到"继续/上次/报错"这类信号，给 agent 塞一条 `Consider calling memory_search`。
问题是很明显的——**提示是税，不是红利**。一次提示 ≈ 50 token + 一次工具调用 + 一次往返，
收益还要等 agent 真的去查、查到了、并且用上才兑现；而 agent 的默认行为是直接干活。

现在的默认路径反过来：**会话第一轮，服务端直接把"这个仓库过去定过什么"渲染成一份简报，注入到 user turn。**

```
用户发第一句话 ──► POST /memory/brief {goal}
                        │
                        ├─ 检索：BM25 + char-ngram + 同义词，取候选
                        ├─ 过滤：goal 与记忆零实词重叠的丢掉（噪音大头）
                        ├─ 渲染：陈述句 / 过去时 / 带日期 / 字面值逐字保留
                        └─ 预算：默认 1200 字符，放不下整条丢，不切断
                        ▼
              <mnemosyne_memory> … </mnemosyne_memory>
              （一条 source.kind = plugin:dsh-mnemosyne 的 recall 消息）
```

| 机制 | 旧：提示式 | 新：简报式 |
|------|-----------|-----------|
| 注入内容 | "你可以去搜 X" | 结论本身（决策/约定/踩过的坑） |
| 注入位置 | system prompt（每轮变化，破坏前缀缓存） | user turn，首轮一次 |
| 每会话成本 | 最多 3×50 token，且大概率没人理 | ≤1200 字符（≈350 token），一次 |
| 空库/无关 | 照样提示，制造噪音 | 返回空串，**什么都不注入** |
| 失败 | 静默放弃 | 静默降级为无记忆的一轮，写日志 |

检索仍然保留：`memory_search`（按需）、`memory_brief`（任务切换后重新对齐）。深浅两档，深挖才花 token。

简报的措辞是**刻意校准**的：明确写出"这是过去的记录，不是给你的任务"，并授权模型"判断无关就直接忽略"。
一段自信满满的"这解释了你的问题，请精确应用"遇到跑偏的记忆，读起来和 prompt injection 无法区分，
模型会正确地丢掉整条通道。

> 实现：`server/brief.js`（渲染器，纯函数、零依赖、可 `node server/brief.js --demo` 自检）、
> `server/index.js` 的 `POST /memory/brief`、插件 `agent/pre-step` 钩子。

## 存储设计

### 为什么用 SQLite 而不是 MySQL？

1. **零运维** — 不需要安装/配置数据库服务
2. **备份简单** — 复制一个文件即可
3. **性能足够** — SQLite WAL 模式单连接读 > MySQL 单连接
4. **数据量可控** — 记忆有 GC，单 workspace 上限 500 条
5. **事务安全** — better-sqlite3 同步 API，天然事务

如果未来需要多写入者/分布式，可无痛迁移到 PostgreSQL。

### 表结构

```
workspaces     — 工作区隔离
memories       — 主记忆表（时间轴格式）
  ├── kind: fact|preference|decision|procedure|error|episode
  ├── state: active|archived|superseded|contradicted
  ├── valid_from / valid_until — 时间轴
  └── importance: 0.0-1.0

relations      — 记忆间关系（supersede|contradict|support|derive|relate）
entities       — 提取的实体（人/项目/概念）
memory_entities — 记忆-实体关联
```

## API 参考

### 记忆操作

```
POST   /memory/save       — 保存记忆
GET    /memory/get?id=xxx — 获取记忆（含关系）
POST   /memory/search     — 搜索记忆
GET    /memory/recent     — 最近记忆
GET    /memory/timeline   — 时间轴查询
PUT    /memory/update     — 更新记忆
DELETE /memory/delete     — 删除记忆
POST   /memory/relate     — 创建记忆间关系
```

### 管理与备份

```
GET    /health            — 健康检查 + 统计
GET    /stats             — 工作区统计
GET    /export            — 完整 JSON 导出
POST   /backup            — SQLite 备份文件
```

详见 [SKILLS.md](./SKILLS.md)。

## 备份

```bash
# 自动备份（推荐）：systemd timer 或 cron
curl -X POST -H "Authorization: Bearer $TOKEN" $MNEMOSYNE_URL/backup

# 手动导出 JSON
curl -H "Authorization: Bearer $TOKEN" $MNEMOSYNE_URL/export > backup.json

# SQLite 直接复制（需停止服务）
scp root@your-server:~/.mnemosyne/mnemosyne.db ./backup/
```

## 迁移现有记忆

```bash
# 从灵枢 (dsh-memory) 按工作区迁移
node deploy/migrate-by-workspace.js \
  --url $MNEMOSYNE_URL \
  --token $MNEMOSYNE_TOKEN

# 同步会话摘要
node deploy/sync-session-summaries.js \
  --url $MNEMOSYNE_URL \
  --token $MNEMOSYNE_TOKEN

# 干跑模式（预览不写数据）
node deploy/migrate-by-workspace.js --dry-run --token $MNEMOSYNE_TOKEN
```

## 与灵枢（dsh-memory）共存

Mnemosyne 与灵枢可以共存：
- 灵枢：自动记录（每步写入知识面）
- Mnemosyne：主动记忆（agent 决定保存什么）

也可以完全替换灵枢：
```bash
# 禁用灵枢
dsh plugin --profile desktop remove @furongjun1999/dsh-memory
```

## 路线图

- [x] 中心化 REST API
- [x] SQLite + 时间轴存储
- [x] DSH 预测插件
- [x] 一键部署脚本
- [x] 按工作区迁移工具
- [x] 会话摘要同步
- [x] AI 智能体使用指南 (SKILLS.md)
- [ ] MCP server 独立包
- [ ] 向量检索（SQLite-VSS）
- [ ] 自动 GC（TTL + 容量上限）
- [ ] Web 面板
- [ ] 多用户/权限系统
