/*
 * ═══════════════════════════════════════════════════════════════════
 *  NAid ESP32 BLE Node — port จาก iStyle28.py (Raspberry Pi) → ESP32
 * ═══════════════════════════════════════════════════════════════════
 *
 *  หน้าที่: เชื่อมนาฬิกา J-Style สูงสุด MAX_DEVICES เรือนพร้อมกัน
 *           อ่าน HR / Temp / SpO2 / Battery แล้วส่งขึ้น MQTT
 *           ด้วย topic + payload รูปแบบ "เดียวกับ" iStyle28.py ทุกประการ
 *           → Dashboard เดิมใช้ได้ทันที ไม่ต้องแก้ backend
 *
 *  สิ่งที่ต่างจากเวอร์ชัน Pi:
 *    • ไม่มี BlueZ → ปัญหา org.bluez.Error.InProgress ทั้งชุดหายไป
 *    • ไม่ต้องมี recovery 4 ขั้น → ถ้าระบบเสียจริง ESP.restart() จบ
 *    • จำกัด MAX_DEVICES = 3 ตามคำแนะนำของ Espressif ที่ว่า
 *      "ESP32 BLE สื่อสารได้เสถียรที่ 3 การเชื่อมต่อพร้อมกัน"
 *    • ไม่มี rotation — 3 เรือนต่อค้างไว้ตลอด ค่าอัปเดตต่อเนื่อง
 *
 *  ── LIBRARY ที่ต้องติดตั้ง (Arduino IDE → Library Manager) ──
 *    1. NimBLE-Arduino  เวอร์ชัน 2.x  (ทดสอบกับ 2.5.1)
 *       ⚠️ ต้องเป็น 2.x เท่านั้น — API 1.x ไม่ตรงกัน
 *    2. PubSubClient    เวอร์ชัน 2.8  (ของ Nick O'Leary)
 *
 *  ── บอร์ด ──
 *    ESP32 Dev Module (แนะนำ ESP32-WROOM-32U + เสาอากาศภายนอก)
 *    ⚠️ ห้ามใช้ ESP32-S2 (ไม่มี Bluetooth)
 *
 *  ── หมายเหตุ coexistence (WiFi + BLE ใช้ radio ตัวเดียวกัน) ──
 *    • scan window (96) < scan interval (160) เสมอ ไม่งั้น WiFi โดนอด
 *    • ไม่เรียก WiFi.setSleep(false) — modem sleep ช่วยแบ่งเวลาให้ BLE
 *    • เมื่อ slot เต็ม 3 เรือน จะ "หยุด scan" ทั้งหมด ลดการแย่ง radio
 */

#include <WiFi.h>
#include <PubSubClient.h>
#include <NimBLEDevice.h>
#include <time.h>
#include <Preferences.h>
#include <WiFiManager.h>
#include "esp_wpa2.h"       // WPA2-Enterprise (PEAP / TTLS) สำหรับเครือข่ายองค์กร
#include <ArduinoOTA.h>     // OTA แบบ push (สั่งจาก command line ด้วย espota.py ได้)
#include <HTTPUpdate.h>     // OTA แบบ pull (โหลด .bin จาก Pi เอง สั่งผ่าน MQTT)
#include <ESPmDNS.h>
#include <esp_task_wdt.h>   // watchdog ระดับชิป — รีเซ็ตเองเมื่อ loop() ค้าง
#include <esp_system.h>
#include <esp_mac.h>       // esp_read_mac() — อ่าน MAC เรียงถูกลำดับ

// ═══════════════════════════════════════════════════════════════════
// EMBEDDED METADATA — webapp อ่านจากไฟล์ .bin ได้ทันทีหลังอัปโหลด
//
//   webapp จะค้นหา magic string "NAidMETA" ในไฟล์ binary แล้วอ่าน
//   ฟิลด์ถัดไปตาม layout ที่ตรงกัน เพื่อแสดงข้อมูล config ก่อน deploy
//   ⚠️ ห้ามเปลี่ยนลำดับ/ขนาดฟิลด์ — webapp อ่านตาม offset ตายตัว
//      ถ้าต้องเพิ่มฟิลด์ ให้เพิ่มต่อท้าย reserved แล้วขึ้น metaVersion
// ═══════════════════════════════════════════════════════════════════
// ⚠️ forward-declare เท่านั้น — ค่าจริงอยู่หลัง #define CONFIG ด้านล่าง
//    เพราะ struct ต้องรู้จักก่อนที่ Arduino จะสร้าง prototype อัตโนมัติ
struct __attribute__((packed)) FirmwareMetadata {
    char     magic[8];          // "NAidMETA" — ใช้ค้นหาตำแหน่งใน binary
    uint8_t  metaVersion;       // เวอร์ชันของ struct นี้ (เริ่มที่ 1)
    char     fwVersion[24];     // เช่น "2.1.0"
    char     mqttBroker[48];    // เช่น "172.16.251.38"
    uint16_t mqttPort;          // เช่น 1883
    char     mqttBaseTopic[16]; // เช่น "ble"
    uint8_t  maxDevices;        // เช่น 8
    char     defaultSsid[33];   // SSID สำรอง
    char     buildDate[24];     // เช่น "Sep 10 2026"
    char     reserved[32];      // เผื่อเพิ่มฟิลด์ในอนาคต
};

// ═══════════════════════════════════════════════════════════════════
// CONFIG — แก้ส่วนนี้ก่อนอัพโหลด
// ═══════════════════════════════════════════════════════════════════

// --- WiFi (ต้องเป็น 2.4GHz — ESP32 ไม่รองรับ 5GHz) ---
// --- WiFi ---
//   ไม่ต้องแก้ SSID/รหัสในโค้ดอีกแล้ว — ตั้งผ่านหน้าเว็บตอนติดตั้งหน้างาน
//   ค่าที่ตั้งจะถูกเก็บใน NVS อยู่รอดข้ามการรีบูตและการอัปเดตเฟิร์มแวร์
//
//   ⚠️ ค่า 2 ตัวนี้เป็นแค่ "ค่าสำรองตอนบูตครั้งแรก" เท่านั้น
//      ถ้าต่อไม่ได้จะเปิดหน้าเว็บให้ตั้งค่าเอง
#define WIFI_SSID        "ksr_comp3"
#define WIFI_PASS        "1111100000"

// --- โหมดตั้งค่า WiFi ผ่านหน้าเว็บ ---
#define WM_AP_PASSWORD   "naidsetup"   // รหัสเข้า WiFi ตอนตั้งค่า (อย่างน้อย 8 ตัว)
#define WM_PORTAL_TIMEOUT_SEC   180    // ไม่มีใครเข้ามาตั้งค่าใน 3 นาที → เลิกรอ แล้วบูตใหม่
#define WM_CONNECT_TIMEOUT_SEC   20    // รอเชื่อม WiFi เดิมนานสุดกี่วินาที

// ปุ่ม BOOT บนบอร์ด (GPIO9 บน C3 / GPIO0 บนรุ่นอื่น) ใช้ล้างค่า WiFi
//   กดค้างไว้ตอนเสียบไฟ → เข้าโหมดตั้งค่าใหม่
//   จำเป็นเพราะถ้า WiFi เดิมใช้ไม่ได้ จะสั่งผ่าน MQTT ไม่ได้เลย
#if CONFIG_IDF_TARGET_ESP32C3
  #define WM_RESET_PIN     9
#else
  #define WM_RESET_PIN     0
#endif
#define WM_RESET_HOLD_MS  3000

// ═══════════════════════════════════════════════════════════════════
// รายชื่อ WiFi ที่โหนดรู้จัก (เก็บใน NVS)
//
//   ทำไมต้องเก็บหลายชุด:
//     ตอนโรงพยาบาลเปลี่ยน WiFi ถ้าโหนดจำได้ชุดเดียว พอของเก่าหาย = ออฟไลน์ทันที
//     แล้วสั่งค่าใหม่ผ่าน MQTT ไม่ได้เพราะไม่มีเน็ตแล้ว (ปัญหาไก่กับไข่)
//
//   ถ้าจำได้หลายชุด: เพิ่มชุดใหม่เข้าไป "ก่อน" วันเปลี่ยนจริง
//   พอของเก่าหาย โหนดจะย้ายไปเกาะชุดใหม่เองอัตโนมัติ ไม่ต้องมีใครไปยุ่ง
// ═══════════════════════════════════════════════════════════════════
#define WIFI_MAX_SAVED       5      // จำได้กี่ชุด
#define WIFI_TRY_TIMEOUT_MS  9000   // ลองแต่ละชุดนานสุดกี่ ms

// ── ชนิดการยืนยันตัวตนที่รองรับ ──
//   ไม่ใช้ WiFiMulti เพราะ addAP() รับได้แค่ ssid+รหัส ใช้กับ Enterprise ไม่ได้
//   จึงเขียนลูปลองเองเพื่อให้รองรับได้ทุกแบบในโค้ดชุดเดียว
enum WifiAuth : uint8_t {
    AUTH_PSK  = 0,   // WPA2/WPA3-PSK — รหัสเดียวร่วมกัน (แบบที่ใช้อยู่)
    AUTH_OPEN = 1,   // เครือข่ายเปิด ไม่มีรหัส
    AUTH_PEAP = 2,   // WPA2-Enterprise PEAP-MSCHAPv2 ← พบบ่อยสุดในองค์กร
    AUTH_TTLS = 3,   // WPA2-Enterprise EAP-TTLS (phase2 = MSCHAPv2)
};
static const char* AUTH_NAME[] = { "psk", "open", "peap", "ttls" };

// ⚠️ ต้องประกาศตรงนี้ (บนสุด) — Arduino สร้าง prototype ของฟังก์ชันอัตโนมัติ
//    ไว้ก่อนโค้ดของเรา ถ้า struct อยู่ล่างกว่านั้นจะคอมไพล์ไม่ผ่าน
struct WifiCred {
    String ssid, pass, identity, username;
    WifiAuth auth = AUTH_PSK;
};

// --- MQTT (ค่าเดียวกับ iStyle28.py) ---
#define MQTT_BROKER      "172.16.251.45"
#define MQTT_PORT        1883
#define MQTT_USER        "nursemon"
#define MQTT_PASS        "softTech^2"              // ← ใส่รหัสเดียวกับที่ตั้งใน env MQTT_PASS ของ Pi
#define MQTT_BASE_TOPIC  "ble"

// --- ประจำตัวโหนด (ตั้งไม่ซ้ำกันเมื่อมีหลายโหนด: node1, node2, ...) ---
// --- ชื่อประจำโหนด ---
//   ⚠️ ห้ามซ้ำกันเด็ดขาด เพราะเป็นส่วนหนึ่งของ MQTT topic
//      ถ้าซ้ำ: สั่ง reboot ตัวเดียวจะโดนทุกตัว · log ปนกัน · ข้อมูล retained ทับกัน
//
//   ปล่อยว่าง "" = ตั้งชื่อเองจาก MAC → แฟลชไฟล์เดียวกันได้ทุกเครื่อง
//   ใส่ชื่อ      = บังคับใช้ชื่อนั้น (เหมาะตอนทดสอบเครื่องเดียว)
#define NODE_ID_FIXED    ""

//   ชื่ออัตโนมัติใช้ 3 ไบต์ท้ายของ MAC เช่น "n8cd0a4" (7 ตัวอักษร)
//   ทดสอบแล้ว 100 เครื่องมีโอกาสชื่อชนกันเพียง 0.03%
//   (ตัดเหลือ 4 หลักจะสั้นลงแต่โอกาสชนพุ่งเป็น 7% — ไม่คุ้ม)
static char NODE_ID[24] = "";

// --- OTA / สั่งงานระยะไกล ---
#define FW_VERSION       "2.2.0"    // ส่งไปกับ heartbeat ใช้ยืนยันว่าอัปเดตสำเร็จจริง

#define OTA_PASSWORD     "naid-ota" // ⚠️ เปลี่ยนก่อนใช้จริง ใครรู้รหัสนี้อัปเฟิร์มแวร์เข้าเครื่องได้
static char TOPIC_CMD_NODE[64]     = "";   // เติมตอนบูตหลังรู้ NODE_ID
#define TOPIC_CMD_ALL    MQTT_BASE_TOPIC "/node/all/cmd"           // สั่งพร้อมกันทุกโหนด

// ═══════════════════════════════════════════════════════════════════
// การกู้ตัวเองเมื่อค้าง — เพื่อไม่ต้องเดินไปชักปลั๊กที่ห้องผู้ป่วย
// ═══════════════════════════════════════════════════════════════════
// ชั้นที่ 1: Task Watchdog ระดับชิป
//   ถ้า loop() ไม่กลับมา "ป้อนอาหาร" ภายในเวลาที่ตั้ง ชิปจะรีเซ็ตตัวเอง
//   ⚠️ ต้องตั้งมากกว่าเวลา block นานสุดใน loop หนึ่งรอบ ไม่งั้นจะรีเซ็ตทั้งที่ปกติ
//      วัดแล้วกรณีแย่สุด ~12 วิ (connect 8 + discovery 3 + อื่น ๆ) จึงตั้ง 30 วิ
#define WDT_TIMEOUT_SEC              30
#define BROKER_TRY_MAX_BOOTS         2       // ลองรวมกี่บูต ถ้าไม่ติด → กลับ broker เดิม
#define BROKER_CONFIRM_MS            120000  // ต้องต่อติดต่อเนื่องกี่ ms ก่อนยืนยันเป็นตัวหลัก
#define BROKER_TRIAL_DEADLINE_MS     900000  // ทดลองได้ไม่เกิน 15 นาที ไม่ผ่าน = ถอยกลับ

// ชั้นที่ 2: เน็ตหลุดยาว = รีบูต
//   ครอบคลุมเคสที่ chip ไม่ค้าง แต่ WiFi/MQTT stack เอ๋อจนต่อไม่ติดอีกเลย
#define NET_DEAD_REBOOT_MS   (10UL * 60UL * 1000UL)   // 10 นาที

// ชั้นที่ 3: รีบูตตามรอบ (0 = ปิด) — ล้าง heap fragmentation สะสม
#define AUTO_REBOOT_HOURS             0

// --- DEVICE REGISTRY ---
//     ⚠️ รายชื่อนี้เป็นแค่ "ค่าสำรองตอนบูตครั้งแรก" เท่านั้น
//        รายชื่อจริงมาจาก PostgreSQL ผ่าน MQTT retained message
//        ลำดับความสำคัญ:  MQTT (สดที่สุด) > NVS (ที่จำไว้) > รายชื่อด้านล่าง
static const char* FALLBACK_DEVICES[] = {
    /*"21:02:02:05:FF:9A",
    "21:02:02:05:F9:DD",
    "21:02:02:06:A0:63",
    "21:02:02:06:9F:20",
    "21:02:02:06:A0:F4",
    "03:02:02:08:29:96",
    "21:02:02:06:9F:7F",
    "00:00:13:A7:5D:18",*/
};
static const int NUM_FALLBACK = sizeof(FALLBACK_DEVICES) / sizeof(FALLBACK_DEVICES[0]);
#define MAX_REGISTERED   20      // เพดานรายชื่อที่เก็บได้ (คนละเรื่องกับจำนวนที่ต่อพร้อมกัน)

// --- หัวข้อ MQTT ที่ใช้รับรายชื่อจากฐานข้อมูล ---
//   ทั้งสองหัวข้อต้องส่งแบบ retained  → ESP32 ได้รายชื่อทันทีที่ต่อ broker ติด
//   ถ้ามีทั้งคู่ จะใช้ของเฉพาะโหนดก่อน (สำคัญมากเมื่อมีหลายโหนด จะได้ไม่แย่งเรือนเดียวกัน)
#define TOPIC_DEVICES_ALL   MQTT_BASE_TOPIC "/mac"          // รายชื่อรวมทุกโหนด
//   ⚠️ ต้องมี "/" คั่นก่อน NODE_ID ไม่งั้น C เชื่อมสตริงติดกันเป็น "ble/macslave1"
static char TOPIC_DEVICES_NODE[64] = "";   // เติมตอนบูตหลังรู้ NODE_ID

// --- หัวข้อ MQTT ที่ใช้รับ priority ต่อเรือนจากแอป (ดู PRIORITY_MEDIUM_INTERVAL_MS) ---
//   payload ยอมรับได้ทั้ง "AA:BB:CC:DD:EE:FF:high, 11:22:33:44:55:66:low" หรือ
//   JSON-ish "AA:BB:CC:DD:EE:FF":"high" — ตัวอ่านหา MAC ก่อนแล้วอ่านคำถัดไปเป็น priority
//   เรือนที่ไม่ถูกกล่าวถึงในข้อความนี้ = ไม่เปลี่ยนแปลง priority เดิม (ค่าเริ่มต้น = high)
#define TOPIC_PRIORITY_ALL   MQTT_BASE_TOPIC "/priority"
static char TOPIC_PRIORITY_NODE[64] = "";   // เติมตอนบูตหลังรู้ NODE_ID

// --- ⭐ จำกัดจำนวนเชื่อมต่อพร้อมกัน ---
//
//   ⚠️⚠️ ค่านี้ต้อง ≤ CONFIG_BT_NIMBLE_MAX_CONNECTIONS ของไลบรารี NimBLE
//        ซึ่งมีค่า default = 3
//
//   ❗ การใส่ #define CONFIG_BT_NIMBLE_MAX_CONNECTIONS ในไฟล์ .ino "ไม่มีผล"
//      เพราะไลบรารีถูกคอมไพล์แยกไปแล้วก่อนที่จะอ่านไฟล์นี้
//      ต้องไปแก้ที่ไฟล์ของไลบรารีโดยตรง:
//
//        Arduino/libraries/NimBLE-Arduino/src/nimconfig.h  บรรทัดราว ๆ 23
//        เปลี่ยนจาก   // #define CONFIG_BT_NIMBLE_MAX_CONNECTIONS 3
//        เป็น         #define CONFIG_BT_NIMBLE_MAX_CONNECTIONS 8     ← เอา // ออกด้วย
//
//      แก้แล้วต้องลบ cache การคอมไพล์ก่อน build ใหม่ ไม่งั้นจะใช้ของเก่า
//
//   ถ้าไม่แก้ nimconfig.h ให้ตั้ง MAX_DEVICES เป็น 3 แทน
#define MAX_DEVICES      8

// ── ค่าจริงของ metadata ที่ฝังลงใน .bin ──
//    ต้องอยู่หลัง #define ทั้งหมดที่ใช้เป็นค่าเริ่มต้น
//    attribute(used) กันคอมไพเลอร์ตัดทิ้ง (ไม่มีโค้ดอ้างถึงโดยตรง)
// retain จำเป็น — Arduino ESP32 ลิงก์ด้วย --gc-sections ลำพัง used กันได้แค่คอมไพเลอร์
static const FirmwareMetadata __attribute__((used, retain, section(".rodata")))
FIRMWARE_META = {
    {'N','A','i','d','M','E','T','A'},  // magic — ห้ามเปลี่ยน
    1,                                   // metaVersion
    FW_VERSION,                          // fwVersion
    MQTT_BROKER,                         // mqttBroker
    MQTT_PORT,                           // mqttPort
    MQTT_BASE_TOPIC,                     // mqttBaseTopic
    MAX_DEVICES,                         // maxDevices
    WIFI_SSID,                           // defaultSsid
    __DATE__,                            // buildDate (คอมไพเลอร์ใส่ให้)
    ""                                   // reserved
};
// ── ตัวดักตอนคอมไพล์: กันตั้งค่าขัดกันจนแครชหน้างาน ──
//    (ค่าจริงของไลบรารีถูกอ่านมาแล้วจาก nimconfig.h ตอน #include NimBLEDevice.h)
#if defined(CONFIG_BT_NIMBLE_MAX_CONNECTIONS) && (MAX_DEVICES > CONFIG_BT_NIMBLE_MAX_CONNECTIONS)
  #error "MAX_DEVICES มากกว่าเพดานของ NimBLE — เรือนที่เกินจะทำให้ createClient() คืน NULL แล้วแครช | แก้ไฟล์ NimBLE-Arduino/src/nimconfig.h บรรทัด ~23 ให้ CONFIG_BT_NIMBLE_MAX_CONNECTIONS เท่ากับ MAX_DEVICES (อย่าลืมเอา // ออก) แล้วลบ cache ก่อน build | หรือลด MAX_DEVICES ลงให้เท่าเพดาน"
#endif

// --- TIMING (มิลลิวินาที — ค่าเดียวกับ iStyle28.py ที่เป็นวินาที) ---
#define BLE_CONNECT_TIMEOUT_MS      8000   // ⚠️ connect() เป็น blocking — ค่านี้คือ "เพดานความช้า"
                                            //    ของการแจ้ง disconnect ทั้งโหนด เพราะ loop ติดอยู่ตรงนั้น
                                            //    ลดจาก 15s เหลือ 8s เพื่อให้ Dashboard อัปเดตไวขึ้น
                                            //    (เรือนที่ต่อไม่ติดใน 8 วิ มักต่อไม่ติดอยู่ดี)
#define PHASE1_DURATION_MS         120000   // Phase 1 (HR/Temp) 120 วิ
#define PHASE2_TIMEOUT_MS         75000   // รอผล SpO2 สูงสุด 75 วิ
                                            // ⚠️ ต้อง >= เวลาที่นาฬิกาใช้วัดจริงที่ช้าที่สุด
                                            //    วัดจากหน้างาน: 45 วิ (เร็วสุด) – 120 วิ (ช้าสุด)
                                            //    ถ้าตั้งน้อยกว่านี้ เคสที่วัดช้าจะไม่มีวันได้ค่าเลย
#define KEEPALIVE_INTERVAL_MS      30000   // ส่ง 0x41 ทุก 30 วิ
#define BATTERY_READ_INTERVAL_MS   60000   // ส่ง 0x13 ทุก 60 วิ
#define RSSI_READ_INTERVAL_MS      30000   // อ่าน+ส่ง RSSI ทุก 30 วิ
#define DATA_TIMEOUT_MS            30000   // watchdog ช่วง Phase 1: เงียบเกินนี้ = ตัดทิ้ง
// ⚠️ ช่วงวัด SpO2 ห้ามใช้ค่าข้างบน — นาฬิกาอาจเงียบยาวระหว่างวัด (45-120 วิ)
//    ถ้าใช้ค่าเดียวกัน watchdog จะตัดการเชื่อมต่อทิ้งกลางคันทุกครั้ง
//    ช่วงนั้นจึงมี watchdog ของตัวเอง = PHASE2_TIMEOUT + ระยะเผื่อ
//    (ไม่ได้ปิด watchdog ทิ้ง เพราะยังต้องกันเคส connection ค้างจริง)
#define PHASE2_WATCHDOG_GRACE_MS   30000   // เผื่อจาก PHASE2_TIMEOUT_MS

// เพดานรวมของ Phase 2 ทั้งหมด (นับรวมทุกรอบที่วัดซ้ำ)
//   จำเป็นเพราะ SPO2_LOW_RECHECK_MAX=3 คูณกับ PHASE2_TIMEOUT=120 วิ
//   ทำให้กรณีแย่สุดกิน 6 นาที ซึ่ง "ไม่มี HR/Temp ส่งออกเลย" ตลอดช่วงนั้น
//   ครบเพดานนี้เมื่อไหร่ให้กลับ Phase 1 ทันที ไม่วัดซ้ำต่อ
#define PHASE2_TOTAL_BUDGET_MS    180000   // 3 นาที
#define MQTT_PUBLISH_INTERVAL_MS    1000   // rate limit ต่อ (mac, key)
#define ESP32_STATUS_INTERVAL_MS   30000   // ความถี่ส่งสถานะโหนดไป ble/esp32
#define STALE_DEVICE_MS            30000   // ไม่เห็น advertisement เกินนี้ = ไม่อยู่ในระยะ
#define CONNECT_STAGGER_MS          1500   // เว้นระยะระหว่างการ connect แต่ละเรือน
#define FAIL_COUNT_FOR_COOLDOWN        5   // fail ครบแล้วพัก
#define COOLDOWN_MS                60000
#define RSSI_MIN_THRESHOLD           -85   // สัญญาณอ่อนกว่านี้ไม่พยายามต่อ
                                            // ⚠️ FIX (debug session นี้): คืนจาก -100 กลับเป็น -85
                                            //    -100 dBm อยู่เกือบชิดพื้น noise — พยายามต่อกับ
                                            //    เรือนที่สัญญาณอ่อนขนาดนั้นมีโอกาสสูงที่จะ connect
                                            //    fail/หลุดกลางคัน ยิ่งเพิ่มอาการ "หลุดบ่อย"
// (ห้ามใส่ CONFIG_BT_NIMBLE_MAX_CONNECTIONS ตรงนี้ — ไม่มีผล ดูหมายเหตุที่ MAX_DEVICES)

// ═══════════════════════════════════════════════════════════════════
// PRIORITY — ปรับความถี่การวัดตาม priority ที่แอปตั้ง (ประหยัดแบตนาฬิกา)
//
//   high   : เหมือนพฤติกรรมเดิมทั้งหมด — ค้างเชื่อมต่อตลอด วนรอบไม่จบ
//   medium/low : วัดครบ 1 รอบ (HR/Temp+SpO2) แล้ว "ตัดการเชื่อมต่อ" ทันที
//                คืน slot ให้เรือนอื่น แล้วรอครบ interval ค่อยต่อกลับมาวัดใหม่
//                ช่วงที่ไม่ได้เชื่อมต่อ = ไม่มี BLE radio ค้าง + ไม่มี LED PPG
//                ทำงาน ซึ่งเป็นตัวกินแบตหลักของนาฬิกา
//
//   ⚠️ ค่าเริ่มต้นของทุกเรือนคือ high เสมอ (ดู RegDevice.priority ด้านล่าง)
//      ถ้าแอปไม่เคยส่ง priority มาเลย ระบบจะทำงานเหมือนก่อนมี feature นี้ทุกประการ
#define PRIORITY_MEDIUM_INTERVAL_MS    (5UL * 60UL * 1000UL)   // 5 นาที
#define PRIORITY_LOW_INTERVAL_MS      (10UL * 60UL * 1000UL)   // 10 นาที

// --- SPO2 LOW ALERT (เหมือน Pi) ---
#define SPO2_LOW_THRESHOLD            95   // ต่ำกว่านี้ → วัดซ้ำทันที
#define SPO2_LOW_RECHECK_MAX           3
#define SPO2_LOW_RECHECK_DELAY_MS   2000

// --- OFF-WRIST DETECTION (เหมือน Pi) ---
#define TEMP_VALID_MIN              20.0f
#define TEMP_OFFWRIST_SUSPECT       29.0f
#define TEMP_OFFWRIST_DEFINITE      25.0f   // เกณฑ์สัมบูรณ์ — ใช้เป็นตาข่ายชั้นสุดท้ายเท่านั้น
#define HR_ZERO_OFFWRIST_MS        45000
#define OFFWRIST_DEBOUNCE_COUNT        3

// ── ตรวจจับการถอดสายรัดแบบใหม่ (เร็วกว่าและไม่ขึ้นกับอุณหภูมิห้อง) ──
//
//   ⚠️ เกณฑ์สัมบูรณ์ temp<25°C ใช้ไม่ได้จริงในห้องแอร์
//      เพราะสายรัดจะเย็นลงเข้าหาอุณหภูมิห้องเท่านั้น ไม่มีทางต่ำกว่านั้น
//      ห้องแอร์ 26°C → temp ลงไปได้ต่ำสุด ~26°C → ไม่มีวันแตะ 25°C → ตรวจไม่เจอตลอดกาล
//
//   ⚠️ เกณฑ์ "HR=0 นาน 45 วิ" ก็ใช้ไม่ได้เช่นกัน
//      เพราะจากการวัดหน้างาน พอถอดออกแล้ว HR ไม่เป็น 0 แต่ "ค้างที่ค่าล่าสุด"
//      ทำให้ heart>0 เสมอ → ตัวจับเวลาถูกรีเซ็ตทุกเฟรม → เงื่อนไขนี้ตายสนิท
//
//   จึงเปลี่ยนมาใช้สัญญาณที่วัดได้จริง 2 อย่าง:
//     ① HR ค้างค่าเดิมเป๊ะ ๆ ติดกันหลายครั้ง — ตอนสวมอยู่ค่าจะแกว่งเสมอ
//     ② อุณหภูมิ "ลดลงจากค่าฐาน" (ไม่ใช่ค่าสัมบูรณ์) → ใช้ได้ทุกอุณหภูมิห้อง
//   หมายเหตุ: สัญญาณ HR ค้างเป็นแค่ "ตัวประกอบ" ไม่ใช่ตัวตัดสิน
//   เพราะถ้านาฬิกาอัปเดต HR ช้ากว่าอัตราการส่งเฟรม ค่าก็จะซ้ำเป็นปกติอยู่แล้ว
//   ตัวที่กันแจ้งผิดจริงคือ TEMP_DROP_WITH_HR ด้านล่าง
#define HR_FROZEN_SAMPLES             10   // HR ซ้ำเป๊ะกี่ครั้งถึงถือว่า sensor ไม่อ่านแล้ว
//   ⚠️ ค่านี้คือ "ตัวกันแจ้งผิด" ตัวจริง ไม่ใช่ HR_FROZEN_SAMPLES
//      ทดสอบแล้วพบว่า 0.8 จะแจ้งผิดตอนผู้ป่วยเอาแขนออกนอกผ้าห่ม
//      (อุณหภูมิลด 1.5°C ใน 2 นาที → แจ้งผิดที่ 106 วิ)
//      ปรับเป็น 1.2 แล้วไม่แจ้งผิด แลกกับตรวจถอดจริงช้าลงจาก 20 → 31 วิ
//      ถ้าต้องการไวขึ้นอีก ลดเป็น 1.0 ได้ (25 วิ) แต่เหลือระยะปลอดภัยน้อยลง
#define TEMP_DROP_WITH_HR          1.2f    // ลดจากฐานเท่านี้ + HR ค้าง = ถอดแล้ว
#define TEMP_DROP_ALONE            2.0f    // ลดจากฐานมากขนาดนี้ = ถอดแล้ว (ไม่ต้องดู HR)
#define TEMP_BASELINE_FALL_ALPHA   0.01f   // ค่าฐานไล่ตามขาลงช้า ๆ (ขาขึ้นตามทันที)

// ── เกณฑ์ "สวมกลับ" ต้องแยกจากเกณฑ์ "ถอด" (hysteresis) ──
//   ⚠️ ห้ามใช้เกณฑ์เดียวกันทั้งสองทาง เพราะจะเกิดบั๊กนี้:
//      ถอดวางทิ้งไว้ → สายรัดเย็นลงเรื่อย ๆ จนเท่าอุณหภูมิห้องแล้วหยุด
//      → ค่าฐานไล่ตามมาบรรจบ → ส่วนต่างหดเหลือ 0
//      → ระบบเข้าใจผิดว่า "สวมกลับแล้ว" ทั้งที่ยังวางอยู่บนโต๊ะ
//   จึงต้องใช้ "หลักฐานเชิงบวก" ว่าสวมกลับจริง คืออุณหภูมิต้องสูงขึ้น
#define TEMP_RISE_BACK             1.0f    // ต้องสูงขึ้นจากจุดต่ำสุดเท่านี้
#define TEMP_WEAR_MIN             30.0f    // และต้องถึงระดับที่สัมผัสผิวจริงเท่านั้น
#define ONWRIST_DEBOUNCE_COUNT        3

// ── ต้องมี "ชีพจรที่มีชีวิต" ด้วย ถึงจะถือว่าสวมกลับ ──
//   เหตุผล: อุณหภูมิอย่างเดียวหลอกได้ง่ายมาก
//     • ความร้อนจากไฟ PPG ตอนวัด HR/SpO2 (LED อยู่ติดเซ็นเซอร์วัดอุณหภูมิ)
//     • ความร้อนจากวิทยุ BLE ตอนสตรีมข้อมูล
//     • วางบนที่อุ่น / โดนแดด / มีคนหยิบจับ
//   แต่ค่า HR จะ "แกว่ง" ได้ก็ต่อเมื่อมีเลือดไหลผ่านใต้เซ็นเซอร์จริงเท่านั้น
//
//   ⚠️ ต้องดู "การเปลี่ยนแปลง" ไม่ใช่ "มีค่าหรือไม่"
//      เพราะตอนถอดออก HR ไม่เป็น 0 แต่ค้างที่ค่าล่าสุด → มีค่าเสมอ
#define HR_CHANGES_FOR_ONWRIST        3     // ต้องเปลี่ยนค่ากี่ครั้ง
#define HR_LIVE_WINDOW_MS         30000     // ภายในกี่มิลลิวินาที
#define HR_PLAUSIBLE_MIN             40     // ช่วงชีพจรที่เป็นไปได้ของคน
#define HR_PLAUSIBLE_MAX            180

// ── ถอดไว้นานเกินกำหนด → ตัดการเชื่อมต่อคืน slot ให้เรือนอื่น ──
#define OFFWRIST_DISCONNECT_MS  (10UL * 60UL * 1000UL)   // 10 นาที
#define OFFWRIST_RECHECK_MS     (3UL * 60UL * 1000UL)    // เว้นก่อนกลับมาตรวจใหม่
#define HR_FREEZE_AFTER_SPO2_MS    30000

// --- J-STYLE GATT (เหมือน Pi) ---
static const NimBLEUUID UUID_SERVICE("fff0");
static const NimBLEUUID UUID_TX("fff6");        // เขียนคำสั่ง
static const NimBLEUUID UUID_RX("fff7");        // รับ notification

// --- NTP (ใช้ประทับเวลาใน payload ให้เหมือน Pi) ---
//     ถ้าโรงพยาบาลบล็อก NTP เวลาจะค้างปี 1970 — backend ควรใช้เวลารับเป็นหลัก
#define NTP_SERVER1      "172.16.0.7"
#define NTP_SERVER2      "time.google.com"
#define TZ_OFFSET_SEC    (7 * 3600)             // ไทย UTC+7
#define NTP_SYNC_TIMEOUT_MS       10000         // รอ sync ตอนบูตนานสุด
#define NTP_RESYNC_INTERVAL_MS  3600000         // เทียบเวลาใหม่ทุก 1 ชม. (กันนาฬิกาชิปดริฟต์)

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

// ── สถานะของแต่ละขั้นใน hybrid cycle (แทน while-loop ของ Python ด้วย FSM
//    เพราะบน Arduino ห้าม block นาน ไม่งั้นเรือนอื่น + MQTT จะค้างตาม) ──
enum SlotPhase : uint8_t {
    PH_FREE = 0,        // ช่องว่าง
    PH_SETUP,           // เพิ่งต่อติด รอ notify พร้อม (2 วิ) แล้วเริ่ม Phase 1
    PH_PHASE1,          // สตรีม HR/Temp
    PH_P2_STOPPING,     // ส่ง stop 0x09 แล้วรอ 1.5 วิ
    PH_P2_MEASURING,    // ส่ง start SpO2 แล้วรอผล
    PH_P2_ENDING,       // ส่ง stop SpO2 แล้วรอ 1.5 วิ ก่อนตัดสินใจ
    PH_P2_RECHECK_WAIT, // SpO2 ต่ำ → หน่วง 2 วิ ก่อนวัดซ้ำ
};

// ── กุญแจ MQTT ที่ส่ง (ใช้ index ทำ rate-limit ราคาถูก) ──
enum PubKey : uint8_t { K_HEART = 0, K_TEMP, K_SPO2, K_BATT, K_STATUS, K_RSSI, K_COUNT };
static const char* PUB_KEY_NAME[K_COUNT] = { "heart", "temp", "spo2", "batt", "status", "rssi" };

// ── priority การวัด ต่อเรือน (ตั้งจากแอป ผ่าน MQTT — ดูหมายเหตุที่ PRIORITY_MEDIUM_INTERVAL_MS) ──
enum Priority : uint8_t { PRIORITY_HIGH = 0, PRIORITY_MEDIUM = 1, PRIORITY_LOW = 2 };
static const char* PRIORITY_NAME[] = { "high", "medium", "low" };

struct DeviceSlot {
    bool     inUse = false;
    int      regIdx = -1;                  // ชี้กลับไปที่ registry
    NimBLEClient* client = nullptr;
    NimBLERemoteCharacteristic* txChar = nullptr;
    char     macUp[18];                    // ตัวพิมพ์ใหญ่ ใช้ใน payload ให้ตรงกับฝั่ง Pi

    SlotPhase phase = PH_FREE;
    uint32_t phaseAt = 0;                  // เวลาเข้าสถานะปัจจุบัน (millis)

    // ตัวจับเวลางานประจำ
    uint32_t lastData = 0, lastKeepalive = 0, lastBatt = 0, lastRssi = 0;

    // off-wrist / freeze (ตรรกะเดียวกับ Python)
    uint32_t hrZeroStart = 0;              // 0 = ไม่ได้นับอยู่
    int      lastHeart = -1;               // ค่า HR ครั้งก่อน (ใช้ดูว่าค้างไหม)
    uint16_t hrSameCount = 0;              // HR ซ้ำเป๊ะติดกันกี่ครั้ง
    float    tempBaseline = 0.0f;          // ค่าฐานอุณหภูมิตอนสวมอยู่
    float    tempFloor = 0.0f;             // อุณหภูมิต่ำสุดที่เจอระหว่างถอด
    bool     tempFloorInit = false;        // ตั้งค่า tempFloor แล้วหรือยัง
    uint8_t  onWristCount = 0;             // debounce ขาสวมกลับ
    uint32_t hrChangeAt[HR_CHANGES_FOR_ONWRIST] = {0};  // เวลาที่ HR เปลี่ยนค่า (วนทับ)
    uint32_t hrChangeSeq = 0;              // นับจำนวนครั้งที่เปลี่ยนทั้งหมด
    uint32_t offWristSince = 0;            // เวลาที่เริ่มถอด (0 = ยังสวมอยู่)
    bool     tempBaseInit = false;
    uint8_t  offWristCount = 0;
    bool     isWearing = true;
    bool     inSpo2 = false;
    uint8_t  lastSpo2 = 0;
    volatile bool spo2Ready = false;       // เซ็ตจาก notify callback
    uint16_t p2Frames = 0;                 // นับ frame ที่ได้รับระหว่างวัด SpO2 (ใช้วินิจฉัย)
    uint32_t p2Silence = 0;                // ช่วงเงียบยาวสุดระหว่างวัด (ms)
    uint32_t p2LastFrame = 0;
    uint32_t p2StartedAt = 0;              // เวลาที่เข้า Phase 2 ครั้งแรก (นับรวมทุกรอบวัดซ้ำ)
    uint32_t lastSpo2End = 0;
    uint8_t  spo2Recheck = 0;

    // ธงจาก BLE callback (ทำงานคนละ task — ห้ามเคลียร์ทรัพยากรใน callback)
    volatile bool gone = false;

    uint32_t lastPub[K_COUNT] = {0};       // rate limit ต่อ key
};
static DeviceSlot slots[MAX_DEVICES];

// ── ทะเบียนนาฬิกา (สถานะการค้นพบ + cooldown ต่อเรือน) ──
struct RegDevice {
    char macUp[18];
    char macLow[18];
    NimBLEAddress addr;
    volatile uint32_t lastSeen = 0;        // millis ที่เห็น advertisement ล่าสุด
    volatile int rssi = -127;
    bool inSlot = false;
    uint8_t failCount = 0;
    uint32_t nextAttempt = 0;              // ห้ามลองก่อนเวลานี้ (backoff/cooldown)
    bool lastOffWrist = false;             // สถานะ "ถอดแล้ว" ครั้งล่าสุด
                                           //   ⚠️ ต้องเก็บที่ทะเบียน ไม่ใช่ที่ slot
                                           //   เพราะ slot ถูกล้างทุกครั้งที่ต่อใหม่
                                           //   ถ้าไม่เก็บ พอ reconnect จะกลับเป็น "สวมอยู่"
                                           //   แล้วส่ง temp จริงออกไป = ค่าเด้งบน Dashboard
    uint8_t priority = PRIORITY_HIGH;      // ตั้งจากแอป — ค่าเริ่มต้น high = พฤติกรรมเดิมทุกประการ
};
static RegDevice registry[MAX_REGISTERED];
static int  numRegistered = 0;             // จำนวนจริงที่ใช้อยู่
static bool haveNodeList  = false;         // เคยได้รายชื่อเฉพาะโหนดแล้วหรือยัง
static bool sawAppRoster  = false;        // เคยได้รายชื่อ MAC จากแอปเราบน broker นี้แล้วหรือยัง
static bool listDirty     = true;          // ต้องรายงานรายชื่อปัจจุบันกลับขึ้น MQTT
static Preferences prefs;

// ── คิวส่ง frame จาก BLE callback → loop() ──
//    notify มาบน task ของ NimBLE ถ้า publish MQTT ตรงนั้นจะชนกับ loop()
//    (PubSubClient ไม่ thread-safe) จึงส่งผ่านคิวมาประมวลผลใน loop แทน
struct BleFrame { uint8_t slot; uint8_t len; uint8_t data[28]; };
static QueueHandle_t frameQueue;

static WiFiClient   wifiClient;
static PubSubClient mqtt(wifiClient);

static uint32_t lastConnectAttempt = 0;    // stagger การ connect
static uint32_t lastMqttAttempt = 0;
static uint32_t lastHeartbeat = 0;
static uint32_t lastStatusLog = 0;
static bool     scanRunning = false;

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

static void macToUpper(const char* in, char* out) {
    for (int i = 0; i < 17 && in[i]; i++) out[i] = toupper(in[i]);
    out[17] = 0;
}
static void macToLower(const char* in, char* out) {
    for (int i = 0; i < 17 && in[i]; i++) out[i] = tolower(in[i]);
    out[17] = 0;
}

// สร้าง frame คำสั่ง 16 ไบต์: 15 ไบต์แรก + checksum (ผลรวม & 0xFF)
// — เหมือน _create_command ของ Python เป๊ะ
static void buildCmd(const uint8_t* bytes, size_t n, uint8_t out[16]) {
    memset(out, 0, 16);
    memcpy(out, bytes, n > 15 ? 15 : n);
    uint8_t crc = 0;
    for (int i = 0; i < 15; i++) crc += out[i];
    out[15] = crc;
}

// เขียนคำสั่งไปที่ TX — คืน false ถ้าเขียนไม่ได้ (มักแปลว่าหลุดแล้ว)
static bool writeCmd(DeviceSlot& s, std::initializer_list<uint8_t> bytes) {
    if (!s.txChar || s.gone) return false;
    uint8_t frame[16];
    uint8_t tmp[15]; size_t i = 0;
    for (uint8_t b : bytes) { if (i < 15) tmp[i++] = b; }
    buildCmd(tmp, i, frame);
    if (!s.txChar->writeValue(frame, 16, false)) {
        Serial.printf("[W] %s เขียนคำสั่งไม่ได้ (หลุดแล้ว?)\n", s.macUp);
        return false;
    }
    return true;
}

// ประทับเวลาแบบเดียวกับ Python: "YYYY-MM-DD HH:MM:SS"

static void timeStr(char* out, size_t n) {
    time_t now = time(nullptr);
    // ถ้ายังไม่ได้เทียบเวลา อย่าส่งปี 1970 ออกไปเงียบ ๆ
    // ให้ส่งค่าที่ฝั่งเซิร์ฟเวอร์มองออกทันทีว่า "เวลานี้เชื่อไม่ได้"
    if (now < 1600000000) {
        snprintf(out, n, "1970-01-01 00:00:00");
        return;
    }
    struct tm tmv;
    localtime_r(&now, &tmv);
    strftime(out, n, "%Y-%m-%d %H:%M:%S", &tmv);
}
static bool timeSynced() { return time(nullptr) > 1600000000; }   // > ปี 2020 = sync แล้ว

// uuid4 จาก esp_random() (แทน uuid.uuid4() ของ Python)
static void makeUuid(char* out37) {
    uint32_t a = esp_random(), b = esp_random(), c = esp_random(), d = esp_random();
    snprintf(out37, 37, "%08lx-%04lx-4%03lx-%04lx-%04lx%08lx",
             (unsigned long)a,
             (unsigned long)(b >> 16),
             (unsigned long)(b & 0x0FFF),
             (unsigned long)(0x8000 | ((c >> 16) & 0x3FFF)),
             (unsigned long)(c & 0xFFFF),
             (unsigned long)d);
}

// ═══════════════════════════════════════════════════════════════════
// DEVICE LIST — รับรายชื่อ MAC จากฐานข้อมูลผ่าน MQTT retained message
//
//   ทำไมไม่ใช้การ poll ทุก 10-15 วิ:
//     • retained message มาถึงภายใน ~1 วินาทีหลังแก้ใน DB (เร็วกว่า 10-15 วิ)
//     • ไม่ต้องยิงคำขอซ้ำๆ  → ประหยัดเวลาใช้คลื่นที่ต้องแบ่งกับ BLE
//     • broker เก็บข้อความไว้ให้ → โหนดที่เพิ่งบูตได้รายชื่อทันทีที่ต่อติด
//     • ไม่ต้องเปิด endpoint HTTP เพิ่ม
// ═══════════════════════════════════════════════════════════════════
static int findRegistry(const char* macUp) {
    for (int i = 0; i < numRegistered; i++)
        if (strcmp(registry[i].macUp, macUp) == 0) return i;
    return -1;
}

static bool addToRegistry(const char* mac) {
    if (numRegistered >= MAX_REGISTERED) return false;
    if (strlen(mac) != 17) return false;                 // ต้องเป็น AA:BB:CC:DD:EE:FF
    char up[18]; macToUpper(mac, up);
    if (findRegistry(up) >= 0) return false;             // กันซ้ำ
    RegDevice& r = registry[numRegistered];
    r = RegDevice();
    macToUpper(mac, r.macUp);
    macToLower(mac, r.macLow);
    numRegistered++;
    return true;
}

// ตัดการเชื่อมต่อของเรือนที่ถูกถอดออกจากรายชื่อ
static void dropSlotByRegIdx(int regIdx);

// ── ดึง MAC ออกจาก payload โดยไม่สนรูปแบบ ──
//    รองรับทุกแบบที่ฝั่งเว็บส่งมาได้ตามสะดวก:
//      CSV        : "AA:BB:CC:DD:EE:01,AA:BB:CC:DD:EE:02"
//      JSON array : ["AA:BB:CC:DD:EE:01","AA:BB:CC:DD:EE:02"]
//      ขึ้นบรรทัดใหม่ / เว้นวรรค / มีวงเล็บปีกกาครอบ ก็ได้หมด
//
//    ⚠️ ข้อตกลง: ส่งมาเฉพาะ MAC ที่ต้องการให้โหนดนี้เชื่อมเท่านั้น
//       อย่าใส่ MAC อื่นปนมาในข้อความเดียวกัน (เช่น รายการที่เพิ่งลบ)
//       เพราะตัวดึงจะเก็บ MAC ทุกตัวที่เจอในข้อความ
static bool isMacAt(const char* p) {
    for (int i = 0; i < 17; i++) {
        if (i % 3 == 2) { if (p[i] != ':' && p[i] != '-') return false; }
        else            { if (!isxdigit((unsigned char)p[i]))       return false; }
    }
    // ต้องไม่มีตัวอักษร hex ต่อท้าย (กันจับพลาดจากสตริงที่ยาวกว่า)
    return !isxdigit((unsigned char)p[17]);
}

static int extractMacs(const char* payload, char out[][18], int maxOut) {
    int n = 0;
    size_t len = strlen(payload);
    for (size_t i = 0; i + 17 <= len && n < maxOut; ) {
        if (isMacAt(payload + i)) {
            for (int k = 0; k < 17; k++) {
                char c = payload[i + k];
                out[n][k] = (k % 3 == 2) ? ':' : toupper((unsigned char)c);   // แปลง - เป็น : ด้วย
            }
            out[n][17] = 0;
            n++;
            i += 17;
        } else {
            i++;
        }
    }
    return n;
}

// นำรายชื่อใหม่มาใช้ "ทันที" โดยไม่ต้องรีบูต
//   - เรือนที่ถูกลบออก → ตัดการเชื่อมต่อทิ้ง
//   - เรือนที่เพิ่มเข้ามา → เริ่มค้นหาและเชื่อมต่อในรอบถัดไป
//   - เรือนที่ยังอยู่เหมือนเดิม → ไม่แตะต้อง (ไม่ให้ข้อมูลขาดช่วง)
static bool applyDeviceList(const char* payload, const char* src) {
    char incoming[MAX_REGISTERED][18];
    int  nIn = extractMacs(payload, incoming, MAX_REGISTERED);

    if (nIn == 0) {
        // ป้องกันข้อมูลเสีย/ข้อความว่างมาล้างทะเบียนจนระบบตายทั้งวอร์ด
        Serial.printf("[LIST] จาก %s ไม่พบ MAC ที่ใช้ได้เลย — คงรายชื่อเดิมไว้\n", src);
        return false;
    }

    // ── ถอดเรือนที่ไม่อยู่ในรายชื่อใหม่ ──
    int removed = 0;
    for (int i = numRegistered - 1; i >= 0; i--) {
        bool keep = false;
        for (int j = 0; j < nIn; j++)
            if (strcmp(registry[i].macUp, incoming[j]) == 0) { keep = true; break; }
        if (keep) continue;

        Serial.printf("[LIST] ถอด %s ออกจากทะเบียน\n", registry[i].macUp);
        dropSlotByRegIdx(i);                     // ตัดการเชื่อมต่อถ้ากำลังต่ออยู่
        for (int k = i; k < numRegistered - 1; k++) registry[k] = registry[k + 1];
        numRegistered--;
        removed++;
        // index ของ slot ที่ชี้มาที่ registry ต้องเลื่อนตาม
        for (auto& s : slots) if (s.inUse && s.regIdx > i) s.regIdx--;
    }

    // ── เพิ่มเรือนใหม่ ──
    int added = 0;
    for (int j = 0; j < nIn; j++)
        if (addToRegistry(incoming[j])) { added++; Serial.printf("[LIST] เพิ่ม %s\n", incoming[j]); }

    Serial.printf("[LIST] อัปเดตจาก %s → รวม %d เรือน (เพิ่ม %d ถอด %d)\n",
                  src, numRegistered, added, removed);

    // จำไว้ใน NVS เผื่อบูตครั้งหน้าตอน broker ยังไม่พร้อม
    // เก็บเป็น CSV ที่ normalize แล้ว ไม่ใช่ payload ดิบ (เล็กกว่าและอ่านง่ายกว่า)
    String store;
    for (int i = 0; i < numRegistered; i++) {
        if (i) store += ",";
        store += registry[i].macUp;
    }
    prefs.begin("naid", false);
    prefs.putString("devices", store);
    prefs.end();

    listDirty = true;        // ให้รายงานกลับขึ้น MQTT ในรอบถัดไป
    return true;
}

// ── รับ priority ต่อเรือนจากแอป ──
//   ใช้ isMacAt() ตัวเดิมหา MAC ในข้อความ แล้วอ่านคำถัดไปเป็น priority
//   (h.../high → HIGH, m.../medium → MEDIUM, l.../low → LOW, อื่น ๆ/ไม่มี → HIGH)
//   ⚠️ ค่าที่จำแนกไม่ได้ตีเป็น HIGH เสมอ — ปลอดภัยกว่า (พลาดไปวัดถี่เกินดีกว่าห่างเกิน)
//   MAC ที่ยังไม่อยู่ในทะเบียน (จาก applyDeviceList) จะถูกข้าม — priority ไม่สร้างเรือนใหม่เอง
static Priority parsePriorityWord(const char* p, size_t len) {
    if (len == 0) return PRIORITY_HIGH;
    switch (tolower((unsigned char)p[0])) {
        case 'm': return PRIORITY_MEDIUM;
        case 'l': return PRIORITY_LOW;
        default:  return PRIORITY_HIGH;
    }
}

static bool applyPriorityList(const char* payload, const char* src) {
    size_t len = strlen(payload);
    int applied = 0;
    for (size_t i = 0; i + 17 <= len; ) {
        if (!isMacAt(payload + i)) { i++; continue; }

        char mac[18];
        for (int k = 0; k < 17; k++) {
            char c = payload[i + k];
            mac[k] = (k % 3 == 2) ? ':' : toupper((unsigned char)c);
        }
        mac[17] = 0;
        i += 17;

        while (i < len && (payload[i] == ':' || payload[i] == '"' ||
                            payload[i] == ' ' || payload[i] == '=')) i++;
        size_t wstart = i;
        while (i < len && isalpha((unsigned char)payload[i])) i++;

        int idx = findRegistry(mac);
        if (idx >= 0) {
            registry[idx].priority = parsePriorityWord(payload + wstart, i - wstart);
            applied++;
        }
    }
    if (applied > 0)
        Serial.printf("[PRIORITY] จาก %s → ปรับ priority %d เรือน\n", src, applied);
    else
        Serial.printf("[PRIORITY] จาก %s ไม่พบ MAC ที่ตรงกับทะเบียนเลย\n", src);
    return applied > 0;
}

// โหลดรายชื่อตอนบูต: NVS ก่อน ถ้าไม่มีค่อยใช้ค่าสำรองใน firmware
static void loadRegistryAtBoot() {
    numRegistered = 0;
    prefs.begin("naid", true);
    String csv = prefs.getString("devices", "");
    prefs.end();

    if (csv.length() >= 17) {
        char tmp[MAX_REGISTERED][18];
        int n = extractMacs(csv.c_str(), tmp, MAX_REGISTERED);
        for (int i = 0; i < n; i++) addToRegistry(tmp[i]);
        Serial.printf("ทะเบียน: ใช้รายชื่อที่จำไว้ %d เรือน (รอ MQTT อัปเดต)\n", numRegistered);
    }
    if (numRegistered == 0) {
        for (int i = 0; i < NUM_FALLBACK; i++) addToRegistry(FALLBACK_DEVICES[i]);
        Serial.printf("ทะเบียน: ใช้ค่าสำรองใน firmware %d เรือน\n", numRegistered);
    }
}

// ═══════════════════════════════════════════════════════════════════
// OTA + สั่งงานระยะไกล
// ═══════════════════════════════════════════════════════════════════
// RTC memory อยู่รอดข้ามการรีเซ็ต (แต่หายเมื่อถอดไฟ) — ใช้นับว่ารีบูตเองกี่ครั้ง
RTC_NOINIT_ATTR static uint32_t rtcBootCount;
RTC_NOINIT_ATTR static uint32_t rtcMagic;
#define RTC_MAGIC_VALUE 0xA1D0001u

static const char* resetReasonText() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON:  return "เสียบไฟใหม่";
        case ESP_RST_SW:       return "สั่งรีบูตจากโปรแกรม";
        case ESP_RST_PANIC:    return "โปรแกรมแครช (panic)";
        case ESP_RST_INT_WDT:  return "🔴 Interrupt watchdog (ISR ค้าง)";
        case ESP_RST_TASK_WDT: return "🔴 Task watchdog (loop ค้าง)";
        case ESP_RST_WDT:      return "🔴 watchdog อื่น";
        case ESP_RST_BROWNOUT: return "🔴 ไฟตก (brownout) — ตรวจอะแดปเตอร์/สายไฟ";
        case ESP_RST_EXT:      return "กดปุ่ม reset";
        case ESP_RST_DEEPSLEEP:return "ตื่นจาก deep sleep";
        default:               return "ไม่ทราบสาเหตุ";
    }
}

static bool otaReady = false;          // เริ่ม ArduinoOTA แล้วหรือยัง
static volatile bool otaBusy = false;      // ระหว่างอัปเดต หยุดงานอื่นทั้งหมด
static uint32_t pendingRebootAt = 0;
static String   activeMqttBroker;
static bool     brokerOnTrial         = false;  // กำลังทดลอง broker ตัวใหม่อยู่
static uint32_t brokerOkSince         = 0;      // ต่อ broker ทดลองติดมาตั้งแต่เมื่อไร
static bool     brokerRollbackPending = false;  // ต้องแจ้งกลับว่า rollback แล้ว
static bool     brokerTrialAnnounced  = false;  // แจ้ง broker_trial ไปแล้วหรือยัง (แจ้งครั้งเดียว)

static void nlog(const char* fmt, ...) {
    char b[200];
    va_list ap; va_start(ap, fmt);
    vsnprintf(b, sizeof(b), fmt, ap);
    va_end(ap);
    Serial.println(b);
    if (mqtt.connected()) {                // ส่งขึ้น MQTT ด้วย เพราะปกติไม่มีใครเสียบ USB เฝ้าดู
        char t[64];
        snprintf(t, sizeof(t), "%s/node/%s/log", MQTT_BASE_TOPIC, NODE_ID);
        mqtt.publish(t, b);
    }
}

static void publishOtaStatus(const char* state, const char* detail) {
    if (!mqtt.connected()) return;
    char t[64], p[256];
    snprintf(t, sizeof(t), "%s/node/%s/ota", MQTT_BASE_TOPIC, NODE_ID);
    snprintf(p, sizeof(p), "{\"state\":\"%s\",\"detail\":\"%s\",\"version\":\"%s\"}",
             state, detail, FW_VERSION);
    mqtt.publish(t, p);
    mqtt.loop();                           // ดันออกทันทีก่อนจะไปทำงานหนัก
}

static void slotCleanupFwd(DeviceSlot& s, bool graceful);   // นิยามจริงอยู่ด้านล่าง

static void doHttpOta(const char* url) {
    nlog("[OTA] เริ่มอัปเดตจาก %s", url);
    publishOtaStatus("start", url);
    otaBusy = true;

    // ปลด BLE ทั้งหมดก่อน — คืน RAM และไม่ให้แย่งคลื่นระหว่างโหลดไฟล์
    NimBLEDevice::getScan()->stop();
    scanRunning = false;
    for (auto& s : slots) if (s.inUse) slotCleanupFwd(s, true);
    delay(300);

    WiFiClient client;
    httpUpdate.rebootOnUpdate(false);      // จะรีบูตเองหลังแจ้งผลแล้ว
    httpUpdate.setLedPin(-1);
    t_httpUpdate_return ret = httpUpdate.update(client, url);

    switch (ret) {
        case HTTP_UPDATE_OK:
            publishOtaStatus("success", "กำลังรีบูตเข้าเฟิร์มแวร์ใหม่");
            nlog("[OTA] ✅ สำเร็จ — รีบูต");
            delay(500);
            ESP.restart();
            break;
        case HTTP_UPDATE_NO_UPDATES:
            publishOtaStatus("no_update", "เซิร์ฟเวอร์ไม่มีไฟล์ใหม่");
            break;
        default: {
            char e[128];
            snprintf(e, sizeof(e), "code=%d %s", httpUpdate.getLastError(),
                     httpUpdate.getLastErrorString().c_str());
            publishOtaStatus("failed", e);
            nlog("[OTA] ❌ ล้มเหลว %s (เฟิร์มแวร์เดิมยังอยู่ครบ)", e);
            break;
        }
    }
    otaBusy = false;                       // ล้มเหลว → กลับไปทำงานปกติต่อ
}

// ตรวจว่าเป็น IPv4 ที่ใช้ได้จริง — กัน admin พิมพ์ผิดแล้วเครื่องหลุดจากระบบถาวร
static bool isUsableBrokerAddr(const String& s) {
    if (s.length() < 7 || s.length() >= 48) return false;
    if (s.indexOf(':') >= 0) return false;              // ปฏิเสธ IPv6 — โหนดใช้ IPv4 เท่านั้น
    int dots = 0;
    for (size_t i = 0; i < s.length(); i++) {
        char c = s[i];
        if (c == '.') dots++;
        else if (c < '0' || c > '9') return false;      // อนุญาตแค่ตัวเลขกับจุด
    }
    if (dots != 3) return false;
    IPAddress probe;
    if (!probe.fromString(s)) return false;
    if (probe[0] == 0) return false;                    // 0.x.x.x
    if (probe[0] == 127) return false;                  // loopback
    if (probe[0] == 255 || probe[3] == 255) return false; // broadcast
    return true;
}

// คำสั่งเป็นข้อความธรรมดา ส่งด้วย mosquitto_pub ได้ตรง ๆ ไม่ต้องมี GUI
static void handleCommand(const char* cmd) {
    nlog("[CMD] รับคำสั่ง: %s", cmd);

    if (strncmp(cmd, "name ", 5) == 0) {
        // ตั้งชื่อที่จำง่ายแทนชื่อจาก MAC เช่น  name ward-a-1
        //   ⚠️ ต้องไม่ซ้ำกับโหนดอื่น และห้ามมี / หรือเว้นวรรค (ใช้ใน MQTT topic)
        String nm = String(cmd + 5); nm.trim();
        if (nm.length() < 1 || nm.length() >= sizeof(NODE_ID)) {
            nlog("[CMD] ชื่อต้องยาว 1-%d ตัว", (int)sizeof(NODE_ID) - 1); return;
        }
        if (nm.indexOf('/') >= 0 || nm.indexOf(' ') >= 0 || nm.indexOf('+') >= 0
            || nm.indexOf('#') >= 0) {
            nlog("[CMD] ชื่อห้ามมี / เว้นวรรค + หรือ # (ใช้ใน MQTT topic)"); return;
        }
        prefs.begin("naid", false); prefs.putString("nodename", nm); prefs.end();
        nlog("[CMD] ตั้งชื่อเป็น '%s' — รีบูตเพื่อใช้งาน", nm.c_str());
        pendingRebootAt = millis() + 2000;

    } else if (strcmp(cmd, "name-reset") == 0) {
        prefs.begin("naid", false); prefs.remove("nodename"); prefs.end();
        nlog("[CMD] ล้างชื่อที่ตั้งไว้ — จะกลับไปใช้ชื่อจาก MAC หลังรีบูต");
        pendingRebootAt = millis() + 2000;

    } else if (strncmp(cmd, "wifi-add ", 9) == 0) {
        // เพิ่ม WiFi ชุดใหม่ "โดยไม่ลบของเดิม" — ใช้เตรียมไว้ก่อนวันเปลี่ยนเครือข่าย
        //   psk  : wifi-add psk  <ssid> <password>
        //   open : wifi-add open <ssid>
        //   peap : wifi-add peap <ssid> <username> <password>
        //   ttls : wifi-add ttls <ssid> <username> <password>
        //   ⚠️ ทุกฟิลด์ห้ามมีเว้นวรรค (ใช้เว้นวรรคเป็นตัวแยก)
        char a[5][80] = {{0}};
        int  na = 0;
        const char* q = cmd + 9;
        while (*q && na < 5) {
            while (*q == ' ') q++;
            if (!*q) break;
            const char* sp = strchr(q, ' ');
            size_t len = sp ? (size_t)(sp - q) : strlen(q);
            if (len >= sizeof(a[0])) len = sizeof(a[0]) - 1;
            memcpy(a[na], q, len); a[na][len] = 0; na++;
            q = sp ? sp + 1 : q + strlen(q);
        }
        if (na < 2) { nlog("[CMD] ใช้: wifi-add <psk|open|peap|ttls> <ssid> ..."); return; }

        WifiCred c;
        c.auth = authFromName(String(a[0]));
        c.ssid = a[1];
        if (c.auth == AUTH_PEAP || c.auth == AUTH_TTLS) {
            if (na < 4) { nlog("[CMD] enterprise ต้องมี <ssid> <username> <password>"); return; }
            c.username = a[2];
            c.identity = a[2];        // ส่วนใหญ่ identity = username
            c.pass     = a[3];
        } else if (c.auth == AUTH_PSK) {
            if (na < 3) { nlog("[CMD] psk ต้องมีรหัสผ่าน"); return; }
            c.pass = a[2];
        }
        wifiListAdd(c);
        nlog("[CMD] เพิ่ม '%s' (%s) แล้ว — จะใช้อัตโนมัติเมื่อชุดปัจจุบันใช้ไม่ได้",
             c.ssid.c_str(), AUTH_NAME[c.auth]);

    } else if (strcmp(cmd, "wifi-list") == 0) {
        wifiListPrint();

    } else if (strcmp(cmd, "wifi-reset") == 0) {
        // ล้างค่า WiFi ที่บันทึกไว้ → บูตหน้าถัดไปจะเปิดหน้าเว็บให้ตั้งใหม่
        // ⚠️ ใช้ตอนย้ายโหนดไปโรงพยาบาลอื่น หรือโรงพยาบาลเปลี่ยนรหัส WiFi
        //    หลังสั่งแล้วโหนดจะออฟไลน์ ต้องไปตั้งค่าที่หน้างานเท่านั้น
        nlog("[CMD] ล้างค่า WiFi แล้ว — รีบูตเข้าโหมดตั้งค่า");
        {
            WiFiManager wm;
            wm.resetSettings();
        }
        pendingRebootAt = millis() + 2000;

    } else if (strcmp(cmd, "reboot") == 0) {
        nlog("[CMD] จะรีบูตใน 2 วินาที");
        pendingRebootAt = millis() + 2000;

    } else if (strcmp(cmd, "status") == 0 || strcmp(cmd, "version") == 0) {
        int links = 0;
        for (auto& s : slots) if (s.inUse) links++;
        nlog("[CMD] เวอร์ชัน %s · เชื่อม %d/%d เรือน · heap %lu · IP %s",
             FW_VERSION, links, MAX_DEVICES,
             (unsigned long)ESP.getFreeHeap(), WiFi.localIP().toString().c_str());

    } else if (strncmp(cmd, "ota ", 4) == 0) {
        bool brokerArmed = false;
        const char* p = cmd + 4;
        while (*p == ' ') p++;
        // หาช่องว่างตัวถัดไป (คั่นระหว่าง url กับ broker_ip)
        const char* spacePtr = strchr(p, ' ');
        String url;
        String newBroker = "";
        
        if (spacePtr != nullptr) {
            url = String(p).substring(0, spacePtr - p);
            newBroker = String(spacePtr + 1);
            newBroker.trim();
        } else {
            url = String(p);
        }

        if (url.startsWith("http://") || url.startsWith("https://")) {
            if (newBroker.length() > 0) {
                if (!isUsableBrokerAddr(newBroker)) {
                    nlog("[OTA] ❌ broker IP ไม่ถูกต้อง: %s — ยกเลิกทั้งคำสั่ง", newBroker.c_str());
                    publishOtaStatus("failed", "broker ip ไม่ถูกต้อง");
                    return;
                }
                if (newBroker != activeMqttBroker) {
                    prefs.begin("naid", false);
                    // บอร์ดที่ไม่เคยย้าย broker ยังไม่มีคีย์นี้ใน NVS — ถ้าไม่ตรึงไว้ตอนนี้
                    // ตอนถอยกลับจะไปได้ค่า default ของเฟิร์มแวร์ใหม่ ซึ่งไม่เคยพิสูจน์ว่าต่อติด
                    if (prefs.getString("mqtt_broker", "").length() == 0)
                        prefs.putString("mqtt_broker", activeMqttBroker);
                    prefs.putString("mqtt_broker_try", newBroker);   // ไม่ทับตัวที่ยืนยันแล้ว
                    brokerArmed = true;
                    prefs.putUChar("mqtt_try_boots", 0);
                    prefs.end();
                    nlog("[OTA] ตั้ง broker ทดลอง %s (ตัวเดิมยังเก็บไว้เป็นทางถอย)", newBroker.c_str());
                }
            }
            doHttpOta(url.c_str());
            // มาถึงบรรทัดนี้ = doHttpOta ไม่ได้รีบูต → อัปเดตไม่สำเร็จ
            // ต้องปลด broker ทดลองออก ไม่ให้ไปโดนใช้ตอนรีบูตรอบหน้าโดยไม่ตั้งใจ
            if (brokerArmed) {
                prefs.begin("naid", false);
                prefs.remove("mqtt_broker_try");
                prefs.remove("mqtt_try_boots");
                prefs.end();
                nlog("[OTA] อัปเดตไม่สำเร็จ → ปลด broker ทดลองออกแล้ว");
            }
        } else {
            nlog("[CMD] URL ไม่ถูกต้อง ต้องขึ้นต้นด้วย http:// หรือ https://");
        }

    } else if (strncmp(cmd, "broker ", 7) == 0) {
        String nb = String(cmd + 7); nb.trim();
        if (!isUsableBrokerAddr(nb)) {
            nlog("[CMD] broker IP ไม่ถูกต้อง: %s", nb.c_str());
            publishOtaStatus("failed", "broker ip ไม่ถูกต้อง");
            return;
        }
        if (nb == activeMqttBroker) { nlog("[CMD] broker เดิมอยู่แล้ว ไม่ต้องเปลี่ยน"); return; }
        prefs.begin("naid", false);
        if (prefs.getString("mqtt_broker", "").length() == 0)
            prefs.putString("mqtt_broker", activeMqttBroker);
        prefs.putString("mqtt_broker_try", nb);
        prefs.putUChar("mqtt_try_boots", 0);
        prefs.end();
        nlog("[CMD] ตั้ง broker ทดลอง %s — รีบูตเพื่อทดลองใช้", nb.c_str());
        publishOtaStatus("broker_trial", nb.c_str());
        pendingRebootAt = millis() + 2000;

    } else {
        nlog("[CMD] ไม่รู้จักคำสั่ง | ใช้ได้: status, version, reboot, ota <url>, "
             "wifi-add <psk|open|peap|ttls> <ssid> ..., wifi-list, wifi-reset, "
             "name <ชื่อ>, name-reset");
    }
}

static void setupArduinoOTA() {
    static char host[32];
    snprintf(host, sizeof(host), "naid-%s", NODE_ID);
    ArduinoOTA.setHostname(host);
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.onStart([]() {
        otaBusy = true;
        NimBLEDevice::getScan()->stop();
        scanRunning = false;
        for (auto& s : slots) if (s.inUse) slotCleanupFwd(s, true);
        Serial.println("[OTA] เริ่มรับเฟิร์มแวร์ (push)");
    });
    ArduinoOTA.onProgress([](unsigned int p, unsigned int t) {
        static int last = -1;
        int pct = t ? (int)(p * 100 / t) : 0;
        if (pct / 10 != last) { last = pct / 10; Serial.printf("[OTA] %d%%\n", pct); }
    });
    ArduinoOTA.onEnd([]()   { Serial.println("[OTA] ✅ สำเร็จ — รีบูต"); });
    ArduinoOTA.onError([](ota_error_t e) {
        Serial.printf("[OTA] ❌ error %u\n", e);
        otaBusy = false;
    });
    ArduinoOTA.begin();
    Serial.printf("[OTA] พร้อมรับ push ที่ %s.local (พอร์ต 3232)\n", host);
}

// ── รับข้อความจาก MQTT ──
static void mqttCallback(char* topic, byte* payload, unsigned int len) {
    // วินิจฉัย: พิมพ์ทุกข้อความที่เข้ามา ใช้แยกสาเหตุเวลาไม่ได้รับรายชื่อ
    //   ไม่มีบรรทัดนี้เลย   = ข้อความไม่ถึงเครื่อง (ไม่ได้ retain / ACL / คนละ broker)
    //   มีแต่ไม่ถูกใช้      = topic ไม่ตรงกับที่โค้ดรอ
    Serial.printf("[MQTT-RX] %s (%u ไบต์)\n", topic, len);
    if (len == 0 || len > 900) {
        Serial.println("[MQTT-RX] ⚠️ ขนาดไม่เข้าเกณฑ์ — ทิ้ง");
        return;
    }
    static char buf[901];
    memcpy(buf, payload, len);
    buf[len] = 0;

    // คำสั่งควบคุมมาก่อน
    if (strcmp(topic, TOPIC_CMD_NODE) == 0 || strcmp(topic, TOPIC_CMD_ALL) == 0) {
        handleCommand(buf);
        return;
    }

    // priority — คนละ topic กับรายชื่อ MAC เพราะเป็นข้อมูลคนละก้อนที่เปลี่ยนคนละจังหวะกัน
    if (strcmp(topic, TOPIC_PRIORITY_NODE) == 0 || strcmp(topic, TOPIC_PRIORITY_ALL) == 0) {
        applyPriorityList(buf, strcmp(topic, TOPIC_PRIORITY_NODE) == 0
                               ? "priority เฉพาะโหนด" : "priority รวม");
        return;
    }

    bool isNode = (strcmp(topic, TOPIC_DEVICES_NODE) == 0);
    bool isAll  = (strcmp(topic, TOPIC_DEVICES_ALL)  == 0);

    // รายชื่อเฉพาะโหนดสำคัญกว่ารายชื่อรวม — ถ้าได้ของเฉพาะแล้วก็ไม่ต้องสนของรวม
    if (isAll && haveNodeList) {
        Serial.println("[LIST] ข้ามรายชื่อรวม เพราะมีรายชื่อเฉพาะโหนดแล้ว");
        return;
    }
    if (!isNode && !isAll) {
        Serial.printf("[MQTT-RX] topic ไม่ตรงกับที่รออยู่ — ข้าม\n");
        return;
    }
    // ข้อความมาถึง topic รายชื่อ = broker นี้มีข้อมูลที่แอปเรา publish ไว้จริง
    // (ble/mac ส่งแบบ retained) ใช้เป็นหลักฐานว่าไม่ใช่ broker ตัวอื่นที่บังเอิญรับ
    // connection ได้ — ตั้งก่อน parse เพราะรายชื่อว่าง (DB ยังไม่จับคู่) ก็ยังนับ
    sawAppRoster = true;

    if (applyDeviceList(buf, isNode ? "รายชื่อเฉพาะโหนด" : "รายชื่อรวม") && isNode)
        haveNodeList = true;
}

// รายงานว่า "ตอนนี้โหนดนี้ถือรายชื่ออะไรอยู่จริง" — ส่งแบบ retained
//   มีไว้ให้ฝั่งเว็บ/ผู้ดูแลตรวจสอบได้ว่า DB กับ ESP32 ตรงกันไหม
//   สำคัญเมื่อไม่มีตัว sync คอยไล่ตรวจให้ ถ้าเว็บลืมส่ง MQTT จะเห็นความต่างตรงนี้
static void reportActiveList() {
    if (!listDirty || !mqtt.connected()) return;
    listDirty = false;

    char payload[MAX_REGISTERED * 18 + 8];
    int  pos = 0;
    for (int i = 0; i < numRegistered && pos < (int)sizeof(payload) - 20; i++) {
        pos += snprintf(payload + pos, sizeof(payload) - pos, "%s%s",
                        i ? "," : "", registry[i].macUp);
    }
    payload[pos] = 0;

    char topic[64];
    snprintf(topic, sizeof(topic), "%s/node/%s/devices", MQTT_BASE_TOPIC, NODE_ID);
    mqtt.publish(topic, payload, true);      // retained
    Serial.printf("[LIST] รายงานรายชื่อที่ใช้อยู่ %d เรือน → %s\n", numRegistered, topic);
}

// ═══════════════════════════════════════════════════════════════════
// จัดการรายชื่อ WiFi ที่จำไว้ (เก็บใน NVS namespace "naid" คีย์ wifi_list)
//   รูปแบบที่เก็บ: ssid1\tpass1\nssid2\tpass2\n...
//   ใช้ \t และ \n เป็นตัวคั่นเพราะ SSID/รหัสผ่านมี , และ ; ได้
// ═══════════════════════════════════════════════════════════════════
// รูปแบบที่เก็บใน NVS (1 บรรทัด = 1 เครือข่าย, คั่นฟิลด์ด้วย \t):
//    ssid \t auth \t pass \t identity \t username
//    auth: psk | open | peap | ttls
//  ใช้ \t เพราะ SSID และรหัสผ่านมี , ; : ได้ แต่มี tab ไม่ได้
// ═══════════════════════════════════════════════════════════════════
// ตั้งชื่อโหนด — ลำดับความสำคัญ: ชื่อที่ตั้งไว้เอง > ค่าใน firmware > จาก MAC
// ═══════════════════════════════════════════════════════════════════
// คืน 3 ไบต์ "ท้าย" ของ MAC เรียงตามที่พิมพ์บนตัวบอร์ด
//
//   ⚠️ ห้ามใช้ ESP.getEfuseMac() & 0xFFFFFF เด็ดขาด
//      ฟังก์ชันนั้นคืนค่าโดยสลับลำดับไบต์ การ & 0xFFFFFF จึงได้ 3 ไบต์ "แรก"
//      ซึ่งคือ OUI (รหัสผู้ผลิต) — เหมือนกันทุกบอร์ดที่ผลิตล็อตเดียวกัน → ชื่อชนกัน
//      ตัวอย่างจริง: MAC 7C:4F:AD:79:98:70 → ได้ 0xAD4F7C (คือ 7C:4F:AD กลับด้าน)
//
//   esp_read_mac() คืน byte array เรียงถูกต้องอยู่แล้ว จึงหยิบ mac[3..5] ตรง ๆ ได้
static uint32_t macSuffix24() {
    uint8_t mac[6] = {0};
    if (esp_read_mac(mac, ESP_MAC_WIFI_STA) != ESP_OK) return 0;
    return ((uint32_t)mac[3] << 16) | ((uint32_t)mac[4] << 8) | mac[5];
}

static void resolveNodeId() {
    prefs.begin("naid", true);
    String saved = prefs.getString("nodename", "");
    prefs.end();

    if (saved.length() > 0 && saved.length() < sizeof(NODE_ID)) {
        strncpy(NODE_ID, saved.c_str(), sizeof(NODE_ID) - 1);
        Serial.printf("ชื่อโหนด: %s (ตั้งไว้ผ่านคำสั่ง name)\n", NODE_ID);
    } else if (strlen(NODE_ID_FIXED) > 0) {
        strncpy(NODE_ID, NODE_ID_FIXED, sizeof(NODE_ID) - 1);
        Serial.printf("ชื่อโหนด: %s (กำหนดตายตัวใน firmware)\n", NODE_ID);
    } else {
        // 3 ไบต์ท้ายของ MAC — ส่วนที่ต่างกันจริงในแต่ละบอร์ด
        snprintf(NODE_ID, sizeof(NODE_ID), "n%06lx", (unsigned long)macSuffix24());
        Serial.printf("ชื่อโหนด: %s (ตั้งอัตโนมัติจาก MAC)\n", NODE_ID);
    }

    // topic ที่มีชื่อโหนดอยู่ข้างใน ต้องสร้างหลังรู้ชื่อแล้วเท่านั้น
    snprintf(TOPIC_CMD_NODE,     sizeof(TOPIC_CMD_NODE),     "%s/node/%s/cmd", MQTT_BASE_TOPIC, NODE_ID);
    snprintf(TOPIC_DEVICES_NODE, sizeof(TOPIC_DEVICES_NODE), "%s/mac/%s",      MQTT_BASE_TOPIC, NODE_ID);
    snprintf(TOPIC_PRIORITY_NODE, sizeof(TOPIC_PRIORITY_NODE), "%s/priority/%s", MQTT_BASE_TOPIC, NODE_ID);
}

static String wifiListLoad() {
    prefs.begin("naid", true);
    String v = prefs.getString("wifi_list", "");
    prefs.end();
    return v;
}
static void wifiListSave(const String& v) {
    prefs.begin("naid", false);
    prefs.putString("wifi_list", v);
    prefs.end();
}

static WifiAuth authFromName(const String& n) {
    for (uint8_t i = 0; i < 4; i++)
        if (n.equalsIgnoreCase(AUTH_NAME[i])) return (WifiAuth)i;
    return AUTH_PSK;
}

// แยก 1 บรรทัดเป็น WifiCred — คืน false ถ้ารูปแบบไม่ถูก
static bool parseCredLine(const String& line, WifiCred& c) {
    int f[4], n = 0, from = 0;
    while (n < 4) {
        int t = line.indexOf('\t', from);
        if (t < 0) break;
        f[n++] = t; from = t + 1;
    }
    if (n < 1) return false;                       // อย่างน้อยต้องมี ssid+auth
    c.ssid = line.substring(0, f[0]);
    if (c.ssid.length() == 0) return false;
    c.auth     = authFromName(n >= 2 ? line.substring(f[0]+1, f[1]) : line.substring(f[0]+1));
    c.pass     = (n >= 3) ? line.substring(f[1]+1, f[2]) : "";
    c.identity = (n >= 4) ? line.substring(f[2]+1, f[3]) : "";
    c.username = (n >= 4) ? line.substring(f[3]+1)       : "";
    return true;
}

static String credToLine(const WifiCred& c) {
    return c.ssid + "\t" + AUTH_NAME[c.auth] + "\t" + c.pass + "\t"
         + c.identity + "\t" + c.username + "\n";
}

// เพิ่มชุดใหม่ไว้บนสุด (SSID ซ้ำ = ทับของเดิม)
static bool wifiListAdd(const WifiCred& c) {
    if (c.ssid.length() == 0) return false;
    String list = wifiListLoad(), out = credToLine(c);
    int kept = 1, start = 0;
    while (start < (int)list.length() && kept < WIFI_MAX_SAVED) {
        int nl = list.indexOf('\n', start);
        if (nl < 0) break;
        String line = list.substring(start, nl);
        start = nl + 1;
        WifiCred old;
        if (!parseCredLine(line, old)) continue;
        if (old.ssid == c.ssid) continue;          // ทับของเดิม
        out += line + "\n";
        kept++;
    }
    wifiListSave(out);
    Serial.printf("[WIFI-LIST] เพิ่ม '%s' (%s) — จำไว้ %d ชุด\n",
                  c.ssid.c_str(), AUTH_NAME[c.auth], kept);
    return true;
}

// เชื่อมต่อ 1 ชุด รองรับทุกแบบ — คืน true ถ้าติด
static bool wifiTryConnect(const WifiCred& c) {
    Serial.printf("[WiFi] ลอง '%s' (%s) ... ", c.ssid.c_str(), AUTH_NAME[c.auth]);
    WiFi.disconnect(true, false);
    delay(150);

    if (c.auth == AUTH_PEAP || c.auth == AUTH_TTLS) {
        // ⚠️ Enterprise ต้องตั้งค่า "ก่อน" WiFi.begin() และห้ามส่งรหัสใน begin()
        String id = c.identity.length() ? c.identity : c.username;
        esp_wifi_sta_wpa2_ent_set_identity((uint8_t*)id.c_str(), id.length());
        esp_wifi_sta_wpa2_ent_set_username((uint8_t*)c.username.c_str(), c.username.length());
        esp_wifi_sta_wpa2_ent_set_password((uint8_t*)c.pass.c_str(), c.pass.length());
        if (c.auth == AUTH_TTLS)
            esp_wifi_sta_wpa2_ent_set_ttls_phase2_method(ESP_EAP_TTLS_PHASE2_MSCHAPV2);
        esp_wifi_sta_wpa2_ent_enable();
        WiFi.begin(c.ssid.c_str());
    } else {
        // ปิด Enterprise เผื่อชุดก่อนหน้าเปิดค้างไว้ ไม่งั้น PSK จะเชื่อมไม่ติด
        esp_wifi_sta_wpa2_ent_disable();
        if (c.auth == AUTH_OPEN) WiFi.begin(c.ssid.c_str());
        else                     WiFi.begin(c.ssid.c_str(), c.pass.c_str());
    }

    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_TRY_TIMEOUT_MS) {
        delay(250);
        esp_task_wdt_reset();
    }
    bool ok = (WiFi.status() == WL_CONNECTED);
    Serial.println(ok ? "✅" : "❌");
    return ok;
}

// ไล่ลองทุกชุดที่จำไว้ตามลำดับ
static bool wifiConnectFromList() {
    String list = wifiListLoad();
    int start = 0, n = 0;
    while (start < (int)list.length()) {
        int nl = list.indexOf('\n', start);
        if (nl < 0) break;
        String line = list.substring(start, nl);
        start = nl + 1;
        WifiCred c;
        if (!parseCredLine(line, c)) continue;
        n++;
        if (wifiTryConnect(c)) return true;
    }
    if (n == 0) Serial.println("[WiFi] ยังไม่มีชุดที่จำไว้");
    return false;
}

static void wifiListPrint() {
    String list = wifiListLoad();
    int start = 0, n = 0; String out;
    while (start < (int)list.length()) {
        int nl = list.indexOf('\n', start);
        if (nl < 0) break;
        WifiCred c;
        if (parseCredLine(list.substring(start, nl), c))
            out += String(++n) + "." + c.ssid + "(" + AUTH_NAME[c.auth] + ") ";
        start = nl + 1;
    }
    nlog("[WIFI-LIST] จำไว้ %d ชุด: %s", n, n ? out.c_str() : "(ว่าง)");
}

static void subscribeDeviceList() {
    // เช็คผลจริง — subscribe ล้มเหลวได้เงียบ ๆ เช่นโดน ACL ปฏิเสธ
    bool okNode = mqtt.subscribe(TOPIC_DEVICES_NODE);
    bool okAll  = mqtt.subscribe(TOPIC_DEVICES_ALL);
    Serial.printf("[MQTT] subscribe %s → %s\n", TOPIC_DEVICES_NODE, okNode ? "✅" : "❌");
    Serial.printf("[MQTT] subscribe %s → %s\n", TOPIC_DEVICES_ALL,  okAll  ? "✅" : "❌");
    mqtt.subscribe(TOPIC_CMD_NODE);        // รับคำสั่งเฉพาะโหนดนี้
    mqtt.subscribe(TOPIC_CMD_ALL);         // รับคำสั่งที่ยิงถึงทุกโหนด
    Serial.printf("[MQTT] รับคำสั่งที่ %s และ %s\n", TOPIC_CMD_NODE, TOPIC_CMD_ALL);
    mqtt.subscribe(TOPIC_PRIORITY_NODE);
    mqtt.subscribe(TOPIC_PRIORITY_ALL);
    Serial.printf("[MQTT] รอ priority จาก %s และ %s\n", TOPIC_PRIORITY_NODE, TOPIC_PRIORITY_ALL);
    Serial.printf("[MQTT] รอรายชื่อจาก %s และ %s\n", TOPIC_DEVICES_NODE, TOPIC_DEVICES_ALL);
}


//   {"value": X, "mac": "AA:BB:..", "time": "...", "uuid": "..."}
// ═══════════════════════════════════════════════════════════════════
static void publishMetric(DeviceSlot& s, PubKey key, float value, bool isFloat) {
    uint32_t now = millis();
    if (now - s.lastPub[key] < MQTT_PUBLISH_INTERVAL_MS) return;   // rate limit
    s.lastPub[key] = now;
    if (!mqtt.connected()) return;

    char ts[24];  timeStr(ts, sizeof(ts));
    char uid[40]; makeUuid(uid);
    char val[16];
    if (isFloat) snprintf(val, sizeof(val), "%.1f", value);
    else         snprintf(val, sizeof(val), "%d", (int)value);

    char topic[48];
    snprintf(topic, sizeof(topic), "%s/%s", MQTT_BASE_TOPIC, PUB_KEY_NAME[key]);
    char payload[160];
    snprintf(payload, sizeof(payload),
             "{\"value\": %s, \"mac\": \"%s\", \"time\": \"%s\", \"uuid\": \"%s\"}",
             val, s.macUp, ts, uid);
    mqtt.publish(topic, payload);
}

// ── ส่งชุด "สวมอยู่" (ตรรกะเดียวกับ _publish_wearing) ──
static void publishWearing(DeviceSlot& s, int heart, float temp) {
    publishMetric(s, K_TEMP, temp, true);
    publishMetric(s, K_STATUS, 1, false);

    // HR Freeze — งดส่ง HR=0 ชั่วคราวหลังวัด SpO2 (กันกราฟตกหลอกๆ)
    bool freeze = (heart == 0) &&
                  (millis() - s.lastSpo2End <= HR_FREEZE_AFTER_SPO2_MS) &&
                  (s.lastSpo2End != 0);
    if (!freeze) publishMetric(s, K_HEART, heart, false);

    // ส่ง SpO2 ล่าสุดซ้ำทุกรอบ ให้ dashboard เห็นค่าต่อเนื่อง
    if (s.lastSpo2 > 0) publishMetric(s, K_SPO2, s.lastSpo2, false);
}

// ── ส่งชุด "ถอดแล้ว" (ตรรกะเดียวกับ _publish_off_wrist) ──
static void publishOffWrist(DeviceSlot& s) {
    s.lastSpo2 = 0;
    publishMetric(s, K_STATUS, 0, false);
    publishMetric(s, K_HEART, 0, false);
    publishMetric(s, K_TEMP, 0, false);
    publishMetric(s, K_SPO2, 0, false);
}

// ═══════════════════════════════════════════════════════════════════
// PARSER — ตรรกะเดียวกับ _parse_data / _detect_off_wrist ของ Python
//   ทำงานใน loop() (ดึงจากคิว) ไม่ใช่ใน BLE callback
// ═══════════════════════════════════════════════════════════════════
static void processFrame(DeviceSlot& s, const uint8_t* d, uint8_t len) {
    uint32_t nowF = millis();
    // วัดพฤติกรรมนาฬิการะหว่าง Phase 2 — ใช้ตอบว่า "เงียบจริงไหม" ในบันทึก
    if (s.phase >= PH_P2_STOPPING) {
        s.p2Frames++;
        if (s.p2LastFrame) {
            uint32_t gap = nowF - s.p2LastFrame;
            if (gap > s.p2Silence) s.p2Silence = gap;
        }
        s.p2LastFrame = nowF;
    }
    s.lastData = nowF;

    // 🟢 0x09 — HR & Temp (frame 25 ไบต์: byte21=HR, byte22-23 LE ÷10 = Temp)
    if (len >= 25 && d[0] == 0x09) {
        int   heart = d[21];
        float temp  = ((d[23] << 8) | d[22]) / 10.0f;
        if (temp < TEMP_VALID_MIN) return;                  // ค่าเพี้ยน ทิ้ง

        // ── ① ติดตามว่า HR "ค้าง" หรือไม่ ──
        //    ตอนสวมอยู่ ค่า HR จาก PPG จะแกว่งเสมอ (±1-3 bpm)
        //    การได้ค่าเดิมเป๊ะ ๆ ติดกันหลายครั้ง = sensor ไม่ได้อ่านของจริงแล้ว
        if (heart == s.lastHeart) { if (s.hrSameCount < 65535) s.hrSameCount++; }
        else {
            s.hrSameCount = 0;
            s.lastHeart = heart;
            // จดเวลาที่ค่าเปลี่ยน เฉพาะค่าที่อยู่ในช่วงชีพจรของคนจริง
            // (กันสัญญาณรบกวนที่กระโดดไปมานอกช่วงมานับเป็น "มีชีวิต")
            if (heart >= HR_PLAUSIBLE_MIN && heart <= HR_PLAUSIBLE_MAX) {
                s.hrChangeAt[s.hrChangeSeq % HR_CHANGES_FOR_ONWRIST] = millis();
                s.hrChangeSeq++;
            }
        }

        // ── ② สถานะ "สวมอยู่" กับ "ถอดแล้ว" ใช้เกณฑ์คนละชุด (hysteresis) ──
        //    ขาถอด  : ดูว่าอุณหภูมิ "ลดลงจากค่าฐาน" เท่าไหร่
        //    ขาสวมกลับ: ดูว่าอุณหภูมิ "สูงขึ้นจากจุดต่ำสุด" เท่าไหร่ + ถึงระดับผิวจริง
        //    แยกกันแบบนี้เพื่อไม่ให้สายรัดที่วางทิ้งไว้จนเย็นเท่าห้อง
        //    ถูกเข้าใจผิดว่าสวมกลับ (ค่าฐานจะไล่มาบรรจบกันเมื่ออุณหภูมิหยุดลด)

        // ตัวจับเวลา HR=0 (ยังเก็บไว้เผื่อนาฬิการุ่นที่ส่ง 0 จริง)
        if (heart > 0)            s.hrZeroStart = 0;
        else if (!s.inSpo2 && s.hrZeroStart == 0) s.hrZeroStart = millis();
        bool hrZeroLong = (s.hrZeroStart != 0) && !s.inSpo2 &&
                          (millis() - s.hrZeroStart > HR_ZERO_OFFWRIST_MS);
        bool hrFrozen = (s.hrSameCount >= HR_FROZEN_SAMPLES);
        bool wasWearing = s.isWearing;
        float tempDrop = 0.0f;

        if (s.isWearing) {
            // ─── กำลังสวมอยู่ → เฝ้าดูว่าถอดหรือยัง ───
            // ค่าฐาน: ขาขึ้นตามทันที ขาลงไล่ตามช้า
            if (!s.tempBaseInit)            { s.tempBaseline = temp; s.tempBaseInit = true; }
            else if (temp > s.tempBaseline)   s.tempBaseline = temp;
            else s.tempBaseline += (temp - s.tempBaseline) * TEMP_BASELINE_FALL_ALPHA;

            tempDrop = s.tempBaseline - temp;

            // ระหว่างวัด SpO2 นาฬิกาหยุดสตรีม HR เป็นปกติ — ห้ามตัดสินว่าถอดช่วงนั้น
            bool detectedOff = false;
            if (!s.inSpo2) {
                detectedOff =
                    (hrFrozen && tempDrop >= TEMP_DROP_WITH_HR) ||
                    (tempDrop >= TEMP_DROP_ALONE)               ||
                    (temp < TEMP_OFFWRIST_DEFINITE)             ||
                    (temp < TEMP_OFFWRIST_SUSPECT && hrZeroLong);
            }
            if (detectedOff) { if (s.offWristCount < 255) s.offWristCount++; }
            else               s.offWristCount = 0;

            if (s.offWristCount >= OFFWRIST_DEBOUNCE_COUNT) {
                s.isWearing = false;
                s.onWristCount = 0;
                s.tempFloor = temp;                 // เริ่มจับจุดต่ำสุดจากตรงนี้
                s.tempFloorInit = true;
                s.hrChangeSeq = 0;                  // เริ่มนับ HR มีชีวิตใหม่หมด
                s.offWristSince = millis();
            }
        } else {
            // ─── ถอดแล้ว → ต้องมีหลักฐานว่าสวมกลับจริงเท่านั้น ───
            // ค่าฐานถูกแช่ไว้ ไม่ให้ไล่ตามลงมาจนส่วนต่างหาย
            // ⚠️ ต้องใช้ธงกำกับ ห้ามเทียบกับค่า 0 ที่ยังไม่ได้ตั้ง
            //    ถ้า reconnect มาในสถานะถอด tempFloor ยังเป็น 0
            //    จะทำให้ (temp - 0) มากกว่าเกณฑ์เสมอ → เข้าใจผิดว่าสวมกลับทันที
            if (!s.tempFloorInit) { s.tempFloor = temp; s.tempFloorInit = true; }
            else if (temp < s.tempFloor) s.tempFloor = temp;

            bool rising    = (temp - s.tempFloor) >= TEMP_RISE_BACK;  // อุ่นขึ้นจากจุดต่ำสุด
            bool plausible = (temp >= TEMP_WEAR_MIN);                 // ถึงระดับสัมผัสผิวจริง

            // ── ชีพจรต้อง "มีชีวิต" ด้วย ──
            //    ครบจำนวนครั้งที่ต้องการ และครั้งที่เก่าสุดในกลุ่มต้องยังไม่เกินหน้าต่างเวลา
            //    = ค่าเปลี่ยนถี่พอในช่วงที่ผ่านมา ไม่ใช่เปลี่ยนนาน ๆ ครั้งจากสัญญาณรบกวน
            bool hrLive = false;
            if (s.hrChangeSeq >= HR_CHANGES_FOR_ONWRIST) {
                uint32_t oldest = s.hrChangeAt[s.hrChangeSeq % HR_CHANGES_FOR_ONWRIST];
                hrLive = (millis() - oldest) <= HR_LIVE_WINDOW_MS;
            }

            if (rising && plausible && hrLive) { if (s.onWristCount < 255) s.onWristCount++; }
            else                                 s.onWristCount = 0;

            if (s.onWristCount >= ONWRIST_DEBOUNCE_COUNT) {
                s.isWearing = true;
                s.offWristCount = 0;
                s.offWristSince = 0;
                s.tempBaseInit = false;             // ตั้งค่าฐานใหม่จากอุณหภูมิปัจจุบัน
                s.tempFloorInit = false;
                s.hrSameCount  = 0;
            }
        }

        if (wasWearing && !s.isWearing) {
            Serial.printf("[OFF-WRIST] %s ถอดแล้ว (HR ค้าง %u ครั้ง · temp ลด %.2f°C)\n",
                          s.macUp, s.hrSameCount, tempDrop);
        } else if (!wasWearing && s.isWearing) {
            Serial.printf("[ON-WRIST] %s สวมกลับแล้ว (temp %.2f°C ขึ้นจากต่ำสุด %.2f°C · HR เปลี่ยน %lu ครั้ง)\n",
                          s.macUp, temp, temp - s.tempFloor, (unsigned long)s.hrChangeSeq);
        }

        if (s.isWearing) publishWearing(s, heart, temp);
        else             publishOffWrist(s);
    }
    // 🔴 0x28 — SpO2 (byte3 = ค่า)
    else if (len >= 10 && d[0] == 0x28 && d[1] == 0x03) {
        uint8_t spo2 = d[3];
        if (spo2 > 0 && spo2 <= 100) {
            if (s.isWearing) {
                s.lastSpo2 = spo2;
                publishMetric(s, K_SPO2, spo2, false);
            }
            s.spo2Ready = true;
        }
    }
    // 🔋 0x13 — Battery
    else if (len >= 2 && d[0] == 0x13) {
        uint8_t batt = d[1];
        if (batt <= 100) publishMetric(s, K_BATT, batt, false);
    }
}

// ═══════════════════════════════════════════════════════════════════
// BLE CALLBACKS — ทำน้อยที่สุด แค่บันทึก/ส่งคิว/ตั้งธง
// ═══════════════════════════════════════════════════════════════════

// scan เจอ advertisement → อัพเดตทะเบียน (เทียบ MAC ตัวพิมพ์เล็ก)
class ScanCB : public NimBLEScanCallbacks {
    void onResult(const NimBLEAdvertisedDevice* adv) override {
        std::string a = adv->getAddress().toString();
        for (int i = 0; i < numRegistered; i++) {
            if (a == registry[i].macLow) {
                registry[i].lastSeen = millis();
                registry[i].rssi = adv->getRSSI();
                registry[i].addr = adv->getAddress();
                break;
            }
        }
    }
} scanCB;

class ClientCB : public NimBLEClientCallbacks {
    void onDisconnect(NimBLEClient* c, int reason) override {
        for (auto& s : slots) {
            if (s.inUse && s.client == c) {
                s.gone = true;                       // เก็บกวาดจริงใน loop()
                Serial.printf("[BLE] %s หลุด (reason=%d)\n", s.macUp, reason);
                break;
            }
        }
    }
} clientCB;

// notify จากนาฬิกา → หา slot จาก client แล้วโยนเข้าคิว
static void onNotify(NimBLERemoteCharacteristic* chr, uint8_t* data, size_t len, bool) {
    // ⚠️ ต้องตรวจ null ทุกชั้น — callback นี้ทำงานบน task ของ NimBLE
    //    ถ้า loop() เพิ่งเรียก deleteClient() ไปพอดี ตัว service/characteristic
    //    จะถูกทำลายไปแล้ว → getRemoteService() คืน NULL → เรียกต่อจะแครชทันที
    //    (ESP32-C3 มีคอร์เดียว จังหวะชนกันบ่อยกว่า WROOM ที่มี 2 คอร์มาก)
    if (!chr || !data || len == 0) return;
    const NimBLERemoteService* svc = chr->getRemoteService();
    if (!svc) return;
    NimBLEClient* c = svc->getClient();
    if (!c) return;
    for (uint8_t i = 0; i < MAX_DEVICES; i++) {
        if (slots[i].inUse && slots[i].client == c) {
            BleFrame f;
            f.slot = i;
            f.len = len > sizeof(f.data) ? sizeof(f.data) : (uint8_t)len;
            memcpy(f.data, data, f.len);
            xQueueSend(frameQueue, &f, 0);           // เต็มก็ทิ้ง (frame ถัดไปมาแทน)
            break;
        }
    }
}

// ═══════════════════════════════════════════════════════════════════
// SCAN MANAGEMENT — เปิดเฉพาะตอนมีช่องว่าง (slot เต็ม = ปิด ลดแย่ง radio)
// ═══════════════════════════════════════════════════════════════════
static int freeSlotCount() {
    int n = 0;
    for (auto& s : slots) if (!s.inUse) n++;
    return n;
}

static void manageScan() {
    bool want = freeSlotCount() > 0;
    if (want && !scanRunning) {
        NimBLEDevice::getScan()->start(0, false, true);   // 0 = ไม่จำกัดเวลา
        scanRunning = true;
        Serial.println("[SCAN] เริ่มค้นหา");
    } else if (!want && scanRunning) {
        NimBLEDevice::getScan()->stop();
        scanRunning = false;
        Serial.println("[SCAN] ครบทุกช่อง — หยุดค้นหา ลดการแย่ง radio");
    }
}

// ═══════════════════════════════════════════════════════════════════
// CONNECTOR — ต่อทีละเรือน มี stagger + backoff (แทน adapter lock ของ Python)
// ═══════════════════════════════════════════════════════════════════
static void slotCleanup(DeviceSlot& s, bool countAsFail);

// กวาดเรือนที่หลุดออกทันที — เรียกแทรกได้ทุกจุดที่เพิ่งกลับจากงานที่ block นาน
//   ปกติ s.gone ถูกจัดการใน serviceSlot() แต่ถ้า loop ติดอยู่ใน connect()
//   Dashboard จะช้าตามไปด้วยทั้งโหนด จึงต้องกวาดแทรกตรงนี้เพิ่ม
static void sweepGoneSlots() {
    for (auto& s : slots) {
        if (s.inUse && s.gone) {
            Serial.printf("[SWEEP] %s หลุด — ส่งค่า 0 ทันที ไม่รอรอบ loop\n", s.macUp);
            slotCleanup(s, false);
        }
    }
}

static void tryConnectNext() {
    uint32_t now = millis();
    if (now - lastConnectAttempt < CONNECT_STAGGER_MS) return;

    // หา slot ว่าง
    int si = -1;
    for (int i = 0; i < MAX_DEVICES; i++) if (!slots[i].inUse) { si = i; break; }
    if (si < 0) return;

    // เลือกเรือนที่: เห็นล่าสุด ≤30 วิ, สัญญาณ ≥ -85, ไม่ได้อยู่ใน slot, พ้น cooldown
    int best = -1;
    for (int i = 0; i < numRegistered; i++) {
        RegDevice& r = registry[i];
        if (r.inSlot) continue;
        if (now < r.nextAttempt) continue;
        if (r.lastSeen == 0 || now - r.lastSeen > STALE_DEVICE_MS) continue;
        if (r.rssi < RSSI_MIN_THRESHOLD) continue;
        if (best < 0 || r.rssi > registry[best].rssi) best = i;   // เอาตัวสัญญาณดีสุดก่อน
    }
    if (best < 0) return;

    lastConnectAttempt = now;
    RegDevice& r = registry[best];

    // หยุด scan ระหว่าง connect — GATT discovery จะนิ่งกว่า
    // (บทเรียนเดียวกับที่โค้ดพี่ทำบน Pi)
    if (scanRunning) { NimBLEDevice::getScan()->stop(); scanRunning = false; }

    Serial.printf("[CONNECT] %s (RSSI %d) ...\n", r.macUp, r.rssi);

    DeviceSlot& s = slots[si];
    s = DeviceSlot();                                 // ล้างค่าเริ่มต้นทั้งหมด
    s.client = NimBLEDevice::createClient();
    if (!s.client) {
        // 🔴 ต้นเหตุ Guru Meditation: createClient() คืน nullptr เมื่อถึงเพดานของ NimBLE
        //    (ไลบรารีจำกัดที่ CONFIG_BT_NIMBLE_MAX_CONNECTIONS ซึ่ง default = 3)
        //    ถ้าไม่ตรวจตรงนี้ บรรทัดถัดไปจะอ่านที่ offset ของ NULL แล้วแครชทันที
        Serial.printf("[CONNECT] ❌ %s สร้าง client ไม่ได้ — ถึงเพดาน NimBLE แล้ว "
                      "(ต่ออยู่ %d เรือน) ดูวิธีแก้ที่หมายเหตุ MAX_DEVICES\n",
                      r.macUp, MAX_DEVICES - freeSlotCount());
        s = DeviceSlot();
        r.nextAttempt = now + 30000;      // พักยาวหน่อย ไม่ต้องรีบลองซ้ำ
        return;
    }
    s.client->setClientCallbacks(&clientCB, false);
    s.client->setConnectTimeout(BLE_CONNECT_TIMEOUT_MS);

    // ⚠️ connect() เป็น blocking (สูงสุด 15 วิ) — เรือนอื่นที่ต่ออยู่ไม่กระทบ
    //    (notify เข้าคิวต่อเนื่อง) แต่ MQTT จะเว้นช่วงสั้นๆ ซึ่ง keepalive 30 วิ รับได้
    if (!s.client->connect(r.addr)) {                 // exchangeMTU=true อัตโนมัติ
        // เพิ่งกลับจากการ block นานถึง 8 วิ — ระหว่างนั้นอาจมีเรือนอื่นหลุดไปแล้ว
        // กวาดทันทีก่อนทำอย่างอื่น เพื่อให้ Dashboard ไม่ค้างแสดงเรือนที่หลุดไปแล้ว
        sweepGoneSlots();
        Serial.printf("[CONNECT] %s ล้มเหลว\n", r.macUp);
        NimBLEDevice::deleteClient(s.client);
        s.client = nullptr;
        r.failCount++;
        if (r.failCount >= FAIL_COUNT_FOR_COOLDOWN) {
            Serial.printf("[COOLDOWN] %s fail ครบ %d ครั้ง พัก %d วิ\n",
                          r.macUp, r.failCount, COOLDOWN_MS / 1000);
            r.nextAttempt = now + COOLDOWN_MS;
            r.failCount = 0;
        } else {
            r.nextAttempt = now + 2000UL * r.failCount;   // backoff 2,4,6,8 วิ
        }
        return;
    }

    // ต่อติด → หา service/characteristic แล้ว subscribe
    // (ขั้น service discovery ก็ block เช่นกัน จึงกวาดเรือนที่หลุดอีกรอบ)
    sweepGoneSlots();
    NimBLERemoteService* svc = s.client->getService(UUID_SERVICE);
    NimBLERemoteCharacteristic* rx = svc ? svc->getCharacteristic(UUID_RX) : nullptr;
    s.txChar = svc ? svc->getCharacteristic(UUID_TX) : nullptr;
    if (!rx || !s.txChar || !rx->subscribe(true, onNotify)) {
        Serial.printf("[CONNECT] %s ไม่พบ FFF6/FFF7 หรือ subscribe ไม่ได้\n", r.macUp);
        s.client->disconnect();
        NimBLEDevice::deleteClient(s.client);
        s = DeviceSlot();
        r.failCount++;
        r.nextAttempt = now + 5000;
        return;
    }

    s.inUse = true;
    s.regIdx = best;
    // กู้สถานะจากครั้งก่อน — ถ้าเดิมถอดอยู่ ต้องยังถือว่าถอด
    // ไม่งั้นทุกครั้งที่ต่อกลับ Dashboard จะเห็น temp เด้งขึ้นมาชั่วครู่
    if (r.lastOffWrist) {
        s.isWearing     = false;
        s.offWristSince = millis();
        s.tempFloor     = 0.0f;
        s.tempFloorInit = false;
        s.hrChangeSeq   = 0;
        Serial.printf("[STATE] %s ต่อกลับแล้ว แต่ครั้งก่อนยังถอดอยู่ — คงสถานะถอดไว้\n", r.macUp);
    }
    strncpy(s.macUp, r.macUp, sizeof(s.macUp));
    s.phase = PH_SETUP;
    s.phaseAt = millis();
    s.lastData = millis();
    r.inSlot = true;
    r.failCount = 0;
    Serial.printf("[CONNECT] ✅ %s (MTU=%d) — รอ notify พร้อม\n",
                  s.macUp, s.client ? s.client->getMTU() : 0);
}

// ═══════════════════════════════════════════════════════════════════
// SLOT FSM — แทน _keep_receiving ของ Python (Phase1 ↔ Phase2 ไม่ block)
// ═══════════════════════════════════════════════════════════════════
// ส่งค่า 0 ทุกตัวเมื่อเรือนหลุด/ถูกตัด เพื่อให้ dashboard รู้ทันทีว่าไม่มีข้อมูลแล้ว
//   ต้องล้าง lastPub ก่อน ไม่งั้นจะติด rate limit 1 วิ แล้วค่าไม่ถูกส่งออกไปเลย
//   (จังหวะที่หลุดมักอยู่ห่างจากการส่งครั้งก่อนไม่ถึง 1 วินาที)
static void publishDisconnected(DeviceSlot& s, const char* reason) {
    if (!mqtt.connected() || !s.inUse) return;
    for (int k = 0; k < K_COUNT; k++) s.lastPub[k] = 0;   // บังคับให้ส่งได้แน่นอน
    s.lastSpo2 = 0;
    publishMetric(s, K_STATUS, 0, false);
    publishMetric(s, K_HEART,  0, false);
    publishMetric(s, K_SPO2,   0, false);
    publishMetric(s, K_TEMP,   0, false);
    mqtt.loop();                                          // ดันออกทันที ก่อนจะตัด BLE
    Serial.printf("[MQTT] %s ส่งค่า 0 ทั้งหมด (สาเหตุ: %s)\n", s.macUp, reason);
}

static void slotCleanup(DeviceSlot& s, bool graceful);
static void slotCleanupFwd(DeviceSlot& s, bool graceful) { slotCleanup(s, graceful); }

static void slotCleanup(DeviceSlot& s, bool graceful) {
    // ส่งค่า 0 ก่อนเป็นอันดับแรก — ทำผ่าน WiFi เร็วกว่ารอ BLE disconnect
    publishDisconnected(s, graceful ? "ตัดการเชื่อมต่อ" : "อุปกรณ์หลุด");

    if (s.client) {
        if (graceful && s.client->isConnected()) {
            writeCmd(s, {0x09, 0x00, 0x00, 0x00});    // สั่งหยุดก่อนจาก (เหมือน finally ของ Python)
            writeCmd(s, {0x28, 0x03, 0x00});
            s.client->disconnect();
        }
        NimBLEDevice::deleteClient(s.client);
    }
    if (s.regIdx >= 0) {
        registry[s.regIdx].inSlot = false;
        registry[s.regIdx].lastOffWrist = !s.isWearing;   // จำไว้ใช้ตอนต่อกลับ
        registry[s.regIdx].nextAttempt = millis() + 3000;   // เว้นก่อนต่อใหม่
    }
    Serial.printf("[SLOT] %s ปิดช่องแล้ว\n", s.macUp);
    s = DeviceSlot();
}

// ตัดการเชื่อมต่อของเรือนที่ถูกถอดออกจากรายชื่อ (เรียกจาก applyDeviceList)
static void dropSlotByRegIdx(int regIdx) {
    for (auto& s : slots) {
        if (s.inUse && s.regIdx == regIdx) {
            Serial.printf("[LIST] %s ถูกถอดออก — ตัดการเชื่อมต่อ\n", s.macUp);
            slotCleanup(s, true);              // ส่งคำสั่งหยุดวัดก่อนแล้วค่อยตัด
            return;
        }
    }
}

static void serviceSlot(DeviceSlot& s) {
    if (!s.inUse) return;
    uint32_t now = millis();

    // หลุด (ธงจาก callback) → เก็บกวาด
    if (s.gone) { slotCleanup(s, false); return; }

// 💡 FIX: แยกเวลา Watchdog — ถ้ากำลังวัด SpO2 ให้รอได้สูงสุด 75 วิ แต่ถ้าปกติเอาแค่ 10 วิ
//   uint32_t currentWatchdogLimit = (s.phase >= PH_P2_STOPPING) ? PHASE2_TIMEOUT_MS : 10000;

    // watchdog: ไม่มีข้อมูลนานเกิน = connection ค้าง → ตัดทิ้ง (เหมือน _connection_watchdog)
    // watchdog: ไม่มีข้อมูลนานเกิน = connection ค้าง → ตัดทิ้ง
    //   ต้องแยกเพดานตามเฟส เพราะช่วงวัด SpO2 นาฬิกาอาจเงียบยาว 45-120 วิ
    //   ถ้าใช้เพดานเดียวกับ Phase 1 (15 วิ) จะตัดกลางคันทุกครั้งที่วัด SpO2
    //
    //   ช่วง Phase 2 ยังมีตัวคุมเวลาของตัวเองอยู่แล้ว (PHASE2_TIMEOUT_MS ใน PH_P2_MEASURING)
    //   watchdog ตรงนี้จึงเป็นแค่ตาข่ายชั้นสุดท้ายกันเคส connection ค้างจริงๆ
    uint32_t wdLimit = (s.phase >= PH_P2_STOPPING)
                       ? (PHASE2_TIMEOUT_MS + PHASE2_WATCHDOG_GRACE_MS)
                       : DATA_TIMEOUT_MS;

    // ถอดไว้นานเกินกำหนด → ตัดการเชื่อมต่อ คืน slot ให้เรือนที่มีคนใส่จริง
    //   ตั้ง cooldown ไว้ด้วย ไม่งั้นจะรีบต่อกลับทันทีแล้ววนซ้ำไม่จบ
    //   ระหว่าง cooldown เรายังเห็น advertisement อยู่ (รู้ว่าอยู่ในระยะ)
    //   แต่จะไม่รู้ว่ามีคนหยิบไปใส่หรือยัง จนกว่าจะต่อกลับไปอ่านอุณหภูมิ
    if (!s.isWearing && s.offWristSince != 0 &&
        now - s.offWristSince > OFFWRIST_DISCONNECT_MS) {
        Serial.printf("[OFF-WRIST] %s ถอดไว้เกิน %lu นาที → ตัดการเชื่อมต่อคืน slot\n",
                      s.macUp, (unsigned long)(OFFWRIST_DISCONNECT_MS / 60000));
        int reg = s.regIdx;                 // เก็บไว้ก่อน เพราะ slotCleanup จะล้าง slot ทิ้ง
        slotCleanup(s, true);
        // ⚠️ ต้องตั้ง cooldown "หลัง" slotCleanup เพราะข้างในมันเขียน nextAttempt
        //    เป็น +3 วินาทีเสมอ ถ้าตั้งก่อนจะโดนทับแล้วต่อกลับทันทีวนไม่จบ
        if (reg >= 0) registry[reg].nextAttempt = millis() + OFFWRIST_RECHECK_MS;
        return;
    }

    if (s.phase >= PH_PHASE1 && now - s.lastData > wdLimit) {
        Serial.printf("[WATCHDOG] %s เงียบเกิน %lu วิ (เฟส %d) → ตัดทิ้ง\n",
                      s.macUp, (unsigned long)(wdLimit / 1000), (int)s.phase);
        slotCleanup(s, true);
        return;
    }

    switch (s.phase) {
        case PH_SETUP:
            // Python: sleep 2 วิ หลัง start_notify ก่อนส่งคำสั่งแรก
            if (now - s.phaseAt >= 2000) {
                Serial.printf("[PHASE1] %s ▶️ เริ่มสตรีม HR/Temp\n", s.macUp);
                if (!writeCmd(s, {0x09, 0x01, 0x01, 0x00})) { s.gone = true; break; }
                s.phase = PH_PHASE1;
                s.phaseAt = now;
                s.lastKeepalive = now;
                s.lastBatt = 0;            // 0 = ให้ขอ battery ทันทีรอบแรก
                s.lastRssi = now;
            }
            break;

        case PH_PHASE1: {
            // keepalive 0x41 ทุก 30 วิ — กันนาฬิกาตัดเองเพราะ inactive
            if (now - s.lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
                s.lastKeepalive = now;
                if (!writeCmd(s, {0x41})) { s.gone = true; break; }
            }
            // battery 0x13 ทุก 60 วิ (อัพเดตเวลาก่อนส่ง — fail จะได้ไม่ยิงรัว, เหมือน Python)
            if (now - s.lastBatt >= BATTERY_READ_INTERVAL_MS) {
                s.lastBatt = now;
                if (!writeCmd(s, {0x13, 0x00})) { s.gone = true; break; }
            }
            // RSSI ของ connection ทุก 30 วิ (ESP32 อ่านตรงจาก controller ไม่ต้องใช้ hcitool)
            if (now - s.lastRssi >= RSSI_READ_INTERVAL_MS) {
                s.lastRssi = now;
                if (s.client && s.client->isConnected()) {
                    int rssi = s.client->getRssi();
                    if (rssi != 0) publishMetric(s, K_RSSI, rssi, false);
                }
            }
            // ครบ 90 วิ → เข้า Phase 2
            if (now - s.phaseAt >= PHASE1_DURATION_MS) {
                Serial.printf("[PHASE2] %s หยุด HR/Temp เตรียมวัด SpO2\n", s.macUp);
                s.inSpo2 = true;                       // กัน off-wrist false ระหว่างวัด
                s.p2Frames = 0; s.p2Silence = 0; s.p2LastFrame = 0;
                s.p2StartedAt = now;
                if (!writeCmd(s, {0x09, 0x00, 0x00, 0x00})) { s.gone = true; break; }
                s.phase = PH_P2_STOPPING;
                s.phaseAt = now;
                s.spo2Recheck = 0;
            }
            break;
        }

        case PH_P2_STOPPING:
            if (now - s.phaseAt >= 1500) {             // Python: sleep 1.5 วิ
                s.spo2Ready = false;
                if (!writeCmd(s, {0x28, 0x03, 0x01})) { s.gone = true; break; }
                Serial.printf("[SPO2] %s 🩸 เริ่มวัด (รอบ %d)\n", s.macUp, s.spo2Recheck + 1);
                s.phase = PH_P2_MEASURING;
                s.phaseAt = now;
            }
            break;

        case PH_P2_MEASURING:
            if (s.spo2Ready || now - s.phaseAt >= PHASE2_TIMEOUT_MS) {
                uint32_t took = now - s.phaseAt;
                if (s.spo2Ready)
                    Serial.printf("[SPO2] %s ✅ ได้ค่าแล้ว ใช้เวลา %lu วิ\n",
                                  s.macUp, (unsigned long)(took / 1000));
                else
                    Serial.printf("[SPO2] %s ⏱️ หมดเวลาที่ %lu วิ\n",
                                  s.macUp, (unsigned long)(took / 1000));
                // บอกว่านาฬิกาเงียบจริงไหมระหว่างวัด — ใช้ปรับ PHASE2_WATCHDOG_GRACE_MS ให้พอดี
                Serial.printf("[SPO2] %s   ระหว่างวัดได้รับ %u frame · เงียบยาวสุด %lu วิ\n",
                              s.macUp, s.p2Frames, (unsigned long)(s.p2Silence / 1000));
                writeCmd(s, {0x28, 0x03, 0x00});       // หยุดวัด
                s.lastSpo2End = now;                   // HR Freeze เริ่มนับจากตรงนี้
                s.phase = PH_P2_ENDING;
                s.phaseAt = now;
            }
            break;

        case PH_P2_ENDING:
            if (now - s.phaseAt >= 1500) {
                // ตรรกะ recheck เดียวกับ Python:
                //   ไม่ได้ค่าเลย → กลับ Phase 1
                //   ค่า < 95 และยังไม่ครบ 3 รอบ → วัดซ้ำ
                //   นอกนั้น → กลับ Phase 1
                bool budgetLeft = (s.p2StartedAt == 0) ||
                                  (now - s.p2StartedAt < PHASE2_TOTAL_BUDGET_MS);
                if (!budgetLeft && s.lastSpo2 != 0 && s.lastSpo2 < SPO2_LOW_THRESHOLD)
                    Serial.printf("[SPO2] %s ครบเพดานรวม %d วิ — เลิกวัดซ้ำ กลับไปวัด HR/Temp\n",
                                  s.macUp, PHASE2_TOTAL_BUDGET_MS / 1000);

                if (budgetLeft && s.lastSpo2 != 0 && s.lastSpo2 < SPO2_LOW_THRESHOLD &&
                    s.spo2Recheck + 1 < SPO2_LOW_RECHECK_MAX) {
                    s.spo2Recheck++;
                    Serial.printf("[SPO2 LOW] %s %d%% < %d%% → วัดซ้ำ (%d/%d)\n",
                                  s.macUp, s.lastSpo2, SPO2_LOW_THRESHOLD,
                                  s.spo2Recheck, SPO2_LOW_RECHECK_MAX);
                    s.phase = PH_P2_RECHECK_WAIT;
                    s.phaseAt = now;
                } else if (s.regIdx >= 0 && registry[s.regIdx].priority != PRIORITY_HIGH) {
                    // ── priority กลาง/ต่ำ + วัดครบรอบแล้ว (ไม่ใช่ระหว่างวัดซ้ำ SpO2 ต่ำ) ──
                    //    ตัดการเชื่อมต่อไปพักตาม interval แทนวนกลับ Phase 1 ไม่จบแบบ high
                    //    เพื่อประหยัดแบตนาฬิกา (ไม่มี BLE ค้าง + ไม่มี LED PPG ทำงานระหว่างพัก)
                    int reg = s.regIdx;
                    uint32_t interval = (registry[reg].priority == PRIORITY_MEDIUM)
                                       ? PRIORITY_MEDIUM_INTERVAL_MS : PRIORITY_LOW_INTERVAL_MS;
                    Serial.printf("[PRIORITY] %s วัดครบรอบแล้ว (priority=%s) → ตัดการเชื่อมต่อ พักไป %lu นาที\n",
                                  s.macUp, PRIORITY_NAME[registry[reg].priority],
                                  (unsigned long)(interval / 60000));
                    slotCleanup(s, true);
                    // ⚠️ ต้องตั้งหลัง slotCleanup เสมอ (pattern เดียวกับ OFFWRIST_RECHECK_MS
                    //    ด้านบน) เพราะข้างใน slotCleanup เขียน nextAttempt เป็น +3 วิเสมอ
                    //    ตั้งก่อนจะโดนทับแล้วต่อกลับทันทีแทนที่จะพักจริง
                    registry[reg].nextAttempt = millis() + interval;
                    return;
                } else {
                    // กลับ Phase 1
                    s.inSpo2 = false;
                    s.hrZeroStart = 0;                 // HR=0 ระหว่าง SpO2 ไม่นับ
                    Serial.printf("[PHASE1] %s ▶️ กลับมาสตรีม HR/Temp\n", s.macUp);
                    if (!writeCmd(s, {0x09, 0x01, 0x01, 0x00})) { s.gone = true; break; }
                    s.phase = PH_PHASE1;
                    s.phaseAt = now;
                }
            }
            break;

        case PH_P2_RECHECK_WAIT:
            if (now - s.phaseAt >= SPO2_LOW_RECHECK_DELAY_MS) {
                s.spo2Ready = false;
                if (!writeCmd(s, {0x28, 0x03, 0x01})) { s.gone = true; break; }
                s.phase = PH_P2_MEASURING;
                s.phaseAt = now;
            }
            break;

        default: break;
    }
}

// ═══════════════════════════════════════════════════════════════════
// WIFI + MQTT (reconnect แบบไม่ block ยาว)
// ═══════════════════════════════════════════════════════════════════
static void ensureNetwork() {
    if (WiFi.status() != WL_CONNECTED) return;         // WiFi หลุด → รอ auto-reconnect
    if (mqtt.connected()) { mqtt.loop(); return; }

    uint32_t now = millis();
    if (now - lastMqttAttempt < 5000) return;          // ลองใหม่ทุก 5 วิ
    lastMqttAttempt = now;

    char cid[40];
    snprintf(cid, sizeof(cid), "naid-%s-%06lx", NODE_ID, (unsigned long)macSuffix24());
    Serial.printf("[MQTT] เชื่อม %s:%d ...\n", activeMqttBroker.c_str(), MQTT_PORT);
    if (mqtt.connect(cid, MQTT_USER, MQTT_PASS)) {
        Serial.println("[MQTT] ✅ เชื่อมต่อแล้ว");
        {   // รายงานว่ารอบที่แล้วดับเพราะอะไร — ใช้ไล่หาสาเหตุจากที่นั่งได้เลย
            char t[64], p[220];
            snprintf(t, sizeof(t), "%s/node/%s/boot", MQTT_BASE_TOPIC, NODE_ID);
            snprintf(p, sizeof(p),
                     "{\"boot\":%lu,\"reason\":\"%s\",\"version\":\"%s\"}",
                     (unsigned long)rtcBootCount, resetReasonText(), FW_VERSION);
            mqtt.publish(t, p, true);       // retained — เปิดดูย้อนหลังได้
        }
        haveNodeList = false;                  // ให้ retained message ตัดสินใหม่ทุกครั้งที่ต่อใหม่
        sawAppRoster = false;                  // ให้ broker ใหม่ต้องพิสูจน์ตัวเองอีกครั้ง
        subscribeDeviceList();
    } else {
        Serial.printf("[MQTT] ❌ rc=%d\n", mqtt.state());
    }
}

// heartbeat ของโหนด (ของเพิ่มจากเวอร์ชัน Pi — จำเป็นเมื่อมีหลายโหนดในสนาม)
// ═══════════════════════════════════════════════════════════════════
// ble/esp32 — บอกว่า "โหนดนี้คือใคร และกำลังถือนาฬิกาเรือนไหนอยู่บ้าง"
//
//   ต่างจาก ble/node/<id> (heartbeat ทุก 60 วิ) ตรงที่ตัวนี้ส่งถี่ทุก 1 วินาที
//   และเน้นข้อมูลการจับคู่ ใช้ให้ฝั่งเซิร์ฟเวอร์รู้ว่าเรือนไหนอยู่กับโหนดไหน
//   โดยไม่ต้องรอ heartbeat รอบถัดไป
// ═══════════════════════════════════════════════════════════════════
static void publishEsp32Status() {
    static uint32_t lastSend = 0;
    uint32_t now = millis();
    if (now - lastSend < ESP32_STATUS_INTERVAL_MS) return;
    if (!mqtt.connected()) return;
    lastSend = now;

    // รวม MAC ของนาฬิกาที่กำลังเชื่อมอยู่ เป็น JSON array
    // ใช้เฉพาะ slot ที่ inUse และยังไม่ถูกตั้งธง gone (กำลังจะถูกเก็บกวาด)
    char devices[MAX_DEVICES * 21 + 4];
    int  pos = 0;
    int  count = 0;
    devices[pos++] = '[';
    for (auto& sl : slots) {
        if (!sl.inUse || sl.gone) continue;
        pos += snprintf(devices + pos, sizeof(devices) - pos,
                        "%s\"%s\"", count ? "," : "", sl.macUp);
        count++;
        if (pos >= (int)sizeof(devices) - 24) break;   // กัน buffer ล้น
    }
    devices[pos++] = ']';
    devices[pos]   = 0;

    char ts[24];  timeStr(ts, sizeof(ts));
    char uid[40]; makeUuid(uid);

    char topic[48];
    snprintf(topic, sizeof(topic), "%s/esp32", MQTT_BASE_TOPIC);

    char payload[MAX_DEVICES * 21 + 260];
    snprintf(payload, sizeof(payload),
             "{\"node_id\": \"%s\", \"mac\": \"%s\", \"ip\": \"%s\", "
             "\"devices\": %s, \"count\": %d, "
             "\"time\": \"%s\", \"uuid\": \"%s\"}",
             NODE_ID, WiFi.macAddress().c_str(), WiFi.localIP().toString().c_str(),
             devices, count, ts, uid);
    mqtt.publish(topic, payload);
}

static void publishHeartbeat() {
    uint32_t now = millis();
    if (now - lastHeartbeat < 60000 || !mqtt.connected()) return;
    lastHeartbeat = now;

    int links = 0;
    for (auto& s : slots) if (s.inUse) links++;
    char topic[48], payload[384];
    snprintf(topic, sizeof(topic), "%s/node/%s", MQTT_BASE_TOPIC, NODE_ID);
    snprintf(payload, sizeof(payload),
             "{\"uptime\": %lu, \"links\": %d, \"heap\": %lu, "
             "\"wifi_rssi\": %d, \"time_ok\": %d, \"boot_reason\": \"%s\", "
             "\"version\": \"%s\", \"ip\": \"%s\", "
             "\"mqtt_broker\": \"%s\", \"mqtt_port\": %d, \"max_devices\": %d}",
             (unsigned long)(now / 1000), links,
             (unsigned long)ESP.getFreeHeap(), WiFi.RSSI(), timeSynced() ? 1 : 0,
             resetReasonText(),
             FW_VERSION, WiFi.localIP().toString().c_str(),
             activeMqttBroker.c_str(), MQTT_PORT, MAX_DEVICES);
    mqtt.publish(topic, payload);
}

// ═══════════════════════════════════════════════════════════════════
// SETUP / LOOP
// ═══════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    // ⚠️ ESP32-C3/S3 ใช้ USB แบบ native (ไม่มีชิป USB-UART แยกเหมือน WROOM)
    //    ทุกครั้งที่รีเซ็ต การเชื่อมต่อ USB จะหลุดแล้ว enumerate ใหม่
    //    ถ้าพิมพ์เร็วเกินไป ข้อความช่วงต้นจะหายหมดจนดูเหมือน "เงียบสนิท"
    //    (บน WROOM ไม่มีปัญหานี้เพราะชิป CH340 ยังเปิดพอร์ตค้างไว้)
    {   uint32_t t0 = millis();
        while (!Serial && millis() - t0 < 2000) delay(10);
    }
    delay(500);
    Serial.println("\n════════════════════════════════════════");
    Serial.println("  NAid ESP32 Node — iStyle28 port");
    resolveNodeId();     // ต้องเรียกก่อนใช้ NODE_ID และก่อนสร้าง topic ใด ๆ
    Serial.printf("  โหนด: %s | จำกัด %d เรือนพร้อมกัน\n", NODE_ID, MAX_DEVICES);
    // นับจำนวนครั้งที่รีบูต (RTC memory อยู่รอดข้ามการรีเซ็ต แต่หายเมื่อถอดไฟ)
    if (rtcMagic != RTC_MAGIC_VALUE) { rtcMagic = RTC_MAGIC_VALUE; rtcBootCount = 0; }
    rtcBootCount++;
    Serial.printf("  บูตครั้งที่ %lu · สาเหตุ: %s\n",
                  (unsigned long)rtcBootCount, resetReasonText());

    // เปิด Task Watchdog ระดับชิป — ถ้า loop() ค้าง ชิปจะรีเซ็ตตัวเอง
    // ⚠️ API ต่างกันระหว่าง Arduino ESP32 core 2.x กับ 3.x
    //    2.x : esp_task_wdt_init(uint32_t timeout_sec, bool panic)
    //    3.x : esp_task_wdt_init(const esp_task_wdt_config_t*)   ← หน่วยเป็นมิลลิวินาที
    //    และบน 3.x ตัว TWDT ถูกเปิดไว้แล้วตั้งแต่บูต การเรียก init ซ้ำจะคืน
    //    ESP_ERR_INVALID_STATE จึงต้องใช้ esp_task_wdt_reconfigure() แทน
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
    esp_task_wdt_config_t twdtCfg = {
        .timeout_ms     = (uint32_t)WDT_TIMEOUT_SEC * 1000U,
        .idle_core_mask = 0,          // ไม่เฝ้า idle task — เฝ้าเฉพาะ loop ของเรา
        .trigger_panic  = true,       // ให้บันทึกสาเหตุไว้ อ่านได้ในรอบบูตถัดไป
    };
    // core 3.x เปิด TWDT ไว้ให้แล้วตั้งแต่บูต จึงลอง reconfigure ก่อน
    // (ถ้าเรียก init ก่อน ESP-IDF จะพิมพ์ error "TWDT already initialized"
    //  ออกมาทุกครั้งทั้งที่ไม่ได้ผิดอะไร ทำให้ log รกและชวนเข้าใจผิด)
    if (esp_task_wdt_reconfigure(&twdtCfg) != ESP_OK) {
        esp_task_wdt_init(&twdtCfg);          // เผื่อ core รุ่นที่ไม่ได้เปิดมาให้
    }
#else
    esp_task_wdt_init(WDT_TIMEOUT_SEC, true);
#endif
    // ⚠️ ยังไม่เรียก esp_task_wdt_add() ตรงนี้ — จะไปเรียกท้าย setup() แทน
    //    เพราะ setup() ใช้เวลานานถึง ~23 วิ (รอ WiFi 20 วิ + init BLE/mDNS)
    //    โดยไม่มีการป้อนอาหาร watchdog เลย ถ้า WiFi ช้ากว่าปกตินิดเดียว
    //    จะครบ 30 วิแล้วถูกรีเซ็ตกลางคัน → วนรีบูตไม่จบ → USB ไม่ทัน enumerate
    //    → มองจากภายนอกเหมือน "บอร์ดเงียบสนิท ไม่มี log อะไรเลย"
    Serial.printf("  Watchdog: จะเริ่มเฝ้าหลัง setup เสร็จ (timeout %d วิ)\n", WDT_TIMEOUT_SEC);
    Serial.println("════════════════════════════════════════");

    prefs.begin("naid", true);
    String confirmedBroker = prefs.getString("mqtt_broker", FIRMWARE_META.mqttBroker);
    String trialBroker     = prefs.getString("mqtt_broker_try", "");
    uint8_t trialBoots     = prefs.getUChar("mqtt_try_boots", 0);
    prefs.end();

    if (trialBroker.length() > 0 && trialBoots < BROKER_TRY_MAX_BOOTS) {
        // ⚠️ นับ "ก่อน" ลอง — ถ้าเครื่องค้างกลางทางจนถูก watchdog รีเซ็ต
        //    ตัวนับก็เดินแล้ว จึงไม่มีทางวนรีบูตไม่จบกับ broker ที่ผิด
        prefs.begin("naid", false);
        size_t counterWrote = prefs.putUChar("mqtt_try_boots", trialBoots + 1);
        prefs.end();
        if (counterWrote == 0) {
            // เขียนตัวนับไม่ได้ = ไม่มีทางรู้ว่าลองไปกี่รอบ ถ้าขืนลองต่อจะวนลอง
            // candidate เดิมทุกบูตไม่สิ้นสุด เลือกทางปลอดภัย: ไม่ทดลอง ใช้ตัวที่ยืนยันแล้ว
            activeMqttBroker = confirmedBroker;
            brokerOnTrial    = false;
            Serial.println("[MQTT] ⚠️ เขียนตัวนับ NVS ไม่ได้ → ไม่ทดลอง broker ใหม่ ใช้ตัวเดิม");
        } else {
            activeMqttBroker = trialBroker;
            brokerOnTrial    = true;
            Serial.printf("[MQTT] ทดลอง broker ใหม่ %s (ครั้งที่ %d/%d)\n",
                          trialBroker.c_str(), trialBoots + 1, BROKER_TRY_MAX_BOOTS);
        }
    } else {
        activeMqttBroker = confirmedBroker;
        if (trialBroker.length() > 0) {
            prefs.begin("naid", false);
            prefs.remove("mqtt_broker_try");
            prefs.remove("mqtt_try_boots");
            prefs.end();
            brokerRollbackPending = true;
            Serial.printf("[MQTT] broker ทดลองใช้ไม่ได้ → กลับไปใช้ %s\n", confirmedBroker.c_str());
        }
    }

    // ทะเบียนนาฬิกา — NVS ก่อน แล้วรอ MQTT ส่งรายชื่อจริงจากฐานข้อมูลมาทับ
    loadRegistryAtBoot();
    Serial.printf("ทะเบียน %d เรือน (โหนดนี้ต่อพร้อมกันได้ %d)\n", numRegistered, MAX_DEVICES);

    frameQueue = xQueueCreate(24, sizeof(BleFrame));

    // --- WiFi (ตั้งค่าผ่านหน้าเว็บด้วย WiFiManager) ---
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    // บอร์ด ESP32-C3 บางล็อตเสาอากาศแมตช์ไม่ดี ส่งแรงเกินจะทำให้ไฟตกและรีบูตวน
    // ต้องเรียก "หลัง" WiFi.mode() เท่านั้น ไม่งั้นคำสั่งจะล้มเหลวเงียบ ๆ
#if CONFIG_IDF_TARGET_ESP32C3
    WiFi.setTxPower(WIFI_POWER_8_5dBm);
#endif

    // กดปุ่ม BOOT ค้างไว้ตอนเปิดเครื่อง = ล้างค่า WiFi เข้าโหมดตั้งค่า
    bool forcePortal = false;
    pinMode(WM_RESET_PIN, INPUT_PULLUP);
    if (digitalRead(WM_RESET_PIN) == LOW) {
        Serial.printf("[WiFi] ตรวจพบการกดปุ่ม — กดค้างอีก %d วิเพื่อล้างค่า WiFi ",
                      WM_RESET_HOLD_MS / 1000);
        uint32_t t0 = millis();
        while (digitalRead(WM_RESET_PIN) == LOW && millis() - t0 < WM_RESET_HOLD_MS) {
            delay(200);
            if ((millis() - t0) % 1000 < 200) Serial.print(".");
        }
        if (digitalRead(WM_RESET_PIN) == LOW) {
            forcePortal = true;
            Serial.println(" ✅ จะเข้าโหมดตั้งค่า");
        } else {
            Serial.println(" ยกเลิก (ปล่อยเร็วเกินไป)");
        }
    }

    {
        WiFiManager wm;
        wm.setDebugOutput(false);                       // ลด log รก
        wm.setConnectTimeout(WM_CONNECT_TIMEOUT_SEC);   // รอเชื่อม WiFi เดิม
        wm.setConfigPortalTimeout(WM_PORTAL_TIMEOUT_SEC);
        wm.setAPCallback([](WiFiManager* mgr) {
            Serial.println("\n╔════════════════════════════════════════════════╗");
            Serial.println("║  ยังไม่ได้ตั้งค่า WiFi — เปิดโหมดตั้งค่าแล้ว      ║");
            Serial.printf ("║  1. เชื่อม WiFi ชื่อ : %-22s ║\n", mgr->getConfigPortalSSID().c_str());
            Serial.printf ("║     รหัสผ่าน        : %-22s ║\n", WM_AP_PASSWORD);
            Serial.println("║  2. เปิดเบราว์เซอร์ไปที่ http://192.168.4.1     ║");
            Serial.println("║  3. เลือก WiFi แล้วใส่รหัส                      ║");
            Serial.println("╚════════════════════════════════════════════════╝");
        });
        wm.setSaveConfigCallback([]() {
            Serial.println("[WiFi] ✅ บันทึกค่าแล้ว");
        });

        // ตั้งชื่อ AP ให้ไม่ซ้ำกันเวลามีหลายโหนดเปิดพร้อมกัน
        char apName[32];
        snprintf(apName, sizeof(apName), "NAid-Setup-%06lX", (unsigned long)macSuffix24());

        // ถ้าเคยตั้งค่าไว้แล้วจะเชื่อมอัตโนมัติ
        // ถ้ายังไม่เคย (หรือ WiFi เดิมหาย) จะเปิดหน้าเว็บให้ตั้งค่า
        // ── ลองชุดที่จำไว้ทั้งหมดก่อน (รองรับ psk/open/peap/ttls) ──
        //    ถ้าโรงพยาบาลเพิ่งเปลี่ยน WiFi แต่เราเพิ่มชุดใหม่ไว้ล่วงหน้าแล้ว
        //    ตรงนี้จะเกาะชุดใหม่ได้เองโดยไม่ต้องมีใครไปตั้งค่า
        bool ok = false;
        if (!forcePortal) ok = wifiConnectFromList();

        // ── ยังไม่ติด → ลองค่าที่ฝังมากับเฟิร์มแวร์ ──
        //    จำเป็นสำหรับบอร์ดที่เพิ่งแฟลชใหม่ (NVS ว่าง)
        //    ถ้าไม่มีขั้นนี้ ทุกเครื่องที่ผลิตจะต้องเปิดมือถือตั้งค่าทีละตัว
        //    ติดแล้วจะจำลง NVS ให้ ครั้งหน้าบูตจะใช้จากรายชื่อเลย ไม่ต้องลองซ้ำ
        if (!ok && !forcePortal && strlen(WIFI_SSID) > 0) {
            Serial.println("[WiFi] ลองค่าเริ่มต้นที่ฝังมากับเฟิร์มแวร์");
            WifiCred c;
            c.ssid = WIFI_SSID;
            c.pass = WIFI_PASS;
            c.auth = (strlen(WIFI_PASS) > 0) ? AUTH_PSK : AUTH_OPEN;
            ok = wifiTryConnect(c);
            if (ok) wifiListAdd(c);
        }

        if (ok) {
            // เชื่อมได้แล้วจากรายชื่อที่จำไว้ ไม่ต้องเรียก WiFiManager
        } else if (forcePortal) {
            wm.resetSettings();
            wifiListSave("");                   // ล้างรายชื่อที่จำไว้ด้วย
            ok = wm.startConfigPortal(apName, WM_AP_PASSWORD);
        } else {
            Serial.printf("[WiFi] กำลังเชื่อมต่อ (รอสูงสุด %d วิ)...\n", WM_CONNECT_TIMEOUT_SEC);
            ok = wm.autoConnect(apName, WM_AP_PASSWORD);
        }

        if (ok) {
            // จำชุดที่ใช้ได้ไว้ เผื่อวันหลังมีชุดอื่นเพิ่มเข้ามา
            if (WiFi.SSID().length() > 0) {
                WifiCred c;
                c.ssid = WiFi.SSID();
                c.pass = WiFi.psk();
                c.auth = c.pass.length() ? AUTH_PSK : AUTH_OPEN;
                wifiListAdd(c);        // หน้าเว็บตั้งได้แค่ PSK/open
            }
            Serial.printf("[WiFi] ✅ %s  IP: %s  RSSI: %d dBm\n",
                          WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
        } else {
            // หมดเวลารอแล้วไม่มีใครมาตั้งค่า → รีบูตไปเริ่มใหม่
            // ดีกว่าปล่อยให้ค้างอยู่เฉย ๆ โดยไม่มีใครรู้
            Serial.println("[WiFi] ⚠️ ตั้งค่าไม่สำเร็จ — รีบูตเพื่อลองใหม่");
            Serial.flush();
            delay(1000);
            ESP.restart();
        }
    }   // ปล่อย WiFiManager ทิ้งตรงนี้ คืน RAM ก่อนเริ่ม BLE

    // ⚠️ configTime() เป็นคำสั่งแบบ "สั่งแล้วจบ" ไม่ได้รอให้ sync เสร็จ
    //    การ sync จริงใช้เวลา 1-10 วินาที ถ้าไม่รอ ข้อความช่วงแรกจะได้เวลาปี 1970
    configTime(TZ_OFFSET_SEC, 0, NTP_SERVER1, NTP_SERVER2);
    // ตั้ง TZ ให้ชัดเจนอีกชั้น กันกรณี configTime ถูกเรียกซ้ำแล้ว offset หาย
    setenv("TZ", "ICT-7", 1);      // ไทย UTC+7 ไม่มี DST
    tzset();

    if (WiFi.status() == WL_CONNECTED) {
        Serial.print("[NTP] เทียบเวลา ");
        uint32_t t0 = millis();
        while (!timeSynced() && millis() - t0 < NTP_SYNC_TIMEOUT_MS) {
            delay(250);
            if ((millis() - t0) % 1000 < 250) Serial.print(".");
        }
        if (timeSynced()) {
            char ts[24]; timeStr(ts, sizeof(ts));
            Serial.printf(" ✅ %s\n", ts);
        } else {
            Serial.printf(" ⚠️ ไม่สำเร็จใน %d วิ — จะเทียบใหม่ในพื้นหลัง\n",
                          NTP_SYNC_TIMEOUT_MS / 1000);
            Serial.println("     (เครือข่ายอาจบล็อก NTP พอร์ต 123 — ดูหมายเหตุใน README)");
        }
    }

    // --- MQTT ---
    // ⚠️ PubSubClient::setServer(const char*, ...) เก็บ pointer ไม่ copy string
    //    activeMqttBroker เป็น global String จึงอยู่รอด — แต่ห้าม assign ค่าใหม่
    //    ทับตัวแปรนี้ตอน runtime โดยไม่เรียก setServer() ใหม่ (pointer จะชี้ขยะ)
    mqtt.setServer(activeMqttBroker.c_str(), MQTT_PORT);
    mqtt.setCallback(mqttCallback);        // รับรายชื่อ MAC + คำสั่งควบคุม

    // ArduinoOTA/mDNS เริ่มได้ต่อเมื่อ WiFi ติดแล้วเท่านั้น
    // ถ้าตอนบูต WiFi ยังไม่ติด จะไปเริ่มให้ใน loop() แทน (ดู otaReady)
    // ต้องพอสำหรับ payload ที่ยาวที่สุด = ble/esp32 ตอนเชื่อมครบทุกเรือน
    //   (~336 ไบต์ที่ 8 เรือน) + topic + header ของ MQTT
    //   ⚠️ ถ้าเล็กเกิน PubSubClient จะ "ทิ้งข้อความเงียบ ๆ" ไม่มี error ให้เห็น
    mqtt.setBufferSize(MAX_DEVICES * 24 + 384);
    mqtt.setKeepAlive(30);          // เผื่อช่วง connect BLE ที่ block ~15 วิ
    mqtt.setSocketTimeout(5);

    // --- BLE ---
    NimBLEDevice::init("");
    // ⚠️ ยืนยันแล้วด้วยการทดสอบจริง (debug session นี้): เคยลองดันขึ้น 20dBm
    //    (สูงสุดที่รองรับ) เพื่อดูว่าช่วยเรื่อง RSSI อ่อนไหม — ผลคือ:
    //      • RSSI ที่นาฬิกาส่งมาไม่เปลี่ยนเลย (คนละทิศทางกับ TX power ฝั่งนี้ ตามคาด)
    //      • ~74 วิหลังเริ่มสตรีม เจอ "[BLE] ... หลุด (reason=520)" = HCI 0x08
    //        Connection Timeout จริง — เป็น disconnect โดยไม่ตั้งใจครั้งแรกในเซสชันทั้งหมด
    //        (ตอน 9dBm ไม่เคยหลุดเองเลยแม้ทดสอบต่อเนื่อง 8+ นาที)
    //    สรุป: 20dBm ไม่ช่วย RSSI แถมกลับไปเจอ disconnect ตรงกับที่สงสัยไว้เรื่อง
    //    กระแสพีค/brownout บนบอร์ดล็อตที่เสาอากาศแมตช์ไม่ดี — คืนกลับ 9dBm ถาวร
    //    (ตัวเลขเดียวกับที่ลด WiFi ไปแล้วด้วยเหตุผลเดียวกัน — WIFI_POWER_8_5dBm)
    NimBLEDevice::setPower(9);
    NimBLEDevice::setMTU(185);      // ⚠️ สำคัญมาก: frame 0x09 ยาว 25 ไบต์
                                    //    MTU default 23 จะรับได้แค่ 20 ไบต์ → parse พัง
                                    //    (บน Pi BlueZ ต่อรอง MTU ให้เองเลยไม่เคยเจอ)
    NimBLEScan* scan = NimBLEDevice::getScan();
    scan->setScanCallbacks(&scanCB, true);   // true = แจ้ง advertisement ซ้ำด้วย (อัพเดต lastSeen)
    scan->setActiveScan(false);              // passive พอ (เราจับด้วย MAC) — เบากับ coexistence
    scan->setInterval(160);                  // 100 ms  (หน่วย 0.625 ms)
    scan->setWindow(96);                     //  60 ms  — window < interval เสมอ เว้นช่วงให้ WiFi
    scan->setMaxResults(0);                  // ไม่เก็บผลในหน่วยความจำ (ใช้ callback อย่างเดียว)

    Serial.println("[BLE] พร้อม เริ่มค้นหานาฬิกา\n");

    // เริ่มให้ watchdog เฝ้า "หลัง" setup เสร็จเรียบร้อยแล้วเท่านั้น
    // ตั้งแต่บรรทัดนี้ไป loop() ต้องกลับมาป้อนอาหารทุก ๆ ไม่เกิน WDT_TIMEOUT_SEC วิ
    esp_task_wdt_add(NULL);
    esp_task_wdt_reset();
    Serial.printf("[WDT] เริ่มเฝ้า loop แล้ว (timeout %d วิ)\n", WDT_TIMEOUT_SEC);
}

void loop() {
    esp_task_wdt_reset();                  // ป้อนอาหาร watchdog ทุกรอบ

    // เริ่ม ArduinoOTA ครั้งแรกที่ WiFi ติด (อาจติดหลัง setup จบไปแล้ว)
    if (!otaReady && WiFi.status() == WL_CONNECTED) {
        char mdnsName[32];
        snprintf(mdnsName, sizeof(mdnsName), "naid-%s", NODE_ID);
        MDNS.begin(mdnsName);
        setupArduinoOTA();
        otaReady = true;
    }
    if (otaReady) ArduinoOTA.handle();      // ต้องเรียกบ่อย ไม่งั้น espota ต่อไม่ติด

    // ระหว่างอัปเดตเฟิร์มแวร์ หยุดทุกอย่าง ห้ามยุ่งกับ BLE/MQTT
    if (otaBusy) { esp_task_wdt_reset(); delay(10); return; }

    // ── ชั้นที่ 2: เน็ตหลุดยาวเกินกำหนด = รีบูต ──
    //    ครอบคลุมเคสที่ชิปไม่ค้าง (watchdog จึงไม่ทำงาน) แต่ WiFi/MQTT stack
    //    เอ๋อจนต่อไม่ติดอีกเลย ซึ่งเป็นอาการที่พบบ่อยกว่าการค้างทั้งเครื่อง
    static uint32_t lastNetOk = 0;
    if (lastNetOk == 0) lastNetOk = millis();
    if (WiFi.status() == WL_CONNECTED && mqtt.connected()) lastNetOk = millis();
    else if (millis() - lastNetOk > NET_DEAD_REBOOT_MS) {
        Serial.printf("[SYS] เน็ตหลุดเกิน %lu นาที → รีบูตเพื่อกู้ตัวเอง\n",
                      (unsigned long)(NET_DEAD_REBOOT_MS / 60000));
        Serial.flush();
        ESP.restart();
    }

    // ── broker ทดลอง: ต่อติดต่อเนื่องนานพอ = ยืนยันเป็นตัวหลัก ──
    //    ที่ต้องรอต่อเนื่อง ไม่ใช่แค่ connect ติดครั้งเดียว เพราะ broker
    //    "ที่ผิดแต่มีอยู่จริง" ในเครือข่ายอาจตอบ CONNACK ให้ได้
    if (brokerOnTrial) {
        // ── เพดานเวลาทดลอง ──
        //    broker ที่ติด ๆ หลุด ๆ จะรีเซ็ต brokerOkSince ตลอดจนไม่เคยครบ
        //    BROKER_CONFIRM_MS ในขณะที่ lastNetOk ก็ถูกรีเฟรชจนชั้น net-dead
        //    ไม่ยิง → ค้างสถานะทดลองไม่จบ ตัดบทด้วยเพดานเวลาแทน
        if (millis() >= BROKER_TRIAL_DEADLINE_MS) {
            prefs.begin("naid", false);
            prefs.remove("mqtt_broker_try");
            prefs.remove("mqtt_try_boots");
            prefs.end();
            brokerOnTrial = false;
            nlog("[MQTT] broker ทดลองไม่ผ่านใน %lu นาที → ถอยกลับตัวเดิมแล้วรีบูต",
                 (unsigned long)(BROKER_TRIAL_DEADLINE_MS / 60000));
            publishOtaStatus("broker_rollback", "ทดลองไม่ผ่านตามเวลาที่กำหนด");
            pendingRebootAt = millis() + 2000;   // รีบูตเพื่อกลับไปใช้ broker ที่ยืนยันแล้ว
        // ต้องมีทั้ง "ต่อติด" และ "ได้รายชื่อจากแอปเรา" — connected อย่างเดียว
        // พิสูจน์แค่ว่ามี broker ตัวหนึ่งรับ connection ไม่ได้พิสูจน์ว่าเป็นตัวที่ถูก
        } else if (mqtt.connected() && sawAppRoster) {
            if (brokerOkSince == 0) brokerOkSince = millis();
            else if (millis() - brokerOkSince >= BROKER_CONFIRM_MS) {
                prefs.begin("naid", false);
                size_t wrote = prefs.putString("mqtt_broker", activeMqttBroker);
                if (wrote > 0) {
                    prefs.remove("mqtt_broker_try");
                    prefs.remove("mqtt_try_boots");
                }
                prefs.end();
                if (wrote > 0) {
                    brokerOnTrial = false;
                    nlog("[MQTT] ✅ ยืนยัน broker %s เป็นตัวหลักแล้ว", activeMqttBroker.c_str());
                    publishOtaStatus("broker_ok", activeMqttBroker.c_str());
                } else {
                    // เขียน NVS ไม่ผ่าน — คงสถานะทดลองไว้ เดี๋ยวรอบหน้าลองยืนยันใหม่
                    brokerOkSince = 0;
                    nlog("[MQTT] ⚠️ เขียน NVS ไม่สำเร็จ — ยังไม่ยืนยัน broker");
                }
            }
        } else {
            brokerOkSince = 0;      // หลุด → เริ่มนับใหม่
        }
    }
    // แจ้งครั้งเดียวตอนต่อ broker ทดลองติด — เส้นทาง OTA รีบูตมาแล้วยังไม่เคยแจ้ง
    // ทำให้ UI ไม่เห็นสถานะ "กำลังทดลอง" เลยตลอดช่วง 2-15 นาทีที่รอผล
    if (brokerOnTrial && !brokerTrialAnnounced && mqtt.connected()) {
        brokerTrialAnnounced = true;
        publishOtaStatus("broker_trial", activeMqttBroker.c_str());
    }
    if (brokerRollbackPending && mqtt.connected()) {
        brokerRollbackPending = false;
        publishOtaStatus("broker_rollback", activeMqttBroker.c_str());
    }

    // ── ชั้นที่ 3: รีบูตตามรอบ (รอจังหวะที่ไม่มีเรือนเชื่อมอยู่) ──
#if AUTO_REBOOT_HOURS > 0
    if (millis() > (uint32_t)AUTO_REBOOT_HOURS * 3600000UL) {
        int links = 0;
        for (auto& s : slots) if (s.inUse) links++;
        if (links == 0) {
            Serial.printf("[SYS] ครบรอบ %d ชม. — รีบูตตามกำหนด\n", AUTO_REBOOT_HOURS);
            Serial.flush();
            ESP.restart();
        }
    }
#endif

    if (pendingRebootAt != 0 && millis() >= pendingRebootAt) {
        Serial.println("[SYS] รีบูตตามคำสั่ง");
        Serial.flush();
        ESP.restart();
    }

    ensureNetwork();

    // ประมวลผล frame จากคิว (BLE callback → ที่นี่)
    BleFrame f;
    while (xQueueReceive(frameQueue, &f, 0) == pdTRUE) {
        if (f.slot < MAX_DEVICES && slots[f.slot].inUse) {
            processFrame(slots[f.slot], f.data, f.len);
        }
    }

    for (auto& s : slots) serviceSlot(s);
    tryConnectNext();
    manageScan();
    // เทียบเวลาใหม่เป็นระยะ — นาฬิกาภายในชิปดริฟต์ได้หลายวินาทีต่อวัน
    // และถ้าตอนบูต NTP ไม่ผ่าน ตรงนี้จะเป็นโอกาสให้ sync สำเร็จภายหลัง
    {
        static uint32_t lastNtp = 0;
        if (WiFi.status() == WL_CONNECTED &&
            (lastNtp == 0 || millis() - lastNtp > NTP_RESYNC_INTERVAL_MS)) {
            lastNtp = millis();
            configTime(TZ_OFFSET_SEC, 0, NTP_SERVER1, NTP_SERVER2);
        }
    }

    publishHeartbeat();
    publishEsp32Status();
    reportActiveList();

    // log สรุปทุก 30 วิ
    if (millis() - lastStatusLog >= 30000) {
        lastStatusLog = millis();
        int links = 0;
        for (auto& s : slots) if (s.inUse) links++;
        Serial.printf("[STATUS] เชื่อม %d/%d | WiFi %s | MQTT %s | heap %lu\n",
                      links, MAX_DEVICES,
                      WiFi.status() == WL_CONNECTED ? "✅" : "❌",
                      mqtt.connected() ? "✅" : "❌",
                      (unsigned long)ESP.getFreeHeap());
    }

    delay(10);      // ปล่อยเวลาให้ task อื่น (NimBLE/WiFi) — loop ยังไวพอสำหรับ FSM
}
