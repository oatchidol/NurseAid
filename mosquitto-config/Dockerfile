FROM eclipse-mosquitto:2.0

# Set timezone to Thailand (UTC+7)
ENV TZ=Asia/Bangkok
RUN apk add --no-cache tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

COPY mosquitto.conf /mosquitto/config/mosquitto.conf
RUN chmod 644 /mosquitto/config/mosquitto.conf
ENTRYPOINT []
CMD ["mosquitto", "-c", "/mosquitto/config/mosquitto.conf"]
