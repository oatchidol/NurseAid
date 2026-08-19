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
RUN apk add --no-cache curl tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && \
    echo $TZ > /etc/timezone

WORKDIR /app

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy node_modules and source files from builder
COPY --chown=appuser:appgroup --from=builder /build/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json package-lock.json ./
COPY --chown=appuser:appgroup server.js ./
COPY --chown=appuser:appgroup live-status.js ./

# Expose port
EXPOSE 3333

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:3333/health || exit 1

# Run as non-root user
USER appuser

# Start the application
CMD ["node", "server.js"]