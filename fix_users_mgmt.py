#!/usr/bin/env python3
import re

with open('/root/nurseaid/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update /users-mgmt route middleware from adminOnly to requireCapability
content = content.replace(
    "app.get('/users-mgmt', adminOnly,",
    "app.get('/users-mgmt', requireCapability('users:manage'),"
)

# 2. Update role badge logic
old_role_badge = """        const roleBadge = u.role === 'admin'
            ? '<span class="text-[10px] px-2 py-0.5 rounded-full font-bold" style="background: var(--accent-red-light); color: var(--accent-red);">Admin</span>'
            : '<span class="text-[10px] px-2 py-0.5 rounded-full font-bold" style="background: var(--accent-green-light); color: var(--accent-green);">Operator</span>';"""

new_role_badge = """        const _RC = {super_admin:{b:'var(--accent-red-light)',c:'var(--accent-red)',l:'Super Admin'},ward_admin:{b:'var(--accent-primary-light)',c:'var(--accent-primary)',l:'Ward Admin'},staff_nurse:{b:'var(--accent-green-light)',c:'var(--accent-green)',l:'Staff Nurse'},viewer:{b:'#e2e8f0',c:'#64748b',l:'Viewer'},admin:{b:'var(--accent-red-light)',c:'var(--accent-red)',l:'Admin'},operator:{b:'var(--accent-green-light)',c:'var(--accent-green)',l:'Operator'}};
        const _r = _RC[u.role] || _RC.viewer;
        const roleBadge = `<span class="text-[10px] px-2 py-0.5 rounded-full font-bold" style="background: ${_r.b}; color: ${_r.c};">${_r.l}</span>`;"""

content = content.replace(old_role_badge, new_role_badge)

# 3. Update delete protection
content = content.replace(
    "u.role !== 'admin' ? `<button onclick=\"delUser(${u.id},'",
    "['super_admin','admin'].includes(u.role) ? '' : `<button onclick=\"delUser(${u.id},"
)

with open('/root/nurseaid/server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done with users-mgmt updates')