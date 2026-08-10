import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

old_api_me = """app.get('/api/me', (req, res) => {
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role });
});"""

new_api_me = """app.get('/api/me', async (req, res) => {
    let wards = [];
    try {
        const result = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
        wards = result.rows.map(r => r.ward_id);
    } catch (e) {}
    const caps = Array.from(ROLE_CAPABILITIES[req.user.role] || []);
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role, wards, capabilities: caps });
});"""

content = content.replace(old_api_me, new_api_me)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated /api/me")
