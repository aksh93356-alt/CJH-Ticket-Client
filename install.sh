#!/usr/bin/env bash
# =============================================================================
#  CJH TICKET CLIENT - Interactive Installer (Ubuntu VPS)
#  Run:  curl -fsSL https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/CJH-Ticket-Client/main/install.sh | sudo bash
# =============================================================================
set -u

APP_NAME="cjh-ticket-bot"
INSTALL_DIR="/opt/cjh-ticket-bot"
REPO_URL="${CJH_REPO_URL:-https://github.com/YOUR_GITHUB_USERNAME/CJH-Ticket-Client.git}"
BRANCH="${CJH_BRANCH:-main}"
LOG_FILE="/tmp/cjh-installer.log"

# ── Colors ───────────────────────────────────────────────────────────────────
RED=$'\033[1;31m'; GREEN=$'\033[1;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[1;34m'; CYAN=$'\033[1;36m'; BOLD=$'\033[1m'; NC=$'\033[0m'

info() { printf "%s[..]%s %s\n" "$CYAN" "$NC" "$*"; }
ok()   { printf "%s[OK]%s %s\n" "$GREEN" "$NC" "$*"; }
warn() { printf "%s[!!]%s %s\n" "$YELLOW" "$NC" "$*"; }
err()  { printf "%s[XX]%s %s\n" "$RED" "$NC" "$*"; }

# ── Pre-flight ───────────────────────────────────────────────────────────────
if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  err "Please run as root:  curl -fsSL <URL>/install.sh | sudo bash"
  exit 1
fi
if ! : </dev/tty 2>/dev/null; then
  err "No interactive terminal (/dev/tty) available. Run this from an SSH session."
  exit 1
fi
if ! command -v apt-get >/dev/null 2>&1; then
  err "This installer supports Ubuntu/Debian (apt) only."
  exit 1
fi
export HOME="/root"
export PM2_HOME="/root/.pm2"
export DEBIAN_FRONTEND=noninteractive
export GIT_TERMINAL_PROMPT=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
: > "$LOG_FILE"

# ── Helpers ──────────────────────────────────────────────────────────────────
ask() {  # ask "Prompt: " VAR [silent]
  local prompt="$1" __var="$2" mode="${3:-}" val=""
  if [ "$mode" = "silent" ]; then
    read -r -s -p "$prompt" val </dev/tty
    echo
  else
    read -r -p "$prompt" val </dev/tty
  fi
  printf -v "$__var" '%s' "$val"
}

pause() { read -r -p "${BOLD}Press Enter to return to the menu...${NC}" _ </dev/tty; }

run() {  # run "Description" cmd args...
  local desc="$1"; shift
  info "$desc"
  if "$@" >>"$LOG_FILE" 2>&1; then
    ok "$desc"
    return 0
  fi
  err "$desc failed. Last log lines:"
  tail -n 15 "$LOG_FILE"
  return 1
}

pm2_ready() { command -v pm2 >/dev/null 2>&1; }
bot_online() {
  pm2_ready || return 1
  pm2 jlist 2>/dev/null | node -e '
    let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
      try { const l=d.split("\n").find(x=>x.trim().startsWith("["));
        const p=JSON.parse(l).find(x=>x.name==="cjh-ticket-bot");
        process.exit(p && p.pm2_env.status==="online" ? 0 : 1);
      } catch(e) { process.exit(1); } });'
}
bot_exists() { pm2_ready && pm2 describe "$APP_NAME" >/dev/null 2>&1; }

# ── Dependencies ─────────────────────────────────────────────────────────────
install_deps() {
  run "Updating package lists" apt-get update -y || warn "apt update failed, continuing..."
  run "Installing curl, git, certificates" apt-get install -y curl git ca-certificates gnupg || return 1

  local need_node=1 major
  if command -v node >/dev/null 2>&1; then
    major="$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
    [ "${major:-0}" -ge 20 ] && need_node=0
  fi
  if [ "$need_node" -eq 1 ]; then
    run "Adding NodeSource repository (Node.js 20)" bash -c "curl -fsSL https://deb.nodesource.com/setup_20.x | bash -" || return 1
    run "Installing Node.js 20 + npm" apt-get install -y nodejs || return 1
  else
    ok "Node.js $(node -v) already installed"
  fi
  command -v npm >/dev/null 2>&1 || { err "npm not found after Node install."; return 1; }
  if ! pm2_ready; then
    run "Installing PM2 globally" npm install -g pm2 || return 1
  else
    ok "PM2 already installed"
  fi
  return 0
}

fetch_files() {
  rm -rf "$INSTALL_DIR"
  if run "Downloading CJH Ticket Client from GitHub" git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"; then
    return 0
  fi
  # Fallback: running from a local clone of the repo
  if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/index.js" ] && grep -q "cjh-ticket-bot" "$SCRIPT_DIR/package.json" 2>/dev/null; then
    warn "Git clone failed - using local files from $SCRIPT_DIR"
    mkdir -p "$INSTALL_DIR" && cp -a "$SCRIPT_DIR"/. "$INSTALL_DIR"/ && return 0
  fi
  err "Could not download the bot. Check REPO_URL in install.sh (currently: $REPO_URL)"
  return 1
}

write_config() {  # token owner staff
  BOT_TOKEN="$1" OWNER_ID="$2" STAFF_ID="$3" APP_DIR="$INSTALL_DIR" node -e '
    const fs = require("fs"), path = require("path");
    const d = process.env.APP_DIR;
    const c = JSON.parse(fs.readFileSync(path.join(d, "config.example.json"), "utf8"));
    c.token = process.env.BOT_TOKEN;
    c.ownerId = process.env.OWNER_ID;
    c.staffRoleIds = process.env.STAFF_ID ? [process.env.STAFF_ID] : [];
    c.guilds = {};
    fs.writeFileSync(path.join(d, "config.json"), JSON.stringify(c, null, 2));
  ' && chmod 600 "$INSTALL_DIR/config.json"
}

# ── 1) Install ───────────────────────────────────────────────────────────────
do_install() {
  echo
  printf "%s=== Installing CJH Ticket Bot ===%s\n" "$BLUE" "$NC"

  if [ -d "$INSTALL_DIR" ]; then
    warn "An installation already exists at $INSTALL_DIR."
    ask "Reinstall (this wipes the old config)? [y/N]: " yn
    case "$yn" in y|Y|yes|YES) ;; *) info "Cancelled."; return ;; esac
    pm2_ready && pm2 delete "$APP_NAME" >/dev/null 2>&1
  fi

  install_deps || { err "Dependency installation failed."; return; }
  fetch_files  || return
  run "Installing npm packages" bash -c "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund" || return

  echo
  printf "%sCreate your bot at https://discord.com/developers/applications (Bot tab -> copy token).%s\n" "$YELLOW" "$NC"
  printf "%sEnable 'MESSAGE CONTENT INTENT' under Privileged Gateway Intents for full transcripts.%s\n\n" "$YELLOW" "$NC"

  local token owner staff attempt=0 out rc
  while :; do
    token=""
    while [ -z "$token" ]; do
      ask "Enter Bot Token: " token silent
      token="$(echo "$token" | tr -d '[:space:]')"
      [ -z "$token" ] && err "Token cannot be empty."
    done
    if [ -z "${owner:-}" ]; then
      while :; do
        ask "Enter Owner Discord ID: " owner
        owner="$(echo "$owner" | tr -d '[:space:]')"
        [[ "$owner" =~ ^[0-9]{15,25}$ ]] && break
        err "Invalid ID. It must be 15-25 digits (enable Developer Mode -> right-click user -> Copy User ID)."
      done
      while :; do
        ask "Enter Staff Role ID: " staff
        staff="$(echo "$staff" | tr -d '[:space:]')"
        [ -z "$staff" ] && { warn "No staff role set - add one later with /staff add."; break; }
        [[ "$staff" =~ ^[0-9]{15,25}$ ]] && break
        err "Invalid ID. It must be 15-25 digits."
      done
    fi

    write_config "$token" "$owner" "$staff" || { err "Could not write config.json"; return; }
    ok "config.json written"

    info "Validating token & registering slash commands..."
    out="$(cd "$INSTALL_DIR" && timeout 60 node index.js --register 2>&1)"; rc=$?
    echo "$out" | sed 's/^/    /'
    if [ $rc -eq 0 ]; then
      ok "Token valid, slash commands registered"
      break
    fi
    attempt=$((attempt + 1))
    err "Validation failed (see message above)."
    if [ $attempt -ge 3 ]; then
      err "Too many failed attempts. Fix the problem and choose option 1 again."
      return
    fi
    warn "Please re-enter the bot token."
  done

  pm2 delete "$APP_NAME" >/dev/null 2>&1
  run "Starting bot with PM2" bash -c "cd '$INSTALL_DIR' && pm2 start index.js --name $APP_NAME --exp-backoff-restart-delay=2000" || return
  pm2 startup systemd -u root --hp /root >>"$LOG_FILE" 2>&1 || warn "pm2 startup could not be configured (auto-start on reboot may not work)."
  pm2 save >>"$LOG_FILE" 2>&1 && ok "PM2 process list saved (auto-start on reboot)"

  info "Waiting for the bot to come online..."
  sleep 6
  echo
  if bot_online; then
    printf "%s*** CJH Ticket Bot is ONLINE ***%s\n" "$GREEN" "$NC"
  else
    err "Bot is not online yet. Recent logs:"
  fi
  pm2 logs "$APP_NAME" --lines 15 --nostream 2>/dev/null
  echo
  ok "Done! The bot is creating the ticket category/channel and posting the panel in your server."
  warn "If nothing appears, invite the bot using the 'Invite link' shown in the logs above."
}

# ── 2) Status ────────────────────────────────────────────────────────────────
do_status() {
  echo
  printf "%s=== Bot Status ===%s\n" "$BLUE" "$NC"
  if ! pm2_ready || ! bot_exists; then
    err "Bot is not installed / not registered in PM2. Choose option 1 to install."
    return
  fi
  pm2 jlist 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", c => d += c).on("end", () => {
      try {
        const line = d.split("\n").find(l => l.trim().startsWith("["));
        const p = JSON.parse(line).find(x => x.name === "cjh-ticket-bot");
        if (!p) return console.log("  Not found in PM2.");
        const up = p.pm2_env.status === "online" ? Date.now() - p.pm2_env.pm_uptime : 0;
        const s = Math.floor(up / 1000), f = `${Math.floor(s/86400)}d ${Math.floor(s%86400/3600)}h ${Math.floor(s%3600/60)}m ${s%60}s`;
        console.log(`  Status   : ${p.pm2_env.status.toUpperCase()}`);
        console.log(`  Uptime   : ${up ? f : "-"}`);
        console.log(`  Memory   : ${(p.monit.memory / 1048576).toFixed(1)} MB`);
        console.log(`  CPU      : ${p.monit.cpu}%`);
        console.log(`  Restarts : ${p.pm2_env.restart_time}`);
        console.log(`  PID      : ${p.pid || "-"}`);
      } catch (e) { console.log("  Could not parse PM2 status."); }
    });'
  echo
  printf "%s--- Last 15 log lines ---%s\n" "$CYAN" "$NC"
  pm2 logs "$APP_NAME" --lines 15 --nostream 2>/dev/null
}

# ── 3) Uninstall ─────────────────────────────────────────────────────────────
do_uninstall() {
  echo
  printf "%s=== Uninstall CJH Ticket Bot ===%s\n" "$RED" "$NC"
  if [ ! -d "$INSTALL_DIR" ] && ! bot_exists; then
    warn "Nothing to uninstall."
    return
  fi
  ask "This deletes $INSTALL_DIR and the PM2 process. Type 'yes' to confirm: " yn
  if [ "$yn" != "yes" ]; then info "Cancelled."; return; fi
  if pm2_ready; then
    pm2 stop "$APP_NAME" >/dev/null 2>&1
    pm2 delete "$APP_NAME" >/dev/null 2>&1
    pm2 save --force >/dev/null 2>&1
  fi
  [ -n "$INSTALL_DIR" ] && rm -rf "$INSTALL_DIR"
  ok "CJH Ticket Bot has been uninstalled."
}

# ── 4) Offline ───────────────────────────────────────────────────────────────
do_offline() {
  echo
  if ! bot_exists; then err "Bot is not installed / not in PM2."; return; fi
  if pm2 stop "$APP_NAME" >/dev/null 2>&1; then
    pm2 save >/dev/null 2>&1
    ok "Bot is now OFFLINE."
  else
    err "Failed to stop the bot."
  fi
}

# ── 5) Online ────────────────────────────────────────────────────────────────
do_online() {
  echo
  if bot_exists; then
    if bot_online; then
      pm2 restart "$APP_NAME" >/dev/null 2>&1 && info "Bot was running - restarted."
    else
      pm2 start "$APP_NAME" >/dev/null 2>&1
    fi
  elif [ -f "$INSTALL_DIR/index.js" ] && [ -f "$INSTALL_DIR/config.json" ]; then
    pm2_ready || { err "PM2 is not installed."; return; }
    (cd "$INSTALL_DIR" && pm2 start index.js --name "$APP_NAME" --exp-backoff-restart-delay=2000 >/dev/null 2>&1)
  else
    err "Bot is not installed. Choose option 1 first."
    return
  fi
  pm2 save >/dev/null 2>&1
  sleep 3
  if bot_online; then
    ok "Bot is back ONLINE."
  else
    err "Bot failed to start. Check logs via option 2."
  fi
}

# ── Menu ─────────────────────────────────────────────────────────────────────
show_menu() {
  clear 2>/dev/null || true
  printf "%s=========================================%s\n" "$CYAN" "$NC"
  printf "%s      CJH TICKET CLIENT - INSTALLER%s\n" "$BOLD" "$NC"
  printf "%s=========================================%s\n" "$CYAN" "$NC"
  printf "  %s1)%s Install CJH Ticket Bot (Free)\n" "$GREEN" "$NC"
  printf "  %s2)%s Bot Status\n" "$GREEN" "$NC"
  printf "  %s3)%s Uninstall Bot\n" "$GREEN" "$NC"
  printf "  %s4)%s Offline Bot (Stop)\n" "$GREEN" "$NC"
  printf "  %s5)%s Online Bot (Start)\n" "$GREEN" "$NC"
  printf "  %s6)%s Exit\n" "$GREEN" "$NC"
  printf "%s=========================================%s\n" "$CYAN" "$NC"
}

while true; do
  show_menu
  ask "Select an option [1-6]: " choice
  case "$choice" in
    1) do_install;   pause ;;
    2) do_status;    pause ;;
    3) do_uninstall; pause ;;
    4) do_offline;   pause ;;
    5) do_online;    pause ;;
    6) echo; ok "Goodbye!"; exit 0 ;;
    *) err "Invalid option."; sleep 1 ;;
  esac
done
