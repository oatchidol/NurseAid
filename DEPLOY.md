# Deploying NurseAid on a new machine

This repo builds a self-contained stack via Docker Compose: the app
(`nurseaid`), PostgreSQL, InfluxDB, Mosquitto, an MQTT ingestion bridge,
and a compose-status collector. A fresh clone starts with **empty data**
(no patients, no wards, no vitals history) and **one working admin
login**, created automatically the first time the app boots against an
empty `users` table.

## What's in this repo (and what isn't)
This repo is scoped to *the deployable app only* — everything needed to
build and run the docker-compose stack, nothing else:

```
server.js, live-status.js          the app
Dockerfile, docker-compose.yml     how it's built/run
mosquitto-config/, mqtt-bridge/,   the other services' build
  ops/                             contexts
postgres-init/, influxdb-init/     first-boot DB setup
package.json, package-lock.json    Node deps
.env.example                       field reference (no real secrets)
scripts/bootstrap-new-machine.sh   one-command setup (see below)
DEPLOY.md, README.md, CHANGELOG.md docs
RELEASE.md                         cutting/pushing a new version
```

Deliberately **not** in this repo (see `.gitignore`) — present on the
machines that were used to develop it, but not needed to run the app and
not shipped to a new one:
- `.claude/`, `.codex/`, `.agents/` — AI coding-assistant tooling and
  session data. Includes things like `.claude/skills/run-nurseaid/`, an
  agent-driving helper useful for testing this app *from inside an agent
  session* — genuinely handy in that context, but it's dev tooling, not
  part of the app, so it stays local and out of the deploy repo.
- `android-app/`, `pi-files/`, `README-Pi5.md`, and the `test_*`/`eval_*`
  scripts — separate concerns (mobile client, legacy Pi notes, test
  suite) kept locally, not part of this deploy.
- `.env` itself, and anything under `.compose-*-deploy/` (ad-hoc deploy
  logs/backups) — see the security note at the bottom of this file for
  why that second one matters more than it looks.

## Fast path: fully automated setup (recommended)
For a brand-new machine, you don't need to do steps 1–5 by hand. Run
`scripts/bootstrap-new-machine.sh` and it does everything end-to-end,
non-interactively, and idempotently:

```sh
# From a checkout:
scripts/bootstrap-new-machine.sh

# Or standalone (clones the repo first):
sh bootstrap-new-machine.sh
```

The script: checks that `docker` + the `docker compose` (v2) plugin are
installed; generates a fresh `.env` **only if one doesn't already exist**
(never overwrites a real `.env`, so re-runs keep your secrets); builds and
starts the stack with `docker compose up -d --build`; waits for all six
services to report healthy (printing logs on timeout); verifies the app is
actually usable by hitting `/health` and logging in as the initial admin;
and finally prints the URL, admin username, and — only when it just
generated them — the one-time admin password.

It reads optional operator credentials from your shell environment instead
of hardcoding them: export `NURSEAID_LINE_TOKEN`, `NURSEAID_AI_CHAT_ENABLED`,
`NURSEAID_AI_BASE_URL`, `NURSEAID_AI_API_KEY`, and `NURSEAID_AI_MODEL` before
running to enable LINE notifications / the AI assistant. Everything else
defaults to safe, working values and the app still boots without them.

> The manual steps below remain the documented fallback and explain what the
> script does under the hood.

## 1. Prerequisites
- Docker + Docker Compose plugin installed
- Ports free on the host: 3333 (app), 5432 (Postgres), 8086 (InfluxDB), 1883 (MQTT)

## 2. Get the code
```sh
git clone https://github.com/oatchidol/NurseAid.git
cd NurseAid
```

## 3. Provide `.env`
`.env` is intentionally not in git (it holds real secrets). Copy it onto
the new machine out-of-band — e.g. `scp` it directly from wherever it was
prepared:
```sh
scp .env root@<new-machine-ip>:/path/to/NurseAid/.env
```
Never commit `.env` or paste it into chat/tickets. Use `.env.example` as
the field reference if you're writing one from scratch — every variable
it lists is required or has a safe default baked into `docker-compose.yml`.

Two fields matter most for a **fresh** deployment:
- `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_PASSWORD` (≥12 chars) — used
  exactly once, only while the `users` table is empty, to create the
  first `super_admin` login. Change the password after first login.
- `DB_PASSWORD`, `INFLUX_TOKEN`, `INFLUX_ADMIN_PASSWORD`, `SESSION_SECRET`
  — generate fresh random values per deployment; don't reuse another
  machine's.

## 4. Build and start
```sh
docker compose up -d --build
```
First boot creates the Postgres schema (`postgres-init/01-init.sql`),
sets up InfluxDB, and starts the app. Watch it come healthy:
```sh
docker compose ps
```
All six services should report `healthy` within ~1 minute.

## 5. Log in
Open `http://<machine-ip>:3333`, sign in with `INITIAL_ADMIN_USERNAME` /
`INITIAL_ADMIN_PASSWORD`, then immediately:
1. Change the admin password.
2. Create the first ward (there is no default ward anymore — ward now
   lives on the patient record, not a placeholder).
3. Add users/patients/devices as needed.

## 6. HTTPS (nginx + self-signed certificate)

NurseAid ใช้ nginx container เป็น reverse proxy ข้างหน้า app
โดย terminate TLS ด้วย self-signed certificate — ใช้ได้ทันทีบน LAN
โดยไม่ต้องมี domain, ไม่ต้องเปิด port ที่ router, ไม่ต้องพึ่ง third-party

### 6.1 สร้าง certificate (ครั้งเดียว)

```sh
scripts/generate-certs.sh
```

Script จะ:
- สร้าง EC P-256 self-signed cert อายุ 10 ปี
- ใส่ hostname + IP ทั้งหมดของเครื่องเป็น SAN
- เก็บไว้ที่ `nginx/certs/` (อยู่ใน `.gitignore` แล้ว)

### 6.2 Start stack

```sh
docker compose up -d --build
```

ตรวจสอบ:
```sh
docker compose ps nginx
# ต้อง Healthy

curl -skI https://localhost/health/ready
# HTTP/1.1 200 OK
```

### 6.3 เข้าใช้งาน

| Protocol | URL | หมายเหตุ |
|----------|-----|----------|
| HTTPS | `https://<machine-ip>/` | Browser เตือนครั้งแรก — กด Advanced → Proceed |
| HTTP | `http://<machine-ip>:3333/` | ยังใช้ได้ (direct to app, no TLS) |

### 6.4 Trust certificate (ไม่ให้ browser เตือนอีก)

Download `nginx/certs/nurseaid.crt` แล้ว import ที่ device:
- **Android**: Settings → Security → Install from storage
- **iOS**: AirDrop/email `.crt` file → Install Profile → Trust
- **Chrome**: Settings → Privacy → Manage certificates → Import
- **Windows**: Double-click `.crt` → Install → Trusted Root CA

## Known gaps (not yet automated here)
- No data migration path is included by design — this produces a
  **blank** instance. If you need to carry over patients/wards/history
  from another machine, dump/restore Postgres and InfluxDB separately.
- LINE notifications and the AI assistant only work if `.env` carries
  valid `LINE_TOKEN` / `AI_*` credentials for those external services.

## Background: why this repo's history was squashed (2026-08-20)
An earlier commit had accidentally included the entire `.claude/`
directory (~271MB, including a live Claude Code OAuth credential and
old session transcripts). History was squashed to a clean, secret-free
"app-only" baseline and force-pushed; the full old history stays on the
`backup-master-before-cleanup-20260820` branch on the machine where the
cleanup happened, but was intentionally not pushed anywhere else. This
is also why `.claude/` (and its skills, however useful) stays out of
this repo going forward — one accidental `git add -A` is all it takes
to repeat the leak.
If you're reading this because you're setting up a new machine from an
old checkout that still has that leaked credential in its `.claude/`
folder: that token should already have been rotated (revoked/regenerated
via Claude Code login or the claude.ai account's session list) — if it
hasn't, do that regardless of anything in this repo.
