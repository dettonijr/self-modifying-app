#!/usr/bin/env bash
# Resets the game: deletes the data volume (Run store, platform services' data,
# the Canvas repo and its history) and starts the platform again with the starter Canvas.
# Usage: scripts/reset-game.sh [--yes]
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "${1:-}" != "--yes" && "${1:-}" != "-y" ]]; then
  echo "This deletes every Run, all Canvas history and all platform service data."
  read -r -p "Reset the game? [y/N] " answer
  [[ "$answer" == "y" || "$answer" == "Y" ]] || { echo "Cancelled."; exit 1; }
fi

docker compose down --volumes
docker compose up --detach --build

echo "Waiting for the Console..."
for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://localhost:${CONSOLE_PORT:-3000}"; then
    echo "Game reset. Console: http://localhost:${CONSOLE_PORT:-3000}  Canvas: http://localhost:${CANVAS_PORT:-3001}"
    exit 0
  fi
  sleep 1
done
echo "The platform didn't answer within 60 seconds; check 'docker compose logs platform'." >&2
exit 1
