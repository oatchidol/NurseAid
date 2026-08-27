# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are on-shift nurses and ward staff who watch live alerts from patient-paired monitoring devices under time pressure, and need to act on them fast and without ambiguity. Secondary users are administrative roles — `super_admin`, `admin`, `ward_admin`, and capability-scoped assistant accounts — who configure wards, devices, patients, device-to-patient pairing, users, and alert settings, and who review the audit log. Access throughout is gated by fine-grained capabilities (e.g. `alerts:settings:write`, `devices:write`, `patients:write`, `pairing:write`, `wards:manage`, `users:manage:ward` / `users:manage:all`, `audit:read:ward` / `audit:read:all`, `settings:global`), not just role name.

## Product Purpose

NurseAid is a hospital nurse-call / patient-monitoring system: it pairs physical devices to patients on a ward, ingests their live signal, and raises alerts (online/offline, threshold, alert-level) to nursing staff in real time, with audit history and per-ward configuration. Success means an alert reaches the right staff, unambiguously, fast enough to act on — not visual polish for its own sake.

## Positioning

Differentiated from a traditional call-button/intercom nurse-call system by real-time IoT device-to-patient pairing plus MQTT/InfluxDB-backed live alerting and history, rather than a simple manual call/acknowledge loop.

## Operating Context

Runs in real hospital wards, in production, with real patients and staff — not a demo or an internal tool with forgiving stakes. Backed by MQTT (device telemetry), InfluxDB (time-series), and Postgres (application data); deployed via Docker Compose behind nginx. The entire web UI today is server-rendered inline HTML template strings inside `server.js` (~10.4k lines, single file), using Tailwind (CDN) for styling and Chart.js for charts; there is no separate frontend build. Key surfaces: `/login`, the main `ui()` shell/sidebar nav, `/wards-mgmt`, `/patients-mgmt`, `/devices-mgmt`, `/matching` (pairing), `/quick-setup` (guided pairing wizard), `/alert-settings`, `/alert-history`, `/notification-settings`, `/users-mgmt`, `/user-wards-mgmt`, `/audit-log`, `/system-mgmt` (admin: version/update management), `/export`.

## Capabilities and Constraints

- UI language is Thai (`<html lang="th">`); all user-facing copy, including this project's own CHANGELOG, is written in Thai. This is a durable constraint, not a placeholder.
- Alert-state colors (active / acknowledged / resolved, online/offline, alert severity level) are safety-critical signaling, not decorative choices — they must stay unambiguous and consistent, not be freely restyled for aesthetic variety.
- The product is under active, frequent release (CHANGELOG shows near-daily version bumps); changes are expected to ship into a live system, so backward-compatible, low-regression-risk changes are valued over exploratory rewrites.
- No dedicated design/frontend tooling exists yet (no component library, no CSS token file, no build step) — all styling today is inline Tailwind utility classes and inline `<style>` blocks inside `server.js`.

## Brand Commitments

Product name is "NurseAid" (seen in-product as "NurseAid PRO", "NurseAid AI Assistant", "NurseAid System"). No other confirmed logo, color, or identity asset beyond what's already implemented in code.

## Evidence on Hand

Real, in-production code is the evidence: `server.js` (routes, HTML, inline styles), `CHANGELOG.md` (Thai-language release notes back to v2.13), `RELEASE.md`, `DEPLOY.md`. No testimonials, case studies, or press exist and none should be fabricated.

## Product Principles

1. Clarity and correctness of an alert outrank visual expression — this is Operate-mode software for time-pressured clinical work, not a marketing surface.
2. Preserve Thai-language copy and existing alert-state color semantics; do not silently translate, reword clinical/status language, or reassign alert colors during design work.
3. Ship changes that are safe to deploy into a live hospital system — favor scoped, reviewable, low-regression-risk edits over sweeping rewrites of the single production `server.js`.
4. Respect the existing capability/role gating model when touching any page — a design change must not alter who can see or do what.

## Accessibility & Inclusion

No formal accessibility standard has been confirmed as a requirement. Given the safety-critical nature of alerts, color should not be the sole signal (icon/text should accompany color-coded alert states) — flagged as a durable principle rather than a specific confirmed standard.
