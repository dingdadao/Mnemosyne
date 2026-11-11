#!/bin/bash
# 工作区脚本公用变量与函数。被 check.sh / dev-sync.sh source。
# 不写死任何 token：一律从运行中的 profile 配置读取。

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-desktop}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
INSTALLED="$PROFILE_DIR/node_modules/dsh-mnemosyne"
PROFILE_PATCH="$PROFILE_DIR/cordis.patch.yml"
SRC_PLUGIN="$REPO_ROOT/plugin/index.js"
SRC_PATCH="$REPO_ROOT/plugin/cordis.patch.yml"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; DIM='\033[2m'; NC='\033[0m'
ok()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
bad()  { printf "${RED}✗${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}!${NC} %s\n" "$1"; }
step() { printf "\n${BLUE}▸ %s${NC}\n" "$1"; }
info() { printf "${DIM}  %s${NC}\n" "$1"; }

# 从 profile 的 cordis.patch.yml 读取 mnemosyneUrl / mnemosyneToken
# （profile 里这份才是真配置；仓库里的那份是带环境变量的模板）
read_profile_conf() {
  if [ ! -f "$PROFILE_PATCH" ]; then
    MNEMOSYNE_URL=""; MNEMOSYNE_TOKEN=""; return 1
  fi
  MNEMOSYNE_URL=$(sed -n "s/.*mnemosyneUrl:[[:space:]]*'\{0,1\}\([^']*\)'\{0,1\}[[:space:]]*$/\1/p" "$PROFILE_PATCH" | head -1)
  MNEMOSYNE_TOKEN=$(sed -n "s/.*mnemosyneToken:[[:space:]]*'\{0,1\}\([^']*\)'\{0,1\}[[:space:]]*$/\1/p" "$PROFILE_PATCH" | head -1)
  [ -n "$MNEMOSYNE_URL" ]
}

# 带鉴权调用服务端，输出 body；失败输出空
api() {
  local path="$1"; shift
  curl -s -m "${API_TIMEOUT:-8}" \
    -H "Authorization: Bearer $MNEMOSYNE_TOKEN" \
    -H 'Content-Type: application/json' \
    "$@" "$MNEMOSYNE_URL$path"
}
