const express = require('express');
const { Pool } = require('pg');
const { InfluxDB } = require('@influxdata/influxdb-client');
const cors = require('cors');
const app = express();

const PORT = 3333;

// --- [ CONFIGURATION ] ---
const pool = new Pool({
    user: 'postgres', host: '172.16.0.64', database: 'softwatch_iot',
    password: 'NewSoftTech^2', port: 5432,
});

const influxConfig = {
    url: 'http://172.16.0.153:8086',
    token: 'gRaARwF5SIvtm01RIVeltbmx86tpEmzfiAWsgkFhFt0qgS6u4-qPj8siTnS0tuuIzT7dz9S1nKAkzV1oo9ICsg==',
    org: 'softsquaregroup', 
    bucket: 'naret2' 
};
const queryApi = new InfluxDB({ url: influxConfig.url, token: influxConfig.token }).getQueryApi(influxConfig.org);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- [ ALERT SYSTEM CONFIGURATION ] ---
const LINE_TOKEN = 'c4MVrlwlqsuYusEEKxw28Dpb8p3dKx5Z1DATTuzvcMznd0na8jZzOPWIlSUCKZqMix9XllfrqG/7yK/GVAuZ2VJgFaOzMAXIgoaruW9lShiQgQGQ5XHuxL1uiYQuS/rEUxLOXzv5aOPT1xjWK4Hs4QdB04t89/1O/w1cDnyilFU=';
const GROUP_ID = 'C02fd71d3db999dd6bc182cd88c6c33d4'; // ใส่ Group ID ของคุณที่นี่
const deviceAlertState = {}; 

async function triggerAlert(mac, bed, name, level, msg) {
    // 1. บันทึก Log ลง Database
    try {
        await pool.query(
            'INSERT INTO alert_logs (mac, bed_no, patient_name, level, message) VALUES ($1, $2, $3, $4, $5)',
            [mac, bed, name, level, msg]
        );
    } catch(e) { console.error("DB Log Error:", e.message); }

    // 2. ส่งข้อมูลหา LINE (Messaging API / Bot Push)
    if (LINE_TOKEN && GROUP_ID) {
        const icon = level === 'critical' ? '🔴' : '🟡';
        const lineText = `${icon} แจ้งเตือน: ${level.toUpperCase()}\nเตียง: ${bed || '-'}\nคนไข้: ${name}\nรายละเอียด: ${msg}`;
        
        try {
            const response = await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LINE_TOKEN}`
                },
                body: JSON.stringify({
                    to: GROUP_ID,
                    messages: [{ type: 'text', text: lineText }]
                })
            });

            if (!response.ok) {
                const errData = await response.json();
                console.error("LINE API Error Response:", JSON.stringify(errData));
            }
        } catch(e) { 
            console.error("LINE Fetch Error:", e.message); 
        }
    }
}
// --- [ UI ENGINE ] ---
const ui = (active, content, script = "") => `
<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>NurseAid PRO</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        body { font-family: 'Prompt', sans-serif; background: #f1f5f9; }
        
        /* ====== ALERTS CSS ====== */
        @keyframes criticalFlash {
            0% { background-color: #ffffff; }
            50% { background-color: #fee2e2; }
            100% { background-color: #ffffff; }
        }
        @keyframes warningFlash {
            0% { background-color: #ffffff; }
            50% { background-color: #fef08a; }
            100% { background-color: #ffffff; }
        }

        .critical-card { animation: criticalFlash 1s infinite; border: 2px solid #dc2626 !important; }
        .warning-card { animation: warningFlash 1.5s infinite; border: 2px solid #eab308 !important; }

        .critical-banner { background: #dc2626; color: white; font-weight: 900; text-align: center; padding: 6px; font-size: 12px; letter-spacing: 1px; margin-bottom: 10px; border-radius: 6px; }
        .warning-banner { background: #eab308; color: #713f12; font-weight: 900; text-align: center; padding: 6px; font-size: 12px; letter-spacing: 1px; margin-bottom: 10px; border-radius: 6px; }

        .nav-active { background: #2563eb; color: white; border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.2); }
        .modal { display: none; position: fixed; inset: 0; background: rgba(15, 23, 42, 0.8); z-index: 100; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
        .card { background: white; border-radius: 1.25rem; border: 1px solid #e2e8f0; transition: all 0.3s; }
        th { background: #f8fafc; color: #64748b; font-size: 0.7rem; text-transform: uppercase; padding: 12px; text-align: left; border-bottom: 1px solid #e2e8f0; }
        td { padding: 12px; border-bottom: 1px solid #f1f5f9; font-size: 0.85rem; }
        .admin-only { display: none !important; }
        body.is-admin .admin-only { display: block !important; }

        /* ขยายขนาด Side Panel ให้ใหญ่ขึ้น (800px) */
        #sidePanel { 
            position: fixed; top: 0; right: -850px; width: 800px; height: 100vh; 
            background: white; z-index: 1000; transition: 0.5s cubic-bezier(0.4, 0, 0.2, 1); 
            box-shadow: -15px 0 50px rgba(0,0,0,0.15); padding: 2.5rem; overflow-y: auto;
        }
        #sidePanel.active { right: 0; }
        .panel-overlay { 
            position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5); 
            z-index: 999; display: none; backdrop-filter: blur(4px); 
        }
        @media (max-width: 800px) { #sidePanel { width: 100%; right: -100%; } }
    </style>
</head>
<body class="flex flex-col md:flex-row min-h-screen">
    <aside class="w-full md:w-64 bg-white border-r p-6 flex flex-col shadow-sm z-50">
        <div class="text-center mb-8">
            <h1 class="text-2xl font-black text-blue-600 italic uppercase">Nurse <span class="text-slate-800">Aid</span></h1>
            <p class="text-[9px] font-bold text-slate-400 tracking-widest uppercase">Smart Hospital System</p>
        </div>
        <div class="mb-6 p-4 bg-slate-50 rounded-2xl border border-slate-100 text-sm">
            <p id="display-nurse" class="font-bold text-slate-700 italic">Checking...</p>
            <p id="display-role" class="text-[9px] text-slate-400 font-bold uppercase"></p>
        </div>
        <nav class="flex flex-col gap-1.5 flex-1">
            <a href="/" class="p-3 ${active==='dash'?'nav-active':'text-slate-500 hover:bg-slate-50'} flex items-center gap-3 font-semibold transition-all text-sm"><span>📊</span> Monitor</a>
            <a href="/export" class="p-3 ${active==='export'?'nav-active':'text-slate-500 hover:bg-slate-50'} flex items-center gap-3 font-semibold transition-all text-sm"><span>📥</span> Report</a>
            <a href="/devices-mgmt" class="p-3 ${active==='devs'?'nav-active':'text-slate-500 hover:bg-slate-50'} flex items-center gap-3 font-semibold transition-all text-sm"><span>📟</span> Devices</a>
            <a href="/patients-mgmt" class="p-3 ${active==='pats'?'nav-active':'text-slate-500 hover:bg-slate-50'} flex items-center gap-3 font-semibold transition-all text-sm"><span>👥</span> Patients</a>
            <a href="/matching" class="p-3 ${active==='match'?'nav-active':'text-slate-500 hover:bg-slate-50'} flex items-center gap-3 font-semibold transition-all text-sm"><span>⌚</span> Pairing</a>
            <a href="/users-mgmt" class="admin-only p-3 ${active==='users'?'nav-active':'text-slate-500 hover:bg-slate-50'} flex items-center gap-3 font-semibold transition-all text-sm"><span>🛡️</span> Users</a>
        </nav>
        <button onclick="logout()" class="text-red-500 font-bold p-3 border-t mt-4 hover:bg-red-50 rounded-xl transition-all flex items-center gap-3 text-sm"><span>🚪</span> Logout</button>
    </aside>

    <main class="flex-1 p-6 md:p-8 overflow-auto">${content}</main>

    <div id="globalModal" class="modal"><div class="bg-white p-8 rounded-3xl w-full max-w-md shadow-2xl transition-all"><h3 id="modalTitle" class="text-xl font-bold mb-6 text-slate-800"></h3><div id="modalBody" class="space-y-4"></div><div class="flex gap-3 mt-8"><button onclick="document.getElementById('globalModal').style.display='none'" class="flex-1 p-3 bg-slate-100 text-slate-600 rounded-xl font-bold">ยกเลิก</button><button id="modalSubmit" class="flex-1 p-3 bg-blue-600 text-white rounded-xl font-bold">ตกลง</button></div></div></div>

    <div id="panelOverlay" class="panel-overlay" onclick="closePanel()"></div>
    <div id="sidePanel">
        <div class="flex justify-between items-start mb-8">
            <div>
                <h2 id="p-title" class="text-3xl font-black text-slate-800 uppercase">Trend</h2>
                <p id="p-hn" class="text-sm text-blue-600 font-bold tracking-widest mt-1"></p>
                <div class="mt-2 bg-slate-100 text-[10px] px-3 py-1 rounded-full font-bold text-slate-500 uppercase italic">Show: Last 24 Hours</div>
            </div>
            <button onclick="closePanel()" class="bg-slate-50 hover:bg-red-50 hover:text-red-500 p-2 rounded-2xl transition-all text-2xl">✕</button>
        </div>
        <div class="grid grid-cols-1 gap-8">
            <div class="card p-6 border-none bg-slate-50 shadow-sm">
                <div class="flex justify-between items-center mb-4">
                    <p class="text-xs font-bold text-red-500 uppercase">🫀 Heart Rate (BPM)</p>
                    <span id="avg-hr" class="text-[10px] font-mono text-slate-400"></span>
                </div>
                <div class="h-[220px]"><canvas id="chartHR_Panel"></canvas></div>
            </div>
            <div class="card p-6 border-none bg-slate-50 shadow-sm">
                <div class="flex justify-between items-center mb-4">
                    <p class="text-xs font-bold text-blue-500 uppercase">💧Oxygen Saturation (SpO2 %)</p>
                    <span id="avg-spo2" class="text-[10px] font-mono text-slate-400"></span>
                </div>
                <div class="h-[220px]"><canvas id="chartSPO2_Panel"></canvas></div>
            </div>
            <div class="card p-6 border-none bg-slate-50 shadow-sm">
                <div class="flex justify-between items-center mb-4">
                    <p class="text-xs font-bold text-orange-500 uppercase">🌡 Body Temperature (°C)</p>
                    <span id="avg-temp" class="text-[10px] font-mono text-slate-400"></span>
                </div>
                <div class="h-[220px]"><canvas id="chartTEMP_Panel"></canvas></div>
            </div>
        </div>
    </div>

    <audio id="alertSound" src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg" preload="auto"></audio>

    <script>
        const nurse = localStorage.getItem('nurse_name');
        const role = localStorage.getItem('user_role');
        if(!nurse && window.location.pathname !== '/login') window.location.href = '/login';
        if(role === 'admin') document.body.classList.add('is-admin');
        document.getElementById('display-nurse').innerText = nurse || 'Guest';
        document.getElementById('display-role').innerText = role === 'admin' ? '🛡️ Administrator' : '👁️ Viewer';
        
        function logout() { localStorage.clear(); window.location.href = '/login'; }
        
        function openModal(title, bodyHtml, submitFn) {
            document.getElementById('modalTitle').innerText = title;
            document.getElementById('modalBody').innerHTML = bodyHtml;
            document.getElementById('modalSubmit').onclick = submitFn;
            document.getElementById('globalModal').style.display = 'flex';
        }

        function playAlert() { document.getElementById('alertSound').play().catch(e => {}); }

        let panelCharts = {};

        function closePanel() {
            document.getElementById('sidePanel').classList.remove('active');
            document.getElementById('panelOverlay').style.display = 'none';
        }

        async function showTrend(mac, name, hn) {
            document.getElementById('p-title').innerText = name;
            document.getElementById('p-hn').innerText = 'HN: ' + hn;
            document.getElementById('sidePanel').classList.add('active');
            document.getElementById('panelOverlay').style.display = 'block';

            const res = await fetch(\`/api/patient-trend-24h/\${mac}\`);
            const data = await res.json();
            
            const labels = data.map(d => {
                const date = new Date(d._time);
                return date.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
            });

            const render = (id, label, color, key, min, max) => {
                if(panelCharts[id]) panelCharts[id].destroy();
                panelCharts[id] = new Chart(document.getElementById(id), {
                    type: 'line',
                    data: {
                        labels,
                        datasets: [{ 
                            label, 
                            data: data.map(d => d[key]), 
                            borderColor: color, 
                            backgroundColor: color + '10', 
                            fill: true, tension: 0.4, pointRadius: 0, borderWidth: 2
                        }]
                    },
                    options: { 
                        responsive: true, maintainAspectRatio: false, 
                        interaction: { intersect: false, mode: 'index' },
                        plugins: { legend: { display: false } },
                        scales: { 
                            y: { min, max, grid: { color: '#e2e8f0', borderDash: [5, 5] } }, 
                            x: { 
                                grid: { display: false },
                                ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } 
                            } 
                        }
                    }
                });
            };

            render('chartHR_Panel', 'HR', '#ef4444', 'ble_heart', 40, 160);
            render('chartSPO2_Panel', 'SpO2', '#3b82f6', 'ble_spo2', 80, 100);
            render('chartTEMP_Panel', 'Temp', '#f97316', 'ble_temp', 34, 41);
        }

        ${script}
    </script>
</body>
</html>`;

const adminOnly = (req, res, next) => {
    const userRole = (req.body && req.body.role) || (req.query && req.query.role) || 'viewer';
    if(userRole === 'admin') next(); else res.status(403).json({error: 'Forbidden'});
};

// --- [ API ROUTES ] ---

app.post('/api/login', async(req,res)=>{
    const r = await pool.query('SELECT full_name, role FROM users WHERE username=$1 AND password=$2',[req.body.u,req.body.p]);
    if(r.rows.length>0) res.json({success:true, name:r.rows[0].full_name, role:r.rows[0].role});
    else res.json({success:false});
});

app.get('/api/live-status', async (req, res) => {
    try {
        const activeDevices = await pool.query(
            'SELECT mac, device_no, name, hm_number, bed_no FROM nurseaid WHERE hm_number IS NOT NULL'
        );
        if (activeDevices.rows.length === 0) return res.json([]);
        const fluxQuery = `
        from(bucket: "${influxConfig.bucket}")
            |> range(start: -5m)
            |> filter(fn: (r) =>
                r._measurement == "ble_heart" or
                r._measurement == "ble_spo2" or
                r._measurement == "ble_temp" or
                r._measurement == "ble_status"
            )
            |> group(columns: ["mac", "_measurement"])
            |> last()
            |> pivot(rowKey:["mac"], columnKey: ["_measurement"], valueColumn: "_value")
        `;
        const influxData = [];
        queryApi.queryRows(fluxQuery, {
            next(row, tableMeta) {
                const obj = tableMeta.toObject(row);
                if (obj.mac) obj.mac = obj.mac.toLowerCase().trim();
                influxData.push(obj);
            },
            error(err) { res.json([]); },
            complete() {
                const result = activeDevices.rows.map(dev => {
                    const dbMac = dev.mac?.toLowerCase().trim();
                    const sensor = influxData.find(s => s.mac === dbMac);
                    
                    let hr = '--', spo2 = '--', temp = '--', status = 'Offline';
                    let alertLevel = 'normal'; // 'normal', 'warning', 'critical'
                    let alertCauses = [];

                    if (sensor) {
                        const hrNum = parseInt(sensor.ble_heart);
                        const spo2Num = parseInt(sensor.ble_spo2);
                        const tempNum = parseFloat(sensor.ble_temp);
                        const statusNum = parseInt(sensor.ble_status);
                        
                        hr = (!isNaN(hrNum) && hrNum > 0) ? hrNum : '--';
                        spo2 = (!isNaN(spo2Num) && spo2Num > 0) ? spo2Num : '--';
                        temp = (!isNaN(tempNum) && tempNum > 0) ? tempNum : '--';
                        status = (!isNaN(statusNum) && statusNum === 1) ? 'Online' : 'Offline';

                        if (status === 'Online') {
                            // การตั้งค่าแจ้งเตือน
                            if (hr !== '--' && (hr > 120 || hr < 50)) {
                                alertLevel = 'critical';
                                alertCauses.push(`HR=${hr}`);
                            }
                            if (temp !== '--' && (temp > 37.8 || temp < 35.5)) {
                                alertLevel = 'critical';
                                alertCauses.push(`Temp=${temp}`);
                            }
                            if (spo2 !== '--') {
                                if (spo2 <= 90) {
                                    alertLevel = 'critical';
                                    alertCauses.push(`SpO2=${spo2}% (วิกฤต)`);
                                } else if (spo2 > 90 && spo2 <= 94) {
                                    if (alertLevel !== 'critical') alertLevel = 'warning';
                                    alertCauses.push(`SpO2=${spo2}% (ต่ำ)`);
                                }
                            }

                            // ตรวจสอบและส่งแจ้งเตือนเฉพาะตอนมีการเปลี่ยนแปลงสถานะ
                            const prevState = deviceAlertState[dbMac] || 'normal';
                            if (alertLevel !== 'normal' && alertLevel !== prevState) {
                                triggerAlert(dbMac, dev.bed_no, dev.name, alertLevel, alertCauses.join(', '));
                            }
                            deviceAlertState[dbMac] = alertLevel;
                        } else {
                            deviceAlertState[dbMac] = 'offline';
                        }
                    }
                    return { ...dev, hr, spo2, temp, status, alertLevel };
                });
                res.json(result);
            }
        });
    } catch (err) { res.json([]); }
});

// API ใหม่สำหรับดึงข้อมูล 24 ชั่วโมง
app.get('/api/patient-trend-24h/:mac', async (req, res) => {
    const { mac } = req.params;
    const flux = `
        from(bucket: "${influxConfig.bucket}")
        |> range(start: -24h)
        |> filter(fn: (r) => r["mac"] == "${mac}")
        |> filter(fn: (r) => r["_field"] == "value")
        |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
        |> pivot(rowKey:["_time"], columnKey: ["_measurement"], valueColumn: "_value")
        |> keep(columns: ["_time", "ble_heart", "ble_spo2", "ble_temp"])
        |> sort(columns: ["_time"], desc: false)`;
    
    const results = [];
    queryApi.queryRows(flux, {
        next(row, tableMeta) { results.push(tableMeta.toObject(row)); },
        error(e) { res.status(500).json([]); },
        complete() { res.json(results); }
    });
});

app.get('/', (req, res) => res.send(ui('dash', `
    <div class="flex justify-between items-center mb-8">
        <div>
            <h2 class="text-2xl font-black text-slate-800 uppercase leading-none">Patient Dashboard</h2>
            <p class="text-slate-400 text-[10px] font-bold mt-1">INDIVIDUAL MONITORING</p>
        </div>
        <div id="last-sync" class="text-[10px] font-bold bg-white px-4 py-2 rounded-full border text-slate-400 font-mono italic shadow-sm">🔄 Syncing...</div>
    </div>

    <div id="global-alert" class="hidden bg-red-600 text-white text-center py-3 px-4 rounded-2xl mb-6 font-black animate-pulse shadow-lg text-lg"></div>

    <div id="monitor-grid" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-6"></div>
`, `
    const DEFAULT_LIMITS = { hrMin: 50, hrMax: 120, spo2Min: 95, tempMin: 35.5, tempMax: 37.5 };

    function getLimits(mac) {
        const allSettings = JSON.parse(localStorage.getItem('patient_thresholds')) || {};
        return allSettings[mac] || { ...DEFAULT_LIMITS };
    }

    function openIndividualConfig(mac, name, bed) {
        const current = getLimits(mac);
        const html = \`
            <div class="bg-blue-50 p-4 rounded-2xl mb-4 text-center">
                <p class="text-xs font-bold text-blue-600 uppercase">ตั้งค่าขีดจำกัดรายบุคคล</p>
                <p class="font-bold text-slate-800">เตียง \${bed}: \${name}</p>
            </div>
            <div class="grid grid-cols-2 gap-4 text-sm">
                <div class="col-span-2 font-bold text-slate-500 border-b pb-1">Heart Rate (BPM)</div>
                <div><label class="text-[10px]">Min</label><input type="number" id="th-hrMin" value="\${current.hrMin}" class="w-full border p-2 rounded-lg"></div>
                <div><label class="text-[10px]">Max</label><input type="number" id="th-hrMax" value="\${current.hrMax}" class="w-full border p-2 rounded-lg"></div>
                <div class="col-span-2 font-bold text-slate-500 border-b pb-1 mt-2">SpO2 (%)</div>
                <div class="col-span-2"><label class="text-[10px]">ต่ำกว่า (Min %)</label><input type="number" id="th-spo2Min" value="\${current.spo2Min}" class="w-full border p-2 rounded-lg"></div>
                <div class="col-span-2 font-bold text-slate-500 border-b pb-1 mt-2">Temperature (°C)</div>
                <div><label class="text-[10px]">Min</label><input type="number" id="th-tempMin" value="\${current.tempMin}" step="0.1" class="w-full border p-2 rounded-lg"></div>
                <div><label class="text-[10px]">Max</label><input type="number" id="th-tempMax" value="\${current.tempMax}" step="0.1" class="w-full border p-2 rounded-lg"></div>
            </div>
            <button onclick="window.resetToDefault('\${mac}')" class="w-full mt-4 text-[10px] text-slate-400 underline italic">ล้างค่าและใช้ค่าเริ่มต้น</button>
        \`;
        openModal('⚙️ Settings', html, () => {
            const allSettings = JSON.parse(localStorage.getItem('patient_thresholds')) || {};
            allSettings[mac] = {
                hrMin: parseInt(document.getElementById('th-hrMin').value),
                hrMax: parseInt(document.getElementById('th-hrMax').value),
                spo2Min: parseInt(document.getElementById('th-spo2Min').value),
                tempMin: parseFloat(document.getElementById('th-tempMin').value),
                tempMax: parseFloat(document.getElementById('th-tempMax').value)
            };
            localStorage.setItem('patient_thresholds', JSON.stringify(allSettings));
            document.getElementById('globalModal').style.display='none';
            updateDash();
        });
    }

    window.resetToDefault = (mac) => {
        const allSettings = JSON.parse(localStorage.getItem('patient_thresholds')) || {};
        delete allSettings[mac];
        localStorage.setItem('patient_thresholds', JSON.stringify(allSettings));
        document.getElementById('globalModal').style.display='none';
        updateDash();
    };

    let alertInterval = null;
    function startAlertLoop(){ if(!alertInterval){ playAlert(); alertInterval = setInterval(()=>playAlert(), 2000); } }
    function stopAlertLoop(){ if(alertInterval){ clearInterval(alertInterval); alertInterval = null; } }

    async function updateDash() {
        try {
            const r = await fetch('/api/live-status');
            const data = await r.json();
            const grid = document.getElementById('monitor-grid');
            const globalBanner = document.getElementById('global-alert');
            
            if(!data || data.length === 0) {
                grid.innerHTML = '<p class="col-span-full text-center p-12 text-slate-300 italic">ไม่มีข้อมูลคนไข้ในขณะนี้</p>';
                return;
            }

            let criticalBeds = [];
            grid.innerHTML = data.map(p => {
                const isOnline = p.status === 'Online';
                const limit = getLimits(p.mac);
                const isHrCrit = isOnline && p.hr !== '--' && (p.hr > limit.hrMax || p.hr < limit.hrMin);
                const isSpo2Crit = isOnline && p.spo2 !== '--' && (p.spo2 < limit.spo2Min);
                const isTempCrit = isOnline && p.temp !== '--' && (p.temp > limit.tempMax || p.temp < limit.tempMin);
                const isCrit = isHrCrit || isSpo2Crit || isTempCrit;
                if(isCrit) criticalBeds.push(p.bed_no || '-');

                const statusColor = isOnline ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-slate-300';
                const hasCustom = (JSON.parse(localStorage.getItem('patient_thresholds')) || {})[p.mac];

                return \`
                <div class="card p-4 border-t-4 \${isCrit ? 'border-red-600 critical-card shadow-lg' : (isOnline ? 'border-green-500 shadow-sm' : 'border-slate-200 shadow-sm')} transition-all">
                    <div class="flex items-center justify-between mb-4 gap-2 border-b pb-2">
                        <div class="flex items-center gap-2 overflow-hidden flex-1">
                            <span class="shrink-0 bg-slate-800 text-white text-[10px] px-2 py-0.5 rounded font-bold italic uppercase tracking-tighter">\${p.bed_no || '-'}</span>
                            <div class="w-2.5 h-2.5 shrink-0 rounded-full \${statusColor}"></div>
                            <h4 class="font-bold text-slate-800 text-sm truncate cursor-pointer hover:text-blue-600" onclick="showTrend('\${p.mac}', '\${p.name}', '\${p.hm_number}')">
                                \${p.name}
                            </h4>
                            <span class="shrink-0 text-[9px] text-slate-400 font-bold border-l pl-2 leading-none uppercase">HN: \${p.hm_number}</span>
                            \${hasCustom ? '<span class="text-[10px] shrink-0" title="ตั้งค่าเฉพาะบุคคล"></span>' : ''}
                        </div>
                        <button onclick="openIndividualConfig('\${p.mac}', '\${p.name}', '\${p.bed_no}')" class="shrink-0 text-slate-300 hover:text-blue-600 p-1">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                        </button>
                    </div>

                    <div class="grid grid-cols-3 gap-2">
                        <div class="\${isHrCrit ? 'bg-red-50 ring-1 ring-red-200' : 'bg-slate-50'} p-2 rounded-xl text-center">
                            <p class="text-[8px] font-bold text-slate-400 uppercase">HR</p>
                            <p class="text-3xl font-black \${isHrCrit ? 'text-red-600' : 'text-slate-700'} tracking-tighter">\${p.hr}</p>
                        </div>
                        <div class="\${isSpo2Crit ? 'bg-red-50 ring-1 ring-red-200' : 'bg-slate-50'} p-2 rounded-xl text-center">
                            <p class="text-[8px] font-bold text-slate-400 uppercase">SpO2</p>
                            <p class="text-3xl font-black \${isSpo2Crit ? 'text-red-600' : 'text-slate-700'} tracking-tighter">\${p.spo2}</p>
                        </div>
                        <div class="\${isTempCrit ? 'bg-red-50 ring-1 ring-red-200' : 'bg-slate-50'} p-2 rounded-xl text-center">
                            <p class="text-[8px] font-bold text-slate-400 uppercase">Temp</p>
                            <p class="text-3xl font-black \${isTempCrit ? 'text-red-600' : 'text-slate-700'} tracking-tighter">\${p.temp}</p>
                        </div>
                    </div>
                </div>\`;
            }).join('');

            if(criticalBeds.length > 0){
                globalBanner.classList.remove('hidden');
                globalBanner.innerText = '🚨 วิกฤต: เตียง ' + criticalBeds.join(', ');
                startAlertLoop();
            } else {
                globalBanner.classList.add('hidden');
                stopAlertLoop();
            }
            document.getElementById('last-sync').innerText = 'Last Sync: ' + new Date().toLocaleTimeString();
        } catch(e) { console.error('Dashboard Update Error:', e); }
    }

    updateDash();
    setInterval(updateDash, 5000);
`)));

app.get('/export', async (req, res) => {
    const r = await pool.query('SELECT mac, name, hm_number, bed_no FROM nurseaid WHERE hm_number IS NOT NULL');
    const opts = r.rows.map(p => `<option value="${p.mac}">[${p.bed_no}] ${p.name} (${p.hm_number})</option>`).join('');
    
    res.send(ui('export', `
        <h2 class="text-2xl font-black text-slate-800 uppercase mb-8">Export Data</h2>
        <div class="card p-8 shadow-xl max-w-2xl">
            <div class="space-y-4">
                <select id="e-mac" class="w-full border p-4 rounded-2xl bg-slate-50 outline-none">${opts}</select>
                <div class="grid grid-cols-2 gap-4">
                    <input id="e-start" type="datetime-local" class="border p-4 rounded-2xl bg-slate-50">
                    <input id="e-stop" type="datetime-local" class="border p-4 rounded-2xl bg-slate-50">
                </div>
                <button onclick="doExp()" class="w-full bg-slate-900 text-white p-4 rounded-2xl font-bold">GENERATE CSV</button>
            </div>
        </div>
    `, `
        // ตั้งค่าเวลาเริ่มต้น (ย้อนหลัง 1 วัน)
        const now = new Date();
        const tzOffset = now.getTimezoneOffset() * 60000;
        document.getElementById('e-start').value = new Date(Date.now() - 86400000 - tzOffset).toISOString().slice(0, 16);
        document.getElementById('e-stop').value = new Date(Date.now() - tzOffset).toISOString().slice(0, 16);

        async function doExp() {
            try {
                const el = document.getElementById('e-mac');
                const mac = el.value;
                // ดึงข้อความจาก Option ที่เลือก เช่น "[Bed 1] นายเอ (64001)"
                const fullText = el.options[el.selectedIndex].text;
                // ล้างอักขระพิเศษออกให้เป็นไฟล์ name ที่ปลอดภัย
                const sanitizedInfo = fullText.replace(/[^a-zA-Z0-9ก-๙]/g, '_');

                const start = document.getElementById('e-start').value;
                const stop = document.getElementById('e-stop').value;

                if(!start || !stop) return alert('กรุณาเลือกวันที่');

                const url = '/api/export-data?mac=' + mac + '&start=' + start + '&stop=' + stop;
                const response = await fetch(url);
                const data = await response.json();
                
                if(!data || data.length === 0) {
                    alert('ไม่พบข้อมูลในช่วงเวลานี้');
                    return;
                }

                let csv = "\\uFEFFTime,HN,Name,HR,SpO2,Temp\\n";
                data.forEach(i => {
                    csv += i._time_str + ',' + i.hm_number + ',' + i.patient_name + ',' + 
                           (i.ble_heart || '--') + ',' + (i.ble_spo2 || '--') + ',' + (i.ble_temp || '--') + '\\n';
                });

                // สร้างชื่อไฟล์: Report_ชื่อคนไข้_วันที่.csv
                const d = new Date();
                const dateStr = d.getDate() + "-" + (d.getMonth() + 1) + "-" + (d.getFullYear() + 543);
                const fileName = "Report_" + sanitizedInfo + "_" + dateStr + ".csv";

                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement("a");
                link.href = URL.createObjectURL(blob);
                link.download = fileName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            } catch (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            }
        }
    `));
});


app.get('/api/export-data', async (req, res) => {
    const { mac, start, stop } = req.query;
    try {
        const queryText = `
            SELECT 
                -- ปัดเศษ Milliseconds ทิ้งเพื่อให้ GROUP BY รวมวินาทีเดียวกันได้
                to_char(date_trunc('second', recorded_at), 'DD/MM/YYYY HH24:MI:SS') as _time_str, 
                hm_number, 
                patient_name, 
                MAX(heart_rate) as ble_heart, 
                MAX(spo2) as ble_spo2, 
                MAX(temperature) as ble_temp
            FROM vital_signs_logs
            WHERE mac = $1 
            AND recorded_at BETWEEN $2::timestamp AND $3::timestamp
            -- ต้อง GROUP BY ด้วยวินาทีที่ตัดเศษแล้ว
            GROUP BY date_trunc('second', recorded_at), hm_number, patient_name
            ORDER BY date_trunc('second', recorded_at) DESC
        `;
        const result = await pool.query(queryText, [mac, start, stop]);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});
app.get('/devices-mgmt', async (req, res) => {
    const r = await pool.query('SELECT * FROM nurseaid ORDER BY device_no');
    const rows = r.rows.map(d => `<tr><td class="font-bold">#${d.device_no}</td><td class="font-mono text-slate-400 text-xs">${d.mac}</td><td class="text-right admin-only"><button onclick="editD('${d.mac}','${d.device_no}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delD('${d.mac}')" class="text-red-400 font-bold">ลบ</button></td></tr>`).join('');
    res.send(ui('devs', `<div class="grid md:grid-cols-3 gap-8"><div class="admin-only card p-6 h-fit"><h3 class="font-bold mb-6">📟 เพิ่มอุปกรณ์</h3><div class="space-y-4"><input id="dno" placeholder="Device No" class="w-full border p-3 rounded-xl bg-slate-50"><input id="m_addr" placeholder="MAC Address" class="w-full border p-3 rounded-xl bg-slate-50"><button onclick="addD()" class="w-full bg-slate-800 text-white p-4 rounded-xl font-bold">เพิ่ม</button></div></div><div class="md:col-span-2 card overflow-hidden"><table><thead><tr><th>No</th><th>MAC</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table></div></div>`, `
        window.addD = async () => { await fetch('/api/devices', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dno:document.getElementById('dno').value,mac:document.getElementById('m_addr').value,role: localStorage.getItem('user_role')}) }); location.reload(); }
        window.editD = (mac, dno) => { openModal('✏️ แก้ไข', '<input id="edno" value="'+dno+'" class="w-full border p-3 rounded-xl bg-slate-50">', async () => { await fetch('/api/devices/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac, newDno:document.getElementById('edno').value, role: localStorage.getItem('user_role')}) }); location.reload(); }); }
        window.delD = async (m) => { if(confirm('ลบ?')) { await fetch('/api/devices/'+m+'?role='+localStorage.getItem('user_role'), {method:'DELETE'}); location.reload(); } }
    `));
});

app.get('/patients-mgmt', async (req, res) => {
    const r = await pool.query('SELECT * FROM patients ORDER BY name');
    const rows = r.rows.map(p => `<tr><td class="font-bold text-blue-600">${p.hn_number}</td><td>${p.name}</td><td class="text-right admin-only"><button onclick="editP('${p.hn_number}','${p.name}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delP('${p.hn_number}')" class="text-red-500 font-bold">ลบ</button></td></tr>`).join('');
    res.send(ui('pats', `<div class="grid md:grid-cols-3 gap-8"><div class="admin-only card p-6 h-fit"><h3 class="font-bold mb-6">👥 เพิ่มคนไข้</h3><div class="space-y-4"><input id="p_hn" placeholder="HN" class="w-full border p-3 rounded-xl bg-slate-50"><input id="p_nm" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50"><button onclick="addP()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button></div></div><div class="md:col-span-2 card overflow-hidden"><table><thead><tr><th>HN</th><th>Name</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table></div></div>`, `
        window.addP = async () => { await fetch('/api/patients', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({hn:document.getElementById('p_hn').value,nm:document.getElementById('p_nm').value,role: localStorage.getItem('user_role')}) }); location.reload(); }
        window.editP = (hn, name) => { openModal('✏️ แก้ไข', '<input id="enm" value="'+name+'" class="w-full border p-3 rounded-xl bg-slate-50">', async () => { await fetch('/api/patients/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({hn, newName:document.getElementById('enm').value, role: localStorage.getItem('user_role')}) }); location.reload(); }); }
        window.delP = async (id) => { if(confirm('ลบ?')) { await fetch('/api/patients/'+id+'?role='+localStorage.getItem('user_role'), {method:'DELETE'}); location.reload(); } }
    `));
});

app.get('/matching', async (req, res) => {
    const r = await pool.query('SELECT * FROM nurseaid ORDER BY device_no ASC');
    const cards = r.rows.map(x => `<div class="card p-6 ${x.hm_number?'bg-blue-50 border-blue-200':''}"><div class="flex justify-between mb-4"><span class="bg-slate-800 text-white text-[10px] px-2 py-1 rounded font-bold uppercase">#${x.device_no}</span> ${x.bed_no?`<span class="bg-blue-600 text-white text-[10px] px-2 py-1 rounded font-bold italic">BED ${x.bed_no}</span>`:''}</div><div class="min-h-[80px]">${x.hm_number ? `<p class="text-blue-900 font-bold">${x.name}</p><p class="text-[10px] text-blue-500 font-bold">HN: ${x.hm_number}</p>` : `<p class="text-slate-300 italic">Available</p>`}</div><div class="mt-4">${x.hm_number ? `<button onclick="unpair('${x.mac}')" class="admin-only w-full p-2 text-red-500 border border-red-100 rounded-lg text-[10px] font-bold">Unpair</button>` : `<button onclick="openPair('${x.mac}', '${x.device_no}')" class="admin-only w-full p-2 bg-blue-600 text-white rounded-lg text-[10px] font-bold">Pair Device</button>`}</div></div>`).join('');
    res.send(ui('match', `<h2 class="text-xl font-bold mb-8">Pairing</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-6">${cards}</div>`, `
        window.openPair = async (mac, dno) => {
            currentMac = mac; const res = await fetch('/api/patients-available'); const pats = await res.json();
            const opts = pats.map(p => '<option value="'+p.hn_number+'|'+p.name+'">'+p.name+' ('+p.hn_number+')</option>').join('');
            openModal('🔗 จับคู่ #'+dno, '<input id="bed" placeholder="Bed (e.g. B01)" class="w-full border p-3 rounded-xl bg-slate-50 mb-3"><select id="selP" class="w-full border p-3 rounded-xl bg-slate-50">'+opts+'</select>', async () => {
                const bed = document.getElementById('bed').value; 
                const [hn, name] = document.getElementById('selP').value.split('|');
                await fetch('/api/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac:currentMac, hn, name, bed, nurse: localStorage.getItem('nurse_name'), role: localStorage.getItem('user_role')}) });
                location.reload();
            });
        }
        window.unpair = async (mac) => { if(confirm('ยกเลิก?')) { await fetch('/api/unpair', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac, nurse: localStorage.getItem('nurse_name'), role: localStorage.getItem('user_role')})}); location.reload(); } }
    `));
});

app.get('/users-mgmt', async (req, res) => {
    const r = await pool.query('SELECT * FROM users ORDER BY id');
    const rows = r.rows.map(u => `<tr><td class="font-bold text-slate-700">${u.username}</td><td>${u.full_name}</td><td>${u.role}</td><td class="text-right"><button onclick="editU('${u.id}', '${u.full_name}', '${u.role}')" class="text-blue-500 font-bold mr-3 text-xs">แก้ไข</button><button onclick="delU('${u.id}')" class="text-red-400 font-bold text-xs">ลบ</button></td></tr>`).join('');
    res.send(ui('users', `<div class="grid md:grid-cols-3 gap-8"><div class="admin-only card p-6 h-fit"><h3 class="font-bold mb-6">🛡️ เพิ่ม User</h3><div class="space-y-3"><input id="u_un" placeholder="User" class="w-full border p-3 rounded-xl bg-slate-50"><input id="u_fn" placeholder="ชื่อ" class="w-full border p-3 rounded-xl bg-slate-50"><input id="u_pw" type="password" placeholder="Pass" class="w-full border p-3 rounded-xl bg-slate-50"><select id="u_ur" class="w-full border p-3 rounded-xl bg-slate-50"><option value="viewer">Viewer</option><option value="admin">Admin</option></select><button onclick="addU()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button></div></div><div class="md:col-span-2 card overflow-hidden"><table><thead><tr><th>User</th><th>Name</th><th>Role</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`, `
        window.addU = async () => { await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({un:document.getElementById('u_un').value,fn:document.getElementById('u_fn').value,pw:document.getElementById('u_pw').value,urole:document.getElementById('u_ur').value, role: localStorage.getItem('user_role')}) }); location.reload(); }
        window.editU = (id, curFn, curRole) => { openModal('✏️ แก้ไข', '<input id="efn" value="'+curFn+'" class="w-full border p-3 rounded-xl bg-slate-50 mb-3"><select id="eur" class="w-full border p-3 rounded-xl bg-slate-50"><option value="viewer" '+(curRole==='viewer'?'selected':'')+'>Viewer</option><option value="admin" '+(curRole==='admin'?'selected':'')+'>Admin</option></select><input id="epw" type="password" placeholder="New Pass" class="w-full border p-3 rounded-xl bg-slate-50">', async () => { await fetch('/api/users/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,fn:document.getElementById('efn').value,urole:document.getElementById('eur').value,pw:document.getElementById('epw').value, role: localStorage.getItem('user_role')}) }); location.reload(); }); }
        window.delU = async (id) => { if(confirm('ลบ?')) { await fetch('/api/users/'+id+'?role='+localStorage.getItem('user_role'), {method:'DELETE'}); location.reload(); } }
    `));
});

// --- API ACTIONS ---
app.post('/api/devices', adminOnly, async(req,res)=>{ await pool.query('INSERT INTO nurseaid (device_no, mac) VALUES ($1,$2)',[req.body.dno, req.body.mac]); res.sendStatus(200); });
app.post('/api/devices/update', adminOnly, async(req,res)=>{ await pool.query('UPDATE nurseaid SET device_no=$1 WHERE mac=$2',[req.body.newDno, req.body.mac]); res.sendStatus(200); });
app.delete('/api/devices/:mac', adminOnly, async(req,res)=>{ await pool.query('DELETE FROM nurseaid WHERE mac=$1',[req.params.mac]); res.sendStatus(200); });
app.post('/api/patients', adminOnly, async(req,res)=>{ await pool.query('INSERT INTO patients (hn_number, name) VALUES ($1,$2)',[req.body.hn, req.body.nm]); res.sendStatus(200); });
app.post('/api/patients/update', adminOnly, async(req,res)=>{ await pool.query('UPDATE patients SET name=$1 WHERE hn_number=$2',[req.body.newName, req.body.hn]); res.sendStatus(200); });
app.delete('/api/patients/:id', adminOnly, async(req,res)=>{ await pool.query('DELETE FROM patients WHERE hn_number=$1',[req.params.id]); res.sendStatus(200); });
app.post('/api/users', adminOnly, async(req,res)=>{ await pool.query('INSERT INTO users (username, full_name, password, role) VALUES ($1,$2,$3,$4)',[req.body.un, req.body.fn, req.body.pw, req.body.urole]); res.sendStatus(200); });
app.post('/api/users/update', adminOnly, async(req,res)=>{ const { id, fn, urole, pw } = req.body; if(pw) await pool.query('UPDATE users SET full_name=$1, role=$2, password=$3 WHERE id=$4',[fn, urole, pw, id]); else await pool.query('UPDATE users SET full_name=$1, role=$2 WHERE id=$3',[fn, urole, id]); res.sendStatus(200); });
app.delete('/api/users/:id', adminOnly, async(req,res)=>{ await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]); res.sendStatus(200); });
app.post('/api/pair', adminOnly, async (req, res) => {
    const { hn, name, nurse, bed, mac } = req.body;
    try {
        // 1. อัปเดตสถานะปัจจุบันในตารางหลัก
        await pool.query(
            'UPDATE nurseaid SET hm_number=$1, name=$2, update_by=$3, lastupdate=NOW(), bed_no=$4 WHERE mac=$5',
            [hn, name, nurse, bed, mac]
        );
        
        // 2. บันทึกลงตารางประวัติ (Device Occupancy Log)
        await pool.query(
            'INSERT INTO device_history (mac, hm_number, patient_name, bed_no, assign_time, status) VALUES ($1, $2, $3, $4, NOW(), $5)',
            [mac, hn, name, bed, 'active']
        );
        
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});
app.post('/api/unpair', adminOnly, async (req, res) => {
    const { mac, nurse } = req.body;
    try {
        // 1. อัปเดตตารางประวัติ: ปิดสถานะการใช้งาน (Discharge)
        await pool.query(
            "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
            [mac]
        );

        // 2. ล้างข้อมูลในตารางหลัก
        await pool.query(
            'UPDATE nurseaid SET hm_number=NULL, name=NULL, update_by=$1, lastupdate=NOW(), bed_no=NULL WHERE mac=$2',
            [nurse, mac]
        );
        
        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});
app.get('/api/patients-available', async(req,res)=> { 
    const r = await pool.query(
        'SELECT * FROM patients WHERE hn_number NOT IN (SELECT hm_number FROM nurseaid WHERE hm_number IS NOT NULL)'
    ); 
    res.json(r.rows); 
});
app.get('/login', (req, res) => res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><script src="https://cdn.tailwindcss.com"></script><link href="https://fonts.googleapis.com/css2?family=Prompt&display=swap" rel="stylesheet"></head><body class="flex items-center justify-center min-h-screen bg-slate-900 font-['Prompt']"><div class="bg-white p-10 rounded-[2.5rem] w-full max-w-sm"><h1 class="text-3xl font-black text-blue-600 italic text-center mb-10">Nurse Aid</h1><div class="space-y-4"><input id="u" placeholder="User" class="w-full p-4 rounded-2xl bg-slate-100 outline-none"><input id="p" type="password" placeholder="Pass" class="w-full p-4 rounded-2xl bg-slate-100 outline-none"><button onclick="login()" class="w-full bg-blue-600 text-white p-4 rounded-2xl font-bold">SIGN IN</button></div></div><script>async function login(){ const u = document.getElementById('u').value, p = document.getElementById('p').value; const r = await fetch('/api/login',{ method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ u, p }) }); const d = await r.json(); if(d.success){ localStorage.setItem('nurse_name', d.name); localStorage.setItem('user_role', d.role); location.href='/'; } else alert('ชื่อผู้ใช้หรือรหัสผ่านผิด กรุณาติดต่อน้องโจ้'); }</script></body></html>`));

async function syncData() {
    try {
        // ดึงรายชื่อคนไข้ที่ครองเครื่องอยู่ตอนนี้
        const active = await pool.query('SELECT mac, hm_number, name FROM nurseaid WHERE hm_number IS NOT NULL');
        
        for (let p of active.rows) {
            const flux = `from(bucket:"${influxConfig.bucket}")
                |> range(start: -2m)
                |> filter(fn:(r) => r["mac"] == "${p.mac}")
                |> pivot(rowKey:["_time"], columnKey: ["_measurement"], valueColumn: "_value")`;

            queryApi.queryRows(flux, {
                next: async (row, tableMeta) => {
    const d = tableMeta.toObject(row);
    // ใช้เวลาจาก Influx ตรงๆ ไม่ต้องบวกเพิ่มที่นี่
    const recordTime = new Date(d._time); 

    try {
        await pool.query(`
            INSERT INTO vital_signs_logs (hm_number, patient_name, mac, heart_rate, spo2, temperature, recorded_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (mac, recorded_at) 
            DO UPDATE SET 
                heart_rate = COALESCE(EXCLUDED.heart_rate, vital_signs_logs.heart_rate),
                spo2 = COALESCE(EXCLUDED.spo2, vital_signs_logs.spo2),
                temperature = COALESCE(EXCLUDED.temperature, vital_signs_logs.temperature)
        `, [p.hm_number, p.name, p.mac, d.ble_heart, d.ble_spo2, d.ble_temp, recordTime]);
    } catch (err) {}
},
                error: (e) => {},
                complete: () => {}
            });
        }
    } catch (e) {
        console.error("Sync Error:", e);
    }
}
setInterval(syncData, 15000); // ทำงานทุก 15 วินาที


app.listen(PORT, '0.0.0.0', () => console.log('✅ SERVER RUNNING ON PORT '+PORT));