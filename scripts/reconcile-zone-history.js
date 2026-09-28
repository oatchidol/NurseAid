'use strict';

// One-time, conservative consolidation of interrupted receiver history.
// Dry-run by default. Source rows are copied into an immutable backup table
// before any apply operation; never infer transitions between different boards.
// On this host:
//   DB_HOST=127.0.0.1 node -r dotenv/config scripts/reconcile-zone-history.js
//   DB_HOST=127.0.0.1 node -r dotenv/config scripts/reconcile-zone-history.js --apply
// The original table is retained in patient_zone_history_reconcile_backup_20260928.
const { Pool } = require('pg');

const BACKUP_TABLE = 'patient_zone_history_reconcile_backup_20260928';
const MAX_EDGE_GAP_MS = 30_000;
const REST_HOLD_SECONDS = Object.freeze({ high: 120, medium: 240, low: 480 });

const same = (a, b) => String(a ?? '') === String(b ?? '');
const time = value => value == null ? NaN : new Date(value).getTime();
const matchedBoard = (a, b) => Boolean(a && b) && String(a).toUpperCase() === String(b).toUpperCase();

function shouldBridge(previous, unknown, following, priority = 'medium') {
    if (!previous || !unknown || !following || !matchedBoard(previous.board_mac, following.board_mac)) return false;
    if (unknown.board_mac !== null || unknown.zone_label !== null || unknown.ward_id !== null) return false;
    if (unknown.match_state !== 'unknown') return false;
    if (!same(previous.zone_label, following.zone_label)
        || !same(previous.ward_id, following.ward_id)
        || !same(previous.match_state, following.match_state)) return false;
    const beforeGapMs = time(unknown.started_at) - time(previous.ended_at);
    const afterGapMs = time(following.started_at) - time(unknown.ended_at);
    const durationMs = time(unknown.ended_at) - time(unknown.started_at);
    const maxHoldMs = 1000 * (REST_HOLD_SECONDS[priority] ?? REST_HOLD_SECONDS.medium);
    return Number.isFinite(durationMs) && durationMs >= 0 && durationMs <= maxHoldMs
        && beforeGapMs >= 0 && beforeGapMs <= MAX_EDGE_GAP_MS
        && afterGapMs >= 0 && afterGapMs <= MAX_EDGE_GAP_MS;
}

function buildPlan(rows, priorityByMac = new Map()) {
    const updates = [];
    const deletes = [];
    let bridges = 0;
    for (let i = 0; i < rows.length;) {
        const first = rows[i];
        let last = first;
        let j = i;
        const priority = priorityByMac.get(String(first.mac).toUpperCase()) || 'medium';
        const mergedIds = [];
        while (j + 2 < rows.length
            && same(first.mac, rows[j + 1].mac)
            && same(first.mac, rows[j + 2].mac)
            && shouldBridge(last, rows[j + 1], rows[j + 2], priority)) {
            mergedIds.push(rows[j + 1].id, rows[j + 2].id);
            last = rows[j + 2];
            bridges++;
            j += 2;
        }
        if (mergedIds.length) {
            updates.push({ id: first.id, ended_at: last.ended_at });
            deletes.push(...mergedIds);
        }
        i = j + 1;
    }
    return { updates, deletes, bridges };
}

async function main() {
    const apply = process.argv.includes('--apply');
    const pool = new Pool({
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'softwatch_iot',
        password: process.env.DB_PASSWORD || '',
        port: Number(process.env.DB_PORT || 5432),
        max: 1
    });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (apply) await client.query('LOCK TABLE patient_zone_history IN SHARE ROW EXCLUSIVE MODE');
        const { rows } = await client.query(
            'SELECT id, mac, board_mac, zone_label, ward_id, match_state, started_at, ended_at FROM patient_zone_history ORDER BY mac, started_at, id'
        );
        const { rows: priorities } = await client.query(
            `SELECT DISTINCT ON (UPPER(n.mac)) UPPER(n.mac) AS mac, COALESCE(p.priority,'medium') AS priority
             FROM nurseaid n LEFT JOIN patients p ON LOWER(p.hn_number)=LOWER(n.hm_number)
             ORDER BY UPPER(n.mac), p.id DESC NULLS LAST`
        );
        const byMac = new Map(priorities.map(x => [x.mac, x.priority]));
        const plan = buildPlan(rows, byMac);
        console.log(JSON.stringify({
            mode: apply ? 'apply' : 'dry-run',
            original_rows: rows.length,
            bridged_gaps: plan.bridges,
            updated_intervals: plan.updates.length,
            removed_duplicate_rows: plan.deletes.length,
            projected_rows: rows.length - plan.deletes.length
        }));
        if (apply && plan.bridges) {
            await client.query(`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (LIKE patient_zone_history INCLUDING ALL)`);
            await client.query(`INSERT INTO ${BACKUP_TABLE} SELECT * FROM patient_zone_history ON CONFLICT (id) DO NOTHING`);
            const expected = new Set([...plan.updates.map(x => String(x.id)), ...plan.deletes.map(String)]);
            const result = await client.query(`SELECT id FROM ${BACKUP_TABLE} WHERE id = ANY($1::bigint[])`, [Array.from(expected)]);
            if (result.rows.length !== expected.size) throw new Error('Backup verification failed; no history was changed');
            for (const update of plan.updates) {
                const result = await client.query(
                    'UPDATE patient_zone_history SET ended_at=$1 WHERE id=$2',
                    [update.ended_at, update.id]
                );
                if (result.rowCount !== 1) throw new Error('Update failed; rolling back');
            }
            const deleted = await client.query('DELETE FROM patient_zone_history WHERE id=ANY($1::bigint[])', [plan.deletes]);
            if (deleted.rowCount !== plan.deletes.length) throw new Error('Delete count mismatch; rolling back');
            const { rows: [after] } = await client.query('SELECT count(*)::integer AS count FROM patient_zone_history');
            if (after.count !== rows.length - plan.deletes.length) throw new Error('Row count mismatch; rolling back');
            console.log(JSON.stringify({ backup_table: BACKUP_TABLE, verified_remaining_rows: after.count }));
        }
        await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    main().catch(error => { console.error('Reconciliation failed:', error.message); process.exitCode = 1; });
}

module.exports = { shouldBridge, buildPlan, REST_HOLD_SECONDS };
