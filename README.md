# Mnemosyne (谟涅摩绪涅)

> 记忆女神 —— 预测式记忆召回层。Pull, not Push. Hint, not Inject.

> 📖 **AI 智能体使用指南**: [SKILLS.md](./SKILLS.md) — 任何 AI 读完即可一键使用
> 
> 🔧 **快速接入**: 设置 `MNEMOSYNE_URL` 和 `MNEMOSYNE_TOKEN` 环境变量即可

---

## 为什么不用灵枢（dsh-memory）？

| 问题 | 灵枢 | Mnemosyne |
|------|------|-----------|
| 注入频率 | **每步注入**（44步=44次） | **按需提示**（最多3次/会话） |
| Token 浪费 | ~70,000/会话 | **~150/会话** |
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
      │预测式 │ │      │ │      │  │          │
      │召回  │ │按需  │ │按需  │  │  按需    │
      │      │ │调用  │ │调用  │  │  调用    │
      └──────┘ └──────┘ └──────┘  └──────────┘
```

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

## 预测式召回

Mnemosyne 的核心创新：**预测什么时候需要记忆**，而不是盲目注入。

| 置信度 | 信号 | 动作 | 成本 |
|--------|------|------|------|
| **HIGH** | 用户说"继续/上次/之前" | 提示 agent 搜索 | ~50 tokens hint |
| **MEDIUM** | 检测到错误/决策点 | 注入一次性提示 | ~50 tokens hint |
| **MEDIUM** | 话题切换 | 计数，不提示 | 0 |
| **LOW** | 无相关信号 | 什么都不做 | 0 |

**限制**：每会话最多 3 个提示（对比灵枢的 44 次注入）。

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
