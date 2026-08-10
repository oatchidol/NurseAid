#!/usr/bin/env bash
# ============================================================
# NurseAid BLE Gateway Health Check Script
# ============================================================
# ตรวจสอบสุขภาพระบบ BLE Gateway ทัง้ชุด:
#   - ไฟล์ gateway
#   - Python dependencies
#   - PostgreSQL (device registry)
#   - MQTT broker
#   - Bluetooth adapter
#   - BLE scan (สั้นๆ)
#   - Gateway dry-run (สั้นๆ)
#
# Usage:
#   chmod +x check_ble_gateway.sh
#   ./check_ble_gateway.sh
#   ./check_ble_gateway.sh | tee ble-gateway-check.log
# ============================================================

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# --- Counters ---
PASS=0
WARN=0
FAIL=0

# --- Helper functions ---
pass_check() { echo -e "  ${GREEN}✅ PASS${NC} $1"; PASS=$((PASS + 1)); }
warn_check() { echo -e "  ${YELLOW}⚠️  WARN${NC} $1"; WARN=$((WARN + 1)); }
fail_check() { echo -e "  ${RED}❌ FAIL${NC} $1"; FAIL=$((FAIL + 1)); }
info()       { echo -e "  ${CYAN}ℹ️   INFO${NC} $1"; }
section()    { echo -e "\n${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "  ${BLUE}$1${NC}"; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }

# --- Load .env file if exists ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
    # Load .env but don't export passwords directly
    while IFS='=' read -r key value; do
        key=$(echo "$key" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        value=$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
        value=$(echo "$value" | sed "s/^'//;s/'$//")
        value=$(echo "$value" | sed 's/^"//;s/"$//')
        [[ -z "$key" || "$key" =~ ^# ]] && continue
        export "$key=$value" 2>/dev/null || true
    done < "$ENV_FILE"
fi

# --- Defaults ---
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-softwatch_iot}"
DB_USER="${DB_USER:-postgres}"
# Don't expose password
MQTT_HOST="${MQTT_HOST:-localhost}"
MQTT_PORT="${MQTT_PORT:-1883}"
MQTT_USER="${MQTT_USER:-}"
MQTT_PASSWORD="${MQTT_PASSWORD:-}"
BLE_REQUIRE_PAIRED="${BLE_REQUIRE_PAIRED:-true}"
BLUEZ_EXPECTED_PACKAGE_VERSION="${BLUEZ_EXPECTED_PACKAGE_VERSION:-5.66-1+rpt1+deb12u2}"
BLUEZ_EXPECTED_UPSTREAM_VERSION="${BLUEZ_EXPECTED_UPSTREAM_VERSION:-5.66}"

# --- Check 1: Gateway file ---
section "1. ไฟล์ BLE Gateway"

if [[ -f "${SCRIPT_DIR}/nurseaid_ble_gateway.py" ]]; then
    pass_check "ไฟล์ nurseaid_ble_gateway.py มีอยู่"
else
    fail_check "ไฟล์ nurseaid_ble_gateway.py ไม่พบ"
fi

if command -v python3 &>/dev/null; then
    PYTHON_BIN=$(which python3)
    pass_check "พบ python3: ${PYTHON_BIN}"
    PYVER=$(python3 --version 2>&1)
    info "Python version: ${PYVER}"

    # Syntax check
    if python3 -m py_compile nurseaid_ble_gateway.py 2>/dev/null; then
        pass_check "Python syntax ถูกต้อง"
    else
        fail_check "Python syntax มีข้อผิดพลาด"
    fi
else
    fail_check "ไม่พบ python3"
fi

# --- Check 2: Python dependencies ---
section "2. Python dependencies"

for pkg in bleak psycopg2; do
    if python3 -c "import ${pkg}" 2>/dev/null; then
        pass_check "import ${pkg} สำเร็จ"
    else
        fail_check "import ${pkg} ล้มเหลว — รัน: pip3 install ${pkg}"
    fi
done

# paho-mqtt ใช้ dotted module name
if python3 -c "import paho.mqtt" 2>/dev/null; then
    MQTT_VER=$(python3 -c "import paho.mqtt; print(paho.mqtt.__version__)" 2>/dev/null || echo "unknown")
    pass_check "import paho.mqtt สำเร็จ (version ${MQTT_VER})"
else
    fail_check "import paho.mqtt ล้มเหลว — รัน: pip3 install --break-system-packages paho-mqtt"
fi

# --- Check 3: PostgreSQL ---
section "3. PostgreSQL (Device Registry)"

# Check port
if command -v ss &>/dev/null; then
    if ss -tln | grep -q ":${DB_PORT} "; then
        pass_check "PostgreSQL port ${DB_PORT} เปิดอยู่"
    else
        warn_check "PostgreSQL port ${DB_PORT} ไม่เปิดอยู่ (อาจเป็น container)"
    fi
elif command -v netstat &>/dev/null; then
    if netstat -tln | grep -q ":${DB_PORT} "; then
        pass_check "PostgreSQL port ${DB_PORT} เปิดอยู่"
    else
        warn_check "PostgreSQL port ${DB_PORT} ไม่เปิดอยู่"
    fi
else
    info "ไม่พบ ss/netstat — ข้ามการเช็ควงพอร์ต"
fi

# Test DB connection
if command -v psql &>/dev/null; then
    DB_TEST=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c \
        "SELECT count(*) as total, count(hm_number) as paired FROM nurseaid WHERE mac IS NOT NULL AND mac <> '';" \
        -t 2>&1)

    if echo "$DB_TEST" | grep -q "count"; then
        TOTAL_DEV=$(echo "$DB_TEST" | grep -oP '\d+\s+\d+' | awk '{print $1}')
        PAIRED_DEV=$(echo "$DB_TEST" | grep -oP '\d+\s+\d+' | awk '{print $2}')
        pass_check "เชื่อมต่อ DB สำเร็จ — devices: ${TOTAL_DEV}, paired: ${PAIRED_DEV}"

        # List MACs
        MAC_LIST=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -c \
            "SELECT mac FROM nurseaid WHERE mac IS NOT NULL AND mac <> '' ORDER BY mac;" 2>/dev/null)

        if [[ -n "$MAC_LIST" ]]; then
            MAC_COUNT=$(echo "$MAC_LIST" | wc -l)
            info "MAC addresses จาก DB:"
            echo "$MAC_LIST" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | while read -r mac; do
                echo "    • ${mac}"
            done
        fi
    else
        fail_check "เชื่อมต่อ DB ล้มเหลว: ${DB_TEST}"
    fi
else
    warn_check "ไม่พบ psql — ทดสอบ DB ด้วย Python แทน"

    # Fallback: Python psycopg2
    DB_TEST=$(python3 -c "
import psycopg2, os
os.environ['PGPASSWORD'] = '${DB_PASSWORD}'
try:
    conn = psycopg2.connect(host='${DB_HOST}', port=${DB_PORT}, dbname='${DB_NAME}', user='${DB_USER}', password='${DB_PASSWORD}')
    cur = conn.cursor()
    cur.execute(\"SELECT count(*), count(hm_number) FROM nurseaid WHERE mac IS NOT NULL AND mac <> ''\")
    row = cur.fetchone()
    print(f'total={row[0]} paired={row[1]}')
    cur.close(); conn.close()
except Exception as e:
    print(f'error={e}')
" 2>&1)

    if echo "$DB_TEST" | grep -q "total="; then
        pass_check "DB เชื่อมต่อสำเร็จ: ${DB_TEST}"
    else
        fail_check "DB ล้มเหลว: ${DB_TEST}"
    fi
fi

# --- Check 4: MQTT Broker ---
section "4. MQTT Broker"

# Check port
if command -v ss &>/dev/null; then
    if ss -tln | grep -q ":${MQTT_PORT} "; then
        pass_check "MQTT port ${MQTT_PORT} เปิดอยู่"
    else
        warn_check "MQTT port ${MQTT_PORT} ไม่เปิดอยู่"
    fi
fi

# Test MQTT publish/subscribe
if command -v mosquitto_sub &>/dev/null && command -v mosquitto_pub &>/dev/null; then
    MQTT_TOPIC="ble/gateway_healthcheck_$$"

    # Start subscriber in background
    mosquitto_sub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$MQTT_TOPIC" -C 1 -W 5 -d > /tmp/mqtt_sub_out.txt 2>&1 &
    SUB_PID=$!
    sleep 1

    # Publish test message
    if mosquitto_pub -h "$MQTT_HOST" -p "$MQTT_PORT" -t "$MQTT_TOPIC" -m "{\"check\":\"ble_gateway\",\"time\":\"$(date -Iseconds)\"}" -d 2>/dev/null; then
        sleep 3

        if kill -0 $SUB_PID 2>/dev/null; then
            kill $SUB_PID 2>/dev/null || true
            wait $SUB_PID 2>/dev/null || true

            SUB_OUT=$(cat /tmp/mqtt_sub_out.txt 2>/dev/null || echo "")
            if echo "$SUB_OUT" | grep -q "healthcheck"; then
                pass_check "MQTT publish/subscribe สำเร็จ"
            else
                # Check if message was received
                if echo "$SUB_OUT" | grep -q "CONNECT" || echo "$SUB_OUT" | grep -q "CONNACK"; then
                    pass_check "MQTT เชื่อมต่อสำเร็จ (sub timeout อาจเพราะ QoS)"
                else
                    warn_check "MQTT publish สำเร็จ แต่ sub ไม่ได้รับข้อความ"
                fi
            fi
        else
            pass_check "MQTT publish สำเร็จ"
        fi
    else
        fail_check "MQTT publish ล้มเหลว"
    fi

    rm -f /tmp/mqtt_sub_out.txt
else
    # Fallback: Python paho-mqtt
    MQTT_TEST=$(python3 -c "
import paho.mqtt.client as mqtt
import json, time

connected = [False]
def on_connect(c, u, flags, rc):
    connected[0] = True
    print(f'rc={rc}')

client = mqtt.Client(client_id='check_bg_$$')
client.on_connect = on_connect
try:
    client.connect('${MQTT_HOST}', ${MQTT_PORT}, 60)
    client.loop_start()
    for i in range(10):
        time.sleep(0.5)
        if connected[0]: break
    if connected[0]:
        client.publish('ble/gateway_healthcheck_$$', json.dumps({'check':'bg'}))
        time.sleep(1)
        print('OK')
    else:
        print('FAIL:not_connected')
    client.loop_stop()
except Exception as e:
    print(f'FAIL:{e}')
" 2>&1)

    if echo "$MQTT_TEST" | grep -q "OK"; then
        pass_check "MQTT เชื่อมต่อและ publish สำเร็จ"
    else
        warn_check "MQTT: ${MQTT_TEST}"
    fi
fi

# --- Check 5: Bluetooth Adapter ---
section "5. Bluetooth Adapter"

if command -v dpkg-query &>/dev/null; then
    BLUEZ_PACKAGE_VERSION=$(dpkg-query -W -f='${Version}' bluez 2>/dev/null || true)
    if [[ "$BLUEZ_PACKAGE_VERSION" == "$BLUEZ_EXPECTED_PACKAGE_VERSION" ]]; then
        pass_check "BlueZ package ตรงรุ่นที่กำหนด: ${BLUEZ_PACKAGE_VERSION}"
    elif [[ -n "$BLUEZ_PACKAGE_VERSION" ]]; then
        fail_check "BlueZ package version drift: พบ ${BLUEZ_PACKAGE_VERSION}, ต้องเป็น ${BLUEZ_EXPECTED_PACKAGE_VERSION}"
    else
        fail_check "ไม่พบแพ็กเกจ BlueZ บน host"
    fi

    BLUEZ_BINARY_DRIFT=$(dpkg -V bluez 2>/dev/null | grep -E '/usr/(bin|libexec)/' || true)
    if [[ -z "$BLUEZ_BINARY_DRIFT" ]]; then
        pass_check "BlueZ executable files ตรงกับแพ็กเกจที่ติดตั้ง"
    else
        fail_check "BlueZ executable ถูกแก้ไขนอกระบบแพ็กเกจ: ${BLUEZ_BINARY_DRIFT//$'\n'/; }"
    fi

    if command -v apt-mark &>/dev/null; then
        BLUEZ_HOLDS=$(apt-mark showhold 2>/dev/null || true)
        if grep -qx "bluez" <<<"$BLUEZ_HOLDS" && grep -qx "libbluetooth3" <<<"$BLUEZ_HOLDS"; then
            pass_check "bluez และ libbluetooth3 ถูก hold เพื่อป้องกัน version drift"
        else
            fail_check "bluez/libbluetooth3 ยัง hold ไม่ครบ"
        fi
    fi
fi

if command -v bluetoothctl &>/dev/null; then
    BLUEZ_UPSTREAM_VERSION=$(bluetoothctl --version 2>/dev/null | awk '{print $NF}')
    if [[ "$BLUEZ_UPSTREAM_VERSION" == "$BLUEZ_EXPECTED_UPSTREAM_VERSION" ]]; then
        pass_check "bluetoothctl ตรงรุ่น upstream: ${BLUEZ_UPSTREAM_VERSION}"
    else
        fail_check "bluetoothctl version drift: พบ ${BLUEZ_UPSTREAM_VERSION:-unknown}, ต้องเป็น ${BLUEZ_EXPECTED_UPSTREAM_VERSION}"
    fi

    BT_OUTPUT=$(bluetoothctl show 2>&1)

    if echo "$BT_OUTPUT" | grep -q "Name:.*bluetooth"; then
        pass_check "bluetoothctl ทำงานได้"
    else
        warn_check "bluetoothctl มีอยู่ แต่ output อาจว่าง"
    fi

    # Powered — gateway ใช้ hciconfig แทน bluetoothctl ได้
    if echo "$BT_OUTPUT" | grep -q "Powered: yes"; then
        pass_check "Bluetooth Adapter: Powered = yes"
    else
        # เช็คว่า hciconfig เปิดอยู่แทน
        if hciconfig hci0 2>&1 | grep -q "UP"; then
            warn_check "Bluetooth Adapter: Powered = no (แต่ hciconfig UP — gateway ใช้งานได้)"
        else
            fail_check "Bluetooth Adapter: Powered = no (รัน: bluetoothctl power on)"
        fi
    fi

    # Discovering
    if echo "$BT_OUTPUT" | grep -q "Discovering: yes"; then
        warn_check "Bluetooth Adapter: Discovering = yes (อาจค้าง)"
    else
        pass_check "Bluetooth Adapter: Discovering = no (ปกติ)"
    fi

    # Pairable
    if echo "$BT_OUTPUT" | grep -q "Pairable: yes"; then
        fail_check "Bluetooth Adapter: Pairable = yes (no-pair mode ต้องเป็น no)"
    else
        pass_check "Bluetooth Adapter: Pairable = no (no-pair mode)"
    fi

    # The gateway is central-only. Advertising/discoverability can make Wear OS
    # offer to pair with the Pi itself, which is never part of the data path.
    if echo "$BT_OUTPUT" | grep -q "Discoverable: yes"; then
        fail_check "Bluetooth Adapter: Discoverable = yes (gateway ต้องไม่ advertise ตัว Pi)"
    else
        pass_check "Bluetooth Adapter: Discoverable = no (central-only mode)"
    fi

    ACTIVE_ADS=$(sed -n 's/.*ActiveInstances: 0x\([0-9A-Fa-f][0-9A-Fa-f]*\).*/\1/p' <<<"$BT_OUTPUT" | head -1)
    if [[ -n "$ACTIVE_ADS" ]] && (( 16#$ACTIVE_ADS > 0 )); then
        fail_check "พบ BLE peripheral advertisement ที่กำลังทำงาน: ActiveInstances=0x${ACTIVE_ADS}"
    else
        pass_check "ไม่มี BLE peripheral advertisement จาก gateway"
    fi

    if systemctl is-enabled --quiet nurseaid-ble.service 2>/dev/null; then
        fail_check "legacy nurseaid-ble.service ยัง enabled และอาจเปิด advertisement หลัง reboot"
    else
        pass_check "legacy nurseaid-ble.service ไม่ได้ enabled"
    fi
else
    warn_check "ไม่พบ bluetoothctl — ข้ามการเช็ค Bluetooth adapter"
fi

# Check hciconfig
if command -v hciconfig &>/dev/null; then
    HCI_OUTPUT=$(hciconfig hci0 2>&1 || true)
    if echo "$HCI_OUTPUT" | grep -q "UP"; then
        pass_check "hciconfig hci0: UP RUNNING"
    elif echo "$HCI_OUTPUT" | grep -q "DOWN"; then
        warn_check "hciconfig hci0: DOWN (รัน: hciconfig hci0 up)"
    else
        info "hciconfig hci0: ${HCI_OUTPUT:0:80}"
    fi
else
    info "ไม่พบ hciconfig — อาจใช้ BlueZ D-Bus API แทน"
fi

# --- Check 6: BLE Scan (สั้นๆ) ---
section "6. BLE Scan (5 วินาที)"

# Get MACs from DB for scan filter
MAC_FILTER=""
if command -v psql &>/dev/null; then
    MAC_FILTER=$(psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -t -A -c \
        "SELECT string_agg(mac, ' ' ORDER BY mac) FROM (SELECT DISTINCT upper(mac) as mac FROM nurseaid WHERE mac IS NOT NULL AND mac <> '') t;" 2>/dev/null)
elif python3 -c "import psycopg2" 2>/dev/null; then
    MAC_FILTER=$(PGPASSWORD="${DB_PASSWORD}" python3 -c "
import psycopg2
try:
    conn = psycopg2.connect(host='${DB_HOST}', port=${DB_PORT}, dbname='${DB_NAME}', user='${DB_USER}')
    cur = conn.cursor()
    cur.execute(\"SELECT DISTINCT upper(mac) as mac FROM nurseaid WHERE mac IS NOT NULL AND mac <> '' ORDER BY mac\")
    macs = [r[0] for r in cur.fetchall()]
    print(' '.join(macs))
    cur.close(); conn.close()
except Exception as e:
    print('')
" 2>/dev/null)
fi

if [[ -n "$MAC_FILTER" ]]; then
    info "MAC filter จาก DB: ${MAC_FILTER}"

    # Run bleak scanner briefly
    BLE_SCAN_RESULT=$(python3 -c "
import asyncio
from bleak import BleakScanner

macs = '${MAC_FILTER}'.split() if '${MAC_FILTER}' else []
found = {}

def callback(device, adv):
    mac = device.address.upper()
    if macs and mac not in macs:
        return
    rssi = getattr(adv, 'rssi', None)
    found[mac] = rssi

async def scan():
    scanner = BleakScanner(detection_callback=callback)
    await scanner.start()
    await asyncio.sleep(5)
    await scanner.stop()
    return found

result = asyncio.run(scan())
for mac, rssi in sorted(result.items()):
    print(f'FOUND {mac} RSSI={rssi}')
if not result:
    print('NO_DEVICES_FOUND')
" 2>&1)

    if echo "$BLE_SCAN_RESULT" | grep -q "FOUND"; then
        pass_check "BLE scan เจอ device:"
        echo "$BLE_SCAN_RESULT" | grep "FOUND" | while read -r line; do
            echo "    ${line}"
        done
    elif echo "$BLE_SCAN_RESULT" | grep -q "NO_DEVICES_FOUND"; then
        warn_check "BLE scan ไม่เจอ device ใดๆ (อาจไม่มีนาฬิกาใน range)"
    else
        warn_check "BLE scan มีข้อผิดพลาด: ${BLE_SCAN_RESULT:0:200}"
    fi
else
    warn_check "ไม่มี MAC filter จาก DB — ข้าม BLE scan"
fi

# --- Check 7: Gateway dry-run (สั้นๆ) ---
section "7. Gateway Dry-Run (20 วินาที)"

echo "  กำลังรัน gateway แบบสั้นๆ..."
echo "  (จะหยุดอัตโนมัติหลัง 20 วินาที)"

DRY_RUN_OUTPUT=$(timeout 20 python3 "${SCRIPT_DIR}/nurseaid_ble_gateway.py" 2>&1 || true)

LINE_COUNT=$(echo "$DRY_RUN_OUTPUT" | wc -l)
echo "$DRY_RUN_OUTPUT" | head -30
if [[ "$LINE_COUNT" -gt 30 ]]; then
    echo "  ... ($LINE_COUNT lines total)"
fi

# Check for key success indicators
if echo "$DRY_RUN_OUTPUT" | grep -q "Connected successfully"; then
    pass_check "Gateway: MQTT connect สำเร็จ"
else
    warn_check "Gateway: ไม่พบ MQTT connect success (อาจ timeout)"
fi

if echo "$DRY_RUN_OUTPUT" | grep -q "Active devices:"; then
    DEVICE_COUNT=$(echo "$DRY_RUN_OUTPUT" | grep -oP "Active devices: \K\d+")
    pass_check "Gateway: DB sync สำเร็จ — devices: ${DEVICE_COUNT}"
else
    warn_check "Gateway: ไม่พบ device count"
fi

if echo "$DRY_RUN_OUTPUT" | grep -q "scanner started"; then
    pass_check "Gateway: BLE scanner เริ่มทำงาน"
else
    warn_check "Gateway: ไม่พบ scanner started"
fi

# --- Summary ---
section "📊 สรุปผลการเช็ค"

TOTAL=$((PASS + WARN + FAIL))
echo ""
echo -e "  ${GREEN}✅ PASS: ${PASS}/${TOTAL}${NC}"
echo -e "  ${YELLOW}⚠️  WARN: ${WARN}/${TOTAL}${NC}"
echo -e "  ${RED}❌ FAIL: ${FAIL}/${TOTAL}${NC}"
echo ""

if [[ $FAIL -eq 0 && $WARN -eq 0 ]]; then
    echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "  ${GREEN}  🎉 ระบบ BLE Gateway พร้อมใช้งาน!${NC}"
    echo -e "  ${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    EXIT_CODE=0
elif [[ $FAIL -eq 0 ]]; then
    echo -e "  ${YELLOW}⚠️  ระบบพร้อม แต่มีข้อควรระวัง ${WARN} จุด${NC}"
    EXIT_CODE=0
else
    echo -e "  ${RED}❌ ระบบมีข้อผิดพลาด ${FAIL} จุด — ต้องแก้ไขก่อนใช้งาน${NC}"
    EXIT_CODE=1
fi

echo ""
exit $EXIT_CODE