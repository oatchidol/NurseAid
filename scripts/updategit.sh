#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/root/NurseAid"
BACKUP_ROOT="/root"
BRANCH="main"
REMOTE="origin"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${BACKUP_ROOT}/NurseAid-backup-${TIMESTAMP}"

echo "========================================"
echo " NurseAid Update Script"
echo "========================================"
echo "App     : ${APP_DIR}"
echo "Backup  : ${BACKUP_DIR}"
echo "Branch  : ${REMOTE}/${BRANCH}"
echo

# --------------------------------------------------
# 1. ตรวจสอบ directory
# --------------------------------------------------
if [ ! -d "${APP_DIR}/.git" ]; then
    echo "ERROR: ${APP_DIR} ไม่ใช่ Git repository"
    exit 1
fi

cd "${APP_DIR}"

# --------------------------------------------------
# 2. Backup repository ปัจจุบันทั้งหมด
# --------------------------------------------------
echo "[1/8] Backup current NurseAid..."

cp -a "${APP_DIR}" "${BACKUP_DIR}"

echo "Backup completed:"
echo "${BACKUP_DIR}"
echo

# --------------------------------------------------
# 3. Backup .env แยกไว้
# --------------------------------------------------
ENV_BACKUP=""

if [ -f "${APP_DIR}/.env" ]; then
    ENV_BACKUP="/root/NurseAid-env-${TIMESTAMP}.backup"

    echo "[2/8] Backup .env..."
    cp -a "${APP_DIR}/.env" "${ENV_BACKUP}"

    echo ".env backup:"
    echo "${ENV_BACKUP}"
else
    echo "[2/8] No .env found, skipping..."
fi

echo

# --------------------------------------------------
# 4. ดึงข้อมูลล่าสุดจาก GitHub
# --------------------------------------------------
echo "[3/8] Fetching ${REMOTE}/${BRANCH}..."

git fetch "${REMOTE}" "${BRANCH}"

echo
echo "Current HEAD:"
git log -1 --oneline HEAD

echo
echo "Remote HEAD:"
git log -1 --oneline "${REMOTE}/${BRANCH}"

echo

# --------------------------------------------------
# 5. Reset ให้ตรงกับ GitHub
# --------------------------------------------------
echo "[4/8] Resetting repository to ${REMOTE}/${BRANCH}..."

git reset --hard "${REMOTE}/${BRANCH}"

# --------------------------------------------------
# 6. ลบไฟล์ untracked/ignored เก่า
# --------------------------------------------------
echo "[5/8] Cleaning old untracked files..."

git clean -fdx

# --------------------------------------------------
# 7. Restore .env
# --------------------------------------------------
echo "[6/8] Restoring .env..."

if [ -n "${ENV_BACKUP}" ] && [ -f "${ENV_BACKUP}" ]; then
    cp -a "${ENV_BACKUP}" "${APP_DIR}/.env"
    chmod 600 "${APP_DIR}/.env"
    echo ".env restored"
else
    echo "No .env backup to restore"
fi

echo

# --------------------------------------------------
# 8. Validate + Docker rebuild
# --------------------------------------------------
echo "[7/8] Validating Docker Compose..."

cd "${APP_DIR}"

docker compose config >/dev/null

echo "Docker Compose config OK"
echo

echo "[8/8] Building and starting services..."

docker compose build
docker compose up -d

echo
echo "========================================"
echo " Docker status"
echo "========================================"

docker compose ps

echo
echo "Waiting briefly for services..."
sleep 5

echo
echo "========================================"
echo " Health checks"
echo "========================================"

echo -n "NurseAid App : "
curl -fsS --max-time 10 http://127.0.0.1:3333/health || echo "FAILED"

echo
echo -n "InfluxDB     : "
curl -fsS --max-time 10 http://127.0.0.1:8086/health || echo "FAILED"

echo
echo
echo "========================================"
echo " Update completed"
echo "========================================"

echo "Current version:"
git log -1 --oneline

echo
echo "Backup:"
echo "${BACKUP_DIR}"

if [ -n "${ENV_BACKUP}" ]; then
    echo
    echo ".env backup:"
    echo "${ENV_BACKUP}"
fi

echo
echo "If rollback is required:"
echo "  docker compose down"
echo "  rm -rf ${APP_DIR}"
echo "  cp -a ${BACKUP_DIR} ${APP_DIR}"
echo
