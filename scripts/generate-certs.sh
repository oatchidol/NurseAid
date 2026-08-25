#!/bin/bash
# generate-certs.sh — สร้าง self-signed TLS certificate สำหรับ NurseAid
#
# Usage:
#   scripts/generate-certs.sh [HOSTNAME]
#
# ถ้าไม่ระบุ HOSTNAME จะใช้ hostname ของเครื่อง + IP ทั้งหมด
# Certificate อายุ 10 ปี เก็บที่ nginx/certs/

set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/nginx/certs"
CERT_FILE="$CERT_DIR/nurseaid.crt"
KEY_FILE="$CERT_DIR/nurseaid.key"
DAYS=3650  # 10 years

# --- Hostname / IP discovery ---
HOSTNAME_ARG="${1:-$(hostname)}"

# Collect all local IPs
LOCAL_IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true)

echo "╔════════════════════════════════════════════════╗"
echo "║  NurseAid — Self-Signed Certificate Generator  ║"
echo "╚════════════════════════════════════════════════╝"
echo ""

# --- Build SAN (Subject Alternative Names) ---
SAN="DNS:${HOSTNAME_ARG},DNS:localhost"
IP_INDEX=1
for ip in $LOCAL_IPS; do
    SAN="${SAN},IP:${ip}"
    IP_INDEX=$((IP_INDEX + 1))
done
# Always include 127.0.0.1
SAN="${SAN},IP:127.0.0.1"

echo "  Hostname:    $HOSTNAME_ARG"
echo "  Local IPs:   $(echo $LOCAL_IPS | tr '\n' ' ')"
echo "  SAN:         $SAN"
echo "  Valid for:   $DAYS days ($(( DAYS / 365 )) years)"
echo "  Output:      $CERT_DIR/"
echo ""

# --- Create output directory ---
mkdir -p "$CERT_DIR"

# --- Check if certs already exist ---
if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    EXPIRY=$(openssl x509 -enddate -noout -in "$CERT_FILE" 2>/dev/null | cut -d= -f2)
    echo "⚠️  Certificates already exist (expires: $EXPIRY)"
    echo "    Overwrite? (y/N)"
    read -r REPLY
    if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
        echo "    Keeping existing certificates."
        exit 0
    fi
fi

# --- Generate self-signed certificate ---
openssl req -x509 -nodes -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -days "$DAYS" \
    -subj "/CN=${HOSTNAME_ARG}/O=NurseAid/OU=IoT Healthcare" \
    -addext "subjectAltName=${SAN}" \
    -addext "basicConstraints=CA:FALSE" \
    -addext "keyUsage=digitalSignature,keyEncipherment" \
    -addext "extendedKeyUsage=serverAuth" \
    2>/dev/null

# --- Set permissions ---
chmod 644 "$CERT_FILE"
chmod 600 "$KEY_FILE"

echo "✅ Certificates generated successfully!"
echo ""
echo "  Certificate: $CERT_FILE"
echo "  Private Key: $KEY_FILE"
echo ""

# --- Show certificate info ---
echo "--- Certificate Details ---"
openssl x509 -in "$CERT_FILE" -noout \
    -subject -issuer -dates -ext subjectAltName 2>/dev/null
echo ""

echo "📋 Next steps:"
echo "   1. docker compose up -d --build"
echo "   2. เปิด https://$(echo $LOCAL_IPS | awk '{print $1}')/"
echo "   3. Browser จะเตือน — กด 'Advanced' → 'Proceed' เพื่อ trust cert"
echo ""
echo "   💡 เพื่อไม่ให้เตือนอีก: download $CERT_FILE"
echo "      แล้ว import เป็น Trusted CA ที่ browser/device"
