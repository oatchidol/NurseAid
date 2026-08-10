'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const mosquittoConfig = fs.readFileSync(path.join(__dirname, 'mosquitto-config', 'mosquitto.conf'), 'utf8');

test('application version is visible as v2.14 without system version wording', () => {
    assert.match(source, /class="app-version sidebar-hide" aria-label="v2\.14" title="v2\.14"/);
    assert.match(source, /class="app-version-badge">v2\.14<\/span>/);
    assert.match(source, /เข้าสู่ระบบ \| NurseAid PRO[\s\S]*?text-\[10px\] font-mono font-bold[\s\S]*?>v2\.14<\/span>/);
    assert.doesNotMatch(source, /aria-label="[^\"]*(?:System|เวอร์)/);
    assert.doesNotMatch(source, /APP_VERSION_LABEL/);
});

test('dashboard uses the same device number ordering as the pairing page', () => {
    assert.match(
        source,
        /FROM nurseaid WHERE hm_number IS NOT NULL ORDER BY device_no ASC/
    );
    // The pairing page query now carries an optional ward-scope WHERE clause
    // (unpaired devices stay visible to every ward; paired ones are ward-scoped),
    // so match loosely across that rather than requiring an exact literal string.
    assert.match(source, /SELECT \* FROM nurseaid[\s\S]{0,300}ORDER BY device_no ASC/);
});

test('pairing and dashboard use the same responsive card grid layout', () => {
    assert.match(source, /id="monitor-grid" class="monitor-grid-auto monitor-grid-layout"/);
    assert.match(source, /id="pairing-grid" class="monitor-grid-layout"/);
    assert.match(source, /\.monitor-grid-layout \{[\s\S]*?repeat\(auto-fill, minmax\(285px, 1fr\)\)/);
    assert.doesNotMatch(source, /grid grid-cols-2 md:grid-cols-4 gap-6/);
});

test('dashboard card signature excludes fields that change rapidly or only with time', () => {
    assert.match(source, /metricAges:\s*_metricAges/);
    assert.match(source, /lastKnownAgeSeconds:\s*_lastKnownAgeSeconds/);
    assert.match(source, /rssi:\s*_rssi/);
    assert.match(source, /theme, p: stablePatient/);
});

test('dashboard device status dot uses only green and red for connection state', () => {
    assert.doesNotMatch(source, /bg-amber-400.*device-status|device-status.*bg-amber-400/);
    assert.doesNotMatch(source, /bg-gray-500.*device-status|device-status.*bg-gray-500/);
    assert.doesNotMatch(source, /bg-gray-600.*device-status|device-status.*bg-gray-600/);
    assert.doesNotMatch(source, /bg-gray-300.*device-status|device-status.*bg-gray-300/);
    assert.match(source, /data-role="device-status"/);
    assert.match(source, /aria-label="สถานะเครื่อง: /);
});

test('dashboard status labels use simple connected/disconnected text', () => {
    assert.doesNotMatch(source, /ระบบข้อมูลขัดข้อง/);
    assert.doesNotMatch(source, /statusLabel.*ออฟไลน/);
    // Check that statusLabel ternary uses connected/disconnected labels
    assert.match(source, /isOnline \|\| isRecovering \|\| isRecent \|\| isPartial \|\| isSensorWaiting \|\| isPresentWaiting/);
});

test('dashboard does not display status text or metric ages below vital values', () => {
    assert.doesNotMatch(source, /hrAgeText|spo2AgeText|tempAgeText/);
    assert.doesNotMatch(source, /data-role="(?:hr|spo2|temp)-age"/);
    assert.doesNotMatch(source, /data-role="patient-status"/);
    assert.doesNotMatch(source, /card\.statusText/);
    assert.match(source, /data-role="device-status" role="status"/);
    assert.match(source, /aria-label="สถานะเครื่อง: \\\${statusLabel}"/);
});

test('dashboard does not describe readings as fresh or not fresh', () => {
    assert.doesNotMatch(source, /HR สด|HR ไม่สด|● สด|return 'สด'/);
});

test('inactive device states use gray styling and distinguish unknown from empty battery', () => {
    assert.match(source, /const isOffWrist = dq === 'off_wrist'/);
    assert.match(source, /const isOffline = dq === 'offline' \|\| \(!isOnline && !isRecovering\)/);
    assert.match(source, /const isLowBattery = Number\(p\.battery\) === 0/);
    assert.match(source, /const isAwaitingWearState = isPresentWaiting/);
    assert.match(source, /const isInactive = isOffline \|\| isOffWrist \|\| isLowBattery \|\| isAwaitingWearState/);
    assert.match(source, /p\.battery === 0 \? 'แบตหมด'/);
    assert.match(source, /p\.battery !== '--' \? p\.battery \+ '%' : 'ไม่ทราบแบต'/);
    assert.match(source, /present_waiting: 'พบอุปกรณ์ · ยังไม่พบสถานะการสวมใส่'/);
    assert.match(source, /data-device-state="\\\$\{isInactive \? 'inactive' : 'active'\}"/);
    assert.match(source, /off_wrist: '--'/);
    assert.match(source, /const canEvaluateVitals = isOnline && isWorn && !isInactive/);
    assert.match(source, /const bedBg = isInactive \? 'bg-gray-500'/);
});

test('dashboard card frame shows patient clinical state, not device connection alone', () => {
    assert.match(source, /const hasCompleteVitals = canEvaluateVitals && p\.hr !== '--' && p\.spo2 !== '--' && p\.temp !== '--'/);
    assert.match(source, /const isClinicallyNormal = hasCompleteVitals && !isCrit && !isWarn/);
    assert.match(source, /isWarn \? 'border-color: var\(--accent-yellow\);'/);
    assert.match(source, /isClinicallyNormal \? 'border-color: var\(--accent-green\);'/);
    assert.match(source, /style="\\\$\{cardBorderStyle\} \\\$\{isInactive \? inactiveCardStyle : ''\}"/);
    assert.doesNotMatch(source, /isOnline \? 'border-color: var\(--accent-green\);'/);
    assert.doesNotMatch(source, /\(isPartial \|\| isSensorWaiting\) \? 'border-color: #f59e0b;'/);
});

test('critical background remains isolated to its own vital metric', () => {
    assert.match(source, /const hrBg = isInactive \? grayBg : \(isHrCrit \? criticalVitalBg/);
    assert.match(source, /const spo2Bg = isInactive \? grayBg : \(isSpo2Crit \? criticalVitalBg/);
    assert.match(source, /const tempBg = isInactive \? grayBg : \(isTempCrit \? criticalVitalBg/);
    assert.match(source, /isHrWarn \? warningVitalBg/);
    assert.match(source, /isSpo2Warn \? warningVitalBg/);
    assert.match(source, /isTempWarn \? warningVitalBg/);
});

test('trend charts omit timestamps that have no record for their metric', () => {
    assert.match(source, /function panelTrendSeries\(data, key, hours\)/);
    assert.match(source, /if \(!Number\.isFinite\(value\) \|\| value <= 0 \|\| !Number\.isFinite\(timestamp\)\) return/);
    assert.match(source, /const values = series\.values/);
    assert.doesNotMatch(source, /return Number\.isFinite\(value\) && value > 0 \? value : null/);
    assert.match(source, /spanGaps:\s*false/);
    assert.doesNotMatch(source, /spanGaps:\s*true/);
});

test('trend charts break the line across missing time ranges', () => {
    assert.match(source, /const panelTrendGapMinutes = \{/);
    assert.match(source, /point\.x - previous\.x > gapMs/);
    assert.match(source, /points\.push\(\{ x: previous\.x \+ \(point\.x - previous\.x\) \/ 2, y: null \}\)/);
    assert.match(source, /data: series\.points/);
    assert.match(source, /type: 'linear'/);
});

test('patient trend supports selectable ranges and adaptive Y axes', () => {
    assert.match(source, /id="trend-range" onchange="changeTrendRange\(this\.value\)"/);
    for (const hours of ['1', '6', '12', '24', '72', '168']) {
        assert.match(source, new RegExp(`<option value="${hours}"`));
    }
    assert.match(source, /fetch\('\/api\/patient-trend\//);
    assert.match(source, /'\?hours=' \+ encodeURIComponent\(state\.hours\)/);
    assert.match(source, /function calculateTrendYAxis\(values, config\)/);
    assert.match(source, /let span = Math\.max\(config\.minSpan, observedRange \* 1\.3\)/);
    assert.match(source, /stepSize: yAxis\.step/);
    assert.doesNotMatch(source, /render\('chartHR_Panel',[\s\S]*?'ble_heart', 40, 160\)/);
});

test('patient trend opens as a large readable responsive panel', () => {
    assert.match(source, /width: min\(1560px, calc\(100vw - 2rem\)\)/);
    assert.match(source, /#sidePanel \{[\s\S]*?display: flex;[\s\S]*?overflow: hidden/);
    assert.match(source, /grid-template-rows: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(source, /#sidePanel \.trend-chart \{[\s\S]*?flex: 1 1 0;[\s\S]*?height: auto !important/);
    assert.match(source, /#sidePanel \.trend-card-head \{[\s\S]*?flex-direction: column/);
    assert.match(source, /class="trend-card trend-card--hr/);
    assert.match(source, /class="trend-summary/);
    assert.match(source, /document\.body\.classList\.add\('trend-panel-open'\)/);
    assert.match(source, /aria-label="ปิดหน้ากราฟ"/);
});

test('patient trend shows normal, warning, and critical clinical bands', () => {
    assert.match(source, /id: 'panelTrendRange'/);
    assert.match(source, /Chart\.register\(panelTrendRangePlugin\)/);
    assert.match(source, /referenceMin: state\.thresholds\.hrMin, referenceMax: state\.thresholds\.hrMax/);
    assert.match(source, /referenceMin: state\.thresholds\.spo2CriticalMin, referenceMax: 100/);
    assert.match(source, /referenceMin: state\.thresholds\.tempMin, referenceMax: state\.thresholds\.tempMax/);
    assert.match(source, /warningMin: state\.thresholds\.hrWarningMin/);
    assert.match(source, /warningMin: state\.thresholds\.spo2WarningMin/);
    assert.match(source, /warningMin: state\.thresholds\.tempWarningMin/);
    assert.match(source, /fillBand\(criticalMin, warningMin/);
    assert.match(source, /fillBand\(warningMin, warningMax/);
    assert.match(source, /span = Math\.max\(config\.minSpan, observedRange \* 1\.12\)/);
    assert.match(source, /querySelector\('\[data-action="show-trend"\]'\)[\s\S]*?showTrend\([\s\S]*?limit\.tempMax/);
});

test('dashboard escapes patient data and binds actions without inline patient JavaScript', () => {
    assert.match(source, /name: escapeHTML\(p\.name \|\| '-'\)/);
    assert.match(source, /dataMessage: escapeHTML\(p\.dataMessage \|\| statusLabel\)/);
    assert.match(source, /data-action="show-trend"/);
    assert.match(source, /data-action="open-config"/);
    assert.doesNotMatch(source, /onclick="showTrend\('\\\$\{p\.mac\}/);
    assert.doesNotMatch(source, /onclick="openIndividualConfig\('\\\$\{p\.mac\}/);
});

test('device and patient management CRUD routes exist and require admin access', () => {
    for (const route of [
        /app\.post\('\/api\/devices', requireCapability\(/,
        /app\.post\('\/api\/devices\/update', requireCapability\(/,
        /app\.delete\('\/api\/devices\/:mac', requireCapability\(/,
        /app\.post\('\/api\/patients', requireCapability\(/,
        /app\.post\('\/api\/patients\/update', requireCapability\(/,
        /app\.delete\('\/api\/patients\/:hn', requireCapability\(/
    ]) {
        assert.match(source, route);
    }
});

test('account changes revoke sessions and preserve a final administrator', () => {
    assert.match(source, /SELECT id, username, full_name, role, session_version[\s\S]*?FROM users WHERE id=\$1/);
    assert.match(source, /Number\(claims\.sessionVersion\) !== Number\(user\.session_version\)/);
    assert.match(source, /session_version=session_version\+1/);
    assert.match(source, /Cannot demote the last super admin/);
    assert.match(source, /LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE/);
    assert.match(source, /validRoles\.has\(role\)/);
});

test('alert settings exposes central ranges, computed midpoints, and patient overrides', () => {
    assert.match(source, /ค่ากลางของระบบ/);
    assert.match(source, /id="\\\$\{prefix\}-hrMid"/);
    assert.match(source, /id="\\\$\{prefix\}-tempMid"/);
    assert.match(source, /window\.saveDefaultAlertSettings/);
    assert.match(source, /mac:'\*', \.\.\.values/);
    assert.match(source, /ตั้งค่าเฉพาะราย/);
    assert.match(source, /window\.resetPatientAlertSettings/);
    assert.match(source, /href="\/alert-settings" class="admin-only panel-settings-btn"/);
    assert.match(source, /Normal[^`]*Warning[^`]*Critical/);
    assert.match(source, /hrWarningMin/);
    assert.match(source, /spo2CriticalMin/);
    assert.match(source, /tempWarningMax/);
    assert.match(source, /#globalModal\.modal--wide > div/);
    assert.match(source, /\.alert-settings-modal-grid \{[\s\S]*?repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(source, /openModal\('⚙️ ช่วงค่าและการแจ้งเตือน'[\s\S]*?}, 'wide'\)/);
});

test('alert settings API validates chart-compatible ranges', () => {
    assert.match(source, /values\.hrMin < 20 \|\| values\.hrMax > 240/);
    assert.match(source, /values\.spo2CriticalMin < 50 \|\| values\.spo2WarningMin > 100/);
    assert.match(source, /values\.tempMin < 30 \|\| values\.tempMax > 43/);
    assert.match(source, /values\.hrMin < values\.hrWarningMin/);
    assert.match(source, /values\.tempWarningMax < values\.tempMax/);
    assert.match(source, /values\.offlineThresholdMinutes < 1 \|\| values\.offlineThresholdMinutes > 60/);
});

test('offline device alerts are configurable, deduplicated, and recover automatically', () => {
    assert.match(source, /enable_offline_alert BOOLEAN DEFAULT true/);
    assert.match(source, /offline_threshold_minutes INTEGER DEFAULT 2/);
    assert.match(source, /id="default-offline"/);
    assert.match(source, /id="default-offlineMinutes"/);
    assert.match(source, /category='device_offline' AND resolved=false/);
    assert.match(source, /triggerOfflineAlert\(status, deviceSettings, thresholdMinutes\)/);
    assert.match(source, /resolveOfflineAlert\(/);
    assert.match(source, /NurseAid DEVICE ONLINE/);
    assert.match(source, /NurseAid DEVICE OFFLINE/);
});

test('active alert transitions are serialized before replacing the per-device row', () => {
    assert.match(source, /async function replaceActiveAlert/);
    assert.match(source, /pg_advisory_xact_lock\(hashtext\(LOWER\(\$1\)\)\)/);
    assert.match(source, /UPDATE alert_logs SET resolved=true, resolved_at=NOW\(\)[\s\S]*?LOWER\(mac\)=LOWER\(\$1\) AND resolved=false/);
    assert.match(source, /await client\.query\('BEGIN'\)/);
    assert.match(source, /await client\.query\('COMMIT'\)/);
    assert.match(source, /await client\.query\('ROLLBACK'\)/);
});

test('LINE HTTP 429 responses open a per-credential circuit breaker', () => {
    assert.match(source, /const lineSuppressedUntilByToken = new Map\(\)/);
    assert.match(source, /async function postLinePush/);
    assert.match(source, /Number\(error\.status\) !== 429/);
    assert.match(source, /nextUtcMonthStartMs\(\)/);
    assert.doesNotMatch(source, /tasks\.push\(postJson\('https:\/\/api\.line\.me/);
});

test('Mosquitto persistence uses a directory and an explicit file name', () => {
    assert.match(mosquittoConfig, /^persistence_location \/mosquitto\/data\/$/m);
    assert.match(mosquittoConfig, /^persistence_file mosquitto\.db$/m);
    assert.doesNotMatch(mosquittoConfig, /^persistence_location .*mosquitto\.db$/m);
});

test('all vital signs escalate from warning to critical using configurable limits', () => {
    assert.match(source, /function classifyVitalRange\(value, criticalMin, warningMin, warningMax, criticalMax\)/);
    assert.match(source, /if \(number < criticalMin \|\| number > criticalMax\) return 'critical'/);
    assert.match(source, /if \(number < warningMin \|\| number > warningMax\) return 'warning'/);
    assert.match(source, /spo2 <= limits\.spo2CriticalMin \? 'critical' : 'warning'/);
    assert.match(source, /hr_warning_min INTEGER DEFAULT 60/);
    assert.match(source, /spo2_critical_min INTEGER DEFAULT 91/);
    assert.match(source, /temp_warning_min DECIMAL\(3,1\) DEFAULT 36\.0/);
});

test('alert editor presents severity in normal, warning, critical order', () => {
    const editor = source.slice(
        source.indexOf('function renderAlertMetricEditor'),
        source.indexOf('function alertSettingsValues')
    );
    const cards = [
        editor.slice(editor.indexOf('range-metric-card--hr'), editor.indexOf('range-metric-card--spo2')),
        editor.slice(editor.indexOf('range-metric-card--spo2'), editor.indexOf('range-metric-card--temp')),
        editor.slice(editor.indexOf('range-metric-card--temp'))
    ];
    for (const card of cards) {
        assert.ok(card.indexOf('range-normal-preview') < card.indexOf('range-tier-row--warning'));
        assert.ok(card.indexOf('range-tier-row--warning') < card.indexOf('range-tier-row--critical'));
    }
});

test('restart recovery is amber and is not treated as inactive offline state', () => {
    assert.match(source, /const isRecovering = p\.status === 'Recovering' \|\| p\.dataQuality === 'recovering'/);
    assert.match(source, /const isOffline = dq === 'offline' \|\| \(!isOnline && !isRecovering\)/);
    assert.match(source, /recovering: 'กำลังเชื่อมต่อใหม่'/);
    assert.match(source, /isRecovering \|\| isRecent \|\| isPartial/);
});

test('pairing page has Change Device button on paired cards', () => {
    assert.match(source, /window\.changeDevice\s*=\s*async\s*\(/);
    assert.match(source, /Change Device/);
    assert.match(source, /ย้ายคนไข้/);
});

test('pairing page calls /api/change-device endpoint', () => {
    assert.match(source, /\/api\/change-device/);
    assert.match(source, /method:\s*'POST'/);
    assert.match(source, /fromMac.*toMac|toMac.*fromMac/);
});

test('POST /api/change-device endpoint exists with requireCapability\( protection', () => {
    assert.match(source, /app\.post\('\/api\/change-device', requireCapability\(/);
});

test('change-device uses database transaction (BEGIN/COMMIT/ROLLBACK)', () => {
    assert.match(source, /await client\.query\('BEGIN'\)/);
    assert.match(source, /await client\.query\('COMMIT'\)/);
    assert.match(source, /await client\.query\('ROLLBACK'\)/);
});

test('change-device validates source device has patient and target device is available', () => {
    assert.match(source, /Source device has no paired patient/);
    assert.match(source, /Target device already has a paired patient/);
});

test('change-device updates device_history with discharge and new assignment', () => {
    assert.match(source, /discharge_time=NOW\(\), status='discharged'/);
    assert.match(source, /status.*=.*'active'/);
});
