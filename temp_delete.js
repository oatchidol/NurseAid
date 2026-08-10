app.get('/wards-mgmt', requireCapability('settings:global'), async (req, res) => {
    const r = await pool.query('SELECT id, name, code, is_active FROM wards ORDER BY id');
    const rows = r.rows.map(w => `
        <tr>
            <td class="font-mono text-xs">${escapeHtml(w.code || '-')}</td>
            <td>${escapeHtml(w.name)}</td>
            <td>${w.is_active ? '<span class="text-green-600 font-bold">Active</span>' : '<span class="text-slate-400">Inactive</span>'}</td>
            <td class="text-right">
                <button onclick="editWard(${w.id},'${escapeJsSingle(w.name)}','${escapeJsSingle(w.code || '')}',${w.is_active})" class="text-blue-500 font-bold text-xs mr-3">แก้ไข</button>
            </td>
        </tr>
    `).join('');
    res.send(ui('wards', `
        <h2 class="text-2xl font-black mb-6">🏥 Wards Management</h2>
        <div class="space-y-6">
            <div class="card p-6">
                <h3 class="font-bold mb-4">➕ เพิ่มวอร์ดใหม่</h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                    <div><label class="text-xs font-bold">รหัสวอร์ด (Code)</label><input id="w_code" placeholder="Code" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">ชื่อวอร์ด (Name)</label><input id="w_name" placeholder="ชื่อวอร์ด" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <button onclick="addWard()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold hover:bg-blue-700 transition-colors">💾 บันทึก</button>
                </div>
            </div>
            <div class="card overflow-hidden">
                <table class="w-full text-xs">
                    <thead><tr><th>Code</th><th>Name</th><th>Status</th><th class="text-right">Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `, `
        window.addWard = async () => {
            const code = document.getElementById('w_code').value.trim();
            const name = document.getElementById('w_name').value.trim();
            if (!name) return alert('กรุณากรอกชื่อวอร์ด');
            try {
                const r = await fetch('/api/wards', {
                    method: 'POST', headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ code, name })
                });
                if (r.ok) location.reload();
                else alert('Error: ' + (await r.json()).error);
            } catch(e) { alert(e.message); }
        };
        window.editWard = (id, name, code, isActive) => {
            const html = \\`
                <div class="space-y-4">
                    <div><label class="text-xs font-bold">Code</label><input id="ew_code" value="\${escapeHTML(code)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Name</label><input id="ew_name" value="\${escapeHTML(name)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Status</label>
                        <select id="ew_active" class="w-full border p-3 rounded-xl bg-slate-50">
                            <option value="true" \${isActive ? 'selected' : ''}>Active</option>
                            <option value="false" \${!isActive ? 'selected' : ''}>Inactive</option>
                        </select>
                    </div>
                </div>
            \`;
            openModal('✏️ แก้ไขวอร์ด', html, async () => {
                try {
                    const r = await fetch('/api/wards/' + id, {
                        method: 'PUT', headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            code: document.getElementById('ew_code').value,
                            name: document.getElementById('ew_name').value,
                            is_active: document.getElementById('ew_active').value === 'true'
                        })
                    });
                    if (r.ok) location.reload();
                    else alert('Error: ' + (await r.json()).error);
                } catch(e) { alert(e.message); }
            });
        };
    `));
});

app.post('/api/wards', requireCapability('settings:global'), async (req, res) => {
    const code = String(req.body.code || '').trim();
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
        const r = await pool.query('INSERT INTO wards (code, name) VALUES ($1, $2) RETURNING id', [code, name]);
        logAudit(req, 'CREATE', 'ward', r.rows[0].id, { code, name }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Code already exists' });
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/wards/:id', requireCapability('settings:global'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const code = String(req.body.code || '').trim();
    const name = String(req.body.name || '').trim();
    const is_active = Boolean(req.body.is_active);
    if (!name || isNaN(id)) return res.status(400).json({ error: 'Invalid data' });
    try {
        await pool.query('UPDATE wards SET code=$1, name=$2, is_active=$3, updated_at=NOW() WHERE id=$4', [code, name, is_active, id]);
        logAudit(req, 'UPDATE', 'ward', id, { code, name, is_active }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Code already exists' });
        res.status(500).json({ error: e.message });
    }
});

// ─── Audit Log Management ───────────────────────────────────────────
app.get('/audit-log', requireCapability('settings:global'), async (req, res) => {
    res.send(ui('audit', `
        <h2 class="text-2xl font-black mb-6">📜 Audit Logs</h2>
        <div class="card overflow-hidden">
            <div class="p-4 border-b flex gap-4">
                <input id="al_user" placeholder="User ID / Username" class="border p-2 rounded text-xs w-40">
                <select id="al_action" class="border p-2 rounded text-xs">
                    <option value="">All Actions</option>
                    <option value="LOGIN">LOGIN</option>
                    <option value="LOGOUT">LOGOUT</option>
                    <option value="CREATE">CREATE</option>
                    <option value="UPDATE">UPDATE</option>
                    <option value="DELETE">DELETE</option>
                </select>
                <button onclick="loadLogs()" class="bg-blue-600 text-white px-4 py-2 rounded text-xs font-bold">Search</button>
            </div>
            <table class="w-full text-xs">
                <thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead>
                <tbody id="audit_tbody">
                    <tr><td colspan="7" class="text-center py-4 text-slate-400">Loading...</td></tr>
                </tbody>
            </table>
        </div>
    `, `
        window.loadLogs = async () => {
            try {
                const uid = document.getElementById('al_user').value;
                const act = document.getElementById('al_action').value;
                const r = await fetch('/api/audit-log?' + new URLSearchParams({ user: uid, action: act }));
                const logs = await r.json();
                const tbody = document.getElementById('audit_tbody');
                if (!logs.length) {
                    tbody.innerHTML = '<tr><td colspan="7" class="text-center py-4 text-slate-400">No logs found</td></tr>';
                    return;
                }
                tbody.innerHTML = logs.map(l => \\`
                    <tr>
                        <td class="text-[10px] text-slate-400">\\${new Date(l.created_at).toLocaleString('th-TH')}</td>
                        <td class="font-bold">\\${escapeHTML(l.username || 'System')}</td>
                        <td class="text-[10px]">\\${escapeHTML(l.actor_role || '-')}</td>
                        <td class="font-bold \\${l.action==='LOGIN'?'text-green-600':l.action==='DELETE'?'text-red-500':'text-blue-500'}">\\${escapeHTML(l.action)}</td>
                        <td>\\${escapeHTML(l.entity_type)} #\\${escapeHTML(l.entity_id || '')}</td>
                        <td class="font-mono text-[10px] max-w-xs truncate" title="\\${escapeHTML(JSON.stringify(l.details))}">\\${escapeHTML(JSON.stringify(l.details))}</td>
                        <td class="text-slate-400">\\${escapeHTML(l.ip_address || '-')}</td>
                    </tr>\\`).join('');
            } catch(e) {
                alert('Error loading logs: ' + e.message);
            }
        };
        loadLogs();
    `));
});

app.get('/api/audit-log', requireCapability('settings:global'), async (req, res) => {
    try {
        let q = 'SELECT a.*, u.username FROM audit_logs a LEFT JOIN users u ON a.user_id=u.id WHERE 1=1';
        const params = [];
        if (req.query.user) {
            params.push(req.query.user);
            q += ` AND (u.username ILIKE '%' || $${params.length} || '%' OR a.user_id::text = $${params.length})`;
        }
        if (req.query.action) {
            params.push(req.query.action);
            q += ` AND a.action = $${params.length}`;
        }
        q += ' ORDER BY a.created_at DESC LIMIT 200';
        const r = await pool.query(q, params);
        res.json(r.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

