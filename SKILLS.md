# Mnemosyne — 通用 AI 记忆协议

> 任何 AI 工具都可以接入的中心化记忆协议。
> 只需要能发 HTTP 请求，就能共享记忆。

---

## 协议概览

```
┌─────────────────────────────────────────────────────────┐
│                  Mnemosyne Server                        │
│              https://mnemosyne.niao.fun                  │
│                                                          │
│  REST API + Bearer Auth                                  │
│  SQLite + BM25 + Timeline + Relations                    │
│                                                          │
└──────────┬──────────┬──────────┬──────────┬──────────────┘
           │          │          │          │
           ▼          ▼          ▼          ▼
      ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
      │  DSH   │ │ Hermes │ │ 豆包   │ │ 龙虾   │
      │ 插件   │ │Provider│ │ HTTP   │ │ HTTP   │
      │        │ │        │ │ Client │ │ Client │
      └────────┘ └────────┘ └────────┘ └────────┘
           │          │          │          │
           ▼          ▼          ▼          ▼
      ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
      │WorkBuddy│ │ Claude │ │ Cursor │ │ 任意   │
      │ HTTP   │ │  MCP   │ │  MCP   │ │ 工具   │
      │ Client │ │        │ │        │ │        │
      └────────┘ └────────┘ └────────┘ └────────┘
```

---

## 核心协议：HTTP + JSON

**任何能发 HTTP 请求的工具都能接入。**

```
认证: Authorization: Bearer <token>
格式: JSON
编码: UTF-8
```

### 最小接入代码（任何语言）

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

// 保存
await mnemosyne("save", token, { content: "记住这个", kind: "fact" });

// 搜索
await mnemosyne("search", token, { query: "记住", limit: 5 });
```

```bash
# Bash / curl — 3 行接入
MNEMOSYNE() {
  curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$2" "https://mnemosyne.niao.fun/memory/$1"
}

# 保存
MNEMOSYNE save '{"content":"记住这个","kind":"fact"}'

# 搜索
MNEMOSYNE search '{"query":"记住","limit":5}'
```

---

## 工具接入指南

### DSH (DeepSeek Harness)

```bash
# 一键安装
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
# 重启 DSH
```

**DSH 插件特性**：预测式召回（说"之前/上次"自动搜索）、自动保存（说"记住"自动存储）。

### Hermes

```bash
# 一键安装 MemoryProvider
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mn
HERMES_AGENT=/root/.hermes/hermes-agent
mkdir -p "$HERMES_AGENT/plugins/memory/mnemosyne"
cp /tmp/mn/plugins/memory/mnemosyne/* "$HERMES_AGENT/plugins/memory/mnemosyne/"
echo "MNEMOSYNE_URL=YOUR_URL" >> /root/.hermes/.env
echo "MNEMOSYNE_TOKEN=YOUR_TOKEN" >> /root/.hermes/.env
sed -i '/^memory:/a\  provider: mnemosyne' /root/.hermes/config.yaml
systemctl restart hermes-gateway
```

**Hermes 特性**：全自动——每轮自动召回（prefetch）+ 每轮自动保存（sync_turn），agent 无感知。

### Claude Code / Cursor / 任何 MCP 工具

```json
// .mcp.json
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

### 豆包 / 龙虾 / WorkBuddy / 任意自定义工具

只要你的工具能发 HTTP 请求：

```python
# 通用接入模板（复制即用）
import json, urllib.request

class MnemosyneClient:
    def __init__(self, url, token, workspace="default"):
        self.url = url
        self.token = token
        self.workspace = workspace
    
    def _call(self, method, path, body=None):
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
    
    def search(self, query, limit=10, kind=None):
        body = {"query": query, "limit": limit, "workspace": self.workspace}
        if kind: body["kind"] = kind
        return self._call("POST", "/memory/search", body)
    
    def recent(self, limit=10):
        return self._call("GET", f"/memory/recent?workspace={self.workspace}&limit={limit}")
    
    def health(self):
        return self._call("GET", f"/memory/health?workspace={self.workspace}")
    
    def dream(self):
        return self._call("POST", "/memory/dream", {"workspace": self.workspace})

# 使用
client = MnemosyneClient("https://mnemosyne.niao.fun", "YOUR_TOKEN")
client.save("记住这个", kind="fact")
client.search("记住")
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
GET    /memory/duplicates — 查找重复
POST   /memory/dream      — autoDream 整理
POST   /memory/consolidate — 合并重复
POST   /memory/summarize  — 生成摘要
GET    /memory/stats/detailed — 详细统计
```

### 系统

```
GET    /health            — 健康检查
GET    /stats             — 统计
GET    /export            — JSON 导出
POST   /backup            — SQLite 备份
GET    /audit             — 审计日志
```

---

## 数据格式

### 保存记忆

```json
{
  "content": "记忆内容（必填，最长5000字符）",
  "kind": "fact | preference | decision | procedure | error | episode",
  "tags": ["标签1", "标签2"],
  "importance": 0.5,
  "workspace": "default",
  "summary": "简短摘要（可选，不填自动生成）",
  "source_agent": "dsh | hermes | doubao | custom",
  "source_session": "会话ID（可选）"
}
```

### 搜索记忆

```json
{
  "query": "搜索关键词",
  "kind": "fact",
  "limit": 10,
  "offset": 0,
  "workspace": "default"
}
```

### 响应格式

```json
{
  "query": "搜索关键词",
  "count": 5,
  "results": [
    {
      "id": "mem_xxx",
      "content": "记忆内容...",
      "summary": "自动摘要",
      "kind": "fact",
      "importance": 0.8,
      "tags": ["标签"],
      "created_at": 1699353600,
      "workspace_id": "default",
      "_score": 12.34
    }
  ]
}
```

---

## 记忆类型 (kind)

| kind | 用途 | importance 建议 |
|------|------|----------------|
| `fact` | 事实、知识 | 0.5-0.7 |
| `preference` | 用户偏好 | 0.6-0.8 |
| `decision` | 决策记录 | 0.8-0.95 |
| `procedure` | 流程步骤 | 0.6-0.8 |
| `error` | 错误记录 | 0.7-0.9 |
| `episode` | 会话摘要 | 0.4-0.6 |

---

## 工具集成最佳实践

### 自动召回模式

```
用户发消息 → 你的工具
                ├── 调用 POST /memory/search (query=用户消息, limit=3)
                ├── 将结果注入 system prompt 或 context
                ├── Agent 处理（有记忆上下文）
                └── 调用 POST /memory/save (后台，保存对话要点)
```

### 智能保存策略

不需要保存所有对话。用关键词判断：

```python
def should_save(user_msg, assistant_msg):
    """判断这轮对话是否值得保存"""
    keywords_high = ["记住", "决定", "选定", "部署成功", "错误", "失败", "配置"]
    keywords_medium = ["部署", "配置", "步骤", "流程", "偏好", "习惯"]
    
    for kw in keywords_high:
        if kw in user_msg:
            return True, "decision" if "决定" in kw else "error" if "错误" in kw else "fact", 0.8
    
    for kw in keywords_medium:
        if kw in user_msg:
            return True, "procedure", 0.6
    
    return False, "episode", 0.4
```

### 工作区隔离

```python
# 不同项目用不同 workspace，防止记忆串台
client = MnemosyneClient(url, token, workspace="waf-project")
client.save("WAF 配置...", kind="procedure")

client2 = MnemosyneClient(url, token, workspace="ecom-admin")  
client2.save("电商后台...", kind="procedure")
```

---

## 安全

- **HTTPS**: 所有传输加密
- **Bearer Token**: 认证
- **自动脱敏**: 保存时自动检测密码、API Key、Token 并替换
- **Rate Limit**: 100 req/min
- **审计**: 所有操作记录

---

*Mnemosyne — 记忆女神。一个协议，所有工具共享记忆。*
