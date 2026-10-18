#!/usr/bin/env bash
# Restores into a newly created database only. Does not overwrite knowledge_os.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 1 || ! -f "$1" ]]; then
  printf 'Usage: bash deploy/restore_sandbox.sh backups/FILE.sql.gz\n' >&2
  exit 1
fi
gzip -t "$1"
target="restore_$(date -u +%Y%m%d%H%M%S)"
bash deploy/compose.sh exec -T -e RESTORE_DB="$target" db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_root_password)"; exec mysql --user=root --execute="CREATE DATABASE \`$RESTORE_DB\` CHARACTER SET utf8mb4"'
gzip -dc "$1" | bash deploy/compose.sh exec -T -e RESTORE_DB="$target" db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_root_password)"; exec mysql --user=root "$RESTORE_DB"'
bash deploy/compose.sh exec -T -e RESTORE_DB="$target" db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_root_password)"; exec mysql --user=root "$RESTORE_DB" --execute="SELECT COUNT(*) AS route_versions FROM route_versions; SELECT COUNT(*) AS sources FROM source_documents; SELECT COUNT(*) AS nodes FROM knowledge_nodes;"'
printf 'Restore drill completed in separate database: %s\n' "$target"
