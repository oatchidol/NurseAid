import re

with open('/root/nurseaid/server.js', 'r') as f:
    lines = f.readlines()

start_idx = -1
end_idx = -1
for i, line in enumerate(lines):
    if line.strip() == "// ─── Role & Capability Model ───────────────────────────────────────":
        start_idx = i
    if line.strip() == "const publicPaths = new Set(['/login', '/api/login', '/health', '/health/live', '/health/ready']);":
        end_idx = i
        break

if start_idx != -1 and end_idx != -1:
    new_code = """// ─── Role & Capability Model ───────────────────────────────────────
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
    return ui('Access Denied', `
        <div class="empty-state" style="padding: 40px; text-align: center;">
            <div class="empty-icon" style="color:var(--danger); font-size: 3rem; margin-bottom: 20px;">⚠️</div>
            <h2>Access Denied</h2>
            <p>You do not have permission to access this page.</p>
            <a href="/" class="btn-primary" style="margin-top:20px; display:inline-block; padding: 10px 20px; border-radius: 8px; text-decoration: none;">Return to Dashboard</a>
        </div>
    `, '', req.user);
}

function requireCapability(capability) {
    return (req, res, next) => {
        if (roleHasCapability(req.user?.role, capability)) return next();
        if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Forbidden' });
        return res.status(403).send(accessDeniedPage(req));
    };
}

// ─── Ward scoping helpers ──────────────────────────────────────────
async function wardScopeSql(req, column = 'ward_id', paramIndex = 1) {
    if (req.user.role === 'super_admin') return { clause: '', params: [] };
    const wards = await pool.query('SELECT ward_id FROM user_wards WHERE user_id=$1', [req.user.id]);
    const ids = wards.rows.map(r => r.ward_id);
    if (!ids.length) return { clause: `${column} = -1`, params: [] }; // ไม่มีวอร์ด = ไม่เห็นอะไร
    return { clause: `${column} = ANY($${paramIndex})`, params: [ids] };
}

// ─── Audit logging helper ──────────────────────────────────────────
async function logAudit(req, action, entityType, entityId, details) {
    try {
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || null;
        const role = req.user?.role || null;
        const userId = req.user?.id || null;
        let wardId = null;
        if (details && details.ward_id !== undefined) {
            wardId = details.ward_id;
        }
        await pool.query(
            `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, actor_role, ward_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [userId, action, entityType, entityId, JSON.stringify(details || {}), ip, role, wardId]
        );
    } catch (e) {
        console.error('[Audit Log] Error:', e.message);
    }
}

"""
    lines = lines[:start_idx] + [new_code] + lines[end_idx:]
    with open('/root/nurseaid/server.js', 'w') as f:
        f.writelines(lines)
    print("Updated server.js RBAC block")
else:
    print("Could not find start or end index")
