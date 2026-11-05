#!/bin/sh
# Pings the wacrm cron endpoints on a fixed interval so automation
# Wait steps and flows keep advancing. Deployed as its own Easypanel
# service (see docs/docker.md); configured entirely through env vars.
set -u

: "${APP_URL:?APP_URL is required, e.g. https://crm.example.com}"
: "${AUTOMATION_CRON_SECRET:?AUTOMATION_CRON_SECRET is required (same value as the app)}"
INTERVAL="${CRON_INTERVAL_SECONDS:-300}"
APP_URL="${APP_URL%/}"

echo "Pinging $APP_URL every ${INTERVAL}s"
while true; do
  for path in /api/automations/cron /api/flows/cron; do
    status=$(curl -s -o /dev/null -w '%{http_code}' --max-time 120 \
      -H "x-cron-secret: $AUTOMATION_CRON_SECRET" "$APP_URL$path")
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) GET $path -> $status"
  done
  sleep "$INTERVAL"
done
