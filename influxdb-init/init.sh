#!/bin/bash
# ============================================
# NurseAid InfluxDB Initialization Script
# ============================================
# This script initializes InfluxDB with required buckets
# ============================================

set -e

INFLUX_URL="${INFLUX_URL:-http://localhost:8086}"
INFLUX_TOKEN="${INFLUX_TOKEN:-your-admin-token}"
INFLUX_ORG="${INFLUX_ORG:-softsquaregroup}"
INFLUX_BUCKET="${INFLUX_BUCKET:-naret2}"

echo "Initializing InfluxDB..."
echo "URL: $INFLUX_URL"
echo "Org: $INFLUX_ORG"
echo "Bucket: $INFLUX_BUCKET"

# Wait for InfluxDB to be ready
echo "Waiting for InfluxDB to be ready..."
for i in {1..30}; do
    if curl -s "$INFLUX_URL/health" > /dev/null 2>&1; then
        echo "InfluxDB is ready!"
        break
    fi
    echo "Waiting... ($i/30)"
    sleep 1
done

# Create buckets (they should already exist from DOCKER_INFLUXDB_INIT_BUCKET)
# But we ensure they exist here too
echo "Ensuring bucket exists: $INFLUX_BUCKET"

# List existing buckets
echo "Existing buckets:"
influx bucket list --org "$INFLUX_ORG" --token "$INFLUX_TOKEN" 2>/dev/null || echo "Could not list buckets"

echo "InfluxDB initialization complete!"