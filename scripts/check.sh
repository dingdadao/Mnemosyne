#!/bin/bash
# 工作区一站式自检：运行时 / 服务端 / 源码漂移 / 测试 / git 状态
# 用法: ./scripts/check.sh [-q]     -q 只报失败项

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
QUIET=0
[ "${1:-}" = "-q" ] && QUIET=1
FAILED=0
pass() { [ "$QUIET" = 1 ] || ok "$1"; }
fail() { bad "$1"; FAILED=$((FAILED+1)); }

cd "$REPO_ROOT" || exit 1

step "1. 运行时"
NODE_V=$(node -v 2>/dev/null || echo "")
if [ -n "$NODE_V" ]; then
  major=${NODE_V#v}; major=${major%%.*}
  [ "$major" -ge 18 ] && pass "node $NODE_V" || fail "node $NODE_V（需要 >=18）"
else
  fail "node 未安装"
fi
if command -v pnpm >/dev/null; then pass "pnpm $(pnpm -v)"; else warn "pnpm 未安装（dsh plugin 命令需要）"; fi

step "2. profile 配置"
if read_profile_conf; then
  pass "profile=$PROFILE  url=$MNEMOSYNE_URL  token=${MNEMOSYNE_TOKEN:0:8}...${MNEMOSYNE_TOKEN: -4}"
else
  fail "读不到 $PROFILE_PATCH 里的 mnemosyneUrl"
fi

step "3. 服务端连通"
if [ -n "$MNEMOSYNE_TOKEN" ]; then
  HEALTH=$(api /health)
  VER=$(printf '%s' "$HEALTH" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null)
  if [ -n "$VER" ]; then
    TOTAL=$(printf '%s' "$HEALTH" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("stats",{}).get("total","?"))' 2>/dev/null)
    pass "健康 version=$VER  记忆总数=$TOTAL"
  else
    fail "服务端不可达或鉴权失败: $MNEMOSYNE_URL"
  fi
  BRIEF=$(api /memory/brief -X POST -d '{"workspace":"default","goal":"健康检查","budget":200}')
  if printf '%s' "$BRIEF" | grep -q '"stats"'; then
    pass "POST /memory/brief 可用（v4 首轮简报）"
  else
    fail "POST /memory/brief 无响应（插件会走本地合成降级）"
  fi
else
  warn "无 token，跳过"
fi

step "4. 插件安装与漂移"
if [ -f "$INSTALLED/index.js" ]; then
  pass "已安装: $INSTALLED"
  if cmp -s "$SRC_PLUGIN" "$INSTALLED/index.js"; then
    pass "源码与运行副本一致"
  else
    warn "源码与运行副本不一致（运行中生效的是 profile 副本）"
    info "仓库 $(wc -l < "$SRC_PLUGIN" | tr -d ' ') 行  /  profile $(wc -l < "$INSTALLED/index.js" | tr -d ' ') 行"
    info "执行 ./scripts/dev-sync.sh 把仓库源码推到 profile"
  fi
else
  fail "未安装到 $PROFILE_DIR（执行 deploy/install-plugin.sh）"
fi

step "5. 插件单元测试"
if TEST_OUT=$(node --test plugin/index.test.mjs 2>&1); then
  N=$(printf '%s' "$TEST_OUT" | sed -n 's/^ℹ pass \([0-9]*\)$/\1/p')
  pass "node --test 通过 ${N:-?} 项"
else
  fail "插件测试失败（node --test plugin/index.test.mjs）"
  printf '%s\n' "$TEST_OUT" | tail -20
fi

step "6. git"
if [ -d .git ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  AHEAD=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo "?")
  pass "分支 $BRANCH  未提交改动 $DIRTY  领先远程 $AHEAD"
  [ "$DIRTY" -gt 0 ] && info "$(git status --porcelain | head -8 | tr '\n' ' ')"
else
  fail "不是 git 仓库"
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf "${GREEN}全部通过${NC}  （工作区 $REPO_ROOT）\n"
else
  printf "${RED}%d 项失败${NC}\n" "$FAILED"
fi
exit "$FAILED"
