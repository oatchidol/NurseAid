#!/usr/bin/env node
// Driver for the NurseAid web app: brings up an isolated docker-compose
// stack (never touches an already-running prod stack), then drives it
// either over HTTP (curl-equivalent, for API/business-logic layers) or
// through a real headless browser (Playwright + system chromium, for
// the login/dashboard UI layer).
//
// Usage:
//   node driver.mjs up [--project NAME] [--port PORT]
//   node driver.mjs status [--project NAME]
//   node driver.mjs api <METHOD> <path> [jsonBody] [--port PORT] [--cookie FILE]
//   node driver.mjs login-ui <baseUrl> <user> <pass> <storageStateOut.json> [screenshotOut.png]
//   node driver.mjs shot <url> <out.png> [--storage-state FILE]
//   node driver.mjs down [--project NAME]
//
// Run from anywhere; paths below are resolved relative to the repo root
// (two levels up from this file: .claude/skills/run-nurseaid/driver.mjs).
import { chromium } from 'playwright';
import { execFileSync, execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const [, , cmd, ...rest] = process.argv;

function flag(name, def) {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? def : rest[i + 1];
}
// Positional args = everything except recognized "--flag value" pairs
// (not just tokens starting with "--" — the flag's VALUE isn't "--"
// prefixed either and must be excluded too).
const KNOWN_FLAGS = ['project', 'port', 'cookie', 'storage-state'];
function positionals() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (KNOWN_FLAGS.includes(rest[i]?.replace(/^--/, '')) && rest[i].startsWith('--')) { i++; continue; }
    out.push(rest[i]);
  }
  return out;
}
const PROJECT = flag('project', 'nurseaid-agentrun');
const PORT = Number(flag('port', '13333'));
const PG_PORT = PORT + 2099;   // 15432 for the default 13333
const INFLUX_PORT = PORT + 4753; // 18086
const MQTT_PORT_H = PORT - 1450; // 11883
const RUN_DIR = path.join('/tmp', `nurseaid-driver-${PROJECT}`);

function rand(bytes = 24) { return randomBytes(bytes).toString('base64').replace(/[=+/]/g, '').slice(0, bytes); }

function sh(command, args, opts = {}) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...opts });
}

function ensureRunDir() {
  mkdirSync(RUN_DIR, { recursive: true });
  const envPath = path.join(RUN_DIR, '.env');
  if (!existsSync(envPath)) {
    writeFileSync(envPath, [
      'PORT=3333', 'NODE_ENV=production',
      'DB_NAME=softwatch_iot', 'DB_USER=postgres', `DB_PASSWORD=${rand(32)}`,
      'INFLUX_ORG=softsquaregroup', 'INFLUX_BUCKET=naret2',
      `INFLUX_TOKEN=${rand(40)}`, `INFLUX_ADMIN_PASSWORD=${rand(24)}`,
      'MQTT_USER=nursemon', `MQTT_PASSWORD=${rand(24)}`,
      'LINE_TOKEN=', 'LINE_RATE_LIMIT_BACKOFF_SECONDS=900',
      'AI_CHAT_ENABLED=false', 'AI_BASE_URL=', 'AI_API_KEY=', 'AI_MODEL=',
      'AI_TIMEOUT_MS=60000', 'AI_MAX_HISTORY_MESSAGES=8', 'AI_RATE_LIMIT_PER_MINUTE=10',
      'AI_CONVERSATION_MAX_TOKENS=4096',
      `SESSION_SECRET=${rand(40)}`,
      'INITIAL_ADMIN_USERNAME=admin', `INITIAL_ADMIN_PASSWORD=${rand(20)}Aa1`,
    ].join('\n') + '\n');
  }
  // Compose merges list-valued keys (ports, etc.) by CONCATENATING across
  // -f files, not replacing — an override file adding "18086:8086" would
  // leave the base file's "8086:8086" published too, colliding with a
  // real prod stack on the same host. So: full standalone copy with the
  // port/container_name lines textually replaced, not a merge overlay.
  const composePath = path.join(RUN_DIR, 'docker-compose.yml');
  let compose = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  compose = compose
    .replace(/container_name: nurseaid-app/, `container_name: ${PROJECT}-app`)
    .replace(/container_name: nurseaid-influxdb/, `container_name: ${PROJECT}-influxdb`)
    .replace(/container_name: nurseaid-postgres/, `container_name: ${PROJECT}-postgres`)
    .replace(/container_name: nurseaid-mosquitto/, `container_name: ${PROJECT}-mosquitto`)
    .replace(/container_name: nurseaid-mqtt-bridge/, `container_name: ${PROJECT}-mqtt-bridge`)
    .replace(/container_name: nurseaid-compose-collector/, `container_name: ${PROJECT}-compose-collector`)
    .replace('"3333:3333"', `"${PORT}:3333"`)
    .replace('"5432:5432"', `"${PG_PORT}:5432"`)
    .replace('"8086:8086"', `"${INFLUX_PORT}:8086"`)
    .replace('"1883:1883"', `"${MQTT_PORT_H}:1883"`)
    // env_file paths are resolved relative to --project-directory (which
    // we point at the real repo root, so build contexts like
    // ./mosquitto-config resolve correctly) — that would load the REAL
    // prod .env instead of ours. Point env_file at our generated file by
    // absolute path instead.
    .replace(/^(\s*)- \.env$/gm, `$1- ${envPath}`);
  writeFileSync(composePath, compose);
  // build contexts (./mosquitto-config, ./mqtt-bridge, ./ops, .) are
  // relative to --project-directory, not to this generated file's
  // location, so point that at the real repo root.
  return { envPath, composePath };
}

function composeArgs(envPath, composePath) {
  return ['compose', '-p', PROJECT, '--project-directory', REPO_ROOT, '--env-file', envPath, '-f', composePath];
}

async function waitHealthy(timeoutMs = 180000) {
  const services = ['influxdb', 'postgres', 'mosquitto', 'nurseaid', 'mqtt-bridge', 'compose-collector'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = services.map(s => `${PROJECT}-${s === 'nurseaid' ? 'app' : s}`);
    const statuses = names.map(n => {
      try { return sh('docker', ['inspect', '-f', '{{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}}', n]).trim(); }
      catch { return 'missing'; }
    });
    if (statuses.every(s => s === 'healthy' || s === 'n/a')) return true;
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}

async function main() {
  if (cmd === 'up') {
    const { envPath, composePath } = ensureRunDir();
    console.log(`[driver] project=${PROJECT} port=${PORT} envDir=${RUN_DIR}`);
    execFileSync('docker', [...composeArgs(envPath, composePath), 'up', '-d', '--build'], { stdio: 'inherit', cwd: REPO_ROOT });
    const ok = await waitHealthy();
    console.log(ok ? '[driver] all services healthy' : '[driver] TIMEOUT waiting for healthy');
    if (!ok) process.exit(1);
    const admin = readFileSync(path.join(RUN_DIR, '.env'), 'utf8').match(/INITIAL_ADMIN_PASSWORD=(\S+)/)[1];
    console.log(`[driver] url=http://localhost:${PORT}  admin=admin  password=${admin}`);
  } else if (cmd === 'down') {
    const { envPath, composePath } = ensureRunDir();
    execFileSync('docker', [...composeArgs(envPath, composePath), 'down', '-v'], { stdio: 'inherit', cwd: REPO_ROOT });
  } else if (cmd === 'status') {
    const { envPath, composePath } = ensureRunDir();
    execFileSync('docker', [...composeArgs(envPath, composePath), 'ps'], { stdio: 'inherit', cwd: REPO_ROOT });
  } else if (cmd === 'api') {
    const [method, urlPath, body] = positionals();
    const port = flag('port', String(PORT));
    const args = ['-s', '-i', '-X', method, `http://localhost:${port}${urlPath}`];
    if (body) args.push('-H', 'Content-Type: application/json', '-d', body);
    const cookieFile = flag('cookie');
    if (cookieFile) args.push('-c', cookieFile, '-b', cookieFile);
    console.log(sh('curl', args));
  } else if (cmd === 'login-ui') {
    const [baseUrl, user, pass, storageOut, screenshotOut] = positionals();
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.fill('#u', user);
    await page.fill('#p', pass);
    await Promise.all([page.waitForURL(u => u.pathname === '/', { timeout: 10000 }), page.click('button:has-text("SIGN IN")')]);
    if (storageOut) await page.context().storageState({ path: storageOut });
    if (screenshotOut) await page.screenshot({ path: screenshotOut, fullPage: true });
    console.log('[driver] login-ui OK, landed on', page.url());
    await browser.close();
  } else if (cmd === 'shot') {
    const [url, out] = positionals();
    const storageState = flag('storage-state');
    const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const context = await browser.newContext(storageState ? { storageState } : {});
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.screenshot({ path: out, fullPage: true });
    console.log('[driver] screenshot ->', out);
    await browser.close();
  } else {
    console.error('Unknown command. See top-of-file usage comment.');
    process.exit(1);
  }
}

main().catch(e => { console.error('[driver] FAILED', e); process.exit(1); });
