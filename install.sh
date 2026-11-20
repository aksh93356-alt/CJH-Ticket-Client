#!/usr/bin/env bash
# =============================================================================
#  CJH TICKET CLIENT - Interactive Installer (Ubuntu VPS)
#  Self-contained: all bot files are embedded in this script (no GitHub clone needed).
#  Run:  bash install.sh        (or host this file anywhere and: curl -fsSL <URL> | sudo bash)
# =============================================================================
set -u

APP_NAME="cjh-ticket-bot"
INSTALL_DIR="/opt/cjh-ticket-bot"
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
  err "Please run as root:  sudo bash install.sh"
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
  run "Installing curl, certificates" apt-get install -y curl ca-certificates gnupg || return 1

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

# ── Embedded bot files ───────────────────────────────────────────────────────
write_bot_files() {
  info "Creating bot files in $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
  mkdir -p "$INSTALL_DIR" || { err "Cannot create $INSTALL_DIR"; return 1; }
  cat > "$INSTALL_DIR/package.json" <<'CJH_PKG_EOF'
{
  "name": "cjh-ticket-bot",
  "version": "1.0.0",
  "description": "CJH Ticket Client - a Discord.js v14 ticket bot with auto-setup, staff roles and a live panel editor.",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "register": "node index.js --register"
  },
  "engines": {
    "node": ">=18.17.0"
  },
  "license": "MIT",
  "dependencies": {
    "discord.js": "^14.16.3",
    "dotenv": "^16.4.5"
  }
}
CJH_PKG_EOF
  cat > "$INSTALL_DIR/config.example.json" <<'CJH_CFG_EOF'
{
  "token": "YOUR_BOT_TOKEN_HERE",
  "ownerId": "123456789012345678",
  "staffRoleIds": ["123456789012345678"],
  "panelChannelId": "",
  "panelChannelName": "open-ticket",
  "categoryName": "CJH Tickets",
  "logChannelId": "",
  "botName": "",
  "panel": {
    "title": "🎫 CJH Ticket Client",
    "description": "Need help? Click the button below to open a private ticket.\n\nOur staff team will be with you shortly.",
    "color": "#5865F2",
    "footer": "CJH Ticket Client",
    "buttonLabel": "Open Ticket",
    "buttonEmoji": "🎫",
    "buttonStyle": "Primary"
  },
  "guilds": {}
}
CJH_CFG_EOF
  cat > "$INSTALL_DIR/index.js" <<'CJH_INDEX_EOF'
'use strict';
/**
 * CJH Ticket Client - Discord.js v14 ticket bot
 * Storage: config.json (settings) + channel topics (ticket state). No database needed.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits: P,
  ChannelType,
  MessageFlags,
  AttachmentBuilder,
  OverwriteType,
} = require('discord.js');

// ───────────────────────── Constants & helpers ─────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.json');
const TRANSCRIPT_DIR = path.join(__dirname, 'transcripts');
const REGISTER_ONLY = process.argv.includes('--register');
const DEFAULT_COLOR = 0x5865f2;
const EPHEMERAL = MessageFlags.Ephemeral;
const REQUIRED_PERMS = [
  P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles,
  P.ReadMessageHistory, P.ManageChannels, P.ManageRoles,
];
const TICKET_ALLOW = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory];

const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERROR]', ...a),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function fatal(msg) {
  console.error(`\n[FATAL] ${msg}\n`);
  process.exit(1);
}

// ───────────────────────── Config ─────────────────────────
const DEFAULTS = {
  token: '',
  ownerId: '',
  staffRoleIds: [],
  panelChannelId: '',
  panelChannelName: 'open-ticket',
  categoryName: 'CJH Tickets',
  logChannelId: '',
  botName: '',
  panel: {
    title: '🎫 CJH Ticket Client',
    description: 'Need help? Click the button below to open a private ticket.\n\nOur staff team will be with you shortly.',
    color: '#5865F2',
    footer: 'CJH Ticket Client',
    buttonLabel: 'Open Ticket',
    buttonEmoji: '🎫',
    buttonStyle: 'Primary',
  },
  guilds: {},
};

let cfg = null;
const fileSecrets = { token: '', ownerId: '' };

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fatal('config.json not found. Copy config.example.json to config.json and fill it in (or run install.sh).');
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    fatal(`config.json is not valid JSON: ${e.message}`);
  }
  fileSecrets.token = String(raw.token || '');
  fileSecrets.ownerId = String(raw.ownerId || '');
  const c = {
    ...DEFAULTS,
    ...raw,
    panel: { ...DEFAULTS.panel, ...(raw.panel || {}) },
    guilds: raw.guilds && typeof raw.guilds === 'object' ? raw.guilds : {},
  };
  c.token = String(c.token || process.env.DISCORD_TOKEN || '').trim();
  c.ownerId = String(c.ownerId || process.env.OWNER_ID || '').trim();
  c.staffRoleIds = Array.isArray(c.staffRoleIds)
    ? [...new Set(c.staffRoleIds.map(String).filter((x) => /^\d{15,25}$/.test(x)))]
    : [];
  return c;
}

function saveConfig() {
  const out = { ...cfg, token: fileSecrets.token, ownerId: fileSecrets.ownerId };
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  try { fs.chmodSync(CONFIG_PATH, 0o600); } catch { /* ignore */ }
}

const guildState = (id) => (cfg.guilds[id] ||= {});
const isOwner = (userId) => !!cfg.ownerId && String(userId) === cfg.ownerId;
function isStaff(member) {
  if (!member) return false;
  if (isOwner(member.id)) return true;
  return cfg.staffRoleIds.some((id) => member.roles?.cache?.has(id));
}

// ───────────────────────── Panel building ─────────────────────────
const isValidHex = (s) => /^#?[0-9a-f]{6}$/i.test(String(s || '').trim());
const parseColor = (s) => (isValidHex(s) ? parseInt(String(s).trim().replace('#', ''), 16) : DEFAULT_COLOR);
const EMOJI_RE = /^(<a?:\w{2,32}:\d{15,25}>|\p{Extended_Pictographic}[\p{Extended_Pictographic}\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]*)$/u;
const isValidEmoji = (s) => EMOJI_RE.test(String(s || '').trim());

const STYLE_MAP = {
  Primary: ButtonStyle.Primary,
  Secondary: ButtonStyle.Secondary,
  Success: ButtonStyle.Success,
  Danger: ButtonStyle.Danger,
};
const STYLE_LABELS = {
  Primary: '🔵 Primary (Blue)',
  Secondary: '⚪ Secondary (Grey)',
  Success: '🟢 Success (Green)',
  Danger: '🔴 Danger (Red)',
};

function buildPanel() {
  const p = cfg.panel;
  const embed = new EmbedBuilder()
    .setTitle(String(p.title || DEFAULTS.panel.title).slice(0, 256))
    .setDescription(String(p.description || DEFAULTS.panel.description).slice(0, 4096))
    .setColor(parseColor(p.color));
  if (p.footer && String(p.footer).trim()) embed.setFooter({ text: String(p.footer).slice(0, 2048) });

  const btn = new ButtonBuilder()
    .setCustomId('ticket_open')
    .setStyle(STYLE_MAP[p.buttonStyle] || ButtonStyle.Primary);
  const label = String(p.buttonLabel || '').trim().slice(0, 80);
  const emoji = isValidEmoji(p.buttonEmoji) ? String(p.buttonEmoji).trim() : null;
  if (label) btn.setLabel(label);
  if (emoji) btn.setEmoji(emoji);
  if (!label && !emoji) btn.setLabel('Open Ticket');
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] };
}

function ticketControls(claimed = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket_claim').setStyle(ButtonStyle.Success)
      .setLabel(claimed ? 'Claimed' : 'Claim Ticket').setEmoji('🙋').setDisabled(claimed),
    new ButtonBuilder().setCustomId('ticket_close').setStyle(ButtonStyle.Danger)
      .setLabel('Close Ticket').setEmoji('🔒'),
    new ButtonBuilder().setCustomId('ticket_delete').setStyle(ButtonStyle.Secondary)
      .setLabel('Delete / Transcript').setEmoji('🗑️'),
  );
}

// ───────────────────────── Ticket metadata (stored in channel topic) ─────────────────────────
function parseTopic(topic) {
  if (!topic || !topic.startsWith('CJH|')) return null;
  const o = {};
  for (const part of topic.split('|').slice(1)) {
    const i = part.indexOf(':');
    if (i > 0) o[part.slice(0, i)] = part.slice(i + 1);
  }
  return o.opener ? o : null;
}
const ticketMeta = (ch) => (ch && ch.type === ChannelType.GuildText ? parseTopic(ch.topic) : null);
const isClosed = (ch, meta) => !!ch.permissionOverwrites.cache.get(meta.opener)?.deny.has(P.SendMessages);

// ───────────────────────── Slash command definitions ─────────────────────────
const commands = [
  new SlashCommandBuilder().setName('setup').setDescription('Owner only: send the ticket panel to a channel')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel for the panel (default: this channel)')
      .addChannelTypes(ChannelType.GuildText))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('staff').setDescription('Owner only: manage staff roles for tickets')
    .addSubcommand((s) => s.setName('add').setDescription('Add a staff role')
      .addRoleOption((o) => o.setName('role').setDescription('Role to add').setRequired(true)))
    .addSubcommand((s) => s.setName('remove').setDescription('Remove a staff role')
      .addRoleOption((o) => o.setName('role').setDescription('Role to remove').setRequired(true)))
    .addSubcommand((s) => s.setName('list').setDescription('List staff roles'))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('add').setDescription('Add a user to this ticket (owner & staff)')
    .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a user from this ticket (owner & staff)')
    .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true))
    .setDMPermission(false),
  new SlashCommandBuilder().setName('ticket').setDescription('Ticket panel settings')
    .addSubcommand((s) => s.setName('edit').setDescription('Owner only: edit the ticket panel live'))
    .setDMPermission(false),
].map((c) => c.toJSON());

async function registerGuildCommands(guild) {
  try {
    await guild.commands.set(commands);
    return true;
  } catch (e) {
    log.warn(`Could not register commands in "${guild.name}": ${e.message} (re-invite the bot with the applications.commands scope)`);
    return false;
  }
}

// ───────────────────────── Auto setup ─────────────────────────
async function ensureCategory(guild) {
  const g = guildState(guild.id);
  let cat = g.categoryId ? guild.channels.cache.get(g.categoryId) : null;
  if (!cat || cat.type !== ChannelType.GuildCategory) {
    cat = guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === String(cfg.categoryName).toLowerCase(),
    );
  }
  if (!cat) {
    cat = await guild.channels.create({
      name: cfg.categoryName || 'CJH Tickets',
      type: ChannelType.GuildCategory,
      reason: 'CJH Ticket Client auto-setup',
    });
  }
  g.categoryId = cat.id;
  saveConfig();
  return cat;
}

function findPanelChannel(guild) {
  const g = guildState(guild.id);
  const isText = (c) => c && c.type === ChannelType.GuildText;
  for (const id of [cfg.panelChannelId, g.panelChannelId]) {
    if (id) {
      const c = guild.channels.cache.get(id);
      if (isText(c)) return c;
    }
  }
  const names = [cfg.panelChannelName, 'open-ticket', 'create-ticket'].filter(Boolean).map((n) => n.toLowerCase());
  return guild.channels.cache.find((c) => isText(c) && names.includes(c.name.toLowerCase())) || null;
}

async function ensurePanel(guild, channel) {
  const g = guildState(guild.id);
  const me = guild.members.me || (await guild.members.fetchMe());
  let msg = null;
  if (g.panelMessageId && g.panelChannelId === channel.id) {
    msg = await channel.messages.fetch(g.panelMessageId).catch(() => null);
  }
  if (!msg) {
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    msg = recent?.find((m) => m.author.id === me.id
      && m.components.some((r) => r.components?.some((c) => c.customId === 'ticket_open'))) || null;
  }
  const payload = buildPanel();
  msg = msg ? await msg.edit(payload) : await channel.send(payload);
  g.panelChannelId = channel.id;
  g.panelMessageId = msg.id;
  saveConfig();
  return msg;
}

async function setupGuild(guild) {
  try {
    const me = await guild.members.fetchMe();
    const missing = me.permissions.missing(REQUIRED_PERMS);
    if (missing.length) {
      log.warn(`"${guild.name}": missing permissions [${missing.join(', ')}]. Re-invite the bot using the invite link printed at startup.`);
      return;
    }
    await guild.channels.fetch();
    let channel = findPanelChannel(guild);
    if (!channel) {
      const category = await
