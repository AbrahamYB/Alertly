#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="$APP_DIR/app.log"

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "Alertly configuration is missing: $APP_DIR/.env" >&2
  echo "Create it from .env.example and keep it readable only by its owner." >&2
  exit 1
fi

if [[ "$(stat -c '%a' .env)" != "600" ]]; then
  echo "Refusing to start: $APP_DIR/.env must have permissions 600." >&2
  exit 1
fi

# This legacy launcher intentionally contains no credentials and does not alter
# the Git remote. Production deployment is managed separately through Docker.
if ! pgrep -u "$(id -u)" -f "node .*server\.js" >/dev/null; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Alertly." >> "$LOG_FILE"
  nohup /usr/bin/node server.js >> "$LOG_FILE" 2>&1 &
fi
