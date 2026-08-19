---
name: run-nurseaid
description: Build, run, and drive the NurseAid app (Node/Express + Postgres/InfluxDB/Mosquitto via Docker Compose). Use when asked to start NurseAid, build it, take a screenshot of its login/dashboard UI, log in, hit its API, or confirm a server.js change actually works in the running app.
---

NurseAid is a Docker Compose stack (app + Postgres + InfluxDB +
Mosquitto + an MQTT ingestion bridge + a status collector) fronting a
server-rendered web UI. Drive it via
`.claude/skills/run-nurseaid/driver.mjs` — it launches an **isolated**
copy of the stack (its own project name, own host ports, own throwaway
`.env`) so it never collides with an already-running instance on the
same host, then gives you two handles: `curl`-equivalent calls for the
API/business-logic layer, and a real headless Chromium (Playwright) for
the login/dashboard UI layer.

All paths below are relative to the repo root (`/root/nurseaid`).

## Prerequisites

Docker + the Compose v2 plugin (`docker compose`, not standalone
`docker-compose`) must already work — this skill doesn't install
Docker. Confirm:

```bash
docker compose version
```

The driver needs Node's `playwright` package and a Chromium binary.
This container already has both:

```bash
which chromium              # /usr/bin/chromium — driver launches this exact binary
ls .claude/skills/run-nurseaid/node_modules/playwright   # present (see Setup)
```

## Setup

The driver's `node_modules/playwright` is currently a **symlink** into
this session's npx cache (`~/.npm/_npx/.../node_modules/playwright`) —
fast, no download, but that cache path is specific to this container.
On a machine that doesn't have it cached, install for real instead (no
browser download needed — the driver points at the system Chromium):

```bash
cd .claude/skills/run-nurseaid
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
```

## Build

No separate build step to prepare the driver itself. The app image is
built as part of `driver.mjs up` (`docker compose ... up --build`).

## Run (agent path)

```bash
cd .claude/skills/run-nurseaid

# 1. Bring up an isolated stack (default: project "nurseaid-agentrun",
#    app on host port 13333). Builds images, starts all 6 services,
#    polls until every healthcheck passes (~30-90s), then prints the
#    URL and the freshly-generated admin login.
node driver.mjs up
# → [driver] all services healthy
# → [driver] url=http://localhost:13333  admin=admin  password=<random>

# 2. API layer — curl-equivalent. Body is optional JSON; --cookie
#    persists a session across calls (needed for anything but /health).
node driver.mjs api GET /health --port 13333
node driver.mjs api POST /api/login '{"u":"admin","p":"<password from step 1>"}' \
  --port 13333 --cookie /tmp/nurseaid-cookie.txt
node driver.mjs api GET /api/me --port 13333 --cookie /tmp/nurseaid-cookie.txt

# 3. UI layer — real browser. Logs in through the actual <form> (field
#    ids are literally #u / #p, button text "SIGN IN"), waits for the
#    post-login redirect to "/", and can screenshot either step.
node driver.mjs login-ui http://localhost:13333 admin '<password>' \
  /tmp/nurseaid-storage.json /tmp/nurseaid-dashboard.png
# → [driver] login-ui OK, landed on http://localhost:13333/

# Reuse that saved storage state to screenshot any other authenticated
# page without logging in again:
node driver.mjs shot http://localhost:13333/ /tmp/nurseaid-wards.png \
  --storage-state /tmp/nurseaid-storage.json

# 4. Tear down (removes containers + volumes for this isolated project
#    only — never touches a same-named "nurseaid-*" prod stack):
node driver.mjs down
```

| command | what it does |
|---|---|
| `up [--project NAME] [--port PORT]` | generate throwaway `.env` (once — reused on repeat `up`/`down` for the same project), build, start all 6 services, wait for healthy |
| `status [--project NAME]` | `docker compose ps` for that project |
| `api <METHOD> <path> [jsonBody] [--port P] [--cookie FILE]` | raw HTTP call against the running app |
| `login-ui <baseUrl> <user> <pass> <storageOut.json> [shotOut.png]` | fills the real login form, waits for redirect, optionally screenshots |
| `shot <url> <out.png> [--storage-state FILE]` | screenshot any page, optionally authenticated |
| `down [--project NAME]` | tear down that project's containers/volumes/network |

Screenshots/storage-state go wherever you point them (examples above
use `/tmp/`). The generated `.env` and per-project compose file live
under `/tmp/nurseaid-driver-<project>/` and are reused across `up`/
`down` cycles for the same `--project` name — delete that directory to
force fresh secrets.

## Run (human path)

```bash
docker compose up -d --build   # from the repo root, real project name/ports
```

Opens on `http://<host>:3333`. `docker compose down` to stop. See
`DEPLOY.md` for the full first-boot runbook (this is what the driver
automates for isolated/repeatable use).

## Test

```bash
npm test   # node --check server.js && node --test test_wards_mgmt.js test_monitor_ai_chat.js && python3 -m unittest test_mqtt_bridge
```

---

## Gotchas

- **The login API body fields are `u`/`p`, not `username`/`password`.**
  `POST /api/login` with `{"username":...}` silently 400s (missing
  fields), not a wrong-credentials error — easy to misdiagnose as an
  auth failure. The HTML form's field ids are also `#u` / `#p`.
- **`env_file: - .env` in `docker-compose.yml` resolves relative to
  `--project-directory`, not to the compose file's own location.** The
  driver sets `--project-directory` to the real repo root (required so
  the `./mosquitto-config`, `./mqtt-bridge`, `./ops` build contexts and
  the `./postgres-init` volume mount resolve) — which means a naive
  override would load the **real prod `.env`** instead of the isolated
  one. The driver works around this by rewriting `env_file`'s `.env`
  entries to an absolute path in its generated compose copy.
- **Compose merges list-valued keys (`ports`, etc.) across `-f` files
  by concatenation, not replacement.** An override file that adds
  `"18086:8086"` does not remove the base file's `"8086:8086"` — both
  get published, and the second one collides with an already-running
  prod stack on the same host. The driver avoids `-f base -f override`
  entirely and instead writes one full standalone compose copy with
  the port/container_name lines textually replaced.
- **A fresh instance has no default ward.** Older versions had an
  "Unassigned" fallback ward; current `server.js` removes it on
  startup. `INITIAL_ADMIN_PASSWORD` bootstraps exactly one
  `super_admin` login and nothing else — the dashboard correctly shows
  "0 Patients" / no ward until you create one through the UI.
- **`INITIAL_ADMIN_PASSWORD` must be ≥12 characters** or the app throws
  on startup (`server.js` ~line 1227) and the container restart-loops.
  This only matters while the `users` table is empty — on a second
  `up` against an existing `.env`/volume it's not re-checked.
- **`ops/compose-collector` needs Docker socket + host `/proc` mounts**
  (see `docker-compose.yml`) — it reports container health/CPU/mem for
  an ops dashboard and is unrelated to patient-device telemetry (that's
  `mqtt-bridge`). Its healthcheck can lag ~15-20s behind the others;
  the driver's `waitHealthy()` accounts for this with a 3-minute total
  timeout.

## Troubleshooting

- **`Server startup failed: Error: INITIAL_ADMIN_PASSWORD must contain
  at least 12 characters when no users exist`, app container
  restart-looping**: the app container loaded the wrong `.env` (see the
  `env_file` gotcha above) — check the generated compose file under
  `/tmp/nurseaid-driver-<project>/docker-compose.yml` actually points
  `env_file` at an absolute path, not `.env`.
- **`Bind for :::8086 failed: port is already allocated`**: something
  is still publishing that host port — almost always leftover from an
  interrupted `up`/`down` cycle, or the port-merge gotcha above if
  `driver.mjs` was hand-edited. `docker ps -a --filter
  name=nurseaid-agentrun` and `docker compose -p nurseaid-agentrun down
  -v` to clean up, then retry.
- **`page.fill('#u', ...)` times out / `login-ui` hangs**: usually means
  `up` didn't actually finish — check `node driver.mjs status` and
  `docker logs <project>-app` before assuming the UI selectors changed.
