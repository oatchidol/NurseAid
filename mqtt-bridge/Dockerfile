FROM python:3.11-slim

# Set timezone to Thailand (UTC+7)
ENV TZ=Asia/Bangkok

# Set working directory
WORKDIR /app

# Install dependencies and timezone data
COPY requirements.txt .
RUN apt-get update && apt-get install -y --no-install-recommends tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone && \
    pip install --no-cache-dir -r requirements.txt && \
    rm -rf /var/lib/apt/lists/*

# Copy application
COPY mqtt_bridge.py .
COPY bridge_healthcheck.py .

# Non-secret runtime knobs only. Credentials (INFLUX_TOKEN, MQTT_PASSWORD,
# MQTT_USER, INFLUX_ORG, INFLUX_BUCKET) intentionally are NOT baked into the
# image: they MUST be supplied at run time (Compose `environment`/`env_file`).
# mqtt_bridge.py refuses to start if a required secret is absent, so a
# misconfigured container fails fast instead of silently using a placeholder.
ENV INFLUX_URL=http://influxdb:8086
ENV MQTT_HOST=mosquitto
ENV MQTT_PORT=1883
ENV MQTT_TOPICS=ble/#
ENV SAVE_INTERVAL=3
ENV VERBOSE_SENSOR_LOGS=false
ENV PYTHONUNBUFFERED=1

# Run application
CMD ["python", "mqtt_bridge.py"]
