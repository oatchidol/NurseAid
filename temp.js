
// ─── Wards Management Routes ─────────────────────────────────────────
app.get('/wards-mgmt', requireCapability('wards:manage'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT w.*, 
                   COUNT(DISTINCT uw.user_id) AS assigned_users,
                   COUNT(DISTINCT n.id) AS active_devices
            FROM wards w
            LEFT JOIN user_wards uw ON uw.ward_id = w.id
            LEFT JOIN nurseaid n ON n.ward_id = w.id AND n.mac IS NOT NULL
            WHERE w.is_active = true
            GROUP BY w.id
            ORDER BY w.ward_code
        `);
        
        const wardsHtml = result.rows.map(w => `
            <tr>
                <td><strong>${escapeHtml(w.ward_code)}</strong></td>
                <td>${escapeHtml(w.ward_name)}</td>
                <td>${escapeHtml(w.description || '-')}</td>
                <td>${w.assigned_users || 0}</td>
                <td>${w.active_devices || 0}</td>
                <td>
                    <button onclick="editWard(${w.id})" class="text-blue-600 hover:text-blue-800 mr-2">✏️ Edit</button>
                    <button onclick="deactivateWard(${w.id}, '${escapeJsSingle(w.ward_code)}')" class="text-red-600 hover:text-red-800">🗑️ Deactivate</button>
                </td>
            </tr>
        `).join('');
        
        res.send(ui('wards', `
            <div class="mb-6">
                <h2 class="text-2xl font-bold mb-2" style="color: var(--text-heading);">Ward Management</h2>
                <p class="text-sm" style="color: var(--text-secondary);">Manage hospital wards and their assignments.</p>
            </div>
            <div class="card p-6 mb-6">
                <button onclick="openWardModal()" class="bg-accent-primary text-white px-4 py-2 rounded-lg font-bold hover:opacity-90" style="background: var(--accent-primary); color: var(--text-inverse);">
                    + Add New Ward
                </button>
            </div>
            <div class="card p-6 overflow-x-auto">
                <table>
                    <thead>
                        <tr>
                            <th>Code</th>
                            <th>Name</th>
                            <th>Description</th>
                            <th>Users</th>
                            <th>Devices</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>${wardsHtml || '<tr><td colspan="6" class="text-center" style="color: var(--text-tertiary);">No wards found</td></tr>'}</tbody>
                </table>
            </div>
        `, `
            let currentWardId = null;
            
            function openWardModal(wardId = null) {
                currentWardId = wardId;
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
                `;
                
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
                        })
                        .catch(() => closeModal());
                }
                
                openModal();
            }
            
            function editWard(id) { openWardModal(id); }
            
            async function saveWard() {
                const code = document.getElementById('ward-code').value.trim();
                const name = document.getElementById('ward-name').value.trim();
                const desc = document.getElementById('ward-desc').value.trim();
                
                if (!code || !name) {
                    alert('Ward code and name are required');
                    return;
                }
                
                try {
                    const method = currentWardId ? 'PUT' : 'POST';
                    const url = currentWardId ? \`/api/wards/\${currentWardId}\` : '/api/wards';
                    
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
