#!/bin/bash
# ============================================
# Mnemosyne Server — One-command Deployment
# Usage: curl -sSL https://raw.githubusercontent.com/YOUR_REPO/mnemosyne/main/deploy/install-server.sh | bash
#    or: ./install-server.sh [--port 8790] [--data-dir /data/mnemosyne]
# ============================================
set -euo pipefail

# --- Config ---
PORT="${MNEMOSYNE_PORT:-8790}"
DATA_DIR="${MNEMOSYNE_DATA_DIR:-$HOME/.mnemosyne}"
INSTALL_DIR="${MNEMOSYNE_INSTALL_DIR:-/opt/mnemosyne}"
NODE_MIN_VERSION=18

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[mnemosyne]${NC} $1"; }
ok()    { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case $1 in
    --port) PORT="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           Mnemosyne Server — 中心化记忆服务器部署              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# --- Check Node.js ---
info "Checking Node.js..."
if ! command -v node &> /dev/null; then
  error "Node.js not found. Install Node.js ${NODE_MIN_VERSION}+ first."
fi

NODE_VERSION=$(node -e "console.log(process.version.match(/v(\d+)/)[1])")
if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
  error "Node.js ${NODE_MIN_VERSION}+ required, found v${NODE_VERSION}"
fi
ok "Node.js v$(node -v)"

# --- Check npm ---
if ! command -v npm &> /dev/null; then
  error "npm not found"
fi
ok "npm $(npm -v)"

# --- Create directories ---
info "Creating directories..."
mkdir -p "$INSTALL_DIR" "$DATA_DIR/backups"
ok "Install dir: $INSTALL_DIR"
ok "Data dir: $DATA_DIR"

# --- Download/Copy server files ---
info "Installing server..."

# If running from local repo, copy files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

if [ -d "$REPO_ROOT/server" ]; then
  # Local deployment
  cp -r "$REPO_ROOT/server/"* "$INSTALL_DIR/"
  ok "Copied from local repo"
else
  # Remote deployment - clone from git
  if command -v git &> /dev/null; then
    git clone --depth 1 https://github.com/dingdadao/Mnemosyne.git /tmp/mnemosyne-clone 2>/dev/null || true
    if [ -d /tmp/mnemosyne-clone/server ]; then
      cp -r /tmp/mnemosyne-clone/server/* "$INSTALL_DIR/"
      rm -rf /tmp/mnemosyne-clone
      ok "Cloned from git"
    else
      error "Failed to fetch server files. Place the repo locally and re-run."
    fi
  else
    error "git not found. Install git or run from local repo."
  fi
fi

# --- Install dependencies ---
info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --production 2>&1 | tail -5
ok "Dependencies installed"

# --- Build better-sqlite3 if needed ---
info "Checking better-sqlite3..."
node -e "require('better-sqlite3')" 2>/dev/null || {
  warn "better-sqlite3 needs native build..."
  npm rebuild better-sqlite3 2>&1 | tail -3
}
ok "better-sqlite3 ready"

# --- Create systemd service ---
info "Setting up systemd service..."

cat > /etc/systemd/system/mnemosyne.service << EOF
[Unit]
Description=Mnemosyne — Centralized Memory Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=$(which node) $INSTALL_DIR/index.js --port $PORT --host 0.0.0.0 --data-dir $DATA_DIR
Restart=always
RestartSec=5
Environment=MNEMOSYNE_DATA_DIR=$DATA_DIR
Environment=MNEMOSYNE_PORT=$PORT

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mnemosyne.service
systemctl start mnemosyne.service

sleep 2

if systemctl is-active --quiet mnemosyne.service; then
  ok "Service started: mnemosyne.service"
else
  error "Service failed to start. Check: journalctl -u mnemosyne.service"
fi

# --- Get token ---
TOKEN_FILE="$DATA_DIR/.token"
if [ -f "$TOKEN_FILE" ]; then
  TOKEN=$(cat "$TOKEN_FILE")
else
  warn "Token file not found, server may still be starting..."
  sleep 3
  TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null || echo "CHECK_MANUALLY")
fi

# --- Health check ---
info "Health check..."
sleep 2
HEALTH=$(curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/health" 2>/dev/null || echo '{"status":"unknown"}')

# --- Summary ---
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                  ✓ Mnemosyne Deployed!                        ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Endpoint:  http://0.0.0.0:$PORT                              "
echo "║  Auth:      Bearer $TOKEN"
echo "║  Data:      $DATA_DIR                                         "
echo "║  Service:   systemctl {start|stop|restart} mnemosyne          "
echo "║  Logs:      journalctl -u mnemosyne -f                        "
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  DSH Plugin Config (add to cordis.patch.yml):                 "
echo "║                                                               "
echo "║  - insert:                                                    "
echo "║      - id: mnemosyne                                          "
echo "║        name: 'dsh-mnemosyne'                                  "
echo "║        config:                                                "
echo "║          mnemosyneUrl: 'http://$(hostname -I | awk '{print $1}'):$PORT'"
echo "║          mnemosyneToken: '$TOKEN'                             "
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
