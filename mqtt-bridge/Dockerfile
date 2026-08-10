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

# Environment variables (with defaults)
ENV INFLUX_URL=http://influxdb:8086
ENV INFLUX_TOKEN=my-super-secret-auth-token!
ENV INFLUX_ORG=softsquaregroup
ENV INFLUX_BUCKET=naret2
ENV MQTT_HOST=mosquitto
ENV MQTT_PORT=1883
ENV MQTT_USER=nursemon
ENV MQTT_PASSWORD=NewSoft^2
ENV MQTT_TOPICS=ble/#
ENV SAVE_INTERVAL=3
ENV VERBOSE_SENSOR_LOGS=false
ENV PYTHONUNBUFFERED=1

# Run application
CMD ["python", "mqtt_bridge.py"]
