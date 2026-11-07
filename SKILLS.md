# Mnemosyne — 通用 AI 记忆协议

> 任何 AI 工具都可以接入的中心化记忆协议。
> 只需要能发 HTTP 请求，就能共享记忆。

---

## 两种使用模式

### 模式 A：共享后端（推荐，零部署）

直接使用公共 Mnemosyne 服务器。

```
你的 AI 工具 → https://mnemosyne.niao.fun → 共享记忆池
```

### 模式 B：自建后端（完全控制）

```bash
curl -sSL https://raw.githubusercontent.com/dingdadao/Mnemosyne/main/deploy/install-server.sh | bash
```

---

## 核心协议：HTTP + JSON

```
认证: Authorization: Bearer <token>
格式: JSON
编码: UTF-8
```

### 最小接入代码

```python
import urllib.request, json

def mnemosyne(action, token, url="https://mnemosyne.niao.fun", **kwargs):
    body = json.dumps({"action": action, **kwargs}).encode()
    req = urllib.request.Request(f"{url}/memory/{action}", data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    return json.loads(urllib.request.urlopen(req, timeout=10).read())
```

---

## 账号库（自动记录登录凭据）

**核心规则：AI 每次成功登录一台设备后，自动将账号信息存入 Mnemosyne。**

### 触发时机

```
AI 执行 SSH/登录 → 连接成功 → 自动调用 mnemosyne save → 记录账号信息
```

### 记录格式

```json
{
  "content": "SSH 10.0.0.35 | user: root | auth: password | status: active",
  "kind": "fact",
  "tags": ["credential", "ssh", "10.0.0.35", "root"],
  "importance": 0.85
}
```

### 记录内容

| 字段 | 说明 | 示例 |
|------|------|------|
| 设备名称 | 主机名或描述 | hermes-server, mac-mini, nas |
| IP 地址 | 设备 IP | 10.0.0.35 |
| 用户名 | 登录账号 | root, dension, admin |
| 认证方式 | password / key / token | password |
| 密钥路径 | 如果是密钥认证 | ~/.ssh/id_rsa |
| 系统信息 | OS, 架构 | Ubuntu 24.04 x86_64 |

### AI 行为规范

**登录成功后，AI 必须执行：**

```python
# 登录成功，记录到账号库
mnemosyne("save", token, 
    content=f"SSH {ip} | user: {user} | auth: {auth_method} | {hostname} | {os_info}",
    kind="fact",
    importance=0.85,
    tags=["credential", "ssh", ip, user, hostname]
)
```

**下次登录时，AI 应该先查账号库：**

```python
# 连接前先查有没有记录
result = mnemosyne("search", token, query=f"SSH {ip}", kind="fact", limit=3)
# 找到 → 直接用记录的凭据
# 没找到 → 询问用户
```

### 完整流程示例

```
用户: "SSH 到 10.0.0.36 看看"

AI:
  1. 先查 Mnemosyne: search "SSH 10.0.0.36"
     → 找到: "SSH 10.0.0.36 | user: root | auth: password"
  2. 用记录的凭据尝试连接
  3. 连接成功 → 什么都不用存（已有记录）
  4. 连接失败 → 问用户要密码

用户: "root / abc123"

AI:
  5. 登录成功
  6. 自动存储: save "SSH 10.0.0.36 | user: root | auth: password | Ubuntu 24.04"
  7. 执行用户要求的操作
```

### 标签约定

所有凭据记录必须有这些标签：

```
["credential", 协议, IP, 用户名, 主机名]
```

这样搜索时可以用任意维度过滤：
- `search query="credential SSH"` → 所有 SSH 凭据
- `search query="credential 10.0.0.35"` → 特定 IP
- `search query="credential root"` → 所有 root 账号

---

## 工具接入

### DSH (DeepSeekRuntime)

```bash
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
        mnemosyneUrl: 'YOUR_URL'
        mnemosyneToken: 'YOUR_TOKEN'
EOF
```

### Hermes

```bash
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mn
HERMES_AGENT=/root/.hermes/hermes-agent
mkdir -p "$HERMES_AGENT/plugins/memory/mnemosyne"
cp /tmp/mn/plugins/memory/mnemosyne/* "$HERMES_AGENT/plugins/memory/mnemosyne/"
echo "MNEMOSYNE_URL=YOUR_URL" >> /root/.hermes/.env
echo "MNEMOSYNE_TOKEN=YOUR_TOKEN" >> /root/.hermes/.env
sed -i '/^memory:/a\  provider: mnemosyne' /root/.hermes/config.yaml
systemctl restart hermes-gateway
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

### 任意自定义工具

```python
class MnemosyneClient:
    def __init__(self, url, token, workspace="default"):
        self.url, self.token, self.workspace = url, token, workspace
    
    def save_credential(self, ip, user, auth, hostname="", os_info="", tags=None):
        """登录成功后调用"""
        content = f"SSH {ip} | user: {user} | auth: {auth}"
        if hostname: content += f" | {hostname}"
        if os_info: content += f" | {os_info}"
        return self._call("POST", "/memory/save", {
            "content": content, "kind": "fact", "importance": 0.85,
            "tags": ["credential", "ssh", ip, user, hostname] + (tags or []),
            "workspace": self.workspace
        })
    
    def find_credential(self, ip=None, user=None, hostname=None):
        """登录前调用"""
        query = "credential"
        if ip: query += f" {ip}"
        if user: query += f" {user}"
        if hostname: query += f" {hostname}"
        return self._call("POST", "/memory/search", {
            "query": query, "kind": "fact", "limit": 5, "workspace": self.workspace
        })
```

---

## API 参考

```
POST   /memory/save       — 保存（自动脱敏）
POST   /memory/search     — BM25 搜索
GET    /memory/recent     — 最近记忆
GET    /memory/timeline   — 时间轴
POST   /memory/dream      — autoDream 整理
GET    /memory/health     — 健康检查
```

---

*Mnemosyne — 记忆女神。一个协议，所有工具共享记忆。*
