#!/bin/bash
# ============================================
# Mnemosyne DSH Plugin — One-command Install
# Usage: ./install-plugin.sh [--server http://127.0.0.1:8790] [--token xxx]
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

# Check DSH
if ! command -v dsh &> /dev/null; then
  error "dsh CLI not found. Install DeepSeekRuntime first."
fi
ok "DSH $(dsh --version 2>/dev/null || echo 'unknown')"

# Check server connectivity
info "Checking server connectivity..."
if [ -z "$TOKEN" ]; then
  warn "No token provided. Set MNEMOSYNE_TOKEN or use --token"
fi

HEALTH=$(curl -s --max-time 5 -H "Authorization: Bearer $TOKEN" "$SERVER_URL/health" 2>/dev/null || echo '{}')
if echo "$HEALTH" | grep -q '"status"'; then
  ok "Server reachable: $SERVER_URL"
else
  warn "Server not reachable at $SERVER_URL (plugin will retry at runtime)"
fi

# Find plugin source
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")/plugin"

if [ ! -d "$PLUGIN_DIR" ]; then
  error "Plugin not found at $PLUGIN_DIR"
fi
ok "Plugin source: $PLUGIN_DIR"

# Install plugin
info "Installing plugin to profile: $PROFILE"

# Create a temporary copy with correct config
TMP_DIR=$(mktemp -d)
cp -r "$PLUGIN_DIR/"* "$TMP_DIR/"

# Update cordis.patch.yml with actual server URL and token
cat > "$TMP_DIR/cordis.patch.yml" << EOF
- insert:
    - id: mnemosyne
      name: 'dsh-mnemosyne'
      config:
        mnemosyneUrl: '$SERVER_URL'
        mnemosyneToken: '$TOKEN'
        maxHintsPerSession: 3
        maxAutoRecallsPerSession: 2
        enableAutoRecall: true
        enableHints: true
        hintOrder: 95
        workspace: 'default'
        timeoutMs: 5000
EOF

# Install via dsh plugin add
info "Running: dsh plugin --profile $PROFILE add $TMP_DIR"
dsh plugin --profile "$PROFILE" add "$TMP_DIR" 2>&1 || {
  # Fallback: manual install
  warn "dsh plugin add failed, trying manual install..."
  
  PROFILE_DIR="$HOME/.dsh/profiles/$PROFILE"
  mkdir -p "$PROFILE_DIR/node_modules/dsh-mnemosyne"
  cp -r "$TMP_DIR/"* "$PROFILE_DIR/node_modules/dsh-mnemosyne/"
  
  # Add to package.json
  if [ -f "$PROFILE_DIR/package.json" ]; then
    node -e "
      const fs = require('fs');
      const pkg = JSON.parse(fs.readFileSync('$PROFILE_DIR/package.json', 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      pkg.dependencies['dsh-mnemosyne'] = 'file:node_modules/dsh-mnemosyne';
      fs.writeFileSync('$PROFILE_DIR/package.json', JSON.stringify(pkg, null, 2));
    "
  fi
  
  ok "Manual install completed"
}

# Cleanup
rm -rf "$TMP_DIR"

# Verify
info "Verifying installation..."
DUMP=$(dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -A5 "mnemosyne" || echo "")

if [ -n "$DUMP" ]; then
  ok "Plugin registered in profile"
else
  warn "Could not verify. Check: dsh --profile $PROFILE --dump-config | grep mnemosyne"
fi

# Summary
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  ✓ Mnemosyne Plugin Installed!                ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Profile:   $PROFILE                                          "
echo "║  Server:    $SERVER_URL                                       "
echo "║                                                               "
echo "║  Next steps:                                                  "
echo "║  1. Restart DSH completely                                    "
echo "║  2. Tools available: memory_save, memory_search,              "
echo "║     memory_recent, memory_timeline                            "
echo "║  3. Predictive hints: max 3 per session                       "
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
