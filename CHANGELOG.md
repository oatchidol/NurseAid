# Changelog

บันทึกการเปลี่ยนแปลงของ NurseAid ในแต่ละเวอร์ชัน

> **หมายเหตุเรื่องขอบเขต:** โปรเจกต์นี้ไม่มี git history และไม่มี CHANGELOG มาก่อน จึงเริ่มบันทึกอย่างเป็นทางการตั้งแต่ v2.13 เป็นต้นไป เวอร์ชันก่อนหน้า (2.0 – 2.12) ไม่มีบันทึกย้อนหลังที่ยืนยันได้

## [Unreleased]

### Changed
- ลำดับความสำคัญของผู้ป่วย (`สูง` / `กลาง` / `ต่ำ`) แสดงผลเป็นสีที่แยกกันชัดเจนแล้ว — เดิม token `--priority-high` / `--priority-medium` / `--priority-low` ถูกประกาศไว้ในชุดสีแต่ไม่มีโค้ดส่วนใดเรียกใช้ และ `<select>` ในการ์ดไม่มี CSS เลยแม้แต่บรรทัดเดียว ทุกระดับจึงหน้าตาเหมือนกันหมด ค่าที่พยาบาลตั้งไว้มองไม่เห็นบนหอผู้ป่วย ตอนนี้แยกด้วยสามช่องทางพร้อมกัน (สี + พื้น + เส้นขอบ) ไม่ใช่สีเพียงอย่างเดียว: `สูง` พื้นม่วงจางกับขอบม่วงทึบ 1.5px, `กลาง` พื้นเทาสเลตจางกับขอบทึบ 1px, `ต่ำ` ขอบประไม่มีพื้น, `ไม่ระบุ` ไม่มีสี — วัดค่า contrast แล้วผ่าน WCAG AA ทั้งธีมสว่างและธีมมืด (ตัวอักษรแย่สุด 4.66, องค์ประกอบกราฟิกแย่สุด 3.03)
  - เจตนาไม่แตะขอบซ้าย 4px ของการ์ด เพราะนั่นคือสัญญาณ**ทางคลินิก** (เขียว/เหลือง/แดง) แถบม่วงตรงนั้นจะไปกลบการแจ้งเตือนวิกฤตสีแดง สัญญาณความสำคัญจึงอยู่ในป้ายเดียวทั้งหมด
- ความถี่ในการดึงสัญญาณชีพขึ้นอยู่กับลำดับความสำคัญแล้ว — เดิมคงที่ 5 วินาทีเสมอไม่ว่าจะสนใจผู้ป่วยรายใดเป็นพิเศษหรือไม่ ตอนนี้ถ้ามีผู้ป่วยระดับ `สูง` อยู่บนหน้าจอจะดึงทุก 2 วินาที, มีแค่ `กลาง` ทุก 3.5 วินาที, ไม่มีเลยคงที่ 5 วินาทีตามเดิม และแสดงคาบที่ใช้อยู่ต่อท้ายป้าย `Last Sync` เพื่อให้ตรวจสอบได้ว่าทำงานจริง ไม่ใช่เปลี่ยนแบบมองไม่เห็น
  - `/api/live-status` คืนข้อมูลทั้งหอในคำขอเดียว (มี Influx 3 query กับ Postgres 2 query อยู่ข้างหลัง) จึงกำหนดความถี่แยกรายคนไม่ได้ — ระดับที่ด่วนสุดบนหน้าจอเป็นตัวกำหนดคาบของทั้งหน้า และคาบ 2 วินาทีหมายถึงโหลดฝั่งเซิร์ฟเวอร์เพิ่มราว 2.5 เท่าต่อแท็บที่เปิดอยู่
  - ตอน endpoint ล้มเหลวจะถอยกลับไป 5 วินาที เพื่อไม่ให้ผู้ป่วยระดับ `สูง` กลายเป็นการ retry ถี่ 2 วินาทีซ้ำ ๆ ใส่เซิร์ฟเวอร์ที่มีปัญหาอยู่แล้ว
  - **ไม่ได้** เปลี่ยนอัตราการวัดของตัวอุปกรณ์ ระบบไม่มีช่องทางสั่งงานย้อนกลับไปยังอุปกรณ์ (`mqtt_bridge.py` รับทางเดียว) สิ่งที่เร็วขึ้นคือความสดของตัวเลขบนหน้าจอ ไม่ใช่จังหวะที่อุปกรณ์วัด

### Added
- ผู้ใช้บทบาท `viewer` (มี `patients:read` แต่ไม่มี `patients:priority:write`) เห็นระดับความสำคัญได้แล้ว ในรูปป้ายอ่านอย่างเดียวที่หน้าตาเหมือน `<select>` ของผู้ที่แก้ได้ — เดิม `<select>` ถูกซ่อนไปทั้งอัน ผู้ใช้กลุ่มนี้จึงมองไม่เห็นเลยว่าผู้ป่วยรายใดถูกเฝ้าเป็นพิเศษ ไม่ได้เปลี่ยนสิทธิ์ใด ๆ: ป้ายกับ `<select>` แสดงสลับกันเสมอ ไม่มีทางเห็นทั้งคู่หรือหายไปทั้งคู่

## [2.20.2] - 2026-08-27

### Added
- เพิ่มชุดปรับปรุงด้านการเข้าถึง (accessibility) ครอบคลุมทุกหน้า ได้แก่ skip link สำหรับข้ามไปยังเนื้อหาหลัก, ป้ายกำกับ landmark ของเมนู, สไตล์ `:focus-visible` ที่ใช้ร่วมกันทั้งระบบ, ขนาดปุ่มขั้นต่ำ 44px และการรองรับ `prefers-reduced-motion`
- เพิ่ม `scripts/check-offline-assets.js` สำหรับตรวจว่าไม่มี asset ภายนอกหลุดกลับเข้ามาในโค้ด และ asset ในเครื่องที่โค้ดอ้างถึงมีไฟล์อยู่จริง
- เพิ่ม `PRODUCT.md` และ `DESIGN.md` บันทึกบริบทของผลิตภัณฑ์และระบบดีไซน์ที่ใช้อยู่จริง เพื่อให้งานปรับ UI ครั้งต่อไปมีที่อ้างอิงแทนการเดาจากโค้ดเดิม
- เพิ่ม Playwright เป็น devDependency สำหรับตรวจงาน UI ด้วยภาพจริง — เดิมไม่มีเครื่องมือใดเห็นหน้าเว็บได้เลย ทำให้การย้าย CSS ครั้งก่อนเปลี่ยน padding และ margin จริงโดยไม่มีใครรู้

### Changed
- เลิกโหลด asset จาก CDN ภายนอกทั้งหมด (Tailwind CSS, Chart.js, html5-qrcode, Google Fonts) เปลี่ยนมาเสิร์ฟจากเครื่องตัวเองที่ `public/assets/` เพื่อให้ UI ยังทำงานได้ในโรงพยาบาลที่ปิดกั้นอินเทอร์เน็ตขาออก — เดิม Tailwind ใช้ Play CDN ซึ่งคอมไพล์ CSS ในเบราว์เซอร์ใหม่ทุกครั้งที่โหลดหน้า และไม่รองรับการใช้งานจริง (production)
- CSS ของ Tailwind กลายเป็น build artifact ที่ commit เข้า repo สร้างด้วย `npm run build:css` — ถ้าแก้ utility class ใน `server.js` ต้องสั่ง build ใหม่แล้ว commit ไฟล์ที่ได้ด้วย ไม่งั้น class ใหม่จะไม่มีสไตล์
- แปลข้อความในหน้าเนื้อหาให้เป็นไทยครบ — เดิมเมนูเป็นไทยแล้วแต่ในหน้ายังเป็นอังกฤษ (`User Management`, `Full Name`, `ACTIONS`) ปนกับ emoji ทำให้ดูเหมือนงานยังไม่เสร็จ: หัวข้อหน้า 10 จุด, หัวตาราง 17 ช่อง, ป้ายบทบาททั้ง 3 จุดที่แสดงผล และ label ในฟอร์ม โดย**ไม่แตะ role key** จึงไม่กระทบระบบสิทธิ์
  - คำเทคนิคที่เอกสารผู้ให้บริการใช้ (`LINE Bot Token`, `Chat ID`, `SMTP`, `Custom Headers (JSON)`) และ `HN` / `MAC` / `IP` ที่บุคลากรไทยใช้จริง คงไว้ตามเดิมโดยเจตนา
- เปลี่ยนไอคอนเมนูทั้ง 14 ตัวจาก emoji เป็น inline SVG ชุดเดียวกัน — emoji เรนเดอร์ต่างกันทุกระบบปฏิบัติการและไม่เปลี่ยนสีตามธีม พร้อมตัด emoji ประดับออกจากหัวข้อหน้าและปุ่ม
- ปรับปุ่มสลับธีมเป็นแบบแบ่งสองฝั่ง เห็นทั้ง `สว่าง` และ `มืด` พร้อมกันโดยฝั่งที่ใช้อยู่ถูกเติมพื้น — เดิมเป็นสวิตช์เลื่อนที่ไม่มีป้ายกำกับ และหัวปุ่มใช้สีเหลืองอำพันที่ไม่มีอยู่ในชุดสีของระบบ
- ปรับโลโก้ `NurseAid` เลิกใช้ตัวเอียงพิมพ์ใหญ่ และปรับหน้า `login` ให้เป็น `<form>` จริง มี `<label>` ที่มองเห็น และข้อความเป็นไทย — เดิมมีแค่ placeholder ซึ่งหายไปทันทีที่ผู้ใช้พิมพ์ (ไม่ผ่าน WCAG 3.3.2) และตัวจัดการรหัสผ่านจำรหัสไม่ได้

### Fixed
- แก้ปัญหา dark mode: Tailwind utility class แบบฝังค่าตายตัว 195 จุด (เช่น `bg-slate-50`, `text-slate-500`) ไม่เปลี่ยนตามธีม ทำให้พื้นหลังยังสว่างอยู่ตอนเปิดโหมดมืด ซึ่งเป็นโหมดที่พยาบาลใช้ตอนเวรดึก
- แก้ค่า contrast ที่ไม่ผ่านมาตรฐาน WCAG AA: `--text-tertiary` เดิม 2.56:1 และ `--text-muted` เดิม 1.48:1 บนพื้นการ์ด รวมถึงสีสถานะสำเร็จ/เตือน/วิกฤต ที่อ่านไม่ออกในธีมสว่างและธีมมืดคนละทิศทางกัน
- แก้ขนาดตัวอักษรที่เล็กเกินไป (8px และ 9px) จำนวน 20 จุด ให้เป็น 10px เพราะเป็นข้อความที่ต้องอ่านในระยะแขนบนหอผู้ป่วย
- แก้ปุ่มสลับธีมที่เดิมเป็น `<div onclick>` ซึ่งกดด้วยคีย์บอร์ดไม่ได้และโปรแกรมอ่านหน้าจอมองไม่เห็น เปลี่ยนเป็น `<button role="switch">` พร้อม `aria-checked`
- แก้เสียงแจ้งเตือนสำรองที่เดิมโหลดจาก `actions.google.com` ทำให้การแจ้งเตือนครั้งแรกหลังเปิดหน้า (ก่อนที่ผู้ใช้จะแตะหน้าจอ) ไม่มีเสียงบนเครือข่ายที่ปิดกั้นอินเทอร์เน็ต เปลี่ยนไปใช้ไฟล์ในเครื่องที่สังเคราะห์ให้เสียงเหมือนเดิมทุกประการ

## [2.20.1] - 2026-08-27

### Fixed
- แก้บั๊กหน้า login (`/login`) แสดงเลขเวอร์ชันค้างที่ `v2.17` ไม่ว่าจะอัปเดต backend ไปเวอร์ชันไหนแล้วก็ตาม — ต้นเหตุคือ badge เวอร์ชันบนหน้า login เป็น string พิมพ์ตายตัว ไม่ได้อ่านจาก `APP_VERSION`/`package.json` เหมือนหน้า sidebar หลัก (ที่แก้ให้อ่านจากแหล่งเดียวไปแล้วตั้งแต่ v2.18.0) จุดนี้หลุดไปตอนนั้นเพราะไม่มีใครเช็คหน้า login ด้วย — เปลี่ยนให้อ่านจาก `APP_VERSION` เหมือนกันแล้ว

## [2.20.0] - 2026-08-26

### Added
- ปุ่ม "ติดตั้งอัตโนมัติทันที" (หน้า `/system-mgmt`) แสดง **progress bar จริง** พร้อมข้อความบอกขั้นตอนปัจจุบัน (ตรวจสอบ → ดึงโค้ด → สร้างเวอร์ชันใหม่ → รีสตาร์ท → ตรวจสอบสุขภาพ) และเวลาที่ผ่านไป แทนข้อความ "กำลังอัปเดต…" นิ่งๆ แบบเดิม — ขั้นตอน rollback แสดงเป็นแถบสีส้มแยกจากขั้นตอนปกติ

### Fixed
- แก้บั๊ก endpoint ตรวจสถานะการอัปเดตที่ไม่เคยแยกแยะสถานะ "กำลังทำงานอยู่" กับ "จบงานแล้ว" — ถ้าไม่แก้ก่อนเปิดใช้ progress bar หน้าเว็บจะเข้าใจผิดว่าอัปเดตล้มเหลวทันทีที่ backend เริ่มรายงานความคืบหน้าครั้งแรก ทั้งที่ยังทำงานอยู่จริง

## [2.19.0] - 2026-08-26

### Added
- **Quick Setup Wizard** (`/quick-setup`, ไอคอน 🚀 "เริ่มต้นใช้งาน" ในเมนู ต่อจาก Report และมีปุ่มลัดที่หน้า Monitor ด้วย) — หน้าเดียวพาไล่ทำ 3 ขั้นตอนต่อเนื่อง: เพิ่ม/เลือกอุปกรณ์ → เพิ่ม/เลือกผู้ป่วย → จับคู่กัน โดยไม่ต้องสลับไปมาระหว่างหน้า Devices/Patients/Pairing เอง
  - แต่ละขั้นตอนเลือกได้ทั้ง "เพิ่มใหม่" หรือ "เลือกจากที่มีอยู่แล้ว" (ค่าเริ่มต้นของขั้นตอนอุปกรณ์คือ "เลือกจากที่มีอยู่" เพราะอุปกรณ์ส่วนใหญ่ลงทะเบียนไว้แล้วในระบบจริง)
  - มี stepper แสดงความคืบหน้าแบบกราฟิกพร้อมตัวหนังสือ "ขั้นตอนที่ X จาก 3" กดย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าได้ทุกเมื่อ
  - ขั้นตอนที่ 3 สรุปอุปกรณ์/ผู้ป่วยที่เลือกไว้ให้ตรวจสอบก่อนยืนยันจับคู่จริง
  - บันทึกความคืบหน้าไว้อัตโนมัติ (sessionStorage) — รีเฟรชหน้าโดยไม่ตั้งใจไม่ทำให้ข้อมูลที่กรอกหาย
- `scripts/updategit.sh` — สคริปต์สำรองข้อมูล + อัปเดต + rebuild ด้วยคำสั่งเดียวสำหรับกรณีไม่ใช้ปุ่มในเว็บ
- `RELEASE.md` — คู่มือขั้นตอนการปล่อยเวอร์ชันใหม่ (bump version, เขียน changelog, สร้าง tag, push) แยกจาก `DEPLOY.md` ซึ่งเป็นคู่มือ setup เครื่องใหม่ครั้งแรก

### Fixed
- แก้บั๊กสิทธิ์ไฟล์ (permission) ที่ทำให้ปุ่ม "ติดตั้งอัปเดตอัตโนมัติ" ใช้งานไม่ได้ระหว่าง container `nurseaid` กับ `compose-collector` — พบระหว่างทดสอบจริงผ่านหน้าเว็บ ไม่ใช่แค่ทดสอบโค้ด
- แก้บั๊ก CSS ใน Quick Setup Wizard ที่ทำให้ตัวเลือก "เพิ่มใหม่/ใช้ที่มีอยู่" แสดงผลซ้อนกันทั้งคู่พร้อมกัน และบั๊กที่หน้าสรุปก่อนจับคู่ (ขั้นตอนที่ 3) แสดงข้อมูลว่างเปล่าตอนเดินหน้าตามปกติ — พบจากการทดสอบจริงด้วยภาพหน้าจอ (screenshot) ไม่ใช่แค่ตรวจโค้ด

## [2.18.0] - 2026-08-26

### Added
- หน้า "ตรวจสอบอัปเดต" (`/system-mgmt`, เฉพาะ super_admin) แสดงเวอร์ชันปัจจุบันและเช็คเวอร์ชันล่าสุดจาก GitHub tags — แก้ปัญหาป้าย version บน sidebar ที่เคยเป็นข้อความตายตัว (`v2.17`) ให้อ่านจาก `package.json` แหล่งเดียวเสมอ
- ปุ่ม **ติดตั้งอัปเดตอัตโนมัติ** (one-click Apply Update) บนหน้าเดียวกัน — กดแล้วระบบ `git pull` + build + recreate container ให้เองผ่าน `compose-collector` โดยมี **auto-rollback อัตโนมัติ** ถ้าเวอร์ชันใหม่ไม่ผ่าน health check (retag image เดิม, ย้อน git กลับ, recreate ใหม่, ยืนยัน healthy อีกครั้ง) พร้อมแจ้งเตือนผ่าน LINE/Telegram และบันทึก audit log ทุกขั้นตอน — ช่องทางสั่งอัปเดตนี้แยกจาก Central (fleet server ภายนอก) โดยโครงสร้าง ไม่ใช่แค่ไม่เปิดสิทธิ์
- `scripts/updategit.sh` — สคริปต์อัปเดต/สำรองข้อมูลด้วยมือสำหรับกรณีที่ไม่ต้องการใช้ปุ่มในเว็บ (backup repo + `.env`, `git reset --hard` ไปที่ origin, rebuild, health check)

### Fixed
- แก้บั๊กสิทธิ์ไฟล์ข้ามคอนเทนเนอร์ระหว่าง `nurseaid` (รันเป็น appuser) กับ `compose-collector` (รันเป็น root) ที่ทำให้ปุ่ม Apply Update เขียน/อ่านไฟล์ในโฟลเดอร์ spool ที่ใช้สื่อสารกันไม่ได้ — pin UID/GID ของ appuser ให้แน่นอน และปรับสิทธิ์ไฟล์ให้ทั้งสองฝั่งเข้าถึงได้เท่าที่จำเป็นเท่านั้น (พบระหว่างทดสอบจริงผ่านหน้าเว็บ ไม่ใช่แค่ทดสอบโค้ด)
- แก้บั๊ก `git checkout <sha>` ที่ทำให้ HEAD หลุดจาก branch (detached HEAD) หลัง rollback ซึ่งจะทำให้การอัปเดตครั้งถัดไปพัง — เปลี่ยนเป็น `git reset --hard`
- แก้บั๊ก Docker Compose เดารหัสโปรเจกต์ผิดตอนรันจากใน `compose-collector` (ได้ `repo` แทนที่จะเป็น `nurseaid`) ซึ่งเกือบทำให้ container postgres/influxdb ที่รันอยู่จริงถูกสร้างซ้ำโดยไม่ตั้งใจ — เพิ่ม `--project-name` ให้ชัดเจนทุกคำสั่ง

## [2.17.0] - 2026-08-25

### Added
- เพิ่มระดับความสำคัญ (priority) ของผู้ป่วยที่พยาบาล/แอดมินตั้งค่าเองได้ (สูง/กลาง/ต่ำ) แสดงเป็น badge และเส้นขอบเน้นบนการ์ดผู้ป่วยในหน้า Monitor โดยไม่ปะปนกับสีที่ใช้บอกสถานะสัญญาณชีพ
- เพิ่มความสามารถลากจัดเรียงลำดับการ์ดผู้ป่วยในหน้า Monitor (รองรับทั้งเมาส์และหน้าจอสัมผัส) โดยลำดับจะถูกบันทึกและแสดงผลเหมือนกันสำหรับผู้ใช้ทุกคนที่ดูวอร์ดเดียวกัน
- เพิ่มการอัปโหลดเสียงแจ้งเตือนของตัวเองที่หน้า Notification Settings (mp3/wav/ogg/midi สูงสุด 2MB) — ค่าเริ่มต้นยังเป็นเสียงบี๊บมาตรฐานเหมือนเดิมจนกว่าจะอัปโหลดเอง ไฟล์ MIDI จะถูกแปลงเป็น WAV ที่ฝั่ง server อัตโนมัติเพื่อให้เล่นได้แน่นอนทุกเบราว์เซอร์ และหากเล่นเสียงที่อัปโหลดไม่ได้ระบบจะ fallback ไปเสียงบี๊บมาตรฐานเสมอ
- เพิ่ม HTTPS reverse proxy ผ่าน nginx (self-signed certificate, ดู `scripts/generate-certs.sh` และ DEPLOY.md ข้อ 6)
- เพิ่ม WebSocket listener (port 9001) ให้ Mosquitto สำหรับ MQTT over WSS ผ่าน Cloudflare Tunnel

### Fixed
- mqtt-bridge ไม่ crash เมื่อได้รับ payload ที่ไม่ใช่ JSON object บน topic `ble/#` แล้ว (ข้ามและ log แทน)

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
