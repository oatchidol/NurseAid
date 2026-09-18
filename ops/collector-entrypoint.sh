#!/bin/sh
set -eu
install -d -o root -g "${NURSEAID_AGENT_UID:-65532}" -m 2770 /run/nurseaid-compose

# Prefer the writable repo mount so updater fixes become active after a
# self-restart without requiring the collector image itself to be rebuilt on
# every application release. Keep the packaged copy as a boot-safe fallback.
COLLECTOR_SOURCE="${NURSEAID_COLLECTOR_SOURCE:-/repo/ops/nurseaid-compose-collector.py}"
if [ -r "$COLLECTOR_SOURCE" ]; then
    exec python3 "$COLLECTOR_SOURCE"
fi
exec python3 /opt/nurseaid-collector/collector.py