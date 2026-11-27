#!/bin/bash
# The quick entry uses the same assertions as the full measurement tool.
set -eu
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
exec node "$SCRIPT_DIR/perf-smoke-test.mjs"
