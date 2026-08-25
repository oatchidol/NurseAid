# Changelog

บันทึกการเปลี่ยนแปลงของ NurseAid ในแต่ละเวอร์ชัน

> **หมายเหตุเรื่องขอบเขต:** โปรเจกต์นี้ไม่มี git history และไม่มี CHANGELOG มาก่อน จึงเริ่มบันทึกอย่างเป็นทางการตั้งแต่ v2.13 เป็นต้นไป เวอร์ชันก่อนหน้า (2.0 – 2.12) ไม่มีบันทึกย้อนหลังที่ยืนยันได้

## [Unreleased]

### Added
- เพิ่มระดับความสำคัญ (priority) ของผู้ป่วยที่พยาบาล/แอดมินตั้งค่าเองได้ (สูง/กลาง/ต่ำ) แสดงเป็น badge และเส้นขอบเน้นบนการ์ดผู้ป่วยในหน้า Monitor โดยไม่ปะปนกับสีที่ใช้บอกสถานะสัญญาณชีพ
- เพิ่มความสามารถลากจัดเรียงลำดับการ์ดผู้ป่วยในหน้า Monitor (รองรับทั้งเมาส์และหน้าจอสัมผัส) โดยลำดับจะถูกบันทึกและแสดงผลเหมือนกันสำหรับผู้ใช้ทุกคนที่ดูวอร์ดเดียวกัน

## [2.16.0] - 2026-08-18

> **หมายเหตุ:** รวมงานที่เดิมบันทึกแยกเป็น 2.16.0–2.19.0 (วันเดียวกัน) เข้าเป็นรุ่นเดียว เพื่อให้เลขเวอร์ชันที่ประกาศตรงกับที่ deploy จริง

### Added
- AI Harness v2 แบบ structured JSON output พร้อม evidence registry, deterministic risk classification, evidence binding และ deterministic fallback เมื่อโมเดลหรือผล validation ไม่พร้อมใช้งาน
- output safety validator ป้องกันการลดระดับ Critical/Warning, evidence ID ที่ไม่มีจริง, ตัวเลขที่ไม่มีหลักฐาน, คำสั่งใช้ยา และการยืนยันการวินิจฉัย
- signed conversation token ที่ผูกกับผู้ใช้ ผู้ป่วย และช่วงเวลา แทนการเชื่อถือ chat history จาก browser
- provider retry, circuit breaker, per-user concurrency guard, bounded output และ cleanup ของ in-memory rate-limit buckets
- privacy-safe AI request telemetry และ feedback endpoint ที่เก็บเฉพาะ request ID/user ID/ผล helpful โดยไม่เก็บ prompt, คำตอบ หรือ vital values
- synthetic MedGemma evaluation harness ผ่านคำสั่ง `npm run ai:eval` สำหรับวัด JSON validity, critical/low-quality response และ medication safety โดยไม่ใช้ข้อมูลผู้ป่วยจริง
- modern Clinical AI Workspace พร้อม context pill, segmented period control, structured risk/summary/observation cards, recommended checks, data limitations, expandable evidence, copy summary, feedback และ new conversation action
- intent router ให้ NurseAid AI Assistant รองรับ 4 ขอบเขตหลัก: วิเคราะห์ข้อมูล Monitor, ความรู้สุขภาพทั่วไป, คำแนะนำเกี่ยวกับอาการ/สัญญาณอันตราย และวิธีใช้ NurseAid
- deterministic emergency screening สำหรับข้อความที่กล่าวถึงอาการอันตราย เช่น หมดสติ หายใจไม่ออก เจ็บหน้าอกร่วมกับอาการเสี่ยง อ่อนแรงครึ่งซีก ชัก เลือดออกมาก หรือแพ้รุนแรง โดยบังคับคำแนะนำขอความช่วยเหลือฉุกเฉินและไม่รอ AI
- structured validator แยกสำหรับ health education และ symptom guidance ซึ่งยังคงป้องกันการวินิจฉัยยืนยัน คำสั่งยา และการระบุขนาดยาเฉพาะบุคคล
- workflow help context ที่จำกัดคำตอบตามความสามารถจริงของ NurseAid ได้แก่หน้า Monitor, ช่วงข้อมูลย้อนหลัง, evidence, coverage, Warning/Critical และ off-wrist
- ป้ายประเภทคำตอบใน UI และ suggested prompts สำหรับความรู้สุขภาพทั่วไปกับคำแนะนำเกี่ยวกับอาการ

### Changed
- ปรับ trend analysis เป็น linear-regression slope พร้อม absolute change, confidence, largest data gap และแยก Warning episodes ไม่ให้นับซ้อน Critical episodes
- ปรับ downsampling ให้รักษาจุด Warning/Critical, min/max และจุดก่อน-หลังเหตุการณ์สำคัญไว้ภายใต้ขนาด time-series ที่จำกัด
- ปรับ loading, empty, error, mobile, dark mode, focus, reduced-motion และ accessibility states ของแชตให้เข้าใจง่ายและตอบสนองดีขึ้น
- คำถามสุขภาพทั่วไป เช่น “SpO₂ คืออะไร” สามารถถามได้แม้เลือกผู้ป่วยอยู่ โดยไม่ถูกบังคับให้เป็นการวิเคราะห์ผู้ป่วย
- ปฏิเสธแบบ deterministic เฉพาะคำขอวินิจฉัยยืนยัน/สั่งยา และเรื่องที่ไม่เกี่ยวกับสุขภาพหรือ NurseAid อย่างชัดเจน ส่วนคำถามกำกวมจะเข้าสู่โหมดความรู้สุขภาพทั่วไป
- Signed conversation token ผูกกับ intent เพิ่มเติม ป้องกันนำ history จากคำตอบ Monitor ไปใช้ปะปนกับคำถามสุขภาพทั่วไปหรือ workflow help
- เปลี่ยนคำถามทั่วไปเป็น free conversation mode ให้ MedGemma ตอบข้อความภาษาไทยตามธรรมชาติ โดยไม่บังคับ JSON, risk badge, intent badge, observations, limitations หรือ recommended checks
- ยกเลิก keyword blocking สำหรับเรื่องนอกสุขภาพและยกเลิก deterministic refusal สำเร็จรูป ผู้ใช้สามารถสนทนา ถามความรู้ทั่วไป ขอช่วยคิด เขียน หรือคุยเรื่องอื่นได้ตามปกติ
- ใช้ structured evidence/risk cards เฉพาะเมื่อคำถามระบุชัดว่าให้วิเคราะห์ผู้ป่วย เตียง ค่าล่าสุด แนวโน้ม หรือข้อมูลย้อนหลังจาก Monitor
- ปรับ welcome state และ suggested prompts ให้สื่อว่าเป็น AI สนทนาทั่วไปที่สามารถวิเคราะห์ Monitor พร้อมหลักฐานได้เมื่อร้องขอ
- ถอด system prompt ออกจาก free conversation mode ทั้งหมด ไม่บังคับภาษา บุคลิก น้ำเสียง ความยาว รูปแบบ หัวข้อ หรือข้อจำกัดด้านเนื้อหาคำตอบ ส่งให้โมเดลเฉพาะ conversation history ที่ลงลายเซ็นและข้อความผู้ใช้
- เพิ่มขนาดข้อความผู้ใช้จาก 1,000 เป็น 4,000 ตัวอักษร และเพิ่ม output budget สำหรับ conversation เป็น 4,096 tokens เพื่อรองรับคำตอบยาว โค้ด บทความ และหลายภาษา
- ยกเลิกการตัดคำตอบ plain text ที่ 5,000 ตัวอักษร และเก็บ assistant history ต่อรอบได้ยาวขึ้น
- เปลี่ยน placeholder เป็นข้อความกลาง “พิมพ์ข้อความ…” และอัปเดตเลขเวอร์ชันที่แสดงใน sidebar/หน้า login เป็น v2.16

### Security & Safety (คงไว้ทุกโหมด)
- Authentication, ward scoping, signed conversation token, rate limit, provider timeout/circuit breaker และการไม่ส่งข้อมูลผู้ป่วยเข้า conversation mode
- โมเดลไม่มีสิทธิ์ลด deterministic risk ที่คำนวณโดยระบบ และคำตอบ Warning/Critical ต้องมี observation ที่อ้าง evidence จริงเสมอ
- คำตอบทั้งหมด render ด้วย DOM API และ `textContent`; ไม่ render HTML/Markdown จากโมเดล
- ห้ามวินิจฉัยยืนยันโรค ห้ามสั่งยา/ระบุขนาดยาเฉพาะบุคคล
- เมื่อ provider ล่ม, timeout, circuit open, JSON ไม่ถูกต้อง หรือคำตอบไม่ผ่าน safety validator ระบบจะแสดง deterministic summary แทน

### Deployment Configuration
- กำหนด OpenAI-compatible endpoint ปัจจุบันเป็น `https://sai.softsquaregroup.com/v1`
- กำหนด model ปัจจุบันเป็น `nurseaid:latest`
- ณ เวลา deploy endpoint `/v1/chat/completions` ตอบ HTTP 405; ฝั่ง reverse proxy/provider ต้องเปิด POST route นี้ก่อนจึงจะตอบจากโมเดลได้ โดย application จะใช้ข้อความ fallback ระหว่างที่ provider ไม่พร้อม

## [2.15.0] - 2026-08-18

### Added
- เพิ่ม **NurseAid AI Assistant** ในหน้า Monitor เป็นแชตแบบ responsive side panel รองรับการเลือกภาพรวมทุกเตียงหรือผู้ป่วยรายคน พร้อมคำถามแนะนำ สถานะกำลังวิเคราะห์ การยกเลิกคำขอ และ keyboard/accessibility support
- เพิ่ม `POST /api/monitor-ai-chat` สำหรับเชื่อมต่อโมเดล `medgemma:27b` ผ่าน OpenAI-compatible HTTPS endpoint ที่กำหนดด้วย environment variables
- เพิ่มการวิเคราะห์ข้อมูลย้อนหลังรายคนจากข้อมูลเดียวกับกราฟ รองรับช่วง 1 ชั่วโมง, 6 ชั่วโมง, 24 ชั่วโมง, 3 วัน และ 7 วัน
- เพิ่ม trend summary สำหรับ Heart Rate, SpO₂ และอุณหภูมิ ได้แก่ค่าต่ำสุด สูงสุด เฉลี่ย ล่าสุด ทิศทางแนวโน้ม จำนวนช่วง Warning/Critical และเปอร์เซ็นต์ความครอบคลุมของข้อมูล
- เพิ่มการอ่านข้อมูลย้อนหลังจาก InfluxDB โดย fallback ไปยัง PostgreSQL ตาราง `vital_signs_logs` และ downsample time-series ไม่เกิน 60 จุดก่อนส่งให้ AI
- เพิ่ม automated tests สำหรับ ward scoping, payload validation, privacy, HTTPS provider, medical guardrails, trend fallback/downsampling และความถูกต้องของ JavaScript หน้า Monitor

### Changed
- ยกเลิกใช้งาน Raspberry Pi BLE Gateway และนำ BLE-specific control publisher ออกจาก Web Application
- คืน MQTT Bridge สำหรับรับ telemetry จากอุปกรณ์ภายนอกและบันทึกลง InfluxDB โดยคง legacy topic/measurement contract เพื่อไม่กระทบอุปกรณ์ที่ใช้งานอยู่
- อัปเดตเลขเวอร์ชันที่แสดงใน sidebar และหน้า login เป็น v2.15

### Security & Privacy
- AI endpoint ใช้ session authentication และกรองข้อมูลตาม ward ฝั่ง server ก่อนอ่าน live snapshot หรือข้อมูลย้อนหลัง โดยไม่เชื่อ HN, MAC หรือ vital context จาก browser
- ลดข้อมูลระบุตัวบุคคลก่อนส่งไป AI: ไม่ส่งชื่อผู้ป่วย, HN, MAC หรือ ward ID และบังคับใช้ HTTPS พร้อม timeout, per-user rate limit และการจำกัดขนาดคำถาม/ประวัติสนทนา
- แสดงคำตอบ AI ผ่าน `textContent` เพื่อป้องกัน XSS และเพิ่ม medical guardrails ไม่ให้วินิจฉัยโรค สั่งยา หรือแทน clinical judgement/protocol ของหน่วยงาน

### Deployment Notes
- AI endpoint: `https://nurseaid-ai.softsquaregroup.com/v1`
- AI model: `medgemma:27b`
- ต้องตั้งค่า DNS/TLS/nginx ให้โดเมน AI เข้าถึง `/v1/chat/completions` ได้ก่อนใช้งานคำตอบจากโมเดลจริง

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
