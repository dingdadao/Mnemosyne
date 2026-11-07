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
