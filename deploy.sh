#!/bin/bash
# ============================================================
# deploy.sh  —  One-shot deploy (Ubuntu + systemd)
# Usage: bash deploy.sh
# ============================================================
set -e

DEPLOY_USER="${SUDO_USER:-$USER}"
INSTALL_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="sol-ema-monitor"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "========================================="
echo " SOL EMA Monitor — Deploy (systemd)"
echo "========================================="
echo " User : $DEPLOY_USER"
echo " Dir  : $INSTALL_DIR"
echo "========================================="

# ── 1. Node.js ───────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  echo "[1/5] Installing Node.js 18..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/5] Node.js $(node -v) already installed"
fi
NODE_BIN="$(command -v node)"

# ── 2. npm dependencies ───────────────────────────────────────
echo "[2/5] Installing npm dependencies..."
npm install --production

# ── 3. .env ──────────────────────────────────────────────────
if [ ! -f "$INSTALL_DIR/.env" ]; then
  echo "[3/5] Creating .env from template..."
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo ""
  echo "  ⚠️  Edit .env and set your API keys before starting:"
  echo "  nano $INSTALL_DIR/.env"
  echo ""
else
  echo "[3/5] .env exists — skipping"
fi

# ── 4. Directories ────────────────────────────────────────────
mkdir -p "$INSTALL_DIR/logs" "$INSTALL_DIR/data"
chown -R "$DEPLOY_USER":"$DEPLOY_USER" "$INSTALL_DIR/logs" "$INSTALL_DIR/data" 2>/dev/null || true
echo "[4/5] Created logs/ and data/"

# ── 5. systemd unit ───────────────────────────────────────────
echo "[5/5] Installing systemd service..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=SOL EMA Monitor — Solana EMA9/EMA20 Strategy Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${DEPLOY_USER}
Group=${DEPLOY_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} src/index.js
Restart=on-failure
RestartSec=5s
StartLimitIntervalSec=60s
StartLimitBurst=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 2
echo ""
sudo systemctl status "$SERVICE_NAME" --no-pager -l || true

# ── Done ──────────────────────────────────────────────────────
echo ""
echo "========================================="
echo " ✅ Deploy complete!"
echo "========================================="
SERVER_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || echo 'YOUR_IP')
PORT=$(grep -E '^PORT=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d '"' || echo '3001')
echo " Dashboard : http://${SERVER_IP}:${PORT}"
echo " Webhook   : POST http://localhost:${PORT}/webhook/add-token"
echo ""
echo " Commands:"
echo "   sudo systemctl status  ${SERVICE_NAME}"
echo "   sudo systemctl restart ${SERVICE_NAME}"
echo "   sudo systemctl stop    ${SERVICE_NAME}"
echo "   sudo journalctl -u ${SERVICE_NAME} -f"
echo "   sudo journalctl -u ${SERVICE_NAME} --since '1h ago'"
echo "========================================="
