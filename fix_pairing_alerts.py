import re

with open('/root/nurseaid/server.js', 'r') as f:
    content = f.read()

# 1. Update /api/pair
old_pair = """app.post('/api/pair', requireCapability('pairing:write'), async (req, res) => {
    const { mac, hn, name, bed } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        await pool.query(
            'UPDATE nurseaid SET hm_number=$1, name=$2, update_by=$3, lastupdate=NOW(), bed_no=$4 WHERE mac=$5',
            [hn, name, nurse, bed, mac]
        );
        await pool.query(
            'INSERT INTO device_history (mac, hm_number, patient_name, bed_no, assign_time, status) VALUES ($1, $2, $3, $4, NOW(), $5)',
            [mac, hn, name, bed, 'active']
        );
        await pool.query(
            `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
             WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false`,
            [mac]
        );
        delete deviceAlertState[normalizeMac(mac)];
        publishPairedDeviceList();
        res.sendStatus(200);
    } catch (e) {"""

new_pair = """app.post('/api/pair', requireCapability('pairing:write'), async (req, res) => {
    const { mac, hn, name, bed } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        const scope = await wardScopeSql(req, 'ward_id', 6);
        const r = await pool.query(
            `UPDATE nurseaid SET hm_number=$1, name=$2, update_by=$3, lastupdate=NOW(), bed_no=$4 WHERE mac=$5 ${scope.clause ? 'AND ' + scope.clause : ''} RETURNING ward_id`,
            [hn, name, nurse, bed, mac, ...scope.params]
        );
        if (!r.rows.length) return res.status(403).send('Forbidden or not found');
        const wardId = r.rows[0].ward_id;
        
        await pool.query(
            'INSERT INTO device_history (mac, hm_number, patient_name, bed_no, assign_time, status) VALUES ($1, $2, $3, $4, NOW(), $5)',
            [mac, hn, name, bed, 'active']
        );
        await pool.query(
            `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
             WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false`,
            [mac]
        );
        delete deviceAlertState[normalizeMac(mac)];
        logAudit(req, 'PAIR_DEVICE', 'device', mac, { hn, name, bed, ward_id: wardId }).catch(console.error);
        publishPairedDeviceList();
        res.sendStatus(200);
    } catch (e) {"""

content = content.replace(old_pair, new_pair)

# 2. Update /api/unpair
old_unpair = """app.post('/api/unpair', requireCapability('pairing:write'), async (req, res) => {
    const { mac } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        await pool.query(
            "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
            [mac]
        );
        await pool.query(
            'UPDATE nurseaid SET hm_number=NULL, name=NULL, bed_no=NULL, update_by=$1, lastupdate=NOW() WHERE mac=$2',
            [nurse, mac]
        );
        publishPairedDeviceList();
        res.sendStatus(200);
    } catch (e) {"""

new_unpair = """app.post('/api/unpair', requireCapability('pairing:write'), async (req, res) => {
    const { mac } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        const scope = await wardScopeSql(req, 'ward_id', 3);
        const r = await pool.query(
            `UPDATE nurseaid SET hm_number=NULL, name=NULL, bed_no=NULL, update_by=$1, lastupdate=NOW() WHERE mac=$2 ${scope.clause ? 'AND ' + scope.clause : ''} RETURNING ward_id, hm_number`,
            [nurse, mac, ...scope.params]
        );
        if (!r.rows.length) return res.status(403).send('Forbidden or not found');
        
        await pool.query(
            "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
            [mac]
        );
        logAudit(req, 'UNPAIR_DEVICE', 'device', mac, { ward_id: r.rows[0].ward_id, hn: r.rows[0].hm_number }).catch(console.error);
        publishPairedDeviceList();
        res.sendStatus(200);
    } catch (e) {"""

content = content.replace(old_unpair, new_unpair)

# 3. Update /api/change-device
old_change = """app.post('/api/change-device', requireCapability('pairing:write'), async (req, res) => {
    const { fromMac, toMac } = req.body;
    if (!fromMac || !toMac || fromMac === toMac) {
        return res.status(400).json({ error: 'Invalid device Macs' });
    }
    const nurse = req.user.name || req.user.username;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const fromDevice = await client.query('SELECT hm_number, name, bed_no FROM nurseaid WHERE mac=$1', [fromMac]);
        if (!fromDevice.rows.length || !fromDevice.rows[0].hm_number) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Source device is not paired' });
        }
        const toDevice = await client.query('SELECT hm_number FROM nurseaid WHERE mac=$1', [toMac]);
        if (!toDevice.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Target device not found' });
        }
        if (toDevice.rows[0].hm_number) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Target device is already paired' });
        }

        const patient = fromDevice.rows[0];

        await client.query(
            "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
            [fromMac]
        );
        await client.query(
            'UPDATE nurseaid SET hm_number=NULL, name=NULL, bed_no=NULL, update_by=$1, lastupdate=NOW() WHERE mac=$2',
            [nurse, fromMac]
        );
        
        await client.query(
            'UPDATE nurseaid SET hm_number=$1, name=$2, bed_no=$3, update_by=$4, lastupdate=NOW() WHERE mac=$5',
            [patient.hm_number, patient.name, patient.bed_no, nurse, toMac]
        );
        await client.query(
            'INSERT INTO device_history (mac, hm_number, patient_name, bed_no, assign_time, status) VALUES ($1, $2, $3, $4, NOW(), $5)',
            [toMac, patient.hm_number, patient.name, patient.bed_no, 'active']
        );
        
        await client.query(
            `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
             WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false`,
            [fromMac]
        );
        delete deviceAlertState[normalizeMac(fromMac)];

        await client.query('COMMIT');
        publishPairedDeviceList();
        res.json({ success: true });
    } catch (e) {"""

new_change = """app.post('/api/change-device', requireCapability('pairing:write'), async (req, res) => {
    const { fromMac, toMac } = req.body;
    if (!fromMac || !toMac || fromMac === toMac) {
        return res.status(400).json({ error: 'Invalid device Macs' });
    }
    const nurse = req.user.name || req.user.username;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const scope = await wardScopeSql(req, 'ward_id', 2);
        
        const fromDevice = await client.query(`SELECT hm_number, name, bed_no, ward_id FROM nurseaid WHERE mac=$1 ${scope.clause ? 'AND ' + scope.clause : ''}`, [fromMac, ...scope.params]);
        if (!fromDevice.rows.length || !fromDevice.rows[0].hm_number) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Source device is not paired or access denied' });
        }
        
        const toDevice = await client.query(`SELECT hm_number FROM nurseaid WHERE mac=$1 ${scope.clause ? 'AND ' + scope.clause : ''}`, [toMac, ...scope.params]);
        if (!toDevice.rows.length) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Target device not found or access denied' });
        }
        if (toDevice.rows[0].hm_number) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Target device is already paired' });
        }

        const patient = fromDevice.rows[0];

        await client.query(
            "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
            [fromMac]
        );
        await client.query(
            'UPDATE nurseaid SET hm_number=NULL, name=NULL, bed_no=NULL, update_by=$1, lastupdate=NOW() WHERE mac=$2',
            [nurse, fromMac]
        );
        
        await client.query(
            'UPDATE nurseaid SET hm_number=$1, name=$2, bed_no=$3, update_by=$4, lastupdate=NOW() WHERE mac=$5',
            [patient.hm_number, patient.name, patient.bed_no, nurse, toMac]
        );
        await client.query(
            'INSERT INTO device_history (mac, hm_number, patient_name, bed_no, assign_time, status) VALUES ($1, $2, $3, $4, NOW(), $5)',
            [toMac, patient.hm_number, patient.name, patient.bed_no, 'active']
        );
        
        await client.query(
            `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
             WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false`,
            [fromMac]
        );
        delete deviceAlertState[normalizeMac(fromMac)];

        await client.query('COMMIT');
        logAudit(req, 'CHANGE_DEVICE', 'device', fromMac, { to_mac: toMac, ward_id: patient.ward_id, hn: patient.hm_number }).catch(console.error);
        publishPairedDeviceList();
        res.json({ success: true });
    } catch (e) {"""

content = content.replace(old_change, new_change)

with open('/root/nurseaid/server.js', 'w') as f:
    f.write(content)
print("Updated pairing API routes")
