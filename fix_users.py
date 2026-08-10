import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Update /users-mgmt GET
old_users_get = """app.get('/users-mgmt', requireCapability('users:manage:ward'), async (req, res) => {
    const r = await pool.query('SELECT id, username, full_name, role, created_at FROM users ORDER BY created_at DESC');
    const rows = r.rows.map(u => {
        const _RC = {super_admin:{b:'var(--accent-red-light)',c:'var(--accent-red)',l:'Super Admin'},ward_admin:{b:'var(--accent-primary-light)',c:'var(--accent-primary)',l:'Ward Admin'},staff_nurse:{b:'var(--accent-green-light)',c:'var(--accent-green)',l:'Staff Nurse'},viewer:{b:'#e2e8f0',c:'#64748b',l:'Viewer'},admin:{b:'var(--accent-red-light)',c:'var(--accent-red)',l:'Admin'},operator:{b:'var(--accent-green-light)',c:'var(--accent-green)',l:'Operator'}};
        const _r = _RC[u.role] || _RC.viewer;
        const roleBadge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold" style="background: ${_r.b}; color: ${_r.c};">${_r.l}</span>`;
        return `<tr>
            <td class="font-mono text-xs">${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.full_name || '-')}</td>
            <td>${roleBadge}</td>
            <td class="text-xs text-slate-400">${new Date(u.created_at).toLocaleString('th-TH')}</td>
            <td class="text-right">
                <button onclick="editUser(${u.id},'${escapeJsSingle(u.username)}','${escapeJsSingle(u.full_name || '')}','${escapeJsSingle(u.role)}')" class="text-blue-500 font-bold text-xs mr-3">แก้ไข</button>
                <button onclick="resetUserPass(${u.id},'${escapeJsSingle(u.username)}')" class="text-amber-500 font-bold text-xs mr-3">รหัสผ่าน</button>
                ${['super_admin','admin'].includes(u.role) ? '' : `<button onclick="delUser(${u.id},${escapeJsSingle(u.username)}')" class="text-red-500 font-bold text-xs">ลบ</button>` : ''}
            </td>
        </tr>`;
    }).join('');
    res.send(ui('users', `
        <h2 class="text-2xl font-black mb-6">🛡️ User Management</h2>
        <div class="space-y-6">
            <div class="card p-6">
                <h3 class="font-bold mb-4">➕ เพิ่่มผู้ใช้ใหม</h3>
                <div class="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                    <div><label class="text-xs font-bold">Username</label><input id="u_user" placeholder="username" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Full Name</label><input id="u_name" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Password</label><input id="u_pass" type="password" placeholder="Password" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Role</label><select id="u_role" class="w-full border p-3 rounded-xl bg-slate-50"><option value="operator">Operator</option><option value="admin">Admin</option></select></div>
                </div>
                <button onclick="addUser()" class="mt-4 w-full bg-blue-600 text-white p-4 rounded-2xl font-bold hover:bg-blue-700 transition-colors">💾 บันทึก</button>
            </div>
            <div class="card overflow-hidden">
                <table class="w-full text-xs">
                    <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Created</th><th class="text-right">Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `, `
        window.addUser = async () => {
            const username = document.getElementById('u_user').value.trim();
            const full_name = document.getElementById('u_name').value.trim();
            const password = document.getElementById('u_pass').value;
            const role = document.getElementById('u_role').value;
            if (!username || !password) return alert('กรุณากรอก Username และ Password');
            if (password.length < 8) return alert('Password ต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
            try {
                const r = await fetch('/api/users', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username, full_name, password, role })
                });
                if (r.ok) { location.reload(); }
                else { const e = await r.json(); alert('เกิดข้อผิดพลาด: ' + (e.error || 'Unknown error')); }
            } catch(e) { alert('Connection error: ' + e.message); }
        };
        window.editUser = async (id, username, fullName, currentRole) => {
            const html = \`
                <div class="space-y-4">
                    <div><label class="text-xs font-bold">Username</label><input id="eu_user" value="\${escapeHTML(username)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Full Name</label><input id="eu_name" value="\${escapeHTML(fullName)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Role</label><select id="eu_role" class="w-full border p-3 rounded-xl bg-slate-50"><option value="operator" \${currentRole === 'operator' ? 'selected' : ''}>Operator</option><option value="admin" \${currentRole === 'admin' ? 'selected' : ''}>Admin</option></select></div>
                </div>
            \`;
            openModal('✏️ แก้ไขผู้ใช้', html, async () => {
                try {
                    const r = await fetch('/api/users/' + id, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            username: document.getElementById('eu_user').value.trim(),
                            full_name: document.getElementById('eu_name').value.trim(),
                            role: document.getElementById('eu_role').value
                        })
                    });
                    if (r.ok) { location.reload(); }
                    else { const e = await r.json(); alert('เกิดข้อผิดพลาด: ' + (e.error || 'Unknown error')); }
                } catch(e) { alert('Connection error: ' + e.message); }
            });
        };"""

new_users_get = """app.get('/users-mgmt', requireCapability('users:manage:ward'), async (req, res) => {
    let wards = [];
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
        wards = (await pool.query('SELECT id, name FROM wards')).rows;
    } else {
        const w = await pool.query('SELECT w.id, w.name FROM wards w JOIN user_wards uw ON w.id=uw.ward_id WHERE uw.user_id=$1', [req.user.id]);
        wards = w.rows;
    }
    const wardOpts = wards.map(w => `<option value="${w.id}">${escapeHtml(w.name)}</option>`).join('');

    const r = await pool.query(`SELECT u.id, u.username, u.full_name, u.role, u.created_at, array_agg(w.name) as user_wards 
                                FROM users u 
                                LEFT JOIN user_wards uw ON u.id = uw.user_id 
                                LEFT JOIN wards w ON uw.ward_id = w.id 
                                GROUP BY u.id ORDER BY u.created_at DESC`);
    const rows = r.rows.map(u => {
        const _RC = {super_admin:{b:'var(--accent-red-light)',c:'var(--accent-red)',l:'Super Admin'},ward_admin:{b:'var(--accent-primary-light)',c:'var(--accent-primary)',l:'Ward Admin'},staff_nurse:{b:'var(--accent-green-light)',c:'var(--accent-green)',l:'Staff Nurse'},viewer:{b:'#e2e8f0',c:'#64748b',l:'Viewer'},admin:{b:'var(--accent-red-light)',c:'var(--accent-red)',l:'Admin'},operator:{b:'var(--accent-green-light)',c:'var(--accent-green)',l:'Operator'}};
        const _r = _RC[u.role] || _RC.viewer;
        const roleBadge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold" style="background: ${_r.b}; color: ${_r.c};">${_r.l}</span>`;
        const myRank = {super_admin:4,admin:4,ward_admin:3,staff_nurse:2,operator:2,viewer:1}[req.user.role]||1;
        const targetRank = {super_admin:4,admin:4,ward_admin:3,staff_nurse:2,operator:2,viewer:1}[u.role]||1;
        const canManage = (myRank > targetRank) || (myRank === 4 && targetRank === 4 && req.user.id === u.id); // roughly
        return `<tr>
            <td class="font-mono text-xs">${escapeHtml(u.username)}</td>
            <td>${escapeHtml(u.full_name || '-')}</td>
            <td>${roleBadge}</td>
            <td class="text-[10px]">${u.user_wards && u.user_wards[0] ? escapeHtml(u.user_wards.join(', ')) : '-'}</td>
            <td class="text-xs text-slate-400">${new Date(u.created_at).toLocaleString('th-TH')}</td>
            <td class="text-right">
                ${canManage ? `<button onclick="editUser(${u.id},'${escapeJsSingle(u.username)}','${escapeJsSingle(u.full_name || '')}','${escapeJsSingle(u.role)}')" class="text-blue-500 font-bold text-xs mr-3">แก้ไข</button>` : ''}
                ${canManage ? `<button onclick="resetUserPass(${u.id},'${escapeJsSingle(u.username)}')" class="text-amber-500 font-bold text-xs mr-3">รหัสผ่าน</button>` : ''}
                ${canManage && u.id !== req.user.id ? `<button onclick="delUser(${u.id},'${escapeJsSingle(u.username)}')" class="text-red-500 font-bold text-xs">ลบ</button>` : ''}
            </td>
        </tr>`;
    }).join('');
    res.send(ui('users', `
        <h2 class="text-2xl font-black mb-6">🛡️ User Management</h2>
        <div class="space-y-6">
            <div class="card p-6">
                <h3 class="font-bold mb-4">➕ เพิ่มผู้ใช้ใหม่</h3>
                <div class="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                    <div><label class="text-xs font-bold">Username</label><input id="u_user" placeholder="username" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Full Name</label><input id="u_name" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Password</label><input id="u_pass" type="password" placeholder="Password" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Role</label><select id="u_role" class="w-full border p-3 rounded-xl bg-slate-50"><option value="viewer">Viewer</option><option value="staff_nurse" selected>Staff Nurse</option><option value="ward_admin">Ward Admin</option><option value="super_admin">Super Admin</option></select></div>
                    <div><label class="text-xs font-bold">Wards</label><select id="u_wards" multiple class="w-full border p-3 rounded-xl bg-slate-50 h-[46px]">${wardOpts}</select></div>
                </div>
                <button onclick="addUser()" class="mt-4 w-full bg-blue-600 text-white p-4 rounded-2xl font-bold hover:bg-blue-700 transition-colors">💾 บันทึก</button>
            </div>
            <div class="card overflow-hidden">
                <table class="w-full text-xs">
                    <thead><tr><th>Username</th><th>Full Name</th><th>Role</th><th>Wards</th><th>Created</th><th class="text-right">Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `, `
        window.addUser = async () => {
            const username = document.getElementById('u_user').value.trim();
            const full_name = document.getElementById('u_name').value.trim();
            const password = document.getElementById('u_pass').value;
            const role = document.getElementById('u_role').value;
            const wardSelect = document.getElementById('u_wards');
            const wards = Array.from(wardSelect.selectedOptions).map(opt => parseInt(opt.value));
            if (!username || !password) return alert('กรุณากรอก Username และ Password');
            if (password.length < 8) return alert('Password ต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
            try {
                const r = await fetch('/api/users', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username, full_name, password, role, wards })
                });
                if (r.ok) { location.reload(); }
                else { const e = await r.json(); alert('เกิดข้อผิดพลาด: ' + (e.error || 'Unknown error')); }
            } catch(e) { alert('Connection error: ' + e.message); }
        };
        window.editUser = async (id, username, fullName, currentRole) => {
            const opts = \`${wardOpts}\`;
            const html = \\\`
                <div class="space-y-4">
                    <div><label class="text-xs font-bold">Username</label><input id="eu_user" value="\\\${escapeHTML(username)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Full Name</label><input id="eu_name" value="\\\${escapeHTML(fullName)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Role</label><select id="eu_role" class="w-full border p-3 rounded-xl bg-slate-50"><option value="viewer" \\\${currentRole === 'viewer' ? 'selected' : ''}>Viewer</option><option value="staff_nurse" \\\${currentRole === 'staff_nurse' || currentRole === 'operator' ? 'selected' : ''}>Staff Nurse</option><option value="ward_admin" \\\${currentRole === 'ward_admin' ? 'selected' : ''}>Ward Admin</option><option value="super_admin" \\\${currentRole === 'super_admin' || currentRole === 'admin' ? 'selected' : ''}>Super Admin</option></select></div>
                    <div><label class="text-xs font-bold">Wards (Select multiple)</label><select id="eu_wards" multiple class="w-full border p-3 rounded-xl bg-slate-50 h-[100px]">\\\${opts}</select></div>
                </div>
            \\\`;
            openModal('✏️ แก้ไขผู้ใช้', html, async () => {
                const wardSelect = document.getElementById('eu_wards');
                const wards = Array.from(wardSelect.selectedOptions).map(opt => parseInt(opt.value));
                try {
                    const r = await fetch('/api/users/' + id, {
                        method: 'PUT',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            username: document.getElementById('eu_user').value.trim(),
                            full_name: document.getElementById('eu_name').value.trim(),
                            role: document.getElementById('eu_role').value,
                            wards: wards
                        })
                    });
                    if (r.ok) { location.reload(); }
                    else { const e = await r.json(); alert('เกิดข้อผิดพลาด: ' + (e.error || 'Unknown error')); }
                } catch(e) { alert('Connection error: ' + e.message); }
            });
        };"""

content = content.replace(old_users_get, new_users_get)

# 2. Update /api/users POST
old_users_post = """app.post('/api/users', requireCapability('users:manage:ward'), async (req, res) => {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.full_name || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'operator').trim().toLowerCase();
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (username.length > 50 || fullName.length > 100 || !VALID_USER_ROLES.has(role)) {
        return res.status(400).json({ error: 'Invalid user data' });
    }
    try {
        const hashed = await hashPassword(password);
        await pool.query(
            'INSERT INTO users (username, full_name, password, role) VALUES ($1, $2, $3, $4)',
            [username, fullName, hashed, role]
        );
        res.json({ success: true });
    } catch (e) {"""

new_users_post = """app.post('/api/users', requireCapability('users:manage:ward'), async (req, res) => {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.full_name || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'viewer').trim().toLowerCase();
    const wards = Array.isArray(req.body.wards) ? req.body.wards : [];
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (username.length > 50 || fullName.length > 100 || !VALID_USER_ROLES.has(role)) {
        return res.status(400).json({ error: 'Invalid user data' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hashed = await hashPassword(password);
        const r = await client.query(
            'INSERT INTO users (username, full_name, password, role) VALUES ($1, $2, $3, $4) RETURNING id',
            [username, fullName, hashed, role]
        );
        const newUserId = r.rows[0].id;
        for (const w of wards) {
            await client.query('INSERT INTO user_wards (user_id, ward_id, role_in_ward, granted_by) VALUES ($1, $2, $3, $4)', [newUserId, w, role, req.user.id]);
        }
        await client.query('COMMIT');
        logAudit(req, 'CREATE', 'user', newUserId, { username, role, wards }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');"""

content = content.replace(old_users_post, new_users_post)

# 3. Update /api/users/:id PUT
old_users_put = """        await client.query(
            `UPDATE users
             SET username=$1, full_name=$2, role=$3, session_version=session_version+1
             WHERE id=$4`,
            [username, fullName, role, id]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {"""

new_users_put = """        await client.query(
            `UPDATE users
             SET username=$1, full_name=$2, role=$3, session_version=session_version+1
             WHERE id=$4`,
            [username, fullName, role, id]
        );
        if (req.body.wards && Array.isArray(req.body.wards)) {
            await client.query('DELETE FROM user_wards WHERE user_id=$1', [id]);
            for (const w of req.body.wards) {
                await client.query('INSERT INTO user_wards (user_id, ward_id, role_in_ward, granted_by) VALUES ($1, $2, $3, $4)', [id, w, role, req.user.id]);
            }
        }
        await client.query('COMMIT');
        logAudit(req, 'UPDATE', 'user', id, { username, role, wards: req.body.wards }).catch(console.error);
        res.json({ success: true });
    } catch (e) {"""

content = content.replace(old_users_put, new_users_put)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated /users-mgmt and /api/users routes")
