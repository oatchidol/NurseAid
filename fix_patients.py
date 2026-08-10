import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Update /patients-mgmt GET
old_patients_get = """app.get('/patients-mgmt', requireCapability('patients:write'), async (req, res) => {
    try {
        const r = await pool.query('SELECT hn_number, name FROM patients ORDER BY name');
        const rows = r.rows.map(p => `<tr><td class="font-bold text-blue-600">${escapeHtml(p.hn_number)}</td><td>${escapeHtml(p.name)}</td><td class="text-right admin-only"><button onclick="editP('${escapeJsSingle(p.hn_number)}','${escapeJsSingle(p.name)}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delP('${escapeJsSingle(p.hn_number)}')" class="text-red-500 font-bold">ลบ</button></td></tr>`).join('');
        res.send(ui('pats', `<div class="grid md:grid-cols-3 gap-8">
            <div class="admin-only card p-6 h-fit">
                <h3 class="font-bold mb-6">�� เพิ่มคนไข้</h3>
                <div class="space-y-4">
                    <input id="p_hn" placeholder="HN" class="w-full border p-3 rounded-xl bg-slate-50">
                    <input id="p_nm" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50">
                    <button onclick="addP()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button>
                </div>
            </div>
            <div class="md:col-span-2 card overflow-hidden">
                <table><thead><tr><th>HN</th><th>Name</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>`, `"""

new_patients_get = """app.get('/patients-mgmt', requireCapability('patients:write'), async (req, res) => {
    try {
        const scope = await wardScopeSql(req, 'ward_id', 1);
        const wardsRes = await pool.query('SELECT id, name FROM wards ORDER BY name');
        let wardOpts = wardsRes.rows.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
        if (req.user.role !== 'super_admin') {
            const myWards = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
            const myIds = new Set(myWards.rows.map(w => w.ward_id));
            wardOpts = wardsRes.rows.filter(w => myIds.has(w.id)).map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');
        }
        
        const q = `SELECT hn_number, name FROM patients ${scope.clause ? 'WHERE ' + scope.clause : ''} ORDER BY name`;
        const r = await pool.query(q, scope.params);
        const rows = r.rows.map(p => `<tr><td class="font-bold text-blue-600">${escapeHtml(p.hn_number)}</td><td>${escapeHtml(p.name)}</td><td class="text-right"><button onclick="editP('${escapeJsSingle(p.hn_number)}','${escapeJsSingle(p.name)}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delP('${escapeJsSingle(p.hn_number)}')" class="text-red-500 font-bold">ลบ</button></td></tr>`).join('');
        res.send(ui('pats', `<div class="grid md:grid-cols-3 gap-8">
            <div class="card p-6 h-fit">
                <h3 class="font-bold mb-6">👥 เพิ่มคนไข้</h3>
                <div class="space-y-4">
                    <input id="p_hn" placeholder="HN" class="w-full border p-3 rounded-xl bg-slate-50">
                    <input id="p_nm" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50">
                    <select id="p_ward" class="w-full border p-3 rounded-xl bg-slate-50">
                        ${wardOpts}
                    </select>
                    <button onclick="addP()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button>
                </div>
            </div>
            <div class="md:col-span-2 card overflow-hidden">
                <table><thead><tr><th>HN</th><th>Name</th><th></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>`, `"""

content = content.replace(old_patients_get, new_patients_get)

# 2. Update /api/patients POST
old_patients_post = """app.post('/api/patients', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.body.hn || '').trim();
    const nm = String(req.body.nm || '').trim();
    if (!hn || !nm) return res.status(400).json({ error: 'Missing HN or name' });
    try {
        await pool.query('INSERT INTO patients (hn_number, name) VALUES ($1,$2)', [hn, nm]);
        res.json({ success: true });
    } catch (e) {"""

new_patients_post = """app.post('/api/patients', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.body.hn || '').trim();
    const nm = String(req.body.nm || '').trim();
    const wardId = parseInt(req.body.ward_id, 10);
    if (!hn || !nm || isNaN(wardId)) return res.status(400).json({ error: 'Missing data' });
    try {
        if (req.user.role !== 'super_admin') {
            const w = await pool.query('SELECT 1 FROM user_wards WHERE user_id=$1 AND ward_id=$2', [req.user.id, wardId]);
            if (!w.rows.length) return res.status(403).json({ error: 'Forbidden ward' });
        }
        await pool.query('INSERT INTO patients (hn_number, name, ward_id) VALUES ($1,$2,$3)', [hn, nm, wardId]);
        logAudit(req, 'CREATE', 'patient', hn, { name: nm, ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (e) {"""

content = content.replace(old_patients_post, new_patients_post)

# 3. Update /api/patients/update POST
old_patients_update = """app.post('/api/patients/update', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.body.hn || '').trim();
    const newName = String(req.body.newName || '').trim();
    if (!hn || !newName) return res.status(400).json({ error: 'Missing data' });
    try {
        await pool.query('UPDATE patients SET name=$1 WHERE hn_number=$2', [newName, hn]);
        res.json({ success: true });
    } catch (e) {"""

new_patients_update = """app.post('/api/patients/update', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.body.hn || '').trim();
    const newName = String(req.body.newName || '').trim();
    const wardId = parseInt(req.body.ward_id, 10);
    if (!hn || !newName || isNaN(wardId)) return res.status(400).json({ error: 'Missing data' });
    try {
        const scope = await wardScopeSql(req, 'ward_id', 4);
        const r = await pool.query(`UPDATE patients SET name=$1, ward_id=$2 WHERE hn_number=$3 ${scope.clause ? 'AND ' + scope.clause : ''} RETURNING id`, [newName, wardId, hn, ...scope.params]);
        if (!r.rows.length) return res.status(404).json({ error: 'Patient not found or access denied' });
        logAudit(req, 'UPDATE', 'patient', hn, { name: newName, ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (e) {"""

content = content.replace(old_patients_update, new_patients_update)

# 4. Update JS for patients
old_patients_script = """async function addP(){
            const h = document.getElementById('p_hn').value;
            const n = document.getElementById('p_nm').value;
            if(!h||!n) return alert('กรอกข้อมูลไม่ครบ');
            if(confirm(`เพิ่มคนไข้ HN ${h}?`)) {
                await fetch('/api/patients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hn:h, nm:n})});
                location.reload();
            }
        }
        function editP(h, n){
            const newN = prompt('New Name:', n);
            if(!newN) return;
            fetch('/api/patients/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hn:h, newName:newN})}).then(()=>location.reload());
        }"""

new_patients_script = """async function addP(){
            const h = document.getElementById('p_hn').value;
            const n = document.getElementById('p_nm').value;
            const w = document.getElementById('p_ward').value;
            if(!h||!n||!w) return alert('กรอกข้อมูลไม่ครบ');
            if(confirm(`เพิ่มคนไข้ HN ${h}?`)) {
                await fetch('/api/patients',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hn:h, nm:n, ward_id: w})});
                location.reload();
            }
        }
        function editP(h, n){
            const newN = prompt('New Name:', n);
            if(!newN) return;
            const w = document.getElementById('p_ward').value;
            fetch('/api/patients/update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hn:h, newName:newN, ward_id: w})}).then(()=>location.reload());
        }"""

content = content.replace(old_patients_script, new_patients_script)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated /patients-mgmt and /api/patients routes")
