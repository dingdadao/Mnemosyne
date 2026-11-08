# Mnemosyne — 通用 AI 记忆协议

> 任何 AI 工具都可以接入的中心化记忆协议。

---

## 两种模式

**A. 共享后端**：向管理员获取 URL 和 Token
**B. 自建后端**：`curl -sSL .../install-server.sh | bash`

---

## 核心协议

```
认证: Authorization: Bearer <token>
格式: JSON
```

### 最小接入（5行）

```python
import urllib.request, json

def mnemosyne(action, token, url, **kw):
    req = urllib.request.Request(f"{url}/memory/{action}",
        data=json.dumps(kw).encode(), method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(req, timeout=10).read())
```

---

## 凭据库

**AI 每次成功登录/认证后，自动记录到 Mnemosyne。**

### 记录格式（通用）

```
{type} {service} | {key}: {value} | {key}: {value}
```

### 类型

| type | 场景 | 示例 |
|------|------|------|
| ssh | SSH 登录 | `ssh TARGET_IP | user: USER | auth: password` |
| web | 网站登录 | `web example.com | user: USER | auth: token` |
| api | API 配置 | `api provider-name | key: KEY | env: ENV_VAR` |
| db | 数据库 | `db TYPE | host: HOST | user: USER` |
| service | 服务信息 | `service NAME | host: HOST:PORT | note: DESC` |

### 标签约定

```
[type, service, key_fields...]
```

### AI 行为

```python
# 登录成功后
mnemosyne("save", token, url,
    content=f"ssh {ip} | user: {user} | auth: {method}",
    kind="fact", importance=0.85,
    tags=["ssh", ip, user])

# 下次连接前
result = mnemosyne("search", token, url, query=f"ssh {ip}", limit=3)
```

---

## 通用客户端

```python
class MnemosyneClient:
    def __init__(self, url, token, workspace="default"):
        self.url, self.token, self.ws = url, token, workspace

    def _call(self, method, path, body=None):
        import json, urllib.request
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(f"{self.url}{path}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        return json.loads(urllib.request.urlopen(req, timeout=10).read())

    def save_credential(self, cred_type, service, **fields):
        content = f"{cred_type} {service}"
        for k, v in fields.items():
            content += f" | {k}: {v}"
        return self._call("POST", "/memory/save", {
            "content": content, "kind": "fact", "importance": 0.85,
            "tags": [cred_type, service] + list(fields.keys()),
            "workspace": self.ws
        })

    def find_credential(self, cred_type=None, service=None):
        q = cred_type or ""
        if service: q += f" {service}"
        return self._call("POST", "/memory/search", {
            "query": q, "kind": "fact", "limit": 5, "workspace": self.ws
        })

    def save_memory(self, content, kind="fact", importance=0.5, tags=None):
        return self._call("POST", "/memory/save", {
            "content": content, "kind": kind, "importance": importance,
            "tags": tags or [], "workspace": self.ws
        })

    def search(self, query, limit=10):
        return self._call("POST", "/memory/search", {
            "query": query, "limit": limit, "workspace": self.ws
        })
```

---

## 记忆类型

| kind | 用途 | importance |
|------|------|-----------|
| fact | 事实、凭据 | 0.5-0.9 |
| preference | 偏好 | 0.6-0.8 |
| decision | 决策 | 0.8-0.95 |
| procedure | 流程 | 0.6-0.8 |
| error | 错误 | 0.7-0.9 |
| episode | 摘要 | 0.4-0.6 |

---

## API

```
POST   /memory/save       — 保存（自动脱敏）
POST   /memory/search     — BM25 搜索
GET    /memory/recent     — 最近
GET    /memory/timeline   — 时间轴
POST   /memory/dream      — 整理
GET    /memory/health     — 健康
POST   /memory/relate     — 关系
```

---

## 工具集成

### DSH

```bash
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mn
cp -r /tmp/mn/plugin/* ~/.dsh/profiles/desktop/node_modules/dsh-mnemosyne/
# 添加 cordis.patch.yml 配置（URL + Token）
```

### Hermes

```bash
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mn
cp /tmp/mn/plugins/memory/mnemosyne/* /root/.hermes/hermes-agent/plugins/memory/mnemosyne/
# 配置 .env + config.yaml 的 memory.provider
```

### Claude Code / Cursor

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "mnemosyne-mcp"],
      "env": {
        "MNEMOSYNE_URL": "YOUR_URL",
        "MNEMOSYNE_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

---

*Mnemosyne — 记忆女神。一个协议，所有工具共享。*

---

## v3: 多账户支持 (Multi-Tenant)

### 新增字段

| 字段 | 说明 | 必填 |
|------|------|------|
| owner | 记忆归属者 | 否（默认=workspace） |
| visibility | private / shared / public | 否（默认=private） |

### 保存

```json
{
  "content": "...",
  "owner": "dingshuangdao",
  "visibility": "shared"
}
```

### 搜索

```json
{
  "query": "...",
  "owner": "dingshuangdao",
  "include": ["own", "shared"]
}
```

返回 = owner=dingshuangdao 的私有条目 ∪ visibility=shared 的条目

### 权限

- `private`: 只有 owner 能读写
- `shared`: owner 读写，其他人可读
- `public`: 所有人可读写

写入 shared/public 需要 token 有 `can_write_shared` 权限。

### 迁移

```
POST /memory/migrate-owner
{ "from_workspace": "default", "default_owner": "admin", "visibility": "private" }
```

### Hermes 配置

```bash
# .env
MNEMOSYNE_OWNER=dingshuangdao
```

各 profile 设置不同的 MNEMOSYNE_OWNER 实现多用户隔离。

---

## 客户端兼容性

| 工具 | 接入方式 | 自动召回 | 自动保存 | 多账户 | 说明 |
|------|---------|---------|---------|--------|------|
| DSH | 插件 | ✅ 预测式 | ✅ 显式时 | ✅ | 完整支持 |
| Hermes | MemoryProvider | ✅ prefetch | ✅ sync_turn | ✅ | 完整支持 |
| Claude Code | MCP | ❌ 手动 | ❌ 手动 | ✅ 参数 | 需手动调工具 |
| Cursor | MCP | ❌ 手动 | ❌ 手动 | ✅ 参数 | 需手动调工具 |
| 豆包 | HTTP | ❌ 手动 | ❌ 手动 | ✅ 参数 | 无 hook 支持 |
| 龙虾 | HTTP | ❌ 手动 | ❌ 手动 | ✅ 参数 | 无 hook 支持 |
| WorkBuddy | HTTP | ❌ 手动 | ❌ 手动 | ✅ 参数 | 无 hook 支持 |
| 任意工具 | HTTP | ❌ 手动 | ❌ 手动 | ✅ 参数 | 有 HTTP 即可 |

**关键区别**：
- **有 hook 的系统**（DSH、Hermes）：自动召回 + 自动保存
- **无 hook 的系统**（豆包、龙虾等）：只能手动调 API，但数据完全共享

---

## 管理 API（v3）

### 创建受限 Token

```bash
POST /admin/token/create
{
  "owner": "yanyan",
  "can_write_shared": false,
  "can_write_public": false
}
# 响应: { "token": "...", "owner": "yanyan", "can_write_shared": 0 }
```

### 迁移 Owner

```bash
POST /memory/migrate-owner
{
  "from_workspace": "default",
  "from_owner": "admin",        # 可选：源 owner
  "to_owner": "dingshuangdao",  # 目标 owner
  "visibility": "private"       # 可选：同时设置可见性
}
# 响应: { "migrated": 30, "from_owner": "admin", "to_owner": "dingshuangdao" }
```

不传 `from_owner` 时，只迁移 owner 为空的记录（向后兼容）。

### 删除

```bash
DELETE /memory/delete?id=mem_xxx
# 响应: { "id": "mem_xxx", "status": "deleted" }
```

## 认证模型

两种 token：
1. **主 Token**（AUTH_TOKEN）— 全部权限，可写 shared/public
2. **受限 Token**（/admin/token/create 创建）— 权限由 can_write_shared 决定

认证流程：
- 主 token 哈希 === TOKEN_HASH → 通过，身份 admin
- 否则查 owner_tokens 表 → 通过，身份为表里的 owner
- 都不匹配 → 401

---

## Hermes provider 工具名

provider 暴露的工具名为 **`mnemo`**，不是 `mnemosyne`。

原因：Hermes 核心保留 `mnemosyne` 作为工具名，注册时会被静默忽略：
```
WARNING Memory provider 'mnemosyne' tool 'mnemosyne' shadows a reserved core tool name; registration ignored.
```
`registered (1 tools)` 是注册前计数，实际可用工具数是 0。

调用方式：
```python
mnemo(action="search", query="...", owner="dingshuangdao", include=["own","shared"])
mnemo(action="save", content="...", owner="...", visibility="private")
```

provider 本身的 `name` property 仍是 `mnemosyne`（Provider 标识），不影响工具注册。

## prefetch 调试

provider 在以下每个早退分支都有 `logger.debug("mnemo: prefetch ...")`：
- trivial prompt / query < 4 字符
- cache hit
- API 失败 / 服务端无结果
- 相关性过滤后为空
- 成功返回（带条数和字符数）

`recall_status()` 从 `_last_prefetch` 首行解析真实条数（`N relevant memories`），不再硬编码 1。

---

## v3.2：写入侧与演化侧

### 写入前置去重

相同内容重复写入不再新增记录，返回 `deduped: 1` 并 bump 原记录访问计数：

```json
POST /memory/save {"content":"...", "owner":"..."}
→ {"id":"mem_xxx","deduped":0,...}
（再写一次）
→ {"id":"mem_xxx","deduped":1,...}   // 未新增
```

`force: true` 可跳过。

### extract 模式（提炼，不灌日志）

```json
POST /memory/save
{"content":"User: 好的，我决定把缓存 TTL 设为 60 秒。Assistant: 明白",
 "extract": true, "kind":"fact", "owner":"..."}
→ {"ids":["mem_..._0"], "extracted":1, ...}
```

纯规则提炼：去掉 `User:/Assistant:` 前缀、切句、过滤"好的/明白/我来"噪声、去重，最多 3 条。

### 信念修订（belief revision）

`supersede` / `contradict` 关系现在真正生效：
- `/memory/search` 中被取代的旧事实 `_score × 0.3`，排到后面
- 响应带 `demoted` 计数和 `superseded_by`
- `/memory/get` 返回 `superseded_by` + `relation`

```
POST /memory/relate
{"from_id":"新事实ID","to_id":"旧事实ID","relation_type":"supersede"}
```

### 实体时间线图谱

save 时自动抽取实体（IP / 域名 / `service X`），写入 `entities` + `memory_entities`。

```
GET /memory/graph?entity=10.0.0.33
→ {"entity":"...", "count":1, "results":[{"entity":"10.0.0.33","type":"host","memories":[...按时间排序...]}]}
```

注意：部分 CDN/WAF 会对含 IP 的 query 参数返回 403，内网直连 `http://127.0.0.1:8790` 可用。

### procedure 免疫

`kind=procedure` 的记录不会被 dream 去重合并或过期归档（过程性记忆是版本化资产）。

### 回归探针

```bash
./deploy/smoke-test.sh https://mnemosyne.niao.fun YOUR_TOKEN
```

15 项断言：服务存活、6 条召回探针（top1 命中）、多账户隔离、score、写入去重、extract、4 个端点、健康分。
内置 0.4s 节流 + 403 重试（ESA CDN 的 CC 防护会对高频请求临时封禁）。

---

## 限流（v3.2.1）

后端按 **token 分桶**限流，默认 2000 次 / 60 秒：

- 每个 token/设备独立配额，CDN 回源共享 IP 不会互相挤掉
- 环境变量 `MNEMOSYNE_RATE_LIMIT` 可覆盖；启动参数 `--rate-limit N`
- 超限返回 **429**（不是 403），带 `Retry-After` + `limit` + `window_seconds` + `retry_after`
- 未认证请求按 IP 分桶

之前误判为 CDN CC 防护：实测公网与内网直连各打 110 次，都在第 ~100 次精确返回 429，
与后端 `RATE_LIMIT_MAX=100` 吻合（旧值），且 429 响应体是 `{"error":"rate_limited"}`。
403 + `server: ESA` 是撞了 429 后高频重试触发的次生 CC 拦截，根因在后端。

---

## v3.3-B：混合检索（零依赖）

不引入向量模型，用两个真正不同的排序器做 RRF 融合：

```
(1) BM25 排序（词法：精确词、标识符、缩写）
(2) 字符 n-gram 排序（CJK 二元组 + 英文词）
    + 同义词查询扩展（"他喜欢啥" → 偏好/习惯/喜好）
    → RRF(k=60) 融合，同义命中做微加权
```

**为什么不是向量**：实测 bge-base-zh-v1.5 量化 ONNX 在短中文上区分度失效
（所有查询 top1 都是同一条，无关句余弦 0.84 vs 相关句 0.85），
硬融合会把噪声灌进结果。B 方案零内存、零下载、零延迟，且补上了唯一缺口。

效果（同义查询，改前 BM25 = 0 命中）：
```
他喜欢啥  → 8 条，top1「丁大刀偏好：每天 7:20 推送长沙天气」
用户习惯  → 8 条
癖好      → 5 条
```

`POST /memory/search` 响应带 `fusion` 字段说明融合模式和扩展词数。
smoke test 已加 3 条同义探针，共 18 项断言。
