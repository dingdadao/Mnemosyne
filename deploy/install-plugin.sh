#!/bin/bash
# ============================================
# Mnemosyne DSH Plugin — One-command Install
# Usage: ./install-plugin.sh [--server http://127.0.0.1:8790] [--token xxx] [--profile desktop]
#
# 两种宿主都支持：
#   1. 装了 dsh CLI 的机器：额外跑一次 `dsh plugin add`，保证 plugin inventory 一致
#   2. DSH 桌面版（无 CLI）：直接写 profile —— node_modules + dsh.profile.bundles + 配置覆盖
#
# 关键点：光把文件复制进 node_modules 是不够的，必须同时注册到
# dsh.profile.bundles，否则宿主根本不会加载这个插件（旧版 fallback 就漏了这步）。
# ============================================
set -euo pipefail

SERVER_URL="${MNEMOSYNE_URL:-http://127.0.0.1:8790}"
TOKEN="${MNEMOSYNE_TOKEN:-}"
PROFILE="${DSH_PROFILE:-desktop}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()  { echo -e "${BLUE}[mnemosyne]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# Parse args
while [[ $# -gt 0 ]]; do
  case $1 in
    --server) SERVER_URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           Mnemosyne Plugin — DSH 插件安装                     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# --- 宿主能力探测（CLI 不是必需的）---
HAS_CLI=0
if command -v dsh &> /dev/null; then
  HAS_CLI=1
  ok "DSH CLI: $(dsh --version 2>/dev/null || echo 'unknown')"
else
  warn "未找到 dsh CLI（DSH 桌面版属正常）——直接写入 profile"
fi

# --- 服务连通性 ---
info "Checking server connectivity..."
if [ -z "$TOKEN" ]; then
  warn "No token provided. Set MNEMOSYNE_TOKEN or use --token"
fi

# 用 HTTP 状态码判断，不依赖响应体字段（不同版本的 /health 载荷不一样）
HEALTH_CODE=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $TOKEN" "$SERVER_URL/health" 2>/dev/null || echo '000')
case "$HEALTH_CODE" in
  2*) ok "Server reachable: $SERVER_URL (HTTP $HEALTH_CODE)" ;;
  401|403) warn "Server 可达但鉴权失败 (HTTP $HEALTH_CODE)：检查 --token" ;;
  000) warn "Server 不可达：$SERVER_URL（插件运行时会重试）" ;;
  *) warn "Server 返回 HTTP $HEALTH_CODE：$SERVER_URL（插件运行时会重试）" ;;
esac

# --- 插件源码 ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")/plugin"

if [ ! -d "$PLUGIN_DIR" ]; then
  error "Plugin not found at $PLUGIN_DIR"
fi
ok "Plugin source: $PLUGIN_DIR"

PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
if [ ! -d "$PROFILE_DIR" ]; then
  error "Profile not found: $PROFILE_DIR (先启动一次 DSH 让它生成 profile)"
fi

# --- 复制文件 ---
info "Installing plugin to profile: $PROFILE"
mkdir -p "$PROFILE_DIR/node_modules/dsh-mnemosyne"
cp -R "$PLUGIN_DIR/." "$PROFILE_DIR/node_modules/dsh-mnemosyne/"
ok "Plugin files copied"

# --- 注册 bundle + 写配置覆盖 + 自校验 ---
info "Registering bundle and writing config override..."
node "$SCRIPT_DIR/register-profile.js" \
  --profile-dir "$PROFILE_DIR" \
  --url "$SERVER_URL" \
  --token "$TOKEN" || error "注册失败（见上方 ✗ 项）"

# --- CLI 存在时再对齐一次 inventory ---
if [ "$HAS_CLI" = "1" ]; then
  info "Running: dsh plugin --profile $PROFILE add $PLUGIN_DIR"
  if dsh plugin --profile "$PROFILE" add "$PLUGIN_DIR" >/dev/null 2>&1; then
    ok "dsh plugin add ok"
  else
    warn "dsh plugin add skipped (profile already updated manually)"
  fi
fi

# --- 汇总 ---
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  ✓ Mnemosyne Plugin Installed!                ║"
echo "╠══════════════════════════════════════════════════════════════╣"
printf  "║  Profile:   %-49s║\n" "$PROFILE"
printf  "║  Server:    %-49s║\n" "$SERVER_URL"
echo   "║                                                               ║"
echo   "║  生效方式（二选一）                                           ║"
echo   "║  1. 重启 DSH                                                  ║"
echo   "║  2. 改 profile 的 cordis.patch.yml（HMR 自动重载，免重启）     ║"
echo   "║                                                               ║"
echo   "║  工具: memory_save / memory_search / memory_recent /          ║"
echo   "║        memory_timeline / memory_brief                         ║"
echo   "╚══════════════════════════════════════════════════════════════╝"
echo ""
