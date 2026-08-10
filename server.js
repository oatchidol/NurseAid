const express = require('express');
const { Pool, types } = require('pg');
// Every timestamp column in this schema is TIMESTAMP WITHOUT TIME ZONE, and Postgres's
// session timezone here is UTC — so NOW() is stored as plain UTC wall-clock digits with
// no offset marker. node-postgres's default parser for that type (oid 1114) builds the
// JS Date from those digits as if they were *local* time (the Node process runs with
// TZ=Asia/Bangkok), which silently shifts every timestamp read from the DB back by 7
// hours. Override the parser to treat the naive string as UTC instead, so created_at /
// acknowledged_at / etc. report the real instant everywhere (audit log, alert history, ...).
types.setTypeParser(1114, str => (str === null ? null : new Date(str.replace(' ', 'T') + 'Z')));
const { InfluxDB } = require('@influxdata/influxdb-client');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { promisify } = require('util');
const mqtt = require('mqtt');
const {
    buildLiveSnapshot,
    calculateQueryWindowMinutes,
    createResilientSingleFlightCache,
    markStatusesUnavailable,
    offlineThresholdMinutes,
    shouldRaiseOfflineAlert
} = require('./live-status');
const app = express();
// Trust exactly one hop of reverse proxy (nginx at the edge terminates TLS and
// forwards X-Forwarded-Proto/X-Forwarded-For) so req.protocol reflects the real
// client-facing scheme instead of always reporting 'http'. Without this, the
// origin check below always computes an http:// expected origin even when the
// site is accessed over https via the proxy, rejecting every non-GET request.
app.set('trust proxy', 1);

const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3333;
const SERVER_STARTED_AT_MS = Date.now();
const parsedLiveFreshness = Number.parseInt(process.env.LIVE_VITAL_FRESHNESS_SECONDS || '600', 10);
const LIVE_VITAL_FRESHNESS_SECONDS = Number.isFinite(parsedLiveFreshness) && parsedLiveFreshness > 0
    ? parsedLiveFreshness
    : 600;
const parsedStatusFreshness = Number.parseInt(process.env.LIVE_STATUS_FRESHNESS_SECONDS || '180', 10);
const parsedBatteryFreshness = Number.parseInt(process.env.LIVE_BATTERY_FRESHNESS_SECONDS || '1800', 10);
const parsedPresenceFreshness = Number.parseInt(process.env.LIVE_PRESENCE_FRESHNESS_SECONDS || '90', 10);
const parsedLiveHrFreshness = Number.parseInt(process.env.LIVE_HR_FRESHNESS_SECONDS || '30', 10);
const LIVE_FRESHNESS_POLICY = {
    clinical: LIVE_VITAL_FRESHNESS_SECONDS,
    status: Number.isFinite(parsedStatusFreshness) && parsedStatusFreshness > 0 ? parsedStatusFreshness : 180,
    battery: Number.isFinite(parsedBatteryFreshness) && parsedBatteryFreshness > 0 ? parsedBatteryFreshness : 1800,
    quality: LIVE_VITAL_FRESHNESS_SECONDS,
    presence: Number.isFinite(parsedPresenceFreshness) && parsedPresenceFreshness > 0 ? parsedPresenceFreshness : 90,
    liveHr: Number.isFinite(parsedLiveHrFreshness) && parsedLiveHrFreshness > 0 ? parsedLiveHrFreshness : 30,
    sessionStartedAtMs: SERVER_STARTED_AT_MS
};
const LIVE_CLINICAL_QUERY_WINDOW_MINUTES = calculateQueryWindowMinutes({
    clinical: LIVE_FRESHNESS_POLICY.clinical,
    status: LIVE_FRESHNESS_POLICY.status,
    quality: LIVE_FRESHNESS_POLICY.quality,
    presence: LIVE_FRESHNESS_POLICY.presence
});
const LIVE_BATTERY_QUERY_WINDOW_MINUTES = calculateQueryWindowMinutes({
    battery: LIVE_FRESHNESS_POLICY.battery
});
const parsedInfluxTimeout = Number.parseInt(process.env.INFLUX_QUERY_TIMEOUT_MS || '5000', 10);
const INFLUX_QUERY_TIMEOUT_MS = Number.isFinite(parsedInfluxTimeout) && parsedInfluxTimeout >= 1000
    ? parsedInfluxTimeout
    : 5000;
const parsedLiveFallback = Number.parseInt(process.env.LIVE_STATUS_FALLBACK_SECONDS || '300', 10);
const LIVE_STATUS_FALLBACK_MS = (Number.isFinite(parsedLiveFallback) && parsedLiveFallback > 0
    ? parsedLiveFallback
    : 300) * 1000;
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const APP_ORIGIN = process.env.APP_ORIGIN || '';
const SESSION_COOKIE = 'nurseaid_session';

if (SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters');
}

// Database configuration from environment variables
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'softwatch_iot',
    password: process.env.DB_PASSWORD || '',
    port: process.env.DB_PORT || 5432,
});

// InfluxDB configuration from environment variables
const influxConfig = {
    url: process.env.INFLUX_URL || 'http://localhost:8086',
    token: process.env.INFLUX_TOKEN || '',
    org: process.env.INFLUX_ORG || 'softsquaregroup',
    bucket: process.env.INFLUX_BUCKET || 'naret2'
};
const queryApi = new InfluxDB({
    url: influxConfig.url,
    token: influxConfig.token,
    timeout: INFLUX_QUERY_TIMEOUT_MS
}).getQueryApi(influxConfig.org);

// ============================================================
// MQTT Client — publishes paired device list to BLE Gateway
// ============================================================
const MQTT_HOST = process.env.MQTT_HOST || 'localhost';
const MQTT_PORT = Number.parseInt(process.env.MQTT_PORT || '1883', 10);
const MQTT_USER = process.env.MQTT_USER || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const MQTT_PAIRED_TOPIC = 'nurseaid/paired_devices';

let mqttClient = null;

function initMqttClient() {
    const url = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
    const options = { clientId: `nurseaid_server_${Date.now()}`, reconnectPeriod: 5000 };
    if (MQTT_USER) { options.username = MQTT_USER; options.password = MQTT_PASSWORD; }
    mqttClient = mqtt.connect(url, options);
    mqttClient.on('connect', () => console.log('[MQTT] Server connected to broker'));
    mqttClient.on('error', (err) => console.error('[MQTT] Connection error:', err.message));
    mqttClient.on('offline', () => console.warn('[MQTT] Client went offline, will reconnect'));
}

async function publishPairedDeviceList() {
    if (!mqttClient || !mqttClient.connected) return;
    try {
        const result = await pool.query(
            `SELECT mac, device_no, hm_number, name, bed_no,
                    COALESCE(device_type, 'jstyle') AS device_type
             FROM nurseaid
             WHERE mac IS NOT NULL AND mac <> ''
               AND NULLIF(BTRIM(hm_number), '') IS NOT NULL
             ORDER BY device_no`
        );
        const payload = JSON.stringify({
            devices: result.rows,
            timestamp: Date.now()
        });
        mqttClient.publish(MQTT_PAIRED_TOPIC, payload, { qos: 1, retain: true }, (err) => {
            if (err) console.error('[MQTT] Publish paired devices failed:', err.message);
            else console.log(`[MQTT] Published ${result.rows.length} paired device(s) to ${MQTT_PAIRED_TOPIC}`);
        });

        // Publish a simple MAC array specifically for ESP32 memory-constrained parsing
        const macArray = result.rows.map(row => row.mac);
        mqttClient.publish('ble/mac', JSON.stringify(macArray), { qos: 1, retain: true });
    } catch (e) {
        console.error('[MQTT] Error querying paired devices:', e.message);
    }
}

app.disable('x-powered-by');
app.use(cors({ origin: APP_ORIGIN || false, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    next();
});

function parseCookies(header = '') {
    return header.split(';').reduce((cookies, item) => {
        const separator = item.indexOf('=');
        if (separator < 0) return cookies;
        const key = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
        return cookies;
    }, {});
}

function sessionCookie(token) {
    const secure = process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE === 'true';
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? '; Secure' : ''}`;
}

function clearSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const derived = await scryptAsync(String(password), salt, 64);
    return `scrypt:${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(password, stored) {
    if (!stored || !password) return false;
    if (!stored.startsWith('scrypt:')) return String(password) === String(stored);
    const [, salt, expectedHex] = stored.split(':');
    if (!salt || !expectedHex) return false;
    const actual = await scryptAsync(String(password), salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({
        '&': '&', '<': '<', '>': '>', "'": '&#39;', '"': '"'
    })[char]);
}

function escapeJsSingle(value) {
    return escapeHtml(String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n\u2028\u2029]/g, ' '));
}

// ─── Role & Capability Model ───────────────────────────────────────
const ROLES = Object.freeze(['super_admin', 'ward_admin', 'staff_nurse', 'viewer']);

const ROLE_CAPABILITIES = {
    super_admin: new Set([
        'patients:read','patients:write','devices:read','devices:write','pairing:write',
        'alerts:read','alerts:ack','alerts:settings:write',
        'users:manage:all','wards:manage','settings:global','audit:read:all','export:read'
    ]),
    ward_admin: new Set([
        'patients:read','patients:write','devices:read','devices:write','pairing:write',
        'alerts:read','alerts:ack','alerts:settings:write',
        'users:manage:ward','audit:read:ward','export:read'
    ]),
    staff_nurse: new Set(['patients:read','devices:read','alerts:read','alerts:ack','export:read']),
    viewer: new Set(['patients:read','devices:read','alerts:read'])
};

function roleHasCapability(role, cap) { return ROLE_CAPABILITIES[role]?.has(cap) === true; }

function accessDeniedPage(req) {
    return ui(req.user, 'Access Denied', `
        <div class="empty-state" style="padding: 40px; text-align: center;">
            <div class="empty-icon" style="color:var(--danger); font-size: 3rem; margin-bottom: 20px;">⚠️</div>
            <h2>Access Denied</h2>
            <p>You do not have permission to access this page.</p>
            <a href="/" class="btn-primary" style="margin-top:20px; display:inline-block; padding: 10px 20px; border-radius: 8px; text-decoration: none;">Return to Dashboard</a>
        </div>
    `, '');
}

function requireCapability(...capabilities) {
    // Accept multiple capabilities - any one grants access
    const caps = capabilities.flat();
    return (req, res, next) => {
        if (caps.some(cap => roleHasCapability(req.user?.role, cap))) return next();
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
        return res.status(403).send(accessDeniedPage(req));
    };
}

// ─── Ward scoping helpers ──────────────────────────────────────────
async function getUserWardIds(userId) {
    const result = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [userId]);
    return result.rows.map(r => r.ward_id);
}

async function wardScopeSql(req, column = 'ward_id', paramIndex = 1) {
    if (req.user.role === 'super_admin') return { clause: '', params: [] };
    const ids = req.user.wardIds || await getUserWardIds(req.user.id);
    if (!ids.length) return { clause: `${column} = -1`, params: [] }; // ไม่มีวอร์ด = ไม่เห็นอะไร
    return { clause: `${column} = ANY($${paramIndex})`, params: [ids] };
}

// A ward_admin may only manage (edit/delete/reset-password) users who share at
// least one ward with them — mirrors the read-side scoping above. super_admin/admin
// are not ward-restricted and always pass.
async function userSharesWardWithCaller(req, targetUserId) {
    if (req.user.role !== 'ward_admin') return true;
    const ids = req.user.wardIds || await getUserWardIds(req.user.id);
    if (!ids.length) return false;
    const r = await pool.query(
        'SELECT 1 FROM user_wards WHERE user_id=$1 AND ward_id = ANY($2) LIMIT 1',
        [targetUserId, ids]
    );
    return r.rows.length > 0;
}

// ─── Audit logging helper ──────────────────────────────────────────
async function logAudit(req, action, entityType, entityId, details) {
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        const role = req.user?.role || null;
        const userId = req.user?.id || null;
        // Actions on a user can touch more than one ward (a multi-ward assignment) —
        // fan out into one audit_log row per ward so every ward_admin whose ward was
        // affected sees the entry in their own (ward-scoped) audit log, not just
        // super_admin. Falls back to a single ward_id (or none) as before.
        let wardIds = [null];
        if (details) {
            if (Array.isArray(details.wards) && details.wards.length) {
                wardIds = [...new Set(details.wards.filter(w => w !== undefined && w !== null))];
                if (!wardIds.length) wardIds = [null];
            } else if (details.ward_id !== undefined && details.ward_id !== null) {
                wardIds = [details.ward_id];
            }
        }
        const detailsJson = JSON.stringify(details || {});
        for (const wardId of wardIds) {
            await pool.query(
                `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, actor_role, ward_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [userId, action, entityType, entityId, detailsJson, ip, role, wardId]
            );
        }
    } catch (e) {
        console.error('[Audit Log] Error:', e.message);
    }
}

const publicPaths = new Set(['/login', '/api/login', '/health', '/health/live', '/health/ready']);
app.use(async (req, res, next) => {
    if (publicPaths.has(req.path)) return next();

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    let claims;
    try {
        claims = jwt.verify(token || '', SESSION_SECRET);
    } catch (_) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
        return res.redirect('/login');
    }

    try {
        const result = await pool.query(
            `SELECT id, username, full_name, role, session_version
             FROM users WHERE id=$1`,
            [claims.id]
        );
        const user = result.rows[0];
        if (!user || Number(claims.sessionVersion) !== Number(user.session_version)) {
            if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Session expired' });
            return res.redirect('/login');
        }
        req.user = {
            id: user.id,
            username: user.username,
            name: user.full_name,
            role: user.role
        };
        // Load user's ward assignments for scoping
        req.user.wardIds = await getUserWardIds(user.id);
    } catch (error) {
        console.error('[Authentication]', error.message);
        if (req.path.startsWith('/api/')) return res.status(503).json({ error: 'Authentication service unavailable' });
        return res.status(503).send('Authentication service unavailable');
    }

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.get('origin');
        const expectedOrigin = APP_ORIGIN || `${req.protocol}://${req.get('host')}`;
        if (origin && origin !== expectedOrigin) return res.status(403).json({ error: 'Invalid request origin' });
    }
    next();
});

// LINE Bot Token - ใชจาก environment variable (หากไม ใสจะไมส่ง LINE)
const LINE_TOKEN = process.env.LINE_TOKEN || '';
const GROUP_ID = process.env.LINE_GROUP_ID || '';
const deviceAlertState = {};
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Bangkok';
const ALERT_ENGINE_INTERVAL_MS = Math.max(5000, Number.parseInt(process.env.ALERT_ENGINE_INTERVAL_MS || '15000', 10) || 15000);
const LINE_RATE_LIMIT_BACKOFF_MS = Math.max(
    60000,
    (Number.parseInt(process.env.LINE_RATE_LIMIT_BACKOFF_SECONDS || '900', 10) || 900) * 1000
);
const LIVE_STATUS_CACHE_MS = Math.max(0, Number.parseInt(process.env.LIVE_STATUS_CACHE_MS || '3000', 10) || 0);
const TREND_WINDOW_CONFIG = Object.freeze({
    '1': { hours: 1, range: '1h', aggregateWindow: '1m', postgresBucketMinutes: 1 },
    '6': { hours: 6, range: '6h', aggregateWindow: '2m', postgresBucketMinutes: 2 },
    '12': { hours: 12, range: '12h', aggregateWindow: '5m', postgresBucketMinutes: 5 },
    '24': { hours: 24, range: '24h', aggregateWindow: '5m', postgresBucketMinutes: 5 },
    '72': { hours: 72, range: '72h', aggregateWindow: '15m', postgresBucketMinutes: 15 },
    '168': { hours: 168, range: '168h', aggregateWindow: '30m', postgresBucketMinutes: 30 }
});
let alertEngineRunning = false;
const lineSuppressedUntilByToken = new Map();

// Initialize database tables
async function initDatabase() {
    const tables = [
        `CREATE TABLE IF NOT EXISTS alert_settings (
            id SERIAL PRIMARY KEY,
            mac VARCHAR(50) UNIQUE,
            hr_min INTEGER DEFAULT 50, hr_max INTEGER DEFAULT 120,
            hr_warning_min INTEGER DEFAULT 60, hr_warning_max INTEGER DEFAULT 110,
            spo2_min INTEGER DEFAULT 95,
            spo2_warning_min INTEGER DEFAULT 95, spo2_critical_min INTEGER DEFAULT 91,
            temp_min DECIMAL(3,1) DEFAULT 35.5, temp_max DECIMAL(3,1) DEFAULT 37.5,
            temp_warning_min DECIMAL(3,1) DEFAULT 36.0, temp_warning_max DECIMAL(3,1) DEFAULT 37.0,
            enable_sound BOOLEAN DEFAULT true,
            enable_line BOOLEAN DEFAULT true,
            enable_offline_alert BOOLEAN DEFAULT true,
            enable_webhook BOOLEAN DEFAULT false,
            webhook_url TEXT,
            webhook_headers TEXT,
            silence_start TIME DEFAULT '22:00',
            silence_end TIME DEFAULT '06:00',
            escalation_enabled BOOLEAN DEFAULT false,
            escalation_timeout INTEGER DEFAULT 15,
            battery_low_threshold INTEGER DEFAULT 20,
            offline_threshold_minutes INTEGER DEFAULT 2,
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS alert_logs (
            id SERIAL PRIMARY KEY,
            mac VARCHAR(50),
            bed_no VARCHAR(10),
            patient_name VARCHAR(100),
            level VARCHAR(20) DEFAULT 'warning',
            category VARCHAR(20),
            message TEXT,
            acknowledged BOOLEAN DEFAULT false,
            acknowledged_by VARCHAR(50),
            acknowledged_at TIMESTAMP,
            resolved BOOLEAN DEFAULT false,
            resolved_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS webhook_logs (
            id SERIAL PRIMARY KEY,
            alert_id INTEGER REFERENCES alert_logs(id),
            url TEXT,
            status_code INTEGER,
            response_body TEXT,
            retry_count INTEGER DEFAULT 0,
            sent_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS audit_logs (
            id SERIAL PRIMARY KEY,
            user_id INTEGER,
            action VARCHAR(100),
            entity_type VARCHAR(50),
            entity_id VARCHAR(100),
            details JSONB,
            created_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS system_settings (
            id SERIAL PRIMARY KEY,
            setting_key VARCHAR(100) UNIQUE,
            setting_value TEXT,
            updated_at TIMESTAMP DEFAULT NOW()
        )`,
        `CREATE TABLE IF NOT EXISTS user_notification_settings (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) UNIQUE,
            
            -- LINE
            line_enabled BOOLEAN DEFAULT false,
            line_bot_token TEXT,
            line_target TEXT,
            
            -- Telegram
            telegram_enabled BOOLEAN DEFAULT false,
            telegram_bot_token TEXT,
            telegram_chat_id TEXT,
            
            -- Email
            email_enabled BOOLEAN DEFAULT false,
            email_smtp_host TEXT,
            email_smtp_port INTEGER DEFAULT 587,
            email_username TEXT,
            email_password TEXT,
            email_to TEXT,
            email_secure BOOLEAN DEFAULT true,
            
            -- Webhook
            webhook_enabled BOOLEAN DEFAULT false,
            webhook_url TEXT,
            webhook_headers TEXT,
            
            -- Alert Rules
            alert_critical BOOLEAN DEFAULT true,
            alert_warning BOOLEAN DEFAULT false,
            sound_enabled BOOLEAN DEFAULT true,
            silent_start TIME DEFAULT '22:00',
            silent_end TIME DEFAULT '06:00',
            
            updated_at TIMESTAMP DEFAULT NOW()
        )`
    ];
    for (const sql of tables) {
        try { await pool.query(sql); } catch (e) { console.error("Table init error:", e.message); }
    }
    // Runtime migrations for existing installations
    try {
        await pool.query("ALTER TABLE nurseaid ADD COLUMN IF NOT EXISTS device_type VARCHAR(20) DEFAULT 'jstyle'");
        await pool.query("UPDATE nurseaid SET device_type='jstyle' WHERE device_type IS NULL OR device_type='' ");
        await pool.query(`
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS hr_warning_min INTEGER;
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS hr_warning_max INTEGER;
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS spo2_warning_min INTEGER;
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS spo2_critical_min INTEGER;
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS temp_warning_min DECIMAL(3,1);
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS temp_warning_max DECIMAL(3,1);
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS enable_offline_alert BOOLEAN DEFAULT true;
            ALTER TABLE alert_settings ADD COLUMN IF NOT EXISTS offline_threshold_minutes INTEGER DEFAULT 2;
            UPDATE alert_settings SET
                hr_warning_min=COALESCE(hr_warning_min, CASE WHEN hr_min+10 < hr_max-10 THEN hr_min+10 ELSE ROUND(hr_min+(hr_max-hr_min)/3.0) END),
                hr_warning_max=COALESCE(hr_warning_max, CASE WHEN hr_min+10 < hr_max-10 THEN hr_max-10 ELSE ROUND(hr_max-(hr_max-hr_min)/3.0) END),
                spo2_warning_min=COALESCE(spo2_warning_min, spo2_min),
                spo2_critical_min=COALESCE(spo2_critical_min, GREATEST(50, spo2_min-4)),
                temp_warning_min=COALESCE(temp_warning_min, CASE WHEN temp_min+0.5 < temp_max-0.5 THEN temp_min+0.5 ELSE ROUND((temp_min+(temp_max-temp_min)/3.0)::numeric,1) END),
                temp_warning_max=COALESCE(temp_warning_max, CASE WHEN temp_min+0.5 < temp_max-0.5 THEN temp_max-0.5 ELSE ROUND((temp_max-(temp_max-temp_min)/3.0)::numeric,1) END),
                enable_offline_alert=COALESCE(enable_offline_alert, true),
                offline_threshold_minutes=CASE WHEN offline_threshold_minutes IS NULL OR offline_threshold_minutes=10 THEN 2 ELSE offline_threshold_minutes END;
            ALTER TABLE alert_settings ALTER COLUMN hr_warning_min SET DEFAULT 60;
            ALTER TABLE alert_settings ALTER COLUMN hr_warning_max SET DEFAULT 110;
            ALTER TABLE alert_settings ALTER COLUMN spo2_warning_min SET DEFAULT 95;
            ALTER TABLE alert_settings ALTER COLUMN spo2_critical_min SET DEFAULT 91;
            ALTER TABLE alert_settings ALTER COLUMN temp_warning_min SET DEFAULT 36.0;
            ALTER TABLE alert_settings ALTER COLUMN temp_warning_max SET DEFAULT 37.0;
            ALTER TABLE alert_settings ALTER COLUMN enable_offline_alert SET DEFAULT true;
            ALTER TABLE alert_settings ALTER COLUMN offline_threshold_minutes SET DEFAULT 2;
        `);
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_vital_signs_logs_mac_recorded_at
            ON vital_signs_logs(mac, recorded_at)
        `);
    } catch (e) { console.error("Migration error:", e.message); }
    await pool.query(`
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 0
    `);
    // ─── RBAC Migration: wards, user_wards ─────────────────────────────
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS wards (
                id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, code VARCHAR(20) UNIQUE NOT NULL,
                created_at TIMESTAMP DEFAULT NOW()
            );
            ALTER TABLE wards ADD COLUMN IF NOT EXISTS description TEXT;
            ALTER TABLE wards ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
            CREATE TABLE IF NOT EXISTS user_wards (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
                role_in_ward VARCHAR(20) DEFAULT 'staff_nurse',
                granted_by INTEGER REFERENCES users(id),
                granted_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (user_id, ward_id)
            );
            CREATE INDEX IF NOT EXISTS idx_user_wards_ward_id ON user_wards(ward_id);

            ALTER TABLE user_wards ADD COLUMN IF NOT EXISTS role_in_ward VARCHAR(20) DEFAULT 'staff_nurse';
            ALTER TABLE user_wards ADD COLUMN IF NOT EXISTS granted_by INTEGER REFERENCES users(id);
            ALTER TABLE user_wards ADD COLUMN IF NOT EXISTS granted_at TIMESTAMP DEFAULT NOW();

            ALTER TABLE patients ADD COLUMN IF NOT EXISTS ward_id INTEGER REFERENCES wards(id);
            ALTER TABLE nurseaid ADD COLUMN IF NOT EXISTS ward_id INTEGER REFERENCES wards(id);
            CREATE INDEX IF NOT EXISTS idx_patients_ward_id ON patients(ward_id);
            CREATE INDEX IF NOT EXISTS idx_nurseaid_ward_id ON nurseaid(ward_id);

            ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45);
            ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_role VARCHAR(20);
            ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ward_id INTEGER REFERENCES wards(id);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type ON audit_logs(entity_type);
            CREATE INDEX IF NOT EXISTS idx_audit_logs_ward_id ON audit_logs(ward_id);

            -- alert_logs.ward_id is captured at alert-creation time (not derived by joining
            -- to nurseaid live) so ward attribution stays correct even after the device is
            -- later unpaired or re-paired to a different ward's patient.
            ALTER TABLE alert_logs ADD COLUMN IF NOT EXISTS ward_id INTEGER REFERENCES wards(id);
            CREATE INDEX IF NOT EXISTS idx_alert_logs_ward_id ON alert_logs(ward_id);
        `);

        // Backfill
        await pool.query(`
            INSERT INTO wards (name, code) VALUES ('Unassigned', 'DEFAULT') ON CONFLICT (code) DO NOTHING;
            UPDATE patients SET ward_id = (SELECT id FROM wards WHERE code='DEFAULT') WHERE ward_id IS NULL;
            -- Ward now lives on the patient, not the device: keep every currently-paired
            -- device's ward_id mirrored from its patient (self-correcting, safe to re-run).
            UPDATE nurseaid n SET ward_id = p.ward_id
              FROM patients p
              WHERE LOWER(n.hm_number) = LOWER(p.hn_number) AND n.hm_number IS NOT NULL
                AND n.ward_id IS DISTINCT FROM p.ward_id;
            UPDATE nurseaid SET ward_id = (SELECT id FROM wards WHERE code='DEFAULT') WHERE ward_id IS NULL;
            -- Best-effort one-time backfill for alerts logged before ward_id existed on
            -- alert_logs: attribute them to whichever ward the device is in *now*. Not
            -- perfectly retroactive for devices re-paired since, but every alert logged
            -- from here on captures its ward at creation time and won't drift.
            UPDATE alert_logs a SET ward_id = n.ward_id
              FROM nurseaid n
              WHERE LOWER(n.mac) = LOWER(a.mac) AND a.ward_id IS NULL AND n.ward_id IS NOT NULL;
            UPDATE users SET role = 'super_admin' WHERE role = 'admin';
            UPDATE users SET role = 'staff_nurse' WHERE role = 'operator';
            -- One-time backfill for legacy staff_nurse accounts that predate the ward
            -- system and have NO ward at all — guarded by NOT EXISTS so it never touches
            -- (or re-adds "Unassigned" to) an account that already has a real ward. This
            -- runs on every boot, so without the guard it would re-add "Unassigned" to
            -- every staff_nurse on every restart, including ones just given a real ward.
            INSERT INTO user_wards (user_id, ward_id)
              SELECT u.id, (SELECT id FROM wards WHERE code='DEFAULT') FROM users u
              WHERE u.role='staff_nurse' AND NOT EXISTS (SELECT 1 FROM user_wards uw WHERE uw.user_id = u.id)
              ON CONFLICT DO NOTHING;
        `);
    } catch (e) { console.error("RBAC migration error:", e.message); }

        const userCount = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) === 0) {
        const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || '';
        if (initialPassword.length < 12) {
            throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 12 characters when no users exist');
        }
        await pool.query(
            'INSERT INTO users (username, full_name, password, role) VALUES ($1,$2,$3,$4)',
            [process.env.INITIAL_ADMIN_USERNAME || 'admin', 'Administrator', await hashPassword(initialPassword), 'super_admin']
        );
    }
}

async function ensureDeviceTypeColumn() {
    await pool.query("ALTER TABLE nurseaid ADD COLUMN IF NOT EXISTS device_type VARCHAR(20) DEFAULT 'jstyle'");
    await pool.query("UPDATE nurseaid SET device_type='jstyle' WHERE device_type IS NULL OR device_type='' ");
}

function timeInZone(date = new Date()) {
    return new Intl.DateTimeFormat('en-GB', {
        timeZone: APP_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).format(date);
}

function isSilencePeriod(start, end, date = new Date()) {
    const current = timeInZone(date);
    const from = String(start || '').slice(0, 5);
    const to = String(end || '').slice(0, 5);
    if (!from || !to || from === to) return false;
    return from < to ? current >= from && current < to : current >= from || current < to;
}

function safeJsonObject(value) {
    if (!value) return {};
    try {
        const parsed = typeof value === 'string' ? JSON.parse(value) : value;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (_) { return {}; }
}

async function sendWebhook(url, data, headerValue = null, alertId = null) {
    try {
        const headers = { 'Content-Type': 'application/json', ...safeJsonObject(headerValue) };
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(10000)
        });
        const body = await response.text();
        // Log webhook
        try {
            await pool.query('INSERT INTO webhook_logs (alert_id, url, status_code, response_body) VALUES ($1, $2, $3, $4)',
                [alertId, url, response.status, body.slice(0, 4000)]);
        } catch (e) { }
        return { success: true, status: response.status, body };
    } catch (e) {
        console.error("Webhook error:", e.message);
        return { success: false, error: e.message };
    }
}

function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

function escapeFluxString(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeMac(value) {
    return String(value ?? '').toLowerCase().trim();
}

function alertThresholds(settings = {}) {
    const hrCriticalMin = toFiniteNumber(settings.hr_min) ?? 50;
    const hrCriticalMax = toFiniteNumber(settings.hr_max) ?? 120;
    const tempCriticalMin = toFiniteNumber(settings.temp_min) ?? 35.5;
    const tempCriticalMax = toFiniteNumber(settings.temp_max) ?? 37.5;
    const spo2WarningMin = toFiniteNumber(settings.spo2_warning_min ?? settings.spo2_min) ?? 95;

    let hrWarningMin = toFiniteNumber(settings.hr_warning_min);
    let hrWarningMax = toFiniteNumber(settings.hr_warning_max);
    if (!(hrCriticalMin < hrWarningMin && hrWarningMin < hrWarningMax && hrWarningMax < hrCriticalMax)) {
        hrWarningMin = Math.round(hrCriticalMin + (hrCriticalMax - hrCriticalMin) / 3);
        hrWarningMax = Math.round(hrCriticalMax - (hrCriticalMax - hrCriticalMin) / 3);
    }

    let tempWarningMin = toFiniteNumber(settings.temp_warning_min);
    let tempWarningMax = toFiniteNumber(settings.temp_warning_max);
    if (!(tempCriticalMin < tempWarningMin && tempWarningMin < tempWarningMax && tempWarningMax < tempCriticalMax)) {
        tempWarningMin = Number((tempCriticalMin + (tempCriticalMax - tempCriticalMin) / 3).toFixed(1));
        tempWarningMax = Number((tempCriticalMax - (tempCriticalMax - tempCriticalMin) / 3).toFixed(1));
    }

    let spo2CriticalMin = toFiniteNumber(settings.spo2_critical_min);
    if (!(spo2CriticalMin >= 50 && spo2CriticalMin < spo2WarningMin)) {
        spo2CriticalMin = Math.max(50, spo2WarningMin - 4);
    }

    return {
        hrMin: hrCriticalMin,
        hrWarningMin,
        hrWarningMax,
        hrMax: hrCriticalMax,
        spo2Min: spo2WarningMin,
        spo2WarningMin,
        spo2CriticalMin,
        tempMin: tempCriticalMin,
        tempWarningMin,
        tempWarningMax,
        tempMax: tempCriticalMax
    };
}

function classifyVitalRange(value, criticalMin, warningMin, warningMax, criticalMax) {
    if (!Number.isFinite(Number(value))) return 'normal';
    const number = Number(value);
    if (number < criticalMin || number > criticalMax) return 'critical';
    if (number < warningMin || number > warningMax) return 'warning';
    return 'normal';
}

function higherAlertLevel(current, next) {
    if (current === 'critical' || next === 'critical') return 'critical';
    if (current === 'warning' || next === 'warning') return 'warning';
    return 'normal';
}

function parseExportDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function formatExportDateTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';

    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: process.env.APP_TIMEZONE || 'Asia/Bangkok',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${values.day}/${values.month}/${values.year} ${values.hour}:${values.minute}:${values.second}`;
}

function getWearableVitalRecord(d) {
    const wearStatus = parseInt(d.ble_status, 10);
    const heartRate = toFiniteNumber(d.ble_heart);
    const spo2 = toFiniteNumber(d.ble_spo2);
    const temperature = toFiniteNumber(d.ble_temp);
    const battery = toFiniteNumber(d.ble_batt);
    const hasHeartRate = heartRate !== null && heartRate > 0;
    const hasSpo2 = spo2 !== null && spo2 > 0;
    const hasTemperature = temperature !== null && temperature > 0;

    // Influx measurements are not always written at the exact same timestamp.
    // Skip only when the device explicitly says "not worn", or when no vital value exists.
    if (wearStatus === 0 || (!hasHeartRate && !hasSpo2 && !hasTemperature)) {
        return null;
    }

    return {
        heartRate: hasHeartRate ? heartRate : null,
        spo2: hasSpo2 ? spo2 : null,
        temperature: hasTemperature ? temperature : null,
        battery
    };
}

async function postJson(url, body, headers = {}) {
    const response = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
        const responseText = await response.text();
        const error = new Error(`${response.status} ${responseText}`);
        error.status = response.status;
        error.responseText = responseText;
        error.retryAfter = response.headers.get('retry-after');
        throw error;
    }
}

function nextUtcMonthStartMs(now = new Date()) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 5, 0);
}

function lineCredentialId(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

async function postLinePush(token, target, text) {
    const now = Date.now();
    const suppressedUntil = Number(lineSuppressedUntilByToken.get(token) || 0);
    if (suppressedUntil > now) return { skipped: true, suppressedUntil };

    try {
        await postJson('https://api.line.me/v2/bot/message/push', {
            to: target,
            messages: [{ type: 'text', text }]
        }, { Authorization: `Bearer ${token}` });
        lineSuppressedUntilByToken.delete(token);
        return { sent: true };
    } catch (error) {
        if (Number(error.status) !== 429) throw error;

        const responseText = String(error.responseText || error.message || '');
        const monthlyLimit = /monthly limit/i.test(responseText);
        const retryAfterSeconds = Number.parseInt(error.retryAfter || '', 10);
        const backoffMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? retryAfterSeconds * 1000
            : LINE_RATE_LIMIT_BACKOFF_MS;
        const until = monthlyLimit
            ? nextUtcMonthStartMs()
            : now + backoffMs;
        lineSuppressedUntilByToken.set(token, until);
        console.error(
            `[LINE] credential=${lineCredentialId(token)} paused until ` +
            `${new Date(until).toISOString()} after HTTP 429` +
            `${monthlyLimit ? ' monthly quota exhaustion' : ''}`
        );
        return { skipped: true, suppressedUntil: until };
    }
}

function connectionNotificationText(status, event, thresholdMinutes) {
    const device = status.device_no ? `#${status.device_no}` : status.mac;
    if (event === 'online') {
        return `🟢 NurseAid DEVICE ONLINE\nเตียง: ${status.bed_no || '-'}\nคนไข้: ${status.name || '-'}\nอุปกรณ์: ${device || '-'}\nรายละเอียด: อุปกรณ์กลับมาเชื่อมต่อและส่งข้อมูลแล้ว`;
    }
    return `🟠 NurseAid DEVICE OFFLINE\nเตียง: ${status.bed_no || '-'}\nคนไข้: ${status.name || '-'}\nอุปกรณ์: ${device || '-'}\nรายละเอียด: ไม่ได้รับข้อมูลจากอุปกรณ์ต่อเนื่อง ${thresholdMinutes} นาที\nตรวจสอบระยะสัญญาณ แบตเตอรี่ และการสวมใส่อุปกรณ์`;
}

async function dispatchConnectionNotification(status, deviceSettings, event, thresholdMinutes) {
    if (deviceSettings.enable_line === false || deviceSettings.enable_offline_alert === false) return;

    const settings = await pool.query('SELECT * FROM user_notification_settings');
    const text = connectionNotificationText(status, event, thresholdMinutes);
    const destinations = new Set();
    const tasks = [];
    const addDestination = (token, target) => {
        if (!token || !target) return;
        const key = `${token}\u0000${target}`;
        if (destinations.has(key)) return;
        destinations.add(key);
        tasks.push(postLinePush(token, target, text));
    };

    for (const user of settings.rows) {
        if (user.line_enabled && !isSilencePeriod(user.silent_start, user.silent_end)) {
            addDestination(user.line_bot_token, user.line_target);
        }
    }
    if (!isSilencePeriod(deviceSettings.silence_start, deviceSettings.silence_end)) {
        addDestination(LINE_TOKEN, GROUP_ID);
    }

    const results = await Promise.allSettled(tasks);
    results.filter(item => item.status === 'rejected')
        .forEach(item => console.error('[Connection Notification]', item.reason?.message || item.reason));
}

async function dispatchAlertNotifications(alert, deviceSettings) {
    const settings = await pool.query('SELECT * FROM user_notification_settings');
    const icon = alert.level === 'critical' ? '🔴' : '🟡';
    const text = `${icon} NurseAid ${alert.level.toUpperCase()}\nเตียง: ${alert.bed_no || '-'}\nคนไข้: ${alert.patient_name || '-'}\nรายละเอียด: ${alert.message}`;
    const payload = { event: 'nurseaid.alert', alert };
    const tasks = [];

    for (const user of settings.rows) {
        if ((alert.level === 'critical' && !user.alert_critical) || (alert.level === 'warning' && !user.alert_warning)) continue;
        if (isSilencePeriod(user.silent_start, user.silent_end)) continue;
        if (deviceSettings.enable_line && user.line_enabled && user.line_bot_token && user.line_target) {
            tasks.push(postLinePush(user.line_bot_token, user.line_target, text));
        }
        if (user.telegram_enabled && user.telegram_bot_token && user.telegram_chat_id) {
            tasks.push(postJson(`https://api.telegram.org/bot${user.telegram_bot_token}/sendMessage`, {
                chat_id: user.telegram_chat_id, text
            }));
        }
        if (user.email_enabled && user.email_smtp_host && user.email_to) {
            const transport = nodemailer.createTransport({
                host: user.email_smtp_host,
                port: Number(user.email_smtp_port) || 587,
                secure: Boolean(user.email_secure),
                auth: user.email_username ? { user: user.email_username, pass: user.email_password || '' } : undefined
            });
            tasks.push(transport.sendMail({
                from: user.email_username || 'nurseaid@localhost', to: user.email_to,
                subject: `[NurseAid ${alert.level.toUpperCase()}] เตียง ${alert.bed_no || '-'}`, text
            }));
        }
        if (user.webhook_enabled && user.webhook_url) {
            tasks.push(sendWebhook(user.webhook_url, payload, user.webhook_headers, alert.id));
        }
    }

    if (deviceSettings.enable_line && LINE_TOKEN && GROUP_ID && !isSilencePeriod(deviceSettings.silence_start, deviceSettings.silence_end)) {
        tasks.push(postLinePush(LINE_TOKEN, GROUP_ID, text));
    }
    if (deviceSettings.enable_webhook && deviceSettings.webhook_url && !isSilencePeriod(deviceSettings.silence_start, deviceSettings.silence_end)) {
        tasks.push(sendWebhook(deviceSettings.webhook_url, payload, deviceSettings.webhook_headers, alert.id));
    }
    const results = await Promise.allSettled(tasks);
    results.filter(item => item.status === 'rejected').forEach(item => console.error('[Alert Notification]', item.reason?.message || item.reason));
}

async function replaceActiveAlert(mac, bed, name, level, category, message) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Serialize alert state transitions per MAC. This keeps the database's
        // one-active-alert invariant without racing vital and offline events.
        await client.query(
            `SELECT pg_advisory_xact_lock(hashtext(LOWER($1)))`,
            [mac]
        );
        await client.query(
            `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
             WHERE LOWER(mac)=LOWER($1) AND resolved=false`,
            [mac]
        );
        const inserted = await client.query(
            `INSERT INTO alert_logs (mac, bed_no, patient_name, level, category, message, ward_id)
             VALUES ($1, $2, $3, $4, $5, $6, (SELECT ward_id FROM nurseaid WHERE LOWER(mac)=LOWER($1) LIMIT 1))
             RETURNING *`,
            [mac, bed, name, level, category, message]
        );
        await client.query('COMMIT');
        return inserted.rows[0];
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        throw error;
    } finally {
        client.release();
    }
}

async function triggerAlert(mac, bed, name, level, category, msg, deviceSettings) {
    const alert = await replaceActiveAlert(mac, bed, name, level, category, msg);
    await dispatchAlertNotifications(alert, deviceSettings).catch(error => console.error('[Alert Dispatch]', error.message));
    return alert;
}

async function triggerOfflineAlert(status, deviceSettings, thresholdMinutes) {
    const message = `ไม่ได้รับข้อมูลจากอุปกรณ์ต่อเนื่อง ${thresholdMinutes} นาที อาจอยู่นอกระยะ แบตเตอรี่หมด หรือเชื่อมต่อไม่ได้`;
    const alert = await replaceActiveAlert(
        status.mac,
        status.bed_no,
        status.name,
        'warning',
        'device_offline',
        message
    );
    await dispatchConnectionNotification(status, deviceSettings, 'offline', thresholdMinutes)
        .catch(error => console.error('[Offline Alert Dispatch]', error.message));
    return alert;
}

async function resolveOfflineAlert(status, deviceSettings, thresholdMinutes, notifyRecovery = true) {
    const resolved = await pool.query(
        `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
         WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false
         RETURNING id`,
        [status.mac]
    );
    if (notifyRecovery && resolved.rows.length > 0) {
        await dispatchConnectionNotification(status, deviceSettings, 'online', thresholdMinutes)
            .catch(error => console.error('[Online Recovery Dispatch]', error.message));
    }
    return resolved.rows.length;
}

// adminOnly kept for backward compatibility with existing templates (deprecated, use requireCapability instead)
const adminOnly = requireCapability('settings:global');

// ─── Wards Management Routes ─────────────────────────────────────────
function renderNavLinks(user, active) {
    if (!user) return { main: '', alerts: '' };
    const role = user.role;
    let main = '';
    let alerts = '';
    
    if (roleHasCapability(role, 'patients:read')) main += `<a href="/" title="Monitor" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'dash' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📊</span><span class="sidebar-hide">Monitor</span></a>\n`;
    if (roleHasCapability(role, 'export:read')) main += `<a href="/export" title="Report" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'export' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📥</span><span class="sidebar-hide">Report</span></a>\n`;
    
    if (roleHasCapability(role, 'devices:write')) main += `<a href="/devices-mgmt" title="Devices" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'devs' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📟</span><span class="sidebar-hide">Devices</span></a>\n`;
    if (roleHasCapability(role, 'patients:write')) main += `<a href="/patients-mgmt" title="Patients" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'pats' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">👥</span><span class="sidebar-hide">Patients</span></a>\n`;
    if (roleHasCapability(role, 'pairing:write')) main += `<a href="/matching" title="Pairing" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'match' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">⌚</span><span class="sidebar-hide">Pairing</span></a>\n`;
    
    if (roleHasCapability(role, 'users:manage:ward') || roleHasCapability(role, 'users:manage:all')) main += `<a href="/users-mgmt" title="Users" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'users' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">🛡️</span><span class="sidebar-hide">Users</span></a>\n`;

    alerts += `<a href="/notification-settings" title="Notification" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'notif' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📱</span><span class="sidebar-hide">Notification</span></a>\n`;
    
    if (roleHasCapability(role, 'alerts:settings:write')) alerts += `<a href="/alert-settings" title="Alert Settings" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'alert' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">🔔</span><span class="sidebar-hide">Alert Settings</span></a>\n`;
    if (roleHasCapability(role, 'alerts:read')) alerts += `<a href="/alert-history" title="Alert History" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'ahist' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📋</span><span class="sidebar-hide">Alert History</span></a>\n`;
    
    if (roleHasCapability(role, 'wards:manage')) alerts += `<a href="/wards-mgmt" title="Wards" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'wards' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">🏥</span><span class="sidebar-hide">Wards</span></a>\n`;
    if (roleHasCapability(role, 'audit:read:all') || roleHasCapability(role, 'audit:read:ward')) alerts += `<a href="/audit-log" title="Audit Log" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active === 'audit' ? '' : 'color: var(--text-secondary);'}"><span class="nav-icon text-sm">📜</span><span class="sidebar-hide">Audit Log</span></a>\n`;
    
    return { main, alerts };
}

function ui(user, active, content, script = "") {
    const navs = renderNavLinks(user, active);
    return `
<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>NurseAid PRO</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>
    <link href="https://fonts.googleapis.com/css2?family=Prompt:wght@300;400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            /* Light Theme (Default) */
            --bg-primary: #f0f4f8;
            --bg-secondary: #ffffff;
            --bg-sidebar: #ffffff;
            --bg-card: #ffffff;
            --bg-card-hover: #f8fafc;
            --bg-table-header: #f1f5f9;
            --bg-table-row: #ffffff;
            --bg-table-row-alt: #f8fafc;
            --bg-input: #f1f5f9;
            --bg-input-focus: #ffffff;
            --bg-badge: #e2e8f0;
            --bg-tooltip: #1e293b;
            --bg-scrollbar: rgba(0,0,0,0.1);
            --bg-toggle: #cbd5e1;
            --bg-toggle-knob: #ffffff;
            --bg-vital: #f8fafc;
            --bg-sidebar-info: #f8fafc;
            --bg-chart-area: rgba(59, 130, 246, 0.05);
            --bg-modal: rgba(0, 0, 0, 0.4);

            --text-primary: #1e293b;
            --text-secondary: #475569;
            --text-tertiary: #94a3b8;
            --text-muted: #cbd5e1;
            --text-inverse: #ffffff;
            --text-badge: #64748b;
            --text-vital: #334155;
            --text-vital-muted: #94a3b8;
            --text-heading: #0f172a;

            --border-color: #e2e8f0;
            --border-light: #f1f5f9;
            --border-focus: #3b82f6;
            --border-card: #e2e8f0;

            --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
            --shadow-md: 0 4px 6px -1px rgba(0,0,0,0.07), 0 2px 4px -1px rgba(0,0,0,0.03);
            --shadow-lg: 0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -2px rgba(0,0,0,0.03);
            --shadow-xl: 0 20px 25px -5px rgba(0,0,0,0.08), 0 10px 10px -5px rgba(0,0,0,0.02);

            --accent-primary: #3b82f6;
            --accent-primary-light: #60a5fa;
            --accent-green: #22c55e;
            --accent-yellow: #eab308;
            --accent-red: #ef4444;
            --accent-amber: #f59e0b;
            --accent-secondary: #8b5cf6;
            --accent-red-light: #fecaca;
            --accent-green-light: #bbf7d0;
            --bg-card-paired: #eff6ff;
            --border-card-paired: #bfdbfe;
        }

        [data-theme="dark"] {
            /* Dark Theme - High Contrast & Clear Layers */
            --bg-primary: #010409;
            --bg-secondary: #0d1117;
            --bg-sidebar: #010409;
            --bg-card: #161b22;
            --bg-card-hover: #1c2128;
            --bg-table-header: #010409;
            --bg-table-row: #161b22;
            --bg-table-row-alt: #111827;
            --bg-input: #1c2128;
            --bg-input-focus: #1c2128;
            --bg-badge: #1f2a37;
            --bg-tooltip: #374151;
            --bg-scrollbar: rgba(255,255,255,0.08);
            --bg-toggle: #1f5a9f;
            --bg-toggle-knob: #e2e8f0;
            --bg-vital: #1c2128;
            --bg-sidebar-info: #0d1117;
            --bg-chart-area: rgba(88, 166, 255, 0.08);
            --bg-modal: rgba(0, 0, 0, 0.8);

            --text-primary: #f0f6fc;
            --text-secondary: #c9d1d9;
            --text-tertiary: #8b949e;
            --text-muted: #484f58;
            --text-inverse: #0d1117;
            --text-badge: #8b949e;
            --text-vital: #f0f6fc;
            --text-vital-muted: #8b949e;
            --text-heading: #f0f6fc;

            --border-color: #30363d;
            --border-light: #21262d;
            --border-focus: #58a6ff;
            --border-card: #30363d;
            --border-strong: #484f58;

            --shadow-sm: 0 1px 3px rgba(0,0,0,0.5);
            --shadow-md: 0 4px 8px rgba(0,0,0,0.5);
            --shadow-lg: 0 10px 15px rgba(0,0,0,0.6);
            --shadow-xl: 0 20px 25px rgba(0,0,0,0.7);

            --accent-primary: #58a6ff;
            --accent-primary-light: #79c0ff;
            --accent-green: #3fb950;
            --accent-yellow: #d29922;
            --accent-red: #f85149;
            --accent-amber: #d29922;
            --accent-secondary: #bc8cff;
            --accent-red-light: rgba(248, 81, 73, 0.15);
            --accent-green-light: rgba(63, 185, 80, 0.15);
            --bg-card-paired: #0d1a2a;
            --border-card-paired: #1c3a5f;
        }

        html {
            transition: background-color 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        body {
            font-family: 'Prompt', sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            transition: background-color 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                        color 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes criticalFlash {
            0% { background-color: #ffffff; }
            50% { background-color: #fee2e2; }
            100% { background-color: #ffffff; }
        }
        @keyframes warningFlash {
            0% { background-color: #ffffff; }
            50% { background-color: #fef08a; }
            100% { background-color: #ffffff; }
        }

        /* Table header theme */
        th {
            background: var(--bg-table-header);
            color: var(--text-secondary);
            border-color: var(--border-color);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        td {
            color: var(--text-primary);
            border-color: var(--border-color);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Input theme */
        input, select {
            background: var(--bg-input);
            color: var(--text-primary);
            border-color: var(--border-color);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        input:focus, select:focus {
            background: var(--bg-input-focus);
            border-color: var(--border-focus);
            box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
        }
        input::placeholder, select::placeholder {
            color: var(--text-tertiary);
            opacity: 1;
        }
        /* Dark mode select options */
        select option {
            background: var(--bg-card);
            color: var(--text-primary);
        }
        /* Dark mode specific input enhancements */
        [data-theme="dark"] input,
        [data-theme="dark"] select {
            background: var(--bg-input) !important;
            color: var(--text-primary) !important;
            border-color: var(--border-strong) !important;
            box-shadow: inset 0 1px 2px rgba(0,0,0,0.3);
        }
        [data-theme="dark"] input::placeholder,
        [data-theme="dark"] select::placeholder {
            color: var(--text-tertiary) !important;
        }
        [data-theme="dark"] input:focus,
        [data-theme="dark"] select:focus {
            background: var(--bg-input-focus) !important;
            border-color: var(--border-focus) !important;
            box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.25), inset 0 1px 2px rgba(0,0,0,0.3) !important;
        }

        /* Sidebar nav links */
        .nav-link {
            color: var(--text-primary);
            background-color: transparent;
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .nav-link:hover {
            background-color: var(--bg-card-hover);
        }

        .app-version {
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.45rem;
            margin-top: 0.75rem;
            padding-top: 0.75rem;
            border-top: 1px solid var(--border-color);
            color: var(--text-tertiary);
            font-size: 0.55rem;
            font-weight: 600;
            letter-spacing: 0.08em;
            line-height: 1;
            text-transform: uppercase;
            white-space: nowrap;
        }

        .app-version-badge {
            display: inline-flex;
            align-items: center;
            min-height: 1.25rem;
            padding: 0.2rem 0.45rem;
            border: 1px solid var(--border-color);
            border-radius: 999px;
            background: var(--bg-badge);
            color: var(--text-secondary);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            font-size: 0.6rem;
            font-weight: 700;
            letter-spacing: 0.02em;
            text-transform: none;
        }

        /* Info box in sidebar */
        .sidebar-info-box {
            background: var(--bg-sidebar-info);
            border-color: var(--border-color);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Vital stat cards */
        .vital-card {
            background: var(--bg-vital);
            color: var(--text-vital);
            transition: all 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Chart area background */
        .chart-area-fill {
            fill: var(--bg-chart-area);
        }

        /* Modal overlay theme */
        .modal {
            background: var(--bg-modal);
            transition: background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }
        [data-theme="light"] .modal {
            background: var(--bg-modal);
        }

        /* Panel overlay theme */
        .panel-overlay {
            background: rgba(0, 0, 0, 0.5);
            transition: background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Trend cards theme */
        .trend-card {
            background: var(--bg-card);
            border: 1px solid var(--border-card);
            box-shadow: var(--shadow-sm);
            transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .trend-card:hover {
            box-shadow: var(--shadow-md);
            border-color: var(--border-strong);
        }

        /* Global alert banner */
        #global-alert {
            transition: all 0.3s ease;
        }

        /* Smooth transition for all elements */
        *, *::before, *::after {
            transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Elements that should have slower, smoother transitions */
        body,
        .card,
        .nav-link,
        th, td,
        input, select,
        #sidebar,
        #appMain,
        .modal,
        .panel-overlay,
        #sidePanel,
        .trend-card {
            transition: background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        border-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        box-shadow 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }

        /* Faster transitions for interactive states */
        button,
        a,
        .theme-toggle-switch,
        input,
        select {
            transition: background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        border-color 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        color 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        box-shadow 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .critical-card { animation: criticalFlash 1s infinite; border: 2px solid #dc2626 !important; }
        .warning-card { animation: warningFlash 1.5s infinite; border: 2px solid #eab308 !important; }

        /* Theme transition for cards */
        .card {
            background: var(--bg-card);
            border-color: var(--border-color);
            transition: all 0.3s ease;
        }

        .critical-banner { background: #dc2626; color: white; font-weight: 900; text-align: center; padding: 6px; font-size: 12px; letter-spacing: 1px; margin-bottom: 10px; border-radius: 6px; }
        .warning-banner { background: #eab308; color: #713f12; font-weight: 900; text-align: center; padding: 6px; font-size: 12px; letter-spacing: 1px; margin-bottom: 10px; border-radius: 6px; }

        .nav-active { background: var(--accent-primary); color: var(--text-inverse); border-radius: 0.75rem; box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.3); }
        .modal { display: none; position: fixed; inset: 0; z-index: 100; align-items: center; justify-content: center; backdrop-filter: blur(4px); }
        .card {
            border-radius: 1.25rem;
            border: 1px solid var(--border-card);
            background: var(--bg-card);
            box-shadow: var(--shadow-md);
            transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .card:hover {
            box-shadow: var(--shadow-lg);
            border-color: var(--border-strong);
        }
        th {
            font-size: 0.7rem;
            text-transform: uppercase;
            padding: 12px;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }
        td { padding: 12px; border-bottom: 1px solid var(--border-light); font-size: 0.85rem; }
        .admin-only { display: none !important; }
        body.is-admin .admin-only { display: block !important; }

        #sidebar {
            width: 13rem;
            min-width: 13rem;
            transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        padding 0.3s cubic-bezier(0.4, 0, 0.2, 1),
                        background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        border-color 0.6s cubic-bezier(0.4, 0, 0.2, 1);
            flex-shrink: 0;
            background: var(--bg-sidebar);
            border-right: 2px solid var(--border-color);
            box-shadow: 2px 0 10px rgba(0,0,0,0.4);
            height: 100vh;
            position: sticky;
            top: 0;
            overflow-y: auto;
        }

        #sidebar.collapsed {
            width: 4.5rem;
            min-width: 4.5rem;
            padding-left: 0.75rem;
            padding-right: 0.75rem;
        }

        #sidebar.collapsed .sidebar-hide {
            display: none !important;
        }

        #sidebar.collapsed .nav-link {
            justify-content: center;
            padding-left: 0.75rem;
            padding-right: 0.75rem;
        }

        /* Sidebar collapsed state theme */
        #sidebar.collapsed {
            box-shadow: 2px 0 10px rgba(0,0,0,0.5);
        }

        #sidebar.collapsed .nav-icon {
            margin: 0 auto;
            font-size: 1.1rem;
        }

        /* Theme Toggle Switch - Simple & Compact */
        .theme-toggle-container {
            display: flex;
            justify-content: center;
            margin: 0 auto 0.75rem auto;
            padding: 0.25rem 0;
        }

        .theme-toggle-switch {
            position: relative;
            width: 48px;
            height: 26px;
            border-radius: 13px;
            background: linear-gradient(135deg, var(--bg-toggle) 0%, var(--bg-toggle) 100%);
            cursor: pointer;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: inset 0 1px 3px rgba(0,0,0,0.15);
            overflow: hidden;
        }

        .theme-toggle-switch::before {
            content: '';
            position: absolute;
            top: 2px;
            left: 2px;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 1px 4px rgba(251, 191, 36, 0.3);
            z-index: 2;
        }

        .theme-toggle-switch::after {
            content: '☀';
            position: absolute;
            top: 50%;
            left: 5px;
            transform: translateY(-50%);
            font-size: 12px;
            font-weight: bold;
            transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 1;
            filter: drop-shadow(0 1px 1px rgba(0,0,0,0.2));
        }

        [data-theme="dark"] .theme-toggle-switch {
            background: linear-gradient(135deg, #1e3a5f 0%, #2d4a6f 100%);
            box-shadow: inset 0 1px 3px rgba(0,0,0,0.3), 0 0 8px rgba(96, 165, 250, 0.15);
        }

        [data-theme="dark"] .theme-toggle-switch::before {
            left: 24px;
            background: linear-gradient(135deg, #e2e8f0 0%, #cbd5e1 100%);
            box-shadow: 0 1px 4px rgba(0,0,0,0.3);
        }

        [data-theme="dark"] .theme-toggle-switch::after {
            content: '☾';
            left: 5px;
            opacity: 0.3;
        }

        .theme-toggle-switch:hover::before {
            transform: scale(1.05);
        }

        #sidebarToggle {
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            background: var(--bg-badge);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
        }
        #sidebarToggle:hover {
            background: var(--accent-primary);
            color: var(--text-inverse);
            border-color: var(--accent-primary);
        }

        #sidebar.collapsed #sidebarToggle {
            margin-left: auto;
            margin-right: auto;
        }

        body.is-admin .admin-only.nav-link {
            display: flex !important;
        }

        #appMain {
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            color: var(--text-primary);
            background: var(--bg-primary);
            min-width: 0;
        }

        html, body {
            max-width: 100%;
            overflow-x: hidden;
        }

        button, a, input, select, textarea {
            touch-action: manipulation;
        }

        table {
            width: 100%;
            border-collapse: collapse;
        }

        .card:has(> table) {
            overflow-x: auto !important;
            -webkit-overflow-scrolling: touch;
        }

        #mobileHeader, #sidebarBackdrop {
            display: none;
        }

        /* Dashboard grid background for dark mode */
        .monitor-grid-auto {
            background: transparent;
        }

        @media (max-width: 768px) {
            body {
                flex-direction: column;
            }

            #sidebar {
                position: fixed;
                inset: 0 auto 0 0;
                width: min(19rem, 86vw);
                min-width: 0;
                height: 100dvh;
                max-height: none;
                overflow-y: auto;
                padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom));
                transform: translateX(-105%);
                transition: transform 0.25s ease, background-color 0.6s ease;
                box-shadow: 12px 0 30px rgba(0,0,0,0.22);
                z-index: 1200;
            }

            #sidebar.mobile-open {
                transform: translateX(0);
            }

            #sidebar.collapsed {
                width: min(19rem, 86vw);
                min-width: 0;
                padding-left: 1rem;
                padding-right: 1rem;
            }

            #sidebar.collapsed .sidebar-hide { display: initial !important; }
            #sidebar.collapsed .nav-link {
                justify-content: flex-start;
            }

            #sidebar.collapsed .nav-icon { margin: 0; }

            #sidebarToggle { display: none; }

            #mobileHeader {
                display: flex;
                position: sticky;
                top: 0;
                z-index: 900;
                min-height: 3.75rem;
                padding: max(0.6rem, env(safe-area-inset-top)) 1rem 0.6rem;
                align-items: center;
                justify-content: space-between;
                gap: 0.75rem;
                background: var(--bg-sidebar);
                border-bottom: 1px solid var(--border-color);
                box-shadow: var(--shadow-sm);
            }

            #mobileMenuButton, #mobileThemeButton {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 2.75rem;
                height: 2.75rem;
                flex: 0 0 2.75rem;
                border-radius: 0.75rem;
                background: var(--bg-badge);
                color: var(--text-primary);
                border: 1px solid var(--border-color);
                font-size: 1.2rem;
            }

            #sidebarBackdrop {
                position: fixed;
                inset: 0;
                z-index: 1100;
                background: rgba(15, 23, 42, 0.55);
                backdrop-filter: blur(2px);
            }

            #sidebarBackdrop.active { display: block; }

            #appMain {
                width: 100%;
                padding: 1rem !important;
                padding-bottom: max(1.25rem, env(safe-area-inset-bottom)) !important;
                overflow-x: hidden;
            }

            #appMain > h2, #appMain > div > h2 {
                font-size: 1.25rem !important;
                margin-bottom: 1.25rem !important;
            }

            #appMain .gap-8 { gap: 1rem !important; }
            #appMain .gap-6 { gap: 0.875rem !important; }
            #appMain .p-8 { padding: 1rem !important; }
            #appMain .p-6 { padding: 1rem !important; }

            .card { border-radius: 1rem; }

            .card:has(> table) {
                border-radius: 1rem;
            }

            .card > table, .card table {
                min-width: 38rem;
            }

            th, td {
                padding: 0.7rem 0.65rem;
                white-space: nowrap;
            }

            input, select, textarea {
                max-width: 100%;
                font-size: 16px !important;
            }

            .modal {
                align-items: flex-end;
                padding: 0.75rem;
                padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
            }

            .modal > div {
                max-height: calc(100dvh - 1.5rem - env(safe-area-inset-bottom));
                overflow-y: auto;
                padding: 1.25rem !important;
                border-radius: 1.25rem !important;
            }

            #modalTitle { margin-bottom: 1rem !important; }
            #globalModal #modalBody + div { margin-top: 1.25rem !important; }

            #sidePanel {
                height: 100dvh;
                padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)) !important;
            }

            #sidePanel .panel-compact-header { align-items: flex-start; }
            #sidePanel .panel-compact-header > div { padding-right: 0.5rem; }

            .dashboard-topbar {
                align-items: flex-start !important;
                flex-direction: column;
            }

            .dashboard-topbar > div:last-child {
                width: 100%;
                display: grid;
                grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr);
            }

            .dashboard-sync {
                min-width: 0;
                padding: 0.45rem 0.55rem !important;
                text-align: center;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }

            #appMain .grid.grid-cols-2:not(.dashboard-topbar *) {
                grid-template-columns: 1fr !important;
            }

            #monitor-grid .grid.grid-cols-3 {
                grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
            }

            #monitor-grid .grid.grid-cols-3 p.text-3xl {
                font-size: clamp(1.25rem, 7vw, 1.55rem) !important;
            }

            .theme-toggle-container { margin-bottom: 0.5rem; }
            .nav-link { min-height: 2.75rem; }
        }

        body.trend-panel-open {
            overflow: hidden;
        }

        #sidePanel {
            position: fixed;
            top: 1rem;
            right: -1650px;
            width: min(1560px, calc(100vw - 2rem));
            height: calc(100dvh - 2rem);
            display: flex;
            flex-direction: column;
            z-index: 1000;
            transition: right 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                        background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        box-shadow 0.5s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: -18px 0 55px rgba(15, 23, 42, 0.34), 0 20px 55px rgba(15, 23, 42, 0.22);
            padding: 1.5rem;
            overflow: hidden;
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 1.5rem;
            color: var(--text-primary);
        }
        #sidePanel.active { right: 1rem; }
        .panel-overlay {
            position: fixed; inset: 0; background: rgba(15, 23, 42, 0.62);
            z-index: 999; display: none; backdrop-filter: blur(7px);
        }
        @media (max-width: 800px) { #sidePanel { width: 100%; right: -100%; } }
        @media (min-width: 801px) { #sidePanel { width: min(1560px, calc(100vw - 2rem)); } }

        .dashboard-topbar {
            margin-bottom: 0.75rem !important;
        }

        .dashboard-title {
            font-size: 1.15rem !important;
            letter-spacing: 0.02em;
        }

        .dashboard-subtitle {
            font-size: 0.58rem !important;
        }

        .dashboard-sync {
            padding: 0.45rem 0.8rem !important;
            font-size: 0.62rem !important;
        }

        #global-alert {
            padding: 0.55rem 0.75rem !important;
            margin-bottom: 0.75rem !important;
            border-radius: 0.9rem !important;
            font-size: 0.9rem !important;
            line-height: 1.1 !important;
        }

        .monitor-grid-layout {
            display: grid !important;
            grid-template-columns: repeat(auto-fill, minmax(285px, 1fr)) !important;
            gap: 0.75rem !important;
            align-items: start !important;
        }

        @media (min-width: 1800px) {
            .monitor-grid-layout {
                grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)) !important;
            }
        }

        @media (min-width: 2500px) {
            .monitor-grid-layout {
                grid-template-columns: repeat(auto-fill, minmax(255px, 1fr)) !important;
            }
        }

        #monitor-grid > .card {
            padding: 0.75rem !important;
            border-top-width: 0 !important;
            border-left-width: 4px !important;
            border-radius: 1rem !important;
        }

        #monitor-grid > .card > div:first-child {
            margin-bottom: 0.55rem !important;
            padding-bottom: 0.45rem !important;
        }

        #monitor-grid h4 {
            font-size: 0.82rem !important;
            line-height: 1.1 !important;
        }

        #monitor-grid .grid.grid-cols-3 {
            gap: 0.35rem !important;
        }

        #monitor-grid .grid.grid-cols-3 > div {
            padding: 0.45rem 0.35rem !important;
            border-radius: 0.75rem !important;
        }

        #monitor-grid .grid.grid-cols-3 p.text-3xl {
            font-size: 1.55rem !important;
            line-height: 1.05 !important;
        }

        #monitor-grid .grid.grid-cols-3 p.text-\\[8px\\] {
            font-size: 0.48rem !important;
        }

        @media (max-width: 640px) {
            .monitor-grid-layout {
                grid-template-columns: 1fr !important;
            }

            .dashboard-subtitle {
                display: none !important;
            }
        }

        #sidePanel {
            padding: 1.5rem !important;
        }

        #sidePanel .panel-compact-header {
            position: relative;
            flex: 0 0 auto;
            margin-bottom: 0.75rem !important;
            padding: 0.1rem 0.15rem 0.75rem;
            border-bottom: 1px solid var(--border-color);
        }

        #sidePanel #p-title {
            font-size: clamp(1.35rem, 2vw, 1.85rem) !important;
            line-height: 1.25 !important;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: min(920px, calc(100vw - 8rem));
            letter-spacing: -0.02em;
        }

        #sidePanel .panel-kicker {
            margin-bottom: 0.2rem;
            color: var(--text-tertiary);
            font-size: 0.66rem;
            font-weight: 700;
            letter-spacing: 0.18em;
        }

        #sidePanel .panel-close-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2.85rem;
            height: 2.85rem;
            flex: 0 0 2.85rem;
            border-radius: 0.9rem;
            font-size: 1.15rem;
            box-shadow: var(--shadow-sm);
        }

        #sidePanel .panel-close-btn:hover {
            color: var(--text-primary) !important;
            border-color: var(--accent-primary) !important;
            transform: translateY(-1px);
        }

        #sidePanel .panel-header-actions {
            display: flex;
            flex: 0 0 auto;
            align-items: center;
            gap: 0.5rem;
        }

        #sidePanel .panel-settings-btn {
            display: inline-flex;
            min-height: 2.85rem;
            align-items: center;
            justify-content: center;
            gap: 0.4rem;
            padding: 0.55rem 0.8rem;
            border: 1px solid var(--border-color);
            border-radius: 0.9rem;
            background: var(--bg-badge);
            color: var(--text-secondary);
            font-size: 0.7rem;
            font-weight: 700;
        }

        #sidePanel .panel-settings-btn:hover {
            border-color: var(--accent-primary);
            color: var(--accent-primary);
            transform: translateY(-1px);
        }

        #sidePanel .panel-meta-row {
            display: flex !important;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.5rem;
            margin-top: 0.55rem;
        }

        #sidePanel #p-hn,
        #sidePanel #trend-range-label,
        #sidePanel #panel-export-btn {
            min-height: 2rem;
            display: inline-flex;
            align-items: center;
        }

        #sidePanel #p-hn {
            padding: 0.35rem 0.75rem;
            border-radius: 9999px;
            background: color-mix(in srgb, var(--accent-primary) 12%, transparent);
            border: 1px solid color-mix(in srgb, var(--accent-primary) 32%, transparent);
        }

        #sidePanel #panel-export-btn:hover {
            filter: brightness(1.06);
            transform: translateY(-1px);
            box-shadow: var(--shadow-md);
        }

        #sidePanel .trend-range-control {
            display: inline-flex;
            align-items: center;
            gap: 0.45rem;
            min-height: 2rem;
            padding: 0.18rem 0.28rem 0.18rem 0.7rem;
            border-radius: 9999px;
            background: var(--bg-input);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
        }

        #sidePanel #trend-range {
            min-width: 6rem;
            padding: 0.3rem 1.55rem 0.3rem 0.55rem;
            border: 0;
            border-radius: 9999px;
            font-size: 0.72rem;
            font-weight: 700;
            line-height: 1.25;
            background: var(--bg-card);
            color: var(--text-primary);
        }

        #sidePanel #trend-range:focus {
            outline: 2px solid var(--accent-primary);
            outline-offset: 1px;
            box-shadow: none;
        }

        #sidePanel #panel-trend-status {
            padding: 0.65rem 0.85rem;
            border-radius: 0.8rem;
            font-size: 0.78rem;
            font-weight: 600;
            text-align: center;
            background: var(--bg-badge);
            color: var(--text-secondary);
            border: 1px solid var(--border-color);
        }

        #sidePanel .trend-grid {
            position: relative;
            display: grid !important;
            flex: 1 1 auto;
            min-height: 0;
            grid-template-columns: minmax(0, 1fr) !important;
            grid-template-rows: repeat(3, minmax(0, 1fr));
            gap: 0.7rem !important;
        }

        #sidePanel .trend-card {
            position: relative;
            display: flex;
            min-height: 0;
            flex-direction: column;
            overflow: hidden;
            padding: 0.7rem 1rem 0.8rem !important;
            border-radius: 1rem !important;
            box-shadow: var(--shadow-sm);
        }

        #sidePanel .trend-card::before {
            content: '';
            position: absolute;
            inset: 0 auto 0 0;
            width: 4px;
            background: var(--trend-color, var(--accent-primary));
        }

        #sidePanel .trend-card--hr { --trend-color: #ef4444; }
        #sidePanel .trend-card--spo2 { --trend-color: #3b82f6; }
        #sidePanel .trend-card--temp { --trend-color: #f97316; }

        #sidePanel .trend-card:hover {
            border-color: color-mix(in srgb, var(--trend-color) 38%, var(--border-color));
            box-shadow: var(--shadow-md);
        }

        #sidePanel .trend-card-head {
            flex: 0 0 auto;
            gap: 0.75rem;
            margin-bottom: 0.35rem !important;
        }

        #sidePanel .trend-title-group {
            display: flex;
            min-width: 0;
            align-items: center;
            gap: 0.65rem;
        }

        #sidePanel .trend-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 2rem;
            height: 2rem;
            flex: 0 0 2rem;
            border-radius: 0.65rem;
            background: color-mix(in srgb, var(--trend-color) 12%, transparent);
        }

        #sidePanel .trend-card-subtitle {
            display: block;
            margin-top: 0.08rem;
            color: var(--text-tertiary);
            font-size: 0.66rem;
            font-weight: 500;
            letter-spacing: 0.02em;
        }

        #sidePanel .trend-chart {
            flex: 1 1 0;
            height: auto !important;
            min-height: 0;
            min-width: 0;
        }

        #sidePanel .trend-chart canvas {
            display: block;
            max-width: 100%;
            max-height: 100%;
        }

        #sidePanel .trend-card-head p {
            font-size: 0.82rem !important;
        }

        #sidePanel .trend-card-head span {
            font-size: 0.72rem !important;
        }

        #sidePanel .trend-summary {
            flex: 0 0 auto;
            padding: 0.35rem 0.65rem;
            border-radius: 9999px;
            background: var(--bg-badge);
            border: 1px solid var(--border-color);
            color: var(--text-secondary) !important;
            font-weight: 700;
        }

        #sidePanel #panel-trend-status {
            position: absolute;
            z-index: 5;
            top: 0.4rem;
            left: 50%;
            width: min(32rem, calc(100% - 2rem));
            transform: translateX(-50%);
            box-shadow: var(--shadow-lg);
        }

        .range-settings-hero {
            position: relative;
            overflow: hidden;
            background: linear-gradient(135deg,
                color-mix(in srgb, var(--accent-primary) 12%, var(--bg-card)),
                var(--bg-card) 46%,
                color-mix(in srgb, var(--accent-green) 7%, var(--bg-card)));
        }

        .range-settings-hero::after {
            content: '';
            position: absolute;
            top: -5rem;
            right: -4rem;
            width: 13rem;
            height: 13rem;
            border-radius: 9999px;
            background: color-mix(in srgb, var(--accent-primary) 9%, transparent);
            pointer-events: none;
        }

        .range-metric-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 0.8rem;
        }

        .range-metric-card {
            position: relative;
            z-index: 1;
            padding: 1rem;
            border: 1px solid var(--border-color);
            border-left: 4px solid var(--metric-color, var(--accent-primary));
            border-radius: 1rem;
            background: color-mix(in srgb, var(--bg-vital) 88%, transparent);
        }

        .range-metric-card--hr { --metric-color: #ef4444; }
        .range-metric-card--spo2 { --metric-color: #3b82f6; }
        .range-metric-card--temp { --metric-color: #f97316; }

        .range-input-row {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(5.2rem, 0.78fr) minmax(0, 1fr);
            align-items: end;
            gap: 0.55rem;
            margin-top: 0.75rem;
        }

        .range-input-row--single {
            grid-template-columns: minmax(0, 1fr) minmax(7.5rem, 1fr);
        }

        .range-tier-stack {
            display: grid;
            gap: 0.48rem;
            margin-top: 0.7rem;
        }

        .range-tier-row {
            display: grid;
            grid-template-columns: 4.6rem minmax(0, 1fr) minmax(0, 1fr);
            align-items: end;
            gap: 0.45rem;
            padding: 0.48rem;
            border-radius: 0.8rem;
        }

        .range-tier-row--single {
            grid-template-columns: 4.6rem minmax(0, 1fr);
        }

        .range-tier-row--warning {
            background: color-mix(in srgb, var(--accent-yellow) 10%, transparent);
            border: 1px solid color-mix(in srgb, var(--accent-yellow) 30%, var(--border-color));
        }

        .range-tier-row--critical {
            background: color-mix(in srgb, var(--accent-red) 8%, transparent);
            border: 1px solid color-mix(in srgb, var(--accent-red) 25%, var(--border-color));
        }

        .range-tier-label {
            align-self: center;
            font-size: 0.58rem;
            font-weight: 900;
            letter-spacing: 0.04em;
        }

        .range-tier-row--warning .range-tier-label { color: var(--accent-yellow); }
        .range-tier-row--critical .range-tier-label { color: var(--accent-red); }

        .range-normal-preview {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            min-height: 2.25rem;
            padding: 0.45rem 0.65rem;
            border: 1px dashed color-mix(in srgb, var(--accent-green) 48%, var(--border-color));
            border-radius: 0.75rem;
            background: color-mix(in srgb, var(--accent-green) 9%, transparent);
            color: var(--accent-green);
            font-size: 0.64rem;
            font-weight: 900;
        }

        .range-normal-preview strong {
            color: var(--text-primary);
            font-size: 0.74rem;
        }

        .range-field label {
            display: block;
            margin-bottom: 0.25rem;
            color: var(--text-tertiary);
            font-size: 0.62rem;
            font-weight: 700;
        }

        .range-field input {
            width: 100%;
            min-height: 2.65rem;
            padding: 0.55rem 0.65rem;
            border: 1px solid var(--border-color);
            border-radius: 0.75rem;
            font-size: 0.88rem;
            font-weight: 700;
            text-align: center;
        }

        .range-midpoint {
            min-height: 2.65rem;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 0.35rem;
            border: 1px dashed color-mix(in srgb, var(--accent-green) 48%, var(--border-color));
            border-radius: 0.75rem;
            background: color-mix(in srgb, var(--accent-green) 9%, transparent);
            color: var(--text-secondary);
            text-align: center;
        }

        .range-midpoint span { font-size: 0.55rem; font-weight: 600; }
        .range-midpoint strong { color: var(--accent-green); font-size: 0.82rem; }

        .range-patient-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
            gap: 0.8rem;
        }

        .range-patient-card {
            padding: 1rem !important;
            border-radius: 1rem !important;
        }

        .range-patient-values {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 0.45rem;
        }

        .range-patient-value {
            padding: 0.55rem 0.45rem;
            border-radius: 0.7rem;
            background: var(--bg-vital);
            border: 1px solid var(--border-light);
            text-align: center;
        }

        .range-patient-value span {
            display: block;
            color: var(--text-tertiary);
            font-size: 0.56rem;
            font-weight: 700;
        }

        .range-patient-value strong {
            color: var(--text-primary);
            font-size: 0.72rem;
        }

        @media (max-height: 850px) {
            #sidePanel .trend-card {
                padding: 0.55rem 0.85rem 0.6rem !important;
            }

            #sidePanel {
                padding: 0.85rem !important;
            }

            #sidePanel .panel-compact-header {
                margin-bottom: 0.55rem !important;
                padding-bottom: 0.55rem;
            }
        }

        body.is-admin td.admin-only { display: table-cell !important; }
        body.is-admin th.admin-only { display: table-cell !important; }
        body.is-admin div.admin-only { display: block !important; }

        @media (max-width: 768px) {
            #sidePanel {
                top: 0;
                width: 100% !important;
                right: -100%;
                height: 100dvh;
                padding: max(0.7rem, env(safe-area-inset-top)) 0.75rem max(0.7rem, env(safe-area-inset-bottom)) !important;
                border-width: 0;
                border-radius: 0;
            }

            #sidePanel.active { right: 0; }
            #sidePanel .panel-compact-header {
                margin-bottom: 0.55rem !important;
                padding: 0 0 0.5rem;
            }
            #sidePanel .panel-kicker { display: none; }
            #sidePanel #p-title {
                max-width: calc(100vw - 4.5rem);
                font-size: 1.15rem !important;
            }
            #sidePanel .panel-close-btn {
                width: 2.5rem;
                height: 2.5rem;
                flex-basis: 2.5rem;
            }
            #sidePanel .panel-settings-btn {
                width: 2.5rem;
                min-height: 2.5rem;
                padding: 0;
            }
            #sidePanel .panel-settings-label { display: none; }
            #sidePanel .panel-meta-row {
                flex-wrap: nowrap;
                gap: 0.3rem;
                margin-top: 0.4rem;
            }
            #sidePanel #p-hn {
                min-width: 0;
                padding: 0.25rem 0.55rem;
                overflow: hidden;
                font-size: 0.68rem;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            #sidePanel #trend-range-label { display: none !important; }
            #sidePanel #panel-export-btn {
                min-width: 3.5rem;
                padding: 0.3rem 0.55rem !important;
                font-size: 0 !important;
                justify-content: center;
            }
            #sidePanel #panel-export-btn::after {
                content: '⬇ CSV';
                font-size: 0.66rem;
            }

            .range-tier-row {
                grid-template-columns: 4.15rem minmax(0, 1fr) minmax(0, 1fr);
                gap: 0.35rem;
                padding: 0.4rem;
            }

            .range-tier-row--single {
                grid-template-columns: 4.15rem minmax(0, 1fr);
            }
            #sidePanel .trend-range-control {
                min-width: 0;
                flex: 1 1 auto;
                padding: 0.15rem 0.2rem;
            }
            #sidePanel .trend-range-control > span { display: none; }
            #sidePanel #trend-range {
                width: 100%;
                min-width: 0;
                padding: 0.2rem 1.35rem 0.2rem 0.45rem;
                font-size: 0.7rem !important;
            }
            #sidePanel .trend-grid { gap: 0.45rem !important; }
            #sidePanel .trend-card {
                padding: 0.45rem 0.65rem 0.5rem !important;
                border-radius: 0.85rem !important;
            }
            #sidePanel .trend-card-head {
                align-items: stretch;
                flex-direction: column;
                gap: 0.25rem;
                margin-bottom: 0.2rem !important;
            }
            #sidePanel .trend-title-group { width: 100%; }
            #sidePanel .trend-icon {
                width: 1.65rem;
                height: 1.65rem;
                flex-basis: 1.65rem;
                border-radius: 0.5rem;
                font-size: 0.72rem;
            }
            #sidePanel .trend-card-head p { font-size: 0.72rem !important; }
            #sidePanel .trend-card-subtitle { font-size: 0.58rem !important; }
            #sidePanel .trend-summary {
                align-self: stretch;
                width: 100%;
                padding: 0.2rem 0.4rem;
                white-space: nowrap;
                text-align: center;
            }

            .device-address-row {
                flex-direction: column;
            }

            .device-address-row > input,
            .device-address-row > button {
                width: 100%;
                min-height: 2.75rem;
                justify-content: center;
            }

            #qr-scanner-modal > div { width: 100%; }

            #appMain .card > .flex.items-center.justify-between {
                align-items: flex-start;
                gap: 0.75rem;
                flex-wrap: wrap;
            }

            #appMain label.flex.items-center {
                min-height: 2.75rem;
            }

            #appMain button,
            .modal button,
            #sidePanel button:not(.panel-close-btn):not(#panel-export-btn) {
                min-height: 2.75rem;
            }

            #sidePanel .panel-close-btn { min-height: 2.5rem; }
            #sidePanel #panel-export-btn { min-height: 2rem; }

            .range-metric-grid { grid-template-columns: 1fr; }
            .range-patient-grid { grid-template-columns: 1fr; }
            .range-input-row { grid-template-columns: minmax(0, 1fr) minmax(4.7rem, 0.8fr) minmax(0, 1fr); }
            .range-input-row--single { grid-template-columns: minmax(0, 1fr) minmax(6.5rem, 1fr); }
        }

        @media (max-width: 768px) and (max-height: 700px) {
            #sidePanel .trend-card-subtitle { display: none; }
            #sidePanel .trend-card-head { flex-direction: row; align-items: center; }
            #sidePanel .trend-title-group { flex: 1 1 auto; width: auto; }
            #sidePanel .trend-summary {
                width: auto;
                flex: 0 0 auto;
                font-size: 0.58rem !important;
            }
        }

        @media (max-width: 374px) {
            #appMain { padding: 0.75rem !important; }
            .dashboard-title { font-size: 1rem !important; }
            #monitor-grid > .card { padding: 0.65rem !important; }
            #monitor-grid .grid.grid-cols-3 p.text-3xl { font-size: 1.2rem !important; }
            .modal { padding: 0.5rem; }
            .modal > div { padding: 1rem !important; }
        }

        #globalModal.modal--wide {
            z-index: 2100;
            padding: 1rem;
        }

        #globalModal.modal--wide > div {
            width: min(1180px, calc(100vw - 2rem));
            max-width: none !important;
            max-height: calc(100dvh - 2rem);
            display: flex;
            flex-direction: column;
            padding: 0 !important;
            overflow: hidden;
        }

        #globalModal.modal--wide #modalTitle {
            flex: 0 0 auto;
            margin: 0 !important;
            padding: 1rem 1.25rem;
            border-bottom: 1px solid var(--border-color);
        }

        #globalModal.modal--wide #modalBody {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            overscroll-behavior: contain;
            padding: 1rem 1.25rem;
        }

        #globalModal.modal--wide #modalBody + div {
            flex: 0 0 auto;
            margin: 0 !important;
            padding: 0.85rem 1.25rem 1rem;
            border-top: 1px solid var(--border-color);
            background: var(--bg-card);
        }

        .alert-settings-modal-grid {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 0.75rem;
        }

        .alert-settings-modal-grid > .range-metric-card {
            height: 100%;
            min-width: 0;
        }

        @media (max-width: 768px) {
            #globalModal.modal--wide {
                align-items: flex-end;
                padding: 0.5rem;
                padding-bottom: max(0.5rem, env(safe-area-inset-bottom));
            }

            #globalModal.modal--wide > div {
                width: 100%;
                max-height: calc(100dvh - 1rem - env(safe-area-inset-bottom));
                border-radius: 1.25rem !important;
            }

            #globalModal.modal--wide #modalTitle,
            #globalModal.modal--wide #modalBody,
            #globalModal.modal--wide #modalBody + div {
                padding-left: 1rem;
                padding-right: 1rem;
            }

            .alert-settings-modal-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body class="flex flex-col md:flex-row min-h-screen">
    <header id="mobileHeader">
        <button id="mobileMenuButton" type="button" onclick="openMobileMenu()" aria-label="เปิดเมนู" aria-controls="sidebar" aria-expanded="false">☰</button>
        <div class="min-w-0 text-center">
            <p class="font-black italic uppercase truncate" style="color: var(--accent-primary);">Nurse <span style="color: var(--text-primary);">Aid</span></p>
            <p class="text-[8px] font-bold uppercase tracking-widest" style="color: var(--text-tertiary);">Hospital System</p>
        </div>
        <button id="mobileThemeButton" type="button" onclick="toggleTheme()" aria-label="สลับโหมดสี" title="สลับโหมดสี">◐</button>
    </header>
    <div id="sidebarBackdrop" onclick="closeMobileMenu()" aria-hidden="true"></div>
    <aside id="sidebar" class="p-6 flex flex-col shadow-sm z-50" style="background: var(--bg-sidebar); border-right: 1px solid var(--border-color);">
        <div class="flex items-center justify-between mb-3 gap-2">
            <div class="text-center sidebar-hide min-w-0">
                <h1 class="text-xl font-black italic uppercase whitespace-nowrap" style="color: var(--accent-primary);">Nurse <span style="color: var(--text-primary);">Aid</span></h1>
                <p class="text-[8px] font-bold uppercase whitespace-nowrap" style="color: var(--text-tertiary); letter-spacing: 0.15em;">Hospital System</p>
            </div>

            <button id="sidebarToggle" onclick="toggleSidebar()" type="button"
                class="shrink-0 w-8 h-8 rounded-lg font-black"
                aria-label="Toggle sidebar" title="หุบเมนู">❮</button>
        </div>

        <!-- Theme Toggle Switch -->
        <div class="theme-toggle-container">
            <div id="themeToggle" class="theme-toggle-switch" onclick="toggleTheme()" title="สลับโหมดแสง/มืดย"></div>
        </div>

        <div class="sidebar-hide mb-4 p-3 rounded-xl text-xs" style="background: var(--bg-sidebar-info); border: 1px solid var(--border-color);">
            <p id="display-nurse" class="font-bold truncate" style="color: var(--text-primary);">Checking...</p>
            <p id="display-role" class="text-[8px] font-bold uppercase" style="color: var(--text-tertiary);"></p>
            <p id="display-ward" class="text-[9px] font-bold mt-1" style="color: var(--text-secondary);"></p>
        </div>

        <nav class="flex flex-col gap-1 flex-1">
            ${navs.main}
        </nav>

        <div class="sidebar-hide mt-4 pt-4 border-t" style="border-color: var(--border-color);">
            <p class="text-[8px] font-bold uppercase tracking-widest mb-2 px-2" style="color: var(--text-tertiary);">Alerts</p>
            ${navs.alerts}
        </div>

        <button onclick="logout()" title="Logout" class="nav-link font-bold p-2.5 border-t mt-3 rounded-lg transition-all flex items-center gap-2.5 text-xs" style="color: var(--accent-red); border-color: var(--border-color);">
            <span class="nav-icon text-sm">🚪</span><span class="sidebar-hide">Logout</span>
        </button>

        <div class="app-version sidebar-hide" aria-label="v2.14" title="v2.14">
            <span class="app-version-badge">v2.14</span>
        </div>
    </aside>

    <main id="appMain" class="flex-1 p-6 md:p-8 overflow-auto">${content}</main>
    <a id="siteAlertBanner" href="/alert-history" class="hidden fixed top-3 left-1/2 -translate-x-1/2 z-[100] bg-red-600 text-white px-5 py-3 rounded-xl shadow-2xl font-bold text-sm" role="alert" aria-live="assertive"></a>

        <div id="globalModal" class="modal"><div class="p-8 rounded-3xl w-full max-w-md shadow-2xl transition-all" style="background: var(--bg-card); border: 1px solid var(--border-color);"><h3 id="modalTitle" class="text-xl font-bold mb-6" style="color: var(--text-primary);"></h3><div id="modalBody" class="space-y-4"></div><div class="flex gap-3 mt-8"><button onclick="closeModal()" class="flex-1 p-3 rounded-xl font-bold" style="background: var(--bg-badge); color: var(--text-secondary); border: 1px solid var(--border-color);">ยกเลิก</button><button id="modalSubmit" class="flex-1 p-3 rounded-xl font-bold" style="background: var(--accent-primary); color: var(--text-inverse);">ตกลง</button></div></div></div>

    <div id="panelOverlay" class="panel-overlay" onclick="closePanel()"></div>
    <div id="sidePanel" style="background: var(--bg-card); border-left: 1px solid var(--border-color);">
        <div class="panel-compact-header flex justify-between items-start">
            <div class="min-w-0 pr-4">
                <p class="panel-kicker">VITAL SIGNS · TREND ANALYSIS</p>
                <h2 id="p-title" class="text-3xl font-black" style="color: var(--text-heading);">Trend</h2>
                <div class="panel-meta-row">
                    <span id="p-hn" class="text-sm font-bold tracking-widest" style="color: var(--accent-primary);"></span>
                    <button id="panel-export-btn" type="button"
                        class="text-[10px] px-3 py-1 rounded-full font-black uppercase shadow-sm transition-all"
                        style="background: var(--accent-primary); color: var(--text-inverse);">
                        ⬇ Export CSV 24h
                    </button>
                    <label class="trend-range-control text-[10px] font-bold" for="trend-range">
                        <span>ช่วงเวลา</span>
                        <select id="trend-range" onchange="changeTrendRange(this.value)" aria-label="เลือกช่วงเวลาของกราฟ">
                            <option value="1">1 ชม.</option>
                            <option value="6">6 ชม.</option>
                            <option value="12">12 ชม.</option>
                            <option value="24" selected>24 ชม.</option>
                            <option value="72">3 วัน</option>
                            <option value="168">7 วัน</option>
                        </select>
                    </label>
                    <span id="trend-range-label" class="text-[10px] px-3 py-1 rounded-full font-bold uppercase italic"
                        style="background: var(--bg-badge); color: var(--text-badge); border: 1px solid var(--border-color);">
                        ย้อนหลัง 24 ชั่วโมง
                    </span>
                </div>
            </div>
            <div class="panel-header-actions">
                <a href="/alert-settings" class="admin-only panel-settings-btn" aria-label="ตั้งค่าช่วงและการแจ้งเตือน" title="ตั้งค่าช่วงและการแจ้งเตือน">
                    <span aria-hidden="true">⚙️</span><span class="panel-settings-label">ตั้งค่าช่วง</span>
                </a>
                <button onclick="closePanel()" class="panel-close-btn p-2 transition-all" aria-label="ปิดหน้ากราฟ"
                    style="background: var(--bg-badge); color: var(--text-secondary); border: 1px solid var(--border-color);">✕</button>
            </div>
        </div>
        <div class="trend-grid grid grid-cols-1 gap-3">
            <div id="panel-trend-status" class="hidden" role="status" aria-live="polite"></div>
            <div class="trend-card trend-card--hr card p-4 shadow-sm" style="background: var(--bg-vital); border: 1px solid var(--border-color);">
                <div class="trend-card-head flex justify-between items-center mb-2">
                    <div class="trend-title-group">
                        <span class="trend-icon" aria-hidden="true">🫀</span>
                        <div>
                            <p class="text-xs font-bold uppercase" style="color: var(--accent-red);">Heart Rate</p>
                            <span id="limit-hr" class="trend-card-subtitle">ช่วงที่ตั้งไว้ · BPM</span>
                        </div>
                    </div>
                    <span id="avg-hr" class="trend-summary text-[10px] font-mono"></span>
                </div>
                <div class="trend-chart h-[145px]"><canvas id="chartHR_Panel"></canvas></div>
            </div>

            <div class="trend-card trend-card--spo2 card p-4 shadow-sm" style="background: var(--bg-vital); border: 1px solid var(--border-color);">
                <div class="trend-card-head flex justify-between items-center mb-2">
                    <div class="trend-title-group">
                        <span class="trend-icon" aria-hidden="true">💧</span>
                        <div>
                            <p class="text-xs font-bold uppercase" style="color: var(--accent-primary);">Oxygen Saturation</p>
                            <span id="limit-spo2" class="trend-card-subtitle">ช่วงที่ตั้งไว้ · SpO₂ %</span>
                        </div>
                    </div>
                    <span id="avg-spo2" class="trend-summary text-[10px] font-mono"></span>
                </div>
                <div class="trend-chart h-[145px]"><canvas id="chartSPO2_Panel"></canvas></div>
            </div>

            <div class="trend-card trend-card--temp card p-4 shadow-sm" style="background: var(--bg-vital); border: 1px solid var(--border-color);">
                <div class="trend-card-head flex justify-between items-center mb-2">
                    <div class="trend-title-group">
                        <span class="trend-icon" aria-hidden="true">🌡️</span>
                        <div>
                            <p class="text-xs font-bold uppercase" style="color: #f97316;">Body Temperature</p>
                            <span id="limit-temp" class="trend-card-subtitle">ช่วงที่ตั้งไว้ · °C</span>
                        </div>
                    </div>
                    <span id="avg-temp" class="trend-summary text-[10px] font-mono"></span>
                </div>
                <div class="trend-chart h-[145px]"><canvas id="chartTEMP_Panel"></canvas></div>
            </div>
        </div>
    </div>

    <audio id="alertSound" src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg" preload="auto"></audio>

    <script>
        let nurse = '';
        let role = 'viewer';
        const _ROLE_LABELS = {
            super_admin: '🛡️ Super Admin',
            ward_admin: '🏥 Ward Admin',
            staff_nurse: '👩‍⚕️ Staff Nurse',
            viewer: '👁️ Viewer'
        };
        function _roleLabel(r) { return _ROLE_LABELS[r] || ('👤 ' + (r || 'viewer')); }
        const _ROLE_CAPS = {
            super_admin: new Set([
                'patients:read', 'patients:write', 'devices:read', 'devices:write', 'pairing:write',
                'alerts:read', 'alerts:ack', 'alerts:settings:write',
                'users:manage:all', 'users:manage:ward', 'wards:manage', 'settings:global', 'audit:read:all', 'audit:read:ward', 'export:read'
            ]),
            ward_admin: new Set([
                'patients:read', 'patients:write', 'devices:read', 'devices:write', 'pairing:write',
                'alerts:read', 'alerts:ack', 'alerts:settings:write',
                'users:manage:ward', 'audit:read:ward', 'export:read'
            ]),
            staff_nurse: new Set(['patients:read', 'devices:read', 'alerts:read', 'alerts:ack', 'export:read']),
            viewer: new Set(['patients:read', 'devices:read', 'alerts:read'])
        };
        function _userCapabilities(r) { return _ROLE_CAPS[r] || new Set(); }

        const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
        })[char]);
        async function apiErrorMessage(response, fallback) {
            try {
                const payload = await response.json();
                return payload.error || payload.message || fallback;
            } catch (_) {
                return fallback + ' (HTTP ' + response.status + ')';
            }
        }
        fetch('/api/me').then(async response => {
            if (!response.ok) throw new Error('Unauthenticated');
            const user = await response.json();
            nurse = user.name || user.username || '';
            role = user.role || 'viewer';
            document.getElementById('display-nurse').innerText = nurse;
            document.getElementById('display-role').innerText = _roleLabel(role);
            // Apply role-based CSS class for legacy admin-only elements (the add/edit/
            // pair forms and buttons) — gate on the same write capabilities the backend
            // actually enforces, not a hardcoded 'super_admin' check, so ward_admin (who
            // already has devices:write/patients:write/pairing:write server-side) sees them too.
            const caps = _userCapabilities(role);
            if (caps.has('devices:write') || caps.has('patients:write') || caps.has('pairing:write')) {
                document.body.classList.add('is-admin');
            }
            // Show/hide sidebar links by capability
            document.querySelectorAll('[data-cap]').forEach(link => {
                const cap = link.getAttribute('data-cap');
                if (caps.has(cap)) {
                    link.style.display = '';
                } else {
                    link.style.display = 'none';
                }
            });
        }).catch(() => { window.location.href = '/login'; });

        function applySidebarState() {
            const sidebar = document.getElementById('sidebar');
            const btn = document.getElementById('sidebarToggle');
            const collapsed = localStorage.getItem('sidebar_collapsed') === '1';

            if (!sidebar || !btn) return;

            if (window.matchMedia('(max-width: 768px)').matches) {
                sidebar.classList.remove('collapsed');
                return;
            }

            sidebar.classList.toggle('collapsed', collapsed);
            btn.innerText = collapsed ? '❯' : '❮';
            btn.title = collapsed ? 'เปิดเมนู' : 'หุบเมนู';
            btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        }

        // Theme Management
        function applyTheme() {
            const theme = localStorage.getItem('theme') || 'light';
            document.documentElement.setAttribute('data-theme', theme);
            const toggleBtn = document.getElementById('themeToggle');
            if (toggleBtn) {
                toggleBtn.title = theme === 'dark' ? 'สลับไปโหมดแสง' : 'สลับไปโหมดมืดย';
            }
        }

        function toggleTheme() {
            const current = document.documentElement.getAttribute('data-theme');
            const next = current === 'dark' ? 'light' : 'dark';
            localStorage.setItem('theme', next);
            applyTheme();
        }

        // Apply theme on page load
        applyTheme();

        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            if (!sidebar) return;

            if (window.matchMedia('(max-width: 768px)').matches) {
                sidebar.classList.contains('mobile-open') ? closeMobileMenu() : openMobileMenu();
                return;
            }

            const nextCollapsed = !sidebar.classList.contains('collapsed');
            localStorage.setItem('sidebar_collapsed', nextCollapsed ? '1' : '0');
            applySidebarState();
        }

        applySidebarState();

        function openMobileMenu() {
            if (!window.matchMedia('(max-width: 768px)').matches) return;
            const sidebar = document.getElementById('sidebar');
            const backdrop = document.getElementById('sidebarBackdrop');
            const button = document.getElementById('mobileMenuButton');
            sidebar?.classList.add('mobile-open');
            backdrop?.classList.add('active');
            button?.setAttribute('aria-expanded', 'true');
            document.body.style.overflow = 'hidden';
        }

        function closeMobileMenu() {
            const sidebar = document.getElementById('sidebar');
            const backdrop = document.getElementById('sidebarBackdrop');
            const button = document.getElementById('mobileMenuButton');
            sidebar?.classList.remove('mobile-open');
            backdrop?.classList.remove('active');
            button?.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        }

        document.querySelectorAll('#sidebar a').forEach(link => link.addEventListener('click', closeMobileMenu));
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeMobileMenu();
                closeModal();
                closePanel();
            }
        });
        window.addEventListener('resize', () => {
            if (!window.matchMedia('(max-width: 768px)').matches) closeMobileMenu();
            applySidebarState();
        });

        async function logout() {
            try { await fetch('/api/logout', { method: 'POST' }); } catch (_) {}
            localStorage.removeItem('nurse_name');
            localStorage.removeItem('user_role');
            window.location.href = '/login';
        }

        function closeModal() {
            const modal = document.getElementById('globalModal');
            modal.style.display = 'none';
            modal.classList.remove('modal--wide');
        }

        function openModal(title, bodyHtml, submitFn, variant) {
            const modal = document.getElementById('globalModal');
            document.getElementById('modalTitle').innerText = title;
            document.getElementById('modalBody').innerHTML = bodyHtml;
            document.getElementById('modalSubmit').onclick = submitFn;
            modal.classList.toggle('modal--wide', variant === 'wide');
            modal.style.display = 'flex';
            modal.querySelector(':scope > div').scrollTop = 0;
            document.getElementById('modalBody').scrollTop = 0;
        }

        let alertAudioContext = null;
        function unlockAlertAudio() {
            try {
                alertAudioContext = alertAudioContext || new (window.AudioContext || window.webkitAudioContext)();
                alertAudioContext.resume();
            } catch (_) {}
        }
        document.addEventListener('pointerdown', unlockAlertAudio, { once: true });
        function playAlert() {
            document.getElementById('alertSound')?.play().catch(() => {
                try {
                    unlockAlertAudio();
                    if (!alertAudioContext || alertAudioContext.state !== 'running') return;
                    const oscillator = alertAudioContext.createOscillator();
                    const gain = alertAudioContext.createGain();
                    oscillator.frequency.value = 880;
                    gain.gain.setValueAtTime(0.12, alertAudioContext.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.001, alertAudioContext.currentTime + 0.35);
                    oscillator.connect(gain).connect(alertAudioContext.destination);
                    oscillator.start(); oscillator.stop(alertAudioContext.currentTime + 0.35);
                } catch (_) {}
            });
        }

        let globalAlertSoundTimer = null;
        async function monitorGlobalAlerts() {
            try {
                const response = await fetch('/api/alert-ui-state');
                if (!response.ok) return;
                const state = await response.json();
                document.title = state.count > 0 ? '(' + state.count + ') NurseAid' : 'NurseAid System';
                const banner = document.getElementById('siteAlertBanner');
                if (banner) {
                    banner.classList.toggle('hidden', state.count === 0);
                    banner.style.background = state.critical > 0 ? 'var(--accent-red)' : 'var(--accent-yellow)';
                    banner.style.color = state.critical > 0 ? 'var(--text-inverse)' : '#422006';
                    banner.textContent = state.count > 0
                        ? (state.critical > 0 ? '🔴 Critical ' + state.critical : '') +
                            (state.critical > 0 && state.warning > 0 ? ' · ' : '') +
                            (state.warning > 0 ? '🟡 Warning ' + state.warning : '') + ' — แตะเพื่อดู'
                        : '';
                }
                if (state.shouldSound && !globalAlertSoundTimer) {
                    playAlert();
                    globalAlertSoundTimer = setInterval(playAlert, 10000);
                } else if (!state.shouldSound && globalAlertSoundTimer) {
                    clearInterval(globalAlertSoundTimer);
                    globalAlertSoundTimer = null;
                }
            } catch (_) {}
        }
        monitorGlobalAlerts();
        setInterval(monitorGlobalAlerts, 10000);

        let panelCharts = {};
        let panelTrendRequest = null;
        let panelTrendState = {
            hn: '', name: '', hours: 24,
            thresholds: {
                hrMin: 50, hrWarningMin: 60, hrWarningMax: 110, hrMax: 120,
                spo2CriticalMin: 91, spo2WarningMin: 95,
                tempMin: 35.5, tempWarningMin: 36, tempWarningMax: 37, tempMax: 37.5
            }
        };
        const panelTrendRanges = {
            1: '1 ชั่วโมง',
            6: '6 ชั่วโมง',
            12: '12 ชั่วโมง',
            24: '24 ชั่วโมง',
            72: '3 วัน',
            168: '7 วัน'
        };
        const panelTrendGapMinutes = {
            1: 1.5,
            6: 3,
            12: 7.5,
            24: 7.5,
            72: 22.5,
            168: 45
        };

        const panelTrendRangePlugin = {
            id: 'panelTrendRange',
            beforeDatasetsDraw: function(chart, _args, options) {
                const yScale = chart.scales && chart.scales.y;
                const area = chart.chartArea;
                const criticalMin = Number(options && options.criticalMin);
                const warningMin = Number(options && options.warningMin);
                const warningMax = Number(options && options.warningMax);
                const criticalMax = Number(options && options.criticalMax);
                if (!yScale || !area || ![criticalMin, warningMin, warningMax, criticalMax].every(Number.isFinite)) return;

                const clampPixel = function(pixel) {
                    return Math.max(area.top, Math.min(area.bottom, pixel));
                };
                const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
                const ctx = chart.ctx;
                const fillBand = function(min, max, color) {
                    if (!(max > min)) return;
                    const top = clampPixel(yScale.getPixelForValue(max));
                    const bottom = clampPixel(yScale.getPixelForValue(min));
                    ctx.fillStyle = color;
                    ctx.fillRect(area.left, top, area.right - area.left, Math.max(0, bottom - top));
                };

                ctx.save();
                fillBand(yScale.min, criticalMin, isDark ? 'rgba(248,81,73,0.09)' : 'rgba(239,68,68,0.065)');
                fillBand(criticalMin, warningMin, isDark ? 'rgba(210,153,34,0.11)' : 'rgba(234,179,8,0.09)');
                fillBand(warningMin, warningMax, isDark ? 'rgba(63,185,80,0.08)' : 'rgba(34,197,94,0.07)');
                fillBand(warningMax, criticalMax, isDark ? 'rgba(210,153,34,0.11)' : 'rgba(234,179,8,0.09)');
                fillBand(criticalMax, yScale.max, isDark ? 'rgba(248,81,73,0.09)' : 'rgba(239,68,68,0.065)');

                [
                    {value: criticalMin, color: isDark ? 'rgba(248,81,73,0.5)' : 'rgba(220,38,38,0.38)'},
                    {value: warningMin, color: isDark ? 'rgba(210,153,34,0.55)' : 'rgba(202,138,4,0.4)'},
                    {value: warningMax, color: isDark ? 'rgba(210,153,34,0.55)' : 'rgba(202,138,4,0.4)'},
                    {value: criticalMax, color: isDark ? 'rgba(248,81,73,0.5)' : 'rgba(220,38,38,0.38)'}
                ].forEach(function(line) {
                    if (line.value < yScale.min || line.value > yScale.max) return;
                    const y = clampPixel(yScale.getPixelForValue(line.value));
                    ctx.strokeStyle = line.color;
                    ctx.lineWidth = 1;
                    ctx.setLineDash([5, 5]);
                    ctx.beginPath(); ctx.moveTo(area.left, y); ctx.lineTo(area.right, y); ctx.stroke();
                });
                ctx.restore();
            }
        };
        Chart.register(panelTrendRangePlugin);

        function closePanel() {
            document.getElementById('sidePanel').classList.remove('active');
            document.getElementById('panelOverlay').style.display = 'none';
            document.body.classList.remove('trend-panel-open');
            if (panelTrendRequest) panelTrendRequest.abort();
        }

        function trendRangeText(hours) {
            return panelTrendRanges[Number(hours)] || panelTrendRanges[24];
        }

        function setPanelTrendStatus(message, isError) {
            const status = document.getElementById('panel-trend-status');
            if (!status) return;
            status.textContent = message || '';
            status.classList.toggle('hidden', !message);
            status.style.color = isError ? 'var(--accent-red)' : 'var(--text-secondary)';
        }

        function clearPanelCharts() {
            Object.keys(panelCharts).forEach(function(id) {
                panelCharts[id].destroy();
            });
            panelCharts = {};
            ['avg-hr', 'avg-spo2', 'avg-temp'].forEach(function(id) {
                const node = document.getElementById(id);
                if (node) node.textContent = '';
            });
        }

        function panelTrendSeries(data, key, hours) {
            const recordedPoints = [];

            data.forEach(function(row) {
                const value = Number(row[key]);
                const timestamp = new Date(row._time).getTime();
                if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(timestamp)) return;
                recordedPoints.push({ x: timestamp, y: value });
            });

            recordedPoints.sort(function(a, b) { return a.x - b.x; });

            const points = [];
            const gapMs = (panelTrendGapMinutes[Number(hours)] || panelTrendGapMinutes[24]) * 60 * 1000;
            recordedPoints.forEach(function(point, index) {
                const previous = recordedPoints[index - 1];
                if (previous && point.x - previous.x > gapMs) {
                    points.push({ x: previous.x + (point.x - previous.x) / 2, y: null });
                }
                points.push(point);
            });

            return {
                points,
                values: recordedPoints.map(function(point) { return point.y; })
            };
        }

        function niceTrendStep(value, decimals) {
            const minimum = Math.pow(10, -decimals);
            if (!Number.isFinite(value) || value <= 0) return minimum;
            const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
            const normalized = value / magnitude;
            const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
            return Math.max(minimum, nice * magnitude);
        }

        function calculateTrendYAxis(values, config) {
            const valid = values.filter(Number.isFinite);
            if (valid.length === 0) {
                return { min: config.fallbackMin, max: config.fallbackMax, step: config.fallbackStep };
            }

            const observedMin = Math.min.apply(null, valid);
            const observedMax = Math.max.apply(null, valid);
            const observedRange = observedMax - observedMin;
            let span = Math.max(config.minSpan, observedRange * 1.3);
            if (config.referenceBounds) {
                span = Math.max(config.minSpan, observedRange * 1.12);
            }
            const center = (observedMin + observedMax) / 2;
            const step = niceTrendStep(span / 5, config.decimals);
            let min = Math.floor((center - span / 2) / step) * step;
            let max = Math.ceil((center + span / 2) / step) * step;

            min = Math.max(config.absoluteMin, min);
            max = Math.min(config.absoluteMax, max);

            if (max - min < config.minSpan) {
                if (max >= config.absoluteMax) min = Math.max(config.absoluteMin, max - config.minSpan);
                else max = Math.min(config.absoluteMax, min + config.minSpan);
            }

            const factor = Math.pow(10, config.decimals);
            return {
                min: Math.round(min * factor) / factor,
                max: Math.round(max * factor) / factor,
                step: Math.round(step * factor) / factor
            };
        }

        function updateTrendSummary(id, values, decimals) {
            const node = document.getElementById(id);
            const valid = values.filter(Number.isFinite);
            if (!node) return;
            if (valid.length === 0) {
                node.textContent = 'ไม่มีข้อมูล';
                return;
            }
            const average = valid.reduce(function(sum, value) { return sum + value; }, 0) / valid.length;
            const min = Math.min.apply(null, valid);
            const max = Math.max.apply(null, valid);
            node.textContent = 'เฉลี่ย ' + average.toFixed(decimals) + ' · ต่ำสุด ' +
                min.toFixed(decimals) + ' · สูงสุด ' + max.toFixed(decimals);
        }

        function panelCsvCell(value) {
            const text = value === null || value === undefined ? '' : String(value);
            const nl = String.fromCharCode(10);
            const cr = String.fromCharCode(13);

            if (
                text.indexOf('"') >= 0 ||
                text.indexOf(',') >= 0 ||
                text.indexOf(nl) >= 0 ||
                text.indexOf(cr) >= 0
            ) {
                return '"' + text.split('"').join('""') + '"';
            }

            return text;
        }

        function panelLocalDateTime(date) {
            const tzOffset = date.getTimezoneOffset() * 60000;
            return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
        }

        function panelSafeFilePart(value) {
            const badChars = [92, 47, 58, 42, 63, 34, 60, 62, 124];
            const text = String(value || 'patient');
            let out = '';

            for (let i = 0; i < text.length; i++) {
                const ch = text[i];
                out += badChars.indexOf(ch.charCodeAt(0)) >= 0 ? '_' : ch;
            }

            return out.split(' ').join('_').slice(0, 80) || 'patient';
        }

        function ensurePanelExportButton(hn, name, hours) {
            const btn = document.getElementById('panel-export-btn');
            if (!btn) return;

            const selectedHours = Number(hours) || 24;
            btn.innerText = '⬇ Export CSV ' + trendRangeText(selectedHours);
            btn.disabled = false;
            btn.onclick = function() {
                exportPatientRange(hn, name, selectedHours);
            };
        }

        async function exportPatientRange(hn, name, hours) {
            const btn = document.getElementById('panel-export-btn');

            if (!hn) {
                alert('ไม่พบ HN ของคนไข้');
                return;
            }

            const now = new Date();
            const selectedHours = Number(hours) || 24;
            const start = new Date(now.getTime() - selectedHours * 60 * 60 * 1000).toISOString();
            const stop = now.toISOString();

            try {
                if (btn) {
                    btn.disabled = true;
                    btn.innerText = 'Exporting...';
                }

                const url = '/api/export-data?hn=' + encodeURIComponent(hn) +
                    '&start=' + encodeURIComponent(start) +
                    '&stop=' + encodeURIComponent(stop);

                const response = await fetch(url);
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data && data.error ? data.error : 'Export API error');
                }

                if (!Array.isArray(data) || data.length === 0) {
                    alert('ไม่พบข้อมูลย้อนหลัง ' + trendRangeText(selectedHours) + ' ของคนไข้คนนี้');
                    return;
                }

                const nl = String.fromCharCode(10);
                let csv = String.fromCharCode(0xFEFF) + 'Time,HN,Name,HR,SpO2,Temp' + nl;

                data.forEach(function(i) {
                    csv += [
                        panelCsvCell(i._time_str),
                        panelCsvCell(i.hm_number || hn),
                        panelCsvCell(i.patient_name || name),
                        panelCsvCell(i.ble_heart || ''),
                        panelCsvCell(i.ble_spo2 || ''),
                        panelCsvCell(i.ble_temp || '')
                    ].join(',') + nl;
                });

                const fileTime = panelLocalDateTime(new Date()).split(':').join('').split('T').join('_');
                const fileName = 'Patient_' + selectedHours + 'H_' +
                    panelSafeFilePart(name) + '_' +
                    panelSafeFilePart(hn) + '_' +
                    fileTime + '.csv';

                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement('a');

                link.href = URL.createObjectURL(blob);
                link.download = fileName;

                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                setTimeout(function() {
                    URL.revokeObjectURL(link.href);
                }, 1000);

            } catch (err) {
                alert('Export ไม่สำเร็จ: ' + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerText = '⬇ Export CSV ' + trendRangeText(selectedHours);
                }
            }
        }

        function panelThresholdNumber(value, fallback) {
            const number = Number(value);
            return Number.isFinite(number) ? number : fallback;
        }

        function updatePanelThresholdLabels() {
            const limits = panelTrendState.thresholds;
            const hr = document.getElementById('limit-hr');
            const spo2 = document.getElementById('limit-spo2');
            const temp = document.getElementById('limit-temp');
            if (hr) hr.textContent = 'ปกติ ' + limits.hrWarningMin + '–' + limits.hrWarningMax + ' · วิกฤตนอก ' + limits.hrMin + '–' + limits.hrMax;
            if (spo2) spo2.textContent = 'ปกติ ≥' + limits.spo2WarningMin + '% · วิกฤต ≤' + limits.spo2CriticalMin + '%';
            if (temp) temp.textContent = 'ปกติ ' + limits.tempWarningMin + '–' + limits.tempWarningMax + ' · วิกฤตนอก ' + limits.tempMin + '–' + limits.tempMax;
        }

        async function showTrend(mac, name, hn, hrMin, hrWarningMin, hrWarningMax, hrMax, spo2CriticalMin, spo2WarningMin, tempMin, tempWarningMin, tempWarningMax, tempMax) {
            panelTrendState = {
                hn: hn,
                name: name,
                hours: 24,
                thresholds: {
                    hrMin: panelThresholdNumber(hrMin, 50),
                    hrWarningMin: panelThresholdNumber(hrWarningMin, 60),
                    hrWarningMax: panelThresholdNumber(hrWarningMax, 110),
                    hrMax: panelThresholdNumber(hrMax, 120),
                    spo2CriticalMin: panelThresholdNumber(spo2CriticalMin, 91),
                    spo2WarningMin: panelThresholdNumber(spo2WarningMin, 95),
                    tempMin: panelThresholdNumber(tempMin, 35.5),
                    tempWarningMin: panelThresholdNumber(tempWarningMin, 36),
                    tempWarningMax: panelThresholdNumber(tempWarningMax, 37),
                    tempMax: panelThresholdNumber(tempMax, 37.5)
                }
            };
            document.getElementById('p-title').innerText = name;
            document.getElementById('p-hn').innerText = 'HN: ' + hn;
            document.getElementById('trend-range').value = '24';
            document.getElementById('sidePanel').classList.add('active');
            document.getElementById('panelOverlay').style.display = 'block';
            document.body.classList.add('trend-panel-open');
            updatePanelThresholdLabels();
            updatePanelTrendRange();
            await loadPanelTrend();
        }

        function changeTrendRange(value) {
            const hours = Number(value);
            if (!panelTrendRanges[hours]) return;
            panelTrendState.hours = hours;
            updatePanelTrendRange();
            loadPanelTrend();
        }

        function updatePanelTrendRange() {
            const label = document.getElementById('trend-range-label');
            if (label) label.textContent = 'ย้อนหลัง ' + trendRangeText(panelTrendState.hours);
            ensurePanelExportButton(panelTrendState.hn, panelTrendState.name, panelTrendState.hours);
        }

        function panelTrendTimeLabel(value, hours) {
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return '';
            if (hours <= 12) {
                return date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
            }
            return date.toLocaleString('th-TH', {
                day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
            });
        }

        async function loadPanelTrend() {
            const state = Object.assign({}, panelTrendState);
            const rangeSelect = document.getElementById('trend-range');
            if (panelTrendRequest) panelTrendRequest.abort();
            panelTrendRequest = new AbortController();
            const request = panelTrendRequest;
            if (rangeSelect) rangeSelect.disabled = true;
            setPanelTrendStatus('กำลังโหลดข้อมูลย้อนหลัง ' + trendRangeText(state.hours) + '…', false);

            try {
                const res = await fetch('/api/patient-trend/' + encodeURIComponent(state.hn) +
                    '?hours=' + encodeURIComponent(state.hours), { signal: request.signal });
                if (!res.ok) throw new Error('Trend API error');
                const data = await res.json();

                if (!Array.isArray(data) || data.length === 0) {
                    clearPanelCharts();
                    setPanelTrendStatus('ไม่พบข้อมูลในช่วง ' + trendRangeText(state.hours), false);
                    return;
                }

                const render = function(id, label, color, key, axisConfig, summaryId) {
                    const series = panelTrendSeries(data, key, state.hours);
                    const values = series.values;
                    const scaleValues = values.slice();
                    if (Number.isFinite(axisConfig.referenceMin)) scaleValues.push(axisConfig.referenceMin);
                    if (Number.isFinite(axisConfig.referenceMax)) scaleValues.push(axisConfig.referenceMax);
                    const yAxis = calculateTrendYAxis(scaleValues, axisConfig);
                    if(panelCharts[id]) panelCharts[id].destroy();
                    panelCharts[id] = new Chart(document.getElementById(id), {
                        type: 'line',
                        data: {
                            datasets: [{
                                label,
                                data: series.points,
                                borderColor: color,
                                backgroundColor: color + '10',
                                fill: true,
                                tension: 0.3,
                                cubicInterpolationMode: 'monotone',
                                pointRadius: 0,
                                pointHoverRadius: 5,
                                pointHitRadius: 14,
                                borderWidth: 2.35,
                                // Missing metric records and their timestamps are removed
                                // from this chart before it is rendered.
                                spanGaps: false
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 450, easing: 'easeOutQuart' },
                            interaction: { intersect: false, mode: 'index' },
                            layout: { padding: { top: 6, right: 12, bottom: 2, left: 4 } },
                            scales: {
                                y: {
                                    min: yAxis.min,
                                    max: yAxis.max,
                                    ticks: {
                                        stepSize: yAxis.step,
                                        maxTicksLimit: 7,
                                        padding: 8,
                                        font: { family: 'Prompt', size: 11, weight: '600' },
                                        color: function() {
                                            const theme = document.documentElement.getAttribute('data-theme');
                                            return theme === 'dark' ? '#8b949e' : '#64748b';
                                        },
                                        callback: function(value) { return Number(value).toFixed(axisConfig.decimals); }
                                    },
                                    grid: { color: ctx => {
                                        const theme = document.documentElement.getAttribute('data-theme');
                                        return theme === 'dark' ? '#21262d' : '#e2e8f0';
                                    }, borderDash: [5, 5] }
                                },
                                x: {
                                    type: 'linear',
                                    grid: { display: false },
                                    ticks: {
                                        maxRotation: 0,
                                        autoSkip: true,
                                        maxTicksLimit: window.innerWidth >= 1200 ? 12 : 8,
                                        padding: 8,
                                        font: { family: 'Prompt', size: 11, weight: '500' },
                                        callback: function(value) {
                                            return panelTrendTimeLabel(Number(value), state.hours);
                                        },
                                        color: ctx => {
                                            const theme = document.documentElement.getAttribute('data-theme');
                                            return theme === 'dark' ? '#7d8590' : '#94a3b8';
                                        }
                                    }
                                }
                            },
                            plugins: {
                                legend: { display: false },
                                panelTrendRange: {
                                    criticalMin: axisConfig.criticalMin,
                                    warningMin: axisConfig.warningMin,
                                    warningMax: axisConfig.warningMax,
                                    criticalMax: axisConfig.criticalMax
                                },
                                tooltip: {
                                    displayColors: false,
                                    backgroundColor: '#0f172a',
                                    titleFont: { family: 'Prompt', size: 12, weight: '600' },
                                    bodyFont: { family: 'Prompt', size: 13, weight: '600' },
                                    padding: 12,
                                    cornerRadius: 10,
                                    callbacks: {
                                        title: function(items) {
                                            if (!items || !items.length) return '';
                                            return panelTrendTimeLabel(items[0].parsed.x, state.hours);
                                        },
                                        label: function(item) {
                                            return item.dataset.label + ': ' +
                                                Number(item.parsed.y).toFixed(axisConfig.decimals) +
                                                (axisConfig.unit ? ' ' + axisConfig.unit : '');
                                        }
                                    }
                                }
                            }
                        }
                    });
                    updateTrendSummary(summaryId, values, axisConfig.decimals);
                };

                render('chartHR_Panel', 'HR', '#ef4444', 'ble_heart', {
                    absoluteMin: 20, absoluteMax: 240, minSpan: 10, decimals: 0,
                    fallbackMin: 40, fallbackMax: 160, fallbackStep: 20, unit: 'BPM',
                    referenceMin: state.thresholds.hrMin, referenceMax: state.thresholds.hrMax,
                    criticalMin: state.thresholds.hrMin, warningMin: state.thresholds.hrWarningMin,
                    warningMax: state.thresholds.hrWarningMax, criticalMax: state.thresholds.hrMax,
                    referenceBounds: true
                }, 'avg-hr');
                render('chartSPO2_Panel', 'SpO2', '#3b82f6', 'ble_spo2', {
                    absoluteMin: 50, absoluteMax: 100, minSpan: 2, decimals: 1,
                    fallbackMin: 90, fallbackMax: 100, fallbackStep: 2, unit: '%',
                    referenceMin: state.thresholds.spo2CriticalMin, referenceMax: 100,
                    criticalMin: state.thresholds.spo2CriticalMin, warningMin: state.thresholds.spo2WarningMin,
                    warningMax: 100, criticalMax: 100,
                    referenceBounds: true
                }, 'avg-spo2');
                render('chartTEMP_Panel', 'Temp', '#f97316', 'ble_temp', {
                    absoluteMin: 30, absoluteMax: 43, minSpan: 0.6, decimals: 1,
                    fallbackMin: 35, fallbackMax: 38, fallbackStep: 0.5, unit: '°C',
                    referenceMin: state.thresholds.tempMin, referenceMax: state.thresholds.tempMax,
                    criticalMin: state.thresholds.tempMin, warningMin: state.thresholds.tempWarningMin,
                    warningMax: state.thresholds.tempWarningMax, criticalMax: state.thresholds.tempMax,
                    referenceBounds: true
                }, 'avg-temp');

                setPanelTrendStatus('', false);

            } catch (err) {
                if (err.name === 'AbortError') return;
                console.error('Error fetching trend:', err);
                clearPanelCharts();
                setPanelTrendStatus('โหลดข้อมูลกราฟไม่สำเร็จ กรุณาลองอีกครั้ง', true);
            } finally {
                if (panelTrendRequest === request) {
                    panelTrendRequest = null;
                    if (rangeSelect) rangeSelect.disabled = false;
                }
            }
        }

        ${script}
    </script>
</body>
</html>`;
}

const MANAGED_DEVICE_TYPES = new Set(['jstyle', 'wearos']);

app.post('/api/login', async (req, res) => {
    const username = String(req.body.u || '').trim();
    const password = String(req.body.p || '');
    if (!username || !password) return res.status(400).json({ success: false });

    const r = await pool.query(
        'SELECT id, username, full_name, role, password, session_version FROM users WHERE username=$1',
        [username]
    );
    const user = r.rows[0];
    if (!user || !(await verifyPassword(password, user.password))) {
        return res.status(401).json({ success: false });
    }

    if (!user.password.startsWith('scrypt:')) {
        await pool.query('UPDATE users SET password=$1 WHERE id=$2', [await hashPassword(password), user.id]);
    }

    const token = jwt.sign(
        {
            id: user.id,
            username: user.username,
            name: user.full_name,
            role: user.role,
            sessionVersion: Number(user.session_version) || 0
        },
        SESSION_SECRET,
        { expiresIn: '8h', issuer: 'nurseaid' }
    );
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ success: true, name: user.full_name, role: user.role });

    // Audit login
    logAudit({ user: { id: user.id, role: user.role }, headers: req.headers, socket: req.socket }, 'login', 'user', user.id, { username }).catch(() => { });
});

app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ success: true });
});

app.get('/api/me', async (req, res) => {
    let wards = [];
    try {
        const result = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
        wards = result.rows.map(r => r.ward_id);
    } catch (e) {}
    const caps = Array.from(ROLE_CAPABILITIES[req.user.role] || []);
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role, wards, capabilities: caps });
});

app.get('/health/live', (req, res) => res.json({
    status: 'ok',
    uptimeSeconds: Math.floor(process.uptime())
}));

async function readiness() {
    const startedAt = Date.now();
    const checks = { postgres: false, influxdb: false };
    const errors = {};
    try {
        await Promise.race([
            pool.query('SELECT 1'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]);
        checks.postgres = true;
    } catch (error) {
        errors.postgres = error.message;
    }
    try {
        const response = await fetch(`${influxConfig.url}/health`, {
            signal: AbortSignal.timeout(3000)
        });
        checks.influxdb = response.ok;
        if (!response.ok) errors.influxdb = `HTTP ${response.status}`;
    } catch (error) {
        errors.influxdb = error.message;
    }
    const ready = Object.values(checks).every(Boolean);
    return {
        ready,
        status: ready ? 'ready' : 'not_ready',
        checks,
        errors,
        latencyMs: Date.now() - startedAt
    };
}

app.get('/health/ready', async (req, res) => {
    const result = await readiness();
    res.status(result.ready ? 200 : 503).json(result);
});

// Backward-compatible liveness endpoint used by existing deployments.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/live-status-legacy', adminOnly, async (req, res) => {
    try {
        const activeDevices = await pool.query(
            `SELECT mac, device_no, name, hm_number, bed_no,
                    COALESCE(device_type, 'jstyle') AS device_type
             FROM nurseaid
             WHERE hm_number IS NOT NULL`
        );
        if (activeDevices.rows.length === 0) return res.json([]);

        const fluxQuery = `
        from(bucket: "${influxConfig.bucket}")
            |> range(start: -${LIVE_CLINICAL_QUERY_WINDOW_MINUTES}m)
            |> filter(fn: (r) =>
                r._measurement == "ble_heart" or
                r._measurement == "ble_spo2" or
                r._measurement == "ble_spo2_quality" or
                r._measurement == "ble_temp" or
                r._measurement == "ble_status" or
                r._measurement == "ble_batt"
            )
            |> filter(fn: (r) => r._field == "value" or r._field == "status")
            |> group(columns: ["mac", "_measurement", "_field"])
            |> last()
        `;

        const measurementKeys = {
            ble_heart: 'heart',
            ble_spo2: 'spo2',
            ble_spo2_quality: 'spo2Quality',
            ble_temp: 'temp',
            ble_status: 'status',
            ble_batt: 'battery'
        };
        const influxData = new Map();

        queryApi.queryRows(fluxQuery, {
            next(row, tableMeta) {
                const obj = tableMeta.toObject(row);
                const mac = normalizeMac(obj.mac);
                const key = measurementKeys[obj._measurement];
                const timestampMs = new Date(obj._time).getTime();
                if (!mac || !key || !Number.isFinite(timestampMs)) return;
                if (obj._measurement === 'ble_spo2_quality' && obj._field !== 'status') return;

                const sensor = influxData.get(mac) || {};
                const previous = sensor[key];
                if (!previous || timestampMs >= previous.timestampMs) {
                    sensor[key] = { value: obj._value, timestampMs };
                    influxData.set(mac, sensor);
                }
            },
            error(err) {
                console.error('[Live Status] InfluxDB query failed:', err.message);
                if (!res.headersSent) {
                    res.status(503).json({
                        error: 'live_data_unavailable',
                        message: 'ไม่สามารถอ่านข้อมูลสัญญาณชีพได้ในขณะนี้'
                    });
                }
            },
            complete() {
                if (res.headersSent) return;

                const nowMs = Date.now();
                const freshEntry = (sensor, key) => {
                    const entry = sensor?.[key];
                    if (!entry) return null;
                    const ageSeconds = Math.max(0, Math.floor((nowMs - entry.timestampMs) / 1000));
                    return ageSeconds <= LIVE_VITAL_FRESHNESS_SECONDS ? { ...entry, ageSeconds } : null;
                };

                const result = activeDevices.rows.map(dev => {
                    const dbMac = normalizeMac(dev.mac);
                    const sensor = influxData.get(dbMac);

                    let hr = '--', spo2 = '--', temp = '--', status = 'Offline', battery = '--';
                    let spo2Quality = 'unavailable';
                    let alertLevel = 'normal';
                    let alertCauses = [];

                    if (sensor) {
                        const heartEntry = freshEntry(sensor, 'heart');
                        const spo2Entry = freshEntry(sensor, 'spo2');
                        const spo2QualityEntry = freshEntry(sensor, 'spo2Quality');
                        const tempEntry = freshEntry(sensor, 'temp');
                        const statusEntry = freshEntry(sensor, 'status');
                        const batteryEntry = freshEntry(sensor, 'battery');
                        const hrNum = parseInt(heartEntry?.value);
                        const spo2Num = parseInt(spo2Entry?.value);
                        const tempNum = parseFloat(tempEntry?.value);
                        const statusNum = parseInt(statusEntry?.value);
                        const battNum = parseInt(batteryEntry?.value);
                        const isJStyleDevice = String(dev.device_type || 'jstyle').toLowerCase() === 'jstyle';
                        spo2Quality = String(
                            spo2QualityEntry?.value || (!isJStyleDevice && spo2Entry ? 'verified' : 'unavailable')
                        ).toLowerCase();

                        hr = (!isNaN(hrNum) && hrNum > 0) ? hrNum : '--';
                        // ble_spo2 is written only after the gateway quality
                        // gate verifies a value. Keep that last verified value
                        // visible while a newer round is measuring or fails,
                        // as long as the value itself is still fresh.
                        spo2 = (!isNaN(spo2Num) && spo2Num > 0) ? spo2Num : '--';
                        temp = (!isNaN(tempNum) && tempNum > 0) ? tempNum : '--';
                        status = (!isNaN(statusNum) && statusNum >= 0) ? 'Online' : 'Offline';
                        battery = (!isNaN(battNum)) ? battNum : '--';

                        // A fresh status=0 means the wearable is not being worn.
                        // Do not show older clinical points that remain fresh.
                        if (status !== 'Online') {
                            hr = '--';
                            spo2 = '--';
                            temp = '--';
                        }

                        if (status === 'Online') {
                            if (hr !== '--' && (hr > 120 || hr < 50)) {
                                alertLevel = 'critical';
                                alertCauses.push(`HR=${hr}`);
                            } else if (hr !== '--' && (hr > 110 || hr < 60)) {
                                alertLevel = 'warning';
                                alertCauses.push(`HR=${hr} (เฝ้าระวัง)`);
                            }
                            if (temp !== '--' && (temp > 37.8 || temp < 35.5)) {
                                alertLevel = 'critical';
                                alertCauses.push(`Temp=${temp}`);
                            } else if (temp !== '--' && (temp > 37.5 || temp < 36.0)) {
                                if (alertLevel !== 'critical') alertLevel = 'warning';
                                alertCauses.push(`Temp=${temp} (เฝ้าระวัง)`);
                            }
                            if (spo2 !== '--') {
                                if (spo2 <= 90) {
                                    alertLevel = 'critical';
                                    alertCauses.push(`SpO2=${spo2}% (วิกฤต)`);
                                } else if (spo2 > 90 && spo2 <= 94) {
                                    if (alertLevel !== 'critical') alertLevel = 'warning';
                                    alertCauses.push(`SpO2=${spo2}% (ต่ำ)`);
                                }
                            }

                        }
                    }

                    const missingMetrics = [];
                    if (hr === '--') missingMetrics.push('HR');
                    if (spo2 === '--') missingMetrics.push('SpO2');
                    if (temp === '--') missingMetrics.push('Temp');

                    const dataQuality = status !== 'Online'
                        ? 'offline'
                        : (missingMetrics.length > 0 ? 'partial' : 'complete');
                    const dataMessage = dataQuality === 'complete'
                        ? 'ข้อมูลครบและเป็นปัจจุบัน'
                        : (dataQuality === 'partial'
                            ? `ข้อมูลไม่ครบ: ${missingMetrics.join(', ')}`
                            : 'ไม่พบข้อมูลจากอุปกรณ์');
                    const timestamps = sensor
                        ? Object.values(sensor).map(entry => entry.timestampMs).filter(Number.isFinite)
                        : [];
                    const lastSeenMs = timestamps.length > 0 ? Math.max(...timestamps) : null;

                    return {
                        ...dev,
                        hr,
                        spo2,
                        temp,
                        status,
                        battery,
                        spo2Quality,
                        alertLevel,
                        dataQuality,
                        dataMessage,
                        missingMetrics,
                        lastSeenAt: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
                        lastSeenSeconds: lastSeenMs ? Math.max(0, Math.floor((nowMs - lastSeenMs) / 1000)) : null
                    };
                });
                res.json(result);
            }
        });
    } catch (err) {
        console.error('[Live Status] Request failed:', err.message);
        res.status(503).json({
            error: 'live_status_unavailable',
            message: 'ไม่สามารถอ่านสถานะอุปกรณ์ได้ในขณะนี้'
        });
    }
});

async function queryLiveStatuses() {
    const [devicesResult, settingsResult] = await Promise.all([
        pool.query(`SELECT mac, device_no, name, hm_number, bed_no, ward_id,
                           COALESCE(device_type, 'jstyle') AS device_type
                    FROM nurseaid WHERE hm_number IS NOT NULL ORDER BY device_no ASC`),
        pool.query('SELECT * FROM alert_settings')
    ]);
    if (devicesResult.rows.length === 0) return [];

    const defaultSettings = settingsResult.rows.find(row => row.mac === '*') || {
        hr_min: 50, hr_max: 120, hr_warning_min: 60, hr_warning_max: 110,
        spo2_min: 95, spo2_warning_min: 95, spo2_critical_min: 91,
        temp_min: 35.5, temp_max: 37.5, temp_warning_min: 36.0, temp_warning_max: 37.0,
        enable_sound: true, enable_line: true, enable_offline_alert: true, enable_webhook: false,
        battery_low_threshold: 20, offline_threshold_minutes: 2
    };
    const settingByMac = new Map(settingsResult.rows.filter(row => row.mac !== '*').map(row => [normalizeMac(row.mac), row]));
    const clinicalFluxQuery = `
        from(bucket: "${influxConfig.bucket}")
            |> range(start: -${LIVE_CLINICAL_QUERY_WINDOW_MINUTES}m)
            |> filter(fn: (r) => r._measurement == "ble_heart" or r._measurement == "ble_spo2" or
                r._measurement == "ble_spo2_quality" or r._measurement == "ble_temp" or
                r._measurement == "ble_status" or r._measurement == "ble_rssi")
            |> filter(fn: (r) => r._field == "value" or r._field == "status" or r._field == "activity")
            |> group(columns: ["mac", "_measurement", "_field"])
            |> last()`;
    const batteryFluxQuery = `
        from(bucket: "${influxConfig.bucket}")
            |> range(start: -${LIVE_BATTERY_QUERY_WINDOW_MINUTES}m)
            |> filter(fn: (r) => r._measurement == "ble_batt" and r._field == "value")
            |> group(columns: ["mac", "_measurement", "_field"])
            |> last()`;
    const [clinicalRows, batteryRows] = await Promise.all([
        queryApi.collectRows(clinicalFluxQuery),
        queryApi.collectRows(batteryFluxQuery).catch(error => {
            console.warn(`[Live Status] Battery query unavailable: ${error.message}`);
            return [];
        })
    ]);
    const rows = clinicalRows.concat(batteryRows);
    const measurementKeys = {
        ble_heart: 'heart', ble_spo2: 'spo2', ble_spo2_quality: 'spo2Quality',
        ble_temp: 'temp', ble_status: 'status', ble_batt: 'battery', ble_rssi: 'rssi'
    };
    const influxData = new Map();
    for (const row of rows) {
        const mac = normalizeMac(row.mac);
        const key = measurementKeys[row._measurement];
        const timestampMs = new Date(row._time).getTime();
        if (!mac || !key || !Number.isFinite(timestampMs)) continue;
        if (row._measurement === 'ble_spo2_quality' && row._field !== 'status') continue;
        const sensor = influxData.get(mac) || {};
        if (row._measurement === 'ble_status' && row._field === 'activity') {
            if (!sensor.activity || timestampMs >= sensor.activity.timestampMs) sensor.activity = { value: row._value, timestampMs };
        } else {
            if (!sensor[key] || timestampMs >= sensor[key].timestampMs) sensor[key] = { value: row._value, timestampMs };
        }
        influxData.set(mac, sensor);
    }

    const nowMs = Date.now();
    return devicesResult.rows.map(device => {
        const mac = normalizeMac(device.mac);
        const sensor = influxData.get(mac);
        const settings = { ...defaultSettings, ...(settingByMac.get(mac) || {}), mac: device.mac };
        const limits = alertThresholds(settings);
        const snapshot = buildLiveSnapshot(sensor, nowMs, LIVE_FRESHNESS_POLICY);
        let { hr, temp, battery } = snapshot;
        let spo2 = snapshot.spo2;
        if (snapshot.recoveryPending) {
            hr = '--';
            spo2 = '--';
            temp = '--';
        }
        // If explicitly off-wrist, immediately blank all clinical values so we don't
        // display ghost data for 3 minutes after the device is removed.
        if (snapshot.explicitOffWrist) {
            hr = '--';
            temp = '--';
            spo2 = '--';
        }
        const causes = [];
        let alertLevel = 'normal';
        // Retain recent values while an explicitly off-wrist device is still
        // communicating, but never use those retained values for alerts.
        if (snapshot.connected && snapshot.worn) {
            if (snapshot.hrLive && hr !== '--') {
                const level = classifyVitalRange(hr, limits.hrMin, limits.hrWarningMin, limits.hrWarningMax, limits.hrMax);
                alertLevel = higherAlertLevel(alertLevel, level);
                if (level !== 'normal') causes.push(`HR=${hr} bpm (${level === 'critical' ? 'Critical' : 'Warning'})`);
            }
            if (temp !== '--') {
                const level = classifyVitalRange(temp, limits.tempMin, limits.tempWarningMin, limits.tempWarningMax, limits.tempMax);
                alertLevel = higherAlertLevel(alertLevel, level);
                if (level !== 'normal') causes.push(`Temp=${temp}°C (${level === 'critical' ? 'Critical' : 'Warning'})`);
            }
            if (spo2 !== '--' && spo2 < limits.spo2WarningMin) {
                const level = spo2 <= limits.spo2CriticalMin ? 'critical' : 'warning';
                alertLevel = higherAlertLevel(alertLevel, level);
                causes.push(`SpO2=${spo2}% (${level === 'critical' ? 'Critical' : 'Warning'})`);
            }
        }
        const missingMetrics = [['HR', hr], ['SpO2', spo2], ['Temp', temp]].filter(([, value]) => value === '--').map(([name]) => name);
        const wearState = snapshot.explicitOffWrist ? false : (snapshot.worn ? true : null);
        const dataQuality = snapshot.recoveryPending
            ? 'recovering'
            : !snapshot.connected
                ? 'offline'
                : snapshot.explicitOffWrist
                    ? 'off_wrist'
                    : wearState === null
                        ? (snapshot.presence === 'present' ? 'present_waiting' : 'sensor_waiting')
                        : (!snapshot.hrLive ? 'recent' : (missingMetrics.length ? 'partial' : 'live'));
        const dataMessages = {
            offline: 'ไม่พบข้อมูลจากอุปกรณ์',
            recovering: 'ระบบเพิ่งเริ่มทำงาน · กำลังเชื่อมต่ออุปกรณ์ใหม่',
            off_wrist: 'อุปกรณ์ยืนยันว่าไม่ได้สวม · ซ่อนค่าทางคลินิกเก่าแล้ว',
            present_waiting: 'พบอุปกรณ์ในระยะ · รอค่าทางคลินิก',
            sensor_waiting: 'อุปกรณ์เชื่อมต่อ แต่ยังไม่ได้รับสัญญาณจากเซ็นเซอร์',
            recent: 'มีค่าล่าสุด · ระบบติดตามต่อเนื่อง'
        };
        const activityMap = {
            scanning: 'กำลังค้นหาอุปกรณ์...',
            connecting: 'กำลังพยายามเชื่อมต่อบลูทูธ...',
            measuring_hr: 'กำลังวัดอัตราการเต้นหัวใจ...',
            measuring_spo2: 'กำลังวัดระดับออกซิเจน (SpO₂)...',
            gatt_error: 'สัญญาณถูกรบกวน (GATT Error) · กำลังลองใหม่...',
            hardware_hung: 'อุปกรณ์ค้าง โปรดชาร์จแบตเพื่อรีเซ็ต'
        };
        const activityMsg = snapshot.activity ? activityMap[snapshot.activity] : null;

        const dataMessage = activityMsg || dataMessages[dataQuality]
            || (missingMetrics.length ? `กำลังรอค่า: ${missingMetrics.join(', ')}` : 'ข้อมูลเป็นปัจจุบัน');
        return {
            ...device, hr, spo2, temp, battery,
            status: snapshot.recoveryPending ? 'Recovering' : (snapshot.connected ? 'Online' : 'Offline'),
            presence: snapshot.presence, rssi: snapshot.rssi, hrLive: snapshot.hrLive,
            metricAges: snapshot.metricAges,
            isWorn: wearState,
            spo2Quality: String(snapshot.explicitOffWrist ? 'off_wrist' : (snapshot.spo2Quality || (String(device.device_type).toLowerCase() !== 'jstyle' && spo2 !== '--' ? 'verified' : 'unavailable'))).toLowerCase(),
            alertLevel, alertCauses: causes, limits,
            hasCustomLimits: settingByMac.has(mac), soundEnabled: Boolean(settings.enable_sound),
            dataQuality, dataMessage, diagnosticCode: dataQuality,
            missingMetrics, lastSeenAt: snapshot.lastSeenMs ? new Date(snapshot.lastSeenMs).toISOString() : null,
            lastSeenSeconds: snapshot.lastSeenMs ? Math.max(0, Math.floor((nowMs - snapshot.lastSeenMs) / 1000)) : null,
            vitalLastSeenSeconds: snapshot.vitalLastSeenMs ? Math.max(0, Math.floor((nowMs - snapshot.vitalLastSeenMs) / 1000)) : null,
            _alertSettings: settings
        };
    });
}

const readLiveStatuses = createResilientSingleFlightCache(
    queryLiveStatuses,
    LIVE_STATUS_CACHE_MS,
    LIVE_STATUS_FALLBACK_MS
);

async function runAlertEngine() {
    if (alertEngineRunning) return;
    alertEngineRunning = true;
    try {
        const snapshot = await readLiveStatuses();
        if (snapshot.stale) return;
        const statuses = snapshot.value;
        const openOfflineResult = await pool.query(
            `SELECT id, mac FROM alert_logs
             WHERE category='device_offline' AND resolved=false`
        );
        const openOfflineByMac = new Map(
            openOfflineResult.rows.map(alert => [normalizeMac(alert.mac), alert])
        );
        const uptimeSeconds = Math.max(0, Math.floor((Date.now() - SERVER_STARTED_AT_MS) / 1000));
        for (const status of statuses) {
            const mac = normalizeMac(status.mac);
            const deviceSettings = status._alertSettings || {};
            const thresholdMinutes = offlineThresholdMinutes(deviceSettings);
            const offlineAlertEnabled = deviceSettings.enable_offline_alert !== false;
            const connectionOffline = offlineAlertEnabled
                && shouldRaiseOfflineAlert(status, deviceSettings, uptimeSeconds);
            const openOfflineAlert = openOfflineByMac.get(mac);

            if (connectionOffline && !openOfflineAlert) {
                const alert = await triggerOfflineAlert(status, deviceSettings, thresholdMinutes);
                openOfflineByMac.set(mac, alert);
            } else if ((!connectionOffline || !offlineAlertEnabled) && openOfflineAlert) {
                await resolveOfflineAlert(
                    status,
                    deviceSettings,
                    thresholdMinutes,
                    offlineAlertEnabled && !connectionOffline
                );
                openOfflineByMac.delete(mac);
            }

            const previous = deviceAlertState[mac] || 'normal';
            const current = status.status === 'Online' && !connectionOffline ? status.alertLevel : 'normal';
            if (current !== previous) {
                await pool.query(`UPDATE alert_logs SET resolved=true, resolved_at=NOW()
                                  WHERE LOWER(mac)=LOWER($1) AND category='vital' AND resolved=false`, [status.mac]);
                if (current === 'critical' || current === 'warning') {
                    await triggerAlert(status.mac, status.bed_no, status.name, current, 'vital', status.alertCauses.join(', '), deviceSettings);
                }
                deviceAlertState[mac] = current;
            }
        }
    } catch (error) {
        console.error('[Alert Engine]', error.message);
    } finally {
        alertEngineRunning = false;
    }
}

app.get('/api/live-status', async (req, res) => {
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
    } catch (error) {
        console.error('[Live Status]', error.message);
        res.status(503).json({ error: 'live_status_unavailable', message: 'ไม่สามารถอ่านข้อมูลสัญญาณชีพได้ในขณะนี้' });
    }
});

async function patientTrendHandler(req, res) {
    const { hn } = req.params;
    const trendWindow = TREND_WINDOW_CONFIG[String(req.query.hours || '24')] || TREND_WINDOW_CONFIG['24'];
    try {
        // Step 1: Lookup MAC address from nurseaid table
        const nurseaidResult = await pool.query(
            'SELECT mac, name FROM nurseaid WHERE hm_number = $1',
            [hn]
        );
        if (nurseaidResult.rows.length === 0) {
            return res.json([]);
        }
        const { mac } = nurseaidResult.rows[0];
        const macNormalized = normalizeMac(mac);
        if (!macNormalized) {
            return res.json([]);
        }

        // Step 2: Query InfluxDB for vital signs (primary source).
        // Keep the point count readable while preserving more detail for shorter ranges.
        const influxQuery = `
            import "strings"

            from(bucket: "${influxConfig.bucket}")
                |> range(start: -${trendWindow.range})
                |> filter(fn: (r) =>
                    r._measurement == "ble_heart" or
                    r._measurement == "ble_spo2" or
                    r._measurement == "ble_temp"
                )
                |> filter(fn: (r) => exists r.mac and strings.toLower(v: r.mac) == "${escapeFluxString(macNormalized)}")
                |> aggregateWindow(every: ${trendWindow.aggregateWindow}, fn: mean, createEmpty: false)
                |> yield(name: "mean")
        `;

        try {
            const rows = await queryApi.collectRows(influxQuery);
            if (rows.length > 0) {
                // Transform InfluxDB results to the format expected by the frontend
                const grouped = {};
                rows.forEach(row => {
                    const value = Number(row._value);
                    if (!Number.isFinite(value)) return;

                    const timeStr = new Date(row._time).toISOString();
                    const key = timeStr;
                    if (!grouped[key]) {
                        grouped[key] = { _time: key, ble_heart: null, ble_spo2: null, ble_temp: null };
                    }
                    if (row._measurement === 'ble_heart') grouped[key].ble_heart = Math.round(value);
                    if (row._measurement === 'ble_spo2') grouped[key].ble_spo2 = Math.round(value * 10) / 10;
                    if (row._measurement === 'ble_temp') grouped[key].ble_temp = Math.round(value * 100) / 100;
                });
                const result = Object.values(grouped).sort((a, b) => new Date(a._time) - new Date(b._time));
                const hasVitalValues = result.some(row =>
                    row.ble_heart !== null || row.ble_spo2 !== null || row.ble_temp !== null
                );

                if (hasVitalValues) {
                    console.log(`[Trend] HN=${hn} MAC=${mac} InfluxDB returned ${result.length} rows`);
                    return res.json(result);
                }

                console.warn(`[Trend] HN=${hn} MAC=${mac} InfluxDB rows had no vital values, falling back to Postgres`);
            }
        } catch (influxErr) {
            console.warn(`[Trend] InfluxDB query failed for MAC=${mac}, falling back to Postgres:`, influxErr.message);
        }

        // Step 3: Fallback to Postgres vital_signs_logs
        const queryText = `
            SELECT
                date_trunc('minute', recorded_at) -
                    (CAST(extract(minute from recorded_at) AS integer) % $2::integer) * interval '1 minute' as _time,
                ROUND(AVG(heart_rate)) as ble_heart,
                ROUND(AVG(spo2), 1) as ble_spo2,
                ROUND(AVG(temperature), 2) as ble_temp
            FROM vital_signs_logs
            WHERE hm_number = $1
            AND recorded_at > NOW() - ($3::integer * interval '1 hour')
            AND (
                COALESCE(heart_rate, 0) > 0 OR
                COALESCE(spo2, 0) > 0 OR
                COALESCE(temperature, 0) > 0
            )
            GROUP BY 1
            ORDER BY 1 ASC
        `;
        const result = await pool.query(queryText, [hn, trendWindow.postgresBucketMinutes, trendWindow.hours]);
        console.log(`[Trend] HN=${hn} Postgres fallback returned ${result.rows.length} rows`);
        res.json(result.rows);
    } catch (err) {
        console.error("Patient Trend Error:", err);
        res.status(500).json([]);
    }
}

app.get('/api/patient-trend/:hn', patientTrendHandler);
// Backward-compatible URL for existing dashboard clients.
app.get('/api/patient-trend-24h/:hn', patientTrendHandler);

app.get('/', (req, res) => res.send(ui(req.user, 'dash', `
    <div class="dashboard-topbar flex justify-between items-center mb-3 gap-3">
        <div>
            <h2 class="dashboard-title text-xl font-black uppercase leading-none" style="color: var(--text-heading);">Patient Dashboard</h2>
            <p class="dashboard-subtitle text-[10px] font-bold mt-1" style="color: var(--text-tertiary);">INDIVIDUAL MONITORING</p>
        </div>

        <div class="flex items-center gap-2">
            <div id="patient-count" class="dashboard-sync text-[10px] font-bold px-4 py-2 rounded-full font-mono italic shadow-sm" style="background: var(--bg-card); color: var(--text-secondary); border: 1px solid var(--border-color);">0 Patients</div>
            <div id="last-sync" class="dashboard-sync text-[10px] font-bold px-4 py-2 rounded-full font-mono italic shadow-sm" style="background: var(--bg-card); color: var(--text-tertiary); border: 1px solid var(--border-color);">🔄 Syncing...</div>
        </div>
    </div>

    <div id="global-alert" class="hidden font-black animate-pulse shadow-md text-sm" style="background: var(--accent-red); color: var(--text-inverse);"></div>

    <div id="monitor-grid" class="monitor-grid-auto monitor-grid-layout"></div>
`, `
    let latestPatients = [];
    function getLimits(mac) {
        return latestPatients.find(patient => patient.mac === mac)?.limits || {
            hrMin: 50, hrWarningMin: 60, hrWarningMax: 110, hrMax: 120,
            spo2Min: 95, spo2WarningMin: 95, spo2CriticalMin: 91,
            tempMin: 35.5, tempWarningMin: 36, tempWarningMax: 37, tempMax: 37.5
        };
    }

    function openIndividualConfig(mac, name, bed) {
        const current = getLimits(mac);
        const html = \`
            <div class="bg-blue-50 p-4 rounded-2xl mb-4 text-center">
                <p class="text-xs font-bold text-blue-600 uppercase">ตั้งค่าขีดจำกัดรายบุคคล</p>
                <p class="font-bold text-slate-800">เตียง \${escapeHTML(bed || '-')}: \${escapeHTML(name || '-')}</p>
            </div>
            <div class="alert-settings-modal-grid text-sm">
                <div class="range-metric-card range-metric-card--hr"><div class="font-bold mb-2">Heart Rate (BPM)</div><div class="grid grid-cols-2 gap-2"><div><label class="text-[10px]" style="color:var(--accent-yellow);">Warning ต่ำ</label><input type="number" id="th-hrWarningMin" value="\${current.hrWarningMin}" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-yellow);">Warning สูง</label><input type="number" id="th-hrWarningMax" value="\${current.hrWarningMax}" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-red);">Critical ต่ำ</label><input type="number" id="th-hrMin" value="\${current.hrMin}" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-red);">Critical สูง</label><input type="number" id="th-hrMax" value="\${current.hrMax}" class="w-full border p-2 rounded-lg"></div></div></div>
                <div class="range-metric-card range-metric-card--spo2"><div class="font-bold mb-2">SpO₂ (%)</div><div class="grid grid-cols-2 gap-2"><div><label class="text-[10px]" style="color:var(--accent-yellow);">Warning ต่ำกว่า</label><input type="number" id="th-spo2Min" value="\${current.spo2WarningMin}" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-red);">Critical ≤</label><input type="number" id="th-spo2CriticalMin" value="\${current.spo2CriticalMin}" class="w-full border p-2 rounded-lg"></div></div></div>
                <div class="range-metric-card range-metric-card--temp"><div class="font-bold mb-2">Temperature (°C)</div><div class="grid grid-cols-2 gap-2"><div><label class="text-[10px]" style="color:var(--accent-yellow);">Warning ต่ำ</label><input type="number" id="th-tempWarningMin" value="\${current.tempWarningMin}" step="0.1" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-yellow);">Warning สูง</label><input type="number" id="th-tempWarningMax" value="\${current.tempWarningMax}" step="0.1" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-red);">Critical ต่ำ</label><input type="number" id="th-tempMin" value="\${current.tempMin}" step="0.1" class="w-full border p-2 rounded-lg"></div><div><label class="text-[10px]" style="color:var(--accent-red);">Critical สูง</label><input type="number" id="th-tempMax" value="\${current.tempMax}" step="0.1" class="w-full border p-2 rounded-lg"></div></div></div>
            </div>
            <button id="reset-patient-limits" type="button" class="w-full mt-4 text-[10px] text-slate-400 underline italic">ล้างค่าและใช้ค่าเริ่มต้น</button>
        \`;
        openModal('⚙️ Settings', html, async () => {
            const response = await fetch('/api/alert-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                mac, hrMin: Number(document.getElementById('th-hrMin').value),
                hrWarningMin: Number(document.getElementById('th-hrWarningMin').value),
                hrWarningMax: Number(document.getElementById('th-hrWarningMax').value), hrMax: Number(document.getElementById('th-hrMax').value),
                spo2Min: Number(document.getElementById('th-spo2Min').value),
                spo2WarningMin: Number(document.getElementById('th-spo2Min').value),
                spo2CriticalMin: Number(document.getElementById('th-spo2CriticalMin').value),
                tempMin: Number(document.getElementById('th-tempMin').value),
                tempWarningMin: Number(document.getElementById('th-tempWarningMin').value),
                tempWarningMax: Number(document.getElementById('th-tempWarningMax').value),
                tempMax: Number(document.getElementById('th-tempMax').value)
            }) });
            if (!response.ok) { const result = await response.json(); return alert(result.error || 'ไม่สามารถบันทึกค่าได้'); }
            closeModal();
            updateDash();
        }, 'wide');
        document.getElementById('reset-patient-limits').onclick = () => window.resetToDefault(mac);
    }

    window.resetToDefault = async (mac) => {
        const response = await fetch('/api/alert-settings/' + encodeURIComponent(mac), {method:'DELETE'});
        if (!response.ok) return alert('ไม่สามารถคืนค่าเริ่มต้นได้');
        closeModal();
        updateDash();
    };

    let alertInterval = null;
    function startAlertLoop(){ if(!alertInterval){ playAlert(); alertInterval = setInterval(()=>playAlert(), 2000); } }
    function stopAlertLoop(){ if(alertInterval){ clearInterval(alertInterval); alertInterval = null; } }

    let dashboardPollTimer = null;
    let dashboardRequestInFlight = false;
    function scheduleDashboardUpdate() {
        clearTimeout(dashboardPollTimer);
        dashboardPollTimer = setTimeout(updateDash, 5000);
    }

    function reconcilePatientCards(grid, cards) {
        Array.from(grid.children)
            .filter(node => !node.dataset || !node.dataset.patientKey)
            .forEach(node => node.remove());
        const existing = new Map(Array.from(grid.children)
            .filter(node => node.dataset && node.dataset.patientKey)
            .map(node => [node.dataset.patientKey, node]));

        cards.forEach((card, index) => {
            let node = existing.get(card.key);
            if (!node || node.dataset.signature !== card.signature) {
                const template = document.createElement('template');
                template.innerHTML = card.html.trim();
                const replacement = template.content.firstElementChild;
                replacement.dataset.patientKey = card.key;
                replacement.dataset.signature = card.signature;
                replacement.querySelector('[data-action="show-trend"]')?.addEventListener('click', () => {
                    const p = card.patient;
                    const limit = card.limit;
                    showTrend(
                        p.mac, p.name, p.hm_number,
                        limit.hrMin, limit.hrWarningMin, limit.hrWarningMax, limit.hrMax,
                        limit.spo2CriticalMin, limit.spo2WarningMin,
                        limit.tempMin, limit.tempWarningMin, limit.tempWarningMax, limit.tempMax
                    );
                });
                replacement.querySelector('[data-action="open-config"]')?.addEventListener('click', () => {
                    openIndividualConfig(card.patient.mac, card.patient.name, card.patient.bed_no);
                });
                if (node) node.replaceWith(replacement);
                node = replacement;
            }
            const nodeAtPosition = grid.children[index];
            if (nodeAtPosition !== node) grid.insertBefore(node, nodeAtPosition || null);
            existing.delete(card.key);
        });
        existing.forEach(node => node.remove());
    }

    async function updateDash() {
        if (dashboardRequestInFlight) return;
        dashboardRequestInFlight = true;
        try {
            const r = await fetch('/api/live-status');
            const data = await r.json();
            if (!r.ok) throw new Error(data.message || 'Live status request failed');
            if (!Array.isArray(data)) throw new Error('Live status response is invalid');
            latestPatients = data;
            const grid = document.getElementById('monitor-grid');
            const globalBanner = document.getElementById('global-alert');
            const patientCountEl = document.getElementById('patient-count');
            if (patientCountEl) patientCountEl.innerText = (data && data.length ? data.length : 0) + ' Patients';

            if(!data || data.length === 0) {
                grid.innerHTML = '<p class="col-span-full text-center p-12 italic" style="color: var(--text-tertiary);">ไม่มีข้อมูลคนไข้ในขณะนี้</p>';
                return;
            }

            let criticalBeds = [];
            let warningBeds = [];
            const theme = document.documentElement.getAttribute('data-theme');
            const isDark = theme === 'dark';

            const cards = data.map(p => {
                const isUnavailable = p.status === 'Unavailable' || p.dataQuality === 'telemetry_unavailable';
                const isOnline = p.status === 'Online';
                const isRecovering = p.status === 'Recovering' || p.dataQuality === 'recovering';
                const isWorn = p.isWorn === true;
                const dq = p.dataQuality || '';
                const isOffWrist = dq === 'off_wrist' || (isOnline && p.isWorn === false);
                const isOffline = dq === 'offline' || (!isOnline && !isRecovering);
                const isSensorWaiting = dq === 'sensor_waiting';
                const isPresentWaiting = dq === 'present_waiting';
                const isRecent = dq === 'recent';
                const isPartial = dq === 'partial';
                const isLowBattery = Number(p.battery) === 0;
                // Presence alone only proves that the BLE device is nearby. Until
                // the sensor confirms it is worn, keep the card visually inactive.
                const isAwaitingWearState = isPresentWaiting;
                const isInactive = isOffline || isOffWrist || isLowBattery || isAwaitingWearState;
                const canEvaluateVitals = isOnline && isWorn && !isInactive && !p.telemetryStale;
                const limit = getLimits(p.mac);
                const isHrCrit = canEvaluateVitals && p.hr !== '--' && (p.hr > limit.hrMax || p.hr < limit.hrMin);
                const isHrWarn = canEvaluateVitals && p.hr !== '--' && !isHrCrit && (p.hr > limit.hrWarningMax || p.hr < limit.hrWarningMin);
                const isSpo2Crit = canEvaluateVitals && p.spo2 !== '--' && p.spo2 <= limit.spo2CriticalMin;
                const isSpo2Warn = canEvaluateVitals && p.spo2 !== '--' && !isSpo2Crit && p.spo2 < limit.spo2WarningMin;
                const isTempCrit = canEvaluateVitals && p.temp !== '--' && (p.temp > limit.tempMax || p.temp < limit.tempMin);
                const isTempWarn = canEvaluateVitals && p.temp !== '--' && !isTempCrit && (p.temp > limit.tempWarningMax || p.temp < limit.tempWarningMin);
                const isCrit = isHrCrit || isSpo2Crit || isTempCrit;
                const isWarn = !isCrit && (isHrWarn || isSpo2Warn || isTempWarn);
                if(isCrit) criticalBeds.push(p.bed_no || '-');
                else if(isWarn) warningBeds.push(p.bed_no || '-');

                const statusColor = isOnline || isRecovering || isRecent || isPartial || isSensorWaiting || isPresentWaiting
                    ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
                    : 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.45)]';
                const hasCustom = p.hasCustomLimits;
                const dataQualityLabels = {
                    live: 'พร้อมใช้งาน',
                    recent: 'พร้อมใช้งาน',
                    partial: 'กำลังวัด',
                    present_waiting: 'พบอุปกรณ์ · ยังไม่พบสถานะการสวมใส่',
                    sensor_waiting: 'รอสัญญาณเซ็นเซอร์',
                    recovering: 'กำลังเชื่อมต่อใหม่',
                    off_wrist: 'ไม่ได้สวม',
                    offline: 'ออฟไลน์'
                };
                const statusLabel = (isOnline || isRecovering || isRecent || isPartial || isSensorWaiting || isPresentWaiting)
                    ? 'เชื่อมต่อได้'
                    : 'เชื่อมต่อไม่ได้';
                const spo2QualityLabels = {
                    measuring: 'กำลังวัด',
                    unstable: 'สัญญาณไม่นิ่ง',
                    timeout: 'วัดไม่สำเร็จ',
                    off_wrist: '--',
                    unavailable: '--'
                };
                const spo2Display = p.spo2 !== '--' ? p.spo2 : (spo2QualityLabels[p.spo2Quality] || '--');

                let battColor = isDark ? 'text-gray-500' : 'text-gray-400';
                if (p.battery !== '--') {
                    if (p.battery === 0) battColor = 'text-gray-500';
                    else if (p.battery < 20) battColor = 'text-red-500 animate-pulse font-bold';
                    else if (p.battery < 40) battColor = 'text-orange-500 font-bold';
                }
                const battLabel = p.battery === 0 ? 'แบตหมด' : (p.battery !== '--' ? p.battery + '%' : 'ไม่ทราบแบต');

                const bedBg = isInactive ? 'bg-gray-500' : (isDark ? 'bg-gray-700' : 'bg-gray-800');
                const nameColor = isInactive ? 'text-gray-500' : (isDark ? 'text-gray-100' : 'text-slate-800');
                const hnColor = isInactive ? 'text-gray-500' : (isDark ? 'text-gray-500' : 'text-slate-400');
                const settingsColor = isInactive
                    ? 'text-gray-500 hover:text-gray-600'
                    : (isDark ? 'text-gray-600 hover:text-blue-400' : 'text-slate-300 hover:text-blue-600');
                const vitalBg = isDark ? 'style="background: var(--bg-vital);"' : 'class="bg-slate-50"';
                const vitalTextColor = isDark ? 'var(--text-vital-muted)' : 'text-slate-400';
                const grayBg = isDark ? 'style="background: #111827; border: 1px solid #4b5563;"' : 'style="background: #d1d5db; border: 1px solid #9ca3af;"';
                const grayTextColor = isDark ? '#9ca3af' : '#6b7280';
                const inactiveCardStyle = isDark ? 'background: #1f2937;' : 'background: #e5e7eb;';
                // The outer card frame communicates patient clinical state:
                // green = normal vital signs, red = abnormal vital signs.
                // Connection/measurement status is communicated by the round status dot.
                const hasCompleteVitals = canEvaluateVitals && p.hr !== '--' && p.spo2 !== '--' && p.temp !== '--';
                const isClinicallyNormal = hasCompleteVitals && !isCrit && !isWarn;
                const cardBorderStyle = isCrit
                    ? 'border-color: var(--accent-red);'
                    : (isWarn ? 'border-color: var(--accent-yellow);' : (isClinicallyNormal ? 'border-color: var(--accent-green);' : 'border-color: var(--border-color);'));
                const normalVitalNumColor = isDark ? '#e6edf3' : '#334155';
                const criticalVitalBg = isDark
                    ? 'style="background: var(--accent-red-light); border: 1px solid rgba(248, 81, 73, 0.3);"'
                    : 'style="background: var(--accent-red-light); border: 1px solid var(--accent-red-light);"';
                const warningVitalBg = isDark
                    ? 'style="background: rgba(210, 153, 34, 0.14); border: 1px solid rgba(210, 153, 34, 0.35);"'
                    : 'style="background: #fef3c7; border: 1px solid #fde68a;"';
                // Highlight only the metric that is outside its own limits.
                // A critical SpO2 or temperature must not make a normal HR red.
                const hrBg = isInactive ? grayBg : (isHrCrit ? criticalVitalBg : (isHrWarn ? warningVitalBg : vitalBg));
                const spo2Bg = isInactive ? grayBg : (isSpo2Crit ? criticalVitalBg : (isSpo2Warn ? warningVitalBg : vitalBg));
                const tempBg = isInactive ? grayBg : (isTempCrit ? criticalVitalBg : (isTempWarn ? warningVitalBg : vitalBg));
                const hrNumColor = isInactive ? grayTextColor : (isHrCrit ? 'var(--accent-red)' : (isHrWarn ? 'var(--accent-yellow)' : normalVitalNumColor));
                const spo2NumColor = isInactive ? grayTextColor : (isSpo2Crit ? 'var(--accent-red)' : (isSpo2Warn ? 'var(--accent-yellow)' : normalVitalNumColor));
                const tempNumColor = isInactive ? grayTextColor : (isTempCrit ? 'var(--accent-red)' : (isTempWarn ? 'var(--accent-yellow)' : normalVitalNumColor));

                const key = String(p.mac || p.device_no || p.hm_number);
                const {
                    metricAges: _metricAges,
                    lastSeenAt: _lastSeenAt,
                    lastSeenSeconds: _lastSeenSeconds,
                    vitalLastSeenSeconds: _vitalLastSeenSeconds,
                    lastKnownAgeSeconds: _lastKnownAgeSeconds,
                    rssi: _rssi,
                    ...stablePatient
                } = p;
                const signature = JSON.stringify({
                    theme, p: stablePatient,
                    statusLabel, isHrCrit, isHrWarn, isSpo2Crit, isSpo2Warn, isTempCrit, isTempWarn
                });
                const safe = {
                    bed: escapeHTML(p.bed_no || '-'),
                    name: escapeHTML(p.name || '-'),
                    hn: escapeHTML(p.hm_number || '-'),
                    dataMessage: escapeHTML(p.dataMessage || statusLabel),
                    hr: escapeHTML(p.hr),
                    spo2: escapeHTML(spo2Display),
                    temp: escapeHTML(p.temp),
                    batteryLabel: escapeHTML(battLabel),
                    spo2Quality: escapeHTML(p.spo2Quality || 'unavailable')
                };
                const html = \`
                <div class="card p-4 border-t-4 transition-all" data-device-state="\${isInactive ? 'inactive' : 'active'}" style="\${cardBorderStyle} \${isInactive ? inactiveCardStyle : ''}">
                    <div class="flex items-center justify-between mb-4 gap-2 pb-2" style="border-bottom-color: var(--border-color);">
                        <div class="flex min-w-0 items-center gap-2 flex-1">
                            <span class="shrink-0 text-[10px] px-2 py-0.5 rounded font-bold italic uppercase tracking-tighter" style="background: \${bedBg}; color: white;">\${safe.bed}</span>
                            <span data-role="device-status" role="status" class="w-3 h-3 shrink-0 rounded-full \${statusColor}" aria-label="สถานะเครื่อง: \${statusLabel}" title="\${safe.dataMessage}"></span>
                            <div class="flex min-w-0 flex-col">
                                <button type="button" data-action="show-trend" class="font-bold text-sm truncate cursor-pointer leading-tight text-left" style="color: \${nameColor};">\${safe.name}</button>
                                <div class="flex items-center gap-2">
                                    <span class="min-w-0 truncate text-[9px] font-bold uppercase" style="color: \${hnColor};">HN: \${safe.hn}</span>
                                    <div class="flex items-center gap-0.5 \${battColor}">
                                        <svg class="w-4 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="1" y="6" width="18" height="12" rx="2" ry="2"></rect>
                                            <line x1="23" y1="13" x2="23" y2="11"></line>
                                            <line x1="5" y1="9" x2="\${p.battery !== '--' ? (5 + (p.battery * 0.1)) : 5}" y2="9" stroke-width="4" stroke="currentColor" opacity="0.8"></line>
                                        </svg>
                                        <span class="text-[10px] font-bold">\${safe.batteryLabel}</span>
                                    </div>
                                </div>
                            </div>
                            \${hasCustom ? '<span class="text-[10px] shrink-0" title="ตั้งค่าเฉพาะบุคคล">⚙️</span>' : ''}
                        </div>
                        <button type="button" data-action="open-config" class="admin-only shrink-0 p-1 transition-colors \${settingsColor}" aria-label="ตั้งค่าขีดจำกัดรายบุคคล">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                        </button>
                    </div>

                    <div class="grid grid-cols-3 gap-2">
                        <div class="p-2 rounded-xl text-center transition-all" \${hrBg}>
                            <p class="text-[8px] font-bold uppercase" style="color: \${vitalTextColor};">HR</p>
                            <p class="text-3xl font-black tracking-tighter" style="color: \${hrNumColor};">\${safe.hr}</p>
                        </div>
                        <div class="p-2 rounded-xl text-center transition-all" \${spo2Bg}>
                            <p class="text-[8px] font-bold uppercase" style="color: \${vitalTextColor};">SpO2</p>
                            <p class="\${p.spo2 === '--' ? 'text-xs mt-2' : 'text-3xl'} font-black tracking-tighter" style="color: \${spo2NumColor};" title="SpO2 quality: \${safe.spo2Quality}">\${safe.spo2}</p>
                        </div>
                        <div class="p-2 rounded-xl text-center transition-all" \${tempBg}>
                            <p class="text-[8px] font-bold uppercase" style="color: \${vitalTextColor};">Temp</p>
                            <p class="text-3xl font-black tracking-tighter" style="color: \${tempNumColor};">\${safe.temp}</p>
                        </div>
                    </div>
                </div>\`;
                return { key, signature, html, patient: p, limit };
            });
            reconcilePatientCards(grid, cards);

            const shouldSound = data.some(p => p.alertLevel === 'critical' && p.soundEnabled);
            if(criticalBeds.length > 0){
                globalBanner.classList.remove('hidden');
                globalBanner.style.background = 'var(--accent-red)';
                globalBanner.style.color = 'var(--text-inverse)';
                globalBanner.innerText = '🚨 วิกฤต: เตียง ' + criticalBeds.join(', ');
                stopAlertLoop(); // เสียงส่วนกลางของ layout ทำงานในทุกหน้าเว็บ
            } else if(warningBeds.length > 0){
                globalBanner.classList.remove('hidden');
                globalBanner.style.background = 'var(--accent-yellow)';
                globalBanner.style.color = '#422006';
                globalBanner.innerText = '⚠️ เฝ้าระวัง: เตียง ' + warningBeds.join(', ');
                stopAlertLoop();
            } else {
                globalBanner.classList.add('hidden');
                stopAlertLoop();
            }
            document.getElementById('last-sync').innerText = 'Last Sync: ' + new Date().toLocaleTimeString();
        } catch(e) {
            console.error('Dashboard Update Error:', e);
            const grid = document.getElementById('monitor-grid');
            if (grid && latestPatients.length === 0) {
                grid.innerHTML = '<div class="card col-span-full p-8 text-center border border-red-300"><p class="font-bold text-red-500">ไม่สามารถโหลดข้อมูลได้</p><p class="text-xs mt-1" style="color: var(--text-tertiary);">ระบบจะลองเชื่อมต่อใหม่อัตโนมัติ</p></div>';
            }
            const lastSync = document.getElementById('last-sync');
            if (lastSync) lastSync.innerText = latestPatients.length ? 'การเชื่อมต่อขัดข้อง · แสดงข้อมูลล่าสุด' : 'Live data unavailable';
        } finally {
            dashboardRequestInFlight = false;
            scheduleDashboardUpdate();
        }
    }

    updateDash();
`)));

app.get('/export', async (req, res) => {
    const scope = await wardScopeSql(req, 'p.ward_id', 1);
    const r = await pool.query(`
        SELECT
            p.hn_number AS hm_number,
            p.name,
            n.bed_no,
            n.device_no,
            n.mac,
            CASE
                WHEN n.hm_number IS NOT NULL THEN 'paired'
                ELSE 'unpaired'
            END AS pair_status
        FROM patients p
        LEFT JOIN nurseaid n ON n.hm_number = p.hn_number
        ${scope.clause ? 'WHERE ' + scope.clause : ''}
        ORDER BY
            CASE WHEN n.hm_number IS NOT NULL THEN 0 ELSE 1 END,
            COALESCE(n.bed_no, ''),
            p.name
    `, scope.params);

    const opts = r.rows.map(p => {
        const statusText = p.pair_status === 'paired'
            ? `PAIR | BED ${p.bed_no || '-'} | DEV #${p.device_no || '-'}`
            : 'ยังไม่ได้ Pair';

        return `
            <option value="${p.hm_number}">
                [${statusText}] ${p.name} (${p.hm_number})
            </option>
        `;
    }).join('');

    res.send(ui(req.user, 'export', `
        <h2 class="text-2xl font-black text-slate-800 uppercase mb-8">Export Data</h2>
        <div class="card p-8 shadow-xl max-w-2xl">
            <div class="space-y-4">
                <label class="text-xs font-bold text-slate-400">เลือกคนไข้</label>
                <select id="e-hn" class="w-full border p-4 rounded-2xl bg-slate-50 outline-none">
                    ${opts}
                </select>

                <div class="grid grid-cols-2 gap-4">
                    <div>
                        <label class="text-[10px] font-bold text-slate-400">เริ่มวันที่</label>
                        <input id="e-start" type="datetime-local" class="w-full border p-4 rounded-2xl bg-slate-50">
                    </div>
                    <div>
                        <label class="text-[10px] font-bold text-slate-400">ถึงวันที่</label>
                        <input id="e-stop" type="datetime-local" class="w-full border p-4 rounded-2xl bg-slate-50">
                    </div>
                </div>

                <button onclick="doExp()" class="w-full bg-slate-900 text-white p-4 rounded-2xl font-bold">
                    GENERATE CSV
                </button>
            </div>
        </div>
    `, `
        const now = new Date();
        const tzOffset = now.getTimezoneOffset() * 60000;

        document.getElementById('e-start').value =
            new Date(Date.now() - 86400000 - tzOffset).toISOString().slice(0, 16);

        document.getElementById('e-stop').value =
            new Date(Date.now() - tzOffset).toISOString().slice(0, 16);

        function csvCell(value) {
            const text = value === null || value === undefined ? '' : String(value);
            if (text.includes('"') || text.includes(',') || text.includes('\\n') || text.includes('\\r')) {
                return '"' + text.replace(/"/g, '""') + '"';
            }
            return text;
        }

        async function doExp() {
            try {
                const el = document.getElementById('e-hn');
                const hn = el.value;
                const fullText = el.options[el.selectedIndex].text.trim();
                const sanitizedInfo = fullText.replace(/[^a-zA-Z0-9ก-๙]/g, '_');

                const start = document.getElementById('e-start').value;
                const stop = document.getElementById('e-stop').value;

                if (!hn) return alert('กรุณาเลือกคนไข้');
                if (!start || !stop) return alert('กรุณาเลือกช่วงเวลา');

                const startDate = new Date(start);
                const stopDate = new Date(stop);
                if (Number.isNaN(startDate.getTime()) || Number.isNaN(stopDate.getTime())) {
                    return alert('รูปแบบวันที่ไม่ถูกต้อง');
                }
                if (startDate >= stopDate) {
                    return alert('วันเริ่มต้นต้องมาก่อนวันสิ้นสุด');
                }

                const url = '/api/export-data?hn=' + encodeURIComponent(hn) +
                    '&start=' + encodeURIComponent(startDate.toISOString()) +
                    '&stop=' + encodeURIComponent(stopDate.toISOString());

                const response = await fetch(url);
                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data && data.error ? data.error : 'Export API error');
                }

                if (!data || data.length === 0) {
                    alert('ไม่พบข้อมูลของคนไข้ท่านนี้ในช่วงเวลาที่เลือก\\nหมายเหตุ: คนไข้ที่ยังไม่เคย pair หรือยังไม่มี vital logs จะไม่มีข้อมูลให้ export');
                    return;
                }

                let csv = "\\uFEFFTime,HN,Name,HR,SpO2,Temp\\n";

                data.forEach(i => {
                    csv += [
                        csvCell(i._time_str),
                        csvCell(i.hm_number || hn),
                        csvCell(i.patient_name || '--'),
                        csvCell(i.ble_heart || '--'),
                        csvCell(i.ble_spo2 || '--'),
                        csvCell(i.ble_temp || '--')
                    ].join(',') + '\\n';
                });

                const d = new Date();
                const dateStr = d.getDate() + "-" + (d.getMonth() + 1) + "-" + (d.getFullYear() + 543);
                const fileName = "Report_" + sanitizedInfo + "_" + dateStr + ".csv";

                const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
                const link = document.createElement("a");

                link.href = URL.createObjectURL(blob);
                link.download = fileName;

                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                setTimeout(() => URL.revokeObjectURL(link.href), 1000);

            } catch (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            }
        }
    `));
});

app.get('/api/export-data', async (req, res) => {
    const { hn, start, stop } = req.query;
    if (!hn) {
        return res.status(400).json({ error: 'กรุณาเลือกคนไข้' });
    }
    if (!start || !stop) {
        return res.status(400).json({ error: 'กรุณาเลือกช่วงเวลา' });
    }

    const startDate = parseExportDate(start);
    const stopDate = parseExportDate(stop);
    if (!startDate || !stopDate) {
        return res.status(400).json({ error: 'รูปแบบวันที่ไม่ถูกต้อง' });
    }
    if (startDate >= stopDate) {
        return res.status(400).json({ error: 'วันเริ่มต้นต้องมาก่อนวันสิ้นสุด' });
    }

    try {
        const patientResult = await pool.query(`
            SELECT p.name, p.ward_id, n.mac
            FROM patients p
            LEFT JOIN nurseaid n ON n.hm_number = p.hn_number
            WHERE p.hn_number = $1
            ORDER BY CASE WHEN n.mac IS NOT NULL AND n.mac <> '' THEN 0 ELSE 1 END
            LIMIT 1
        `, [hn]);

        if (patientResult.rows.length === 0) {
            return res.status(404).json({ error: 'ไม่พบคนไข้' });
        }

        const patient = patientResult.rows[0];

        if (req.user.role !== 'super_admin') {
            const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
            if (!patient.ward_id || !wardIds.includes(patient.ward_id)) {
                return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงข้อมูลคนไข้รายนี้' });
            }
        }

        const macNormalized = normalizeMac(patient.mac);

        // InfluxDB is the primary time-series source. Aggregating to one row
        // per minute aligns measurements written a few milliseconds apart.
        if (macNormalized) {
            const influxQuery = `
                import "strings"

                from(bucket: "${influxConfig.bucket}")
                    |> range(
                        start: time(v: "${startDate.toISOString()}"),
                        stop: time(v: "${stopDate.toISOString()}")
                    )
                    |> filter(fn: (r) =>
                        r._measurement == "ble_heart" or
                        r._measurement == "ble_spo2" or
                        r._measurement == "ble_temp"
                    )
                    |> filter(fn: (r) => exists r.mac and strings.toLower(v: r.mac) == "${escapeFluxString(macNormalized)}")
                    |> aggregateWindow(every: 1m, fn: last, createEmpty: false)
                    |> yield(name: "last")
            `;

            try {
                const influxRows = await queryApi.collectRows(influxQuery);
                const grouped = {};

                for (const row of influxRows) {
                    const value = Number(row._value);
                    if (!Number.isFinite(value) || value <= 0) continue;

                    const time = new Date(row._time);
                    if (Number.isNaN(time.getTime())) continue;

                    const key = time.toISOString();
                    if (!grouped[key]) {
                        grouped[key] = {
                            _time: key,
                            _time_str: formatExportDateTime(time),
                            hm_number: hn,
                            patient_name: patient.name || '',
                            ble_heart: null,
                            ble_spo2: null,
                            ble_temp: null
                        };
                    }

                    if (row._measurement === 'ble_heart') grouped[key].ble_heart = Math.round(value);
                    if (row._measurement === 'ble_spo2') grouped[key].ble_spo2 = Math.round(value * 10) / 10;
                    if (row._measurement === 'ble_temp') grouped[key].ble_temp = Math.round(value * 100) / 100;
                }

                const exportRows = Object.values(grouped)
                    .filter(row => row.ble_heart !== null || row.ble_spo2 !== null || row.ble_temp !== null)
                    .sort((a, b) => new Date(a._time) - new Date(b._time));

                if (exportRows.length > 0) {
                    console.log(`[Export] HN=${hn} MAC=${patient.mac} InfluxDB returned ${exportRows.length} rows`);
                    return res.json(exportRows);
                }
            } catch (influxErr) {
                console.warn(`[Export] InfluxDB query failed for HN=${hn}; using Postgres fallback:`, influxErr.message);
            }
        }

        // Fallback for unpaired patients or existing PostgreSQL history.
        const queryText = `
            SELECT
                to_char(date_trunc('second', recorded_at), 'DD/MM/YYYY HH24:MI:SS') as _time_str,
                hm_number,
                patient_name,
                MAX(heart_rate) as ble_heart,
                MAX(spo2) as ble_spo2,
                MAX(temperature) as ble_temp
            FROM vital_signs_logs
            WHERE hm_number = $1
            AND recorded_at >= $2::timestamp
            AND recorded_at <= $3::timestamp
            GROUP BY date_trunc('second', recorded_at), hm_number, patient_name
            ORDER BY date_trunc('second', recorded_at) ASC
        `;
        const result = await pool.query(queryText, [hn, startDate, stopDate]);
        res.json(result.rows);
    } catch (err) {
        console.error("Export Error:", err);
        res.status(500).json({ error: err.message });
    }
});

app.get('/devices-mgmt', requireCapability('devices:write'), async (req, res) => {
    await ensureDeviceTypeColumn();
    // Unpaired devices are a shared hardware pool (visible to every ward so they can
    // be picked up for pairing); devices already paired to a patient belong to that
    // patient's ward for display purposes, so a ward_admin shouldn't see — or be able
    // to rename/retype — hardware actively in use by another ward.
    const scope = await wardScopeSql(req, 'ward_id', 1);
    const r = await pool.query(
        `SELECT * FROM nurseaid
         WHERE mac IS NOT NULL AND mac != ''
         ${scope.clause ? `AND (NULLIF(BTRIM(hm_number), '') IS NULL OR ${scope.clause})` : ''}
         ORDER BY device_no`,
        scope.params
    );

    // Latest battery reading per device, so staff can see charge status here
    // without opening each patient's dashboard. Best-effort: InfluxDB being
    // unreachable should not block this page from loading. Mirrors the
    // battery lookup in queryLiveStatuses() (unfiltered by mac, matched in
    // JS) since devices here include unpaired stock that has no hm_number.
    const batteryByMac = new Map();
    try {
        const deviceBatteryFluxQuery = `
            from(bucket: "${influxConfig.bucket}")
                |> range(start: -${LIVE_BATTERY_QUERY_WINDOW_MINUTES}m)
                |> filter(fn: (r) => r._measurement == "ble_batt" and r._field == "value")
                |> group(columns: ["mac"])
                |> last()`;
        const batteryRows = await queryApi.collectRows(deviceBatteryFluxQuery);
        const nowMs = Date.now();
        for (const row of batteryRows) {
            const mac = normalizeMac(row.mac);
            const value = parseInt(row._value, 10);
            const ageSeconds = Math.max(0, Math.floor((nowMs - new Date(row._time).getTime()) / 1000));
            if (!mac || isNaN(value) || ageSeconds > LIVE_FRESHNESS_POLICY.battery) continue;
            batteryByMac.set(mac, value);
        }
    } catch (error) {
        console.warn(`[Devices] Battery query unavailable: ${error.message}`);
    }

    const rows = r.rows.map(d => {
        const battery = batteryByMac.get(normalizeMac(d.mac));
        const battCell = battery === undefined
            ? '<span class="text-slate-300 text-xs">ไม่ทราบแบต</span>'
            : `<span class="inline-flex items-center gap-1 font-bold text-xs ${battery === 0 ? 'text-gray-400' : (battery < 20 ? 'text-red-500' : (battery < 40 ? 'text-orange-500' : 'text-emerald-600'))}">🔋 ${battery}%</span>`;
        return `<tr><td class="font-bold">#${escapeHtml(d.device_no)}</td><td><span class="px-2 py-1 rounded-lg text-[10px] font-bold ${d.device_type === 'wearos' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-700'}">${escapeHtml(d.device_type || 'jstyle')}</span></td><td class="font-mono text-slate-400 text-xs">${escapeHtml(d.mac)}</td><td>${battCell}</td><td class="text-right admin-only"><button onclick="editD('${escapeJsSingle(d.mac)}','${escapeJsSingle(d.device_no)}','${escapeJsSingle(d.device_type || 'jstyle')}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delD('${escapeJsSingle(d.mac)}')" class="text-red-400 font-bold">ลบ</button></td></tr>`;
    }).join('');
    res.send(ui(req.user, 'devs', `
        <div class="grid md:grid-cols-3 gap-8">
            <div class="admin-only card p-6 h-fit">
                <h3 class="font-bold mb-6">📟 เพิ่มอุปกรณ์</h3>
                <div class="space-y-4">
                    <input id="dno" placeholder="Device No" class="w-full border p-3 rounded-xl bg-slate-50">
                    <div class="device-address-row flex gap-2">
                        <input id="m_addr" placeholder="MAC Address" class="flex-1 border p-3 rounded-xl bg-slate-50">
                        <button onclick="openQRScanner()" class="px-4 py-3 rounded-xl font-bold text-white shadow-lg transition-all hover:scale-105 active:scale-95 bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 flex items-center gap-2" title="สแกน QR Code">
                            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"></path>
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"></path>
                            </svg>
                            Scan QR
                        </button>
                    </div>
                    <select id="dtype" class="w-full border p-3 rounded-xl bg-slate-50">
                        <option value="jstyle">JStyle / iStyle Watch</option>
                        <option value="wearos">Wear OS Peripheral</option>
                    </select>
                    <button onclick="addD()" class="w-full bg-slate-800 text-white p-4 rounded-xl font-bold hover:bg-slate-900 transition-colors">เพิ่ม</button>
                </div>
            </div>
            <div class="md:col-span-2 card overflow-hidden">
                <table><thead><tr><th>No</th><th>Type</th><th>MAC / Device ID</th><th>Battery</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>
    `, `
        window.addD = async () => {
            const response = await fetch('/api/devices', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({dno:document.getElementById('dno').value, mac:document.getElementById('m_addr').value, device_type:document.getElementById('dtype').value})
            });
            if (!response.ok) return alert(await apiErrorMessage(response, 'ไม่สามารถเพิ่มอุปกรณ์ได้'));
            location.reload();
        };
        window.editD = (mac, dno, dtype) => {
            openModal('✏️ แก้ไข', '<input id="edno" value="'+escapeHTML(dno)+'" class="w-full border p-3 rounded-xl bg-slate-50 mb-3"><select id="edtype" class="w-full border p-3 rounded-xl bg-slate-50"><option value="jstyle" '+(dtype==='jstyle'?'selected':'')+'>JStyle / iStyle Watch</option><option value="wearos" '+(dtype==='wearos'?'selected':'')+'>Wear OS Peripheral</option></select>', async () => {
                const response = await fetch('/api/devices/update', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({mac, newDno:document.getElementById('edno').value, device_type:document.getElementById('edtype').value})
                });
                if (!response.ok) return alert(await apiErrorMessage(response, 'ไม่สามารถแก้ไขอุปกรณ์ได้'));
                location.reload();
            });
        };
        window.delD = async (mac) => {
            if (!confirm('ลบ?')) return;
            const response = await fetch('/api/devices/' + encodeURIComponent(mac), {method:'DELETE'});
            if (!response.ok) return alert(await apiErrorMessage(response, 'ไม่สามารถลบอุปกรณ์ได้'));
            location.reload();
        };

        // QR Scanner Functions
        let html5QrCode = null;
        let scannerRunning = false;

        window.openQRScanner = async () => {
            // Create modal if not exists
            if (!document.getElementById('qr-scanner-modal')) {
                const modal = document.createElement('div');
                modal.id = 'qr-scanner-modal';
                modal.className = 'modal';
                modal.innerHTML = \`
                    <div class="p-8 rounded-3xl w-full max-w-lg shadow-2xl transition-all" style="background: var(--bg-card); border: 2px solid var(--accent-primary);">
                        <div class="flex justify-between items-center mb-6">
                            <h3 class="text-xl font-bold" style="color: var(--text-primary);">📷 สแกน QR Code</h3>
                            <button onclick="closeQRScanner()" class="p-2 rounded-xl transition-all" style="background: var(--bg-badge); color: var(--text-secondary);">✕</button>
                        </div>
                        <div id="qr-reader" style="width: 100%;"></div>
                        <div id="qr-result" class="mt-4 p-4 rounded-xl" style="background: var(--bg-input); border: 1px solid var(--border-color); display: none;">
                            <p class="text-xs font-bold mb-2" style="color: var(--text-secondary);">ผลลัพธ์:</p>
                            <p id="qr-result-text" class="font-mono text-sm break-all" style="color: var(--text-primary);"></p>
                        </div>
                        <div class="flex gap-3 mt-6">
                            <button onclick="closeQRScanner()" class="flex-1 p-3 rounded-xl font-bold" style="background: var(--bg-badge); color: var(--text-secondary); border: 1px solid var(--border-color);">ปดกล้อง</button>
                        </div>
                    </div>
                \`;
                document.body.appendChild(modal);
            }

            document.getElementById('qr-scanner-modal').style.display = 'flex';
            document.getElementById('qr-result').style.display = 'none';

            // Initialize scanner
            html5QrCode = new Html5Qrcode("qr-reader");

            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(device => device.kind === 'videoinput');

                if (videoDevices.length === 0) {
                    alert('ไมพ่บกล้อง');
                    closeQRScanner();
                    return;
                }

                // Use back camera if available
                const backCamera = videoDevices.find(d => d.label.toLowerCase().includes('back')) || videoDevices[0];

                await html5QrCode.start(
                    { facingMode: "environment" },
                    {
                        fps: 10,
                        qrbox: { width: 250, height: 250 },
                        aspectRatio: 1.0
                    },
                    (decodedText) => {
                        // QR Code scanned successfully
                        onQRScanSuccess(decodedText);
                    },
                    (errorMessage) => {
                        // Scanning failed, ignore
                    }
                );

                scannerRunning = true;
            } catch (err) {
                console.error('Camera error:', err);
                alert('ไมส่ามารถเปิดกล้องได้: ' + err.message);
                closeQRScanner();
            }
        };

        function onQRScanSuccess(text) {
            // Stop scanner
            closeQRScanner();

            // Fill the MAC address field
            const mAddrInput = document.getElementById('m_addr');
            if (mAddrInput) {
                mAddrInput.value = text;
                mAddrInput.focus();
                mAddrInput.scrollIntoView({ behavior: 'smooth', block: 'center' });

                // Show success feedback
                const resultDiv = document.getElementById('qr-result');
                const resultText = document.getElementById('qr-result-text');
                if (resultDiv && resultText) {
                    resultText.textContent = text;
                    resultDiv.style.display = 'block';
                    resultDiv.style.borderColor = 'var(--accent-green)';
                }

                // Auto scroll to MAC address field
                mAddrInput.classList.add('ring-4');
                setTimeout(() => mAddrInput.classList.remove('ring-4'), 2000);
            }
        }

        window.closeQRScanner = () => {
            if (html5QrCode && scannerRunning) {
                html5QrCode.stop().then(() => {
                    html5QrCode.clear();
                    scannerRunning = false;
                }).catch(err => {
                    console.error('Error stopping scanner:', err);
                    scannerRunning = false;
                });
            }
            const modal = document.getElementById('qr-scanner-modal');
            if (modal) {
                modal.style.display = 'none';
            }
        };
    `));
});


app.post('/api/devices', requireCapability('devices:write'), async (req, res) => {
    const deviceNo = String(req.body.dno || '').trim();
    const mac = String(req.body.mac || '').trim();
    const deviceType = String(req.body.device_type || 'jstyle').trim().toLowerCase();
    if (!deviceNo || !mac || deviceNo.length > 50 || mac.length > 50 || !MANAGED_DEVICE_TYPES.has(deviceType)) {
        return res.status(400).json({ error: 'Invalid device data' });
    }
    try {
        const duplicate = await pool.query(
            'SELECT 1 FROM nurseaid WHERE LOWER(mac)=LOWER($1) LIMIT 1',
            [mac]
        );
        if (duplicate.rows.length) return res.status(409).json({ error: 'Device already exists' });
        await pool.query(
            'INSERT INTO nurseaid (device_no, mac, device_type) VALUES ($1,$2,$3)',
            [deviceNo, mac, deviceType]
        );
        res.json({ success: true });
    } catch (error) {
        console.error('[Device Create]', error.message);
        res.status(500).json({ error: 'Unable to create device' });
    }
});

app.post('/api/devices/update', requireCapability('devices:write'), async (req, res) => {
    // Ward now lives on the patient (see patients.ward_id / /patients-mgmt), not the device —
    // devices are a shared hardware pool and pick up a ward automatically when paired
    // (see /api/pair, /api/change-device). This endpoint intentionally does not touch ward_id.
    const mac = String(req.body.mac || '').trim();
    const deviceNo = String(req.body.newDno || '').trim();
    const deviceType = String(req.body.device_type || 'jstyle').trim().toLowerCase();
    if (!mac || !deviceNo || deviceNo.length > 50 || !MANAGED_DEVICE_TYPES.has(deviceType)) {
        return res.status(400).json({ error: 'Invalid device data' });
    }
    try {
        // Unpaired devices are shared and editable by any ward; a device that's
        // currently paired to a patient belongs (for editing purposes) to that
        // patient's ward — a ward_admin shouldn't be able to rename/retype hardware
        // actively serving another ward's patient.
        if (req.user.role === 'ward_admin') {
            const existing = await pool.query(
                'SELECT hm_number, ward_id FROM nurseaid WHERE LOWER(mac)=LOWER($1)', [mac]
            );
            if (!existing.rows.length) return res.status(404).json({ error: 'Device not found' });
            const isPaired = Boolean(existing.rows[0].hm_number && existing.rows[0].hm_number.trim());
            if (isPaired) {
                const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
                if (!existing.rows[0].ward_id || !wardIds.includes(existing.rows[0].ward_id)) {
                    return res.status(403).json({ error: 'Cannot manage a device paired to another ward' });
                }
            }
        }
        const result = await pool.query(
            `UPDATE nurseaid SET device_no=$1, device_type=$2 WHERE LOWER(mac)=LOWER($3) RETURNING id, ward_id`,
            [deviceNo, deviceType, mac]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Device not found' });
        logAudit(req, 'UPDATE', 'device', mac, { device_no: deviceNo, ward_id: result.rows[0].ward_id }).catch(console.error);
        res.json({ success: true });
    } catch (error) {
        console.error('[Device Update]', error.message);
        res.status(500).json({ error: 'Unable to update device' });
    }
});

app.delete('/api/devices/:mac', requireCapability('devices:write'), async (req, res) => {
    const mac = String(req.params.mac || '').trim();
    if (!mac) return res.status(400).json({ error: 'Device address required' });
    try {
        const result = await pool.query(
            `DELETE FROM nurseaid
             WHERE LOWER(mac)=LOWER($1) AND NULLIF(BTRIM(hm_number), '') IS NULL
             RETURNING id`,
            [mac]
        );
        if (result.rows.length) return res.json({ success: true });
        const existing = await pool.query('SELECT hm_number FROM nurseaid WHERE LOWER(mac)=LOWER($1)', [mac]);
        if (!existing.rows.length) return res.status(404).json({ error: 'Device not found' });
        return res.status(409).json({ error: 'Unpair the patient before deleting this device' });
    } catch (error) {
        console.error('[Device Delete]', error.message);
        res.status(500).json({ error: 'Unable to delete device' });
    }
});

// ─── User Management ───────────────────────────────────────────────
app.get('/users-mgmt', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    let wards = [];
    if (req.user.role === 'super_admin' || req.user.role === 'admin') {
        wards = (await pool.query('SELECT id, name FROM wards')).rows;
    } else {
        const w = await pool.query('SELECT w.id, w.name FROM wards w JOIN user_wards uw ON w.id=uw.ward_id WHERE uw.user_id=$1', [req.user.id]);
        wards = w.rows;
    }
    // Native <select multiple> listboxes are a common source of accidental
    // multi-selection/deselection — use plain checkboxes instead, which are
    // unambiguous about what's checked.
    const wardChecks = wards.map(w => `<label class="flex items-center gap-2 text-xs font-normal"><input type="checkbox" value="${w.id}"> ${escapeHtml(w.name)}</label>`).join('');
    // A ward_admin scoped to exactly one ward is always creating a user *for* that
    // ward — don't make them tick it every time. Lock it pre-checked (the backend
    // unions it in regardless per /api/users, so this is just matching the UI to
    // what already happens). Editing an existing user stays a free choice, since
    // removing someone from your ward is a legitimate thing to do there.
    const lockedWardId = (req.user.role !== 'super_admin' && req.user.role !== 'admin' && wards.length === 1)
        ? wards[0].id
        : null;
    const wardChecksForCreate = wards.map(w => {
        const locked = lockedWardId === w.id;
        return `<label class="flex items-center gap-2 text-xs font-normal"><input type="checkbox" value="${w.id}" ${locked ? 'checked disabled' : ''}> ${escapeHtml(w.name)}</label>`;
    }).join('');

    // Restrict role options based on current user's role
    let addRoleOptions, editRoleOptions;
    if (req.user.role === 'super_admin') {
        addRoleOptions = '<option value="viewer">Viewer</option><option value="staff_nurse" selected>Staff Nurse</option><option value="ward_admin">Ward Admin</option><option value="super_admin">Super Admin</option>';
        editRoleOptions = '<option value="viewer">Viewer</option><option value="staff_nurse">Staff Nurse</option><option value="ward_admin">Ward Admin</option><option value="super_admin">Super Admin</option>';
    } else {
        // ward_admin can only assign staff_nurse and viewer
        addRoleOptions = '<option value="viewer">Viewer</option><option value="staff_nurse" selected>Staff Nurse</option>';
        editRoleOptions = '<option value="viewer">Viewer</option><option value="staff_nurse">Staff Nurse</option>';
    }

    // ward_admin only manages/sees users who share at least one of their wards —
    // full roster stays visible to super_admin/admin only.
    const isFullAdmin = req.user.role === 'super_admin' || req.user.role === 'admin';
    const wardFilterClause = isFullAdmin
        ? ''
        : `WHERE u.id IN (SELECT user_id FROM user_wards WHERE ward_id = ANY($1))`;
    const r = await pool.query(`SELECT u.id, u.username, u.full_name, u.role, u.created_at, array_agg(w.name) as user_wards
                                FROM users u
                                LEFT JOIN user_wards uw ON u.id = uw.user_id
                                LEFT JOIN wards w ON uw.ward_id = w.id
                                ${wardFilterClause}
                                GROUP BY u.id ORDER BY u.created_at DESC`,
                                isFullAdmin ? [] : [req.user.wardIds || await getUserWardIds(req.user.id)]);
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
    res.send(ui(req.user, 'users', `
        <h2 class="text-2xl font-black mb-6">🛡️ User Management</h2>
        <div class="space-y-6">
            <div class="card p-6">
                <h3 class="font-bold mb-4">➕ เพิ่มผู้ใช้ใหม่</h3>
                <div class="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
                    <div><label class="text-xs font-bold">Username</label><input id="u_user" placeholder="username" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Full Name</label><input id="u_name" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Password</label><input id="u_pass" type="password" placeholder="Password" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Role</label><select id="u_role" class="w-full border p-3 rounded-xl bg-slate-50">${addRoleOptions}</select></div>
                    <div><label class="text-xs font-bold">Wards</label><div id="u_wards" class="w-full border p-2 rounded-xl bg-slate-50 h-[46px] overflow-y-auto space-y-1">${wardChecksForCreate}</div></div>
                </div>
                ${lockedWardId ? '<p class="text-[10px] text-slate-400 mt-2">ผู้ใช้ใหม่จะถูกเพิ่มเข้า ward ของคุณโดยอัตโนมัติ</p>' : ''}
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
            const wards = Array.from(document.querySelectorAll('#u_wards input:checked')).map(el => parseInt(el.value));
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
            const wardChecksHtml = \`${wardChecks}\`;
            const roleOpts = \`${editRoleOptions}\`.replace('value="viewer"', 'value="viewer" ' + (currentRole === 'viewer' ? 'selected' : '')).replace('value="staff_nurse"', 'value="staff_nurse" ' + (currentRole === 'staff_nurse' || currentRole === 'operator' ? 'selected' : ''));
            const html = \`
                <div class="space-y-4">
                    <div><label class="text-xs font-bold">Username</label><input id="eu_user" value="\${escapeHTML(username)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Full Name</label><input id="eu_name" value="\${escapeHTML(fullName)}" class="w-full border p-3 rounded-xl bg-slate-50"></div>
                    <div><label class="text-xs font-bold">Role</label><select id="eu_role" class="w-full border p-3 rounded-xl bg-slate-50">\${roleOpts}</select></div>
                    <div><label class="text-xs font-bold">Wards</label><div id="eu_wards" class="w-full border p-2 rounded-xl bg-slate-50 max-h-[160px] overflow-y-auto space-y-1">\${wardChecksHtml}</div></div>
                </div>
            \`;
            openModal('✏️ แก้ไขผู้ใช้', html, async () => {
                const wards = Array.from(document.querySelectorAll('#eu_wards input:checked')).map(el => parseInt(el.value));
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
            // Pre-check the wards this user is currently assigned to — otherwise saving
            // without touching the Wards field would silently wipe their assignments.
            try {
                const wardsRes = await fetch('/api/users/' + id + '/wards');
                if (wardsRes.ok) {
                    const currentWards = new Set((await wardsRes.json()).map(w => w.ward_id));
                    document.querySelectorAll('#eu_wards input').forEach(el => {
                        el.checked = currentWards.has(parseInt(el.value));
                    });
                }
            } catch (_) { /* leave unchecked if this fails — better than blocking the modal */ }
        };
        window.resetUserPass = async (id, username) => {
            openModal('🔑 รีเซ็ตรหัสผ่าน — ' + username,
                '<div><label class="text-xs font-bold">Password ใหม่</label><input id="rup_pass" type="password" placeholder="Password" class="w-full border p-3 rounded-xl bg-slate-50"></div>',
                async () => {
                    const password = document.getElementById('rup_pass').value;
                    if (!password || password.length < 8) return alert('Password ต้องมีความยาวอย่างน้อย 8 ตัวอักษร');
                    try {
                        const r = await fetch('/api/users/' + id + '/password', {
                            method: 'PUT',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ password })
                        });
                        if (r.ok) { alert('เปลี่ยนรหัสผ่านสำเร็จ!'); document.getElementById('globalModal').style.display='none'; }
                        else { const e = await r.json(); alert('เกิดข้อผิดพลาด: ' + (e.error || 'Unknown error')); }
                    } catch(e) { alert('Connection error: ' + e.message); }
                }
            );
        };
        window.delUser = async (id, username) => {
            if (confirm('ยืนยันการลบผู้ใช้ "' + username + '"?')) {
                try {
                    const r = await fetch('/api/users/' + id, { method: 'DELETE' });
                    if (r.ok) { location.reload(); }
                    else { const e = await r.json(); alert('เกิดข้อผิดพลาด: ' + (e.error || 'Unknown error')); }
                } catch(e) { alert('Connection error: ' + e.message); }
            }
        };
    `));
});

app.post('/api/users', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.full_name || '').trim();
    const password = String(req.body.password || '');
    const role = String(req.body.role || 'viewer').trim().toLowerCase();
    const wards = Array.isArray(req.body.wards) ? req.body.wards : [];
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    
    // Accept only proper roles or backward compatibility
    const validRoles = new Set(['super_admin', 'ward_admin', 'staff_nurse', 'viewer', 'admin', 'operator']);
    if (username.length > 50 || fullName.length > 100 || !validRoles.has(role)) {
        return res.status(400).json({ error: 'Invalid user data' });
    }
    
    // ward_admin cannot grant super_admin or ward_admin roles
    if (req.user.role === 'ward_admin' && ['super_admin', 'ward_admin'].includes(role)) {
        return res.status(403).json({ error: 'Ward admins cannot assign elevated roles' });
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
        // ward_admin can only assign their own wards, and their own ward(s) are always
        // included automatically — otherwise a ward_admin who forgets to tick the Wards
        // box would create a user they can then no longer see or manage themselves.
        let effectiveWards = wards;
        if (req.user.role === 'ward_admin') {
            const allowedWards = await client.query(
                'SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]
            );
            const allowedIds = allowedWards.rows.map(r => r.ward_id);
            const invalidWards = wards.filter(w => !allowedIds.includes(w));
            if (invalidWards.length) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Cannot assign wards you do not have access to' });
            }
            effectiveWards = Array.from(new Set([...wards, ...allowedIds]));
        }
        for (const w of effectiveWards) {
            await client.query('INSERT INTO user_wards (user_id, ward_id, role_in_ward, granted_by) VALUES ($1, $2, $3, $4)', [newUserId, w, role, req.user.id]);
        }
        await client.query('COMMIT');
        logAudit(req, 'CREATE', 'user', newUserId, { username, role, wards: effectiveWards }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.put('/api/users/:id', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const username = String(req.body.username || '').trim();
    const fullName = String(req.body.full_name || '').trim();
    const role = String(req.body.role || '').trim().toLowerCase();
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
    if (!username) return res.status(400).json({ error: 'Username required' });
    const validRoles = new Set(['super_admin', 'ward_admin', 'staff_nurse', 'viewer', 'admin', 'operator']);
    if (username.length > 50 || fullName.length > 100 || !validRoles.has(role)) {
        return res.status(400).json({ error: 'Invalid user data' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        const current = await client.query('SELECT role FROM users WHERE id=$1', [id]);
        if (!current.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        if (!(await userSharesWardWithCaller(req, id))) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Cannot manage a user outside your ward' });
        }
        if (['super_admin'].includes(current.rows[0].role) && !['super_admin'].includes(role)) {
            const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role='super_admin'");
            if (adminCount.rows[0].count <= 1) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Cannot demote the last super admin' });
            }
        }
        if (req.user.role === 'ward_admin' && ['super_admin', 'ward_admin'].includes(role)) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Ward admins cannot assign elevated roles' });
        }
        // ward_admin cannot change another user's wards to a ward they don't have access to
        if (req.user.role === 'ward_admin' && req.body.wards) {
            const allowedWards = await client.query(
                'SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]
            );
            const allowedIds = new Set(allowedWards.rows.map(r => r.ward_id));
            const invalidWards = req.body.wards.filter(w => !allowedIds.has(w));
            if (invalidWards.length) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Cannot assign wards you do not have access to' });
            }
        }
        await client.query(
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
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.put('/api/users/:id/password', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const password = String(req.body.password || '');
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (!(await userSharesWardWithCaller(req, id))) {
        return res.status(403).json({ error: 'Cannot manage a user outside your ward' });
    }
    try {
        const hashed = await hashPassword(password);
        const result = await pool.query(
            `UPDATE users SET password=$1, session_version=session_version+1
             WHERE id=$2 RETURNING id`,
            [hashed, id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/users/:id', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid user id' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE');
        const check = await client.query('SELECT role FROM users WHERE id=$1', [id]);
        if (check.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'User not found' });
        }
        if (!(await userSharesWardWithCaller(req, id))) {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Cannot manage a user outside your ward' });
        }
        if (['super_admin', 'admin'].includes(check.rows[0].role)) {
            const adminCount = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role IN ('super_admin','admin')");
            if (adminCount.rows[0].count <= 1) {
                await client.query('ROLLBACK');
                return res.status(409).json({ error: 'Cannot delete the last super admin' });
            }
        }
        const priorWards = await client.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [id]);
        await client.query('DELETE FROM user_wards WHERE user_id=$1', [id]);
        await client.query('DELETE FROM user_notification_settings WHERE user_id=$1', [id]);
        await client.query('DELETE FROM users WHERE id=$1', [id]);
        await client.query('COMMIT');
        logAudit(req, 'DELETE', 'user', id, { wards: priorWards.rows.map(r => r.ward_id) }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

// ─── User-Wards Assignment Endpoints ─────────────────────────────────
app.get('/api/users/:id/wards', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid user ID' });
    if (!(await userSharesWardWithCaller(req, id))) {
        return res.status(403).json({ error: 'Cannot view a user outside your ward' });
    }

    try {
        const result = await pool.query(
            `SELECT uw.ward_id, w.name as ward_name, w.code as ward_code
             FROM user_wards uw
             JOIN wards w ON w.id = uw.ward_id
             WHERE uw.user_id = $1
             ORDER BY w.code`,
            [id]
        );
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/user-wards', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const { user_id, ward_id } = req.body;
    if (!user_id || !ward_id) return res.status(400).json({ error: 'user_id and ward_id are required' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // ward_admin can only assign their own wards
        if (req.user.role === 'ward_admin') {
            const wardCheck = await client.query(
                'SELECT 1 FROM user_wards WHERE user_id=$1 AND ward_id=$2',
                [req.user.id, ward_id]
            );
            if (!wardCheck.rows.length) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Cannot assign ward you do not have access to' });
            }
        }
        
        await client.query(
            'INSERT INTO user_wards (user_id, ward_id, granted_at) VALUES ($1, $2, NOW()) ON CONFLICT DO NOTHING',
            [user_id, ward_id]
        );
        
        await client.query('COMMIT');
        logAudit(req, 'ASSIGN_WARD', 'user', user_id, { ward_id }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.delete('/api/user-wards', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    const { user_id, ward_id } = req.body;
    if (!user_id || !ward_id) return res.status(400).json({ error: 'user_id and ward_id are required' });
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // ward_admin can only remove from their own wards
        if (req.user.role === 'ward_admin') {
            const wardCheck = await client.query(
                'SELECT 1 FROM user_wards WHERE user_id=$1 AND ward_id=$2',
                [req.user.id, ward_id]
            );
            if (!wardCheck.rows.length) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Cannot remove from ward you do not have access to' });
            }
        }
        
        await client.query(
            'DELETE FROM user_wards WHERE user_id=$1 AND ward_id=$2',
            [user_id, ward_id]
        );
        
        await client.query('COMMIT');
        logAudit(req, 'REMOVE_WARD', 'user', user_id, { ward_id }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.get('/patients-mgmt', requireCapability('patients:write'), async (req, res) => {
    const scope = await wardScopeSql(req, 'p.ward_id', 1);
    const r = await pool.query(
        `SELECT p.*, w.name as ward_name, w.code as ward_code
         FROM patients p
         LEFT JOIN wards w ON w.id = p.ward_id
         WHERE p.name IS NOT NULL AND p.name != '' AND p.hn_number IS NOT NULL AND p.hn_number != ''
         ${scope.clause ? 'AND ' + scope.clause : ''}
         ORDER BY p.name`,
        scope.params
    );
    // Wards this user is allowed to place a patient into: all active wards for
    // super_admin, only their own assigned ward(s) otherwise.
    const allowedWardsResult = req.user.role === 'super_admin'
        ? await pool.query('SELECT id, code, name FROM wards WHERE is_active = true ORDER BY code')
        : await pool.query('SELECT id, code, name FROM wards WHERE is_active = true AND id = ANY($1) ORDER BY code', [req.user.wardIds]);
    // A ward_admin scoped to exactly one ward doesn't need to (and shouldn't have to)
    // pick a ward at all — lock the dropdown to it. Free choice stays super_admin-only;
    // a ward_admin covering multiple wards still picks among just their own.
    const lockedWardId = req.user.role !== 'super_admin' && allowedWardsResult.rows.length === 1
        ? allowedWardsResult.rows[0].id
        : null;
    const wardOpts = allowedWardsResult.rows.map(w => `<option value="${w.id}" ${lockedWardId === w.id ? 'selected' : ''}>${escapeHtml(w.code)} - ${escapeHtml(w.name)}</option>`).join('');
    const wardSelectAttrs = lockedWardId ? 'disabled' : '';

    const rows = r.rows.map(p => `<tr><td class="font-bold text-blue-600">${escapeHtml(p.hn_number)}</td><td>${escapeHtml(p.name)}</td><td class="text-xs">${escapeHtml(p.ward_code || '-')}</td><td class="text-right"><button onclick="editP('${escapeJsSingle(p.hn_number)}','${escapeJsSingle(p.name)}',${p.ward_id ?? 'null'})" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delP('${escapeJsSingle(p.hn_number)}')" class="text-red-500 font-bold">ลบ</button></td></tr>`).join('');
    res.send(ui(req.user, 'pats', `
        <div class="grid md:grid-cols-3 gap-8">
            <div class="admin-only card p-6 h-fit">
                <h3 class="font-bold mb-6">👥 เพิ่มคนไข้</h3>
                <div class="space-y-4">
                    <input id="p_hn" placeholder="HN" class="w-full border p-3 rounded-xl bg-slate-50">
                    <input id="p_nm" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50">
                    <select id="p_ward" class="w-full border p-3 rounded-xl bg-slate-50" ${wardSelectAttrs}>
                        <option value="">เลือก Ward *</option>
                        ${wardOpts}
                    </select>
                    ${lockedWardId ? '<p class="text-[10px] text-slate-400">คนไข้จะถูกเพิ่มเข้า ward ของคุณโดยอัตโนมัติ</p>' : ''}
                    <button onclick="addP()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button>
                </div>
            </div>
            <div class="md:col-span-2 card overflow-hidden">
                <table><thead><tr><th>HN</th><th>Name</th><th>Ward</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>
    `, `
        const wardOptsForPatients = \`${wardOpts}\`;
        const wardSelectLocked = ${lockedWardId ? 'true' : 'false'};
        window.addP = async () => {
            const wardId = document.getElementById('p_ward').value;
            if (!wardId) return alert('กรุณาเลือก Ward');
            const response = await fetch('/api/patients', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({hn:document.getElementById('p_hn').value, nm:document.getElementById('p_nm').value, ward_id: wardId})
            });
            if (!response.ok) return alert(await apiErrorMessage(response, 'ไม่สามารถเพิ่มผู้ป่วยได้'));
            location.reload();
        };
        window.editP = (hn, name, wardId) => {
            openModal('✏️ แก้ไข', \`
                <input id="enm" value="\${escapeHTML(name)}" class="w-full border p-3 rounded-xl bg-slate-50 mb-3">
                <select id="ew_ward" class="w-full border p-3 rounded-xl bg-slate-50">\${wardOptsForPatients}</select>
            \`, async () => {
                const response = await fetch('/api/patients/update', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({hn, newName:document.getElementById('enm').value, ward_id: document.getElementById('ew_ward').value})
                });
                if (!response.ok) return alert(await apiErrorMessage(response, 'ไม่สามารถแก้ไขผู้ป่วยได้'));
                location.reload();
            });
            const ewWard = document.getElementById('ew_ward');
            if (ewWard) {
                ewWard.value = wardId || '';
                ewWard.disabled = wardSelectLocked;
            }
        };
        window.delP = async (hn) => {
            if (!confirm('ลบ?')) return;
            const response = await fetch('/api/patients/' + encodeURIComponent(hn), {method:'DELETE'});
            if (!response.ok) return alert(await apiErrorMessage(response, 'ไม่สามารถลบผู้ป่วยได้'));
            location.reload();
        };
    `));
});

app.post('/api/patients', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.body.hn || '').trim();
    const name = String(req.body.nm || '').trim();
    const wardId = parseInt(req.body.ward_id, 10);
    if (!hn || !name || hn.length > 50 || name.length > 200 || isNaN(wardId)) {
        return res.status(400).json({ error: 'Invalid patient data' });
    }
    if (req.user.role !== 'super_admin') {
        const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
        if (!wardIds.includes(wardId)) {
            return res.status(403).json({ error: 'Cannot add a patient to a ward you do not belong to' });
        }
    }
    try {
        const duplicate = await pool.query(
            'SELECT 1 FROM patients WHERE LOWER(hn_number)=LOWER($1) LIMIT 1',
            [hn]
        );
        if (duplicate.rows.length) return res.status(409).json({ error: 'Patient HN already exists' });
        await pool.query('INSERT INTO patients (hn_number, name, ward_id) VALUES ($1,$2,$3)', [hn, name, wardId]);
        logAudit(req, 'CREATE', 'patient', hn, { name, ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (error) {
        console.error('[Patient Create]', error.message);
        res.status(500).json({ error: 'Unable to create patient' });
    }
});

app.post('/api/patients/update', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.body.hn || '').trim();
    const name = String(req.body.newName || '').trim();
    const wardId = parseInt(req.body.ward_id, 10);
    if (!hn || !name || hn.length > 50 || name.length > 200 || isNaN(wardId)) {
        return res.status(400).json({ error: 'Invalid patient data' });
    }
    if (req.user.role !== 'super_admin') {
        const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
        if (!wardIds.includes(wardId)) {
            return res.status(403).json({ error: 'Cannot move a patient to a ward you do not belong to' });
        }
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // wardScopeSql restricts to patients already in a ward this user can act on —
        // combined with the wardIds.includes check above, a ward_admin can neither pull a
        // patient out of a ward they don't manage nor move one into a ward they don't manage.
        const scope = await wardScopeSql(req, 'ward_id', 4);
        const result = await client.query(
            `UPDATE patients SET name=$1, ward_id=$2 WHERE LOWER(hn_number)=LOWER($3) ${scope.clause ? 'AND ' + scope.clause : ''} RETURNING id`,
            [name, wardId, hn, ...scope.params]
        );
        if (!result.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Patient not found or access denied' });
        }
        // Keep any currently-paired device's ward mirrored to the patient's ward.
        await client.query(
            'UPDATE nurseaid SET name=$1, ward_id=$2, lastupdate=NOW() WHERE LOWER(hm_number)=LOWER($3)',
            [name, wardId, hn]
        );
        await client.query('COMMIT');
        logAudit(req, 'UPDATE', 'patient', hn, { name, ward_id: wardId }).catch(console.error);
        res.json({ success: true });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('[Patient Update]', error.message);
        res.status(500).json({ error: 'Unable to update patient' });
    } finally {
        client.release();
    }
});

app.delete('/api/patients/:hn', requireCapability('patients:write'), async (req, res) => {
    const hn = String(req.params.hn || '').trim();
    if (!hn) return res.status(400).json({ error: 'Patient HN required' });
    try {
        const assigned = await pool.query(
            'SELECT 1 FROM nurseaid WHERE LOWER(hm_number)=LOWER($1) LIMIT 1',
            [hn]
        );
        if (assigned.rows.length) return res.status(409).json({ error: 'Unpair the patient before deleting this record' });
        const scope = await wardScopeSql(req, 'ward_id', 2);
        const result = await pool.query(
            `DELETE FROM patients WHERE LOWER(hn_number)=LOWER($1) ${scope.clause ? 'AND ' + scope.clause : ''} RETURNING id, ward_id`,
            [hn, ...scope.params]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Patient not found or access denied' });
        logAudit(req, 'DELETE', 'patient', hn, { ward_id: result.rows[0].ward_id }).catch(console.error);
        res.json({ success: true });
    } catch (error) {
        console.error('[Patient Delete]', error.message);
        res.status(500).json({ error: 'Unable to delete patient' });
    }
});

app.get('/matching', requireCapability('pairing:write'), async (req, res) => {
    // Same shared-pool rule as /devices-mgmt: unpaired devices are visible to every
    // ward (so they can be picked up for pairing); devices already paired belong to
    // that patient's ward for display purposes.
    const scope = await wardScopeSql(req, 'ward_id', 1);
    const r = await pool.query(
        `SELECT * FROM nurseaid
         ${scope.clause ? `WHERE (NULLIF(BTRIM(hm_number), '') IS NULL OR ${scope.clause})` : ''}
         ORDER BY device_no ASC`,
        scope.params
    );
    const cards = r.rows.map(x => {
        const btnHtml = x.hm_number
            ? `<button onclick="changeDevice('${escapeJsSingle(x.mac)}', '${escapeJsSingle(x.name)}', '${escapeJsSingle(x.hm_number)}', '${escapeJsSingle(x.bed_no || '')}')" class="w-full p-2 mb-2 rounded-lg text-[10px] font-bold transition-colors" style="background: var(--accent-amber); color: var(--text-inverse);">🔄 Change Device</button><button onclick="unpair('${escapeJsSingle(x.mac)}')" class="w-full p-2 rounded-lg text-[10px] font-bold" style="color: var(--accent-red); border: 1px solid var(--border-color);">Unpair</button>`
            : `<button onclick="openPair('${escapeJsSingle(x.mac)}', '${escapeJsSingle(x.device_no)}')" class="admin-only w-full p-2 rounded-lg text-[10px] font-bold" style="background: var(--accent-primary); color: var(--text-inverse);">Pair Device</button>`;
        const cardBg = x.hm_number ? 'background: var(--bg-card-paired); border-color: var(--border-card-paired);' : '';
        const deviceBadgeBg = x.hm_number ? 'background: var(--accent-primary);' : 'background: var(--bg-badge); color: var(--text-secondary);';
        const bedBadgeBg = x.hm_number ? 'background: var(--accent-secondary);' : 'background: var(--bg-badge); color: var(--text-secondary);';
        const patientNameColor = x.hm_number ? 'color: var(--text-primary);' : 'color: var(--text-tertiary);';
        const hnColor = x.hm_number ? 'color: var(--accent-primary);' : 'color: var(--text-tertiary);';
        const availText = x.hm_number ? escapeHtml(x.name) : 'Available';
        const availClass = x.hm_number ? 'font-bold' : 'italic';
        const hnLine = x.hm_number ? `<p class="text-[10px] font-bold" style="${hnColor}">HN: ${escapeHtml(x.hm_number)}</p>` : '';
        return `<div class="card p-6" style="${cardBg}"><div class="flex justify-between mb-4"><span class="text-[10px] px-2 py-1 rounded font-bold uppercase" style="${deviceBadgeBg}">#${escapeHtml(x.device_no)}</span> ${x.bed_no ? `<span class="text-[10px] px-2 py-1 rounded font-bold italic" style="${bedBadgeBg}">BED ${escapeHtml(x.bed_no)}</span>` : ''}</div><div class="min-h-[80px]"><p class="${availClass}" style="${patientNameColor}">${availText}</p>${hnLine}</div><div class="mt-4">${btnHtml}</div></div>`;
    }).join('');
    res.send(ui(req.user, 'match', `<h2 class="text-xl font-bold mb-8">Pairing</h2><div id="pairing-grid" class="monitor-grid-layout">${cards}</div>`, `
        window.openPair = async (mac, dno) => {
            currentMac = mac; const res = await fetch('/api/patients-available'); const pats = await res.json();
            const opts = pats.map(p => '<option value="'+escapeHTML(p.hn_number)+'|'+escapeHTML(p.name)+'">'+escapeHTML(p.name)+' ('+escapeHTML(p.hn_number)+')</option>').join('');
            openModal('🔗 จับคู่ #'+dno, '<input id="bed" placeholder="Bed (e.g. B01)" class="w-full border p-3 rounded-xl mb-3" style="background: var(--bg-input); color: var(--text-primary);"><select id="selP" class="w-full border p-3 rounded-xl" style="background: var(--bg-input); color: var(--text-primary);">'+opts+'</select>', async () => {
                const bed = document.getElementById('bed').value;
                const [hn, name] = document.getElementById('selP').value.split('|');
                await fetch('/api/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac:currentMac, hn, name, bed}) });
                location.reload();
            });
        }
        window.unpair = async (mac) => { if(confirm('ยกเลิก?')) { await fetch('/api/unpair', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac})}); location.reload(); } }

        // Change Device: ย้ายคนไข้จากเครื่องเดิมไปเครื่องใหม่
        window.changeDevice = async (fromMac, patientName, hn, bedNo) => {
            const res = await fetch('/api/devices-available');
            const devices = await res.json();
            if (!devices || devices.length === 0) {
                alert('ไม่มีอุปกรณ์ว่างสำหรับย้ายคนไข้');
                return;
            }
            const opts = devices.map(d => '<option value="'+escapeHTML(d.mac)+'">#'+escapeHTML(d.device_no)+' (ว่าง)</option>').join('');
            openModal('🔄 ย้ายคนไข้ไปเครื่องใหม่',
                '<p class="text-xs mb-3" style="color: var(--text-secondary);">คนไข้: <strong>'+escapeHTML(patientName)+' (HN: '+escapeHTML(hn)+')</strong> จากเตียง '+escapeHTML(bedNo||'-')+'</p><p class="text-xs mb-3" style="color: var(--text-secondary);">เลือกอุปกรณ์ปลายทาง:</p><select id="change-target" class="w-full border p-3 rounded-xl" style="background: var(--bg-card); color: var(--text-primary);">'+opts+'</select>',
                async () => {
                    const targetMac = document.getElementById('change-target').value;
                    if(!targetMac) return alert('ไม่เลือกอุปกรณ์ปลายทาง');
                    try {
                        const r = await fetch('/api/change-device', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ fromMac, toMac: targetMac })
                        });
                        if(r.ok) {
                            alert('ย้ายคนไข้สำเร็จแล้ว');
                            location.reload();
                        } else {
                            const err = await r.json();
                            alert('ย้ายคนไข้ไม่สำเร็จ: ' + (err.error || 'Unknown error'));
                        }
                    } catch(e) {
                        alert('Connection error: ' + e.message);
                    }
                }
            );
        }
    `));
});

app.post('/api/pair', requireCapability('pairing:write'), async (req, res) => {
    const { mac, hn, name, bed } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        // Ward now lives on the patient — a device is a shared, ward-agnostic piece of
        // hardware that inherits its ward from whichever patient it's currently paired to.
        const patientResult = await pool.query('SELECT ward_id FROM patients WHERE LOWER(hn_number)=LOWER($1)', [hn]);
        if (!patientResult.rows.length) return res.status(404).send('Patient not found');
        const wardId = patientResult.rows[0].ward_id;
        if (req.user.role !== 'super_admin') {
            const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
            if (!wardId || !wardIds.includes(wardId)) {
                return res.status(403).send('Cannot pair a patient outside your ward');
            }
        }
        const r = await pool.query(
            `UPDATE nurseaid SET hm_number=$1, name=$2, update_by=$3, lastupdate=NOW(), bed_no=$4, ward_id=$5 WHERE mac=$6 RETURNING ward_id`,
            [hn, name, nurse, bed, wardId, mac]
        );
        if (!r.rows.length) return res.status(404).send('Device not found');

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
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/unpair', requireCapability('pairing:write'), async (req, res) => {
    const { mac } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        await pool.query(
            "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
            [mac]
        );

        await pool.query(
            'UPDATE nurseaid SET hm_number=NULL, name=NULL, update_by=$1, lastupdate=NOW(), bed_no=NULL WHERE mac=$2',
            [nurse, mac]
        );

        await pool.query(
            `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
             WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false`,
            [mac]
        );
        delete deviceAlertState[normalizeMac(mac)];
        publishPairedDeviceList();

        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/change-device', requireCapability('pairing:write'), async (req, res) => {
    const { fromMac, toMac } = req.body;
    const nurse = req.user.name || req.user.username;
    try {
        const result = await pool.query('SELECT * FROM nurseaid WHERE mac = $1', [fromMac]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Device not found' });
        }
        const device = result.rows[0];
        if (!device.hm_number) {
            return res.status(400).json({ error: 'Source device has no paired patient' });
        }

        const target = await pool.query('SELECT * FROM nurseaid WHERE mac = $1', [toMac]);
        if (target.rows.length === 0) {
            return res.status(404).json({ error: 'Target device not found' });
        }
        if (target.rows[0].hm_number) {
            return res.status(400).json({ error: 'Target device already has a paired patient' });
        }
        
        // Ward check: this moves a patient (not a "ward") from one device to another, so
        // gate on the patient's ward — mirrored onto device.ward_id by /api/pair already.
        if (req.user.role !== 'super_admin') {
            const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
            if (!device.ward_id || !wardIds.includes(device.ward_id)) {
                return res.status(403).json({ error: 'Cannot move a patient outside your ward' });
            }
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            await client.query(
                "UPDATE device_history SET discharge_time=NOW(), status='discharged' WHERE mac=$1 AND status='active'",
                [fromMac]
            );

            await client.query(
                'UPDATE nurseaid SET hm_number=NULL, name=NULL, update_by=$1, lastupdate=NOW(), bed_no=NULL WHERE mac=$2',
                [nurse, fromMac]
            );
            await client.query(
                `UPDATE alert_logs SET resolved=true, resolved_at=NOW()
                 WHERE LOWER(mac)=LOWER($1) AND category='device_offline' AND resolved=false`,
                [fromMac]
            );

            const { hm_number: hn, name: pname, bed_no: bed, ward_id: wardId } = device;
            await client.query(
                'UPDATE nurseaid SET hm_number=$1, name=$2, update_by=$3, lastupdate=NOW(), bed_no=$4, ward_id=$5 WHERE mac=$6',
                [hn, pname, nurse, bed, wardId, toMac]
            );

            await client.query(
                'INSERT INTO device_history (mac, hm_number, patient_name, bed_no, assign_time, status) VALUES ($1, $2, $3, $4, NOW(), $5)',
                [toMac, hn, pname, bed, 'active']
            );

            await client.query('COMMIT');
            delete deviceAlertState[normalizeMac(fromMac)];
            delete deviceAlertState[normalizeMac(toMac)];
            publishPairedDeviceList();
            res.json({ success: true });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/patients-available', requireCapability('pairing:write'), async (req, res) => {
    const scope = await wardScopeSql(req, 'ward_id', 1);
    const r = await pool.query(
        `SELECT * FROM patients
         WHERE hn_number NOT IN (SELECT hm_number FROM nurseaid WHERE hm_number IS NOT NULL)
         ${scope.clause ? 'AND ' + scope.clause : ''}`,
        scope.params
    );
    res.json(r.rows);
});

app.get('/api/devices-available', requireCapability('pairing:write'), async (req, res) => {
    // Devices are a shared hardware pool (not ward-owned) — any unpaired device can be
    // picked up and paired to a patient in the caller's ward. Ward scoping happens on the
    // patient side instead (see /api/patients-available, /api/pair).
    const r = await pool.query('SELECT * FROM nurseaid WHERE hm_number IS NULL ORDER BY device_no ASC');
    res.json(r.rows);
});

app.get('/alert-settings', requireCapability('alerts:settings:write'), async (req, res) => {
    const scope = await wardScopeSql(req, 'n.ward_id', 1);
    const [r, defaultResult] = await Promise.all([
        pool.query(`SELECT n.*, (s.mac IS NOT NULL) AS has_custom,
            COALESCE(s.hr_min,d.hr_min,50) hr_min, COALESCE(s.hr_max,d.hr_max,120) hr_max,
            COALESCE(s.hr_warning_min,d.hr_warning_min,60) hr_warning_min,
            COALESCE(s.hr_warning_max,d.hr_warning_max,110) hr_warning_max,
            COALESCE(s.spo2_warning_min,s.spo2_min,d.spo2_warning_min,d.spo2_min,95) spo2_warning_min,
            COALESCE(s.spo2_critical_min,d.spo2_critical_min,91) spo2_critical_min,
            COALESCE(s.temp_min,d.temp_min,35.5) temp_min, COALESCE(s.temp_max,d.temp_max,37.5) temp_max,
            COALESCE(s.temp_warning_min,d.temp_warning_min,36.0) temp_warning_min,
            COALESCE(s.temp_warning_max,d.temp_warning_max,37.0) temp_warning_max,
            COALESCE(s.enable_sound,d.enable_sound,true) enable_sound,
            COALESCE(s.enable_line,d.enable_line,true) enable_line,
            COALESCE(s.enable_offline_alert,d.enable_offline_alert,true) enable_offline_alert,
            COALESCE(s.offline_threshold_minutes,d.offline_threshold_minutes,2) offline_threshold_minutes,
            COALESCE(s.enable_webhook,d.enable_webhook,false) enable_webhook,
            COALESCE(s.webhook_url,d.webhook_url,'') webhook_url
            FROM nurseaid n LEFT JOIN alert_settings s ON LOWER(s.mac)=LOWER(n.mac)
            LEFT JOIN alert_settings d ON d.mac='*'
            WHERE n.hm_number IS NOT NULL ${scope.clause ? 'AND ' + scope.clause : ''}
            ORDER BY n.bed_no`, scope.params),
        pool.query("SELECT * FROM alert_settings WHERE mac='*' LIMIT 1")
    ]);
    const defaults = defaultResult.rows[0] || {
        hr_min: 50, hr_warning_min: 60, hr_warning_max: 110, hr_max: 120,
        spo2_min: 95, spo2_warning_min: 95, spo2_critical_min: 91,
        temp_min: 35.5, temp_warning_min: 36.0, temp_warning_max: 37.0, temp_max: 37.5,
        enable_sound: true, enable_line: true, enable_offline_alert: true,
        offline_threshold_minutes: 2, enable_webhook: false, webhook_url: ''
    };
    const defaultLimits = alertThresholds(defaults);
    const rows = r.rows.map(d => {
        const hasCustom = Boolean(d.has_custom);
        const limits = alertThresholds(d);
        return `<article class="range-patient-card card">
            <div class="flex items-start justify-between gap-3 mb-3"><div class="min-w-0">
                <div class="flex items-center gap-2 mb-1"><span class="text-[10px] px-2 py-1 rounded-lg font-bold" style="background:var(--accent-primary);color:var(--text-inverse);">เตียง ${escapeHtml(d.bed_no || '-')}</span><span class="text-[9px] px-2 py-1 rounded-full font-bold" style="background:${hasCustom ? 'var(--accent-amber)' : 'var(--bg-badge)'};color:${hasCustom ? 'var(--text-inverse)' : 'var(--text-secondary)'};">${hasCustom ? 'ตั้งค่าเฉพาะราย' : 'ใช้ค่ากลาง'}</span></div>
                <h3 class="font-bold truncate" style="color:var(--text-primary);">${escapeHtml(d.name || '-')}</h3><p class="text-[10px]" style="color:var(--text-tertiary);">HN ${escapeHtml(d.hm_number || '-')} · อุปกรณ์ #${escapeHtml(d.device_no)}</p>
            </div></div>
            <div class="range-patient-values mb-3"><div class="range-patient-value"><span>HEART RATE</span><strong>N ${limits.hrWarningMin}–${limits.hrWarningMax} · C นอก ${limits.hrMin}–${limits.hrMax}</strong></div><div class="range-patient-value"><span>SpO₂</span><strong>N ≥${limits.spo2WarningMin}% · C ≤${limits.spo2CriticalMin}%</strong></div><div class="range-patient-value"><span>TEMPERATURE</span><strong>N ${limits.tempWarningMin}–${limits.tempWarningMax} · C นอก ${limits.tempMin}–${limits.tempMax}</strong></div></div>
            <p class="text-[10px] mb-3" style="color:var(--text-secondary);">${d.enable_offline_alert ? `📡 แจ้งเมื่ออุปกรณ์ขาดการติดต่อ ${offlineThresholdMinutes(d)} นาที` : '📡 ปิดการแจ้งเตือนอุปกรณ์หลุด'}</p>
            <div class="flex gap-2"><button type="button" onclick="editAlertSettings('${escapeJsSingle(d.mac)}', ${limits.hrMin}, ${limits.hrWarningMin}, ${limits.hrWarningMax}, ${limits.hrMax}, ${limits.spo2CriticalMin}, ${limits.spo2WarningMin}, ${limits.tempMin}, ${limits.tempWarningMin}, ${limits.tempWarningMax}, ${limits.tempMax}, ${Boolean(d.enable_sound)}, ${Boolean(d.enable_line)}, ${Boolean(d.enable_offline_alert)}, ${offlineThresholdMinutes(d)}, ${Boolean(d.enable_webhook)}, '${escapeJsSingle(d.webhook_url || '')}')" class="flex-1 px-3 py-2 rounded-xl text-xs font-bold" style="background:var(--accent-primary);color:var(--text-inverse);">⚙️ ตั้งค่าเฉพาะราย</button>${hasCustom ? `<button type="button" onclick="resetPatientAlertSettings('${escapeJsSingle(d.mac)}')" class="px-3 py-2 rounded-xl text-xs font-bold" style="background:var(--bg-badge);color:var(--text-secondary);border:1px solid var(--border-color);">ใช้ค่ากลาง</button>` : ''}</div>
        </article>`;
    }).join('');
    res.send(ui(req.user, 'alert', `
        <div class="mb-5"><h2 class="text-2xl font-black" style="color:var(--text-heading);">ช่วงค่ากลางและการแจ้งเตือน</h2><p class="text-xs mt-1" style="color:var(--text-secondary);">ค่าทุกตัวเปลี่ยนสถานะตามลำดับ <strong style="color:var(--accent-green);">Normal</strong> → <strong style="color:var(--accent-yellow);">Warning</strong> → <strong style="color:var(--accent-red);">Critical</strong></p></div>
        <section class="range-settings-hero card p-5 md:p-6 mb-6">
            <div class="relative z-[1] flex flex-wrap items-start justify-between gap-3 mb-4">
                <div class="flex items-center gap-2"><span class="w-9 h-9 inline-flex items-center justify-center rounded-xl" style="background:var(--accent-primary);color:var(--text-inverse);">🎯</span><div><h3 class="font-black" style="color:var(--text-heading);">ค่ากลางของระบบ</h3><p class="text-[10px]" style="color:var(--text-secondary);">ใช้กับผู้ป่วยที่ไม่ได้ตั้งค่าเฉพาะราย</p></div></div>
                <div class="flex gap-1.5"><span class="text-[9px] px-2 py-1 rounded-full font-black" style="background:color-mix(in srgb,var(--accent-green) 12%,transparent);color:var(--accent-green);">NORMAL</span><span class="text-[9px] px-2 py-1 rounded-full font-black" style="background:color-mix(in srgb,var(--accent-yellow) 12%,transparent);color:var(--accent-yellow);">WARNING</span><span class="text-[9px] px-2 py-1 rounded-full font-black" style="background:color-mix(in srgb,var(--accent-red) 10%,transparent);color:var(--accent-red);">CRITICAL</span></div>
            </div>
            <div id="default-metric-editor" class="range-metric-grid mb-4"></div>
            <div class="relative z-[1] flex flex-wrap items-center justify-between gap-3 pt-4" style="border-top:1px solid var(--border-color);">
                <div class="flex flex-wrap items-center gap-3"><label class="inline-flex items-center gap-2 text-xs font-bold"><input type="checkbox" id="default-sound" ${defaults.enable_sound ? 'checked' : ''}> 🔊 เสียงเตือน</label><label class="inline-flex items-center gap-2 text-xs font-bold"><input type="checkbox" id="default-line" ${defaults.enable_line ? 'checked' : ''}> LINE</label><label class="inline-flex items-center gap-2 text-xs font-bold"><input type="checkbox" id="default-offline" ${defaults.enable_offline_alert !== false ? 'checked' : ''} onchange="toggleDefaultOffline()"> 📡 อุปกรณ์หลุด</label><label id="default-offlineMinutes-wrap" class="${defaults.enable_offline_alert === false ? 'hidden' : 'inline-flex'} items-center gap-2 text-xs font-bold">แจ้งเมื่อขาดการติดต่อ <input id="default-offlineMinutes" type="number" min="1" max="60" value="${offlineThresholdMinutes(defaults)}" class="w-16 border px-2 py-1.5 rounded-lg text-xs"> นาที</label><label class="inline-flex items-center gap-2 text-xs font-bold"><input type="checkbox" id="default-webhook" ${defaults.enable_webhook ? 'checked' : ''} onchange="toggleDefaultWebhook()"> Webhook</label><input id="default-webhookUrl" value="${escapeHtml(defaults.webhook_url || '')}" placeholder="Webhook URL" class="${defaults.enable_webhook ? '' : 'hidden'} border px-3 py-2 rounded-xl text-xs min-w-[220px]"></div>
                <button type="button" onclick="saveDefaultAlertSettings()" class="px-5 py-2.5 rounded-xl font-bold text-sm shadow-md" style="background:var(--accent-primary);color:var(--text-inverse);">บันทึกค่ากลาง</button>
            </div>
        </section>
        <div class="flex items-end justify-between gap-3 mb-3"><div><h3 class="font-black" style="color:var(--text-heading);">ตั้งค่าเฉพาะราย</h3><p class="text-[10px]" style="color:var(--text-tertiary);">ค่ารายบุคคลจะมีลำดับความสำคัญเหนือค่ากลาง</p></div><span class="text-[10px]" style="color:var(--text-tertiary);">${r.rows.length} ผู้ป่วย</span></div>
        <div class="range-patient-grid">${rows || '<div class="card p-6 text-center text-sm" style="color:var(--text-tertiary);">ยังไม่มีผู้ป่วยที่จับคู่กับอุปกรณ์</div>'}</div>
    `, `
        const defaultAlertValues = ${JSON.stringify(defaultLimits)};

        function renderAlertMetricEditor(prefix, values) {
            return \`
                <div class="range-metric-card range-metric-card--hr"><p class="text-xs font-black" style="color:#ef4444;">🫀 HEART RATE</p><p class="text-[9px] mt-0.5" style="color:var(--text-tertiary);">Normal → Warning → Critical</p><div class="range-tier-stack">
                    <div class="range-normal-preview"><span>✓ NORMAL</span><strong><span id="\${prefix}-hrNormal">-</span> · กลาง <span id="\${prefix}-hrMid">-</span></strong></div>
                    <div class="range-tier-row range-tier-row--warning"><span class="range-tier-label">WARNING</span><div class="range-field"><label>ต่ำกว่า</label><input type="number" id="\${prefix}-hrWarningMin" min="21" max="238" value="\${values.hrWarningMin}" oninput="updateRangePreview('\${prefix}')"></div><div class="range-field"><label>สูงกว่า</label><input type="number" id="\${prefix}-hrWarningMax" min="22" max="239" value="\${values.hrWarningMax}" oninput="updateRangePreview('\${prefix}')"></div></div>
                    <div class="range-tier-row range-tier-row--critical"><span class="range-tier-label">CRITICAL</span><div class="range-field"><label>ต่ำกว่า</label><input type="number" id="\${prefix}-hrMin" min="20" max="237" value="\${values.hrMin}" oninput="updateRangePreview('\${prefix}')"></div><div class="range-field"><label>สูงกว่า</label><input type="number" id="\${prefix}-hrMax" min="23" max="240" value="\${values.hrMax}" oninput="updateRangePreview('\${prefix}')"></div></div>
                </div></div>
                <div class="range-metric-card range-metric-card--spo2"><p class="text-xs font-black" style="color:#3b82f6;">💧 OXYGEN SATURATION</p><p class="text-[9px] mt-0.5" style="color:var(--text-tertiary);">Normal → Warning → Critical</p><div class="range-tier-stack">
                    <div class="range-normal-preview"><span>✓ NORMAL</span><strong id="\${prefix}-spo2Preview">-</strong></div>
                    <div class="range-tier-row range-tier-row--single range-tier-row--warning"><span class="range-tier-label">WARNING</span><div class="range-field"><label>ต่ำกว่า (%)</label><input type="number" id="\${prefix}-spo2Min" min="51" max="100" value="\${values.spo2WarningMin}" oninput="updateRangePreview('\${prefix}')"></div></div>
                    <div class="range-tier-row range-tier-row--single range-tier-row--critical"><span class="range-tier-label">CRITICAL</span><div class="range-field"><label>เท่ากับหรือต่ำกว่า (%)</label><input type="number" id="\${prefix}-spo2CriticalMin" min="50" max="99" value="\${values.spo2CriticalMin}" oninput="updateRangePreview('\${prefix}')"></div></div>
                </div></div>
                <div class="range-metric-card range-metric-card--temp"><p class="text-xs font-black" style="color:#f97316;">🌡️ BODY TEMPERATURE</p><p class="text-[9px] mt-0.5" style="color:var(--text-tertiary);">Normal → Warning → Critical</p><div class="range-tier-stack">
                    <div class="range-normal-preview"><span>✓ NORMAL</span><strong><span id="\${prefix}-tempNormal">-</span> · กลาง <span id="\${prefix}-tempMid">-</span></strong></div>
                    <div class="range-tier-row range-tier-row--warning"><span class="range-tier-label">WARNING</span><div class="range-field"><label>ต่ำกว่า</label><input type="number" id="\${prefix}-tempWarningMin" min="30.1" max="42.8" step="0.1" value="\${values.tempWarningMin}" oninput="updateRangePreview('\${prefix}')"></div><div class="range-field"><label>สูงกว่า</label><input type="number" id="\${prefix}-tempWarningMax" min="30.2" max="42.9" step="0.1" value="\${values.tempWarningMax}" oninput="updateRangePreview('\${prefix}')"></div></div>
                    <div class="range-tier-row range-tier-row--critical"><span class="range-tier-label">CRITICAL</span><div class="range-field"><label>ต่ำกว่า</label><input type="number" id="\${prefix}-tempMin" min="30" max="42.7" step="0.1" value="\${values.tempMin}" oninput="updateRangePreview('\${prefix}')"></div><div class="range-field"><label>สูงกว่า</label><input type="number" id="\${prefix}-tempMax" min="30.3" max="43" step="0.1" value="\${values.tempMax}" oninput="updateRangePreview('\${prefix}')"></div></div>
                </div></div>
            \`;
        }

        function alertSettingsValues(prefix) {
            return {
                hrMin: Number(document.getElementById(prefix + '-hrMin').value),
                hrWarningMin: Number(document.getElementById(prefix + '-hrWarningMin').value),
                hrWarningMax: Number(document.getElementById(prefix + '-hrWarningMax').value),
                hrMax: Number(document.getElementById(prefix + '-hrMax').value),
                spo2Min: Number(document.getElementById(prefix + '-spo2Min').value),
                spo2WarningMin: Number(document.getElementById(prefix + '-spo2Min').value),
                spo2CriticalMin: Number(document.getElementById(prefix + '-spo2CriticalMin').value),
                tempMin: Number(document.getElementById(prefix + '-tempMin').value),
                tempWarningMin: Number(document.getElementById(prefix + '-tempWarningMin').value),
                tempWarningMax: Number(document.getElementById(prefix + '-tempWarningMax').value),
                tempMax: Number(document.getElementById(prefix + '-tempMax').value)
            };
        }

        function validateAlertSettings(values) {
            if (![values.hrMin, values.hrWarningMin, values.hrWarningMax, values.hrMax].every(Number.isFinite) || !(values.hrMin < values.hrWarningMin && values.hrWarningMin < values.hrWarningMax && values.hrWarningMax < values.hrMax)) return 'Heart Rate ต้องเรียง Critical ต่ำ < Warning ต่ำ < Warning สูง < Critical สูง';
            if (values.hrMin < 20 || values.hrMax > 240) return 'Heart Rate ต้องอยู่ระหว่าง 20–240 BPM';
            if (![values.spo2CriticalMin, values.spo2WarningMin].every(Number.isFinite) || values.spo2CriticalMin < 50 || values.spo2WarningMin > 100 || values.spo2CriticalMin >= values.spo2WarningMin) return 'SpO₂ Critical ต้องต่ำกว่า Warning และอยู่ระหว่าง 50–100%';
            if (![values.tempMin, values.tempWarningMin, values.tempWarningMax, values.tempMax].every(Number.isFinite) || !(values.tempMin < values.tempWarningMin && values.tempWarningMin < values.tempWarningMax && values.tempWarningMax < values.tempMax)) return 'อุณหภูมิต้องเรียง Critical ต่ำ < Warning ต่ำ < Warning สูง < Critical สูง';
            if (values.tempMin < 30 || values.tempMax > 43) return 'อุณหภูมิต้องอยู่ระหว่าง 30–43°C';
            return '';
        }

        window.updateRangePreview = (prefix) => {
            const values = alertSettingsValues(prefix);
            const hrMid = document.getElementById(prefix + '-hrMid');
            const tempMid = document.getElementById(prefix + '-tempMid');
            const spo2 = document.getElementById(prefix + '-spo2Preview');
            const hrNormal = document.getElementById(prefix + '-hrNormal');
            const tempNormal = document.getElementById(prefix + '-tempNormal');
            if (hrMid) hrMid.textContent = ((values.hrWarningMin + values.hrWarningMax) / 2).toFixed(1).replace('.0', '') + ' BPM';
            if (hrNormal) hrNormal.textContent = values.hrWarningMin + '–' + values.hrWarningMax + ' BPM';
            if (tempMid) tempMid.textContent = ((values.tempWarningMin + values.tempWarningMax) / 2).toFixed(1) + '°C';
            if (tempNormal) tempNormal.textContent = values.tempWarningMin.toFixed(1) + '–' + values.tempWarningMax.toFixed(1) + '°C';
            if (spo2) spo2.textContent = '≥ ' + values.spo2WarningMin + '%';
        };

        window.toggleDefaultWebhook = () => document.getElementById('default-webhookUrl').classList.toggle('hidden', !document.getElementById('default-webhook').checked);
        window.toggleDefaultOffline = () => {
            const enabled = document.getElementById('default-offline').checked;
            document.getElementById('default-offlineMinutes-wrap').classList.toggle('hidden', !enabled);
            document.getElementById('default-offlineMinutes-wrap').classList.toggle('inline-flex', enabled);
        };

        window.saveDefaultAlertSettings = async () => {
            const values = alertSettingsValues('default');
            const error = validateAlertSettings(values);
            if (error) return alert(error);
            const response = await fetch('/api/alert-settings', {
                method:'POST', headers:{'Content-Type':'application/json'},
                body:JSON.stringify({mac:'*', ...values,
                    enableSound:document.getElementById('default-sound').checked,
                    enableLine:document.getElementById('default-line').checked,
                    enableOfflineAlert:document.getElementById('default-offline').checked,
                    offlineThresholdMinutes:Number(document.getElementById('default-offlineMinutes').value),
                    enableWebhook:document.getElementById('default-webhook').checked,
                    webhookUrl:document.getElementById('default-webhookUrl').value})
            });
            const result = await response.json();
            if (!response.ok) return alert(result.error || 'ไม่สามารถบันทึกค่ากลางได้');
            alert('บันทึกค่ากลางและเกณฑ์แจ้งเตือนแล้ว');
            location.reload();
        };

        window.editAlertSettings = async (mac, hrMin, hrWarningMin, hrWarningMax, hrMax, spo2CriticalMin, spo2WarningMin, tempMin, tempWarningMin, tempWarningMax, tempMax, enableSound, enableLine, enableOfflineAlert, offlineThresholdMinutes, enableWebhook, webhookUrl) => {
            const html = \`
                <div class="space-y-4">
                    <div class="p-3 rounded-xl text-center" style="background:var(--bg-badge);"><p class="text-xs font-bold" style="color:var(--accent-primary);">ตั้งค่าเฉพาะราย · \${mac}</p><p class="text-[9px] mt-1" style="color:var(--text-tertiary);">Normal → Warning → Critical ตามลำดับ</p></div>
                    <div class="alert-settings-modal-grid">\${renderAlertMetricEditor('patient', {hrMin, hrWarningMin, hrWarningMax, hrMax, spo2CriticalMin, spo2WarningMin, tempMin, tempWarningMin, tempWarningMax, tempMax})}</div>
                    <div class="space-y-2">
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-sound" \${enableSound?'checked':''}> เสียงเตือน</label>
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-line" \${enableLine?'checked':''}> LINE Work</label>
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-offline" \${enableOfflineAlert?'checked':''} onchange="document.getElementById('as-offlineMinutes-wrap').classList.toggle('hidden', !this.checked)"> แจ้งเตือนเมื่ออุปกรณ์หลุด</label>
                        <label id="as-offlineMinutes-wrap" class="\${enableOfflineAlert?'':'hidden'} text-xs font-bold">แจ้งเมื่อขาดการติดต่อ
                            <input id="as-offlineMinutes" type="number" min="1" max="60" value="\${offlineThresholdMinutes}" class="w-20 border p-2 rounded-lg mx-2"> นาที
                        </label>
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-webhook" \${enableWebhook?'checked':''} onchange="document.getElementById('webhook-url-div').classList.toggle('hidden', !this.checked)"> Webhook</label>
                    </div>
                    <div id="webhook-url-div" class="\${enableWebhook?'':'hidden'}">
                        <label class="text-xs font-bold">Webhook URL</label>
                        <input id="as-webhookUrl" value="\${webhookUrl}" placeholder="https://hooks.slack.com/..." class="w-full border p-2 rounded-lg">
                    </div>
                </div>
            \`;
            openModal('⚙️ ช่วงค่าและการแจ้งเตือน', html, async () => {
                const values = alertSettingsValues('patient');
                const error = validateAlertSettings(values);
                if (error) return alert(error);
                const response = await fetch('/api/alert-settings', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        mac, ...values,
                        enableSound: document.getElementById('as-sound').checked,
                        enableLine: document.getElementById('as-line').checked,
                        enableOfflineAlert: document.getElementById('as-offline').checked,
                        offlineThresholdMinutes: Number(document.getElementById('as-offlineMinutes').value),
                        enableWebhook: document.getElementById('as-webhook').checked,
                        webhookUrl: document.getElementById('as-webhookUrl').value
                    })
                });
                const result = await response.json();
                if (!response.ok) return alert(result.error || 'ไม่สามารถบันทึกค่าได้');
                closeModal();
                location.reload();
            }, 'wide');
            updateRangePreview('patient');
        };

        window.resetPatientAlertSettings = async (mac) => {
            if (!confirm('คืนผู้ป่วยรายนี้กลับไปใช้ค่ากลางของระบบ?')) return;
            const response = await fetch('/api/alert-settings/' + encodeURIComponent(mac), {method:'DELETE'});
            if (!response.ok) return alert('ไม่สามารถคืนค่ากลางได้');
            location.reload();
        };

        document.getElementById('default-metric-editor').innerHTML = renderAlertMetricEditor('default', defaultAlertValues);
        updateRangePreview('default');
    `));
});

app.get('/alert-history', async (req, res) => {
    // Scope on alert_logs.ward_id directly — captured at alert-creation time, so it stays
    // accurate even if the device was since unpaired or re-paired to a different ward.
    const scope = await wardScopeSql(req, 'ward_id', 1);
    const r = await pool.query(
        `SELECT * FROM alert_logs
         ${scope.clause ? 'WHERE ' + scope.clause : ''}
         ORDER BY created_at DESC LIMIT 200`,
        scope.params
    );
    const rows = r.rows.map(a => {
        const badge = a.level === 'critical' ? 'bg-red-100 text-red-700' : 'bg-yellow-100 text-yellow-700';
        const ackBadge = a.acknowledged ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700';
        return '<tr>' +
            '<td class="text-xs">' + new Date(a.created_at).toLocaleString('th-TH') + '</td>' +
            '<td>' + escapeHtml(a.bed_no || '-') + '</td>' +
            '<td>' + escapeHtml(a.patient_name || '-') + '</td>' +
            '<td><span class="' + badge + ' text-[10px] px-2 py-0.5 rounded font-bold uppercase">' + escapeHtml(a.level) + '</span></td>' +
            '<td><span class="' + ackBadge + ' text-[10px] px-2 py-0.5 rounded font-bold">' + (a.acknowledged ? 'ร้บทราบ' : 'New') + '</span></td>' +
            '<td class="text-xs max-w-[200px] truncate">' + escapeHtml(a.message || '-') + '</td>' +
            '<td class="text-right">' +
            (!a.acknowledged ? '<button onclick="ackAlert(' + a.id + ')" class="text-green-500 text-xs font-bold mr-2">ร้บทราบ</button>' : '') +
            '</td>' +
            '</tr>';
    }).join('');
    res.send(ui(req.user, 'ahist', `
        <h2 class="text-2xl font-black mb-6">📋 Alert History</h2>
        <div class="card overflow-hidden">
            <table class="w-full text-xs">
                <thead><tr><th>Time</th><th>Bed</th><th>Patient</th><th>Level</th><th>Status</th><th>Message</th><th class="text-right"></th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `, `
        window.ackAlert = async (id) => {
            try {
                const nurseName = localStorage.getItem('nurse_name') || 'system';
                const response = await fetch('/api/alert-ack', {
                    method:'POST',
                    headers:{'Content-Type':'application/json'},
                    body:JSON.stringify({id, nurse: nurseName})
                });
                const result = await response.json();
                if(result.success) {
                    alert('ยื่นยันรรับทราบแล้ว!');
                    location.reload();
                } else {
                    alert('เกิดผิดพลาด: ' + (result.error || 'Unknown error'));
                }
            } catch(e) {
                alert('Connection error: ' + e.message);
            }
        };
    `));
});

app.post('/api/alert-settings', requireCapability('alerts:settings:write'), async (req, res) => {
    const {
        mac, hrMin, hrWarningMin, hrWarningMax, hrMax,
        spo2Min, spo2WarningMin, spo2CriticalMin,
        tempMin, tempWarningMin, tempWarningMax, tempMax,
        enableSound, enableLine, enableOfflineAlert, offlineThresholdMinutes: requestedOfflineThresholdMinutes,
        enableWebhook, webhookUrl
    } = req.body;
    try {
        const legacyLimits = alertThresholds({
            hr_min: hrMin, hr_max: hrMax, hr_warning_min: hrWarningMin, hr_warning_max: hrWarningMax,
            spo2_min: spo2WarningMin ?? spo2Min, spo2_warning_min: spo2WarningMin ?? spo2Min,
            spo2_critical_min: spo2CriticalMin,
            temp_min: tempMin, temp_max: tempMax, temp_warning_min: tempWarningMin, temp_warning_max: tempWarningMax
        });
        const values = {
            hrMin: Number(hrMin),
            hrWarningMin: hrWarningMin === undefined ? legacyLimits.hrWarningMin : Number(hrWarningMin),
            hrWarningMax: hrWarningMax === undefined ? legacyLimits.hrWarningMax : Number(hrWarningMax),
            hrMax: Number(hrMax),
            spo2WarningMin: Number(spo2WarningMin ?? spo2Min),
            spo2CriticalMin: spo2CriticalMin === undefined ? legacyLimits.spo2CriticalMin : Number(spo2CriticalMin),
            tempMin: Number(tempMin),
            tempWarningMin: tempWarningMin === undefined ? legacyLimits.tempWarningMin : Number(tempWarningMin),
            tempWarningMax: tempWarningMax === undefined ? legacyLimits.tempWarningMax : Number(tempWarningMax),
            tempMax: Number(tempMax),
            offlineThresholdMinutes: Number(requestedOfflineThresholdMinutes ?? 2)
        };
        if (!mac || Object.values(values).some(value => !Number.isFinite(value)) ||
            values.hrMin < 20 || values.hrMax > 240 ||
            !(values.hrMin < values.hrWarningMin && values.hrWarningMin < values.hrWarningMax && values.hrWarningMax < values.hrMax) ||
            values.spo2CriticalMin < 50 || values.spo2WarningMin > 100 || values.spo2CriticalMin >= values.spo2WarningMin ||
            values.tempMin < 30 || values.tempMax > 43 ||
            !(values.tempMin < values.tempWarningMin && values.tempWarningMin < values.tempWarningMax && values.tempWarningMax < values.tempMax) ||
            !Number.isInteger(values.offlineThresholdMinutes) || values.offlineThresholdMinutes < 1 || values.offlineThresholdMinutes > 60) {
            return res.status(400).json({ error: 'Invalid alert limits' });
        }
        if (mac !== '*' && req.user.role === 'ward_admin') {
            const device = await pool.query('SELECT ward_id FROM nurseaid WHERE LOWER(mac)=LOWER($1)', [mac]);
            if (device.rows.length && device.rows[0].ward_id) {
                const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
                if (!wardIds.includes(device.rows[0].ward_id)) {
                    return res.status(403).json({ error: 'Cannot manage alert settings for a device paired to another ward' });
                }
            }
        }
        const defaults = await pool.query("SELECT * FROM alert_settings WHERE mac='*'");
        const base = defaults.rows[0] || {};
        const sql = `INSERT INTO alert_settings (
                mac,hr_min,hr_warning_min,hr_warning_max,hr_max,
                spo2_min,spo2_warning_min,spo2_critical_min,
                temp_min,temp_warning_min,temp_warning_max,temp_max,
                enable_sound,enable_line,enable_offline_alert,offline_threshold_minutes,enable_webhook,webhook_url)
            VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
            ON CONFLICT (mac) DO UPDATE SET hr_min=EXCLUDED.hr_min,hr_warning_min=EXCLUDED.hr_warning_min,
            hr_warning_max=EXCLUDED.hr_warning_max,hr_max=EXCLUDED.hr_max,spo2_min=EXCLUDED.spo2_min,
            spo2_warning_min=EXCLUDED.spo2_warning_min,spo2_critical_min=EXCLUDED.spo2_critical_min,
            temp_min=EXCLUDED.temp_min,temp_warning_min=EXCLUDED.temp_warning_min,
            temp_warning_max=EXCLUDED.temp_warning_max,temp_max=EXCLUDED.temp_max,enable_sound=EXCLUDED.enable_sound,
            enable_line=EXCLUDED.enable_line,enable_offline_alert=EXCLUDED.enable_offline_alert,
            offline_threshold_minutes=EXCLUDED.offline_threshold_minutes,
            enable_webhook=EXCLUDED.enable_webhook,webhook_url=EXCLUDED.webhook_url,updated_at=NOW()`;
        await pool.query(sql, [mac, values.hrMin, values.hrWarningMin, values.hrWarningMax, values.hrMax,
            values.spo2WarningMin, values.spo2CriticalMin, values.tempMin, values.tempWarningMin, values.tempWarningMax, values.tempMax,
            enableSound === undefined ? Boolean(base.enable_sound) : Boolean(enableSound),
            enableLine === undefined ? Boolean(base.enable_line) : Boolean(enableLine),
            enableOfflineAlert === undefined ? base.enable_offline_alert !== false : Boolean(enableOfflineAlert),
            values.offlineThresholdMinutes,
            enableWebhook === undefined ? Boolean(base.enable_webhook) : Boolean(enableWebhook), webhookUrl || null]);
        delete deviceAlertState[normalizeMac(mac)];
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/alert-settings/:mac', requireCapability('alerts:settings:write'), async (req, res) => {
    if (req.params.mac === '*') return res.status(400).json({ error: 'Default settings cannot be deleted' });
    if (req.user.role === 'ward_admin') {
        const device = await pool.query('SELECT ward_id FROM nurseaid WHERE LOWER(mac)=LOWER($1)', [req.params.mac]);
        if (device.rows.length && device.rows[0].ward_id) {
            const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
            if (!wardIds.includes(device.rows[0].ward_id)) {
                return res.status(403).json({ error: 'Cannot manage alert settings for a device paired to another ward' });
            }
        }
    }
    await pool.query('DELETE FROM alert_settings WHERE LOWER(mac)=LOWER($1)', [req.params.mac]);
    delete deviceAlertState[normalizeMac(req.params.mac)];
    res.json({ success: true });
});

app.post('/api/alert-ack', async (req, res) => {
    try {
        const nurseName = req.user.name || req.user.username;

        // Deny only on a *known* ward mismatch. Legacy alerts logged before ward_id
        // existed on alert_logs (pre-migration) may still have it NULL — ward is
        // unknowable there, so we fall back to allowing the ack rather than breaking
        // cleanup of old/orphaned alerts.
        if (req.user.role !== 'super_admin') {
            const alertRes = await pool.query('SELECT ward_id FROM alert_logs WHERE id=$1', [req.body.id]);
            if (alertRes.rows.length === 0) {
                return res.status(404).json({ error: 'ไม่พบการแจ้งเตือน' });
            }
            const wardId = alertRes.rows[0].ward_id;
            const wardIds = req.user.wardIds || await getUserWardIds(req.user.id);
            if (wardId && !wardIds.includes(wardId)) {
                return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึงการแจ้งเตือนนี้' });
            }
        }

        await pool.query('UPDATE alert_logs SET acknowledged=true, acknowledged_by=$1, acknowledged_at=NOW() WHERE id=$2',
            [nurseName, req.body.id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alert-count', async (req, res) => {
    try {
        const scope = await wardScopeSql(req, 'ward_id', 1);
        const r = await pool.query(
            `SELECT COUNT(*) FROM alert_logs
             WHERE acknowledged=false AND resolved=false ${scope.clause ? 'AND ' + scope.clause : ''}`,
            scope.params
        );
        res.json({ count: parseInt(r.rows[0].count) });
    } catch (e) { res.json({ count: 0 }); }
});

app.get('/api/active-alerts', async (req, res) => {
    const scope = await wardScopeSql(req, 'ward_id', 1);
    const r = await pool.query(
        `SELECT id,mac,bed_no,patient_name,level,category,message,created_at
         FROM alert_logs
         WHERE resolved=false ${scope.clause ? 'AND ' + scope.clause : ''}
         ORDER BY created_at DESC`,
        scope.params
    );
    res.json(r.rows);
});

app.get('/api/alert-ui-state', async (req, res) => {
    const scope = await wardScopeSql(req, 'ward_id', 1);
    const [alerts, notifications] = await Promise.all([
        pool.query(
            `SELECT COUNT(*)::int count,
                    COUNT(*) FILTER (WHERE level='critical')::int critical,
                    COUNT(*) FILTER (WHERE level='warning')::int warning
             FROM alert_logs
             WHERE resolved=false AND acknowledged=false ${scope.clause ? 'AND ' + scope.clause : ''}`,
            scope.params
        ),
        pool.query('SELECT sound_enabled,silent_start,silent_end FROM user_notification_settings WHERE user_id=$1', [req.user.id])
    ]);
    const state = alerts.rows[0];
    const userSettings = notifications.rows[0];
    const enabled = userSettings ? Boolean(userSettings.sound_enabled) : true;
    const silent = userSettings ? isSilencePeriod(userSettings.silent_start, userSettings.silent_end) : false;
    res.json({ count: state.count, critical: state.critical, warning: state.warning, shouldSound: state.critical > 0 && enabled && !silent });
});

app.post('/api/notification-settings', async (req, res) => {
    const userId = req.user.id;
    const {
        line_enabled, line_bot_token, line_target,
        telegram_enabled, telegram_bot_token, telegram_chat_id,
        email_enabled, email_smtp_host, email_smtp_port, email_username, email_password, email_to, email_secure,
        webhook_enabled, webhook_url, webhook_headers,
        alert_critical, alert_warning, sound_enabled,
        silent_start, silent_end
    } = req.body;

    try {
        // Check if settings exist
        const check = await pool.query('SELECT id FROM user_notification_settings WHERE user_id=$1', [userId]);

        if (check.rows.length > 0) {
            // Update existing
            await pool.query(`UPDATE user_notification_settings SET
                line_enabled=$1, line_bot_token=COALESCE(NULLIF($2, ''), line_bot_token), line_target=$3,
                telegram_enabled=$4, telegram_bot_token=COALESCE(NULLIF($5, ''), telegram_bot_token), telegram_chat_id=$6,
                email_enabled=$7, email_smtp_host=$8, email_smtp_port=$9, email_username=$10, email_password=COALESCE(NULLIF($11, ''), email_password), email_to=$12, email_secure=$13,
                webhook_enabled=$14, webhook_url=$15, webhook_headers=COALESCE(NULLIF($16, ''), webhook_headers),
                alert_critical=$17, alert_warning=$18, sound_enabled=$19,
                silent_start=$20, silent_end=$21, updated_at=NOW()
            WHERE user_id=$22`, [
                line_enabled, line_bot_token, line_target,
                telegram_enabled, telegram_bot_token, telegram_chat_id,
                email_enabled, email_smtp_host, email_smtp_port, email_username, email_password, email_to, email_secure,
                webhook_enabled, webhook_url, webhook_headers,
                alert_critical, alert_warning, sound_enabled,
                silent_start, silent_end,
                userId
            ]);
        } else {
            // Insert new
            await pool.query(`INSERT INTO user_notification_settings (
                user_id, line_enabled, line_bot_token, line_target,
                telegram_enabled, telegram_bot_token, telegram_chat_id,
                email_enabled, email_smtp_host, email_smtp_port, email_username, email_password, email_to, email_secure,
                webhook_enabled, webhook_url, webhook_headers,
                alert_critical, alert_warning, sound_enabled,
                silent_start, silent_end
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`, [
                userId, line_enabled, line_bot_token, line_target,
                telegram_enabled, telegram_bot_token, telegram_chat_id,
                email_enabled, email_smtp_host, email_smtp_port, email_username, email_password, email_to, email_secure,
                webhook_enabled, webhook_url, webhook_headers,
                alert_critical, alert_warning, sound_enabled,
                silent_start, silent_end
            ]);
        }
        res.json({ success: true });
    } catch (e) {
        console.error("Notification Settings Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/notification-settings', async (req, res) => {
    const userId = req.user.id;

    // Load existing settings
    const settingsResult = await pool.query(
        'SELECT * FROM user_notification_settings WHERE user_id=$1', [userId]
    );
    const s = settingsResult.rows[0] || {};

    res.send(ui(req.user, 'notif', `
        <h2 class="text-2xl font-black mb-6">📱 Notification Settings</h2>
        <div class="space-y-6">
            <!-- LINE Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">🟢 LINE Messaging</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="line-enabled" ${s.line_enabled ? 'checked' : ''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">LINE Bot Token</label>
                        <input id="line-token" type="password" value="" placeholder="${s.line_bot_token ? 'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม' : 'LINE Messaging API Token'}" autocomplete="new-password" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">LINE Target (User ID / Group ID)</label>
                        <input id="line-target" value="${escapeHtml(s.line_target || '')}" placeholder="Uxxxxxxxxxxxxxxx หรือ Cxxxxxxxxxxxxxxx" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                </div>
            </div>

            <!-- Telegram Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">🔵 Telegram Bot</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="telegram-enabled" ${s.telegram_enabled ? 'checked' : ''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">Telegram Bot Token</label>
                        <input id="tg-token" type="password" value="" placeholder="${s.telegram_bot_token ? 'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม' : 'Telegram Bot Token'}" autocomplete="new-password" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Chat ID</label>
                        <input id="tg-chatid" value="${escapeHtml(s.telegram_chat_id || '')}" placeholder="-1001234567890" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                </div>
            </div>

            <!-- Email Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">📧 Email (SMTP)</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="email-enabled" ${s.email_enabled ? 'checked' : ''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">SMTP Host</label>
                        <input id="email-host" value="${escapeHtml(s.email_smtp_host || '')}" placeholder="smtp.gmail.com" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Port</label>
                        <input id="email-port" value="${s.email_smtp_port || 587}" type="number" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Username</label>
                        <input id="email-user" value="${escapeHtml(s.email_username || '')}" placeholder="your@email.com" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Password</label>
                        <input id="email-pass" type="password" value="" placeholder="${s.email_password ? 'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม' : 'App Password'}" autocomplete="new-password" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Email ปลายทาง</label>
                        <input id="email-to" value="${escapeHtml(s.email_to || '')}" placeholder="recipient@email.com" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="flex items-center gap-2 text-sm mt-5">
                            <input type="checkbox" id="email-secure" ${s.email_secure !== false ? 'checked' : ''}> TLS/SSL
                        </label>
                    </div>
                </div>
            </div>

            <!-- Webhook Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">🔗 Custom Webhook</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="webhook-enabled" ${s.webhook_enabled ? 'checked' : ''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">Webhook URL</label>
                        <input id="webhook-url" value="${escapeHtml(s.webhook_url || '')}" placeholder="https://hooks.slack.com/services/..." class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Custom Headers (JSON)</label>
                        <textarea id="webhook-headers" placeholder="${s.webhook_headers ? 'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม' : 'JSON headers'}" class="w-full border p-3 rounded-xl bg-slate-50 text-sm" rows="2"></textarea>
                    </div>
                </div>
            </div>

            <!-- Alert Rules -->
            <div class="card p-6">
                <h3 class="font-bold text-lg mb-4">⚙️ Alert Rules</h3>
                <div class="space-y-3">
                    <label class="flex items-center gap-3 text-sm">
                        <input type="checkbox" id="alert-critical" ${s.alert_critical !== false ? 'checked' : ''}>
                        <span class="font-bold">🔴 Critical Alerts</span>
                        <span class="text-slate-500 text-xs">(วิกฤต - ส่องแดง)</span>
                    </label>
                    <label class="flex items-center gap-3 text-sm">
                        <input type="checkbox" id="alert-warning" ${s.alert_warning ? 'checked' : ''}>
                        <span class="font-bold">🟡 Warning Alerts</span>
                        <span class="text-slate-500 text-xs">(เตือน - ส่องเหลือง)</span>
                    </label>
                    <label class="flex items-center gap-3 text-sm">
                        <input type="checkbox" id="sound-enabled" ${s.sound_enabled !== false ? 'checked' : ''}>
                        <span class="font-bold">🔊 Sound Alert</span>
                        <span class="text-slate-500 text-xs">(เสีงงในเว็บ)</span>
                    </label>
                </div>
                <div class="grid grid-cols-2 gap-3 mt-4">
                    <div>
                        <label class="text-xs font-bold text-slate-500">Silent Start</label>
                        <input id="silent-start" value="${s.silent_start || '22:00'}" type="time" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Silent End</label>
                        <input id="silent-end" value="${s.silent_end || '06:00'}" type="time" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                </div>
            </div>

            <!-- Save Button -->
            <button onclick="saveNotifSettings()" class="w-full bg-blue-600 text-white p-4 rounded-2xl font-bold text-lg hover:bg-blue-700 transition-colors">
                💾 บันทึกรายการตังค่า
            </button>
        </div>
    `, `
        async function saveNotifSettings() {
            const payload = {
                line_enabled: document.getElementById('line-enabled').checked,
                line_bot_token: document.getElementById('line-token').value,
                line_target: document.getElementById('line-target').value,
                telegram_enabled: document.getElementById('telegram-enabled').checked,
                telegram_bot_token: document.getElementById('tg-token').value,
                telegram_chat_id: document.getElementById('tg-chatid').value,
                email_enabled: document.getElementById('email-enabled').checked,
                email_smtp_host: document.getElementById('email-host').value,
                email_smtp_port: parseInt(document.getElementById('email-port').value) || 587,
                email_username: document.getElementById('email-user').value,
                email_password: document.getElementById('email-pass').value,
                email_to: document.getElementById('email-to').value,
                email_secure: document.getElementById('email-secure').checked,
                webhook_enabled: document.getElementById('webhook-enabled').checked,
                webhook_url: document.getElementById('webhook-url').value,
                webhook_headers: document.getElementById('webhook-headers').value,
                alert_critical: document.getElementById('alert-critical').checked,
                alert_warning: document.getElementById('alert-warning').checked,
                sound_enabled: document.getElementById('sound-enabled').checked,
                silent_start: document.getElementById('silent-start').value,
                silent_end: document.getElementById('silent-end').value
            };

            try {
                const r = await fetch('/api/notification-settings', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(payload)
                });
                const result = await r.json();
                if(result.success) {
                    alert('บันทึกรายการสำเร็จ!');
                } else {
                    alert('เกิดข้อมูผิดพลาด: ' + (result.error || 'Unknown error'));
                }
            } catch(e) {
                alert('Connection error: ' + e.message);
            }
        }
    `));
});

app.get('/login', (req, res) => res.send(`<!DOCTYPE html>
<html lang="th">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <title>เข้าสู่ระบบ | NurseAid PRO</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Prompt:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
        html, body { min-height: 100%; }
        body { padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
        input { font-size: 16px !important; }
        button, input { min-height: 3rem; touch-action: manipulation; }
    </style>
</head>
<body class="flex items-center justify-center min-h-[100dvh] bg-slate-900 font-['Prompt']">
    <main class="bg-white p-6 sm:p-10 rounded-3xl sm:rounded-[2.5rem] w-full max-w-sm shadow-2xl">
        <h1 class="text-3xl font-black text-blue-600 italic text-center mb-8 sm:mb-10">Nurse Aid</h1>
        <div class="space-y-4">
            <input id="u" autocomplete="username" placeholder="User" class="w-full p-4 rounded-2xl bg-slate-100 outline-none focus:ring-2 focus:ring-blue-500">
            <input id="p" type="password" autocomplete="current-password" placeholder="Password" class="w-full p-4 rounded-2xl bg-slate-100 outline-none focus:ring-2 focus:ring-blue-500">
            <button onclick="login()" class="w-full bg-blue-600 text-white p-4 rounded-2xl font-bold active:bg-blue-700">SIGN IN</button>
        </div>
        <div class="mt-6 flex items-center justify-center" aria-label="v2.14" title="v2.14">
            <span class="rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[10px] font-mono font-bold text-slate-500">v2.14</span>
        </div>
    </main>
    <script>
        async function login() {
            const u = document.getElementById('u').value;
            const p = document.getElementById('p').value;
            const r = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ u, p }) });
            const d = await r.json();
            if (d.success) {
                localStorage.setItem('nurse_name', d.name);
                localStorage.setItem('user_role', d.role);
                location.href='/';
            } else {
                alert('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง กรุณาติดต่อผู้ดูแลระบบ');
            }
        }
        document.getElementById('p').addEventListener('keydown', event => { if (event.key === 'Enter') login(); });
    </script>
</body>
</html>`));

let isSyncing = false;
let lastSyncTimestamp = new Date(Date.now() - 30000).toISOString();

async function syncData() {
    if (isSyncing) return;
    isSyncing = true;
    try {
        const nowMs = Date.now();
        const stopTimestamp = new Date(nowMs).toISOString();
        const active = await pool.query('SELECT mac, hm_number, name FROM nurseaid WHERE hm_number IS NOT NULL');

        if (active.rows.length === 0) {
            lastSyncTimestamp = stopTimestamp;
            return;
        }

        const macMap = new Map();
        active.rows.forEach(p => {
            const m = normalizeMac(p.mac);
            if (m) macMap.set(m, p);
        });

        const macList = Array.from(macMap.keys()).map(m => `"${escapeFluxString(m)}"`).join(", ");
        if (!macList) {
            lastSyncTimestamp = stopTimestamp;
            return;
        }

        const flux = `import "strings"
            from(bucket:"${influxConfig.bucket}")
            |> range(start: ${lastSyncTimestamp}, stop: ${stopTimestamp})
            |> filter(fn:(r) => exists r.mac and contains(value: strings.toLower(v: r.mac), set: [${macList}]))
            |> filter(fn:(r) =>
                r._measurement == "ble_heart" or
                r._measurement == "ble_spo2" or
                r._measurement == "ble_temp" or
                r._measurement == "ble_batt" or
                r._measurement == "ble_status"
            )
            |> pivot(rowKey:["_time"], columnKey: ["_measurement"], valueColumn: "_value")`;

        const records = [];
        await new Promise((resolve, reject) => {
            queryApi.queryRows(flux, {
                next: (row, tableMeta) => {
                    const d = tableMeta.toObject(row);
                    const mac = normalizeMac(d.mac);
                    if (!macMap.has(mac)) return;
                    const vital = getWearableVitalRecord(d);
                    if (!vital) return;

                    const p = macMap.get(mac);
                    records.push([
                        p.hm_number, p.name, p.mac,
                        vital.heartRate, vital.spo2, vital.temperature, vital.battery,
                        new Date(d._time)
                    ]);
                },
                error: reject,
                complete: resolve
            });
        });

        if (records.length > 0) {
            const hm_numbers = records.map(r => r[0]);
            const names = records.map(r => r[1]);
            const macs = records.map(r => r[2]);
            const hrs = records.map(r => r[3]);
            const spo2s = records.map(r => r[4]);
            const temps = records.map(r => r[5]);
            const batts = records.map(r => r[6]);
            const times = records.map(r => r[7]);

            await pool.query(`
                INSERT INTO vital_signs_logs (hm_number, patient_name, mac, heart_rate, spo2, temperature, battery, recorded_at)
                SELECT * FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[], $4::int[], $5::int[], $6::numeric[], $7::int[], $8::timestamp[])
                ON CONFLICT (mac, recorded_at)
                DO UPDATE SET
                    heart_rate = COALESCE(EXCLUDED.heart_rate, vital_signs_logs.heart_rate),
                    spo2 = COALESCE(EXCLUDED.spo2, vital_signs_logs.spo2),
                    temperature = COALESCE(EXCLUDED.temperature, vital_signs_logs.temperature),
                    battery = COALESCE(EXCLUDED.battery, vital_signs_logs.battery)
            `, [hm_numbers, names, macs, hrs, spo2s, temps, batts, times]);
        }
        lastSyncTimestamp = stopTimestamp;
    } catch (e) {
        console.error("Sync Error:", e);
    } finally {
        isSyncing = false;
    }
}
setInterval(syncData, 15000);


// ─── Wards Management ───────────────────────────────────────────────
// ─── Wards Management Routes ─────────────────────────────────────────
app.get('/wards-mgmt', requireCapability('wards:manage'), async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT w.*,
                   COUNT(DISTINCT uw.user_id) as assigned_users,
                   COUNT(DISTINCT p.mac) as active_devices
            FROM wards w
            LEFT JOIN user_wards uw ON w.id = uw.ward_id
            LEFT JOIN nurseaid p ON w.id = p.ward_id AND p.mac IS NOT NULL AND p.mac != ''
            WHERE w.is_active = true
            GROUP BY w.id
            ORDER BY w.code
        `);
        
        const wards = result.rows;
        
        res.send(ui(req.user, 'wards', `
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
                    <div class="card p-6 border-t-4 border-green-500">
                        <div class="flex justify-between items-start mb-4">
                            <div>
                                <h3 class="text-xl font-bold" style="color: var(--text-primary);">${escapeHtml(w.name)}</h3>
                                <div class="text-sm font-mono mt-1" style="color: var(--text-tertiary);">${escapeHtml(w.code)}</div>
                            </div>
                            <span class="px-2 py-1 rounded-full text-[10px] font-bold bg-green-100 text-green-700">
                                ACTIVE
                            </span>
                        </div>
                        <div class="space-y-2 text-sm mb-6" style="color: var(--text-secondary);">
                            <div class="flex justify-between"><span>Assigned Staff:</span> <span class="font-bold">${w.assigned_users}</span></div>
                            <div class="flex justify-between"><span>Active Devices:</span> <span class="font-bold">${w.active_devices}</span></div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="openWardModal(${w.id})" class="flex-1 px-3 py-2 rounded border font-bold text-xs" style="border-color: var(--border-color); color: var(--text-primary);">Edit</button>
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
        res.status(500).send(ui(req.user, 'wards', '<p class="text-red-600">Failed to load wards.</p>'));
    }
});

// ─── Ward CRUD API (backs the Wards Management modal) ────────────────
app.get('/api/wards/:id', requireCapability('wards:manage'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ward ID' });
    try {
        const result = await pool.query(
            'SELECT id, code as ward_code, name as ward_name, description FROM wards WHERE id=$1',
            [id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Ward not found' });
        res.json(result.rows[0]);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/wards', requireCapability('wards:manage'), async (req, res) => {
    const ward_code = String(req.body.ward_code || '').trim();
    const ward_name = String(req.body.ward_name || '').trim();
    const description = String(req.body.description || '').trim() || null;
    if (!ward_code || !ward_name) return res.status(400).json({ error: 'Ward code and name are required' });
    try {
        const result = await pool.query(
            'INSERT INTO wards (code, name, description) VALUES ($1, $2, $3) RETURNING id',
            [ward_code, ward_name, description]
        );
        logAudit(req, 'CREATE', 'ward', result.rows[0].id, { ward_code, ward_name }).catch(console.error);
        res.json({ success: true, id: result.rows[0].id });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Ward code already exists' });
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/wards/:id', requireCapability('wards:manage'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ward ID' });
    const ward_code = String(req.body.ward_code || '').trim();
    const ward_name = String(req.body.ward_name || '').trim();
    const description = String(req.body.description || '').trim() || null;
    if (!ward_code || !ward_name) return res.status(400).json({ error: 'Ward code and name are required' });
    try {
        const result = await pool.query(
            'UPDATE wards SET code=$1, name=$2, description=$3 WHERE id=$4 RETURNING id',
            [ward_code, ward_name, description, id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Ward not found' });
        logAudit(req, 'UPDATE', 'ward', id, { ward_code, ward_name }).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        if (e.code === '23505') return res.status(400).json({ error: 'Ward code already exists' });
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/wards/:id', requireCapability('wards:manage'), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: 'Invalid ward ID' });
    try {
        const result = await pool.query(
            'UPDATE wards SET is_active=false WHERE id=$1 RETURNING id',
            [id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'Ward not found' });
        logAudit(req, 'DEACTIVATE', 'ward', id, {}).catch(console.error);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ─── User-Ward Assignments ───────────────────────────────────────────
app.get('/user-wards-mgmt', requireCapability('users:manage:ward', 'users:manage:all'), async (req, res) => {
    try {
        const [wardsResult, usersResult, assignmentsResult] = await Promise.all([
            pool.query('SELECT id, code as ward_code, name as ward_name FROM wards WHERE is_active = true ORDER BY code'),
            pool.query('SELECT id, username, full_name, role FROM users ORDER BY username'),
            pool.query(`
                SELECT uw.id, uw.user_id, uw.ward_id, uw.role_in_ward, u.username, w.code as ward_code
                FROM user_wards uw
                JOIN users u ON u.id = uw.user_id
                JOIN wards w ON w.id = uw.ward_id
                ORDER BY u.username, w.code
            `)
        ]);
        
        const wards = wardsResult.rows;
        const users = usersResult.rows;
        
        res.send(ui(req.user, 'user-wards', `
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
                            ${users.map(u => `<option value="${u.id}">${escapeHtml(u.username)} (${escapeHtml(u.role)})</option>`).join('')}
                        </select>
                    </div>
                    <div class="flex-1 min-w-[180px]">
                        <label class="block text-sm font-bold mb-2" style="color: var(--text-secondary);">Ward</label>
                        <select id="assign-ward" required style="width: 100%; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-color);">
                            <option value="">Select ward...</option>
                            ${wards.map(w => `<option value="${w.id}">${escapeHtml(w.ward_code)} - ${escapeHtml(w.ward_name)}</option>`).join('')}
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
                        ${assignmentsResult.rows.map(a => `
                            <tr>
                                <td>${escapeHtml(a.username)}</td>
                                <td>${escapeHtml(a.ward_code)}</td>
                                <td><span class="px-2 py-1 rounded text-xs font-bold" style="background: var(--bg-badge); color: var(--text-badge);">${escapeHtml(a.role_in_ward)}</span></td>
                                <td><button onclick="removeAssignment(${a.id})" class="text-red-600 hover:text-red-800">Remove</button></td>
                            </tr>
                        `).join('')}
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
        res.status(500).send(ui(req.user, 'user-wards', '<p class="text-red-600">Failed to load assignments.</p>'));
    }
});

// ─── Audit Log Viewer ────────────────────────────────────────────────
app.get('/audit-log', requireCapability('audit:read:all', 'audit:read:ward'), async (req, res) => {
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
        
        // Ward scope: non-super_admin users can only see their own ward's audit logs
        if (req.user.role !== 'super_admin') {
            const userWards = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
            const wardIds = userWards.rows.map(r => r.ward_id);
            if (wardIds.length === 0) {
                // No wards assigned -> show empty
                return res.send(ui(req.user, 'audit-log', '<p class="text-center text-slate-400 py-12">No audit logs available for your wards.</p>', ''));
            }
            whereClauses.push(`al.ward_id = ANY($${paramIndex++})`);
            params.push(wardIds);
        }
        
        const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';
        
        const [logsResult, wardsResult, countResult] = await Promise.all([
            pool.query(`
                SELECT al.*, u.username, u.full_name
                FROM audit_logs al
                LEFT JOIN users u ON u.id = al.user_id
                ${whereSql}
                ORDER BY al.created_at DESC
                LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
            `, [...params, limit, offset]),
            pool.query('SELECT id, code as ward_code FROM wards ORDER BY code'),
            pool.query(`
                SELECT COUNT(*) 
                FROM audit_logs al 
                LEFT JOIN users u ON u.id = al.user_id 
                ${whereSql}
            `, params)
        ]);
        
        const logs = logsResult.rows;
        const totalLogs = parseInt(countResult.rows[0].count);
        const totalPages = Math.ceil(totalLogs / limit);
        
        res.send(ui(req.user, 'audit-log', `
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
                            <option value="LOGIN" ${req.query.action === 'LOGIN' ? 'selected' : ''}>LOGIN</option>
                            <option value="LOGOUT" ${req.query.action === 'LOGOUT' ? 'selected' : ''}>LOGOUT</option>
                            <option value="CREATE" ${req.query.action === 'CREATE' ? 'selected' : ''}>CREATE</option>
                            <option value="UPDATE" ${req.query.action === 'UPDATE' ? 'selected' : ''}>UPDATE</option>
                            <option value="DELETE" ${req.query.action === 'DELETE' ? 'selected' : ''}>DELETE</option>
                        </select>
                    </div>
                    <div class="flex-1 min-w-[150px]">
                        <label class="block text-xs font-bold mb-1" style="color: var(--text-secondary);">Ward</label>
                        <select name="ward_id" class="w-full border p-2 rounded text-xs bg-slate-50">
                            <option value="">All Wards</option>
                            ${wardsResult.rows.map(w => `<option value="${w.id}" ${req.query.ward_id == w.id ? 'selected' : ''}>${escapeHtml(w.ward_code)}</option>`).join('')}
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
                        ${logs.map(l => `
                            <tr class="border-b border-slate-50 hover:bg-slate-50">
                                <td class="text-slate-500 whitespace-nowrap">${new Date(l.created_at).toLocaleString('th-TH')}</td>
                                <td class="font-bold">${escapeHtml(l.username || 'System')}</td>
                                <td><span class="px-2 py-1 rounded-full text-[9px] bg-slate-100">${escapeHtml(l.actor_role || '-')}</span></td>
                                <td class="font-bold ${
                                    l.action === 'LOGIN' ? 'text-green-600' :
                                    l.action === 'DELETE' ? 'text-red-500' :
                                    l.action === 'CREATE' ? 'text-blue-500' : 'text-slate-600'
                                }">${escapeHtml(l.action)}</td>
                                <td>
                                    <span class="uppercase font-mono text-[9px] text-slate-400">${escapeHtml(l.entity_type)}</span>
                                    ${l.entity_id ? ` <span class="font-bold">#${escapeHtml(l.entity_id)}</span>` : ''}
                                </td>
                                <td class="max-w-[200px] truncate" title='${escapeHtml(JSON.stringify(l.details))}'>
                                    <code class="text-[9px] text-slate-500 bg-slate-50 px-1 py-0.5 rounded">${escapeHtml(JSON.stringify(l.details))}</code>
                                </td>
                                <td class="text-slate-400 font-mono text-[10px]">${escapeHtml(l.ip_address || '-')}</td>
                            </tr>
                        `).join('')}
                        ${logs.length === 0 ? '<tr><td colspan="7" class="text-center py-8 text-slate-400">No logs found</td></tr>' : ''}
                    </tbody>
                </table>
            </div>
            
            ${totalPages > 1 ? `
                <div class="mt-4 flex justify-between items-center text-xs">
                    <span class="text-slate-500">Showing ${offset + 1} - ${Math.min(offset + limit, totalLogs)} of ${totalLogs} logs</span>
                    <div class="flex gap-2">
                        ${page > 1 ? `<a href="?page=${page-1}&${new URLSearchParams(req.query).toString()}" class="px-3 py-1 border rounded hover:bg-slate-50">Previous</a>` : ''}
                        <span class="px-3 py-1 bg-slate-100 rounded font-bold">${page} / ${totalPages}</span>
                        ${page < totalPages ? `<a href="?page=${page+1}&${new URLSearchParams(req.query).toString()}" class="px-3 py-1 border rounded hover:bg-slate-50">Next</a>` : ''}
                    </div>
                </div>
            ` : ''}
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
        res.status(500).send(ui(req.user, 'audit-log', '<p class="text-red-600">Failed to load audit log.</p>'));
    }
});

async function startServer() {
    await initDatabase();
    initMqttClient();
    // Allow MQTT connection to establish before seeding paired list
    setTimeout(() => publishPairedDeviceList(), 2000);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_alert_logs_active ON alert_logs(resolved, acknowledged)`);
    await pool.query(`UPDATE alert_logs SET resolved=true, resolved_at=COALESCE(resolved_at,NOW())
                      WHERE resolved=false AND created_at < NOW() - INTERVAL '24 hours'`);
    await pool.query(`WITH ranked AS (
                        SELECT id, ROW_NUMBER() OVER (PARTITION BY LOWER(mac) ORDER BY created_at DESC,id DESC) AS position
                        FROM alert_logs WHERE resolved=false
                      )
                      UPDATE alert_logs SET resolved=true,resolved_at=NOW()
                      WHERE id IN (SELECT id FROM ranked WHERE position > 1)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_alert_logs_one_active_mac
                      ON alert_logs(LOWER(mac)) WHERE resolved=false`);
    const activeStates = await pool.query(`SELECT DISTINCT ON (LOWER(mac)) mac,level FROM alert_logs
                                           WHERE resolved=false ORDER BY LOWER(mac),created_at DESC`);
    activeStates.rows.forEach(row => { deviceAlertState[normalizeMac(row.mac)] = row.level; });
    await runAlertEngine();
    setInterval(runAlertEngine, ALERT_ENGINE_INTERVAL_MS);
    app.listen(PORT, '0.0.0.0', () => console.log('✅ SERVER RUNNING ON PORT ' + PORT));
}

startServer().catch(err => {
    console.error('Server startup failed:', err);
    process.exit(1);
});
