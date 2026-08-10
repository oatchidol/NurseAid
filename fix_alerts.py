import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Update /api/alert-settings POST
old_alert = """app.post('/api/alert-settings', requireCapability('alerts:settings:write'), async (req, res) => {
    const { mac, hn, hr_min, hr_max, temp_min, temp_max, spo2_min } = req.body;
    // v2.1 settings
    const {
        hr_warning_min, hr_warning_max,
        temp_warning_min, temp_warning_max,
        spo2_warning_min, spo2_critical_min,
        enable_offline_alert, offline_threshold_minutes,
        alert_critical, alert_warning,
        sound_enabled, silent_start, silent_end
    } = req.body;
    
    if (!mac) return res.status(400).json({ error: 'Missing mac address' });
    try {
        await pool.query(
            `INSERT INTO alert_settings (
                mac, hn_number, hr_min, hr_max, temp_min, temp_max, spo2_min,
                hr_warning_min, hr_warning_max,
                temp_warning_min, temp_warning_max,
                spo2_warning_min, spo2_critical_min,
                enable_offline_alert, offline_threshold_minutes,
                alert_critical, alert_warning,
                sound_enabled, silent_start, silent_end,
                updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20,
                NOW()
            ) ON CONFLICT (mac) DO UPDATE SET
                hn_number=EXCLUDED.hn_number,
                hr_min=EXCLUDED.hr_min, hr_max=EXCLUDED.hr_max,
                temp_min=EXCLUDED.temp_min, temp_max=EXCLUDED.temp_max,
                spo2_min=EXCLUDED.spo2_min,
                hr_warning_min=EXCLUDED.hr_warning_min, hr_warning_max=EXCLUDED.hr_warning_max,
                temp_warning_min=EXCLUDED.temp_warning_min, temp_warning_max=EXCLUDED.temp_warning_max,
                spo2_warning_min=EXCLUDED.spo2_warning_min, spo2_critical_min=EXCLUDED.spo2_critical_min,
                enable_offline_alert=EXCLUDED.enable_offline_alert, offline_threshold_minutes=EXCLUDED.offline_threshold_minutes,
                alert_critical=EXCLUDED.alert_critical, alert_warning=EXCLUDED.alert_warning,
                sound_enabled=EXCLUDED.sound_enabled, silent_start=EXCLUDED.silent_start, silent_end=EXCLUDED.silent_end,
                updated_at=NOW()`,
            [
                mac, hn || null, hr_min || 50, hr_max || 120, temp_min || 35.5, temp_max || 37.5, spo2_min || 95,
                hr_warning_min || 60, hr_warning_max || 110,
                temp_warning_min || 36.0, temp_warning_max || 37.0,
                spo2_warning_min || 95, spo2_critical_min || 91,
                enable_offline_alert !== false, offline_threshold_minutes || 2,
                alert_critical !== false, alert_warning === true,
                sound_enabled !== false, silent_start || '22:00', silent_end || '06:00'
            ]
        );
        res.json({ success: true });
    } catch (e) {"""

new_alert = """app.post('/api/alert-settings', requireCapability('alerts:settings:write'), async (req, res) => {
    const { mac, hn, hr_min, hr_max, temp_min, temp_max, spo2_min } = req.body;
    // v2.1 settings
    const {
        hr_warning_min, hr_warning_max,
        temp_warning_min, temp_warning_max,
        spo2_warning_min, spo2_critical_min,
        enable_offline_alert, offline_threshold_minutes,
        alert_critical, alert_warning,
        sound_enabled, silent_start, silent_end
    } = req.body;
    
    if (!mac) return res.status(400).json({ error: 'Missing mac address' });
    try {
        const scope = await wardScopeSql(req, 'ward_id', 1);
        const check = await pool.query(`SELECT ward_id FROM nurseaid WHERE mac=$1 ${scope.clause ? 'AND ' + scope.clause : ''}`, [mac, ...scope.params]);
        if (!check.rows.length) return res.status(403).json({ error: 'Device not found or access denied' });
        const wardId = check.rows[0].ward_id;

        await pool.query(
            `INSERT INTO alert_settings (
                mac, hn_number, hr_min, hr_max, temp_min, temp_max, spo2_min,
                hr_warning_min, hr_warning_max,
                temp_warning_min, temp_warning_max,
                spo2_warning_min, spo2_critical_min,
                enable_offline_alert, offline_threshold_minutes,
                alert_critical, alert_warning,
                sound_enabled, silent_start, silent_end,
                updated_at
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20,
                NOW()
            ) ON CONFLICT (mac) DO UPDATE SET
                hn_number=EXCLUDED.hn_number,
                hr_min=EXCLUDED.hr_min, hr_max=EXCLUDED.hr_max,
                temp_min=EXCLUDED.temp_min, temp_max=EXCLUDED.temp_max,
                spo2_min=EXCLUDED.spo2_min,
                hr_warning_min=EXCLUDED.hr_warning_min, hr_warning_max=EXCLUDED.hr_warning_max,
                temp_warning_min=EXCLUDED.temp_warning_min, temp_warning_max=EXCLUDED.temp_warning_max,
                spo2_warning_min=EXCLUDED.spo2_warning_min, spo2_critical_min=EXCLUDED.spo2_critical_min,
                enable_offline_alert=EXCLUDED.enable_offline_alert, offline_threshold_minutes=EXCLUDED.offline_threshold_minutes,
                alert_critical=EXCLUDED.alert_critical, alert_warning=EXCLUDED.alert_warning,
                sound_enabled=EXCLUDED.sound_enabled, silent_start=EXCLUDED.silent_start, silent_end=EXCLUDED.silent_end,
                updated_at=NOW()`,
            [
                mac, hn || null, hr_min || 50, hr_max || 120, temp_min || 35.5, temp_max || 37.5, spo2_min || 95,
                hr_warning_min || 60, hr_warning_max || 110,
                temp_warning_min || 36.0, temp_warning_max || 37.0,
                spo2_warning_min || 95, spo2_critical_min || 91,
                enable_offline_alert !== false, offline_threshold_minutes || 2,
                alert_critical !== false, alert_warning === true,
                sound_enabled !== false, silent_start || '22:00', silent_end || '06:00'
            ]
        );
        logAudit(req, 'UPDATE_ALERT_SETTINGS', 'device', mac, { ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (e) {"""

content = content.replace(old_alert, new_alert)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated alert-settings API")
