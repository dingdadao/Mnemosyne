# Mnemosyne 安全凭证库设计

## 概述

跨设备共享登录凭据，端到端加密，服务器无法读取明文。

## 威胁模型

| 威胁 | 防护 |
|------|------|
| 服务器被入侵 | AES-256-GCM 加密，服务器无明文 |
| 中间人攻击 | HTTPS + 证书固定 |
| Token 泄露 | Rate limiting + 审计日志 |
| 内部人员 | 设备级密钥隔离，最小权限 |
| 备份泄露 | 备份文件同样加密 |

## 架构

```
设备 A                    Mnemosyne 服务器                 设备 B
  │                            │                            │
  ├─ 生成密钥对 ──────────────→│                            │
  │  (pubkey_A, privkey_A)     │                            │
  │                            │←───────────────────────────┤
  │                            │              生成密钥对     │
  │                            │         (pubkey_B, privkey_B)│
  │                            │                            │
  ├─ 协商共享密钥 ─────────────→│←───────────────────────────┤
  │  ECDH(pubkey_B) → shared   │    ECDH(pubkey_A) → shared │
  │                            │                            │
  ├─ AES-256-GCM 加密凭证 ────→│                            │
  │  ciphertext + nonce + tag  │                            │
  │                            │                            │
  │                            │───────────────────────────→│
  │                            │         读取加密凭证        │
  │                            │←───────────────────────────┤
  │                            │    AES-256-GCM 解密        │
  │←───────────────────────────│         (用 shared key)    │
  │     读取并解密凭证          │                            │
```

## 密钥管理

### 设备密钥对
- 每个设备首次连接时生成 X25519 密钥对
- 私钥存储在设备本地（`~/.mnemosyne/device.key`）
- 公钥注册到 Mnemosyne 服务器

### 共享密钥协商
- 设备 A 和设备 B 通过 ECDH 协商共享密钥
- Mnemosyne 服务器只做密钥交换中转
- 共享密钥永不离开设备

### 凭证加密
- 使用 AES-256-GCM 加密
- 每次加密使用随机 nonce
- AAD（Additional Authenticated Data）绑定 service+key 防止篡改

## API 设计

### 设备注册
```bash
POST /vault/device/register
{
  "device_id": "macbook-pro-2024",
  "public_key": "base64_encoded_x25519_pubkey"
}
```

### 密钥协商
```bash
POST /vault/key/exchange
{
  "from_device": "macbook-pro-2024",
  "to_device": "hermes-server-11",
  "ephemeral_pubkey": "base64_encoded_ephemeral_key"
}
# 响应: { "shared_key_hint": "...", "ephemeral_pubkey": "..." }
```

### 保存凭证
```bash
POST /vault/save
{
  "service": "github",
  "key": "api_token",
  "ciphertext": "base64_aes_gcm_ciphertext",
  "nonce": "base64_nonce",
  "tag": "base64_auth_tag",
  "workspace": "default",
  "tags": ["dev", "ci"]
}
```

### 读取凭证
```bash
GET /vault/get?service=github&key=api_token&workspace=default
# 响应: { "ciphertext": "...", "nonce": "...", "tag": "..." }
# 客户端解密
```

### 列出服务
```bash
GET /vault/list?workspace=default
# 响应: { "services": ["github", "aws", "database"] }
```

## 数据库 Schema

```sql
CREATE TABLE vault_devices (
  id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  public_key TEXT NOT NULL,        -- X25519 public key (base64)
  created_at INTEGER DEFAULT (unixepoch()),
  last_seen_at INTEGER,
  trusted INTEGER DEFAULT 0
);

CREATE TABLE vault_credentials (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  service TEXT NOT NULL,
  key_name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,        -- AES-256-GCM ciphertext (base64)
  nonce TEXT NOT NULL,             -- GCM nonce (base64)
  auth_tag TEXT NOT NULL,          -- GCM auth tag (base64)
  created_by TEXT NOT NULL,        -- device_id
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch()),
  access_count INTEGER DEFAULT 0,
  last_accessed_at INTEGER,
  tags TEXT DEFAULT '[]',
  UNIQUE(workspace_id, service, key_name)
);

CREATE TABLE vault_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER DEFAULT (unixepoch()),
  device_id TEXT NOT NULL,
  action TEXT NOT NULL,            -- save | read | delete | list
  service TEXT,
  key_name TEXT,
  success INTEGER DEFAULT 1,
  ip_address TEXT
);
```

## 客户端流程

### 首次使用（设备注册）
```python
# 生成密钥对
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
private_key = X25519PrivateKey.generate()
public_key = private_key.public_key()

# 保存私钥
with open("~/.mnemosyne/device.key", "wb") as f:
    f.write(private_key.private_bytes(...))

# 注册公钥到服务器
requests.post("/vault/device/register", {
    "device_id": "macbook-pro",
    "public_key": base64.b64encode(public_key_bytes)
})
```

### 保存凭证
```python
# 与其他设备协商共享密钥（通过服务器中转 ECDH）
shared_key = ecdh_key_exchange(my_private_key, other_device_pubkey)

# 加密凭证
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
aesgcm = AESGCM(shared_key)
nonce = os.urandom(12)
ciphertext = aesgcm.encrypt(nonce, plaintext, aad)

# 上传到服务器
requests.post("/vault/save", {
    "service": "github",
    "key": "api_token",
    "ciphertext": base64.b64encode(ciphertext),
    "nonce": base64.b64encode(nonce),
    "tag": base64.b64encode(tag)
})
```

### 读取凭证
```python
# 从服务器获取加密凭证
resp = requests.get("/vault/get?service=github&key=api_token")
data = resp.json()

# 解密
plaintext = aesgcm.decrypt(
    base64.b64decode(data["nonce"]),
    base64.b64decode(data["ciphertext"]),
    aad
)
```

## 安全审计

- 所有凭证操作记录到 `vault_access_log`
- 定期审计异常访问模式
- 设备断连 30 天后自动标记为不可信
- 支持凭证轮换（更新时旧版本自动归档）

## 开源实现参考

- [HashiCorp Vault](https://www.vaultproject.io/) — 企业级密钥管理
- [Mozilla SOPS](https://github.com/getsops/sops) — 文件级加密
- [age](https://age-encryption.org/) — 现代加密工具
