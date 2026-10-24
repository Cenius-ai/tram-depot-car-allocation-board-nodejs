#!/usr/bin/env bash
# Tram Depot — Car Allocation Board
# Installs, migrates and seeds only. It never starts the web server:
# run `node main.js` afterwards (the README two-command quickstart).
set -euo pipefail
cd "$(dirname "$0")"

DEMO_EMAIL="cenius@cenius.ai"
DEMO_PASSWORD="cenius"

echo "==> Tram Depot: install"
if ! command -v node >/dev/null 2>&1; then
  echo "!! Node.js 20+ is required. See INSTALL.md for prerequisites." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt 20 ]; then
  echo "!! Node.js 20+ is required (found $(node -v)). See INSTALL.md." >&2
  exit 1
fi

# No runtime dependencies: this keeps the install phase fast and offline-safe.
# node version advisory (auto-added by cenius)
if command -v node >/dev/null 2>&1; then
  _REQ_NODE="$(node -p "(require('./package.json').engines||{}).node||''" 2>/dev/null || true)"
  [ -n "$_REQ_NODE" ] && echo "-> This app requires Node $_REQ_NODE (you have $(node -v)). If install fails with EBADENGINE, upgrade Node: https://nodejs.org"
fi
npm install --no-audit --no-fund --loglevel=error

echo "==> Seeding the depot store (idempotent, never starts the server)"
node -e '
const { loadStore } = require("./main.js");
const db = loadStore();
console.log(
  "    staff: " + db.staff.length +
  ", routes: " + db.routes.length +
  ", shifts: " + db.shifts.length +
  ", cars: " + db.tramCars.length +
  ", siding slots: " + db.sidingPositions.length +
  ", allocations: " + db.allocations.length +
  ", notices: " + db.notices.length
);
'

echo ""
echo "==> Install complete."
echo "    Demo account — email: ${DEMO_EMAIL}  password: ${DEMO_PASSWORD}"
echo "    Start the board with: node main.js   (then open http://localhost:3000)"
