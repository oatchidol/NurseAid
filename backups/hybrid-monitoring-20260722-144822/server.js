const express = require('express');
const { Pool } = require('pg');
const { InfluxDB } = require('@influxdata/influxdb-client');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { promisify } = require('util');
const {
    buildLiveSnapshot,
    createResilientSingleFlightCache,
    markStatusesUnavailable
} = require('./live-status');
const app = express();

const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3333;
const parsedLiveFreshness = Number.parseInt(process.env.LIVE_VITAL_FRESHNESS_SECONDS || '600', 10);
const LIVE_VITAL_FRESHNESS_SECONDS = Number.isFinite(parsedLiveFreshness) && parsedLiveFreshness > 0
    ? parsedLiveFreshness
    : 600;
const parsedStatusFreshness = Number.parseInt(process.env.LIVE_STATUS_FRESHNESS_SECONDS || '180', 10);
const parsedBatteryFreshness = Number.parseInt(process.env.LIVE_BATTERY_FRESHNESS_SECONDS || '1800', 10);
const LIVE_FRESHNESS_POLICY = {
    clinical: LIVE_VITAL_FRESHNESS_SECONDS,
    status: Number.isFinite(parsedStatusFreshness) && parsedStatusFreshness > 0 ? parsedStatusFreshness : 180,
    battery: Number.isFinite(parsedBatteryFreshness) && parsedBatteryFreshness > 0 ? parsedBatteryFreshness : 1800,
    quality: LIVE_VITAL_FRESHNESS_SECONDS
};
const LIVE_DATA_QUERY_WINDOW_MINUTES = Math.max(
    5,
    Math.ceil(Math.max(...Object.values(LIVE_FRESHNESS_POLICY)) / 60) + 1
);
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
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[char]);
}

function escapeJsSingle(value) {
    return escapeHtml(String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n\u2028\u2029]/g, ' '));
}

const publicPaths = new Set(['/login', '/api/login', '/health']);
app.use((req, res, next) => {
    if (publicPaths.has(req.path)) return next();

    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    try {
        req.user = jwt.verify(token || '', SESSION_SECRET);
    } catch (_) {
        if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Authentication required' });
        return res.redirect('/login');
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
const LIVE_STATUS_CACHE_MS = Math.max(0, Number.parseInt(process.env.LIVE_STATUS_CACHE_MS || '3000', 10) || 0);
let alertEngineRunning = false;

// Initialize database tables
async function initDatabase() {
    const tables = [
        `CREATE TABLE IF NOT EXISTS alert_settings (
            id SERIAL PRIMARY KEY,
            mac VARCHAR(50) UNIQUE,
            hr_min INTEGER DEFAULT 50, hr_max INTEGER DEFAULT 120,
            spo2_min INTEGER DEFAULT 95,
            temp_min DECIMAL(3,1) DEFAULT 35.5, temp_max DECIMAL(3,1) DEFAULT 37.5,
            enable_sound BOOLEAN DEFAULT true,
            enable_line BOOLEAN DEFAULT true,
            enable_webhook BOOLEAN DEFAULT false,
            webhook_url TEXT,
            webhook_headers TEXT,
            silence_start TIME DEFAULT '22:00',
            silence_end TIME DEFAULT '06:00',
            escalation_enabled BOOLEAN DEFAULT false,
            escalation_timeout INTEGER DEFAULT 15,
            battery_low_threshold INTEGER DEFAULT 20,
            offline_threshold_minutes INTEGER DEFAULT 10,
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
        try { await pool.query(sql); } catch(e) { console.error("Table init error:", e.message); }
    }
    // Runtime migrations for existing installations
    try {
        await pool.query("ALTER TABLE nurseaid ADD COLUMN IF NOT EXISTS device_type VARCHAR(20) DEFAULT 'jstyle'");
        await pool.query("UPDATE nurseaid SET device_type='jstyle' WHERE device_type IS NULL OR device_type='' ");
        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_vital_signs_logs_mac_recorded_at
            ON vital_signs_logs(mac, recorded_at)
        `);
    } catch(e) { console.error("Migration error:", e.message); }
    // Insert default alert settings if empty
    const count = await pool.query('SELECT COUNT(*) FROM alert_settings');
    if (parseInt(count.rows[0].count) === 0) {
        await pool.query(`INSERT INTO alert_settings (mac, hr_min, hr_max, spo2_min, temp_min, temp_max, enable_sound, enable_line)
            VALUES ('*', 50, 120, 95, 35.5, 37.5, true, true)`);
    }

    const userCount = await pool.query('SELECT COUNT(*) FROM users');
    if (parseInt(userCount.rows[0].count) === 0) {
        const initialPassword = process.env.INITIAL_ADMIN_PASSWORD || '';
        if (initialPassword.length < 12) {
            throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 12 characters when no users exist');
        }
        await pool.query(
            'INSERT INTO users (username, full_name, password, role) VALUES ($1,$2,$3,$4)',
            [process.env.INITIAL_ADMIN_USERNAME || 'admin', 'Administrator', await hashPassword(initialPassword), 'admin']
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
        } catch(e) {}
        return { success: true, status: response.status, body };
    } catch(e) {
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
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
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
            tasks.push(postJson('https://api.line.me/v2/bot/message/push', {
                to: user.line_target, messages: [{ type: 'text', text }]
            }, { Authorization: `Bearer ${user.line_bot_token}` }));
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
        tasks.push(postJson('https://api.line.me/v2/bot/message/push', {
            to: GROUP_ID, messages: [{ type: 'text', text }]
        }, { Authorization: `Bearer ${LINE_TOKEN}` }));
    }
    if (deviceSettings.enable_webhook && deviceSettings.webhook_url && !isSilencePeriod(deviceSettings.silence_start, deviceSettings.silence_end)) {
        tasks.push(sendWebhook(deviceSettings.webhook_url, payload, deviceSettings.webhook_headers, alert.id));
    }
    const results = await Promise.allSettled(tasks);
    results.filter(item => item.status === 'rejected').forEach(item => console.error('[Alert Notification]', item.reason?.message || item.reason));
}

async function triggerAlert(mac, bed, name, level, category, msg, deviceSettings) {
    const inserted = await pool.query(
        `INSERT INTO alert_logs (mac, bed_no, patient_name, level, category, message)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [mac, bed, name, level, category, msg]
    );
    const alert = inserted.rows[0];
    await dispatchAlertNotifications(alert, deviceSettings).catch(error => console.error('[Alert Dispatch]', error.message));
    return alert;
}

const ui = (active, content, script = "") => `
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
            --accent-red-light: #fecaca;
            --accent-green-light: #bbf7d0;
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
            --accent-red-light: rgba(248, 81, 73, 0.15);
            --accent-green-light: rgba(63, 185, 80, 0.15);
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

        #sidePanel {
            position: fixed; top: 0; right: -700px; width: 650px; height: 100vh;
            z-index: 1000;
            transition: right 0.5s cubic-bezier(0.4, 0, 0.2, 1),
                        background-color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        color 0.6s cubic-bezier(0.4, 0, 0.2, 1),
                        box-shadow 0.5s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: -10px 0 30px rgba(0,0,0,0.5);
            padding: 1.5rem; overflow-y: auto;
            background: var(--bg-card);
            border-left: 2px solid var(--border-color);
            color: var(--text-primary);
        }
        #sidePanel.active { right: 0; }
        .panel-overlay {
            position: fixed; inset: 0; background: rgba(15, 23, 42, 0.5);
            z-index: 999; display: none; backdrop-filter: blur(4px);
        }
        @media (max-width: 800px) { #sidePanel { width: 100%; right: -100%; } }
        @media (min-width: 801px) { #sidePanel { width: 650px; } }

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

        #monitor-grid {
            display: grid !important;
            grid-template-columns: repeat(auto-fill, minmax(285px, 1fr)) !important;
            gap: 0.75rem !important;
            align-items: start !important;
        }

        @media (min-width: 1800px) {
            #monitor-grid {
                grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)) !important;
            }
        }

        @media (min-width: 2500px) {
            #monitor-grid {
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
            #monitor-grid {
                grid-template-columns: 1fr !important;
            }

            .dashboard-subtitle {
                display: none !important;
            }
        }

        #sidePanel {
            padding: 1.35rem !important;
        }

        #sidePanel .panel-compact-header {
            margin-bottom: 0.5rem !important;
        }

        #sidePanel #p-title {
            font-size: 1.1rem !important;
            line-height: 1.2 !important;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 500px;
        }

        #sidePanel .panel-meta-row {
            display: flex !important;
            flex-wrap: wrap;
            align-items: center;
            gap: 0.3rem;
            margin-top: 0.25rem;
        }

        #sidePanel .trend-grid {
            gap: 0.5rem !important;
        }

        #sidePanel .trend-card {
            padding: 0.6rem !important;
            border-radius: 0.75rem !important;
        }

        #sidePanel .trend-card-head {
            margin-bottom: 0.25rem !important;
        }

        #sidePanel .trend-chart {
            height: 100px !important;
        }

        #sidePanel .trend-card-head p {
            font-size: 0.7rem !important;
        }

        #sidePanel .trend-card-head span {
            font-size: 0.65rem !important;
        }

        @media (max-height: 850px) {
            #sidePanel .trend-chart {
                height: 85px !important;
            }

            #sidePanel .trend-card {
                padding: 0.5rem !important;
            }

            #sidePanel {
                padding: 0.75rem !important;
            }
        }

        @media (max-height: 740px) {
            #sidePanel .trend-chart {
                height: 75px !important;
            }
        }

        body.is-admin td.admin-only { display: table-cell !important; }
        body.is-admin th.admin-only { display: table-cell !important; }
        body.is-admin div.admin-only { display: block !important; }

        @media (max-width: 768px) {
            #sidePanel {
                width: 100% !important;
                right: -100%;
                height: 100dvh;
                padding: max(1rem, env(safe-area-inset-top)) 1rem max(1rem, env(safe-area-inset-bottom)) !important;
            }

            #sidePanel.active { right: 0; }
            #sidePanel #p-title { max-width: calc(100vw - 5rem); }
            #sidePanel .panel-meta-row { gap: 0.4rem; }
            #sidePanel .trend-chart { height: 105px !important; }

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
            #sidePanel button {
                min-height: 2.75rem;
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
        </div>

        <nav class="flex flex-col gap-1 flex-1">
            <a href="/" title="Monitor" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='dash'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📊</span><span class="sidebar-hide">Monitor</span>
            </a>

            <a href="/export" title="Report" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='export'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📥</span><span class="sidebar-hide">Report</span>
            </a>

            <a href="/devices-mgmt" title="Devices" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='devs'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📟</span><span class="sidebar-hide">Devices</span>
            </a>

            <a href="/patients-mgmt" title="Patients" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='pats'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">👥</span><span class="sidebar-hide">Patients</span>
            </a>

            <a href="/matching" title="Pairing" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='match'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">⌚</span><span class="sidebar-hide">Pairing</span>
            </a>

            <a href="/users-mgmt" title="Users" class="admin-only nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='users'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">🛡️</span><span class="sidebar-hide">Users</span>
            </a>
        </nav>

        <div class="sidebar-hide mt-4 pt-4 border-t" style="border-color: var(--border-color);">
            <p class="text-[8px] font-bold uppercase tracking-widest mb-2 px-2" style="color: var(--text-tertiary);">Alerts</p>
            <a href="/notification-settings" title="Notification" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='notif'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📱</span><span class="sidebar-hide">Notification</span>
            </a>
            <a href="/alert-settings" title="Alert Settings" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='alert'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">🔔</span><span class="sidebar-hide">Alert Settings</span>
            </a>
            <a href="/alert-history" title="Alert History" class="nav-link p-2.5 flex items-center gap-2.5 font-semibold transition-all text-xs rounded-lg" style="${active==='ahist'?'':'color: var(--text-secondary);'}">
                <span class="nav-icon text-sm">📋</span><span class="sidebar-hide">Alert History</span>
            </a>
        </div>

        <button onclick="logout()" title="Logout" class="admin-only nav-link font-bold p-2.5 border-t mt-3 rounded-lg transition-all flex items-center gap-2.5 text-xs" style="color: var(--accent-red); border-color: var(--border-color);">
            <span class="nav-icon text-sm">🚪</span><span class="sidebar-hide">Logout</span>
        </button>
    </aside>

    <main id="appMain" class="flex-1 p-6 md:p-8 overflow-auto">${content}</main>
    <a id="siteAlertBanner" href="/alert-history" class="hidden fixed top-3 left-1/2 -translate-x-1/2 z-[100] bg-red-600 text-white px-5 py-3 rounded-xl shadow-2xl font-bold text-sm" role="alert" aria-live="assertive"></a>

        <div id="globalModal" class="modal"><div class="p-8 rounded-3xl w-full max-w-md shadow-2xl transition-all" style="background: var(--bg-card); border: 1px solid var(--border-color);"><h3 id="modalTitle" class="text-xl font-bold mb-6" style="color: var(--text-primary);"></h3><div id="modalBody" class="space-y-4"></div><div class="flex gap-3 mt-8"><button onclick="document.getElementById('globalModal').style.display='none'" class="flex-1 p-3 rounded-xl font-bold" style="background: var(--bg-badge); color: var(--text-secondary); border: 1px solid var(--border-color);">ยกเลิก</button><button id="modalSubmit" class="flex-1 p-3 rounded-xl font-bold" style="background: var(--accent-primary); color: var(--text-inverse);">ตกลง</button></div></div></div>

    <div id="panelOverlay" class="panel-overlay" onclick="closePanel()"></div>
    <div id="sidePanel" style="background: var(--bg-card); border-left: 1px solid var(--border-color);">
        <div class="panel-compact-header flex justify-between items-start">
            <div class="min-w-0 pr-4">
                <h2 id="p-title" class="text-3xl font-black uppercase" style="color: var(--text-heading);">Trend</h2>
                <div class="panel-meta-row">
                    <span id="p-hn" class="text-sm font-bold tracking-widest" style="color: var(--accent-primary);"></span>
                    <button id="panel-export-btn" type="button"
                        class="text-[10px] px-3 py-1 rounded-full font-black uppercase shadow-sm transition-all"
                        style="background: var(--accent-primary); color: var(--text-inverse);">
                        ⬇ Export CSV 24h
                    </button>
                    <span class="text-[10px] px-3 py-1 rounded-full font-bold uppercase italic"
                        style="background: var(--bg-badge); color: var(--text-badge); border: 1px solid var(--border-color);">
                        Show: Last 24 Hours
                    </span>
                </div>
            </div>
            <button onclick="closePanel()" class="p-2 rounded-2xl transition-all text-2xl"
                style="background: var(--bg-badge); color: var(--text-secondary); border: 1px solid var(--border-color);">✕</button>
        </div>
        <div class="trend-grid grid grid-cols-1 gap-3">
            <div class="trend-card card p-4 shadow-sm" style="background: var(--bg-vital); border: 1px solid var(--border-color);">
                <div class="trend-card-head flex justify-between items-center mb-2">
                    <p class="text-xs font-bold uppercase" style="color: var(--accent-red);">🫀 Heart Rate (BPM)</p>
                    <span id="avg-hr" class="text-[10px] font-mono" style="color: var(--text-tertiary);"></span>
                </div>
                <div class="trend-chart h-[145px]"><canvas id="chartHR_Panel"></canvas></div>
            </div>

            <div class="trend-card card p-4 shadow-sm" style="background: var(--bg-vital); border: 1px solid var(--border-color);">
                <div class="trend-card-head flex justify-between items-center mb-2">
                    <p class="text-xs font-bold uppercase" style="color: var(--accent-primary);">💧 Oxygen Saturation (SpO2 %)</p>
                    <span id="avg-spo2" class="text-[10px] font-mono" style="color: var(--text-tertiary);"></span>
                </div>
                <div class="trend-chart h-[145px]"><canvas id="chartSPO2_Panel"></canvas></div>
            </div>

            <div class="trend-card card p-4 shadow-sm" style="background: var(--bg-vital); border: 1px solid var(--border-color);">
                <div class="trend-card-head flex justify-between items-center mb-2">
                    <p class="text-xs font-bold uppercase" style="color: #f97316;">🌡 Body Temperature (°C)</p>
                    <span id="avg-temp" class="text-[10px] font-mono" style="color: var(--text-tertiary);"></span>
                </div>
                <div class="trend-chart h-[145px]"><canvas id="chartTEMP_Panel"></canvas></div>
            </div>
        </div>
    </div>

    <audio id="alertSound" src="https://actions.google.com/sounds/v1/alarms/beep_short.ogg" preload="auto"></audio>

    <script>
        let nurse = '';
        let role = 'viewer';
        const escapeHTML = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;'
        })[char]);
        fetch('/api/me').then(async response => {
            if (!response.ok) throw new Error('Unauthenticated');
            const user = await response.json();
            nurse = user.name || user.username || '';
            role = user.role || 'viewer';
            if(role === 'admin') document.body.classList.add('is-admin');
            document.getElementById('display-nurse').innerText = nurse;
            document.getElementById('display-role').innerText = role === 'admin' ? '🛡️ Administrator' : '👁️ Viewer';
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
                document.getElementById('globalModal').style.display = 'none';
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

        function openModal(title, bodyHtml, submitFn) {
            document.getElementById('modalTitle').innerText = title;
            document.getElementById('modalBody').innerHTML = bodyHtml;
            document.getElementById('modalSubmit').onclick = submitFn;
            document.getElementById('globalModal').style.display = 'flex';
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
                    banner.textContent = state.count > 0 ? '🚨 Alert ที่ยังไม่รับทราบ ' + state.count + ' รายการ — แตะเพื่อดู' : '';
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

        function closePanel() {
            document.getElementById('sidePanel').classList.remove('active');
            document.getElementById('panelOverlay').style.display = 'none';
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

        function ensurePanelExportButton(hn, name) {
            const btn = document.getElementById('panel-export-btn');
            if (!btn) return;

            btn.innerText = '⬇ Export CSV 24h';
            btn.disabled = false;
            btn.onclick = function() {
                exportPatient24h(hn, name);
            };
        }

        async function exportPatient24h(hn, name) {
            const btn = document.getElementById('panel-export-btn');

            if (!hn) {
                alert('ไม่พบ HN ของคนไข้');
                return;
            }

            const now = new Date();
            const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
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
                    alert('ไม่พบข้อมูลย้อนหลัง 24 ชั่วโมงของคนไข้คนนี้');
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
                const fileName = 'Patient_24H_' +
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
                    btn.innerText = '⬇ Export CSV 24h';
                }
            }
        }

        async function showTrend(mac, name, hn) {
            ensurePanelExportButton(hn, name);
            document.getElementById('p-title').innerText = name;
            document.getElementById('p-hn').innerText = 'HN: ' + hn;
            document.getElementById('sidePanel').classList.add('active');
            document.getElementById('panelOverlay').style.display = 'block';

            try {
                const res = await fetch('/api/patient-trend-24h/' + encodeURIComponent(hn));
                const data = await res.json();

                if(!data || data.length === 0) return;

                const labels = data.map(d => {
                    const date = new Date(d._time);
                    return date.toLocaleTimeString('th-TH', {hour:'2-digit', minute:'2-digit'});
                });

                const render = (id, label, color, key, min, max) => {
                    if(panelCharts[id]) panelCharts[id].destroy();
                    panelCharts[id] = new Chart(document.getElementById(id), {
                        type: 'line',
                        data: {
                            labels,
                            datasets: [{
                                label,
                                data: data.map(d => d[key]),
                                borderColor: color,
                                backgroundColor: color + '10',
                                fill: true,
                                tension: 0.35,
                                pointRadius: 0,
                                borderWidth: 2,
                                spanGaps: true
                            }]
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            interaction: { intersect: false, mode: 'index' },
                            plugins: { legend: { display: false } },
                            scales: {
                                y: {
                                    min, max,
                                    grid: { color: ctx => {
                                        const theme = document.documentElement.getAttribute('data-theme');
                                        return theme === 'dark' ? '#21262d' : '#e2e8f0';
                                    }, borderDash: [5, 5] }
                                },
                                x: {
                                    grid: { display: false },
                                    ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8, color: ctx => {
                                        const theme = document.documentElement.getAttribute('data-theme');
                                        return theme === 'dark' ? '#7d8590' : '#94a3b8';
                                    } }
                                }
                            }
                        }
                    });
                };

                render('chartHR_Panel', 'HR', '#ef4444', 'ble_heart', 40, 160);
                render('chartSPO2_Panel', 'SpO2', '#3b82f6', 'ble_spo2', 80, 100);
                render('chartTEMP_Panel', 'Temp', '#f97316', 'ble_temp', 34, 41);

            } catch (err) {
                console.error('Error fetching trend:', err);
            }
        }

        ${script}
    </script>
</body>
</html>`;

const adminOnly = (req, res, next) => {
    if(req.user?.role === 'admin') next(); else res.status(403).json({error: 'Forbidden'});
};

app.post('/api/login', async(req,res)=>{
    const username = String(req.body.u || '').trim();
    const password = String(req.body.p || '');
    if (!username || !password) return res.status(400).json({ success: false });

    const r = await pool.query('SELECT id, username, full_name, role, password FROM users WHERE username=$1', [username]);
    const user = r.rows[0];
    if (!user || !(await verifyPassword(password, user.password))) {
        return res.status(401).json({ success: false });
    }

    if (!user.password.startsWith('scrypt:')) {
        await pool.query('UPDATE users SET password=$1 WHERE id=$2', [await hashPassword(password), user.id]);
    }

    const token = jwt.sign(
        { id: user.id, username: user.username, name: user.full_name, role: user.role },
        SESSION_SECRET,
        { expiresIn: '8h', issuer: 'nurseaid' }
    );
    res.setHeader('Set-Cookie', sessionCookie(token));
    res.json({ success:true, name:user.full_name, role:user.role });
});

app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ success: true });
});

app.get('/api/me', (req, res) => {
    res.json({ id: req.user.id, name: req.user.name, role: req.user.role });
});

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
            |> range(start: -${LIVE_DATA_QUERY_WINDOW_MINUTES}m)
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
                        status = (!isNaN(statusNum) && statusNum === 1) ? 'Online' : 'Offline';
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
                            }
                            if (temp !== '--' && (temp > 37.8 || temp < 35.5)) {
                                alertLevel = 'critical';
                                alertCauses.push(`Temp=${temp}`);
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
                            : 'ไม่พบข้อมูลสดจากอุปกรณ์');
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
        pool.query(`SELECT mac, device_no, name, hm_number, bed_no,
                           COALESCE(device_type, 'jstyle') AS device_type
                    FROM nurseaid WHERE hm_number IS NOT NULL ORDER BY bed_no`),
        pool.query('SELECT * FROM alert_settings')
    ]);
    if (devicesResult.rows.length === 0) return [];

    const defaultSettings = settingsResult.rows.find(row => row.mac === '*') || {
        hr_min: 50, hr_max: 120, spo2_min: 95, temp_min: 35.5, temp_max: 37.5,
        enable_sound: true, enable_line: true, enable_webhook: false,
        battery_low_threshold: 20, offline_threshold_minutes: 10
    };
    const settingByMac = new Map(settingsResult.rows.filter(row => row.mac !== '*').map(row => [normalizeMac(row.mac), row]));
    const fluxQuery = `
        from(bucket: "${influxConfig.bucket}")
            |> range(start: -${LIVE_DATA_QUERY_WINDOW_MINUTES}m)
            |> filter(fn: (r) => r._measurement == "ble_heart" or r._measurement == "ble_spo2" or
                r._measurement == "ble_spo2_quality" or r._measurement == "ble_temp" or
                r._measurement == "ble_status" or r._measurement == "ble_batt")
            |> filter(fn: (r) => r._field == "value" or r._field == "status")
            |> group(columns: ["mac", "_measurement", "_field"])
            |> last()`;
    const rows = await queryApi.collectRows(fluxQuery);
    const measurementKeys = {
        ble_heart: 'heart', ble_spo2: 'spo2', ble_spo2_quality: 'spo2Quality',
        ble_temp: 'temp', ble_status: 'status', ble_batt: 'battery'
    };
    const influxData = new Map();
    for (const row of rows) {
        const mac = normalizeMac(row.mac);
        const key = measurementKeys[row._measurement];
        const timestampMs = new Date(row._time).getTime();
        if (!mac || !key || !Number.isFinite(timestampMs)) continue;
        if (row._measurement === 'ble_spo2_quality' && row._field !== 'status') continue;
        const sensor = influxData.get(mac) || {};
        if (!sensor[key] || timestampMs >= sensor[key].timestampMs) sensor[key] = { value: row._value, timestampMs };
        influxData.set(mac, sensor);
    }

    const nowMs = Date.now();
    return devicesResult.rows.map(device => {
        const mac = normalizeMac(device.mac);
        const sensor = influxData.get(mac);
        const settings = { ...defaultSettings, ...(settingByMac.get(mac) || {}), mac: device.mac };
        const snapshot = buildLiveSnapshot(sensor, nowMs, LIVE_FRESHNESS_POLICY);
        let { hr, temp, battery } = snapshot;
        let spo2 = snapshot.spo2;
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
            if (hr !== '--' && (hr < Number(settings.hr_min) || hr > Number(settings.hr_max))) {
                alertLevel = 'critical'; causes.push(`HR=${hr} bpm`);
            }
            if (temp !== '--' && (temp < Number(settings.temp_min) || temp > Number(settings.temp_max))) {
                alertLevel = 'critical'; causes.push(`Temp=${temp}°C`);
            }
            if (spo2 !== '--' && spo2 < Number(settings.spo2_min)) {
                alertLevel = spo2 <= Number(settings.spo2_min) - 4 ? 'critical' : (alertLevel === 'critical' ? 'critical' : 'warning');
                causes.push(`SpO2=${spo2}%`);
            }
        }
        const missingMetrics = [['HR', hr], ['SpO2', spo2], ['Temp', temp]].filter(([, value]) => value === '--').map(([name]) => name);
        const wearState = snapshot.explicitOffWrist ? false : (snapshot.worn ? true : null);
        const dataQuality = !snapshot.connected
            ? 'offline'
            : (snapshot.explicitOffWrist
                ? 'off_wrist'
                : (wearState === null ? 'sensor_waiting' : (missingMetrics.length ? 'partial' : 'complete')));
        const dataMessage = dataQuality === 'offline'
            ? 'ไม่พบข้อมูลสดจากอุปกรณ์'
            : (dataQuality === 'off_wrist'
                ? 'อุปกรณ์ยืนยันว่าไม่ได้สวม · ซ่อนค่าทางคลินิกเก่าแล้ว'
                : (dataQuality === 'sensor_waiting'
                    ? 'อุปกรณ์เชื่อมต่อ แต่ยังไม่ได้รับสัญญาณจากเซ็นเซอร์'
                    : (missingMetrics.length ? `ข้อมูลไม่ครบ: ${missingMetrics.join(', ')}` : 'ข้อมูลครบและเป็นปัจจุบัน')));
        return {
            ...device, hr, spo2, temp, battery, status: snapshot.connected ? 'Online' : 'Offline',
            isWorn: wearState,
            spo2Quality: String(snapshot.explicitOffWrist ? 'off_wrist' : (snapshot.spo2Quality || (String(device.device_type).toLowerCase() !== 'jstyle' && spo2 !== '--' ? 'verified' : 'unavailable'))).toLowerCase(),
            alertLevel, alertCauses: causes, limits: {
                hrMin: Number(settings.hr_min), hrMax: Number(settings.hr_max), spo2Min: Number(settings.spo2_min),
                tempMin: Number(settings.temp_min), tempMax: Number(settings.temp_max)
            },
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
        for (const status of statuses) {
            const mac = normalizeMac(status.mac);
            const previous = deviceAlertState[mac] || 'normal';
            const current = status.status === 'Online' ? status.alertLevel : 'offline';
            if (current !== previous) {
                await pool.query(`UPDATE alert_logs SET resolved=true, resolved_at=NOW()
                                  WHERE LOWER(mac)=LOWER($1) AND resolved=false`, [status.mac]);
                if (current === 'critical' || current === 'warning') {
                    await triggerAlert(status.mac, status.bed_no, status.name, current, 'vital', status.alertCauses.join(', '), status._alertSettings);
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
        const statuses = snapshot.stale
            ? markStatusesUnavailable(snapshot.value)
            : snapshot.value;
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

app.get('/api/patient-trend-24h/:hn', async (req, res) => {
    const { hn } = req.params;
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

        // Step 2: Query InfluxDB for vital signs (primary source)
        // Use the same query pattern as /api/live-status but with 24h range and aggregateWindow
        const influxQuery = `
            import "strings"

            from(bucket: "${influxConfig.bucket}")
                |> range(start: -24h)
                |> filter(fn: (r) =>
                    r._measurement == "ble_heart" or
                    r._measurement == "ble_spo2" or
                    r._measurement == "ble_temp"
                )
                |> filter(fn: (r) => exists r.mac and strings.toLower(v: r.mac) == "${escapeFluxString(macNormalized)}")
                |> aggregateWindow(every: 5m, fn: mean, createEmpty: false)
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
                date_trunc('minute', recorded_at) - (CAST(extract(minute from recorded_at) AS integer) % 5) * interval '1 minute' as _time,
                ROUND(AVG(heart_rate)) as ble_heart,
                ROUND(AVG(spo2), 1) as ble_spo2,
                ROUND(AVG(temperature), 2) as ble_temp
            FROM vital_signs_logs
            WHERE hm_number = $1
            AND recorded_at > NOW() - INTERVAL '24 hours'
            AND (
                COALESCE(heart_rate, 0) > 0 OR
                COALESCE(spo2, 0) > 0 OR
                COALESCE(temperature, 0) > 0
            )
            GROUP BY 1
            ORDER BY 1 ASC
        `;
        const result = await pool.query(queryText, [hn]);
        console.log(`[Trend] HN=${hn} Postgres fallback returned ${result.rows.length} rows`);
        res.json(result.rows);
    } catch (err) {
        console.error("Patient Trend Error:", err);
        res.status(500).json([]);
    }
});

app.get('/', (req, res) => res.send(ui('dash', `
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

    <div id="monitor-grid" class="monitor-grid-auto"></div>
`, `
    let latestPatients = [];
    function getLimits(mac) {
        return latestPatients.find(patient => patient.mac === mac)?.limits || { hrMin: 50, hrMax: 120, spo2Min: 95, tempMin: 35.5, tempMax: 37.5 };
    }

    function openIndividualConfig(mac, name, bed) {
        const current = getLimits(mac);
        const html = \`
            <div class="bg-blue-50 p-4 rounded-2xl mb-4 text-center">
                <p class="text-xs font-bold text-blue-600 uppercase">ตั้งค่าขีดจำกัดรายบุคคล</p>
                <p class="font-bold text-slate-800">เตียง \${bed}: \${name}</p>
            </div>
            <div class="grid grid-cols-2 gap-4 text-sm">
                <div class="col-span-2 font-bold text-slate-500 border-b pb-1">Heart Rate (BPM)</div>
                <div><label class="text-[10px]">Min</label><input type="number" id="th-hrMin" value="\${current.hrMin}" class="w-full border p-2 rounded-lg"></div>
                <div><label class="text-[10px]">Max</label><input type="number" id="th-hrMax" value="\${current.hrMax}" class="w-full border p-2 rounded-lg"></div>
                <div class="col-span-2 font-bold text-slate-500 border-b pb-1 mt-2">SpO2 (%)</div>
                <div class="col-span-2"><label class="text-[10px]">ต่ำกว่า (Min %)</label><input type="number" id="th-spo2Min" value="\${current.spo2Min}" class="w-full border p-2 rounded-lg"></div>
                <div class="col-span-2 font-bold text-slate-500 border-b pb-1 mt-2">Temperature (°C)</div>
                <div><label class="text-[10px]">Min</label><input type="number" id="th-tempMin" value="\${current.tempMin}" step="0.1" class="w-full border p-2 rounded-lg"></div>
                <div><label class="text-[10px]">Max</label><input type="number" id="th-tempMax" value="\${current.tempMax}" step="0.1" class="w-full border p-2 rounded-lg"></div>
            </div>
            <button onclick="window.resetToDefault('\${mac}')" class="w-full mt-4 text-[10px] text-slate-400 underline italic">ล้างค่าและใช้ค่าเริ่มต้น</button>
        \`;
        openModal('⚙️ Settings', html, async () => {
            const response = await fetch('/api/alert-settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
                mac, hrMin: Number(document.getElementById('th-hrMin').value), hrMax: Number(document.getElementById('th-hrMax').value),
                spo2Min: Number(document.getElementById('th-spo2Min').value), tempMin: Number(document.getElementById('th-tempMin').value),
                tempMax: Number(document.getElementById('th-tempMax').value)
            }) });
            if (!response.ok) return alert('ไม่สามารถบันทึกค่าได้');
            document.getElementById('globalModal').style.display='none';
            updateDash();
        });
    }

    window.resetToDefault = async (mac) => {
        const response = await fetch('/api/alert-settings/' + encodeURIComponent(mac), {method:'DELETE'});
        if (!response.ok) return alert('ไม่สามารถคืนค่าเริ่มต้นได้');
        document.getElementById('globalModal').style.display='none';
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
                if (node) node.replaceWith(replacement);
                node = replacement;
            } else {
                const status = node.querySelector('[data-role="patient-status"]');
                if (status) status.textContent = card.statusText;
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
            const theme = document.documentElement.getAttribute('data-theme');
            const isDark = theme === 'dark';

            const cards = data.map(p => {
                const isUnavailable = p.status === 'Unavailable' || p.dataQuality === 'telemetry_unavailable';
                const isOnline = p.status === 'Online';
                const isWorn = p.isWorn === true;
                const isOffWrist = isOnline && p.isWorn === false;
                const isSensorWaiting = isOnline && p.isWorn === null;
                const isPartial = isOnline && isWorn && p.dataQuality === 'partial';
                const canEvaluateVitals = isOnline && isWorn && !p.telemetryStale;
                const limit = getLimits(p.mac);
                const isHrCrit = canEvaluateVitals && p.hr !== '--' && (p.hr > limit.hrMax || p.hr < limit.hrMin);
                const isSpo2Crit = canEvaluateVitals && p.spo2 !== '--' && (p.spo2 < limit.spo2Min);
                const isTempCrit = canEvaluateVitals && p.temp !== '--' && (p.temp > limit.tempMax || p.temp < limit.tempMin);
                const isCrit = isHrCrit || isSpo2Crit || isTempCrit;
                if(isCrit) criticalBeds.push(p.bed_no || '-');

                const statusColor = isUnavailable
                    ? 'bg-red-400 shadow-[0_0_8px_rgba(248,113,113,0.45)]'
                    : isOffWrist
                    ? 'bg-slate-400'
                    : (isPartial || isSensorWaiting)
                    ? 'bg-amber-400 shadow-[0_0_8px_rgba(245,158,11,0.55)]'
                    : (isOnline ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]' : (isDark ? 'bg-gray-600' : 'bg-gray-300'));
                const hasCustom = p.hasCustomLimits;
                const statusLabel = isUnavailable
                    ? 'ระบบข้อมูลขัดข้อง'
                    : (!isOnline ? 'ออฟไลน์' : (isOffWrist ? 'ไม่ได้สวม' : (isSensorWaiting ? 'รอสัญญาณเซ็นเซอร์' : (isPartial ? 'ข้อมูลไม่ครบ' : 'พร้อมใช้งาน'))));
                const statusLabelColor = isUnavailable
                    ? 'color: var(--accent-red);'
                    : (!isOnline || isOffWrist)
                    ? 'color: var(--text-tertiary);'
                    : ((isPartial || isSensorWaiting) ? 'color: #f59e0b;' : 'color: var(--accent-green);');
                const ageSeconds = Number.isFinite(Number(p.lastSeenSeconds)) ? Number(p.lastSeenSeconds) : null;
                const freshnessLabel = ageSeconds === null
                    ? ''
                    : (ageSeconds < 10 ? 'อัปเดตเมื่อสักครู่' : 'อัปเดต ' + ageSeconds + ' วินาทีที่แล้ว');
                const statusText = statusLabel + (freshnessLabel ? ' · ' + freshnessLabel : '');
                const spo2QualityLabels = {
                    measuring: 'กำลังวัด',
                    unstable: 'สัญญาณไม่นิ่ง',
                    timeout: 'วัดไม่สำเร็จ',
                    off_wrist: 'ไม่ได้สวม',
                    unavailable: '--'
                };
                const spo2Display = p.spo2 !== '--' ? p.spo2 : (spo2QualityLabels[p.spo2Quality] || '--');

                let battColor = isDark ? 'text-gray-500' : 'text-gray-400';
                if (p.battery !== '--') {
                    if (p.battery < 20) battColor = 'text-red-500 animate-pulse font-bold';
                    else if (p.battery < 40) battColor = 'text-orange-500 font-bold';
                }

                const bedBg = isDark ? 'bg-gray-700' : 'bg-gray-800';
                const nameColor = isDark ? 'text-gray-100' : 'text-slate-800';
                const hnColor = isDark ? 'text-gray-500' : 'text-slate-400';
                const settingsColor = isDark ? 'text-gray-600 hover:text-blue-400' : 'text-slate-300 hover:text-blue-600';
                const vitalBg = isDark ? 'style="background: var(--bg-vital);"' : 'class="bg-slate-50"';
                const vitalTextColor = isDark ? 'var(--text-vital-muted)' : 'text-slate-400';
                const normalVitalNumColor = isDark ? '#e6edf3' : '#334155';
                const criticalVitalBg = isDark
                    ? 'style="background: var(--accent-red-light); border: 1px solid rgba(248, 81, 73, 0.3);"'
                    : 'style="background: var(--accent-red-light); border: 1px solid var(--accent-red-light);"';
                // Highlight only the metric that is outside its own limits.
                // A critical SpO2 or temperature must not make a normal HR red.
                const hrBg = isHrCrit ? criticalVitalBg : vitalBg;
                const spo2Bg = isSpo2Crit ? criticalVitalBg : vitalBg;
                const tempBg = isTempCrit ? criticalVitalBg : vitalBg;
                const hrNumColor = isHrCrit ? 'var(--accent-red)' : normalVitalNumColor;
                const spo2NumColor = isSpo2Crit ? 'var(--accent-red)' : normalVitalNumColor;
                const tempNumColor = isTempCrit ? 'var(--accent-red)' : normalVitalNumColor;

                const key = String(p.mac || p.device_no || p.hm_number);
                const signature = JSON.stringify({
                    theme, p: { ...p, lastSeenAt: null, lastSeenSeconds: null, vitalLastSeenSeconds: null },
                    statusLabel, isHrCrit, isSpo2Crit, isTempCrit
                });
                const html = \`
                <div class="card p-4 border-t-4 transition-all" style="\${(isCrit || isUnavailable) ? 'border-color: var(--accent-red);' : ((isPartial || isSensorWaiting) ? 'border-color: #f59e0b;' : (isOnline ? 'border-color: var(--accent-green);' : 'border-color: var(--border-color);'))}">
                    <div class="flex items-center justify-between mb-4 gap-2 pb-2" style="border-bottom-color: var(--border-color);">
                        <div class="flex items-center gap-2 overflow-hidden flex-1">
                            <span class="shrink-0 text-[10px] px-2 py-0.5 rounded font-bold italic uppercase tracking-tighter" style="background: \${bedBg}; color: white;">\${p.bed_no || '-'}</span>
                            <div class="w-2.5 h-2.5 shrink-0 rounded-full \${statusColor}" title="\${p.dataMessage || statusLabel}"></div>
                            <div class="flex flex-col truncate">
                                <h4 class="font-bold text-sm truncate cursor-pointer leading-tight" style="color: \${nameColor};" onclick="showTrend('\${p.mac}', '\${p.name}', '\${p.hm_number}')">
                                    \${p.name}
                                </h4>
                                <div class="flex items-center gap-2">
                                    <span class="text-[9px] font-bold uppercase" style="color: \${hnColor};">HN: \${p.hm_number}</span>
                                    <div class="flex items-center gap-0.5 \${battColor}">
                                        <svg class="w-4 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                            <rect x="1" y="6" width="18" height="12" rx="2" ry="2"></rect>
                                            <line x1="23" y1="13" x2="23" y2="11"></line>
                                            <line x1="5" y1="9" x2="\${p.battery !== '--' ? (5 + (p.battery * 0.1)) : 5}" y2="9" stroke-width="4" stroke="currentColor" opacity="0.8"></line>
                                        </svg>
                                        <span class="text-[10px] font-bold">\${p.battery}\${p.battery !== '--' ? '%' : ''}</span>
                                    </div>
                                </div>
                                <span data-role="patient-status" class="text-[9px] font-bold truncate" style="\${statusLabelColor}" title="\${p.dataMessage || statusLabel}">
                                    \${statusText}
                                </span>
                            </div>
                            \${hasCustom ? '<span class="text-[10px] shrink-0" title="ตั้งค่าเฉพาะบุคคล">⚙️</span>' : ''}
                        </div>
                        <button onclick="openIndividualConfig('\${p.mac}', '\${p.name}', '\${p.bed_no}')" class="shrink-0 p-1 transition-colors \${settingsColor}">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                        </button>
                    </div>

                    <div class="grid grid-cols-3 gap-2">
                        <div class="p-2 rounded-xl text-center transition-all" \${hrBg}>
                            <p class="text-[8px] font-bold uppercase" style="color: \${vitalTextColor};">HR</p>
                            <p class="text-3xl font-black tracking-tighter" style="color: \${hrNumColor};">\${p.hr}</p>
                        </div>
                        <div class="p-2 rounded-xl text-center transition-all" \${spo2Bg}>
                            <p class="text-[8px] font-bold uppercase" style="color: \${vitalTextColor};">SpO2</p>
                            <p class="\${p.spo2 === '--' ? 'text-xs mt-2' : 'text-3xl'} font-black tracking-tighter" style="color: \${spo2NumColor};" title="SpO2 quality: \${p.spo2Quality || 'unavailable'}">\${spo2Display}</p>
                        </div>
                        <div class="p-2 rounded-xl text-center transition-all" \${tempBg}>
                            <p class="text-[8px] font-bold uppercase" style="color: \${vitalTextColor};">Temp</p>
                            <p class="text-3xl font-black tracking-tighter" style="color: \${tempNumColor};">\${p.temp}</p>
                        </div>
                    </div>
                </div>\`;
                return { key, signature, html, statusText };
            });
            reconcilePatientCards(grid, cards);

            const shouldSound = data.some(p => p.alertLevel === 'critical' && p.soundEnabled);
            if(criticalBeds.length > 0){
                globalBanner.classList.remove('hidden');
                globalBanner.innerText = '🚨 วิกฤต: เตียง ' + criticalBeds.join(', ');
                stopAlertLoop(); // เสียงส่วนกลางของ layout ทำงานในทุกหน้าเว็บ
            } else {
                globalBanner.classList.add('hidden');
                stopAlertLoop();
            }
            document.getElementById('last-sync').innerText = 'Last Sync: ' + new Date().toLocaleTimeString();
        } catch(e) {
            console.error('Dashboard Update Error:', e);
            const grid = document.getElementById('monitor-grid');
            if (grid && latestPatients.length === 0) {
                grid.innerHTML = '<div class="card col-span-full p-8 text-center border border-red-300"><p class="font-bold text-red-500">ไม่สามารถโหลดข้อมูลสดได้</p><p class="text-xs mt-1" style="color: var(--text-tertiary);">ระบบจะลองเชื่อมต่อใหม่อัตโนมัติ</p></div>';
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
        ORDER BY
            CASE WHEN n.hm_number IS NOT NULL THEN 0 ELSE 1 END,
            COALESCE(n.bed_no, ''),
            p.name
    `);

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

    res.send(ui('export', `
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
            SELECT p.name, n.mac
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

app.get('/devices-mgmt', adminOnly, async (req, res) => {
    await ensureDeviceTypeColumn();
    const r = await pool.query("SELECT * FROM nurseaid WHERE mac IS NOT NULL AND mac != '' ORDER BY device_no");
    const rows = r.rows.map(d => `<tr><td class="font-bold">#${escapeHtml(d.device_no)}</td><td><span class="px-2 py-1 rounded-lg text-[10px] font-bold ${d.device_type==='wearos'?'bg-purple-100 text-purple-700':'bg-slate-100 text-slate-700'}">${escapeHtml(d.device_type || 'jstyle')}</span></td><td class="font-mono text-slate-400 text-xs">${escapeHtml(d.mac)}</td><td class="text-right admin-only"><button onclick="editD('${escapeJsSingle(d.mac)}','${escapeJsSingle(d.device_no)}','${escapeJsSingle(d.device_type || 'jstyle')}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delD('${escapeJsSingle(d.mac)}')" class="text-red-400 font-bold">ลบ</button></td></tr>`).join('');
    res.send(ui('devs', `
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
                <table><thead><tr><th>No</th><th>Type</th><th>MAC / Device ID</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table>
            </div>
        </div>
    `, `
        window.addD = async () => { await fetch('/api/devices', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({dno:document.getElementById('dno').value,mac:document.getElementById('m_addr').value,device_type:document.getElementById('dtype').value}) }); location.reload(); }
        window.editD = (mac, dno, dtype) => { openModal('✏️ แก้ไข', '<input id="edno" value="'+dno+'" class="w-full border p-3 rounded-xl bg-slate-50 mb-3"><select id="edtype" class="w-full border p-3 rounded-xl bg-slate-50"><option value="jstyle" '+(dtype==='jstyle'?'selected':'')+'>JStyle / iStyle Watch</option><option value="wearos" '+(dtype==='wearos'?'selected':'')+'>Wear OS Peripheral</option></select>', async () => { await fetch('/api/devices/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac, newDno:document.getElementById('edno').value, device_type:document.getElementById('edtype').value, role: localStorage.getItem('user_role')}) }); location.reload(); }); }
        window.delD = async (m) => { if(confirm('ลบ?')) { await fetch('/api/devices/'+m+'?role='+localStorage.getItem('user_role'), {method:'DELETE'}); location.reload(); } }

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

app.get('/patients-mgmt', adminOnly, async (req, res) => {
    const r = await pool.query("SELECT * FROM patients WHERE name IS NOT NULL AND name != '' AND hn_number IS NOT NULL AND hn_number != '' ORDER BY name");
    const rows = r.rows.map(p => `<tr><td class="font-bold text-blue-600">${escapeHtml(p.hn_number)}</td><td>${escapeHtml(p.name)}</td><td class="text-right admin-only"><button onclick="editP('${escapeJsSingle(p.hn_number)}','${escapeJsSingle(p.name)}')" class="text-blue-500 font-bold mr-3">แก้ไข</button><button onclick="delP('${escapeJsSingle(p.hn_number)}')" class="text-red-500 font-bold">ลบ</button></td></tr>`).join('');
    res.send(ui('pats', `<div class="grid md:grid-cols-3 gap-8"><div class="admin-only card p-6 h-fit"><h3 class="font-bold mb-6">👥 เพิ่มคนไข้</h3><div class="space-y-4"><input id="p_hn" placeholder="HN" class="w-full border p-3 rounded-xl bg-slate-50"><input id="p_nm" placeholder="ชื่อ-สกุล" class="w-full border p-3 rounded-xl bg-slate-50"><button onclick="addP()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button></div></div><div class="md:col-span-2 card overflow-hidden"><table><thead><tr><th>HN</th><th>Name</th><th class="admin-only"></th></tr></thead><tbody>${rows}</tbody></table></div></div>`, `
        window.addP = async () => { await fetch('/api/patients', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({hn:document.getElementById('p_hn').value,nm:document.getElementById('p_nm').value}) }); location.reload(); }
        window.editP = (hn, name) => { openModal('✏️ แก้ไข', '<input id="enm" value="'+name+'" class="w-full border p-3 rounded-xl bg-slate-50">', async () => { await fetch('/api/patients/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({hn, newName:document.getElementById('enm').value, role: localStorage.getItem('user_role')}) }); location.reload(); }); }
        window.delP = async (id) => { if(confirm('ลบ?')) { await fetch('/api/patients/'+id+'?role='+localStorage.getItem('user_role'), {method:'DELETE'}); location.reload(); } }
    `));
});

app.get('/matching', adminOnly, async (req, res) => {
    const r = await pool.query('SELECT * FROM nurseaid ORDER BY device_no ASC');
    const cards = r.rows.map(x => `<div class="card p-6 ${x.hm_number?'bg-blue-50 border-blue-200':''}"><div class="flex justify-between mb-4"><span class="bg-slate-800 text-white text-[10px] px-2 py-1 rounded font-bold uppercase">#${escapeHtml(x.device_no)}</span> ${x.bed_no?`<span class="bg-blue-600 text-white text-[10px] px-2 py-1 rounded font-bold italic">BED ${escapeHtml(x.bed_no)}</span>`:''}</div><div class="min-h-[80px]">${x.hm_number ? `<p class="text-blue-900 font-bold">${escapeHtml(x.name)}</p><p class="text-[10px] text-blue-500 font-bold">HN: ${escapeHtml(x.hm_number)}</p>` : `<p class="text-slate-300 italic">Available</p>`}</div><div class="mt-4">${x.hm_number ? `<button onclick="unpair('${escapeJsSingle(x.mac)}')" class="admin-only w-full p-2 text-red-500 border border-red-100 rounded-lg text-[10px] font-bold">Unpair</button>` : `<button onclick="openPair('${escapeJsSingle(x.mac)}', '${escapeJsSingle(x.device_no)}')" class="admin-only w-full p-2 bg-blue-600 text-white rounded-lg text-[10px] font-bold">Pair Device</button>`}</div></div>`).join('');
    res.send(ui('match', `<h2 class="text-xl font-bold mb-8">Pairing</h2><div class="grid grid-cols-2 md:grid-cols-4 gap-6">${cards}</div>`, `
        window.openPair = async (mac, dno) => {
            currentMac = mac; const res = await fetch('/api/patients-available'); const pats = await res.json();
            const opts = pats.map(p => '<option value="'+escapeHTML(p.hn_number)+'|'+escapeHTML(p.name)+'">'+escapeHTML(p.name)+' ('+escapeHTML(p.hn_number)+')</option>').join('');
            openModal('🔗 จับคู่ #'+dno, '<input id="bed" placeholder="Bed (e.g. B01)" class="w-full border p-3 rounded-xl bg-slate-50 mb-3"><select id="selP" class="w-full border p-3 rounded-xl bg-slate-50">'+opts+'</select>', async () => {
                const bed = document.getElementById('bed').value;
                const [hn, name] = document.getElementById('selP').value.split('|');
                await fetch('/api/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac:currentMac, hn, name, bed}) });
                location.reload();
            });
        }
        window.unpair = async (mac) => { if(confirm('ยกเลิก?')) { await fetch('/api/unpair', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({mac})}); location.reload(); } }
    `));
});

app.get('/users-mgmt', adminOnly, async (req, res) => {
    const r = await pool.query("SELECT * FROM users WHERE username IS NOT NULL AND username != '' ORDER BY id");
    const rows = r.rows.map(u => `<tr><td class="font-bold text-slate-700">${escapeHtml(u.username)}</td><td>${escapeHtml(u.full_name)}</td><td>${escapeHtml(u.role)}</td><td class="text-right"><button onclick="editU('${escapeJsSingle(u.id)}', '${escapeJsSingle(u.full_name)}', '${escapeJsSingle(u.role)}')" class="text-blue-500 font-bold mr-3 text-xs">แก้ไข</button><button onclick="delU('${escapeJsSingle(u.id)}')" class="text-red-400 font-bold text-xs">ลบ</button></td></tr>`).join('');
    res.send(ui('users', `<div class="grid md:grid-cols-3 gap-8"><div class="admin-only card p-6 h-fit"><h3 class="font-bold mb-6">🛡️ เพิ่ม User</h3><div class="space-y-3"><input id="u_un" placeholder="User" class="w-full border p-3 rounded-xl bg-slate-50"><input id="u_fn" placeholder="ชื่อ" class="w-full border p-3 rounded-xl bg-slate-50"><input id="u_pw" type="password" placeholder="Pass" class="w-full border p-3 rounded-xl bg-slate-50"><select id="u_ur" class="w-full border p-3 rounded-xl bg-slate-50"><option value="viewer">Viewer</option><option value="admin">Admin</option></select><button onclick="addU()" class="w-full bg-blue-600 text-white p-4 rounded-xl font-bold">บันทึก</button></div></div><div class="md:col-span-2 card overflow-hidden"><table><thead><tr><th>User</th><th>Name</th><th>Role</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`, `
        window.addU = async () => { await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({un:document.getElementById('u_un').value,fn:document.getElementById('u_fn').value,pw:document.getElementById('u_pw').value,urole:document.getElementById('u_ur').value, role: localStorage.getItem('user_role')}) }); location.reload(); }
        window.editU = (id, curFn, curRole) => { openModal('✏️ แก้ไข', '<input id="efn" value="'+curFn+'" class="w-full border p-3 rounded-xl bg-slate-50 mb-3"><select id="eur" class="w-full border p-3 rounded-xl bg-slate-50"><option value="viewer" '+(curRole==='viewer'?'selected':'')+'>Viewer</option><option value="admin" '+(curRole==='admin'?'selected':'')+'>Admin</option></select><input id="epw" type="password" placeholder="New Pass" class="w-full border p-3 rounded-xl bg-slate-50">', async () => { await fetch('/api/users/update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id,fn:document.getElementById('efn').value,urole:document.getElementById('eur').value,pw:document.getElementById('epw').value, role: localStorage.getItem('user_role')}) }); location.reload(); }); }
        window.delU = async (id) => { if(confirm('ลบ?')) { await fetch('/api/users/'+id+'?role='+localStorage.getItem('user_role'), {method:'DELETE'}); location.reload(); } }
    `));
});

app.post('/api/devices', adminOnly, async(req,res)=>{
    await ensureDeviceTypeColumn();
    const deviceType = ['jstyle', 'wearos'].includes(req.body.device_type) ? req.body.device_type : 'jstyle';
    await pool.query('INSERT INTO nurseaid (device_no, mac, device_type) VALUES ($1,$2,$3)',[req.body.dno, req.body.mac, deviceType]);
    res.sendStatus(200);
});
app.post('/api/devices/update', adminOnly, async(req,res)=>{
    await ensureDeviceTypeColumn();
    const deviceType = ['jstyle', 'wearos'].includes(req.body.device_type) ? req.body.device_type : 'jstyle';
    await pool.query('UPDATE nurseaid SET device_no=$1, device_type=$2 WHERE mac=$3',[req.body.newDno, deviceType, req.body.mac]);
    res.sendStatus(200);
});
app.delete('/api/devices/:mac', adminOnly, async(req,res)=>{ await pool.query('DELETE FROM nurseaid WHERE mac=$1',[req.params.mac]); res.sendStatus(200); });
app.post('/api/patients', adminOnly, async(req,res)=>{ await pool.query('INSERT INTO patients (hn_number, name) VALUES ($1,$2)',[req.body.hn, req.body.nm]); res.sendStatus(200); });
app.post('/api/patients/update', adminOnly, async(req,res)=>{ await pool.query('UPDATE patients SET name=$1 WHERE hn_number=$2',[req.body.newName, req.body.hn]); res.sendStatus(200); });
app.delete('/api/patients/:id', adminOnly, async(req,res)=>{ await pool.query('DELETE FROM patients WHERE hn_number=$1',[req.params.id]); res.sendStatus(200); });
app.post('/api/users', adminOnly, async(req,res)=>{ await pool.query('INSERT INTO users (username, full_name, password, role) VALUES ($1,$2,$3,$4)',[req.body.un, req.body.fn, await hashPassword(req.body.pw), req.body.urole]); res.sendStatus(200); });
app.post('/api/users/update', adminOnly, async(req,res)=>{ const { id, fn, urole, pw } = req.body; if(pw) await pool.query('UPDATE users SET full_name=$1, role=$2, password=$3 WHERE id=$4',[fn, urole, await hashPassword(pw), id]); else await pool.query('UPDATE users SET full_name=$1, role=$2 WHERE id=$3',[fn, urole, id]); res.sendStatus(200); });
app.delete('/api/users/:id', adminOnly, async(req,res)=>{ await pool.query('DELETE FROM users WHERE id=$1',[req.params.id]); res.sendStatus(200); });

app.post('/api/pair', adminOnly, async (req, res) => {
    const { hn, name, bed, mac } = req.body;
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

        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.post('/api/unpair', adminOnly, async (req, res) => {
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

        res.sendStatus(200);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

app.get('/api/patients-available', async(req,res)=> {
    const r = await pool.query(
        'SELECT * FROM patients WHERE hn_number NOT IN (SELECT hm_number FROM nurseaid WHERE hm_number IS NOT NULL)'
    );
    res.json(r.rows);
});

app.get('/alert-settings', adminOnly, async (req, res) => {
    const r = await pool.query(`SELECT n.*, COALESCE(s.hr_min,d.hr_min,50) hr_min, COALESCE(s.hr_max,d.hr_max,120) hr_max,
        COALESCE(s.spo2_min,d.spo2_min,95) spo2_min, COALESCE(s.temp_min,d.temp_min,35.5) temp_min,
        COALESCE(s.temp_max,d.temp_max,37.5) temp_max, COALESCE(s.enable_sound,d.enable_sound,true) enable_sound,
        COALESCE(s.enable_line,d.enable_line,true) enable_line, COALESCE(s.enable_webhook,d.enable_webhook,false) enable_webhook,
        COALESCE(s.webhook_url,d.webhook_url,'') webhook_url
        FROM nurseaid n LEFT JOIN alert_settings s ON LOWER(s.mac)=LOWER(n.mac)
        LEFT JOIN alert_settings d ON d.mac='*' WHERE n.hm_number IS NOT NULL ORDER BY n.bed_no`);
    const rows = r.rows.map(d => {
        return `<tr>
            <td class="font-bold">#${escapeHtml(d.device_no)}</td>
            <td class="font-mono text-xs">${escapeHtml(d.mac)}</td>
            <td>${escapeHtml(d.bed_no)}</td>
            <td>${escapeHtml(d.name)}</td>
            <td class="text-right admin-only">
                <button onclick="editAlertSettings('${escapeJsSingle(d.mac)}', ${Number(d.hr_min)||50}, ${Number(d.hr_max)||120}, ${Number(d.spo2_min)||95}, ${Number(d.temp_min)||35.5}, ${Number(d.temp_max)||37.5}, ${Boolean(d.enable_sound)}, ${Boolean(d.enable_line)}, ${Boolean(d.enable_webhook)}, '${escapeJsSingle(d.webhook_url||'')}')" class="text-blue-500 font-bold text-xs">ตังค่า</button>
            </td>
        </tr>`;
    }).join('');
    res.send(ui('alert', `
        <h2 class="text-2xl font-black mb-6">🔔 Alert Settings</h2>
        <div class="card overflow-hidden">
            <table class="w-full">
                <thead><tr><th>Device</th><th>MAC</th><th>Bed</th><th>Patient</th><th class="admin-only">Actions</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
    `, `
        window.editAlertSettings = async (mac, hrMin, hrMax, spo2Min, tempMin, tempMax, enableSound, enableLine, enableWebhook, webhookUrl) => {
            const html = \`
                <div class="space-y-4">
                    <div class="bg-blue-50 p-3 rounded-xl text-center"><p class="text-xs font-bold text-blue-600">MAC: \${mac}</p></div>
                    <div class="grid grid-cols-2 gap-3">
                        <div><label class="text-xs font-bold">HR Min</label><input id="as-hrMin" value="\${hrMin}" class="w-full border p-2 rounded-lg"></div>
                        <div><label class="text-xs font-bold">HR Max</label><input id="as-hrMax" value="\${hrMax}" class="w-full border p-2 rounded-lg"></div>
                        <div><label class="text-xs font-bold">SpO2 Min</label><input id="as-spo2Min" value="\${spo2Min}" class="w-full border p-2 rounded-lg"></div>
                        <div><label class="text-xs font-bold">Temp Min</label><input id="as-tempMin" value="\${tempMin}" step="0.1" class="w-full border p-2 rounded-lg"></div>
                        <div><label class="text-xs font-bold">Temp Max</label><input id="as-tempMax" value="\${tempMax}" step="0.1" class="w-full border p-2 rounded-lg"></div>
                    </div>
                    <div class="space-y-2">
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-sound" \${enableSound?'checked':''}> เສียงเตือน</label>
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-line" \${enableLine?'checked':''}> LINE Work</label>
                        <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="as-webhook" \${enableWebhook?'checked':''}> Webhook</label>
                    </div>
                    <div id="webhook-url-div" class="\${enableWebhook?'':'hidden'}">
                        <label class="text-xs font-bold">Webhook URL</label>
                        <input id="as-webhookUrl" value="\${webhookUrl}" placeholder="https://hooks.slack.com/..." class="w-full border p-2 rounded-lg">
                    </div>
                </div>
            \`;
            openModal('⚙️ Alert Settings', html, async () => {
                await fetch('/api/alert-settings', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({
                        mac,
                        hrMin: parseInt(document.getElementById('as-hrMin').value),
                        hrMax: parseInt(document.getElementById('as-hrMax').value),
                        spo2Min: parseInt(document.getElementById('as-spo2Min').value),
                        tempMin: parseFloat(document.getElementById('as-tempMin').value),
                        tempMax: parseFloat(document.getElementById('as-tempMax').value),
                        enableSound: document.getElementById('as-sound').checked,
                        enableLine: document.getElementById('as-line').checked,
                        enableWebhook: document.getElementById('as-webhook').checked,
                        webhookUrl: document.getElementById('as-webhookUrl').value
                    })
                });
                document.getElementById('globalModal').style.display='none';
                location.reload();
            });
        };
        document.getElementById('as-webhook')?.addEventListener('change', function() {
            document.getElementById('webhook-url-div').classList.toggle('hidden', !this.checked);
        });
    `));
});

app.get('/alert-history', async (req, res) => {
    const r = await pool.query('SELECT * FROM alert_logs ORDER BY created_at DESC LIMIT 200');
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
            '<td class="text-right admin-only">' +
            (!a.acknowledged ? '<button onclick="ackAlert(' + a.id + ')" class="text-green-500 text-xs font-bold mr-2">ร้บทราบ</button>' : '') +
            '</td>' +
        '</tr>';
    }).join('');
    res.send(ui('ahist', `
        <h2 class="text-2xl font-black mb-6">📋 Alert History</h2>
        <div class="card overflow-hidden">
            <table class="w-full text-xs">
                <thead><tr><th>Time</th><th>Bed</th><th>Patient</th><th>Level</th><th>Status</th><th>Message</th><th class="admin-only"></th></tr></thead>
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

app.post('/api/alert-settings', adminOnly, async (req, res) => {
    const { mac, hrMin, hrMax, spo2Min, tempMin, tempMax, enableSound, enableLine, enableWebhook, webhookUrl } = req.body;
    try {
        if (!mac || !Number.isFinite(Number(hrMin)) || !Number.isFinite(Number(hrMax)) || Number(hrMin) >= Number(hrMax) ||
            !Number.isFinite(Number(spo2Min)) || !Number.isFinite(Number(tempMin)) || !Number.isFinite(Number(tempMax)) || Number(tempMin) >= Number(tempMax)) {
            return res.status(400).json({ error: 'Invalid alert limits' });
        }
        const defaults = await pool.query("SELECT * FROM alert_settings WHERE mac='*'");
        const base = defaults.rows[0] || {};
        const sql = `INSERT INTO alert_settings (mac,hr_min,hr_max,spo2_min,temp_min,temp_max,enable_sound,enable_line,enable_webhook,webhook_url)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (mac) DO UPDATE SET hr_min=EXCLUDED.hr_min,hr_max=EXCLUDED.hr_max,spo2_min=EXCLUDED.spo2_min,
            temp_min=EXCLUDED.temp_min,temp_max=EXCLUDED.temp_max,enable_sound=EXCLUDED.enable_sound,
            enable_line=EXCLUDED.enable_line,enable_webhook=EXCLUDED.enable_webhook,webhook_url=EXCLUDED.webhook_url,updated_at=NOW()`;
        await pool.query(sql, [mac, Number(hrMin), Number(hrMax), Number(spo2Min), Number(tempMin), Number(tempMax),
            enableSound === undefined ? Boolean(base.enable_sound) : Boolean(enableSound),
            enableLine === undefined ? Boolean(base.enable_line) : Boolean(enableLine),
            enableWebhook === undefined ? Boolean(base.enable_webhook) : Boolean(enableWebhook), webhookUrl || null]);
        delete deviceAlertState[normalizeMac(mac)];
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/alert-settings/:mac', adminOnly, async (req, res) => {
    if (req.params.mac === '*') return res.status(400).json({ error: 'Default settings cannot be deleted' });
    await pool.query('DELETE FROM alert_settings WHERE LOWER(mac)=LOWER($1)', [req.params.mac]);
    delete deviceAlertState[normalizeMac(req.params.mac)];
    res.json({ success: true });
});

app.post('/api/alert-ack', async (req, res) => {
    try {
        const nurseName = req.user.name || req.user.username;
        await pool.query('UPDATE alert_logs SET acknowledged=true, acknowledged_by=$1, acknowledged_at=NOW() WHERE id=$2',
            [nurseName, req.body.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/alert-count', async (req, res) => {
    try {
        const r = await pool.query('SELECT COUNT(*) FROM alert_logs WHERE acknowledged=false AND resolved=false');
        res.json({ count: parseInt(r.rows[0].count) });
    } catch(e) { res.json({ count: 0 }); }
});

app.get('/api/active-alerts', async (req, res) => {
    const r = await pool.query(`SELECT id,mac,bed_no,patient_name,level,category,message,created_at
                                FROM alert_logs WHERE resolved=false ORDER BY created_at DESC`);
    res.json(r.rows);
});

app.get('/api/alert-ui-state', async (req, res) => {
    const [alerts, notifications] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int count, COUNT(*) FILTER (WHERE level='critical')::int critical
                    FROM alert_logs WHERE resolved=false AND acknowledged=false`),
        pool.query('SELECT sound_enabled,silent_start,silent_end FROM user_notification_settings WHERE user_id=$1', [req.user.id])
    ]);
    const state = alerts.rows[0];
    const userSettings = notifications.rows[0];
    const enabled = userSettings ? Boolean(userSettings.sound_enabled) : true;
    const silent = userSettings ? isSilencePeriod(userSettings.silent_start, userSettings.silent_end) : false;
    res.json({ count: state.count, critical: state.critical, shouldSound: state.critical > 0 && enabled && !silent });
});

app.post('/api/notification-settings', adminOnly, async (req, res) => {
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
    } catch(e) {
        console.error("Notification Settings Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.get('/notification-settings', adminOnly, async (req, res) => {
    const userId = req.user.id;
    
    // Load existing settings
    const settingsResult = await pool.query(
        'SELECT * FROM user_notification_settings WHERE user_id=$1', [userId]
    );
    const s = settingsResult.rows[0] || {};
    
    res.send(ui('notif', `
        <h2 class="text-2xl font-black mb-6">📱 Notification Settings</h2>
        <div class="space-y-6">
            <!-- LINE Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">🟢 LINE Messaging</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="line-enabled" ${s.line_enabled?'checked':''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">LINE Bot Token</label>
                        <input id="line-token" type="password" value="" placeholder="${s.line_bot_token?'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม':'LINE Messaging API Token'}" autocomplete="new-password" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">LINE Target (User ID / Group ID)</label>
                        <input id="line-target" value="${escapeHtml(s.line_target||'')}" placeholder="Uxxxxxxxxxxxxxxx หรือ Cxxxxxxxxxxxxxxx" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                </div>
            </div>

            <!-- Telegram Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">🔵 Telegram Bot</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="telegram-enabled" ${s.telegram_enabled?'checked':''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">Telegram Bot Token</label>
                        <input id="tg-token" type="password" value="" placeholder="${s.telegram_bot_token?'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม':'Telegram Bot Token'}" autocomplete="new-password" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Chat ID</label>
                        <input id="tg-chatid" value="${escapeHtml(s.telegram_chat_id||'')}" placeholder="-1001234567890" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                </div>
            </div>

            <!-- Email Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">📧 Email (SMTP)</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="email-enabled" ${s.email_enabled?'checked':''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">SMTP Host</label>
                        <input id="email-host" value="${escapeHtml(s.email_smtp_host||'')}" placeholder="smtp.gmail.com" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Port</label>
                        <input id="email-port" value="${s.email_smtp_port||587}" type="number" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Username</label>
                        <input id="email-user" value="${escapeHtml(s.email_username||'')}" placeholder="your@email.com" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Password</label>
                        <input id="email-pass" type="password" value="" placeholder="${s.email_password?'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม':'App Password'}" autocomplete="new-password" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Email ปลายทาง</label>
                        <input id="email-to" value="${escapeHtml(s.email_to||'')}" placeholder="recipient@email.com" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="flex items-center gap-2 text-sm mt-5">
                            <input type="checkbox" id="email-secure" ${s.email_secure!==false?'checked':''}> TLS/SSL
                        </label>
                    </div>
                </div>
            </div>

            <!-- Webhook Settings -->
            <div class="card p-6">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="font-bold text-lg">🔗 Custom Webhook</h3>
                    <label class="flex items-center gap-2">
                        <input type="checkbox" id="webhook-enabled" ${s.webhook_enabled?'checked':''} class="w-5 h-5">
                        <span class="text-sm font-bold">เปิดใช้</span>
                    </label>
                </div>
                <div class="space-y-3">
                    <div>
                        <label class="text-xs font-bold text-slate-500">Webhook URL</label>
                        <input id="webhook-url" value="${escapeHtml(s.webhook_url||'')}" placeholder="https://hooks.slack.com/services/..." class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Custom Headers (JSON)</label>
                        <textarea id="webhook-headers" placeholder="${s.webhook_headers?'ตั้งค่าแล้ว — เว้นว่างเพื่อคงค่าเดิม':'JSON headers'}" class="w-full border p-3 rounded-xl bg-slate-50 text-sm" rows="2"></textarea>
                    </div>
                </div>
            </div>

            <!-- Alert Rules -->
            <div class="card p-6">
                <h3 class="font-bold text-lg mb-4">⚙️ Alert Rules</h3>
                <div class="space-y-3">
                    <label class="flex items-center gap-3 text-sm">
                        <input type="checkbox" id="alert-critical" ${s.alert_critical!==false?'checked':''}>
                        <span class="font-bold">🔴 Critical Alerts</span>
                        <span class="text-slate-500 text-xs">(วิกฤต - ส่องแดง)</span>
                    </label>
                    <label class="flex items-center gap-3 text-sm">
                        <input type="checkbox" id="alert-warning" ${s.alert_warning?'checked':''}>
                        <span class="font-bold">🟡 Warning Alerts</span>
                        <span class="text-slate-500 text-xs">(เตือน - ส่องเหลือง)</span>
                    </label>
                    <label class="flex items-center gap-3 text-sm">
                        <input type="checkbox" id="sound-enabled" ${s.sound_enabled!==false?'checked':''}>
                        <span class="font-bold">🔊 Sound Alert</span>
                        <span class="text-slate-500 text-xs">(เสีงงในเว็บ)</span>
                    </label>
                </div>
                <div class="grid grid-cols-2 gap-3 mt-4">
                    <div>
                        <label class="text-xs font-bold text-slate-500">Silent Start</label>
                        <input id="silent-start" value="${s.silent_start||'22:00'}" type="time" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
                    </div>
                    <div>
                        <label class="text-xs font-bold text-slate-500">Silent End</label>
                        <input id="silent-end" value="${s.silent_end||'06:00'}" type="time" class="w-full border p-3 rounded-xl bg-slate-50 text-sm">
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

async function syncData() {
    try {
        const active = await pool.query('SELECT mac, hm_number, name FROM nurseaid WHERE hm_number IS NOT NULL');

        for (let p of active.rows) {
            const macNormalized = normalizeMac(p.mac);
            if (!macNormalized) continue;

            const flux = `import "strings"

                from(bucket:"${influxConfig.bucket}")
                |> range(start: -2m)
                |> filter(fn:(r) => exists r.mac and strings.toLower(v: r.mac) == "${escapeFluxString(macNormalized)}")
                |> filter(fn:(r) =>
                    r._measurement == "ble_heart" or
                    r._measurement == "ble_spo2" or
                    r._measurement == "ble_temp" or
                    r._measurement == "ble_batt" or
                    r._measurement == "ble_status"
                )
                |> pivot(rowKey:["_time"], columnKey: ["_measurement"], valueColumn: "_value")`;

            queryApi.queryRows(flux, {
                next: async (row, tableMeta) => {
                    const d = tableMeta.toObject(row);
                    const vital = getWearableVitalRecord(d);

                    if (!vital) {
                        return;
                    }

                    const recordTime = new Date(d._time);

                    try {
                        await pool.query(`
                            INSERT INTO vital_signs_logs (hm_number, patient_name, mac, heart_rate, spo2, temperature, battery, recorded_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            ON CONFLICT (mac, recorded_at)
                            DO UPDATE SET
                                heart_rate = COALESCE(EXCLUDED.heart_rate, vital_signs_logs.heart_rate),
                                spo2 = COALESCE(EXCLUDED.spo2, vital_signs_logs.spo2),
                                temperature = COALESCE(EXCLUDED.temperature, vital_signs_logs.temperature),
                                battery = COALESCE(EXCLUDED.battery, vital_signs_logs.battery)
                        `, [
                            p.hm_number,
                            p.name,
                            p.mac,
                            vital.heartRate,
                            vital.spo2,
                            vital.temperature,
                            vital.battery,
                            recordTime
                        ]);
                    } catch (err) {
                        console.error(`[Sync] Failed to save MAC=${p.mac} time=${recordTime.toISOString()}:`, err.message);
                    }
                },
                error: (e) => {
                    console.error("Influx Query Error:", e);
                },
                complete: () => {

                }
            });
        }
    } catch (e) {
        console.error("Sync Error:", e);
    }
}
setInterval(syncData, 15000);

async function startServer() {
    await initDatabase();
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
    app.listen(PORT, '0.0.0.0', () => console.log('✅ SERVER RUNNING ON PORT '+PORT));
}

startServer().catch(err => {
    console.error('Server startup failed:', err);
    process.exit(1);
});
