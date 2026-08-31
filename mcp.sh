#!/usr/bin/env bash
set -Eeuo pipefail

# ChatGPT ↔ OpenAI Secure MCP Tunnel ↔ Local Workspace
# รองรับ Linux x86_64/arm64 โดยเน้น Debian/Ubuntu สำหรับ auto-install dependencies
# MCP mode:
#   serena     = เหมาะกับงานเขียน/แก้โค้ด
#   filesystem = อ่าน/เขียนไฟล์ทั่วไปผ่าน MCP Filesystem

PROFILE_NAME="${PROFILE_NAME:-chatgpt-local-workspace}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/share/chatgpt-mcp-tunnel}"
PROFILE_DIR="$INSTALL_DIR/profiles"
SECRET_DIR="$INSTALL_DIR/secrets"
LOG_DIR="$INSTALL_DIR/logs"
BIN_DIR="$INSTALL_DIR/bin"
MCP_LAUNCHER="$INSTALL_DIR/mcp-launcher.sh"
START_SCRIPT="$INSTALL_DIR/start-chatgpt-mcp.sh"

info() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; exit 1; }

cleanup_key() {
  unset CONTROL_PLANE_API_KEY 2>/dev/null || true
}
trap cleanup_key EXIT

is_debian_like() {
  [[ -f /etc/debian_version ]] || grep -qiE 'ubuntu|debian' /etc/os-release 2>/dev/null
}

sudo_cmd() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "ต้องใช้สิทธิ์ root/sudo เพื่อติดตั้ง dependency: $*"
  fi
}

ensure_base_tools() {
  local missing=()
  for c in curl unzip sha256sum; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if ((${#missing[@]})); then
    is_debian_like || die "ไม่พบ ${missing[*]} และ auto-install รองรับ Debian/Ubuntu เท่านั้น"
    info "ติดตั้ง dependency พื้นฐาน: ${missing[*]}"
    sudo_cmd apt-get update
    sudo_cmd apt-get install -y curl unzip coreutils ca-certificates
  fi
}

ensure_node() {
  if command -v npx >/dev/null 2>&1; then
    ok "พบ npx: $(command -v npx)"
    return
  fi

  is_debian_like || die "ไม่พบ npx. กรุณาติดตั้ง Node.js 20+ แล้วรันใหม่"
  info "ติดตั้ง Node.js 24.x สำหรับ Filesystem MCP"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$tmp"
  if [[ "$(id -u)" -eq 0 ]]; then
    bash "$tmp"
  else
    sudo -E bash "$tmp"
  fi
  rm -f "$tmp"
  sudo_cmd apt-get install -y nodejs
  command -v npx >/dev/null 2>&1 || die "ติดตั้ง Node.js แล้วแต่ยังไม่พบ npx"
  ok "Node.js: $(node --version), npm: $(npm --version)"
}

ensure_serena() {
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

  if ! command -v uv >/dev/null 2>&1; then
    info "ติดตั้ง uv จาก Astral"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  fi

  command -v uv >/dev/null 2>&1 || die "ติดตั้ง uv ไม่สำเร็จ"

  if command -v serena >/dev/null 2>&1; then
    info "อัปเดต Serena"
    uv tool upgrade serena-agent || true
  else
    info "ติดตั้ง Serena"
    uv tool install -p 3.13 serena-agent
  fi

  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  command -v serena >/dev/null 2>&1 || die "ติดตั้ง Serena แล้วแต่ไม่พบคำสั่ง serena"

  info "Initialize Serena"
  serena init
  ok "Serena พร้อมใช้งาน: $(command -v serena)"
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64) echo amd64 ;;
    aarch64|arm64) echo arm64 ;;
    *) die "สถาปัตยกรรม $(uname -m) ยังไม่มี binary อัตโนมัติในสคริปต์นี้" ;;
  esac
}

install_tunnel_client() {
  ensure_base_tools
  mkdir -p "$BIN_DIR"

  local arch tag asset url sums tmp zip expected actual extracted found
  arch="$(detect_arch)"
  info "ตรวจ release ล่าสุดของ OpenAI tunnel-client"
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/openai/tunnel-client/releases/latest)"
  tag="${url##*/}"
  [[ "$tag" == v* ]] || die "หา release tag ล่าสุดไม่สำเร็จ: $url"

  asset="tunnel-client-${tag}-linux-${arch}.zip"
  tmp="$(mktemp -d)"
  zip="$tmp/$asset"

  info "ดาวน์โหลด tunnel-client $tag ($arch)"
  curl -fL "https://github.com/openai/tunnel-client/releases/download/${tag}/${asset}" -o "$zip"
  curl -fL "https://github.com/openai/tunnel-client/releases/download/${tag}/SHA256SUMS.txt" -o "$tmp/SHA256SUMS.txt"

  expected="$(awk -v f="$asset" '$2==f {print $1; exit}' "$tmp/SHA256SUMS.txt")"
  [[ -n "$expected" ]] || die "ไม่พบ checksum ของ $asset"
  actual="$(sha256sum "$zip" | awk '{print $1}')"
  [[ "$expected" == "$actual" ]] || die "SHA256 ไม่ตรงกัน หยุดติดตั้งเพื่อความปลอดภัย"

  extracted="$tmp/extracted"
  mkdir -p "$extracted"
  unzip -q "$zip" -d "$extracted"
  found="$(find "$extracted" -type f -name 'tunnel-client' -print -quit)"
  [[ -n "$found" ]] || die "ไม่พบ tunnel-client ใน release archive"

  install -m 0755 "$found" "$BIN_DIR/tunnel-client"
  rm -rf "$tmp"
  ok "$("$BIN_DIR/tunnel-client" --version)"
}

prompt_inputs() {
  local default_ws mode_choice

  echo
  echo "เลือก MCP ที่ต้องการ"
  echo "  1) Serena      - แนะนำสำหรับงานโค้ด/โปรเจกต์"
  echo "  2) Filesystem  - อ่าน/เขียนไฟล์ทั่วไป"
  read -r -p "เลือก [1]: " mode_choice
  mode_choice="${mode_choice:-1}"
  case "$mode_choice" in
    1|serena|Serena) MCP_MODE="serena" ;;
    2|filesystem|Filesystem|fs) MCP_MODE="filesystem" ;;
    *) die "ตัวเลือก MCP ไม่ถูกต้อง" ;;
  esac

  default_ws="$PWD"
  read -r -p "Local workspace [$default_ws]: " WORKSPACE
  WORKSPACE="${WORKSPACE:-$default_ws}"
  WORKSPACE="$(readlink -f "$WORKSPACE" 2>/dev/null || true)"
  [[ -d "$WORKSPACE" ]] || die "ไม่พบ workspace: $WORKSPACE"

  read -r -p "OpenAI Tunnel ID (tunnel_...): " TUNNEL_ID
  [[ "$TUNNEL_ID" == tunnel_* ]] || die "Tunnel ID ต้องขึ้นต้นด้วย tunnel_"

  read -r -s -p "OpenAI Runtime API Key (ซ่อนข้อความ): " RUNTIME_KEY
  echo
  [[ -n "$RUNTIME_KEY" ]] || die "Runtime API Key ห้ามว่าง"

  export MCP_MODE WORKSPACE TUNNEL_ID RUNTIME_KEY
}

write_secret() {
  mkdir -p "$SECRET_DIR"
  umask 077
  printf '%s' "$RUNTIME_KEY" > "$SECRET_DIR/runtime-api-key"
  chmod 600 "$SECRET_DIR/runtime-api-key"
  ok "บันทึก Runtime key แบบ permission 600 ที่ $SECRET_DIR/runtime-api-key"
}

write_mcp_launcher() {
  mkdir -p "$INSTALL_DIR"

  if [[ "$MCP_MODE" == "serena" ]]; then
    ensure_serena
    local serena_bin
    serena_bin="$(command -v serena)"
    {
      echo '#!/usr/bin/env bash'
      echo 'set -Eeuo pipefail'
      printf 'exec %q start-mcp-server --context chatgpt --project %q --open-web-dashboard false\n' "$serena_bin" "$WORKSPACE"
    } > "$MCP_LAUNCHER"
  else
    ensure_node
    local npx_bin
    npx_bin="$(command -v npx)"
    {
      echo '#!/usr/bin/env bash'
      echo 'set -Eeuo pipefail'
      printf 'exec %q -y @modelcontextprotocol/server-filesystem %q\n' "$npx_bin" "$WORKSPACE"
    } > "$MCP_LAUNCHER"
  fi

  chmod 700 "$MCP_LAUNCHER"
  ok "สร้าง MCP launcher: $MCP_LAUNCHER"
}

init_profile() {
  mkdir -p "$PROFILE_DIR"
  export TUNNEL_CLIENT_PROFILE_DIR="$PROFILE_DIR"
  export CONTROL_PLANE_API_KEY="$RUNTIME_KEY"

  # สำรอง profile เดิมถ้ามี
  local profile_file="$PROFILE_DIR/$PROFILE_NAME.yaml"
  if [[ -f "$profile_file" ]]; then
    mv "$profile_file" "$profile_file.backup.$(date +%Y%m%d-%H%M%S)"
  fi

  info "สร้าง tunnel-client profile"
  "$BIN_DIR/tunnel-client" init \
    --sample sample_mcp_stdio_local \
    --profile "$PROFILE_NAME" \
    --tunnel-id "$TUNNEL_ID" \
    --mcp-command "$MCP_LAUNCHER"

  info "ตรวจระบบด้วย tunnel-client doctor"
  "$BIN_DIR/tunnel-client" doctor --profile "$PROFILE_NAME" --explain
  ok "Tunnel profile ผ่าน doctor"
}

write_start_script() {
  mkdir -p "$LOG_DIR"
  cat > "$START_SCRIPT" <<EOF
#!/usr/bin/env bash
set -Eeuo pipefail
INSTALL_DIR=$(printf '%q' "$INSTALL_DIR")
PROFILE_NAME=$(printf '%q' "$PROFILE_NAME")
export TUNNEL_CLIENT_PROFILE_DIR=$(printf '%q' "$PROFILE_DIR")
KEY_FILE=$(printf '%q' "$SECRET_DIR/runtime-api-key")
export CONTROL_PLANE_API_KEY="\$(cat "\$KEY_FILE")"
export MCP_CONNECTION_MAX_TTL="168h0m0s"
exec "\$INSTALL_DIR/bin/tunnel-client" run --profile "\$PROFILE_NAME" --mcp.connection-max-ttl 168h0m0s
EOF
  chmod 700 "$START_SCRIPT"
  ok "สร้าง start script: $START_SCRIPT"
}

install_service() {
  info "ตั้งให้ Tunnel รันอัตโนมัติ"

  if ! command -v systemctl >/dev/null 2>&1; then
    warn "เครื่องนี้ไม่มี systemd; จะไม่สร้าง service"
    echo "รันเองด้วย: $START_SCRIPT"
    return
  fi

  if [[ "$(id -u)" -eq 0 ]]; then
    local unit="/etc/systemd/system/chatgpt-mcp-tunnel.service"
    cat > "$unit" <<EOF
[Unit]
Description=OpenAI Secure MCP Tunnel - Local Workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKSPACE
ExecStart=$START_SCRIPT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable --now chatgpt-mcp-tunnel.service
    systemctl is-active --quiet chatgpt-mcp-tunnel.service || {
      systemctl --no-pager -l status chatgpt-mcp-tunnel.service || true
      die "service เริ่มไม่สำเร็จ"
    }
    ok "systemd service ทำงานแล้ว: chatgpt-mcp-tunnel.service"
  else
    local user_unit_dir="$HOME/.config/systemd/user"
    local unit="$user_unit_dir/chatgpt-mcp-tunnel.service"
    mkdir -p "$user_unit_dir"
    cat > "$unit" <<EOF
[Unit]
Description=OpenAI Secure MCP Tunnel - Local Workspace
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORKSPACE
ExecStart=$START_SCRIPT
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now chatgpt-mcp-tunnel.service
    systemctl --user is-active --quiet chatgpt-mcp-tunnel.service || {
      systemctl --user --no-pager -l status chatgpt-mcp-tunnel.service || true
      warn "user service ยังไม่ active; รันเองด้วย $START_SCRIPT"
      return
    }

    # ถ้ามี sudo ให้พยายามเปิด linger เพื่อให้ service อยู่ต่อหลัง logout
    if command -v loginctl >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
      sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || true
    fi
    ok "systemd user service ทำงานแล้ว: chatgpt-mcp-tunnel.service"
  fi
}

write_info_file() {
  cat > "$INSTALL_DIR/INSTALL-INFO.txt" <<EOF
ChatGPT Secure MCP Tunnel
=========================
Mode: $MCP_MODE
Workspace: $WORKSPACE
Tunnel ID: $TUNNEL_ID
Profile: $PROFILE_NAME
Install dir: $INSTALL_DIR

ChatGPT:
https://chatgpt.com/#settings/Connectors
เลือกสร้าง Developer-mode app แล้วเลือก Connection = Tunnel
จากนั้นเลือก Tunnel ID: $TUNNEL_ID

OpenAI Platform Tunnels:
https://platform.openai.com/settings/organization/tunnels

ตรวจสถานะ Linux:
  systemctl status chatgpt-mcp-tunnel.service
หรือ (ถ้าติดตั้งแบบ user service):
  systemctl --user status chatgpt-mcp-tunnel.service

ทดสอบ profile:
  export TUNNEL_CLIENT_PROFILE_DIR="$PROFILE_DIR"
  export CONTROL_PLANE_API_KEY="\$(cat "$SECRET_DIR/runtime-api-key")"
  "$BIN_DIR/tunnel-client" doctor --profile "$PROFILE_NAME" --explain
EOF
}

main() {
  clear 2>/dev/null || true
  echo "======================================================"
  echo " ChatGPT + Secure MCP Tunnel + Local Workspace Installer"
  echo "======================================================"
  echo
  echo "ต้องมีจาก OpenAI ก่อน:"
  echo "  - Tunnel ID"
  echo "  - Runtime API Key ที่มี Tunnels Read + Use"
  echo

  prompt_inputs

  mkdir -p "$INSTALL_DIR" "$PROFILE_DIR" "$SECRET_DIR" "$LOG_DIR" "$BIN_DIR"

  install_tunnel_client
  write_secret
  write_mcp_launcher
  init_profile
  write_start_script
  write_info_file
  install_service

  unset RUNTIME_KEY CONTROL_PLANE_API_KEY

  echo
  echo "======================================================"
  ok "ติดตั้งเสร็จ"
  echo "Mode      : $MCP_MODE"
  echo "Workspace : $WORKSPACE"
  echo "Tunnel ID : $TUNNEL_ID"
  echo
  echo "ขั้นตอนสุดท้ายใน ChatGPT:"
  echo "  1) เปิด https://chatgpt.com/#settings/Connectors"
  echo "  2) สร้าง Developer-mode app"
  echo "  3) Connection = Tunnel"
  echo "  4) เลือก/ใส่ $TUNNEL_ID"
  echo
  echo "จากนั้นลองสั่ง: \"ดูโครงสร้างโปรเจกต์ใน local workspace ของฉัน\""
  echo "======================================================"
}

main "$@"
