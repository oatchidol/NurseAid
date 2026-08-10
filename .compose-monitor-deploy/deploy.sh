#!/bin/sh
set -e
cd /root/nurseaid
docker compose build device-agent mosquitto mqtt-bridge
docker compose up -d --no-deps mosquitto mqtt-bridge device-agent
for i in $(seq 1 80); do
  good=1
  for c in nurseaid-mosquitto nurseaid-mqtt-bridge nurseaid-device-agent; do
    [ "$(docker inspect -f "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}" "$c" 2>/dev/null)" = healthy ] || good=0
  done
  [ "$good" = 1 ] && exit 0
  sleep 3
done
exit 1
