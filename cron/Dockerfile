# Tiny scheduler for wacrm: calls /api/automations/cron and
# /api/flows/cron every CRON_INTERVAL_SECONDS (default 300).
# Required env: APP_URL, AUTOMATION_CRON_SECRET.
FROM alpine:3.20
RUN apk add --no-cache curl ca-certificates
COPY run.sh /run.sh
# Strip CRLF in case the script was checked out on Windows.
RUN sed -i 's/\r$//' /run.sh && chmod +x /run.sh
CMD ["/run.sh"]
