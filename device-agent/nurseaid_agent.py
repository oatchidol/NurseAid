#!/usr/bin/env python3
"""NurseAid device agent using only the Python standard library."""
import hashlib, json, os, random, re, socket, ssl, stat, sys, threading, time
import urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

VERSION = "1.5.2"
DATA_DIR = Path(os.getenv("DATA_DIR", "/var/lib/nurseaid-agent"))
CREDENTIAL_FILE = DATA_DIR / "credential.json"
BOOTSTRAP_FILE = DATA_DIR / "enrollment-code"
LAST_SUCCESS_FILE = DATA_DIR / "last-heartbeat-success"
CENTRAL_URL = os.getenv("CENTRAL_URL", "https://nurseaid.softsquaregroup.com").rstrip("/")
INTERVAL = max(30, int(os.getenv("HEARTBEAT_INTERVAL", "60")))
COMPOSE_STATUS_FILE = Path(os.getenv("COMPOSE_STATUS_FILE", "/run/nurseaid-compose/status.json"))
COMPOSE_STATUS_MAX_AGE = max(60, int(os.getenv("COMPOSE_STATUS_MAX_AGE", "120")))
LOG_SPOOL_DIR = Path(os.getenv("LOG_SPOOL_DIR", "/run/nurseaid-compose"))
LOG_POLL_INTERVAL = max(2, int(os.getenv("LOG_POLL_INTERVAL", "3")))

def read_first(paths):
    for path in paths:
        try:
            value = Path(path).read_text(encoding="utf-8", errors="ignore").strip()
            if value: return value
        except OSError: pass
    return ""

def hardware_identity():
    cpuinfo = read_first(["/host/proc/cpuinfo", "/proc/cpuinfo"])
    for line in cpuinfo.splitlines():
        if line.lower().startswith("serial") and ":" in line:
            serial = line.split(":", 1)[1].strip().lower()
            if serial and serial != "0" * len(serial): return serial
    machine_id = read_first(["/host/etc/machine-id", "/etc/machine-id"])
    if not machine_id: raise RuntimeError("hardware identity is unavailable")
    return machine_id.lower()

def device_id(identity=None):
    identity = identity or hardware_identity()
    tail = identity[-8:]
    suffix = tail.upper() if len(tail) == 8 and all(c in "0123456789abcdefABCDEF" for c in tail) else hashlib.sha256(identity.encode()).hexdigest()[:8].upper()
    return "NA-" + suffix

def host_name():
    value = read_first(["/host/etc/hostname"])
    return value[:160] if value else socket.gethostname()[:160]

def atomic_json(path, value, mode=stat.S_IRUSR | stat.S_IWUSR):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle); handle.flush(); os.fsync(handle.fileno())
    os.replace(temp, path); os.chmod(path, mode)

def atomic_spool_json(path, value):
    atomic_json(path, value, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IWGRP)

def request_json(path, payload, token=None, timeout=12):
    headers = {"Content-Type": "application/json", "User-Agent": f"nurseaid-agent/{VERSION}"}
    if token: headers["Authorization"] = "Bearer " + token
    request = urllib.request.Request(CENTRAL_URL + path, data=json.dumps(payload).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=timeout, context=ssl.create_default_context()) as response:
        return json.loads(response.read().decode())

def redact_log_text(value):
    text = str(value or "").replace("\x00", "")
    rules = (
        (r"(authorization\s*[:=]\s*bearer\s+)[^\s,;]+", r"\1[REDACTED]"),
        (r"((?:password|passwd|pwd|token|secret|api[_-]?key|credential)\s*[:=]\s*)[^\s,;]+", r"\1[REDACTED]"),
        (r"(postgres(?:ql)?://[^:\s/@]+:)[^@\s/]+@", r"\1[REDACTED]@"),
    )
    for pattern, replacement in rules: text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text.encode("utf-8")[:48000].decode("utf-8", errors="ignore")

def valid_session_id(value):
    return bool(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", str(value or "").lower()))

def normalize_action_result(value):
    if not isinstance(value, dict): return {}
    result = {}
    for key, raw in list(value.items())[:40]:
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", str(key)): continue
        if isinstance(raw, bool) or isinstance(raw, (int, float)): result[key] = raw
        elif isinstance(raw, str): result[key] = raw[:2000]
        elif isinstance(raw, list): result[key] = [str(item)[:160] for item in raw[:32]]
        elif isinstance(raw, dict): result[key] = normalize_action_result(raw)
    return result

def upload_action_result(credential, result_path):
    action_id = result_path.name.removesuffix(".action-response.json")
    if not valid_session_id(action_id):
        result_path.unlink(missing_ok=True); return
    value = json.loads(result_path.read_text(encoding="utf-8")); status = "succeeded" if value.get("status") == "succeeded" else "failed"
    request_json("/api/v1/devices/action-results", {"deviceId": credential["deviceId"], "actionId": action_id, "status": status, "result": normalize_action_result(value.get("result")), "error": str(value.get("error") or "")[:500]}, credential["credential"])
    result_path.unlink(missing_ok=True)
    (LOG_SPOOL_DIR / (action_id + ".action-request.json")).unlink(missing_ok=True)

def action_worker():
    LOG_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    while True:
        try:
            credential = load_credential()
            for result_path in list(LOG_SPOOL_DIR.glob("*.action-response.json"))[:4]: upload_action_result(credential, result_path)
            response = request_json("/api/v1/devices/action-commands", {"deviceId": credential["deviceId"]}, credential["credential"])
            active = set()
            for item in response.get("actions", [])[:1]:
                action_id = str(item.get("actionId", "")).lower(); action = str(item.get("action", "")); service = str(item.get("service") or "")
                if not valid_session_id(action_id) or action not in ("diagnostics", "restart_service"): continue
                if action == "restart_service" and not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", service): continue
                active.add(action_id)
                request_path = LOG_SPOOL_DIR / (action_id + ".action-request.json")
                result_path = LOG_SPOOL_DIR / (action_id + ".action-response.json")
                if not request_path.exists() and not result_path.exists(): atomic_spool_json(request_path, {"actionId": action_id, "action": action, "service": service, "expiresAt": item.get("expiresAt")})
                if result_path.exists(): upload_action_result(credential, result_path)
            for request_path in LOG_SPOOL_DIR.glob("*.action-request.json"):
                if request_path.name.split(".", 1)[0] not in active: request_path.unlink(missing_ok=True)
        except urllib.error.HTTPError as error:
            if error.code != 404: print(json.dumps({"event": "action_worker_http_error", "status": error.code}), file=sys.stderr, flush=True)
        except Exception as error:
            print(json.dumps({"event": "action_worker_error", "error": type(error).__name__}), file=sys.stderr, flush=True)
        time.sleep(LOG_POLL_INTERVAL)

def upload_log_response(credential, session_id, response, previous_state=None):
    payload = json.loads(response.read_text(encoding="utf-8"))
    content = redact_log_text(payload.get("content"))
    state = str(payload.get("state") or ("logs" if content else "idle"))
    if state not in ("logs", "idle", "error"): state = "error"
    if content or state != previous_state:
        request_json("/api/v1/devices/log-batches", {
            "deviceId": credential["deviceId"], "sessionId": session_id, "state": state,
            "content": content, "error": str(payload.get("error") or "")[:500]
        }, credential["credential"])
    response.unlink(missing_ok=True)
    return state


def log_worker():
    LOG_SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    session_states = {}
    while True:
        try:
            credential = load_credential()
            result = request_json("/api/v1/devices/log-commands", {"deviceId": credential["deviceId"]}, credential["credential"])
            active = set()
            for session in result.get("sessions", [])[:4]:
                session_id, service = str(session.get("sessionId", "")).lower(), str(session.get("service", ""))
                if not valid_session_id(session_id) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", service): continue
                active.add(session_id)
                atomic_spool_json(LOG_SPOOL_DIR / (session_id + ".request.json"), {"sessionId": session_id, "service": service, "expiresAt": session.get("expiresAt")})
                response = LOG_SPOOL_DIR / (session_id + ".response.json")
                if response.exists():
                    session_states[session_id] = upload_log_response(credential, session_id, response, session_states.get(session_id))
            for request in LOG_SPOOL_DIR.glob("*.request.json"):
                if request.name.split(".", 1)[0] not in active: request.unlink(missing_ok=True)
            session_states = {session_id: state for session_id, state in session_states.items() if session_id in active}
        except Exception as error:
            print(json.dumps({"event": "log_worker_error", "error": type(error).__name__}), file=sys.stderr, flush=True)
        time.sleep(LOG_POLL_INTERVAL)

def probe_http(host, port, path="/health"):
    try:
        with urllib.request.urlopen(f"http://{host}:{port}{path}", timeout=4) as response:
            return {"status": "healthy" if response.status < 400 else "unhealthy", "code": response.status}
    except Exception as error: return {"status": "unhealthy", "error": type(error).__name__}

def probe_tcp(host, port):
    try:
        with socket.create_connection((host, port), timeout=3): return {"status": "healthy"}
    except OSError as error: return {"status": "unhealthy", "error": type(error).__name__}

def parse_cpu_times(value):
    line = next((line for line in str(value or "").splitlines() if line.startswith("cpu ")), "")
    parts = line.split()[1:9]
    if len(parts) < 4 or not all(part.isdigit() for part in parts): return None
    ticks = [int(part) for part in parts]
    return sum(ticks), ticks[3] + (ticks[4] if len(ticks) > 4 else 0)

def cpu_used_percent(before, after):
    first, second = parse_cpu_times(before), parse_cpu_times(after)
    if not first or not second: return None
    total_delta, idle_delta = second[0] - first[0], second[1] - first[1]
    if total_delta <= 0 or idle_delta < 0: return None
    return round(max(0, min(100, (1 - idle_delta / total_delta) * 100)), 1)

def sample_cpu_usage(delay=0.2):
    before = read_first(["/host/proc/stat", "/proc/stat"])
    if not before: return None
    time.sleep(delay)
    return cpu_used_percent(before, read_first(["/host/proc/stat", "/proc/stat"]))

def metrics():
    result = {}
    try:
        payload = json.loads(COMPOSE_STATUS_FILE.read_text(encoding="utf-8"))
        disk = (payload.get("metrics") or {}).get("diskUsedPercent")
        if disk is not None and 0 <= float(disk) <= 100: result["diskUsedPercent"] = round(float(disk), 1)
    except (OSError, ValueError, TypeError, json.JSONDecodeError): pass
    cpu = sample_cpu_usage()
    if cpu is not None: result["cpuUsedPercent"] = cpu
    values = {}
    for line in read_first(["/host/proc/meminfo", "/proc/meminfo"]).splitlines():
        parts = line.replace(":", "").split()
        if len(parts) >= 2 and parts[1].isdigit(): values[parts[0]] = int(parts[1])
    if values.get("MemTotal"): result["memoryUsedPercent"] = round((1 - values.get("MemAvailable", 0) / values["MemTotal"]) * 100, 1)
    temp = read_first(["/host/sys/class/thermal/thermal_zone0/temp"])
    if temp.isdigit(): result["cpuTemperatureC"] = round(int(temp) / 1000, 1)
    return result

def compose_status(now=None):
    now = now or datetime.now(timezone.utc)
    try:
        payload = json.loads(COMPOSE_STATUS_FILE.read_text(encoding="utf-8"))
        collected = datetime.fromisoformat(str(payload["collectedAt"]).replace("Z", "+00:00"))
        if collected.tzinfo is None: collected = collected.replace(tzinfo=timezone.utc)
        age = max(0, int((now - collected).total_seconds()))
        services = payload.get("services")
        if not isinstance(services, dict): raise ValueError("services missing")
        result = {}
        fields = ("service", "containerName", "status", "containerState", "healthStatus", "restartCount", "exitCode", "oomKilled", "failingStreak", "lastHealthOutput", "startedAt", "finishedAt", "reason")
        for name, item in list(services.items())[:32]:
            if not isinstance(item, dict): continue
            result[str(name)[:80]] = {key: item[key] for key in fields if key in item}
        collector = result.setdefault("compose-collector", {})
        collector["snapshotAgeSeconds"] = age
        if age > COMPOSE_STATUS_MAX_AGE:
            collector["status"] = "unhealthy"
            collector["reason"] = "compose status snapshot is stale"
        elif collector.get("status") != "healthy":
            collector["status"] = "healthy"
            collector["reason"] = ""
        return result
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        return {"compose-collector": {"status": "unhealthy", "reason": f"snapshot unavailable: {type(error).__name__}"}}


def service_status():
    services = compose_status()
    probes = {
        "nurseaid": probe_http("nurseaid", 3333),
        "influxdb": probe_http("influxdb", 8086),
        "postgres": probe_tcp("postgres", 5432),
        "mosquitto": probe_tcp("mosquitto", 1883),
    }
    for name, probe in probes.items():
        item = services.setdefault(name, {"service": name, "status": probe["status"], "containerState": "unknown"})
        item["applicationProbe"] = probe
        if probe["status"] != "healthy":
            item["status"] = "unhealthy"
            item["reason"] = "application probe failed: " + str(probe.get("error") or probe.get("code") or "unknown")
    return services

def enroll():
    payload = {"deviceId": device_id(), "hostname": host_name()}
    if BOOTSTRAP_FILE.exists():
        code = BOOTSTRAP_FILE.read_text().strip()
        if not code: raise RuntimeError("enrollment code is empty")
        payload["enrollmentCode"] = code
        result = request_json("/api/v1/devices/enroll", payload)
    else:
        result = request_json("/api/v1/devices/auto-enroll", payload)
    atomic_json(CREDENTIAL_FILE, {"deviceId": result["deviceId"], "credential": result["credential"]})
    BOOTSTRAP_FILE.unlink(missing_ok=True)
    return result

def load_credential():
    if not CREDENTIAL_FILE.exists(): enroll()
    value = json.loads(CREDENTIAL_FILE.read_text())
    if value.get("deviceId") != device_id() or not value.get("credential"): raise RuntimeError("credential does not match this hardware")
    return value

def heartbeat(credential):
    services = service_status(); healthy = all(item["status"] == "healthy" for item in services.values())
    return request_json("/api/v1/devices/heartbeat", {"deviceId": credential["deviceId"], "hostname": host_name(), "appVersion": VERSION, "status": "healthy" if healthy else "degraded", "services": services, "metrics": metrics()}, credential["credential"])

def main():
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700); delay = 5
    threading.Thread(target=log_worker, name="live-log-worker", daemon=True).start()
    threading.Thread(target=action_worker, name="remote-action-worker", daemon=True).start()
    while True:
        try:
            credential = load_credential(); result = heartbeat(credential)
            LAST_SUCCESS_FILE.write_text(str(int(time.time())), encoding="ascii")
            print(json.dumps({"event": "heartbeat", "deviceId": credential["deviceId"], "serverTime": result.get("serverTime")}), flush=True); delay = INTERVAL
        except urllib.error.HTTPError as error:
            print(json.dumps({"event": "http_error", "status": error.code, "detail": error.read(512).decode(errors="replace")}), file=sys.stderr, flush=True); delay = min(300, max(10, delay * 2))
        except Exception as error:
            print(json.dumps({"event": "agent_error", "error": str(error)}), file=sys.stderr, flush=True); delay = min(300, max(10, delay * 2))
        time.sleep(delay + random.uniform(0, min(10, delay * 0.1)))

if __name__ == "__main__": main()