#!/usr/bin/env bash
# Use one project, config and directory for start, backup and restore on V1/V2.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_root"
if docker compose version >/dev/null 2>&1; then
  exec docker compose --project-directory "$project_root" -f "$project_root/compose.yaml" -p knowledge-os "$@"
elif command -v docker-compose >/dev/null 2>&1; then
  exec docker-compose --project-directory "$project_root" -f "$project_root/compose.yaml" -p knowledge-os "$@"
else
  printf 'Docker Compose is unavailable. Install a supported version for the host.\n' >&2
  exit 1
fi
