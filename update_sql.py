import re

with open('/root/nurseaid/postgres-init/01-init.sql', 'r') as f:
    sql = f.read()

# Add wards before audit_logs
wards_sql = """
-- Wards Table
CREATE TABLE IF NOT EXISTS wards (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    code VARCHAR(20) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Audit Logs Table"""
sql = sql.replace("-- Audit Logs Table", wards_sql)

# Update audit_logs table
audit_old = """CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    user_id INTEGER,
    action VARCHAR(100),
    entity_type VARCHAR(50),
    entity_id VARCHAR(100),
    details JSONB,
    created_at TIMESTAMP DEFAULT NOW()
);"""
audit_new = """CREATE TABLE IF NOT EXISTS audit_logs (
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
);"""
sql = sql.replace(audit_old, audit_new)

# Add user_wards after users
users_old = """    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);"""
users_new = """    session_version INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW()
);

-- User Wards Table
CREATE TABLE IF NOT EXISTS user_wards (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, ward_id)
);
CREATE INDEX IF NOT EXISTS idx_user_wards_ward_id ON user_wards(ward_id);"""
sql = sql.replace(users_old, users_new)

# Add ward_id to patients
patients_old = """CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    hn_number VARCHAR(50),
    name VARCHAR(200),
    created_at TIMESTAMP DEFAULT NOW()
);"""
patients_new = """CREATE TABLE IF NOT EXISTS patients (
    id SERIAL PRIMARY KEY,
    hn_number VARCHAR(50),
    name VARCHAR(200),
    ward_id INTEGER REFERENCES wards(id),
    created_at TIMESTAMP DEFAULT NOW()
);"""
sql = sql.replace(patients_old, patients_new)

# Add ward_id to nurseaid
nurseaid_old = """CREATE TABLE IF NOT EXISTS nurseaid (
    id SERIAL PRIMARY KEY,
    mac VARCHAR(50),
    device_no VARCHAR(50),"""
nurseaid_new = """CREATE TABLE IF NOT EXISTS nurseaid (
    id SERIAL PRIMARY KEY,
    mac VARCHAR(50),
    device_no VARCHAR(50),
    ward_id INTEGER REFERENCES wards(id),"""
sql = sql.replace(nurseaid_old, nurseaid_new)

# Add new indexes
indexes_old = "CREATE INDEX IF NOT EXISTS idx_device_history_mac ON device_history(mac);"
indexes_new = """CREATE INDEX IF NOT EXISTS idx_device_history_mac ON device_history(mac);
CREATE INDEX IF NOT EXISTS idx_patients_ward_id ON patients(ward_id);
CREATE INDEX IF NOT EXISTS idx_nurseaid_ward_id ON nurseaid(ward_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity_type ON audit_logs(entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ward_id ON audit_logs(ward_id);"""
sql = sql.replace(indexes_old, indexes_new)

with open('/root/nurseaid/postgres-init/01-init.sql', 'w') as f:
    f.write(sql)
print("Updated 01-init.sql")
