#!/bin/bash
# 把仓库里的插件源码推到运行中的 profile（保留 profile 的真配置与 token）
#
# 用法:
#   ./scripts/dev-sync.sh            # 同步 plugin/index.js + package.json
#   ./scripts/dev-sync.sh --test     # 先跑测试，通过才同步
#   ./scripts/dev-sync.sh --dry-run  # 只看会改什么
#   ./scripts/dev-sync.sh --restore  # 回滚到最近一次同步前的备份
#
# 说明：profile 里的 cordis.patch.yml 才是真配置（带 url + token），
#       仓库里的那份是带 env 的模板 —— 同步时**永不覆盖**它。

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

MODE=sync
for a in "$@"; do
  case "$a" in
    --test) MODE=test ;;
    --dry-run) MODE=dry ;;
    --restore) MODE=restore ;;
    -h|--help) sed -n '2,13p' "${BASH_SOURCE[0]}"; exit 0 ;;
  esac
done

cd "$REPO_ROOT" || exit 1

if [ ! -d "$INSTALLED" ]; then
  bad "profile 里没有 dsh-mnemosyne：先跑 deploy/install-plugin.sh"
  exit 1
fi

if [ "$MODE" = restore ]; then
  LAST=$(ls -t "$INSTALLED"/index.js.bak-* 2>/dev/null | head -1)
  [ -z "$LAST" ] && { bad "没有可回滚的备份"; exit 1; }
  cp "$LAST" "$INSTALLED/index.js"
  ok "已回滚到 $(basename "$LAST")"
  warn "重启 DSH 后生效"
  exit 0
fi

step "同步 $SRC_PLUGIN → $INSTALLED/index.js"
if cmp -s "$SRC_PLUGIN" "$INSTALLED/index.js"; then
  ok "已经一致，无需同步"
  exit 0
fi
info "仓库 $(wc -l < "$SRC_PLUGIN" | tr -d ' ') 行 → profile $(wc -l < "$INSTALLED/index.js" | tr -d ' ') 行"

if [ "$MODE" = test ]; then
  step "同步前跑测试"
  if node --test "$REPO_ROOT/plugin/index.test.mjs" >/tmp/mnemosyne-sync-test.log 2>&1; then
    ok "测试通过"
  else
    bad "测试失败，已中止同步"
    tail -20 /tmp/mnemosyne-sync-test.log
    exit 1
  fi
fi

if [ "$MODE" = dry ]; then
  warn "dry-run：未写入。将要同步的文件："
  echo "  plugin/index.js"
  echo "  plugin/package.json"
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
cp "$INSTALLED/index.js" "$INSTALLED/index.js.bak-$STAMP"
cp "$SRC_PLUGIN" "$INSTALLED/index.js"
cp "$REPO_ROOT/plugin/package.json" "$INSTALLED/package.json" 2>/dev/null
ok "已写入（备份 index.js.bak-$STAMP）"
warn "重启 DSH 后生效：完全退出 DeepSeekRuntime 再启动"
info "回滚: ./scripts/dev-sync.sh --restore"
