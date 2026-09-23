const express = require('express');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { InfluxDB } = require('@influxdata/influxdb-client');

const app = express();
const PORT = Number(process.env.TELEMETRY_HISTORY_PORT || 3340);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_COOKIE = 'nurseaid_session';

if (SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
}

const pool = new Pool({
    host: process.env.DB_HOST || 'postgres',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD
});

const influxConfig = {
    url: process.env.INFLUX_URL || 'http://influxdb:8086',
    token: process.env.INFLUX_TOKEN || '',
    org: process.env.INFLUX_ORG || '',
    bucket: process.env.INFLUX_BUCKET || ''
};
const queryApi = new InfluxDB({
    url: influxConfig.url,
    token: influxConfig.token
}).getQueryApi(influxConfig.org);

const WINDOWS = Object.freeze({
    '1': { range: '1h', every: '1m', label: '1 ชั่วโมง' },
    '6': { range: '6h', every: '2m', label: '6 ชั่วโมง' },
    '12': { range: '12h', every: '5m', label: '12 ชั่วโมง' },
    '24': { range: '24h', every: '5m', label: '24 ชั่วโมง' },
    '72': { range: '72h', every: '15m', label: '3 วัน' },
    '168': { range: '168h', every: '30m', label: '7 วัน' }
});

function parseCookies(header = '') {
    return String(header).split(';').reduce((cookies, item) => {
        const separator = item.indexOf('=');
        if (separator < 0) return cookies;
        const key = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        if (key) {
            try { cookies[key] = decodeURIComponent(value); }
            catch (_) { cookies[key] = value; }
        }
        return cookies;
    }, {});
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function escapeFluxString(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeMac(value) {
    const text = String(value || '').trim().replace(/-/g, ':').toLowerCase();
    return /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(text) ? text : null;
}

function parseDurationMs(value) {
    const match = /^(\d+)\s*h$/.exec(String(value || ''));
    if (!match) return 0;
    return Number(match[1]) * 60 * 60 * 1000;
}

async function loadUser(req) {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const claims = jwt.verify(token || '', SESSION_SECRET, { issuer: 'nurseaid' });
    const result = await pool.query(
        'SELECT id, username, full_name, role, session_version FROM users WHERE id=$1',
        [claims.id]
    );
    const user = result.rows[0];
    if (!user || Number(claims.sessionVersion) !== Number(user.session_version)) {
        throw new Error('session-expired');
    }
    const wards = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1 ORDER BY ward_id', [user.id]);
    return {
        id: Number(user.id),
        username: user.username,
        name: user.full_name,
        role: user.role,
        wardIds: wards.rows.map(row => Number(row.ward_id)).filter(Number.isFinite)
    };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use(async (req, res, next) => {
    try {
        req.user = await loadUser(req);
        next();
    } catch (_) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        return res.redirect('/login');
    }
});

async function listPatients(user) {
    if (user.role === 'super_admin') {
        const result = await pool.query(
            `SELECT hm_number, name, bed_no, mac, ward_id
             FROM nurseaid
             WHERE NULLIF(BTRIM(COALESCE(hm_number, '')), '') IS NOT NULL
               AND NULLIF(BTRIM(COALESCE(mac, '')), '') IS NOT NULL
             ORDER BY ward_id NULLS LAST, bed_no NULLS LAST, hm_number`
        );
        return result.rows;
    }
    if (!user.wardIds.length) return [];
    const result = await pool.query(
        `SELECT hm_number, name, bed_no, mac, ward_id
         FROM nurseaid
         WHERE ward_id = ANY($1::int[])
           AND NULLIF(BTRIM(COALESCE(hm_number, '')), '') IS NOT NULL
           AND NULLIF(BTRIM(COALESCE(mac, '')), '') IS NOT NULL
         ORDER BY ward_id NULLS LAST, bed_no NULLS LAST, hm_number`,
        [user.wardIds]
    );
    return result.rows;
}

async function findPatient(user, hn) {
    const params = [hn];
    let where = 'hm_number=$1';
    if (user.role !== 'super_admin') {
        if (!user.wardIds.length) return null;
        params.push(user.wardIds);
        where += ' AND ward_id = ANY($2::int[])';
    }
    const result = await pool.query(
        `SELECT hm_number, name, bed_no, mac, ward_id
         FROM nurseaid WHERE ${where} LIMIT 1`,
        params
    );
    return result.rows[0] || null;
}

async function getCurrentAssignmentStart(mac) {
    if (!mac) return null;
    const result = await pool.query(
        'SELECT assign_time FROM device_history ' +
        'WHERE LOWER(mac) = LOWER($1) AND discharge_time IS NULL ' +
        'ORDER BY assign_time DESC, id DESC LIMIT 1',
        [mac]
    );
    const row = result.rows[0];
    return row ? row.assign_time : null;
}

app.get('/api/telemetry-history/:hn', async (req, res) => {
    const windowConfig = WINDOWS[String(req.query.hours || '24')] || WINDOWS['24'];
    try {
        const patient = await findPatient(req.user, req.params.hn);
        if (!patient) return res.status(404).json({ error: 'Patient not found' });

        const mac = normalizeMac(patient.mac);
        if (!mac) return res.json({ patient, points: [] });

        const assignmentStart = await getCurrentAssignmentStart(mac);
        const windowStart = new Date(Date.now() - parseDurationMs(windowConfig.range));
        const computedStart = assignmentStart && assignmentStart > windowStart
            ? assignmentStart
            : windowStart;
        const computedStartIso = computedStart.toISOString();

        const flux = `
            import "strings"

            from(bucket: "${influxConfig.bucket}")
                |> range(start: ${computedStartIso})
                |> filter(fn: (r) =>
                    (r._measurement == "ble_batt" or r._measurement == "ble_rssi") and
                    r._field == "value"
                )
                |> filter(fn: (r) =>
                    exists r.mac and strings.toLower(v: r.mac) == "${escapeFluxString(mac)}"
                )
                |> aggregateWindow(every: ${windowConfig.every}, fn: mean, createEmpty: false)
                |> sort(columns: ["_time"])
        `;

        const rows = await queryApi.collectRows(flux);
        const grouped = new Map();
        for (const row of rows) {
            const value = Number(row._value);
            const time = new Date(row._time);
            if (!Number.isFinite(value) || Number.isNaN(time.getTime())) continue;
            const key = time.toISOString();
            const point = grouped.get(key) || { time: key, battery: null, rssi: null };
            if (row._measurement === 'ble_batt' && value >= 0 && value <= 100) {
                point.battery = Math.round(value * 10) / 10;
            } else if (row._measurement === 'ble_rssi' && value >= -120 && value <= 0) {
                point.rssi = Math.round(value * 10) / 10;
            }
            grouped.set(key, point);
        }

        const points = [...grouped.values()]
            .filter(point => point.battery !== null || point.rssi !== null)
            .sort((a, b) => new Date(a.time) - new Date(b.time));

        return res.json({
            patient: {
                hn: patient.hm_number,
                name: patient.name,
                bed: patient.bed_no,
                mac: String(patient.mac || '').toUpperCase()
            },
            hours: Number(Object.keys(WINDOWS).find(key => WINDOWS[key] === windowConfig) || 24),
            points
        });
    } catch (error) {
        console.error('[Telemetry History API]', error.message);
        return res.status(500).json({ error: 'Unable to load telemetry history' });
    }
});

app.get('/telemetry-history', async (req, res) => {
    try {
        const patients = await listPatients(req.user);
        const options = patients.map(patient => {
            const label = [
                patient.bed_no ? 'เตียง ' + patient.bed_no : '',
                patient.name || '',
                patient.hm_number ? 'HN ' + patient.hm_number : ''
            ].filter(Boolean).join(' · ');
            return '<option value="' + escapeHtml(patient.hm_number) + '">' + escapeHtml(label) + '</option>';
        }).join('');

        res.type('html').send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>NurseAid · Battery / RSSI History</title>
    <link rel="stylesheet" href="/assets/fonts.css">
    <link rel="stylesheet" href="/assets/tailwind.css">
    <style>
        :root{color-scheme:light dark}
        body{font-family:Prompt,sans-serif;margin:0;background:#f5f7fb;color:#0f172a}
        .shell{max-width:1180px;margin:0 auto;padding:24px}
        .top{display:flex;justify-content:space-between;gap:16px;align-items:center;flex-wrap:wrap}
        .card{background:#fff;border:1px solid #e2e8f0;border-radius:18px;box-shadow:0 8px 24px rgba(15,23,42,.06)}
        .controls{padding:16px;display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:18px 0}
        label{font-size:12px;font-weight:700;color:#64748b;display:block;margin-bottom:6px}
        select{min-width:220px;border:1px solid #cbd5e1;border-radius:12px;padding:10px 12px;background:#fff;color:#0f172a}
        .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
        .metric{padding:18px;min-width:0}
        .metric-head{display:flex;justify-content:space-between;gap:10px;align-items:start;margin-bottom:12px}
        .metric-title{font-weight:800;font-size:14px}
        .metric-value{font-size:24px;font-weight:800}
        .summary{font-size:11px;color:#64748b;margin-top:4px}
        .chart{height:300px}
        .back{display:inline-flex;text-decoration:none;color:#2563eb;font-weight:700}
        .status{font-size:13px;color:#64748b;padding:4px 2px}
        @media(max-width:760px){.grid{grid-template-columns:1fr}.shell{padding:14px}.chart{height:240px}}
        @media(prefers-color-scheme:dark){
            body{background:#0d1117;color:#e6edf3}.card{background:#161b22;border-color:#30363d}
            select{background:#0d1117;color:#e6edf3;border-color:#30363d}label,.summary,.status{color:#8b949e}
        }
    </style>
</head>
<body>
<div class="shell">
    <div class="top">
        <div>
            <a class="back" href="/">← กลับหน้ามอนิเตอร์</a>
            <h1 style="font-size:24px;font-weight:900;margin:10px 0 2px">ประวัติ Battery / RSSI</h1>
            <div class="status">ข้อมูลย้อนหลังจาก InfluxDB ของ NurseAid</div>
        </div>
    </div>

    <div class="card controls">
        <div>
            <label for="patient">ผู้ป่วย / อุปกรณ์</label>
            <select id="patient">${options || '<option value="">ยังไม่มีอุปกรณ์ที่ผูกกับผู้ป่วย</option>'}</select>
        </div>
        <div>
            <label for="range">ช่วงเวลา</label>
            <select id="range">
                <option value="1">1 ชั่วโมง</option>
                <option value="6">6 ชั่วโมง</option>
                <option value="12">12 ชั่วโมง</option>
                <option value="24" selected>24 ชั่วโมง</option>
                <option value="72">3 วัน</option>
                <option value="168">7 วัน</option>
            </select>
        </div>
        <div id="status" class="status">พร้อมโหลดข้อมูล</div>
    </div>

    <div class="grid">
        <section class="card metric">
            <div class="metric-head">
                <div><div class="metric-title">Battery</div><div class="summary">ระดับแบตเตอรี่อุปกรณ์</div></div>
                <div style="text-align:right"><div id="battery-latest" class="metric-value">--%</div><div id="battery-summary" class="summary"></div></div>
            </div>
            <div class="chart"><canvas id="battery-chart"></canvas></div>
        </section>
        <section class="card metric">
            <div class="metric-head">
                <div><div class="metric-title">RSSI</div><div class="summary">ความแรงสัญญาณ Bluetooth</div></div>
                <div style="text-align:right"><div id="rssi-latest" class="metric-value">-- dBm</div><div id="rssi-summary" class="summary"></div></div>
            </div>
            <div class="chart"><canvas id="rssi-chart"></canvas></div>
        </section>
    </div>
</div>
<script src="/assets/chart.umd.js"></script>
<script>
(() => {
    const patient = document.getElementById('patient');
    const range = document.getElementById('range');
    const status = document.getElementById('status');
    let batteryChart = null;
    let rssiChart = null;

    function formatTime(ms, hours) {
        const d = new Date(ms);
        return Number(hours) <= 24
            ? d.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'})
            : d.toLocaleDateString('th-TH', {day:'2-digit', month:'short'}) + ' ' +
              d.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
    }

    function stats(values) {
        if (!values.length) return null;
        const sum = values.reduce((a,b) => a+b, 0);
        return {latest: values[values.length-1], min: Math.min(...values), max: Math.max(...values), avg: sum/values.length};
    }

    function buildChart(canvas, label, points, min, max, unit) {
        return new Chart(canvas, {
            type:'line',
            data:{datasets:[{label,data:points,borderWidth:2.3,pointRadius:0,pointHoverRadius:4,tension:.25,spanGaps:false}]},
            options:{
                responsive:true,maintainAspectRatio:false,animation:{duration:250},
                interaction:{intersect:false,mode:'nearest'},
                scales:{
                    x:{type:'linear',grid:{display:false},ticks:{maxTicksLimit:8,callback:v=>formatTime(v, range.value)}},
                    y:{min,max,ticks:{callback:v=>v+unit}}
                },
                plugins:{
                    legend:{display:false},
                    tooltip:{callbacks:{
                        title:items=>items.length?new Date(items[0].parsed.x).toLocaleString('th-TH'):'',
                        label:item=>label+': '+item.parsed.y+unit
                    }}
                }
            }
        });
    }

    async function load() {
        const hn = patient.value;
        if (!hn) return;
        status.textContent = 'กำลังโหลด…';
        try {
            const response = await fetch('/api/telemetry-history/' + encodeURIComponent(hn) + '?hours=' + encodeURIComponent(range.value));
            if (!response.ok) throw new Error('HTTP ' + response.status);
            const payload = await response.json();
            const batteryPoints = payload.points.filter(p=>Number.isFinite(p.battery)).map(p=>({x:new Date(p.time).getTime(),y:p.battery}));
            const rssiPoints = payload.points.filter(p=>Number.isFinite(p.rssi)).map(p=>({x:new Date(p.time).getTime(),y:p.rssi}));
            const batteryValues = batteryPoints.map(p=>p.y);
            const rssiValues = rssiPoints.map(p=>p.y);
            const bs = stats(batteryValues);
            const rs = stats(rssiValues);

            document.getElementById('battery-latest').textContent = bs ? Math.round(bs.latest) + '%' : '--%';
            document.getElementById('battery-summary').textContent = bs ? 'เฉลี่ย ' + bs.avg.toFixed(1) + '% · ต่ำสุด ' + bs.min.toFixed(0) + '% · สูงสุด ' + bs.max.toFixed(0) + '%' : 'ไม่มีข้อมูล';
            document.getElementById('rssi-latest').textContent = rs ? Math.round(rs.latest) + ' dBm' : '-- dBm';
            document.getElementById('rssi-summary').textContent = rs ? 'เฉลี่ย ' + rs.avg.toFixed(0) + ' dBm · ต่ำสุด ' + rs.min.toFixed(0) + ' · สูงสุด ' + rs.max.toFixed(0) : 'ไม่มีข้อมูล';

            if (batteryChart) batteryChart.destroy();
            if (rssiChart) rssiChart.destroy();
            batteryChart = buildChart(document.getElementById('battery-chart'), 'Battery', batteryPoints, 0, 100, '%');
            rssiChart = buildChart(document.getElementById('rssi-chart'), 'RSSI', rssiPoints, -120, 0, ' dBm');
            status.textContent = (payload.patient.name || payload.patient.hn) + ' · ' + payload.patient.mac + ' · ' + payload.points.length + ' จุดข้อมูล';
        } catch (error) {
            console.error(error);
            status.textContent = 'โหลดข้อมูลไม่สำเร็จ';
        }
    }

    patient.addEventListener('change', load);
    range.addEventListener('change', load);
    load();
})();
</script>
</body>
</html>`);
    } catch (error) {
        console.error('[Telemetry History Page]', error.message);
        res.status(500).send('Unable to load telemetry history');
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('[Telemetry History] listening on :' + PORT);
});
