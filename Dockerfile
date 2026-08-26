# Multi-stage build for NurseAid application
# Stage 1: Build stage for server.js (Node.js)
FROM node:18-alpine AS builder

# Set timezone to Thailand (UTC+7)
ENV TZ=Asia/Bangkok
RUN ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

WORKDIR /build

# Copy package files first for better caching
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production && \
    npm cache clean --force

# Stage 2: Production stage for server.js (Node.js)
FROM node:18-alpine

# Set timezone to Thailand (UTC+7)
ENV TZ=Asia/Bangkok
# fluidsynth + soundfont-timgm (small ~6MB General MIDI soundfont) let the app
# render user-uploaded .mid/.midi alert sounds to WAV server-side, so playback
# doesn't depend on the browser having its own MIDI synthesizer (most don't).
RUN apk add --no-cache curl tzdata fluidsynth soundfont-timgm && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

WORKDIR /app

# Create non-root user. UID/GID pinned explicitly (matching what Alpine's
# adduser -S already happened to assign) rather than left to
# adduser/addgroup's "next available system id" default — compose-collector
# (a separate image) needs a stable, known GID to grant this user write
# access to the apply_update_spool volume (see docker-compose.yml /
# ops/nurseaid-compose-collector.py), and an implicit "usually 100/101"
# isn't a contract. Existing volumes (e.g. notification_sounds_data) are
# already owned by uid 100/gid 101, so pinning to those exact values is a
# no-op for current deployments, not a breaking change.
RUN addgroup -S -g 101 appgroup && adduser -S -u 100 -G appgroup appuser

# Copy node_modules and source files from builder
COPY --chown=appuser:appgroup --from=builder /build/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json package-lock.json ./
COPY --chown=appuser:appgroup server.js ./
COPY --chown=appuser:appgroup live-status.js ./

# Per-user uploaded alert sounds live here (volume-mounted so they survive
# container recreation) — owned by appuser upfront since the app runs as
# appuser and writes into it at runtime.
RUN mkdir -p /app/uploads/notification-sounds && chown -R appuser:appgroup /app/uploads

# Expose port
EXPOSE 3333

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3333/health || exit 1

# Run as non-root user
USER appuser

# Start the application
CMD ["node", "server.js"]