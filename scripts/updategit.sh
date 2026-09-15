#!/usr/bin/env bash
set -euo pipefail

# NurseAid update script — updates an EXISTING install in place.
#
# This is NOT an installer. A machine with no checkout or no .env is sent to
# scripts/bootstrap-new-machine.sh rather than half-installed here.
#
# What it preserves, and why it is safe to run on a ward machine:
#
#   The clean below is `git clean -fd`, deliberately NOT `git clean -fdx`.
#   In this repo .gitignore IS the definition of "belongs to this machine,
#   not to the app": .env, nginx/certs/ (generated per machine by
#   scripts/generate-certs.sh and never committed), firmware/wifi_credentials.h,
#   docker-compose.override.yml, locally built nurseaid_esp32_*.bin.
#   `-x` deletes ignored files too, so the previous version of this script
#   deleted the TLS private key nginx needs to start, on every single update.
#
#   The clean runs BEFORE the reset on purpose. Cleaning afterwards would judge
#   this machine's files against the INCOMING .gitignore, so a commit that drops
#   a path from .gitignore would make the next update delete that machine's copy.
#   Running first means a file is protected by the rules the machine was
#   installed under.
#
#   Patient and vitals data are not in this directory at all — PostgreSQL and
#   InfluxDB store them in Docker named volumes, which no git operation here
#   can reach.
#
# Environment overrides:
#   NURSEAID_DIR          checkout to update      (default: this script's repo)
#   NURSEAID_REMOTE       git remote              (default: origin)
#   NURSEAID_BRANCH       branch to deploy        (default: main)
#   NURSEAID_BACKUP_DIR   where backups are kept  (default: parent of checkout)
#   NURSEAID_HOST_PORT    port to health-check    (default: PORT from .env)
#   NURSEAID_FORCE=1      proceed even with uncommitted tracked changes

REMOTE="${NURSEAID_REMOTE:-origin}"
BRANCH="${NURSEAID_BRANCH:-main}"
HEALTH_TIMEOUT="${NURSEAID_HEALTH_TIMEOUT:-180}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }

# --------------------------------------------------------------------------
# 1. Locate the checkout from this script's own position, not a fixed path.
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${NURSEAID_DIR:-}" ]; then
    APP_DIR="$NURSEAID_DIR"
else
    APP_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
fi
[ -n "$APP_DIR" ] && [ -d "$APP_DIR" ] \
    || die "No git checkout found (looked from $SCRIPT_DIR). To install NurseAid on a new machine run scripts/bootstrap-new-machine.sh instead."
# Canonicalise before anything derives a path from it: a relative override such
# as NURSEAID_DIR=NurseAid would otherwise place the backup inside the checkout,
# where the clean in step 5 would delete it.
APP_DIR="$(cd -- "$APP_DIR" && pwd)"
[ -d "$APP_DIR/.git" ] \
    || die "$APP_DIR is not a git checkout. To install NurseAid on a new machine run scripts/bootstrap-new-machine.sh instead."

cd "$APP_DIR"

[ -f .env ] \
    || die "$APP_DIR/.env is missing — this machine has never been set up. Run scripts/bootstrap-new-machine.sh instead; it generates .env and starts the stack."

command -v docker >/dev/null 2>&1 || die "docker is not installed."
if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
else die "The docker compose v2 plugin is required."; fi

BACKUP_ROOT="${NURSEAID_BACKUP_DIR:-$(dirname -- "$APP_DIR")}"
BACKUP_ROOT="$(cd -- "$BACKUP_ROOT" && pwd)" || die "NURSEAID_BACKUP_DIR does not exist."
case "$BACKUP_ROOT/" in
    "$APP_DIR"/*) die "The backup directory must not sit inside the checkout ($APP_DIR) — the clean step would delete it." ;;
esac
BACKUP_DIR="${BACKUP_ROOT}/nurseaid-local-backup-${TIMESTAMP}"
OLD_SHA="$(git rev-parse HEAD)"

info "========================================"
info " NurseAid Update"
info "========================================"
info "App      : ${APP_DIR}"
info "Target   : ${REMOTE}/${BRANCH}"
info "Current  : $(git log -1 --oneline HEAD)"
info "Backup   : ${BACKUP_DIR}"

# --------------------------------------------------------------------------
# 2. Refuse to silently destroy uncommitted work on tracked files.
#    `git reset --hard` below would throw it away with nothing to restore
#    from, since this script no longer copies the whole checkout.
# --------------------------------------------------------------------------
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ] && [ "${NURSEAID_FORCE:-0}" != "1" ]; then
    printf '\n%s\n' "Uncommitted changes to tracked files would be destroyed:"
    printf '%s\n' "$DIRTY"
    die "Commit, stash, or discard them first — or re-run with NURSEAID_FORCE=1 to overwrite them."
fi

# --------------------------------------------------------------------------
# 3. Back up the machine-local files that are not in git.
#    Not the whole checkout: the code is recoverable from git via OLD_SHA, and
#    copying .git + node_modules + firmware/ on every run filled the disk.
#    nginx/certs/ is deliberately NOT copied — it holds a TLS private key, the
#    clean below leaves it in place, and duplicating it only creates a second
#    place that key has to be protected.
# --------------------------------------------------------------------------
step "Backing up machine-local files"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
for f in .env docker-compose.override.yml; do
    if [ -f "$f" ]; then
        cp -a "$f" "$BACKUP_DIR/"
        info "  saved $f"
    fi
done
printf '%s\n' "$OLD_SHA" > "$BACKUP_DIR/COMMIT_BEFORE_UPDATE"
info "  recorded previous commit ${OLD_SHA}"

# --------------------------------------------------------------------------
# 4. Fetch.
# --------------------------------------------------------------------------
step "Fetching ${REMOTE}/${BRANCH}"
git fetch "$REMOTE" "$BRANCH" || die "git fetch failed — check network access to the remote."
NEW_SHA="$(git rev-parse "${REMOTE}/${BRANCH}")"
info "Remote : $(git log -1 --oneline "${REMOTE}/${BRANCH}")"

if [ "$OLD_SHA" = "$NEW_SHA" ]; then
    info "Already at ${REMOTE}/${BRANCH}; rebuilding anyway to pick up any image changes."
else
    info "Changes to apply:"
    # `|| true`: head closing the pipe can hand git a SIGPIPE, and under
    # `pipefail` that would abort the update over a display detail.
    git log --oneline "HEAD..${NEW_SHA}" | head -30 || true
fi

# --------------------------------------------------------------------------
# 5. Remove stale UNTRACKED files, judged by the .gitignore this machine is
#    currently running. Ignored files are kept — see the header.
# --------------------------------------------------------------------------
step "Removing stale untracked files (ignored files are kept)"
REMOVING="$(git clean -nd)"
if [ -n "$REMOVING" ]; then printf '%s\n' "$REMOVING"; else info "  nothing to remove"; fi
git clean -fd

# --------------------------------------------------------------------------
# 6. Move the checkout to the target revision.
# --------------------------------------------------------------------------
step "Resetting to ${REMOTE}/${BRANCH}"
git reset --hard "$NEW_SHA"

# --------------------------------------------------------------------------
# 7. Confirm machine-local state survived. .env is ignored, so step 5 cannot
#    have touched it — this is the belt to that braces.
# --------------------------------------------------------------------------
step "Verifying machine-local files survived"
if [ ! -f .env ] && [ -f "$BACKUP_DIR/.env" ]; then
    cp -a "$BACKUP_DIR/.env" .env
    info "  .env was missing and has been restored from the backup"
fi
[ -f .env ] || die ".env is gone and no backup exists — restore it before starting the stack."
chmod 600 .env
info "  .env present"

if [ ! -f docker-compose.override.yml ] && [ -f "$BACKUP_DIR/docker-compose.override.yml" ]; then
    cp -a "$BACKUP_DIR/docker-compose.override.yml" .
    info "  docker-compose.override.yml restored from the backup"
fi

# nginx/nginx.conf names these files directly, so nginx crash-loops without
# them and nothing answers on :443. A machine last updated by the previous
# version of this script has had them deleted by `git clean -fdx`, so
# regenerate rather than leave the operator with a broken listener.
if [ -f nginx/certs/nurseaid.crt ] && [ -f nginx/certs/nurseaid.key ]; then
    info "  TLS certificates present"
elif [ -x scripts/generate-certs.sh ]; then
    step "TLS certificates are missing — generating them"
    scripts/generate-certs.sh || info "WARNING: certificate generation failed; nginx will not serve :443."
else
    info "WARNING: nginx/certs/ is missing and scripts/generate-certs.sh is not executable; :443 will not work."
fi

# --------------------------------------------------------------------------
# 8. Validate, build, start.
# --------------------------------------------------------------------------
rollback_hint() {
    printf 'cd %s\ngit reset --hard %s\n%s up -d --build\n' \
        "'${APP_DIR}'" "$OLD_SHA" "$COMPOSE"
}

step "Validating compose configuration"
$COMPOSE config >/dev/null || die "docker compose config is invalid; nothing was rebuilt."

step "Building and starting services"
$COMPOSE build || die "docker compose build failed. Roll back with:
$(rollback_hint)"
$COMPOSE up -d || die "docker compose up failed. Roll back with:
$(rollback_hint)"

# --------------------------------------------------------------------------
# 9. Health gate. A failure here exits non-zero — the previous script printed
#    "FAILED" and still exited 0, so a broken deploy looked like a good one.
#    /health/ready, not /health: /health is a static 200 that answers even when
#    the app cannot reach PostgreSQL or InfluxDB. /health/ready queries both and
#    returns 503 when either is down.
# --------------------------------------------------------------------------
APP_PORT="$(sed -n 's/^PORT=//p' .env | head -n1 | tr -d '"'"'"' ')"
[ -n "$APP_PORT" ] || APP_PORT=3333
VERIFY_PORT="${NURSEAID_HOST_PORT:-$APP_PORT}"

fail_with_rollback() {
    printf '\nERROR: %s\n' "$1" >&2
    printf '\n--- docker compose ps ---\n' >&2
    $COMPOSE ps --all >&2 || true
    printf '\n--- last 40 log lines from nurseaid ---\n' >&2
    $COMPOSE logs --tail 40 nurseaid >&2 2>&1 || true
    {
        printf '\nThe update has NOT been rolled back automatically. To roll back:\n\n'
        rollback_hint | sed 's/^/  /'
        printf '\nMachine-local files kept at: %s\n' "$BACKUP_DIR"
    } >&2
    exit 1
}

step "Waiting for the app to report ready (up to ${HEALTH_TIMEOUT}s)"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
until curl -fsS --max-time 5 "http://127.0.0.1:${VERIFY_PORT}/health/ready" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] \
        || fail_with_rollback "http://127.0.0.1:${VERIFY_PORT}/health/ready did not report ready within ${HEALTH_TIMEOUT}s."
    sleep 3
done
info "  GET /health/ready -> OK (PostgreSQL and InfluxDB reachable)"

# --all so a container that exited after `up -d` succeeded is still seen; every
# service in this stack is long-running, so any Exited state is a real failure.
BROKEN="$($COMPOSE ps --all --format '{{.Service}} {{.Status}}' 2>/dev/null | awk '/unhealthy|Restarting|Exited|Dead/ {print "  " $0}')"
[ -z "$BROKEN" ] || fail_with_rollback "Services are not running correctly:
${BROKEN}"

# --------------------------------------------------------------------------
# 10. Summary.
# --------------------------------------------------------------------------
step "Update completed"
$COMPOSE ps
info ""
info "Version  : $(git log -1 --oneline)"
info "Previous : ${OLD_SHA}"
info "Backup   : ${BACKUP_DIR}"
info ""
info "If you need to roll back:"
rollback_hint | sed 's/^/  /'
