# Deploying NurseAid on a new machine

This repo builds a self-contained stack via Docker Compose: the app
(`nurseaid`), PostgreSQL, InfluxDB, Mosquitto, an MQTT ingestion bridge,
and a compose-status collector. A fresh clone starts with **empty data**
(no patients, no wards, no vitals history) and **one working admin
login**, created automatically the first time the app boots against an
empty `users` table.

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

## 6. Domain / HTTPS (if applicable)
This repo does not manage the reverse proxy. If the app sits behind an
nginx edge host on a domain (as production currently does), point that
proxy's upstream at the new machine's IP:3333 and make sure it forwards
`X-Forwarded-*` headers — the app trusts the proxy for origin checks on
non-GET requests.

## Known gaps (not yet automated here)
- No data migration path is included by design — this produces a
  **blank** instance. If you need to carry over patients/wards/history
  from another machine, dump/restore Postgres and InfluxDB separately.
- LINE notifications and the AI assistant only work if `.env` carries
  valid `LINE_TOKEN` / `AI_*` credentials for those external services.
