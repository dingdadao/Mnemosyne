# Mnemosyne — AI 智能体使用指南

> 中心化记忆服务器。预测式召回，Pull not Push。
> 任何 AI 智能体读完此文档即可使用。

---

## 一键安装

### DSH 插件（Mac/Linux/Windows）

```bash
# 1. 克隆仓库
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mnemosyne

# 2. 安装插件到 DSH profile
DSH_PROFILE=~/.dsh/profiles/desktop
mkdir -p "$DSH_PROFILE/node_modules/dsh-mnemosyne"
cp -r /tmp/mnemosyne/plugin/* "$DSH_PROFILE/node_modules/dsh-mnemosyne/"

# 3. 注册依赖
cd "$DSH_PROFILE"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies['dsh-mnemosyne'] = 'file:node_modules/dsh-mnemosyne';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
"

# 4. 添加配置
cat >> cordis.patch.yml << 'EOF'

# Mnemosyne — 中心化跨设备记忆
- insert:
    - id: mnemosyne
      name: 'dsh-mnemosyne'
      config:
        mnemosyneUrl: 'YOUR_MNEMOSYNE_URL'
        mnemosyneToken: 'YOUR_TOKEN'
        maxHintsPerSession: 3
        enableAutoRecall: true
        workspace: 'default'
EOF

# 5. 重启 DSH
echo "重启 DSH 后生效"
```

### Hermes MemoryProvider（自动召回+自动保存）

```bash
# 1. 克隆仓库
git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mnemosyne

# 2. 复制 MemoryProvider 插件
HERMES_AGENT=/root/.hermes/hermes-agent  # 按实际路径调整
mkdir -p "$HERMES_AGENT/plugins/memory/mnemosyne"
cp /tmp/mnemosyne/plugins/memory/mnemosyne/* "$HERMES_AGENT/plugins/memory/mnemosyne/"

# 3. 配置环境变量
cat >> /root/.hermes/.env << 'EOF'
MNEMOSYNE_URL=YOUR_MNEMOSYNE_URL
MNEMOSYNE_TOKEN=YOUR_TOKEN
MNEMOSYNE_WS=default
EOF

# 4. 激活 provider
# 编辑 /root/.hermes/config.yaml,在 memory: 下加 provider: mnemosyne

# 5. 重启 Hermes
systemctl restart hermes-gateway
```

### Hermes Tool（手动调用，如果不用 MemoryProvider）

```bash
# 复制 tool 到 Hermes tools 目录
cp /tmp/mnemosyne/plugins/memory/mnemosyne/__init__.py \
   "$HERMES_AGENT/tools/mnemosyne_tool.py"
```

### 中心化服务器（自己部署）

```bash
curl -sSL https://raw.githubusercontent.com/dingdadao/Mnemosyne/main/deploy/install-server.sh | bash
```

---

## 快速开始

```bash
export MNEMOSYNE_URL="https://your-server.com"
export MNEMOSYNE_TOKEN="your-token"

# 测试连接
curl -s -H "Authorization: Bearer $MNEMOSYNE_TOKEN" $MNEMOSYNE_URL/health

# 保存记忆
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "测试记忆", "kind": "fact"}' \
  $MNEMOSYNE_URL/memory/save

# 搜索记忆
curl -s -X POST -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query": "测试"}' \
  $MNEMOSYNE_URL/memory/search
```

---

## 核心概念

### 记忆类型 (kind)

| kind | 用途 | importance |
|------|------|-----------|
| `fact` | 事实、知识 | 0.5-0.7 |
| `preference` | 用户偏好 | 0.6-0.8 |
| `decision` | 决策记录 | 0.8-0.95 |
| `procedure` | 流程步骤 | 0.6-0.8 |
| `error` | 错误记录 | 0.7-0.9 |
| `episode` | 会话摘要 | 0.4-0.6 |

### 工作区 (workspace)

记忆按工作区隔离。不同项目用不同 workspace 防止串台。

### 重要性 (importance)

0.0-1.0，影响搜索排序。关键决策设 0.8+。

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

## 安全特性

- **传输**: HTTPS（CDN 回源）
- **认证**: Bearer Token（timing-safe comparison）
- **脱敏**: 保存时自动检测并替换密码、API Key、Token、SSH Key
- **Rate Limit**: 100 req/min per IP
- **审计**: 所有操作记录到 audit_log
- **文件权限**: 600（owner only）

---

## 凭证库（Credentials Vault）

Mnemosyne 内置加密凭证库，用于跨设备共享登录凭据。

```bash
# 保存凭证（自动加密）
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "service": "github",
    "key": "api_token",
    "value": "ghp_xxxxxxxx",
    "tags": ["dev", "ci"]
  }' \
  $MNEMOSYNE_URL/vault/save

# 读取凭证（自动解密）
curl -s -H "Authorization: Bearer $TOKEN" \
  "$MNEMOSYNE_URL/vault/get?service=github&key=api_token"

# 列出服务
curl -s -H "Authorization: Bearer $TOKEN" \
  "$MNEMOSYNE_URL/vault/list"

# 删除凭证
curl -s -X DELETE -H "Authorization: Bearer $TOKEN" \
  "$MNEMOSYNE_URL/vault/delete?service=github&key=api_token"
```

### 安全设计

- **AES-256-GCM 加密**: 所有凭证在服务端加密存储
- **设备密钥**: 每个设备有独立密钥对，通过 Mnemosyne 协商共享密钥
- **不解密不存储**: 服务器只能存储和转发加密数据，无法读取明文
- **审计日志**: 所有凭证操作（读/写/删）记录到 audit_log
- **访问控制**: 凭证与工作区绑定，不同 workspace 的凭证隔离

---

## 最佳实践

### DO
- 按工作区隔离不同项目
- 标记 kind（fact/decision/error/preference）
- 关键信息设 importance 0.8+
- 加 tags 方便筛选
- 定期运行 dream 整理记忆
- 敏感凭据用 vault 存储

### DON'T
- 不要存明文密码（vault 会自动加密）
- 不要存超长内容（单条限制 5000 字符）
- 不要过度搜索（prefetch 已自动处理）
- 不要跨工作区搜索

---

*Mnemosyne — 记忆女神。Pull, not Push.*
*服务器地址和 Token 请向管理员获取，或自行部署。*
