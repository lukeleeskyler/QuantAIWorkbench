#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f api_keys.env ] && [ -f api_keys.env.example ]; then
  cp api_keys.env.example api_keys.env
fi

if command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="python3"
elif command -v python >/dev/null 2>&1; then
  PYTHON_BIN="python"
else
  echo "Python 3.9+ is required."
  exit 1
fi

"$PYTHON_BIN" - <<'PY'
import sys
if sys.version_info < (3, 9):
    raise SystemExit("Python 3.9+ is required. Current version: " + sys.version.split()[0])
PY

"$PYTHON_BIN" server.py "${QUANT_AI_PORT:-8787}"
