'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const firmware = fs.readFileSync(
    path.join(__dirname, '..', 'firmware', 'nurseaid_esp32.ino'),
    'utf8'
);

test('firmware bounds BLE queue draining so loop keeps servicing its watchdog', () => {
    assert.match(firmware, /#define FRAME_QUEUE_MAX_PER_LOOP\s+8\b/);

    const loop = firmware.slice(firmware.indexOf('void loop() {'));
    assert.match(loop, /while \(framesProcessed < FRAME_QUEUE_MAX_PER_LOOP &&\s*\n\s*xQueueReceive\(frameQueue, &f, 0\) == pdTRUE\)/);
    assert.match(loop, /framesProcessed\+\+;/);
    assert.match(loop, /processFrame\(slots\[f\.slot\], f\.data, f\.len\);[\s\S]{0,250}esp_task_wdt_reset\(\);/);
    assert.doesNotMatch(loop, /while \(xQueueReceive\(frameQueue, &f, 0\) == pdTRUE\)/);
});

const section = (start, end) => firmware.slice(firmware.indexOf(start), firmware.indexOf(end, firmware.indexOf(start)));

test('RTC breadcrumbs snapshot only valid watchdog/panic resets before initialisation', () => {
    for (const [name, type] of [['rtcStage', 'uint8_t'], ['rtcStageSlot', 'uint8_t'],
        ['rtcStageAtMs', 'uint32_t'], ['rtcLastLoopMs', 'uint32_t']]) {
        assert.match(firmware, new RegExp(`RTC_NOINIT_ATTR static ${type} ${name};`));
    }
    const setup = section('void setup() {', 'static void checkOtaRollback()');
    assert.match(setup, /const bool rtcWasValid = rtcMagic == RTC_MAGIC_VALUE;/);
    assert.match(setup, /if \(rtcWasValid && rtcStage <= WD_PUBLISH_METRIC &&/);
    for (const reason of ['TASK_WDT', 'INT_WDT', 'WDT', 'PANIC']) {
        assert.ok(setup.includes(`resetReason == ESP_RST_${reason}`));
    }
    for (const [dest, src, initial] of [['prevStage', 'rtcStage', 'WD_IDLE'],
        ['prevStageSlot', 'rtcStageSlot', '0xFF'], ['prevStageMs', 'rtcStageAtMs', '0'],
        ['prevUpMs', 'rtcLastLoopMs', '0']]) {
        assert.ok(setup.indexOf(`${dest} = ${src};`) < setup.indexOf(`${src} = ${initial};`));
        assert.ok(setup.includes(`${src} = ${initial};`));
    }
    const helper = section('static inline void wdtStage(uint8_t st, uint8_t slot) {', 'static const char* resetReasonText()');
    assert.match(helper, /rtcStage = st;\s*rtcStageSlot = slot;\s*rtcStageAtMs = millis\(\);/);
    assert.doesNotMatch(helper, /Serial|mqtt\.|esp_task_wdt_reset|while\s*\(/);
    assert.ok(firmware.indexOf('enum WdtStage') < firmware.indexOf('struct __attribute__'));
    assert.match(firmware, /static inline void wdtStage\(uint8_t st, uint8_t slot = 0xFF\);/);
});

test('boot preserves its retained legacy JSON and appends named breadcrumbs only when valid', () => {
    const network = section('static void ensureNetwork() {', 'static void expireLocationHolds()');
    assert.ok(network.includes('{\\"boot\\":%lu,\\"reason\\":\\"%s\\",\\"version\\":\\"%s\\",\\"md5\\":\\"%s\\"}'));
    assert.match(network, /char t\[64\], p\[448\];/);
    const names = section('static const char* const WDT_STAGE_NAMES[]', '// ═');
    const stageNames = [...names.matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
    assert.deepEqual(stageNames, ['idle', 'loop_head', 'mdns_ota', 'net_health', 'ensure_network',
        'mqtt_subscribe', 'boot_publish', 'frame_process', 'serviceSlot', 'ble_connect',
        'ble_discover', 'ble_subscribe', 'manage_scan', 'ntp', 'heartbeat', 'esp32_status',
        'report_active_list', 'ota', 'publishMetric']);
    const reasons = [...section('static const char* resetReasonText()', 'static bool otaReady')
        .matchAll(/return "([^"]+)";/g)].map(match => match[1]);
    const version = firmware.match(/^#define FW_VERSION\s+"([^"]+)"/m)[1];
    for (const reason of reasons) {
        const legacy = { boot: 4294967295, reason, version, md5: 'f'.repeat(8) };
        assert.ok(Buffer.byteLength(JSON.stringify(legacy)) + 1 <= 280);
        for (const stage of stageNames) {
            assert.ok(Buffer.byteLength(JSON.stringify({ ...legacy, stage, stage_slot: 255,
                stage_ms: 4294967295, prev_up_ms: 4294967295 })) + 1 <= 448);
        }
    }
    assert.match(network, /if \(prevStageValid\) \{[\s\S]*strlen\(p\) - 1;[\s\S]*WDT_STAGE_NAMES\[prevStage\]/);
    for (const key of ['stage', 'stage_slot', 'stage_ms', 'prev_up_ms']) {
        assert.ok(network.includes(`\\"${key}\\":`));
    }
    assert.match(network, /mqtt\.publish\(t, p, true\);[^\n]*\n\s*esp_task_wdt_reset\(\);/);
    assert.match(network, /mqtt\.connect\(cid, MQTT_USER, MQTT_PASS\);\s*esp_task_wdt_reset\(\);/);
    assert.match(network, /wdtStage\(WD_MQTT_SUBSCRIBE\);\s*subscribeDeviceList\(\);\s*esp_task_wdt_reset\(\);/);
});

test('feeds separate completed BLE and loop calls without changing OTA or timeout settings', () => {
    const connect = section('static void tryConnectNext() {', 'static void publishDisconnected(');
    assert.match(connect, /wdtStage\(WD_BLE_CONNECT, \(uint8_t\)si\);\s*const bool connected = s\.client->connect\(r\.addr\);[^\n]*\n\s*esp_task_wdt_reset\(\);/);
    assert.match(connect, /wdtStage\(WD_BLE_DISCOVER, \(uint8_t\)si\);\s*NimBLERemoteService\* svc = s\.client->getService/);
    assert.match(connect, /getCharacteristic\(UUID_TX\) : nullptr;\s*esp_task_wdt_reset\(\);\s*wdtStage\(WD_BLE_SUBSCRIBE, \(uint8_t\)si\);/);
    assert.match(connect, /const bool subscribed = rx && s\.txChar && rx->subscribe\(true, onNotify\);\s*esp_task_wdt_reset\(\);/);
    const loop = firmware.slice(firmware.indexOf('void loop() {'));
    assert.match(loop, /rtcLastLoopMs = millis\(\);\s*wdtStage\(WD_LOOP_HEAD\);/);
    assert.match(loop, /for \(auto& s : slots\) \{\s*serviceSlot\(s\);\s*esp_task_wdt_reset\(\);\s*\}/);
    assert.match(loop, /tryConnectNext\(\);\s*esp_task_wdt_reset\(\);/);
    for (const fn of ['publishHeartbeat', 'publishEsp32Status', 'reportActiveList']) {
        assert.match(loop, new RegExp(`${fn}\\(\\);\\s*esp_task_wdt_reset\\(\\);`));
    }
    for (const st of ['MDNS_OTA', 'OTA', 'NET_HEALTH', 'ENSURE_NETWORK', 'MANAGE_SCAN',
        'NTP', 'HEARTBEAT', 'ESP32_STATUS', 'REPORT_ACTIVE_LIST']) {
        assert.ok(loop.includes(`wdtStage(WD_${st});`));
    }
    assert.match(loop, /wdtStage\(WD_IDLE\);\s*delay\(10\);/);
    assert.match(loop, /if \(otaBusy\) \{ esp_task_wdt_reset\(\); delay\(10\); return; \}/);
    assert.match(firmware, /#define WDT_TIMEOUT_SEC\s+60\b/);
    assert.match(firmware, /#define OTA_WDT_TIMEOUT_SEC\s+90\b/);
    for (const [fn, st] of [['serviceSlot', 'SERVICE_SLOT'], ['processFrame', 'FRAME_PROCESS']]) {
        assert.match(firmware, new RegExp(`static void ${fn}\\([^\\n]*\\) \\{\\s*wdtStage\\(WD_${st}, \\(uint8_t\\)\\(&s - slots\\)\\);`));
    }
    const metric = section('static void publishMetric(', 'static void publishWearing(');
    assert.match(metric, /wdtStage\(WD_PUBLISH_METRIC, \(uint8_t\)\(&s - slots\)\);\s*mqtt\.publish\(topic, payload\);/);
    assert.match(metric, /rtcStage = callerStage;\s*rtcStageSlot = callerSlot;\s*rtcStageAtMs = callerStageMs;/);
    assert.doesNotMatch(metric, /esp_task_wdt_reset/);
});
