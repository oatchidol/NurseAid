#!/usr/bin/env python3
with open('/root/nurseaid/server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update MANAGED_USER_ROLES
content = content.replace(
    "const MANAGED_USER_ROLES = new Set(['admin', 'operator']);",
    "const VALID_USER_ROLES = new Set(['super_admin', 'ward_admin', 'staff_nurse', 'viewer', 'admin', 'operator']);"
)

# 2. Update POST /api/users role validation
content = content.replace(
    "if (username.length > 50 || fullName.length > 100 || !MANAGED_USER_ROLES.has(role)) {",
    "if (username.length > 50 || fullName.length > 100 || !VALID_USER_ROLES.has(role)) {"
)

# 3. Update PUT /api/users/:id role validation
content = content.replace(
    "if (!username) return res.status(400).json({ error: 'Username required' });\n    if (username.length > 50 || fullName.length > 100 || !MANAGED_USER_ROLES.has(role)) {",
    "if (!username) return res.status(400).json({ error: 'Username required' });\n    if (username.length > 50 || fullName.length > 100 || !VALID_USER_ROLES.has(role)) {"
)

# 4. Update last super_admin protection in PUT
content = content.replace(
    """        if (current.rows[0].role === 'admin' && role !== 'admin') {
            const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin'");
            if (adminCount.rows[0].count <= 1) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Cannot demote the last admin' });
            }
        }""",
    """        if (['super_admin', 'admin'].includes(current.rows[0].role) && !['super_admin', 'admin'].includes(role)) {
            const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role IN ('super_admin','admin')");
            if (adminCount.rows[0].count <= 1) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Cannot demote the last super admin' });
            }
        }
        // ward_admin cannot create super_admin or ward_admin users
        if (req.user.role === 'ward_admin' && ['super_admin', 'ward_admin'].includes(role)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Ward admins cannot create elevated role users' });
        }"""
)

# 5. Update last super_admin protection in DELETE
content = content.replace(
    """        if (check.rows[0].role === 'admin') {
            const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role='admin'");""",
    """        if (['super_admin', 'admin'].includes(check.rows[0].role)) {
            const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role IN ('super_admin','admin')");"""
)

# 6. Update error message in DELETE
content = content.replace(
    "return res.status(409).json({ error: 'Cannot delete the last admin' });",
    "return res.status(409).json({ error: 'Cannot delete the last super admin' });"
)

with open('/root/nurseaid/server.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done with user API endpoint updates')