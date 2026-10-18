#!/usr/bin/env bash
# Run the standalone initializer with the same Python image as the application.
# No Python installation or package-manager change on the host is required.
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
base_image="$(awk '$1 == "FROM" {print $2; exit}' "$project_root/Dockerfile")"
if [[ -z "$base_image" ]]; then
  printf 'No application base image found in Dockerfile.\n' >&2
  exit 1
fi
exec docker run --rm --network none --user 0:0 --cap-drop ALL \
  --security-opt no-new-privileges:true --read-only --tmpfs /tmp \
  --env PYTHONDONTWRITEBYTECODE=1 --volume "$project_root:/workspace:z" \
  --entrypoint python "$base_image" /workspace/deploy/init_secrets.py "$@"
