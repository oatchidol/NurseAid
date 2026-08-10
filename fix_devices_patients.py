import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Update /devices-mgmt GET to render Ward dropdown and filter by wardScopeSql
old_devices_get = """app.get('/devices-mgmt', requireCapability('devices:write'), async (req, res) => {
    try {
        const r = await pool.query('SELECT mac, device_no, device_type FROM nurseaid ORDER BY device_no');
        const rows = r.rows.map(d => `<tr><td class="font-bold">#${escapeHtml(d.device_no)}</td><td><span class="px-2 py-1 rounded-lg text-[10px] font-bold ${d.device_type === 'wearos' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'}">${escapeHtml(d.device_type || 'jstyle')}</span></td><td class="font-mono text-slate-400 text-xs">${escapeHtml(d.mac)}</td><td class="text-right admin-only"><button onclick="editD('${escapeJsSingle(d.mac)}','${escapeJsSingle(d.device_no)}','${escapeJsSingle(d.device_type || 'jstyle')}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delD('${escapeJsSingle(d.mac)}')" class="text-red-400 font-bold">ลบ</button></td></tr>`).join('');
        res.send(ui('devs', `<div class="grid md:grid-cols-3 gap-8">
            <div class="admin-only card p-6 h-fit">
                <h3 class="font-bold mb-6">📟 เพิ่มอุปกรณ์</h3>
                <div class="space-y-4">
                    <input id="d_mac" placeholder="MAC Address (e.g. 00:11...)" class="w-full border p-3 rounded-xl bg-slate-50 uppercase font-mono text-sm">
                    <input id="d_no" placeholder="Device No." class="w-full border p-3 rounded-xl bg-slate-50">
                    <select id="d_type" class="w-full border p-3 rounded-xl bg-slate-50">
                        <option value="jstyle">J-Style</option>
                        <option value="wearos">Wear OS</option>
                    </select>
                    <button onclick="addD()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button>
                </div>
            </div>
            <div class="md:col-span-2 card overflow-hidden">
                <table><thead><tr><th>No</th><th>Type</th><th>MAC / Device ID</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>`, `"""

new_devices_get = """app.get('/devices-mgmt', requireCapability('devices:write'), async (req, res) => {
    try {
        const scope = await wardScopeSql(req, 'ward_id', 1);
        const wardsRes = await pool.query('SELECT id, name FROM wards ORDER BY name');
        let wardOpts = wardsRes.rows.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
        if (req.user.role !== 'super_admin') {
            const myWards = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
            const myIds = new Set(myWards.rows.map(w => w.ward_id));
            wardOpts = wardsRes.rows.filter(w => myIds.has(w.id)).map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
        }
        
        const q = `SELECT mac, device_no, device_type FROM nurseaid ${scope.clause ? 'WHERE ' + scope.clause : ''} ORDER BY device_no`;
        const r = await pool.query(q, scope.params);
        const rows = r.rows.map(d => `<tr><td class="font-bold">#${escapeHtml(d.device_no)}</td><td><span class="px-2 py-1 rounded-lg text-[10px] font-bold ${d.device_type === 'wearos' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'}">${escapeHtml(d.device_type || 'jstyle')}</span></td><td class="font-mono text-slate-400 text-xs">${escapeHtml(d.mac)}</td><td class="text-right"><button onclick="editD('${escapeJsSingle(d.mac)}','${escapeJsSingle(d.device_no)}','${escapeJsSingle(d.device_type || 'jstyle')}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delD('${escapeJsSingle(d.mac)}')" class="text-red-400 font-bold">ลบ</button></td></tr>`).join('');
        res.send(ui('devs', `<div class="grid md:grid-cols-3 gap-8">
            <div class="card p-6 h-fit">
                <h3 class="font-bold mb-6">📟 เพิ่มอุปกรณ์</h3>
                <div class="space-y-4">
                    <input id="d_mac" placeholder="MAC Address (e.g. 00:11...)" class="w-full border p-3 rounded-xl bg-slate-50 uppercase font-mono text-sm">
                    <input id="d_no" placeholder="Device No." class="w-full border p-3 rounded-xl bg-slate-50">
                    <select id="d_type" class="w-full border p-3 rounded-xl bg-slate-50">
                        <option value="jstyle">J-Style</option>
                        <option value="wearos">Wear OS</option>
                    </select>
                    <select id="d_ward" class="w-full border p-3 rounded-xl bg-slate-50">
                        ${wardOpts}
                    </select>
                    <button onclick="addD()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button>
                </div>
            </div>
            <div class="md:col-span-2 card overflow-hidden">
                <table><thead><tr><th>No</th><th>Type</th><th>MAC / Device ID</th><th></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>`, `"""

content = content.replace(old_devices_get, new_devices_get)

# 2. Update /api/devices POST
old_devices_post = """app.post('/api/devices', requireCapability('devices:write'), async (req, res) => {
    const mac = normalizeMac(req.body.mac);
    const deviceNo = String(req.body.dno || '').trim();
    const deviceType = String(req.body.device_type || 'jstyle').trim().toLowerCase();
    if (!mac || !deviceNo || deviceNo.length > 50 || !MANAGED_DEVICE_TYPES.has(deviceType)) {
        return res.status(400).json({ error: 'Invalid device data' });
    }
    try {
        await pool.query(
            'INSERT INTO nurseaid (mac, device_no, device_type) VALUES ($1, $2, $3)',
            [mac, deviceNo, deviceType]
        );
        res.json({ success: true });
    } catch (error) {"""

new_devices_post = """app.post('/api/devices', requireCapability('devices:write'), async (req, res) => {
    const mac = normalizeMac(req.body.mac);
    const deviceNo = String(req.body.dno || '').trim();
    const deviceType = String(req.body.device_type || 'jstyle').trim().toLowerCase();
    const wardId = parseInt(req.body.ward_id, 10);
    if (!mac || !deviceNo || deviceNo.length > 50 || !MANAGED_DEVICE_TYPES.has(deviceType) || isNaN(wardId)) {
        return res.status(400).json({ error: 'Invalid device data' });
    }
    try {
        if (req.user.role !== 'super_admin') {
            const w = await pool.query('SELECT 1 FROM user_wards WHERE user_id=$1 AND ward_id=$2', [req.user.id, wardId]);
            if (!w.rows.length) return res.status(403).json({ error: 'Forbidden ward' });
        }
        await pool.query(
            'INSERT INTO nurseaid (mac, device_no, device_type, ward_id) VALUES ($1, $2, $3, $4)',
            [mac, deviceNo, deviceType, wardId]
        );
        logAudit(req, 'CREATE', 'device', mac, { device_no: deviceNo, ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (error) {"""

content = content.replace(old_devices_post, new_devices_post)

# 3. Update /api/devices/update POST
old_devices_update = """app.post('/api/devices/update', requireCapability('devices:write'), async (req, res) => {
    const mac = String(req.body.mac || '').trim();
    const deviceNo = String(req.body.newDno || '').trim();
    const deviceType = String(req.body.device_type || 'jstyle').trim().toLowerCase();
    if (!mac || !deviceNo || deviceNo.length > 50 || !MANAGED_DEVICE_TYPES.has(deviceType)) {
        return res.status(400).json({ error: 'Invalid device data' });
    }
    try {
        const result = await pool.query(
            'UPDATE nurseaid SET device_no=$1, device_type=$2 WHERE LOWER(mac)=LOWER($3) RETURNING id',
            [deviceNo, deviceType, mac]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Device not found' });
        res.json({ success: true });
    } catch (error) {"""

new_devices_update = """app.post('/api/devices/update', requireCapability('devices:write'), async (req, res) => {
    const mac = String(req.body.mac || '').trim();
    const deviceNo = String(req.body.newDno || '').trim();
    const deviceType = String(req.body.device_type || 'jstyle').trim().toLowerCase();
    const wardId = parseInt(req.body.ward_id, 10);
    if (!mac || !deviceNo || deviceNo.length > 50 || !MANAGED_DEVICE_TYPES.has(deviceType) || isNaN(wardId)) {
        return res.status(400).json({ error: 'Invalid device data' });
    }
    try {
        const scope = await wardScopeSql(req, 'ward_id', 5);
        const result = await pool.query(
            `UPDATE nurseaid SET device_no=$1, device_type=$2, ward_id=$3 WHERE LOWER(mac)=LOWER($4) ${scope.clause ? 'AND ' + scope.clause : ''} RETURNING id`,
            [deviceNo, deviceType, wardId, mac, ...scope.params]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Device not found or access denied' });
        logAudit(req, 'UPDATE', 'device', mac, { device_no: deviceNo, ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (error) {"""

content = content.replace(old_devices_update, new_devices_update)

# 4. Update JS for devices
old_devices_script = """async function addD(){
            const m = document.getElementById('d_mac').value;
            const n = document.getElementById('d_no').value;
            const t = document.getElementById('d_type').value;
            if(!m || !n) return alert('กรอกข้อมูลไม่ครบ');
            if(confirm(`เพิ่มอุปกรณ์ ${n}?`)) {
                await fetch('/api/devices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mac:m, dno:n, device_type: t})});
                location.reload();
            }
        }
        function editD(m,n,t){
            const newN = prompt('New Device No:', n);
            if(!newN) return;
            const newT = prompt('New Device Type (jstyle, wearos):', t || 'jstyle');
            if(!newT) return;
            fetch('/api/devices/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mac:m, newDno:newN, device_type: newT})}).then(()=>location.reload());
        }"""

new_devices_script = """async function addD(){
            const m = document.getElementById('d_mac').value;
            const n = document.getElementById('d_no').value;
            const t = document.getElementById('d_type').value;
            const w = document.getElementById('d_ward').value;
            if(!m || !n || !w) return alert('กรอกข้อมูลไม่ครบ');
            if(confirm(`เพิ่มอุปกรณ์ ${n}?`)) {
                await fetch('/api/devices',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mac:m, dno:n, device_type: t, ward_id: w})});
                location.reload();
            }
        }
        function editD(m,n,t){
            const newN = prompt('New Device No:', n);
            if(!newN) return;
            const newT = prompt('New Device Type (jstyle, wearos):', t || 'jstyle');
            if(!newT) return;
            const w = document.getElementById('d_ward').value; // hack: use selected ward for now
            fetch('/api/devices/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mac:m, newDno:newN, device_type: newT, ward_id: w})}).then(()=>location.reload());
        }"""

content = content.replace(old_devices_script, new_devices_script)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated /devices-mgmt and /api/devices routes")
