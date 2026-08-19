#!/bin/sh
set -eu
install -d -o root -g "${NURSEAID_AGENT_UID:-65532}" -m 2770 /run/nurseaid-compose
exec python3 /opt/nurseaid-collector/collector.py