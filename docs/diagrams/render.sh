#!/bin/bash
# 从 docs/architecture-flow.md 抽取所有 mermaid 块，重新渲染成 docs/diagrams/*.svg
#
# 用法:
#   ./docs/diagrams/render.sh
#   MMDC=/path/to/mmdc ./docs/diagrams/render.sh    # 用已有的 mermaid-cli
#   CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ./docs/diagrams/render.sh
#
# 依赖: node（跑 mermaid-cli）、python3（抽取代码块）、一个 Chrome/Chromium 可执行文件。
# 首次运行会用 npx 拉 @mermaid-js/mermaid-cli；装到本地后可用 MMDC 指过去，快很多。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SRC="$ROOT/docs/architecture-flow.md"
OUT="$ROOT/docs/diagrams"
CONFIG="$OUT/mermaid-config.json"
NAMES=(fig-1-overview fig-2-brief-sequence fig-3-buildbrief fig-4-fallback fig-5-dev-loop)

command -v python3 >/dev/null || { echo "缺 python3"; exit 1; }

# --- 找 Chrome / Chromium -----------------------------------------------------
CHROME="${CHROME:-}"
if [ -z "$CHROME" ]; then
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"; do
    [ -x "$c" ] && CHROME="$c" && break
  done
fi
if [ -z "$CHROME" ]; then
  CHROME="$(command -v chromium || command -v chromium-browser || command -v google-chrome || true)"
fi
[ -n "$CHROME" ] && [ -x "$CHROME" ] || { echo "找不到 Chrome/Chromium，用 CHROME=... 指定"; exit 1; }

PPTR="$(mktemp -t mnemo-pptr).json"
python3 - "$CHROME" "$PPTR" <<'PY'
import json, sys
open(sys.argv[2], 'w').write(json.dumps({
    "executablePath": sys.argv[1],
    "args": ["--no-sandbox", "--disable-dev-shm-usage"],
}, ensure_ascii=False))
PY

# --- 抽取 mermaid 块 ----------------------------------------------------------
TMP="$(mktemp -d -t mnemo-mmd)"
trap 'rm -rf "$TMP" "$PPTR"' EXIT
python3 - "$SRC" "$TMP" "${NAMES[@]}" <<'PY'
import pathlib, re, sys
src, out, names = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), sys.argv[3:]
blocks = re.findall(r'```mermaid\n(.*?)```', src.read_text(), re.S)
if len(blocks) != len(names):
    sys.exit(f'代码块数量不符：文档里 {len(blocks)} 个，脚本期望 {len(names)} 个（改图后请同步 NAMES）')
for n, b in zip(names, blocks):
    (out / f'{n}.mmd').write_text(b.rstrip() + '\n')
print(f'抽取 {len(blocks)} 个 mermaid 块')
PY

# --- 找 mmdc ------------------------------------------------------------------
MMDC="${MMDC:-}"
if [ -z "$MMDC" ]; then
  if [ -x "$ROOT/node_modules/.bin/mmdc" ]; then
    MMDC="$ROOT/node_modules/.bin/mmdc"
  else
    MMDC="npx -y @mermaid-js/mermaid-cli@12"
  fi
fi

# --- 渲染 ---------------------------------------------------------------------
for n in "${NAMES[@]}"; do
  # shellcheck disable=SC2086
  $MMDC -q -p "$PPTR" -c "$CONFIG" -i "$TMP/$n.mmd" -o "$OUT/$n.svg" -b white
  printf '✓ %s.svg\n' "$n"
done

echo
echo "完成：$OUT"
echo "校验：grep -c foreignObject $OUT/*.svg  # 全 0 才能在 GitHub 的 <img> 里正常显示文字"
