content = r"""// ─── Wards Management Routes ─────────────────────────────────────────
app.get('/wards-mgmt', requireCapability('wards:manage'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT w.*, 
                   COUNT(DISTINCT uw.user_id) as assigned_users,
                   COUNT(DISTINCT p.mac) as active_devices
            FROM wards w
            LEFT JOIN user_wards uw ON w.id = uw.ward_id
            LEFT JOIN nurseaid p ON w.id = p.ward_id AND p.mac IS NOT NULL AND p.mac != ''
            GROUP BY w.id
            ORDER BY w.ward_code
        `);
        
        const wards = result.rows;
        
        res.send(ui('wards', `
            <div class="mb-6 flex justify-between items-center">
                <div>
                    <h2 class="text-2xl font-bold mb-2" style="color: var(--text-heading);">Wards Management</h2>
                    <p class="text-sm" style="color: var(--text-secondary);">Manage hospital wards and monitor their active status.</p>
                </div>
                <button onclick="openWardModal()" class="px-4 py-2 rounded-lg font-bold text-white shadow-lg transition-transform hover:scale-105" style="background: var(--accent-primary);">
                    + Add New Ward
                </button>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                ${wards.map(w => `
                    <div class="card p-6 border-t-4 \${w.is_active ? 'border-green-500' : 'border-slate-300'}">
                        <div class="flex justify-between items-start mb-4">
                            <div>
                                <h3 class="text-xl font-bold" style="color: var(--text-primary);">\${escapeHtml(w.ward_name)}</h3>
                                <div class="text-sm font-mono mt-1" style="color: var(--text-tertiary);">\${escapeHtml(w.ward_code)}</div>
                            </div>
                            <span class="px-2 py-1 rounded-full text-[10px] font-bold \${w.is_active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}">
                                \${w.is_active ? 'ACTIVE' : 'INACTIVE'}
                            </span>
                        </div>
                        <div class="space-y-2 text-sm mb-6" style="color: var(--text-secondary);">
                            <div class="flex justify-between"><span>Assigned Staff:</span> <span class="font-bold">\${w.assigned_users}</span></div>
                            <div class="flex justify-between"><span>Active Devices:</span> <span class="font-bold">\${w.active_devices}</span></div>
                            <div class="text-xs italic mt-2" style="color: var(--text-tertiary);">\${escapeHtml(w.description || 'No description')}</div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="openWardModal(\${w.id})" class="flex-1 px-3 py-2 rounded border font-bold text-xs" style="border-color: var(--border-color); color: var(--text-primary);">Edit</button>
                            \${w.is_active ? 
                                \`<button onclick="deactivateWard(\${w.id}, '\${escapeJsSingle(w.ward_code)}')" class="px-3 py-2 rounded font-bold text-xs bg-red-50 text-red-600 hover:bg-red-100 transition-colors">Deactivate</button>\` : 
                                \`<button onclick="activateWard(\${w.id})" class="px-3 py-2 rounded font-bold text-xs bg-green-50 text-green-600 hover:bg-green-100 transition-colors">Activate</button>\`
                            }
                        </div>
                    </div>
                `).join('')}
            </div>
        `, `
            window.openWardModal = (wardId = null) => {
                const title = wardId ? 'Edit Ward' : 'Add New Ward';
                const btnText = wardId ? 'Update' : 'Create';
                
                document.getElementById('modalTitle').innerText = title;
                document.getElementById('modalBody').innerHTML = \`
                    <input type="hidden" id="ward-id" value="\${wardId || ''}">
                    <div class="space-y-4">
                        <div>
                            <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">Ward Code *</label>
                            <input id="ward-code" type="text" maxlength="20" placeholder="e.g., ICU" required 
                                   style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">Ward Name *</label>
                            <input id="ward-name" type="text" maxlength="100" placeholder="e.g., Intensive Care Unit" required
                                   style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);">
                        </div>
                        <div>
                            <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">Description</label>
                            <textarea id="ward-desc" rows="3" placeholder="Optional description"
                                      style="background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);"></textarea>
                        </div>
                    </div>
                \`;
                
                const submitBtn = document.getElementById('modalSubmit');
                submitBtn.innerText = btnText;
                submitBtn.onclick = saveWard;
                
                if (wardId) {
                    fetch(\`/api/wards/\${wardId}\`)
                        .then(r => r.json())
                        .then(ward => {
                            document.getElementById('ward-code').value = ward.ward_code || '';
                            document.getElementById('ward-name').value = ward.ward_name || '';
                            document.getElementById('ward-desc').value = ward.description || '';
                        });
                }
                
                document.getElementById('globalModal').style.display = 'flex';
            };
            
            async function saveWard() {
                const id = document.getElementById('ward-id').value;
                const code = document.getElementById('ward-code').value.trim();
                const name = document.getElementById('ward-name').value.trim();
                const desc = document.getElementById('ward-desc').value.trim();
                
                if (!code || !name) return alert('Code and Name are required');
                
                try {
                    const method = id ? 'PUT' : 'POST';
                    const url = id ? \`/api/wards/\${id}\` : '/api/wards';
                    
                    const response = await fetch(url, {
                        method,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ward_code: code, ward_name: name, description: desc })
                    });
                    
                    if (!response.ok) {
                        const err = await response.json();
                        throw new Error(err.error || 'Failed to save ward');
                    }
                    
                    closeModal();
                    location.reload();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            }
            
            async function deactivateWard(id, code) {
                if (!confirm(\`Deactivate ward "\${code}"? This will not delete data.\`)) return;
                
                try {
                    const response = await fetch(\`/api/wards/\${id}\`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    
                    if (!response.ok) throw new Error('Failed to deactivate');
                    location.reload();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            }
        `, req.user));
    } catch (error) {
        console.error('[Wards Management]', error.message);
        res.status(500).send(ui('wards', '<p class="text-red-600">Failed to load wards.</p>', req.user));
    }
});

// ─── User-Ward Assignments ───────────────────────────────────────────
app.get('/user-wards-mgmt', requireCapability('users:manage'), async (req, res) => {
    try {
        const [wardsResult, usersResult, assignmentsResult] = await Promise.all([
            pool.query('SELECT id, ward_code, ward_name FROM wards WHERE is_active = true ORDER BY ward_code'),
            pool.query('SELECT id, username, full_name, role FROM users ORDER BY username'),
            pool.query(`
                SELECT uw.id, uw.user_id, uw.ward_id, uw.role_in_ward, u.username, w.ward_code
                FROM user_wards uw
                JOIN users u ON u.id = uw.user_id
                JOIN wards w ON w.id = uw.ward_id
                WHERE w.is_active = true
                ORDER BY u.username, w.ward_code
            `)
        ]);
        
        const wards = wardsResult.rows;
        const users = usersResult.rows;
        
        res.send(ui('user-wards', `
            <div class="mb-6">
                <h2 class="text-2xl font-bold mb-2" style="color: var(--text-heading);">User-Ward Assignments</h2>
                <p class="text-sm" style="color: var(--text-secondary);">Assign users to specific wards.</p>
            </div>
            <div class="card p-6 mb-6">
                <form id="assign-form" class="flex flex-wrap gap-4 items-end">
                    <div class="flex-1 min-w-[180px]">
                        <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">User</label>
                        <select id="assign-user" required style="width: 100%; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);">
                            <option value="">Select user...</option>
                            \${users.map(u => \`<option value="\${u.id}">\${escapeHtml(u.username)} (\${escapeHtml(u.role)})</option>\`).join('')}
                        </select>
                    </div>
                    <div class="flex-1 min-w-[180px]">
                        <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">Ward</label>
                        <select id="assign-ward" required style="width: 100%; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);">
                            <option value="">Select ward...</option>
                            \${wards.map(w => \`<option value="\${w.id}">\${escapeHtml(w.ward_code)} - \${escapeHtml(w.ward_name)}</option>\`).join('')}
                        </select>
                    </div>
                    <div class="flex-1 min-w-[180px]">
                        <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">Role in Ward</label>
                        <select id="assign-role" style="width: 100%; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);">
                            <option value="viewer">Viewer</option>
                            <option value="staff_nurse" selected>Staff Nurse</option>
                            <option value="ward_admin">Ward Admin</option>
                        </select>
                    </div>
                    <button type="submit" class="px-4 py-2 rounded-lg font-bold text-white" style="background: var(--accent-primary); color: var(--text-inverse);">Assign</button>
                </form>
            </div>
            <div class="card p-6 overflow-x-auto">
                <table>
                    <thead>
                        <tr>
                            <th>User</th>
                            <th>Ward</th>
                            <th>Role</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${assignmentsResult.rows.map(a => \`
                            <tr>
                                <td>\${escapeHtml(a.username)}</td>
                                <td>\${escapeHtml(a.ward_code)}</td>
                                <td><span class="px-2 py-1 rounded text-xs font-bold" style="background: var(--bg-badge); color: var(--text-badge);">\${escapeHtml(a.role_in_ward)}</span></td>
                                <td><button onclick="removeAssignment(\${a.id})" class="text-red-600 hover:text-red-800">Remove</button></td>
                            </tr>
                        \`).join('')}
                    </tbody>
                </table>
            </div>
        `, `
            document.getElementById('assign-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                const userId = parseInt(document.getElementById('assign-user').value);
                const wardId = parseInt(document.getElementById('assign-ward').value);
                const roleInWard = document.getElementById('assign-role').value;
                
                if (!userId || !wardId) { alert('Please select user and ward'); return; }
                
                try {
                    const response = await fetch('/api/user-wards', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ user_id: userId, ward_id: wardId, role_in_ward: roleInWard })
                    });
                    
                    if (!response.ok) {
                        const err = await response.json();
                        throw new Error(err.error || 'Failed to assign');
                    }
                    
                    location.reload();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            });
            
            async function removeAssignment(id) {
                if (!confirm('Remove this assignment?')) return;
                try {
                    await fetch(\`/api/user-wards/\${id}\`, { method: 'DELETE' });
                    location.reload();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            }
        `
        ));
    } catch (error) {
        console.error('[User-Wards Management]', error.message);
        res.status(500).send(ui('user-wards', '<p class="text-red-600">Failed to load assignments.</p>'));
    }
});

// ─── Audit Log Viewer ────────────────────────────────────────────────
app.get('/audit-log', requireCapability('audit:read'), async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = 50;
        const offset = (page - 1) * limit;
        
        const whereClauses = [];
        const params = [];
        let paramIndex = 1;
        
        if (req.query.user_id) {
            whereClauses.push(`u.id = $${paramIndex++}`);
            params.push(req.query.user_id);
        }
        if (req.query.action) {
            whereClauses.push(`al.action = $${paramIndex++}`);
            params.push(req.query.action);
        }
        if (req.query.ward_id) {
            whereClauses.push(`al.ward_id = $${paramIndex++}`);
            params.push(req.query.ward_id);
        }
        
        const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        
        const [logsResult, wardsResult, countResult] = await Promise.all([
            pool.query(`
                SELECT al.*, u.username, u.full_name
                FROM audit_logs_enhanced al
                LEFT JOIN users u ON u.id = al.user_id
                ${whereSql}
                ORDER BY al.created_at DESC
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `, [...params, limit, offset]),
            pool.query('SELECT id, ward_code FROM wards ORDER BY ward_code'),
            pool.query(`
                SELECT COUNT(*) 
                FROM audit_logs_enhanced al 
                LEFT JOIN users u ON u.id = al.user_id 
                ${whereSql}
            `, params)
        ]);
        
        const logs = logsResult.rows;
        const totalLogs = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalLogs / limit);
        
        res.send(ui('audit-log', `
            <div class="mb-6 flex justify-between items-end">
                <div>
                    <h2 class="text-2xl font-bold mb-2" style="color: var(--text-heading);">Audit Log</h2>
                    <p class="text-sm" style="color: var(--text-secondary);">Track system activities and changes.</p>
                </div>
            </div>
            
            <div class="card p-6 mb-6">
                <form id="audit-filter-form" class="flex flex-wrap gap-4 items-end" method="GET" action="/audit-log">
                    <div class="flex-1 min-w-[150px]">
                        <label class="block text-xs font-bold mb-1" style="color: var(--text-secondary);">Action</label>
                        <select name="action" class="w-full border p-2 rounded text-xs bg-slate-50">
                            <option value="">All Actions</option>
                            <option value="LOGIN" \${req.query.action === 'LOGIN' ? 'selected' : ''}>LOGIN</option>
                            <option value="LOGOUT" \${req.query.action === 'LOGOUT' ? 'selected' : ''}>LOGOUT</option>
                            <option value="CREATE" \${req.query.action === 'CREATE' ? 'selected' : ''}>CREATE</option>
                            <option value="UPDATE" \${req.query.action === 'UPDATE' ? 'selected' : ''}>UPDATE</option>
                            <option value="DELETE" \${req.query.action === 'DELETE' ? 'selected' : ''}>DELETE</option>
                        </select>
                    </div>
                    <div class="flex-1 min-w-[150px]">
                        <label class="block text-xs font-bold mb-1" style="color: var(--text-secondary);">Ward</label>
                        <select name="ward_id" class="w-full border p-2 rounded text-xs bg-slate-50">
                            <option value="">All Wards</option>
                            \${wardsResult.rows.map(w => \`<option value="\${w.id}" \${req.query.ward_id == w.id ? 'selected' : ''}>\${escapeHtml(w.ward_code)}</option>\`).join('')}
                        </select>
                    </div>
                    <button type="submit" class="px-4 py-2 rounded font-bold text-white text-xs" style="background: var(--accent-primary);">Filter</button>
                    <a href="/audit-log" class="px-4 py-2 rounded border text-xs font-bold" style="border-color: var(--border-color); color: var(--text-secondary);">Reset</a>
                </form>
            </div>
            
            <div class="card overflow-x-auto">
                <table class="text-xs">
                    <thead>
                        <tr>
                            <th>Time</th>
                            <th>User</th>
                            <th>Role</th>
                            <th>Action</th>
                            <th>Target</th>
                            <th>Details</th>
                            <th>IP</th>
                        </tr>
                    </thead>
                    <tbody>
                        \${logs.map(l => \`
                            <tr class="border-b border-slate-50 hover:bg-slate-50">
                                <td class="text-slate-500 whitespace-nowrap">\${new Date(l.created_at).toLocaleString('th-TH')}</td>
                                <td class="font-bold">\${escapeHtml(l.username || 'System')}</td>
                                <td><span class="px-2 py-1 rounded-full text-[9px] bg-slate-100">\${escapeHtml(l.actor_role || '-')}</span></td>
                                <td class="font-bold \${
                                    l.action === 'LOGIN' ? 'text-green-600' : 
                                    l.action === 'DELETE' ? 'text-red-500' : 
                                    l.action === 'CREATE' ? 'text-blue-500' : 'text-slate-600'
                                }">\${escapeHtml(l.action)}</td>
                                <td>
                                    <span class="uppercase font-mono text-[9px] text-slate-400">\${escapeHtml(l.entity_type)}</span>
                                    \${l.entity_id ? \` <span class="font-bold">#\${escapeHtml(l.entity_id)}</span>\` : ''}
                                </td>
                                <td class="max-w-[200px] truncate" title='\${escapeHtml(JSON.stringify(l.details))}'>
                                    <code class="text-[9px] text-slate-500 bg-slate-50 px-1 py-0.5 rounded">\${escapeHtml(JSON.stringify(l.details))}</code>
                                </td>
                                <td class="text-slate-400 font-mono text-[10px]">\${escapeHtml(l.ip_address || '-')}</td>
                            </tr>
                        \`).join('')}
                        \${logs.length === 0 ? '<tr><td colspan="7" class="text-center py-8 text-slate-400">No logs found</td></tr>' : ''}
                    </tbody>
                </table>
            </div>
            
            \${totalPages > 1 ? \`
                <div class="mt-4 flex justify-between items-center text-xs">
                    <span class="text-slate-500">Showing \${offset + 1} - \${Math.min(offset + limit, totalLogs)} of \${totalLogs} logs</span>
                    <div class="flex gap-2">
                        \${page > 1 ? \`<a href="?page=\${page-1}&\${new URLSearchParams(req.query).toString()}" class="px-3 py-1 border rounded hover:bg-slate-50">Previous</a>\` : ''}
                        <span class="px-3 py-1 bg-slate-100 rounded font-bold">\${page} / \${totalPages}</span>
                        \${page < totalPages ? \`<a href="?page=\${page+1}&\${new URLSearchParams(req.query).toString()}" class="px-3 py-1 border rounded hover:bg-slate-50">Next</a>\` : ''}
                    </div>
                </div>
            \` : ''}
        `, `
            document.addEventListener('DOMContentLoaded', () => {
                const form = document.getElementById('audit-filter-form');
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    const params = new URLSearchParams();
                    const formData = new FormData(form);
                    formData.forEach((value, key) => { if (value) params.append(key, value); });
                    window.location.href = '/audit-log?' + params.toString();
                });
            });
        `));
    } catch (error) {
        console.error('[Audit Log]', error.message);
        res.status(500).send(ui('audit-log', '<p class="text-red-600">Failed to load audit log.</p>'));
    }
});
"""
with open('temp_routes.js', 'w') as f:
    f.write(content)
print("Generated temp_routes.js")
