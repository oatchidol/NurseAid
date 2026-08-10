# Changelog

บันทึกการเปลี่ยนแปลงของ NurseAid ในแต่ละเวอร์ชัน

> **หมายเหตุเรื่องขอบเขต:** โปรเจกต์นี้ไม่มี git history และไม่มี CHANGELOG มาก่อน จึงเริ่มบันทึกอย่างเป็นทางการตั้งแต่ v2.13 เป็นต้นไป เวอร์ชันก่อนหน้า (2.0 – 2.12) ไม่มีบันทึกย้อนหลังที่ยืนยันได้

## [2.14.0] - 2026-08-10

### Changed
- ปรับโครงสร้าง RBAC (Role-Based Access Control) ใหม่ทั้งระบบ พร้อมแก้ไขบั๊กที่พบหลังเปิดใช้งานจริง 5 รายการ
- Ward-scoping ของผู้ป่วยและอุปกรณ์: `patients.ward_id` เป็นแหล่งข้อมูลหลัก (source of truth) สำหรับ ward ของผู้ป่วย และ ward ของอุปกรณ์จะ sync อัตโนมัติตอน pairing กับผู้ป่วย
- แก้บั๊ก nginx trust-proxy — เพิ่มการตั้งค่า `trust proxy` ทำให้คำขอ (request) แบบ non-GET ที่เข้าผ่านโดเมน `https://nurseaid.softsquaregroup.com` (ผ่าน nginx reverse proxy) ไม่ถูกปฏิเสธด้วย 403 "Invalid request origin" อีกต่อไป
- อัปเดตเลขเวอร์ชันที่แสดงในหน้า UI (sidebar และหน้า login) จาก v2.12 เป็น v2.14

### Known issues / Notes
- ผู้ป่วยที่สร้างไว้ก่อนหน้านี้ยังอยู่ใน ward ตั้งต้น "Unassigned" ต้องย้าย ward ให้ถูกต้องด้วยมือ (manual re-assignment)

## [2.13.0] - 2026-08-05

### Added
- เพิ่มโหมด **Slave Station** สำหรับการเชื่อมต่อแบบ Master (Raspberry Pi) <--> Multi Slave (ESP32 BLE mode)
  - เชื่อมต่อนาฬิกา (devices) ได้จำนวนมากขึ้น
  - โยน device ข้าม Slave station ได้
  - เพิ่มเสถียรภาพมากขึ้น ~60%
  - อุปกรณ์ Slave Station ใช้ MicroComputer แบบ Arduino
- รองรับ Client ได้ประมาณ 10 devices ต่อ station

### Limitations
- รองรับเฉพาะรุ่น J-style เท่านั้น (ข้อจำกัดของเวอร์ชันนี้)
