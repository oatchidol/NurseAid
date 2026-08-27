#!/usr/bin/env python3
"""Export non-sensitive Docker Compose runtime health for the NurseAid agent."""
import json
import os
import subprocess
import tempfile
import re
import time
import ssl
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path

PROJECT_NAME = os.getenv("NURSEAID_PROJECT_NAME", "nurseaid")
HOST_PROJECT_PATH = Path(os.getenv("NURSEAID_HOST_PROJECT_PATH", "/host/project"))
HOST_PROC_PATH = Path(os.getenv("NURSEAID_HOST_PROC_PATH", "/host/proc"))
HOST_THERMAL_PATH = Path(os.getenv("NURSEAID_HOST_THERMAL_PATH", "/host/sys/class/thermal/thermal_zone0/temp"))
OUTPUT_FILE = Path(os.getenv("NURSEAID_STATUS_FILE", "/run/nurseaid-compose-status/status.json"))
SPOOL_DIR = OUTPUT_FILE.parent
AGENT_UID = int(os.getenv("NURSEAID_AGENT_UID", "65532"))
COLLECT_INTERVAL = max(2, int(os.getenv("NURSEAID_COLLECT_INTERVAL", "3")))
INITIAL_LOG_HISTORY_MINUTES = min(
    1440,
    max(1, int(os.getenv("NURSEAID_INITIAL_LOG_HISTORY_MINUTES", "30"))),
)
CENTRAL_URL = os.getenv("NURSEAID_CENTRAL_URL", "https://nurseaid-central.softsquaregroup.com").strip().rstrip("/")
HEARTBEAT_INTERVAL = max(10, int(os.getenv("NURSEAID_HEARTBEAT_INTERVAL", "60")))
CREDENTIAL_FILE = SPOOL_DIR / "central-credential.json"
ENROLL_BACKOFF_MAX = 900


def read_app_version():
    """Return the real running version, derived from the repo, not .env.

    The collector container mounts the repo at /repo, so package.json is the
    source of truth. Fall back to `git describe` and finally a hard default.
    """
    for path in ("/repo/package.json", "package.json"):
        try:
            data = json.loads(Path(path).read_text())
            version = (data.get("version") or "").strip()
            if version:
                return version
        except (OSError, ValueError):
            pass

    try:
        out = subprocess.check_output(
            ["git", "-C", "/repo", "describe", "--tags", "--always", "--dirty"],
            stderr=subprocess.DEVNULL,
        )
        text = out.decode("utf-8", "replace").strip()
        if text:
            return text
    except (OSError, subprocess.CalledProcessError):
        pass

    return "1.0.0"


# Backoff state for enrollment retries: (until_timestamp, current_backoff_seconds, last_logged_value)
_enrollment_backoff_until = 0.0
_enrollment_backoff_current = 0
_last_enrollment_backoff_logged = None
SESSION_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

def get_machine_device_id():
    """Derive this machine's NurseAid device id from real hardware, not .env.

    The id must be a property of the machine itself so Central sees the same
    identity every boot. Order: Raspberry Pi CPU serial (matches the original
    NA-43F42F4B units), then the host machine-id, then a hash of the hostname.
    An operator-set NURSEAID_DEVICE_ID is intentionally ignored — it would make
    Central-bound identity configurable rather than machine-derived.
    """
    # Try Raspberry Pi CPU Serial Number first (to match original NA-43F42F4B)
    try:
        cpuinfo = Path("/proc/cpuinfo").read_text()
        for line in cpuinfo.splitlines():
            if line.startswith("Serial"):
                serial = line.split(":")[1].strip()
                if len(serial) >= 8:
                    return f"NA-{serial[-8:].upper()}"
    except OSError:
        pass

    # Fallback to machine-id
    for p in ["/etc/machine-id", "/var/lib/dbus/machine-id", "/host/proc/sys/kernel/random/boot_id"]:
        try:
            val = Path(p).read_text().strip().replace("-", "")
            if len(val) >= 8:
                return f"NA-{val[:8].upper()}"
        except OSError:
            pass
            
    import hashlib
    h = hashlib.sha256(os.uname().nodename.encode("utf-8")).hexdigest()
    return f"NA-{h[:8].upper()}"

DEVICE_ID = get_machine_device_id()




def command(*args, timeout=15):
    return subprocess.run(args, text=True, capture_output=True, check=True, timeout=timeout).stdout


def log_command(*args, timeout=30):
    completed = subprocess.run(args, text=True, capture_output=True, check=True, timeout=timeout)
    return completed.stdout + completed.stderr


def container_ids(service=None):
    args = ["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT_NAME}"]
    if service: args.extend(("--filter", f"label=com.docker.compose.service={service}"))
    args.extend(("--format", "{{.ID}}"))
    return command(*args).split()


def expected_services():
    output = command("docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT_NAME}", "--format", '{{.Label "com.docker.compose.service"}}')
    return sorted({line.strip() for line in output.splitlines() if line.strip()})


def inspect_service(service):
    ids = container_ids(service)
    if not ids:
        return {"service": service, "status": "missing", "containerState": "missing", "reason": "container not found"}
    raw = json.loads(command("docker", "inspect", ids[0]))[0]
    state = raw.get("State") or {}
    health = state.get("Health") or {}
    logs = health.get("Log") or []
    last_log = logs[-1] if logs else {}
    container_state = str(state.get("Status") or "unknown").lower()
    health_state = str(health.get("Status") or "none").lower()
    status = "healthy" if container_state == "running" and health_state in ("healthy", "none") else "unhealthy"
    if container_state == "restarting": status = "restarting"
    reason = ""
    if container_state != "running": reason = f"container {container_state}"
    elif health_state not in ("healthy", "none"): reason = f"healthcheck {health_state}"
    if state.get("OOMKilled"): reason = "container was OOM killed"
    return {
        "service": service,
        "containerName": str(raw.get("Name") or "").lstrip("/"),
        "status": status,
        "containerState": container_state,
        "healthStatus": health_state,
        "restartCount": max(0, int(raw.get("RestartCount") or 0)),
        "exitCode": int(state.get("ExitCode") or 0),
        "oomKilled": bool(state.get("OOMKilled")),
        "failingStreak": max(0, int(health.get("FailingStreak") or 0)),
        "lastHealthOutput": str(last_log.get("Output") or "").strip()[-500:],
        "startedAt": state.get("StartedAt") or None,
        "finishedAt": state.get("FinishedAt") or None,
        "reason": reason,
    }

def filesystem_metrics(path=HOST_PROJECT_PATH):
    usage = os.statvfs(path)
    if usage.f_blocks <= 0: return {}
    return {
        "diskUsedPercent": round((1 - usage.f_bavail / usage.f_blocks) * 100, 1),
        "diskTotalBytes": usage.f_blocks * usage.f_frsize,
        "diskAvailableBytes": usage.f_bavail * usage.f_frsize,
    }

def parse_cpu_times(value):
    line = next((line for line in str(value or "").splitlines() if line.startswith("cpu ")), "")
    parts = line.split()[1:9]
    if len(parts) < 4 or not all(part.isdigit() for part in parts): return None
    ticks = [int(part) for part in parts]
    return sum(ticks), ticks[3] + (ticks[4] if len(ticks) > 4 else 0)

def cpu_usage(delay=0.2):
    before = parse_cpu_times((HOST_PROC_PATH / "stat").read_text(encoding="ascii", errors="ignore"))
    if not before: return None
    time.sleep(delay)
    after = parse_cpu_times((HOST_PROC_PATH / "stat").read_text(encoding="ascii", errors="ignore"))
    if not after: return None
    total_delta, idle_delta = after[0] - before[0], after[1] - before[1]
    if total_delta <= 0 or idle_delta < 0: return None
    return round(max(0, min(100, (1 - idle_delta / total_delta) * 100)), 1)

def host_metrics():
    result = filesystem_metrics()
    cpu = cpu_usage()
    if cpu is not None: result["cpuUsedPercent"] = cpu
    memory = {}
    try:
        for line in (HOST_PROC_PATH / "meminfo").read_text(encoding="ascii", errors="ignore").splitlines():
            parts = line.replace(":", "").split()
            if len(parts) >= 2 and parts[1].isdigit(): memory[parts[0]] = int(parts[1])
        if memory.get("MemTotal"): result["memoryUsedPercent"] = round((1 - memory.get("MemAvailable", 0) / memory["MemTotal"]) * 100, 1)
    except OSError: pass
    try:
        raw = HOST_THERMAL_PATH.read_text(encoding="ascii").strip()
        if raw.isdigit(): result["cpuTemperatureC"] = round(int(raw) / 1000, 1)
    except OSError: pass
    return result


def snapshot():
    services = {}
    for service in expected_services():
        try: services[service] = inspect_service(service)
        except (subprocess.SubprocessError, json.JSONDecodeError, IndexError, OSError, ValueError) as error:
            services[service] = {"service": service, "status": "unknown", "containerState": "unknown", "reason": type(error).__name__}
            
    metrics = host_metrics()
    metrics.update(filesystem_metrics())
    try:
        metrics["loadAverage"] = [round(v, 2) for v in os.getloadavg()]
        metrics["uptimeSeconds"] = round(float((HOST_PROC_PATH / "uptime").read_text().split()[0]))
    except Exception: pass

    return {"schemaVersion": 2, "collectedAt": datetime.now(timezone.utc).isoformat(), "metrics": metrics, "services": services}


def atomic_write(value):
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True, mode=0o775)
    fd, name = tempfile.mkstemp(prefix=".status-", dir=OUTPUT_FILE.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":")); handle.flush(); os.fsync(handle.fileno())
        os.chmod(name, 0o644); os.replace(name, OUTPUT_FILE)
    finally:
        try: os.unlink(name)
        except FileNotFoundError: pass


def atomic_response(path, value, chown_gid=None):
    # mkstemp defaults to 0600 root:root (this process runs as root) — fine
    # for the log/action spools, which only Central (via this same process)
    # ever reads back. chown_gid opts a response into being group-readable
    # too, for the apply_update spool, where the reader is server.js running
    # as a different, non-root user (nurseaid's appuser) in another container.
    fd, name = tempfile.mkstemp(prefix=".response-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":")); handle.flush(); os.fsync(handle.fileno())
        if chown_gid is not None:
            os.chown(name, 0, chown_gid)
            os.chmod(name, 0o640)
        os.replace(name, path)
    finally:
        try: os.unlink(name)
        except FileNotFoundError: pass


def process_log_requests(now=None):
    now = now or datetime.now(timezone.utc)
    SPOOL_DIR.mkdir(parents=True, exist_ok=True, mode=0o775)
    try: os.chown(SPOOL_DIR, 0, AGENT_UID); os.chmod(SPOOL_DIR, 0o2770)
    except PermissionError: pass
    for stale in list(SPOOL_DIR.glob("*.cursor")) + list(SPOOL_DIR.glob("*.response.json")):
        try:
            if now.timestamp() - stale.stat().st_mtime > 3600: stale.unlink(missing_ok=True)
        except OSError: pass
    allowed = set(expected_services())
    for request_path in list(SPOOL_DIR.glob("*.request.json"))[:8]:
        session_id = request_path.name.removesuffix(".request.json")
        response_path = SPOOL_DIR / f"{session_id}.response.json"
        cursor_path = SPOOL_DIR / f"{session_id}.cursor"
        if response_path.exists(): continue
        try:
            value = json.loads(request_path.read_text(encoding="utf-8"))
            service = str(value.get("service") or "")
            expires = datetime.fromisoformat(str(value.get("expiresAt") or "").replace("Z", "+00:00"))
            if not SESSION_RE.fullmatch(session_id) or service not in allowed or expires <= now:
                request_path.unlink(missing_ok=True); cursor_path.unlink(missing_ok=True); continue
            since = cursor_path.read_text().strip() if cursor_path.exists() else (
                now - timedelta(minutes=INITIAL_LOG_HISTORY_MINUTES)
            ).isoformat()
            cursor = now.isoformat()
            ids = container_ids(service)
            if not ids: raise ValueError("container not found")
            output = log_command("docker", "logs", "--timestamps", "--since", since, ids[0])
            cursor_path.write_text(cursor, encoding="ascii")
            if output:
                atomic_response(response_path, {"sessionId": session_id, "service": service, "state": "logs", "content": output[-48000:]})
            else:
                atomic_response(response_path, {"sessionId": session_id, "service": service, "state": "idle", "content": ""})
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
            try: atomic_response(response_path, {"sessionId": session_id, "state": "error", "error": str(error)[:500] or type(error).__name__})
            except OSError: pass


def diagnostics():
    load = os.getloadavg()
    metrics = host_metrics()
    services = {}
    for name in expected_services():
        item = inspect_service(name)
        services[name] = {key: item[key] for key in ("status", "containerState", "healthStatus", "restartCount", "exitCode", "oomKilled") if key in item}
    return {
        "hostname": os.uname().nodename[:160],
        "kernel": os.uname().release[:160],
        "uptimeSeconds": round(float((HOST_PROC_PATH / "uptime").read_text().split()[0])),
        "loadAverage": [round(value, 2) for value in load],
        **metrics,
        "services": services,
    }

def wait_for_service(service, timeout=90, interval=2):
    deadline = time.monotonic() + timeout
    latest = inspect_service(service)
    while time.monotonic() < deadline:
        if latest.get("status") == "healthy": return latest
        if latest.get("containerState") not in ("running", "restarting"): return latest
        time.sleep(interval)
        latest = inspect_service(service)
    latest["reason"] = latest.get("reason") or "service did not become healthy before timeout"
    return latest


def restart_self(container_id):
    subprocess.Popen(
        ("docker", "restart", container_id),
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    time.sleep(0.5)


def process_action_requests(now=None):
    now = now or datetime.now(timezone.utc)
    SPOOL_DIR.mkdir(parents=True, exist_ok=True, mode=0o775)
    allowed = set(expected_services())
    for request_path in list(SPOOL_DIR.glob("*.action-request.json"))[:2]:
        action_id = request_path.name.removesuffix(".action-request.json")
        response_path = SPOOL_DIR / f"{action_id}.action-response.json"
        if response_path.exists(): continue
        try:
            value = json.loads(request_path.read_text(encoding="utf-8")); action = str(value.get("action") or ""); service = str(value.get("service") or "")
            expires = datetime.fromisoformat(str(value.get("expiresAt") or "").replace("Z", "+00:00"))
            if not SESSION_RE.fullmatch(action_id) or expires <= now or action not in ("diagnostics", "restart_service"):
                request_path.unlink(missing_ok=True); continue
            if action == "diagnostics": result = diagnostics()
            elif service in allowed:
                ids = container_ids(service)
                if not ids: raise ValueError("container not found")
                if service == "compose-collector":
                    result = {"service": service, "message": "collector restart accepted; health will be reported by the next heartbeat"}
                    atomic_response(response_path, {"actionId": action_id, "status": "succeeded", "result": result})
                    request_path.unlink(missing_ok=True)
                    restart_self(ids[0])
                    continue
                command("docker", "restart", ids[0])
                runtime = wait_for_service(service)
                if runtime.get("status") != "healthy": raise RuntimeError(runtime.get("reason") or "service restart did not recover")
                result = {"service": service, "message": "service restart completed and healthy", "runtime": runtime}
            else: raise ValueError("service is not allowlisted")
            atomic_response(response_path, {"actionId": action_id, "status": "succeeded", "result": result})
        except Exception as error:
            try: atomic_response(response_path, {"actionId": action_id, "status": "failed", "error": str(error)[:500] or type(error).__name__})
            except OSError: pass


# ─── apply_update: admin-initiated self-update with automatic rollback ────
# Deliberately a SEPARATE spool dir/volume + separate handler from
# process_action_requests() above. Central only ever talks HTTP to this
# process (see central_cycle() below) and writes into SPOOL_DIR, never into
# APPLY_UPDATE_SPOOL — so Central structurally cannot trigger apply_update,
# not just "isn't supposed to". The only writer of *.action-request.json in
# this spool is server.js's POST /api/system/apply-update (adminOnly).
APPLY_UPDATE_SPOOL = Path(os.getenv("NURSEAID_APPLY_UPDATE_SPOOL", "/run/nurseaid-apply-update"))
# The `nurseaid` service runs as a non-root appuser (uid 100, gid 101 —
# pinned in ./Dockerfile) and must be able to write *.action-request.json
# into this spool; this container runs as root, which can always write
# regardless of the directory's owner/mode. Chowning the directory's group
# to appuser's gid grants exactly that one extra writer — not world-writable.
APPLY_UPDATE_APP_GID = int(os.getenv("NURSEAID_APP_GID", "101"))
REPO_PATH = Path(os.getenv("NURSEAID_REPO_PATH", "/repo"))
COMPOSE_FILE = REPO_PATH / "docker-compose.yml"
LOCK_FILE = APPLY_UPDATE_SPOOL / "apply_update.lock"
HISTORY_FILE = APPLY_UPDATE_SPOOL / "apply_update-history.jsonl"
# Response/request files here are read almost immediately (run_apply_update
# already blocks until the whole build/restart/health cycle is done before
# writing the response), so this only needs to bound long-run spool growth —
# not race the client's ~5s poll / ~6min give-up. Kept well clear of that
# window, unlike the tighter per-item TTL server.js applies on read.
APPLY_UPDATE_STALE_SECONDS = 600


def repo_command(*args, timeout=15):
    return subprocess.run(args, text=True, capture_output=True, check=True, cwd=REPO_PATH, timeout=timeout).stdout


def compose_command(*args, timeout=15):
    # --project-name is NOT optional here: without it, Compose infers the
    # project name from --project-directory's basename ("repo", the
    # container-side mount point) instead of the real running stack's
    # project ("nurseaid", NURSEAID_PROJECT_NAME) — a total identity
    # mismatch. Confirmed live: Compose then can't see the already-running
    # postgres/influxdb containers as "this project's", tries to create
    # fresh ones, and collides on their hardcoded container_name. Caught via
    # a real dry-run before this ever touched the live nurseaid container.
    return repo_command(
        "docker", "compose", "-f", str(COMPOSE_FILE), "--project-directory", str(REPO_PATH),
        "--project-name", PROJECT_NAME, *args, timeout=timeout
    )


def append_apply_update_history(entry):
    try:
        APPLY_UPDATE_SPOOL.mkdir(parents=True, exist_ok=True, mode=0o770)
        with open(HISTORY_FILE, "a", encoding="utf-8") as handle:
            handle.write(json.dumps({**entry, "at": datetime.now(timezone.utc).isoformat()}) + "\n")
    except OSError as error:
        print(f"[ApplyUpdate] history append failed: {error}", flush=True)


def acquire_apply_update_lock():
    APPLY_UPDATE_SPOOL.mkdir(parents=True, exist_ok=True, mode=0o770)
    try:
        fd = os.open(LOCK_FILE, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(fd, str(os.getpid()).encode("ascii"))
        os.close(fd)
    except FileExistsError:
        raise RuntimeError("update already in progress")


def release_apply_update_lock():
    try: LOCK_FILE.unlink(missing_ok=True)
    except OSError: pass


def report_phase(action_id, phase):
    """Write an interim 'still pending, here's where we are' response so the
    client's poll loop can render real progress instead of a static
    "updating..." message for however long build/health-check takes.
    Best-effort: a write failure here must never abort the actual pipeline."""
    try:
        response_path = APPLY_UPDATE_SPOOL / f"{action_id}.action-response.json"
        atomic_response(response_path, {"actionId": action_id, "status": "pending", "phase": phase}, chown_gid=APPLY_UPDATE_APP_GID)
    except OSError as error:
        print(f"[ApplyUpdate] phase report failed ({phase}): {error}", flush=True)


def run_apply_update(action_id):
    """The actual pipeline. Always releases the lock. Never raises for a
    handled build/health failure — those return a result dict describing
    what happened; only truly unexpected errors (guard failures, git/docker
    plumbing errors before any container was touched) raise, which the
    caller turns into a 'failed' response."""
    acquire_apply_update_lock()
    try:
        report_phase(action_id, "checking")
        # Clean-tree guard: never git-reset/checkout over an ops engineer's
        # in-progress edit on the same checkout this bind-mounts.
        if repo_command("git", "status", "--porcelain").strip():
            raise RuntimeError("repo has uncommitted local changes, refusing to update")

        # Snapshot current state so a failed build/health check can roll back.
        old_sha = repo_command("git", "rev-parse", "HEAD").strip()
        nurseaid_ids = container_ids("nurseaid")
        if not nurseaid_ids:
            raise RuntimeError("nurseaid container not found")
        old_image = command("docker", "inspect", "--format={{.Image}}", nurseaid_ids[0]).strip()
        if not old_image:
            raise RuntimeError("could not resolve current nurseaid image id")

        report_phase(action_id, "pulling")
        repo_command("git", "fetch", timeout=60)
        repo_command("git", "pull", timeout=60)
        new_sha = repo_command("git", "rev-parse", "HEAD").strip()

        if new_sha == old_sha:
            result = {"fromSha": old_sha, "toSha": new_sha, "healthy": True, "message": "already up to date"}
            append_apply_update_history({"actionId": action_id, **result})
            return result

        # Build only — does not touch the running container. A build failure
        # is zero-disruption: restore the working tree and stop.
        report_phase(action_id, "building")
        try:
            compose_command("build", "nurseaid", timeout=600)
        except subprocess.CalledProcessError as build_error:
            # `git reset --hard`, not `git checkout <sha>` — checkout on a raw
            # commit hash detaches HEAD, which would break the *next*
            # `git pull` (no tracking branch in detached HEAD). reset --hard
            # moves the current branch back and keeps it attached.
            repo_command("git", "reset", "--hard", old_sha, timeout=30)
            append_apply_update_history({
                "actionId": action_id, "fromSha": old_sha, "toSha": new_sha,
                "phase": "build", "healthy": False,
                "error": (build_error.stderr or build_error.stdout or "")[-2000:],
            })
            raise RuntimeError("build failed; working tree restored to the previous version, running container untouched")

        # This is the one moment the live container is disrupted. If the
        # recreate command itself errors (distinct from "came up but failed
        # its health check", handled below) Compose may not have touched the
        # old container at all yet — but /repo's git state has already moved
        # to new_sha, so it must still be reset to stay consistent with
        # whatever container actually ends up running.
        report_phase(action_id, "starting")
        try:
            compose_command("up", "-d", "nurseaid", timeout=120)
        except subprocess.CalledProcessError as up_error:
            repo_command("git", "reset", "--hard", old_sha, timeout=30)
            append_apply_update_history({
                "actionId": action_id, "fromSha": old_sha, "toSha": new_sha,
                "phase": "recreate", "healthy": False,
                "error": (up_error.stderr or up_error.stdout or "")[-2000:],
            })
            raise RuntimeError("failed to recreate the container on the new build; working tree restored — verify the running container manually, it may still be the old version")
        report_phase(action_id, "health_check")
        runtime = wait_for_service("nurseaid", timeout=90)

        if runtime.get("status") == "healthy":
            result = {"fromSha": old_sha, "toSha": new_sha, "healthy": True}
            append_apply_update_history({"actionId": action_id, **result})
            return result

        # Automatic rollback.
        result = {
            "fromSha": old_sha, "toSha": new_sha, "healthy": False, "rolledBack": True,
            "reason": runtime.get("reason") or "new version failed health check",
        }
        report_phase(action_id, "rolling_back")
        try:
            command("docker", "tag", old_image, "nurseaid-nurseaid:latest")
            # Same reasoning as the build-failure path above: reset --hard,
            # not checkout, to avoid leaving /repo in detached HEAD.
            repo_command("git", "reset", "--hard", old_sha, timeout=30)
            compose_command("up", "-d", "nurseaid", timeout=120)
            report_phase(action_id, "rollback_health_check")
            rollback_runtime = wait_for_service("nurseaid", timeout=90)
            result["rollbackHealthy"] = rollback_runtime.get("status") == "healthy"
            if not result["rollbackHealthy"]:
                result["critical"] = True
                result["rollbackReason"] = rollback_runtime.get("reason") or "rollback did not become healthy"
        except Exception as rollback_error:
            # Rollback itself blew up — do not retry or attempt further
            # remediation. A human has to look at this one.
            result["rollbackHealthy"] = False
            result["critical"] = True
            result["rollbackError"] = str(rollback_error)[:500]
        append_apply_update_history({"actionId": action_id, **result})
        return result
    finally:
        release_apply_update_lock()


def process_apply_update_requests(now=None):
    now = now or datetime.now(timezone.utc)
    APPLY_UPDATE_SPOOL.mkdir(parents=True, exist_ok=True, mode=0o770)
    # mkdir's mode only applies on *creation* — exist_ok=True silently skips
    # it once the volume already exists (Docker itself may have pre-created
    # the mount point as root:root 0755 on first use), so enforce ownership
    # every call. Group-owned by appuser's gid + 0770: root (this process)
    # and appuser (nurseaid, the only two legitimate writers) can read/write;
    # nobody else can.
    try:
        os.chown(APPLY_UPDATE_SPOOL, 0, APPLY_UPDATE_APP_GID)
        os.chmod(APPLY_UPDATE_SPOOL, 0o770)
    except OSError as error:
        print(f"[ApplyUpdate] spool chown/chmod failed: {error}", flush=True)
    for stale in list(APPLY_UPDATE_SPOOL.glob("*.action-request.json")) + list(APPLY_UPDATE_SPOOL.glob("*.action-response.json")):
        try:
            if now.timestamp() - stale.stat().st_mtime > APPLY_UPDATE_STALE_SECONDS: stale.unlink(missing_ok=True)
        except OSError: pass
    for request_path in list(APPLY_UPDATE_SPOOL.glob("*.action-request.json"))[:1]:
        action_id = request_path.name.removesuffix(".action-request.json")
        response_path = APPLY_UPDATE_SPOOL / f"{action_id}.action-response.json"
        if response_path.exists(): continue
        try:
            value = json.loads(request_path.read_text(encoding="utf-8"))
            expires = datetime.fromisoformat(str(value.get("expiresAt") or "").replace("Z", "+00:00"))
            if not SESSION_RE.fullmatch(action_id) or value.get("action") != "apply_update" or expires <= now:
                request_path.unlink(missing_ok=True); continue
            result = run_apply_update(action_id)
            atomic_response(response_path, {"actionId": action_id, "status": "succeeded", "result": result}, chown_gid=APPLY_UPDATE_APP_GID)
        except Exception as error:
            atomic_response(response_path, {"actionId": action_id, "status": "failed", "error": str(error)[:500] or type(error).__name__}, chown_gid=APPLY_UPDATE_APP_GID)


def http_json_request(url, method="POST", payload=None, headers=None, timeout=10, retries=3):
    headers = dict(headers or {})
    # Set default User-Agent and Accept, but allow explicit overrides
    if "User-Agent" not in headers:
        headers["User-Agent"] = f"NurseAid-Agent/{read_app_version()} (device {DEVICE_ID})"
    if "Accept" not in headers:
        headers["Accept"] = "application/json"
    if payload is not None and "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None

    def _one_request():
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        ctx = ssl.create_default_context()
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(body) if body else {}
            except (json.JSONDecodeError, ValueError):
                # Non-JSON success response; preserve evidence
                return resp.status, {
                    "_nonJson": True,
                    "_body": body[:800],
                    "_contentType": resp.headers.get("content-type", ""),
                    "_server": resp.headers.get("server", "")
                }

    # Retry transient failures (network errors and 5xx server responses) so a
    # short blip to Central does not drop a heartbeat/log/action payload whose
    # session would otherwise expire before we can resend it. Client errors
    # (4xx) are permanent and returned immediately.
    for attempt in range(retries + 1):
        try:
            status, res = _one_request()
            return status, res
        except urllib.error.HTTPError as error:
            try:
                body = error.read().decode("utf-8")
                try:
                    status, res = error.code, json.loads(body) if body else {}
                except (json.JSONDecodeError, ValueError):
                    status, res = error.code, {
                        "_nonJson": True,
                        "_body": body[:800],
                        "_contentType": error.headers.get("content-type", ""),
                        "_server": error.headers.get("server", "")
                    }
            except Exception:
                status, res = error.code, {
                    "_nonJson": True,
                    "_body": "",
                    "_contentType": "",
                    "_server": ""
                }
            if status < 500:
                return status, res
        except Exception as error:
            # Network-level failure (DNS, connection reset, timeout).
            status, res = 0, {"error": str(error)}
        if attempt == retries:
            return status, res
        time.sleep(min(30, 2 ** (attempt + 1)) / 10)


def _schedule_enroll_backoff(now):
    """Back off a failed Central enrolment: HEARTBEAT_INTERVAL, doubling up to ENROLL_BACKOFF_MAX."""
    global _enrollment_backoff_until, _enrollment_backoff_current, _last_enrollment_backoff_logged
    nxt = HEARTBEAT_INTERVAL if not _enrollment_backoff_current else _enrollment_backoff_current * 2
    _enrollment_backoff_current = min(ENROLL_BACKOFF_MAX, nxt)
    _enrollment_backoff_until = now + _enrollment_backoff_current
    if _last_enrollment_backoff_logged != _enrollment_backoff_current:
        print(f"[Central] Enrolment backoff: next attempt in {_enrollment_backoff_current}s", flush=True)
        _last_enrollment_backoff_logged = _enrollment_backoff_current


def get_central_credential():
    global _enrollment_backoff_until, _enrollment_backoff_current, _last_enrollment_backoff_logged
    
    if CREDENTIAL_FILE.exists():
        try:
            stored = json.loads(CREDENTIAL_FILE.read_text(encoding="utf-8"))
            if stored.get("deviceId") == DEVICE_ID and stored.get("credential"):
                # Credential found, reset backoff on success
                if _enrollment_backoff_current != 0:
                    _enrollment_backoff_until = 0.0
                    _enrollment_backoff_current = 0
                    _last_enrollment_backoff_logged = None
                return stored["credential"]
        except Exception as e:
            print(f"[Central] Error reading credential file: {e}", flush=True)

    if not CENTRAL_URL:
        return None

    # Check if we are in backoff state
    now = time.monotonic()
    if now < _enrollment_backoff_until:
        # In backoff; do not attempt enrollment
        if _last_enrollment_backoff_logged != _enrollment_backoff_current:
            print(f"[Central] Enrollment backoff: next attempt in {int(_enrollment_backoff_until - now)}s", flush=True)
            _last_enrollment_backoff_logged = _enrollment_backoff_current
        return None

    url = f"{CENTRAL_URL}/api/v1/devices/auto-enroll"
    payload = {"deviceId": DEVICE_ID, "hostname": os.uname().nodename[:160]}

    status, res = http_json_request(url, payload=payload)
    
    if status in (200, 201) and res.get("credential"):
        cred = res["credential"]
        # Reset backoff on success
        _enrollment_backoff_until = 0.0
        _enrollment_backoff_current = 0
        _last_enrollment_backoff_logged = None
        
        fd, name = tempfile.mkstemp(prefix=".cred-", dir=CREDENTIAL_FILE.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump({"deviceId": DEVICE_ID, "credential": cred}, handle)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(name, 0o644)
            os.replace(name, CREDENTIAL_FILE)
        except Exception as e:
            print(f"[Central] Error saving credential: {e}", flush=True)
            try: os.unlink(name)
            except FileNotFoundError: pass
        return cred
    elif status == 409:
        # Device already enrolled on Central but no local credential
        print(f"[Central] Device {DEVICE_ID} is already enrolled on Central server but local credential file is missing. Operator must restore the credential file or reset the device on Central.", flush=True)
        _schedule_enroll_backoff(now)
    else:
        # Other error (403, 500, etc.)
        evidence = res
        body_preview = evidence.get("_body", "")[:200] if evidence.get("_nonJson") else ""
        content_type = evidence.get("_contentType", "")
        server = evidence.get("_server", "")
        
        if status == 403:
            # Distinguish edge/WAF block from Central refusing unregistered device
            if evidence.get("_nonJson") or "cloudflare" in server.lower():
                print(f"[Central] Auto-enroll failed ({status}): request blocked at the edge/WAF, not by Central itself (a Cloudflare 'error code: 1010' here means the User-Agent is banned). URL={url} Device={DEVICE_ID} Server={server}", flush=True)
            else:
                print(f"[Central] Auto-enroll failed ({status}): Central rejected unregistered/unapproved device. Device={DEVICE_ID} Body={body_preview}", flush=True)
        else:
            print(f"[Central] Auto-enroll failed ({status}): URL={url} Device={DEVICE_ID} Body={body_preview} ContentType={content_type} Server={server}", flush=True)
        
        _schedule_enroll_backoff(now)
    
    return None


def central_cycle(snap):
    if not CENTRAL_URL:
        return

    cred = get_central_credential()
    if not cred:
        return

    headers = {"Authorization": f"Bearer {cred}"}
    services = snap.get("services", {})
    metrics = snap.get("metrics", {})
    if not metrics:
        metrics = host_metrics()

    unhealthy = any(s.get("status") != "healthy" for s in services.values())
    # Only machine-derived facts go up. hospitalCode/hospitalName/wardCode/
    # wardName/installPoint are deliberately absent: those are Central's
    # deployment *assignment* for this device, not something the device can
    # observe about itself. Sending them would let a local file (or a stale
    # .env) overwrite the assignment an operator made in Central.
    hb_payload = {
        "deviceId": DEVICE_ID,
        "hostname": os.uname().nodename[:160],
        "appVersion": read_app_version(),
        "status": "unhealthy" if unhealthy else "healthy",
        "services": services,
        "metrics": metrics,
        "sensors": {}
    }

    # 1. Heartbeat
    status, res = http_json_request(f"{CENTRAL_URL}/api/v1/devices/heartbeat", payload=hb_payload, headers=headers)
    if status == 401:
        print("[Central] Credential rejected (401), invalidating local credential", flush=True)
        try: CREDENTIAL_FILE.unlink(missing_ok=True)
        except OSError: pass
        return
    elif status not in (200, 201):
        print(f"[Central] Heartbeat response ({status}): {res}", flush=True)

    # 2. Poll & handle log commands
    status, res = http_json_request(f"{CENTRAL_URL}/api/v1/devices/log-commands", payload={"deviceId": DEVICE_ID}, headers=headers)
    if status == 200 and isinstance(res.get("sessions"), list):
        for item in res["sessions"]:
            session_id = item.get("sessionId")
            service = item.get("service")
            expires_at = item.get("expiresAt")
            if not session_id or not service or not expires_at: continue
            req_file = SPOOL_DIR / f"{session_id}.request.json"
            resp_file = SPOOL_DIR / f"{session_id}.response.json"
            if not resp_file.exists():
                try:
                    req_file.write_text(json.dumps({"service": service, "expiresAt": expires_at}), encoding="utf-8")
                    process_log_requests()
                except Exception as error:
                    print(f"[Central] Failed to process log request {session_id}: {error}", flush=True)
            if resp_file.exists():
                try:
                    resp_data = json.loads(resp_file.read_text(encoding="utf-8"))
                    batch_payload = {
                        "deviceId": DEVICE_ID,
                        "sessionId": session_id,
                        "state": resp_data.get("state"),
                        "content": resp_data.get("content", ""),
                        "error": resp_data.get("error")
                    }
                    upload_status, upload_res = http_json_request(
                        f"{CENTRAL_URL}/api/v1/devices/log-batches",
                        payload=batch_payload, headers=headers)
                    if upload_status == 200:
                        req_file.unlink(missing_ok=True)
                        resp_file.unlink(missing_ok=True)
                        (SPOOL_DIR / f"{session_id}.cursor").unlink(missing_ok=True)
                    else:
                        # Keep the response + cursor so this log is retried next
                        # cycle; deleting here would lose logs Central rejected.
                        print(f"[Central] Log batch upload failed ({upload_status}) for {session_id}: {upload_res}", flush=True)
                except Exception as error:
                    print(f"[Central] Log batch error: {error}", flush=True)

    # 3. Poll & handle action commands
    status, res = http_json_request(f"{CENTRAL_URL}/api/v1/devices/action-commands", payload={"deviceId": DEVICE_ID}, headers=headers)
    if status == 200 and isinstance(res.get("actions"), list):
        for item in res["actions"]:
            action_id = item.get("actionId")
            action = item.get("action")
            service = item.get("service")
            expires_at = item.get("expiresAt")
            if not action_id or not action or not expires_at: continue
            req_file = SPOOL_DIR / f"{action_id}.action-request.json"
            resp_file = SPOOL_DIR / f"{action_id}.action-response.json"
            if not resp_file.exists():
                try:
                    req_file.write_text(json.dumps({"action": action, "service": service, "expiresAt": expires_at}), encoding="utf-8")
                    process_action_requests()
                except Exception: pass
            if resp_file.exists():
                try:
                    resp_data = json.loads(resp_file.read_text(encoding="utf-8"))
                    result_payload = {
                        "deviceId": DEVICE_ID,
                        "actionId": action_id,
                        "status": resp_data.get("status"),
                        "result": resp_data.get("result"),
                        "error": resp_data.get("error")
                    }
                    upload_status, upload_res = http_json_request(
                        f"{CENTRAL_URL}/api/v1/devices/action-results",
                        payload=result_payload, headers=headers)
                    if upload_status == 200:
                        req_file.unlink(missing_ok=True)
                        resp_file.unlink(missing_ok=True)
                    else:
                        print(f"[Central] Action result upload failed ({upload_status}) for {action_id}: {upload_res}", flush=True)
                except Exception as error:
                    print(f"[Central] Action result error: {error}", flush=True)


def collect_once():
    atomic_write(snapshot())
    process_log_requests()
    process_action_requests()
    process_apply_update_requests()

def main():
    last_central_beat = 0
    while True:
        started = time.monotonic()
        current_snap = None
        try:
            current_snap = snapshot()
            atomic_write(current_snap)
            process_log_requests()
            process_action_requests()
            # NOTE: run_apply_update() blocks synchronously for the whole
            # build/restart/health-check cycle (up to ~15 min worst case) —
            # heartbeats to Central and diagnostics/restart_service pause for
            # that window. Acceptable for an admin-initiated, rare action;
            # not fire-and-forget/background by design (keeps the apply
            # pipeline's own error handling linear and simple).
            process_apply_update_requests()
        except Exception as error:
            print(json.dumps({"event": "collector_error", "error": type(error).__name__}), flush=True)

        now_mono = time.monotonic()
        if CENTRAL_URL and (now_mono - last_central_beat >= HEARTBEAT_INTERVAL):
            last_central_beat = now_mono
            try:
                central_cycle(current_snap or snapshot())
            except Exception as error:
                print(json.dumps({"event": "central_error", "error": str(error)}), flush=True)

        time.sleep(max(0.2, COLLECT_INTERVAL - (time.monotonic() - started)))

if __name__ == "__main__": main()