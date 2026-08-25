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
SESSION_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

def get_machine_device_id():
    env_id = os.getenv("NURSEAID_DEVICE_ID", "").strip().upper()
    if env_id and re.match(r"^NA-[A-F0-9]{8}$", env_id):
        return env_id
    
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


def atomic_response(path, value):
    fd, name = tempfile.mkstemp(prefix=".response-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":")); handle.flush(); os.fsync(handle.fileno())
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


def http_json_request(url, method="POST", payload=None, headers=None, timeout=10):
    headers = dict(headers or {})
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    if payload is not None and "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            body = resp.read().decode("utf-8")
            return resp.status, json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        try:
            body = error.read().decode("utf-8")
            return error.code, json.loads(body) if body else {}
        except Exception:
            return error.code, {}
    except Exception as error:
        return 0, {"error": str(error)}


def get_central_credential():
    if CREDENTIAL_FILE.exists():
        try:
            stored = json.loads(CREDENTIAL_FILE.read_text(encoding="utf-8"))
            if stored.get("deviceId") == DEVICE_ID and stored.get("credential"):
                return stored["credential"]
        except Exception as e:
            print(f"[Central] Error reading credential file: {e}", flush=True)

    if not CENTRAL_URL:
        return None

    url = f"{CENTRAL_URL}/api/v1/devices/auto-enroll"
    status, res = http_json_request(url, payload={"deviceId": DEVICE_ID, "hostname": os.uname().nodename[:160]})
    if status in (200, 201) and res.get("credential"):
        cred = res["credential"]
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
        print(f"[Central] Device {DEVICE_ID} is already registered on Central server but missing local credential file", flush=True)
    else:
        print(f"[Central] Auto-enroll failed ({status}): {res}", flush=True)
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
    hb_payload = {
        "deviceId": DEVICE_ID,
        "hostname": os.uname().nodename[:160],
        "appVersion": os.getenv("NURSEAID_APP_VERSION", "1.0.0"),
        "hospitalCode": os.getenv("NURSEAID_HOSPITAL_CODE", ""),
        "hospitalName": os.getenv("NURSEAID_HOSPITAL_NAME", ""),
        "wardCode": os.getenv("NURSEAID_WARD_CODE", ""),
        "wardName": os.getenv("NURSEAID_WARD_NAME", ""),
        "installPoint": os.getenv("NURSEAID_INSTALL_POINT", ""),
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
                except Exception: pass
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
                    http_json_request(f"{CENTRAL_URL}/api/v1/devices/log-batches", payload=batch_payload, headers=headers)
                except Exception as error:
                    print(f"[Central] Log batch error: {error}", flush=True)
                finally:
                    req_file.unlink(missing_ok=True)
                    resp_file.unlink(missing_ok=True)
                    (SPOOL_DIR / f"{session_id}.cursor").unlink(missing_ok=True)

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
                    http_json_request(f"{CENTRAL_URL}/api/v1/devices/action-results", payload=result_payload, headers=headers)
                except Exception as error:
                    print(f"[Central] Action result error: {error}", flush=True)
                finally:
                    req_file.unlink(missing_ok=True)
                    resp_file.unlink(missing_ok=True)


def collect_once():
    atomic_write(snapshot())
    process_log_requests()
    process_action_requests()

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