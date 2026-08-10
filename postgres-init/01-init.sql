-- ============================================
-- NurseAid PostgreSQL Initialization Script
-- ============================================
-- This script creates all required tables for the NurseAid system
-- ============================================

-- Alert Settings Table
CREATE TABLE IF NOT EXISTS alert_settings (
    id SERIAL PRIMARY KEY,
    mac VARCHAR(50) UNIQUE,
    hr_min INTEGER DEFAULT 50,
    hr_max INTEGER DEFAULT 120,
    spo2_min INTEGER DEFAULT 95,
    temp_min DECIMAL(3,1) DEFAULT 35.5,
    temp_max DECIMAL(3,1) DEFAULT 37.5,
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
);

-- Alert Logs Table
CREATE TABLE IF NOT EXISTS alert_logs (
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
);

-- Webhook Logs Table
CREATE TABLE IF NOT EXISTS webhook_logs (
    id SERIAL PRIMARY KEY,
    alert_id INTEGER REFERENCES alert_logs(id),
    url TEXT,
    status_code INTEGER,
    response_body TEXT,
    retry_count INTEGER DEFAULT 0,
    sent_at TIMESTAMP DEFAULT NOW()
);


-- Wards Table
CREATE TABLE IF NOT EXISTS wards (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    action VARCHAR(100),
    entity_type VARCHAR(50),
    entity_id VARCHAR(100),
    details JSONB,
    ip_address VARCHAR(45),
    actor_role VARCHAR(20),
    ward_id INTEGER REFERENCES wards(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- System Settings Table
CREATE TABLE IF NOT EXISTS system_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE,
    full_name VARCHAR(100),
    password VARCHAR(255),
    role VARCHAR(20) DEFAULT 'viewer',
    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User Wards Table
CREATE TABLE IF NOT EXISTS user_wards (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
    role_in_ward VARCHAR(20) DEFAULT 'staff_nurse',
    granted_by INTEGER REFERENCES users(id),
    granted_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, ward_id)
);
CREATE INDEX IF NOT EXISTS idx_user_wards_ward_id ON user_wards(ward_id);

-- User Notification Settings Table
CREATE TABLE IF NOT EXISTS user_notification_settings (
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
);

-- Patients Table
CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    hn_number VARCHAR(50),
    name VARCHAR(200),
    ward_id INTEGER REFERENCES wards(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- NurseAid Devices Table
CREATE TABLE IF NOT EXISTS nurseaid (
    id SERIAL PRIMARY KEY,
    mac VARCHAR(50),
    device_no VARCHAR(50),
    ward_id INTEGER REFERENCES wards(id),
    device_type VARCHAR(20) DEFAULT 'jstyle',
    name VARCHAR(100),
    hm_number VARCHAR(50),
    bed_no VARCHAR(10),
    hr_min INTEGER DEFAULT 50,
    hr_max INTEGER DEFAULT 120,
    spo2_min INTEGER DEFAULT 95,
    temp_min DECIMAL(3,1) DEFAULT 35.5,
    temp_max DECIMAL(3,1) DEFAULT 37.5,
    enable_sound BOOLEAN DEFAULT true,
    enable_line BOOLEAN DEFAULT true,
    enable_offline_alert BOOLEAN DEFAULT true,
    enable_webhook BOOLEAN DEFAULT false,
    webhook_url TEXT,
    silence_start TIME DEFAULT '22:00',
    silence_end TIME DEFAULT '06:00',
    escalation_enabled BOOLEAN DEFAULT false,
    escalation_timeout INTEGER DEFAULT 15,
    battery_low_threshold INTEGER DEFAULT 20,
    offline_threshold_minutes INTEGER DEFAULT 2,
    update_by VARCHAR(100),
    lastupdate TIMESTAMP,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Device History Table
CREATE TABLE IF NOT EXISTS device_history (
    id SERIAL PRIMARY KEY,
    mac VARCHAR(50),
    hm_number VARCHAR(50),
    patient_name VARCHAR(100),
    bed_no VARCHAR(10),
    assign_time TIMESTAMP,
    discharge_time TIMESTAMP,
    status VARCHAR(20) DEFAULT 'active'
);

-- Vital Signs Logs Table
CREATE TABLE IF NOT EXISTS vital_signs_logs (
    id SERIAL PRIMARY KEY,
    hm_number VARCHAR(50),
    patient_name VARCHAR(100),
    mac VARCHAR(50),
    heart_rate INTEGER,
    spo2 INTEGER,
    temperature DECIMAL(3,1),
    battery INTEGER,
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_vital_signs_logs_hm_number ON vital_signs_logs(hm_number);
CREATE INDEX IF NOT EXISTS idx_vital_signs_logs_mac ON vital_signs_logs(mac);
CREATE INDEX IF NOT EXISTS idx_vital_signs_logs_recorded_at ON vital_signs_logs(recorded_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_vital_signs_logs_mac_recorded_at ON vital_signs_logs(mac, recorded_at);
CREATE INDEX IF NOT EXISTS idx_alert_logs_mac ON alert_logs(mac);
CREATE INDEX IF NOT EXISTS idx_alert_logs_created_at ON alert_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_nurseaid_hm_number ON nurseaid(hm_number);
CREATE INDEX IF NOT EXISTS idx_nurseaid_mac ON nurseaid(mac);
CREATE INDEX IF NOT EXISTS idx_device_history_mac ON device_history(mac);
CREATE INDEX IF NOT EXISTS idx_patients_ward_id ON patients(ward_id);
CREATE INDEX IF NOT EXISTS idx_nurseaid_ward_id ON nurseaid(ward_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type ON audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ward_id ON audit_logs(ward_id);

-- Insert default alert settings if empty
INSERT INTO alert_settings (mac, hr_min, hr_max, spo2_min, temp_min, temp_max, enable_sound, enable_line, enable_offline_alert, offline_threshold_minutes)
VALUES ('*', 50, 120, 95, 35.5, 37.5, true, true, true, 2)
ON CONFLICT (mac) DO NOTHING;

-- The application creates the first administrator from INITIAL_ADMIN_PASSWORD
-- and stores a scrypt hash. Static demo/default credentials are intentionally omitted.
