#!/bin/bash
# 工作区入口。无参数=自检，带参数则透传。
#   ./run.sh check            一站式自检
#   ./run.sh test             插件单元测试
#   ./run.sh sync             源码推到 profile（先跑测试）
#   ./run.sh restore          回滚 profile 插件
#   ./run.sh server           本地起服务端（开发用，127.0.0.1:8790）
#   ./run.sh smoke            打生产服务端冒烟
#   ./run.sh init             确保本仓库已注册为 DSH 工作区

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
CMD="${1:-check}"; shift 2>/dev/null

case "$CMD" in
  check)   exec ./scripts/check.sh "$@" ;;
  test)    exec node --test plugin/index.test.mjs ;;
  sync)    exec ./scripts/dev-sync.sh --test "$@" ;;
  restore) exec ./scripts/dev-sync.sh --restore ;;
  init)    exec python3 scripts/register-workspace.py "$@" ;;
  server)
    [ -d server/node_modules ] || (cd server && npm install)
    echo "▸ 本地服务端 http://127.0.0.1:8790 （Ctrl-C 停）"
    cd server && exec node index.js
    ;;
  smoke)
    source ./scripts/lib.sh
    exec ./deploy/smoke-test.sh "$MNEMOSYNE_URL" "$MNEMOSYNE_TOKEN"
    ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 1 ;;
esac
