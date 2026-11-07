# Mnemosyne — 通用 AI 记忆协议

> 任何 AI 工具都可以接入的中心化记忆协议。

---

## 两种模式

**A. 共享后端**：`https://mnemosyne.niao.fun`，向管理员要 Token
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

def mnemosyne(action, token, url="https://mnemosyne.niao.fun", **kw):
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
{type} {service} | {key_field}: {key_value} | {auth_field}: {auth_value}
```

### 示例

```
# SSH
ssh 10.0.0.35 | user: root | auth: password
ssh 10.0.0.11 | user: root | auth: key:~/.ssh/dension_10_0_0_11

# 网站
web github.com | user: dingdadao | auth: token:ghp_xxx
web admin.niao.fun | user: admin | auth: password:xxx

# API
api openai.com | key: sk-xxx | env: OPENAI_API_KEY
api workbuddy | url: 10.0.0.14:7863 | key_env: WB2A_API_KEY

# 数据库
db postgres | host: 10.0.0.20 | user: admin | auth: password:xxx

# 服务
service hermes-gateway | host: 10.0.0.11 | restart: systemctl restart hermes-gateway
service breeze-tts | host: 10.0.0.29:8010 | type: MLX TTS
```

### 标签约定

```
[type, service, host/user, key_field]
```

例如：
- `["ssh", "10.0.0.35", "root"]`
- `["web", "github.com", "dingdadao"]`
- `["api", "openai", "OPENAI_API_KEY"]`
- `["service", "hermes-gateway", "10.0.0.11"]`

### AI 行为

```python
# 登录成功后自动存
def on_login_success(service_type, service, **credentials):
    content = f"{service_type} {service}"
    for k, v in credentials.items():
        content += f" | {k}: {v}"
    mnemosyne("save", token,
        content=content, kind="fact", importance=0.85,
        tags=[service_type, service] + list(credentials.keys()))

# 下次连接前先查
def before_connect(service_type, service):
    r = mnemosyne("search", token, query=f"{service_type} {service}", limit=3)
    # 找到 → 用记录的凭据
    # 没找到 → 问用户
```

### 通用客户端

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
        """登录成功后调用。cred_type: ssh/web/api/db/service"""
        content = f"{cred_type} {service}"
        for k, v in fields.items():
            content += f" | {k}: {v}"
        return self._call("POST", "/memory/save", {
            "content": content, "kind": "fact", "importance": 0.85,
            "tags": [cred_type, service] + list(fields.keys()),
            "workspace": self.ws
        })
    
    def find_credential(self, cred_type=None, service=None):
        """连接前调用"""
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

# 用法
c = MnemosyneClient("https://mnemosyne.niao.fun", "YOUR_TOKEN")

# SSH 登录成功后
c.save_credential("ssh", "10.0.0.35", user="root", auth="password:xxx")

# 网站登录成功后
c.save_credential("web", "github.com", user="dingdadao", auth="token:ghp_xxx")

# API 配置
c.save_credential("api", "openai", key="sk-xxx", env="OPENAI_API_KEY")

# 服务信息
c.save_credential("service", "breeze-tts", host="10.0.0.29:8010", type="MLX")

# 查找
c.find_credential("ssh", "10.0.0.35")
c.find_credential("web", "github.com")
```

---

## API

```
POST   /memory/save       — 保存
POST   /memory/search     — BM25 搜索
GET    /memory/recent     — 最近
POST   /memory/dream      — 整理
GET    /memory/health     — 健康
```

---

*Mnemosyne — 记忆女神。一个协议，所有工具共享。*
