import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Update queryLiveStatuses
old_query = """async function queryLiveStatuses() {
    const [devicesResult, settingsResult] = await Promise.all([
        pool.query(`SELECT mac, device_no, name, hm_number, bed_no,
                           COALESCE(device_type, 'jstyle') AS device_type
                    FROM nurseaid WHERE hm_number IS NOT NULL ORDER BY device_no ASC`),"""
new_query = """async function queryLiveStatuses() {
    const [devicesResult, settingsResult] = await Promise.all([
        pool.query(`SELECT mac, device_no, name, hm_number, bed_no, ward_id,
                           COALESCE(device_type, 'jstyle') AS device_type
                    FROM nurseaid WHERE hm_number IS NOT NULL ORDER BY device_no ASC`),"""

content = content.replace(old_query, new_query)

# 2. Update app.get('/api/live-status')
old_get = """app.get('/api/live-status', async (req, res) => {
    try {
        const snapshot = await readLiveStatuses();
        const statuses = snapshot.stale
            ? markStatusesUnavailable(snapshot.value)
            : snapshot.value;
        if (snapshot.stale) {
            console.warn(`[Live Status] Serving safe fallback after query failure: ${snapshot.error?.message || 'unknown error'}`);
            res.setHeader('X-NurseAid-Telemetry', 'stale-fallback');
        }
        res.json(statuses.map(({ _alertSettings, ...status }) => status));
    } catch (error) {"""

new_get = """app.get('/api/live-status', async (req, res) => {
    try {
        const snapshot = await readLiveStatuses();
        let statuses = snapshot.stale
            ? markStatusesUnavailable(snapshot.value)
            : snapshot.value;
            
        // POST-FILTERING for ward scope
        if (req.user && req.user.role !== 'super_admin') {
            const userWardsRes = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
            const allowedWards = new Set(userWardsRes.rows.map(r => r.ward_id));
            if (allowedWards.size === 0) {
                statuses = []; // No wards -> see nothing
            } else {
                statuses = statuses.filter(s => allowedWards.has(s.ward_id));
            }
        }
        
        if (snapshot.stale) {
            console.warn(`[Live Status] Serving safe fallback after query failure: ${snapshot.error?.message || 'unknown error'}`);
            res.setHeader('X-NurseAid-Telemetry', 'stale-fallback');
        }
        res.json(statuses.map(({ _alertSettings, ...status }) => status));
    } catch (error) {"""

content = content.replace(old_get, new_get)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated /api/live-status with post-filtering")
