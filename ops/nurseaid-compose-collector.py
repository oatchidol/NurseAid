#!/usr/bin/env python3
"""Export non-sensitive Docker Compose runtime health for the NurseAid agent."""
import json
import os
import subprocess
import tempfile
import re
import time
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
SESSION_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def command(*args):
    return subprocess.run(args, text=True, capture_output=True, check=True).stdout


def log_command(*args):
    completed = subprocess.run(args, text=True, capture_output=True, check=True)
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
    return {"schemaVersion": 2, "collectedAt": datetime.now(timezone.utc).isoformat(), "metrics": filesystem_metrics(), "services": services}


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


def atomic_response(path, value):
    fd, name = tempfile.mkstemp(prefix=".response-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":")); handle.flush(); os.fsync(handle.fileno())
        os.chmod(name, 0o600); os.chown(name, AGENT_UID, AGENT_UID); os.replace(name, path)
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


def collect_once():
    atomic_write(snapshot())
    process_log_requests()
    process_action_requests()

def main():
    while True:
        started = time.monotonic()
        try: collect_once()
        except Exception as error:
            print(json.dumps({"event": "collector_error", "error": type(error).__name__}), flush=True)
        time.sleep(max(0.2, COLLECT_INTERVAL - (time.monotonic() - started)))

if __name__ == "__main__": main()