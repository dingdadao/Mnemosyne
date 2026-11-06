# Mnemosyne — AI 智能体使用指南

> 中心化记忆服务器。预测式召回，Pull not Push。
> 任何 AI 智能体读完此文档即可使用。

---

## 快速开始（30 秒）

```bash
# 环境变量（必须设置）
export MNEMOSYNE_URL="https://your-mnemosyne-server.com"    # 你的服务器地址
export MNEMOSYNE_TOKEN="your-token-here"                     # 你的认证令牌

# 1. 测试连接
curl -s -H "Authorization: Bearer $MNEMOSYNE_TOKEN" $MNEMOSYNE_URL/health

# 2. 保存一条记忆
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "这是一条测试记忆", "kind": "fact"}' \
  $MNEMOSYNE_URL/memory/save

# 3. 搜索记忆
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "测试"}' \
  $MNEMOSYNE_URL/memory/search
```

---

## 部署自己的服务器

如果你想自己部署一个 Mnemosyne 服务器：

```bash
# 一键部署（需要 root）
curl -sSL https://raw.githubusercontent.com/YOUR_REPO/Mnemosyne/main/deploy/install-server.sh | bash

# 部署完成后获取 token
cat ~/.mnemosyne/.token
```

详见 [README.md](./README.md) 和 [deploy/](./deploy/)。

---

## 核心概念

### 记忆类型 (kind)

| kind | 用途 | 示例 |
|------|------|------|
| `fact` | 事实、知识 | "项目用 pnpm 管理" |
| `preference` | 用户偏好 | "用户喜欢 4 空格缩进" |
| `decision` | 决策记录 | "选定 SQLite 而非 MySQL" |
| `procedure` | 流程步骤 | "部署步骤：1... 2... 3..." |
| `error` | 错误记录 | "SSH 端口不是 22，在 xxx" |
| `episode` | 会话摘要 | "本次完成了记忆系统部署" |

### 工作区 (workspace)

记忆按工作区隔离。每个项目/目录一个工作区：

```
workspace: "default"           → 默认工作区
workspace: "my-project"        → 自定义项目
workspace: "waf-project"       → WAF 项目
```

**规则**：不同工作区的记忆互不干扰。搜索时指定 workspace 只搜该工作区。

### 重要性 (importance)

0.0 - 1.0。影响搜索排序：
- `0.9` — 关键决策、核心事实
- `0.6` — 有用但不关键
- `0.3` — 一般信息

---

## API 参考

所有 API 都需要认证头：`Authorization: Bearer <token>`

### 1. 保存记忆

```bash
POST /memory/save
```

```json
{
  "content": "记忆内容（必填）",
  "kind": "fact",
  "tags": ["标签1", "标签2"],
  "importance": 0.7,
  "workspace": "default",
  "summary": "简短摘要（可选）",
  "valid_from": 1699353600,
  "source_agent": "claude-code"
}
```

**响应**：
```json
{ "id": "mem_xxx", "status": "saved" }
```

### 2. 搜索记忆

```bash
POST /memory/search
```

```json
{
  "query": "搜索关键词",
  "kind": "fact",
  "limit": 10,
  "offset": 0,
  "workspace": "default"
}
```

**响应**：
```json
{
  "query": "搜索关键词",
  "count": 3,
  "results": [
    {
      "id": "mem_xxx",
      "content": "匹配的记忆内容...",
      "kind": "fact",
      "importance": 0.8,
      "tags": ["标签"],
      "created_at": 1699353600
    }
  ]
}
```

### 3. 获取单条记忆

```bash
GET /memory/get?id=mem_xxx
```

### 4. 最近记忆（时间轴）

```bash
GET /memory/recent?workspace=default&limit=10
```

### 5. 时间范围查询

```bash
GET /memory/timeline?workspace=default&from=1699353600&to=1699440000&limit=50
```

### 6. 更新记忆

```bash
PUT /memory/update
```

```json
{
  "id": "mem_xxx",
  "content": "更新后的内容",
  "state": "archived"
}
```

### 7. 删除记忆

```bash
DELETE /memory/delete?id=mem_xxx
```

### 8. 创建关系

```bash
POST /memory/relate
```

```json
{
  "from_id": "mem_aaa",
  "to_id": "mem_bbb",
  "relation_type": "supersede"
}
```

关系类型：`supersede`（替代）、`contradict`（矛盾）、`support`（支持）、`derive`（派生）、`relate`（相关）

### 9. 健康检查

```bash
GET /health
```

### 10. 统计

```bash
GET /stats?workspace=default
```

### 11. 导出/备份

```bash
GET /export                              # 完整 JSON 导出
POST /backup                             # SQLite 备份文件
```

---

## 使用模式

### 模式 1：会话开始加载上下文

```bash
# 当用户说"继续之前的项目"时，先搜索相关记忆
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "项目名称", "workspace": "当前工作区", "limit": 5}' \
  $MNEMOSYNE_URL/memory/search
```

### 模式 2：保存重要决策

```bash
# 做完重要决策后保存
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "决定使用 SQLite 而非 MySQL，原因：零运维、备份简单",
    "kind": "decision",
    "importance": 0.9,
    "tags": ["database", "architecture"]
  }' \
  $MNEMOSYNE_URL/memory/save
```

### 模式 3：记录错误和解决方案

```bash
# 遇到错误时保存
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "content": "SSH 连接被拒绝。原因：密码错误。解决：使用密钥认证",
    "kind": "error",
    "importance": 0.8,
    "tags": ["ssh", "troubleshooting"]
  }' \
  $MNEMOSYNE_URL/memory/save
```

### 模式 4：按工作区隔离

```bash
# 搜索时指定工作区，避免跨项目串台
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "部署", "workspace": "waf-project"}' \
  $MNEMOSYNE_URL/memory/search
```

---

## 最佳实践

### DO（推荐）

- ✅ **按工作区隔离**：不同项目用不同 workspace
- ✅ **标记 kind**：区分 fact/decision/error/preference
- ✅ **设置 importance**：关键信息设 0.8+
- ✅ **加 tags**：方便后续筛选和聚合
- ✅ **保存决策原因**：不只记"选了什么"，还记"为什么"
- ✅ **会话开始搜索**：用户提到"继续/之前"时先查记忆

### DON'T（避免）

- ❌ **不要存敏感信息**：密码、密钥、token 不要存
- ❌ **不要存超长内容**：单条限制 5000 字符
- ❌ **不要过度搜索**：只在需要时搜索，不要每步都查
- ❌ **不要跨工作区搜索**：保持项目隔离

---

## 典型工作流

### 工作流 1：继续之前的工作

```
用户: "继续之前的 WAF 项目"
  ↓
Agent: 搜索 workspace="waf-project" 中关于 WAF 的记忆
  ↓
Agent: 找到相关 context，继续工作
```

### 工作流 2：遇到错误查历史

```
Agent: 执行命令失败
  ↓
Agent: 搜索 kind="error" 中类似的错误
  ↓
Agent: 找到之前类似错误的解决方案，应用修复
```

### 工作流 3：保存工作成果

```
Agent: 完成了一个重要功能
  ↓
Agent: 保存 kind="episode" 的工作摘要
  ↓
下次会话: 搜索找到这个摘要，快速恢复上下文
```

---

## 故障排查

| 问题 | 解决 |
|------|------|
| `unauthorized` | 检查 MNEMOSYNE_TOKEN 是否正确 |
| `Connection refused` | 检查 MNEMOSYNE_URL 是否正确 |
| `FOREIGN KEY constraint failed` | 服务器已修复，重试即可 |
| 搜索结果为空 | 检查 workspace 是否正确，或 query 太具体 |
| 服务器未部署 | 运行 `deploy/install-server.sh` |

---

## 迁移现有记忆

如果你有其他记忆系统的数据，可以用迁移工具：

```bash
# 从灵枢 (dsh-memory) 迁移
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

---

*Mnemosyne — 记忆女神。Pull, not Push. Hint, not Inject.*
*服务器地址和 Token 请向你的管理员获取，或自行部署。*
