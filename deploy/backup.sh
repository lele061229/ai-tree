#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
destination="backups/knowledge-os-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
temporary="${destination}.partial"
trap 'rm -f "$temporary"' EXIT
bash deploy/compose.sh exec -T db sh -c 'export MYSQL_PWD="$(cat /run/secrets/db_password)"; exec mysqldump --user=knowledge_os --single-transaction --no-tablespaces --set-gtid-purged=OFF --skip-lock-tables knowledge_os' | gzip > "$temporary"
gzip -t "$temporary"
mv "$temporary" "$destination"
printf 'Backup created: %s\n' "$destination"
