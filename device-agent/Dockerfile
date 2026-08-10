FROM python:3.11-alpine

# Set timezone to Thailand (UTC+7)
ENV TZ=Asia/Bangkok
RUN apk add --no-cache tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

WORKDIR /opt/nurseaid-agent
COPY nurseaid_agent.py ./
RUN chmod 0555 nurseaid_agent.py && mkdir -p /var/lib/nurseaid-agent && chown -R 65532:65532 /var/lib/nurseaid-agent
USER 65532:65532
ENV PYTHONUNBUFFERED=1
HEALTHCHECK --interval=60s --timeout=5s --start-period=90s --retries=3 CMD test -s /var/lib/nurseaid-agent/enrollment-code || python3 -c 'import pathlib,time,sys; p=pathlib.Path("/var/lib/nurseaid-agent/last-heartbeat-success"); sys.exit(0 if p.exists() and time.time()-p.stat().st_mtime < 180 else 1)'
CMD ["python3", "/opt/nurseaid-agent/nurseaid_agent.py"]