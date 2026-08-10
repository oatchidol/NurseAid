# 🏥 NurseAid Docker Container System - Raspberry Pi 5

## ภาพรวม

ระบบ NurseAid คือระบบมอนิเตอรสญาณชพีคนไขแบบ Real-time ที่ตดิตัง้บน Raspberry Pi 5 ดวย Docker Container

**องคประกอบ:**
- **NurseAid App** - Node.js/Express Application (Port 3333)
- **PostgreSQL** - ฐานขอมูลหลัก (Port 5432)
- **InfluxDB** - ฐานขอมูล Time-series (Port 8086)
- **LINE Bot** - แจงเตือนผาน LINE (External)

---

## ความตองการระบบ

### Raspberry Pi 5
- **CPU**: Raspberry Pi 5 (4GB RAM ขึ้นไป)
- **Storage**: microSD 32GB ขึ้นไป
- **OS**: Raspberry Pi OS (64-bit) หรือ Ubuntu 22.04+
- **Network**: LAN connection

### Software
- Docker 20.10+
- Docker Compose v2

---

## ขันตอนการติดตัง้

### 1. ติดตัง้ Docker และ Docker Compose

```bash
# ติดตัง้ Docker
curl -fsSL https://get.docker.com | sh

# เพิ่มผใชเข้ากลุม docker
sudo usermod -aG docker $USER
newgrp docker

# ตรวจสอบการติดตัง้
docker --version
docker compose version
```

### 2. สรางโฟลเดอรและคัดลอกไฟล

```bash
# สรางโฟลเดอร
mkdir -p /root/nurseaid && cd /root/nurseaid

# คัดลอกไฟลทั้งหมดไป
# (จากคอมพิวเตอรหลัก)
scp -r nurseaid/ root@172.16.251.45:/root/

# หรือ SSH ไปแล้ว clone จาก git
git clone <repo-url> /root/nurseaid
```

### 3. ตั้งคา Environment Variables

```bash
# คัดลอก .env.example เปน .env
cp .env.example .env

# แก้ไขคาใน .env
nano .env
```

### ไฟล .env ที่ตองแกไข:

```env
# PostgreSQL
DB_PASSWORD=your-strong-database-password
SESSION_SECRET=generate-with-openssl-rand-hex-32
INITIAL_ADMIN_PASSWORD=your-strong-initial-admin-password

# InfluxDB
INFLUX_TOKEN=your-influxdb-admin-token
INFLUX_ORG=softsquaregroup
INFLUX_BUCKET=naret2
INFLUX_ADMIN_PASSWORD=your-strong-influx-password

# LINE Bot (หากตองการใช LINE notification)
LINE_TOKEN=your-line-bot-token-here
```

### 4. Build และรันระบบ

```bash
# เข้าไปโฟลเดอรโปรเจค
cd /root/nurseaid

# Build และรัน
docker compose up -d

# ตรวจสอบสถานะ
docker compose ps

# ดู logs
docker compose logs -f
```

### 5. ตรวจสอบการรัน

```bash
# ตรวจสอบทุก container
docker compose ps

# ตรวจสอบ NurseAid app
docker logs nurseaid-app

# ตรวจสอบ PostgreSQL
docker logs nurseaid-postgres

# ตรวจสอบ InfluxDB
docker logs nurseaid-influxdb
```

---

## การใช้งาน

### เข้าถง Web Application

```
http://172.16.251.45:3333
```

### Login ครังแรก

```
Username: ค่าจาก INITIAL_ADMIN_USERNAME (ค่าเริ่มต้น admin)
Password: ค่าจาก INITIAL_ADMIN_PASSWORD ตอนติดตั้งฐานข้อมูลใหม่
```

### บริการที่ใชงานได

| บริการ | URL | Port |
|--------|-----|------|
| NurseAid Web App | http://172.16.251.45:3333 | 3333 |
| PostgreSQL | 172.16.251.45:5432 | 5432 |
| InfluxDB | 172.16.251.45:8086 | 8086 |

---

## การ Clone ขอมูล

### Clone ขอมูล PostgreSQL จาก Server ภายนอก

```bash
# Backup PostgreSQL จาก Server ภายนอก
pg_dump -h 172.16.0.64 -U postgres softwatch_iot > backup.sql

# Restore ลง Docker Container
docker cp backup.sql nurseaid-postgres:/backup.sql

# Restore ขอมูล
docker exec -i nurseaid-postgres psql -U postgres -d softwatch_iot < /backup.sql

# ลบไฟล backup
docker exec nurseaid-postgres rm /backup.sql
```

### Clone ขอมูล InfluxDB จาก Server ภายนอก

```bash
# Backup InfluxDB จาก Server ภายนอก
influx backup -t <token> -u http://172.16.0.153:8086 /tmp/influx_backup

# คัดลอกไป Pi
scp -r /tmp/influx_backup root@172.16.251.45:/tmp/

# คัดลอกเข้าไปใน container
docker cp /tmp/influx_backup nurseaid-influxdb:/backup

# Restore ขอมูล
docker exec nurseaid-influxdb influx restore -from /backup -token <token>

# ลบไฟล backup
docker exec nurseaid-influxdb rm -rf /backup
```

---

## การแกไขปญหา

### ปญหา: Container ไมรัน

```bash
# ดู logs
docker compose logs nurseaid

# Restart containers
docker compose restart

# ลบและรันใหม
docker compose down
docker compose up -d
```

### ปญหา: PostgreSQL เชื่อมตอไมได

```bash
# ตรวจสอบ PostgreSQL
docker logs nurseaid-postgres

# เชื่อมต่อ PostgreSQL
docker exec -it nurseaid-postgres psql -U postgres -d softwatch_iot
```

### ปญหา: InfluxDB เชื่อมตอไมได

```bash
# ตรวจสอบ InfluxDB
docker logs nurseaid-influxdb

# ตรวจสอบ API
curl http://localhost:8086/health
```

### ปญหา: Application ไมรัน

```bash
# ดู logs
docker logs nurseaid-app

# เชื่อมต่อ container
docker exec -it nurseaid-app sh

# ตรวจสอบ environment variables
env | grep DB
env | grep INFLUX
```

---

## Auto-start เมื่อ Pi เปิดเครื่อง

```bash
# เปิดใช Docker auto-start
sudo systemctl enable docker

# เพิ่ม cron job
crontab -e

# เพิ่มบรรทัดตอไปนี้
@reboot cd /root/nurseaid && /usr/bin/docker compose up -d
```

---

## การ Backup ขอมูล

### Backup PostgreSQL

```bash
docker exec nurseaid-postgres pg_dump -U postgres softwatch_iot > backup.sql
```

### Backup InfluxDB

```bash
docker exec nurseaid-influxdb influx backup -t <token> -u http://localhost:8086 /backup
docker cp nurseaid-influxdb:/backup /tmp/influx_backup
```

---

## ติดต่อ

หากพบปญหาหรือตองการชวยเหลือ กรุณาติดตอ