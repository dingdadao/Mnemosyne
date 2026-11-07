# Mnemosyne — 通用 AI 记忆协议

> 任何 AI 工具都可以接入的中心化记忆协议。
> 只需要能发 HTTP 请求，就能共享记忆。

---

## 两种使用模式

### 模式 A：共享后端（推荐，零部署）

直接使用公共 Mnemosyne 服务器，无需部署。

```
你的 AI 工具 → https://mnemosyne.niao.fun → 共享记忆池
```

**适合**：快速接入、个人使用、小团队。

**接入**：只需要一个 Token，向管理员获取。

---

### 模式 B：自建后端（完全控制）

自己部署 Mnemosyne 服务器，数据完全掌控。

```
你的 AI 工具 → 你的服务器 → 私有记忆池
```

**适合**：企业、隐私敏感、自定义需求。

**部署**：

```bash
curl -sSL https://raw.githubusercontent.com/dingdadao/Mnemosyne/main/deploy/install-server.sh | bash
```

部署完成后会显示你的服务器地址和 Token。

---

## 核心协议：HTTP + JSON

**两种模式协议完全相同**，只是 URL 和 Token 不同。

```
认证: Authorization: Bearer <token>
格式: JSON
编码: UTF-8
```

### 最小接入代码（任何语言，任何工具）

```python
# Python — 5 行接入
import urllib.request, json

def mnemosyne(action, token, url="https://mnemosyne.niao.fun", **kwargs):
    body = json.dumps({"action": action, **kwargs}).encode()
    req = urllib.request.Request(f"{url}/memory/{action}", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(req, timeout=10).read())

# 保存
mnemosyne("save", token, content="记住这个", kind="fact")

# 搜索
mnemosyne("search", token, query="记住", limit=5)
```

```javascript
// JavaScript / Node.js — 5 行接入
const mnemosyne = async (action, token, url = "https://mnemosyne.niao.fun", body = {}) => {
  const res = await fetch(`${url}/memory/${action}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
};
```

```bash
# Bash / curl — 3 行接入
MNEMOSYNE() {
  curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2" "${MNEMOSYNE_URL:-https://mnemosyne.niao.fun}/memory/$1"
}
```

---

## 工具接入

### DSH (DeepSeekRuntime)

```bash
# 一键安装（共享后端版）
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mn
DSH_PROFILE=~/.dsh/profiles/desktop
mkdir -p "$DSH_PROFILE/node_modules/dsh-mnemosyne"
cp -r /tmp/mn/plugin/* "$DSH_PROFILE/node_modules/dsh-mnemosyne/"
cd "$DSH_PROFILE" && node -e "
const fs=require('fs');const pkg=JSON.parse(fs.readFileSync('package.json'));
pkg.dependencies['dsh-mnemosyne']='file:node_modules/dsh-mnemosyne';
fs.writeFileSync('package.json',JSON.stringify(pkg,null,2));"
cat >> cordis.patch.yml << 'EOF'
- insert:
    - id: mnemosyne
      name: 'dsh-mnemosyne'
      config:
        mnemosyneUrl: 'https://mnemosyne.niao.fun'  # 或你的自建服务器
        mnemosyneToken: 'YOUR_TOKEN'
EOF
# 重启 DSH
```

### Hermes

**方式一：MemoryProvider（全自动，推荐）**

```bash
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mn
HERMES_AGENT=/root/.hermes/hermes-agent
mkdir -p "$HERMES_AGENT/plugins/memory/mnemosyne"
cp /tmp/mn/plugins/memory/mnemosyne/* "$HERMES_AGENT/plugins/memory/mnemosyne/"

# 配置（共享后端或自建后端）
cat >> /root/.hermes/.env << 'EOF'
MNEMOSYNE_URL=https://mnemosyne.niao.fun
MNEMOSYNE_TOKEN=YOUR_TOKEN
EOF

# 激活
sed -i '/^memory:/a\  provider: mnemosyne' /root/.hermes/config.yaml
systemctl restart hermes-gateway
```

**方式二：Tool（手动调用）**

```bash
cp /tmp/mn/plugins/memory/mnemosyne/__init__.py \
   "$HERMES_AGENT/tools/mnemosyne_tool.py"
```

### Claude Code / Cursor / 任何 MCP 工具

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "npx",
      "args": ["-y", "mnemosyne-mcp"],
      "env": {
        "MNEMOSYNE_URL": "https://mnemosyne.niao.fun",
        "MNEMOSYNE_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

### 豆包 / 龙虾 / WorkBuddy / 任意自定义工具

复制通用客户端类：

```python
class MnemosyneClient:
    def __init__(self, url, token, workspace="default"):
        self.url = url          # 共享: https://mnemosyne.niao.fun
        self.token = token      # 你的 Token
        self.workspace = workspace
    
    def _call(self, method, path, body=None):
        import json, urllib.request
        data = json.dumps(body).encode() if body else None
        req = urllib.request.Request(f"{self.url}{path}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json")
        return json.loads(urllib.request.urlopen(req, timeout=10).read())
    
    def save(self, content, kind="fact", importance=0.5, tags=None):
        return self._call("POST", "/memory/save", {
            "content": content, "kind": kind,
            "importance": importance, "tags": tags or [],
            "workspace": self.workspace
        })
    
    def search(self, query, limit=10):
        return self._call("POST", "/memory/search", {
            "query": query, "limit": limit, "workspace": self.workspace
        })

# 共享后端
client = MnemosyneClient("https://mnemosyne.niao.fun", "YOUR_TOKEN")

# 或自建后端
client = MnemosyneClient("https://your-server.com", "YOUR_TOKEN")
```

---

## API 参考

### 记忆操作

```
POST   /memory/save       — 保存（自动脱敏）
GET    /memory/get?id=xxx — 获取（含关系）
POST   /memory/search     — BM25 搜索
GET    /memory/recent     — 最近记忆
GET    /memory/timeline   — 时间轴查询
PUT    /memory/update     — 更新
DELETE /memory/delete     — 删除
POST   /memory/relate     — 创建关系
```

### 管理与整理

```
GET    /memory/health     — 健康检查
POST   /memory/dream      — autoDream 整理
GET    /memory/stats/detailed — 详细统计
```

### 系统

```
GET    /health            — 健康检查
GET    /export            — JSON 导出
POST   /backup            — SQLite 备份
```

---

## 记忆类型

| kind | 用途 | importance |
|------|------|-----------|
| `fact` | 事实、知识 | 0.5-0.7 |
| `preference` | 用户偏好 | 0.6-0.8 |
| `decision` | 决策记录 | 0.8-0.95 |
| `procedure` | 流程步骤 | 0.6-0.8 |
| `error` | 错误记录 | 0.7-0.9 |
| `episode` | 会话摘要 | 0.4-0.6 |

---

## 安全

- HTTPS 传输加密
- Bearer Token 认证
- 保存时自动脱敏（密码、API Key、Token）
- Rate Limit 100 req/min
- 审计日志

---

*Mnemosyne — 记忆女神。一个协议，所有工具共享记忆。*
