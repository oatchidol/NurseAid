with open('/root/nurseaid/server.js', 'r') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if line.strip() == "// ─── RBAC Migration: wards, user_wards ─────────────────────────────":
        start_idx = i
    if line.strip() == "const userCount = await pool.query('SELECT COUNT(*) FROM users');":
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    new_code = """    // ─── RBAC Migration: wards, user_wards ─────────────────────────────
    await pool.query(`
        CREATE TABLE IF NOT EXISTS wards (
            id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL, code VARCHAR(20) UNIQUE NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS user_wards (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            ward_id INTEGER NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
            PRIMARY KEY (user_id, ward_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_wards_ward_id ON user_wards(ward_id);

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
    `);

    // Backfill
    await pool.query(`
        INSERT INTO wards (name, code) VALUES ('Unassigned', 'DEFAULT') ON CONFLICT (code) DO NOTHING;
        UPDATE patients SET ward_id = (SELECT id FROM wards WHERE code='DEFAULT') WHERE ward_id IS NULL;
        UPDATE nurseaid SET ward_id = (SELECT id FROM wards WHERE code='DEFAULT') WHERE ward_id IS NULL;
        UPDATE users SET role = 'super_admin' WHERE role = 'admin';
        UPDATE users SET role = 'staff_nurse' WHERE role = 'operator';
        INSERT INTO user_wards (user_id, ward_id)
          SELECT u.id, (SELECT id FROM wards WHERE code='DEFAULT') FROM users u WHERE u.role='staff_nurse'
          ON CONFLICT DO NOTHING;
        UPDATE users SET session_version = session_version + 1;
    `);

    """
    lines = lines[:start_idx] + [new_code] + lines[end_idx:]
    with open('/root/nurseaid/server.js', 'w') as f:
        f.writelines(lines)
    print("Updated initDatabase in server.js")
else:
    print("Could not find start or end index for initDatabase update")
