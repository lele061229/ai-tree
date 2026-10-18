#!/bin/sh
set -eu
python -m backend.manage migrate
python -m backend.manage bootstrap
exec uvicorn backend.main:create_app --factory --host 0.0.0.0 --port 8000 --workers 1 --no-access-log
