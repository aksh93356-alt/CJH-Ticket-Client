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
      const category = await ensureCategory(guild);
      channel = await guild.channels.create({
        name: cfg.panelChannelName || 'open-ticket',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: 'Open a support ticket using the button below.',
        permissionOverwrites: [
          { id: guild.id, type: OverwriteType.Role, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages] },
          { id: me.id, type: OverwriteType.Member, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.AttachFiles] },
        ],
        reason: 'CJH Ticket Client auto-setup',
      });
      log.info(`"${guild.name}": created #${channel.name}`);
    }
    await ensurePanel(guild, channel);
    log.info(`"${guild.name}": panel ready in #${channel.name}`);
  } catch (e) {
    log.error(`Setup failed in "${guild.name}": ${e.message}`);
  }
}

async function refreshPanels(client) {
  let n = 0;
  for (const [gid, g] of Object.entries(cfg.guilds)) {
    if (!g.panelChannelId) continue;
    const guild = client.guilds.cache.get(gid);
    if (!guild) continue;
    try {
      const ch = await guild.channels.fetch(g.panelChannelId).catch(() => null);
      if (!ch || ch.type !== ChannelType.GuildText) continue;
      await ensurePanel(guild, ch);
      n++;
    } catch (e) {
      log.warn(`Panel refresh failed in ${gid}: ${e.message}`);
    }
  }
  return n;
}

// ───────────────────────── Tickets ─────────────────────────
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);

async function buildTicketOverwrites(guild, openerId, botId) {
  const list = [
    { id: guild.id, type: OverwriteType.Role, deny: [P.ViewChannel] },
    { id: openerId, type: OverwriteType.Member, allow: TICKET_ALLOW },
    {
      id: botId, type: OverwriteType.Member,
      allow: [...TICKET_ALLOW, P.ManageChannels, P.EmbedLinks, P.AttachFiles],
    },
  ];
  if (cfg.ownerId && cfg.ownerId !== openerId && cfg.ownerId !== botId) {
    const m = await guild.members.fetch(cfg.ownerId).catch(() => null);
    if (m) list.push({ id: m.id, type: OverwriteType.Member, allow: TICKET_ALLOW });
  }
  for (const rid of cfg.staffRoleIds) {
    if (rid !== guild.id && guild.roles.cache.has(rid)) list.push({ id: rid, type: OverwriteType.Role, allow: TICKET_ALLOW });
  }
  return list;
}

async function openTicket(i) {
  await i.deferReply({ flags: EPHEMERAL });
  const { guild, user } = i;
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && parseTopic(c.topic)?.opener === user.id,
  );
  if (existing) return i.editReply(`❌ You already have an open ticket: ${existing}`);

  const me = await guild.members.fetchMe();
  const missing = me.permissions.missing(REQUIRED_PERMS);
  if (missing.length) return i.editReply(`❌ I'm missing permissions: ${missing.join(', ')}. Please tell an admin.`);

  const category = await ensureCategory(guild);
  const overwrites = await buildTicketOverwrites(guild, user.id, me.id);
  const channel = await guild.channels.create({
    name: `ticket-${slug(user.username) || user.id}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `CJH|opener:${user.id}|claimed:0`,
    permissionOverwrites: overwrites,
    reason: `Ticket opened by ${user.tag}`,
  });

  const roles = cfg.staffRoleIds.filter((r) => r !== guild.id && guild.roles.cache.has(r)).map((r) => `<@&${r}>`);
  const embed = new EmbedBuilder()
    .setColor(parseColor(cfg.panel.color))
    .setTitle('🎫 Ticket Opened')
    .setDescription(`Welcome ${user}! Please describe your issue and a staff member will assist you shortly.`)
    .setFooter({ text: 'CJH Ticket Client' })
    .setTimestamp();
  await channel.send({
    content: `${user} ${roles.join(' ')}`.trim(),
    embeds: [embed],
    components: [ticketControls(false)],
  });
  return i.editReply(`✅ Your ticket has been created: ${channel}`);
}

async function buildTranscript(channel, meta) {
  const all = [];
  let before;
  while (all.length < 5000) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const ts = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const lines = [
    '=== CJH Ticket Client Transcript ===',
    `Channel : #${channel.name} (${channel.id})`,
    `Server  : ${channel.guild.name}`,
    `Opener  : ${meta.opener}`,
    `Claimed : ${meta.claimed && meta.claimed !== '0' ? meta.claimed : 'no'}`,
    `Saved   : ${ts(Date.now())}`,
    `Messages: ${all.length}`,
    '====================================',
    '',
  ];
  for (const m of all) {
    let text = m.content || '';
    if (!text && !m.attachments.size && m.embeds.length) text = '[embed] ' + (m.embeds[0].title || m.embeds[0].description || '');
    lines.push(`[${ts(m.createdTimestamp)}] ${m.author.tag} (${m.author.id}): ${text}`);
    for (const a of m.attachments.values()) lines.push(`    [attachment] ${a.name}: ${a.url}`);
  }
  return lines.join('\n');
}

async function deleteWithTranscript(i) {
  const channel = i.channel;
  const meta = ticketMeta(channel);
  if (!meta) return i.reply({ content: '❌ This is not a ticket channel.', flags: EPHEMERAL });
  if (!isStaff(i.member)) return i.reply({ content: '⛔ Only staff can delete tickets.', flags: EPHEMERAL });
  await i.deferReply({ flags: EPHEMERAL });

  const text = await buildTranscript(channel, meta);
  fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const fileName = `${channel.name}-${Date.now()}.txt`;
  fs.writeFileSync(path.join(TRANSCRIPT_DIR, fileName), text);
  const mk = () => new AttachmentBuilder(Buffer.from(text, 'utf8'), { name: fileName });

  if (cfg.logChannelId) {
    const lc = await i.guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (lc && lc.isTextBased()) {
      await lc.send({ content: `📄 Transcript of **#${channel.name}** — deleted by ${i.user}`, files: [mk()] })
        .catch((e) => log.warn(`Log channel send failed: ${e.message}`));
    }
  }
  try {
    const opener = await i.client.users.fetch(meta.opener);
    await opener.send({ content: `📄 Here is the transcript of your ticket in **${i.guild.name}**.`, files: [mk()] });
  } catch { /* DMs closed */ }

  await i.editReply({ content: '✅ Transcript saved. Deleting this ticket in 5 seconds…', files: [mk()] });
  await channel.send('🗑️ This ticket will be deleted in 5 seconds…').catch(() => {});
  await sleep(5000);
  await channel.delete(`Ticket deleted by ${i.user.tag}`);
}

// ───────────────────────── Panel editor (/ticket edit) ─────────────────────────
function editorPayload(note) {
  const p = cfg.panel;
  const t = (s, n) => {
    s = String(s ?? '');
    return (s.length > n ? `${s.slice(0, n - 1)}…` : s) || '*(empty)*';
  };
  const embed = new EmbedBuilder()
    .setTitle('🛠️ Ticket Panel Editor')
    .setColor(parseColor(p.color))
    .setDescription('Changes are saved to `config.json` and the live panel updates instantly.')
    .addFields(
      { name: 'Title', value: t(p.title, 256) },
      { name: 'Description', value: t(p.description, 400) },
      { name: 'Color', value: t(p.color, 20), inline: true },
      { name: 'Footer', value: t(p.footer, 200), inline: true },
      { name: 'Button Label', value: t(p.buttonLabel, 80), inline: true },
      { name: 'Button Emoji', value: t(p.buttonEmoji, 60), inline: true },
      { name: 'Button Color', value: STYLE_LABELS[p.buttonStyle] || STYLE_LABELS.Primary, inline: true },
    );
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('edit_text').setLabel('Edit Text').setEmoji('✏️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('edit_look').setLabel('Edit Color & Button').setEmoji('🎨').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('edit_refresh').setLabel('Refresh Panel').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('edit_btncolor').setPlaceholder('Open Ticket button color')
      .addOptions(Object.keys(STYLE_MAP).map((k) => new StringSelectMenuOptionBuilder()
        .setLabel(STYLE_LABELS[k]).setValue(k).setDefault(cfg.panel.buttonStyle === k))),
  );
  return { content: note || '', embeds: [embed], components: [row1, row2] };
}

const input = (id, label, style, value, { max = 100, required = true, placeholder } = {}) => {
  const ti = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style)
    .setMaxLength(max).setRequired(required).setValue(String(value ?? '').slice(0, max));
  if (placeholder) ti.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(ti);
};

const textModal = () => new ModalBuilder().setCustomId('edit_text_modal').setTitle('Edit Panel Text').addComponents(
  input('title', 'Embed Title', TextInputStyle.Short, cfg.panel.title, { max: 256 }),
  input('description', 'Embed Description / Message', TextInputStyle.Paragraph, cfg.panel.description, { max: 4000 }),
  input('footer', 'Footer text (empty = none)', TextInputStyle.Short, cfg.panel.footer, { max: 256, required: false }),
);
const lookModal = () => new ModalBuilder().setCustomId('edit_look_modal').setTitle('Edit Color & Button').addComponents(
  input('color', 'Embed Hex Color (e.g. #5865F2)', TextInputStyle.Short, cfg.panel.color, { max: 7, placeholder: '#5865F2' }),
  input('label', 'Open Ticket Button Label', TextInputStyle.Short, cfg.panel.buttonLabel, { max: 80, required: false }),
  input('emoji', 'Button Emoji (🎫 or <:name:id>)', TextInputStyle.Short, cfg.panel.buttonEmoji, { max: 60, required: false }),
);

// ───────────────────────── Interaction handlers ─────────────────────────
const deny = (i, msg = '⛔ Only the bot owner can use this.') => i.reply({ content: msg, flags: EPHEMERAL });

async function onCommand(i) {
  switch (i.commandName) {
    case 'setup': {
      if (!isOwner(i.user.id)) return deny(i);
      await i.deferReply({ flags: EPHEMERAL });
      const target = i.options.getChannel('channel') || i.channel;
      const perms = target.permissionsFor(i.guild.members.me);
      if (!perms?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks])) {
        return i.editReply(`❌ I can't send embeds in ${target}.`);
      }
      const g = guildState(i.guild.id);
      if (g.panelChannelId && g.panelMessageId && g.panelChannelId !== target.id) {
        const old = await i.guild.channels.fetch(g.panelChannelId).catch(() => null);
        const oldMsg = old && (await old.messages.fetch(g.panelMessageId).catch(() => null));
        if (oldMsg) await oldMsg.delete().catch(() => {});
      }
      const msg = await target.send(buildPanel());
      g.panelChannelId = target.id;
      g.panelMessageId = msg.id;
      saveConfig();
      return i.editReply(`✅ Ticket panel sent to ${target}.`);
    }

    case 'staff': {
      if (!isOwner(i.user.id)) return deny(i);
      const sub = i.options.getSubcommand();
      if (sub === 'list') {
        const txt = cfg.staffRoleIds.length ? cfg.staffRoleIds.map((r) => `<@&${r}>`).join('\n') : '*No staff roles set.*';
        return i.reply({ content: `**Staff roles:**\n${txt}`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      }
      const role = i.options.getRole('role', true);
      if (role.id === i.guild.id) return i.reply({ content: '❌ You cannot use @everyone as a staff role.', flags: EPHEMERAL });
      if (sub === 'add') {
        if (cfg.staffRoleIds.includes(role.id)) return i.reply({ content: `ℹ️ ${role} is already a staff role.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
        cfg.staffRoleIds.push(role.id);
        saveConfig();
        return i.reply({ content: `✅ ${role} added. It will have access to all **new** tickets.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      }
      if (!cfg.staffRoleIds.includes(role.id)) return i.reply({ content: `ℹ️ ${role} is not a staff role.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
      cfg.staffRoleIds = cfg.staffRoleIds.filter((r) => r !== role.id);
      saveConfig();
      return i.reply({ content: `✅ ${role} removed from staff roles.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }

    case 'add':
    case 'remove': {
      const meta = ticketMeta(i.channel);
      if (!meta) return i.reply({ content: '❌ Use this command inside a ticket channel.', flags: EPHEMERAL });
      if (!isStaff(i.member)) return deny(i, '⛔ Only the owner or staff can use this.');
      const user = i.options.getUser('user', true);
      if (user.bot) return i.reply({ content: '❌ You cannot add/remove bots.', flags: EPHEMERAL });
      await i.deferReply();
      if (i.commandName === 'add') {
        const member = await i.guild.members.fetch(user.id).catch(() => null);
        if (!member) return i.editReply('❌ That user is not in this server.');
        await i.channel.permissionOverwrites.edit(user, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
        return i.editReply(`✅ ${user} was added to this ticket by ${i.user}.`);
      }
      if (user.id === meta.opener) return i.editReply('❌ You cannot remove the ticket opener.');
      await i.channel.permissionOverwrites.delete(user, `Removed by ${i.user.tag}`);
      return i.editReply(`✅ ${user} was removed from this ticket by ${i.user}.`);
    }

    case 'ticket': {
      if (!isOwner(i.user.id)) return deny(i);
      return i.reply({ ...editorPayload(), flags: EPHEMERAL });
    }
    default:
  }
}

async function onButton(i) {
  const id = i.customId;
  if (id === 'ticket_open') return openTicket(i);

  if (id.startsWith('edit_')) {
    if (!isOwner(i.user.id)) return deny(i);
    if (id === 'edit_text') return i.showModal(textModal());
    if (id === 'edit_look') return i.showModal(lookModal());
    if (id === 'edit_refresh') {
      await i.deferUpdate();
      const n = await refreshPanels(i.client);
      return i.editReply(editorPayload(`🔄 Refreshed ${n} panel(s).`));
    }
    return;
  }

  const meta = ticketMeta(i.channel);
  if (!meta) return i.reply({ content: '❌ This is not a ticket channel.', flags: EPHEMERAL });

  if (id === 'ticket_claim') {
    if (!isStaff(i.member)) return deny(i, '⛔ Only staff can claim tickets.');
    if (meta.claimed && meta.claimed !== '0') {
      return i.reply({ content: `ℹ️ Already claimed by <@${meta.claimed}>.`, flags: EPHEMERAL, allowedMentions: { parse: [] } });
    }
    await i.update({ components: [ticketControls(true)] });
    await i.channel.send({
      embeds: [new EmbedBuilder().setColor(0x57f287).setDescription(`✅ Ticket claimed by ${i.user}`)],
    });
    await i.channel.setTopic(`CJH|opener:${meta.opener}|claimed:${i.user.id}`).catch((e) => log.warn(`Topic update failed: ${e.message}`));
    return;
  }

  if (id === 'ticket_close') {
    if (i.user.id !== meta.opener && !isStaff(i.member)) return deny(i, '⛔ Only the ticket opener or staff can close this.');
    if (isClosed(i.channel, meta)) return i.reply({ content: 'ℹ️ This ticket is already closed.', flags: EPHEMERAL });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ticket_close_confirm').setLabel('Yes, close it').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ticket_close_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return i.reply({ content: '⚠️ Are you sure you want to close this ticket?', components: [row], flags: EPHEMERAL });
  }

  if (id === 'ticket_close_cancel') return i.update({ content: '❎ Close cancelled.', components: [] });

  if (id === 'ticket_close_confirm') {
    if (i.user.id !== meta.opener && !isStaff(i.member)) return deny(i, '⛔ Not allowed.');
    await i.deferUpdate();
    if (isClosed(i.channel, meta)) return i.editReply({ content: 'ℹ️ Already closed.', components: [] });
    const opener = await i.client.users.fetch(meta.opener).catch(() => null);
    if (opener) await i.channel.permissionOverwrites.edit(opener, { SendMessages: false }, { reason: `Closed by ${i.user.tag}` });
    await i.editReply({ content: '✅ Ticket closed.', components: [] });
    return i.channel.send({
      embeds: [new EmbedBuilder().setColor(0xed4245).setTitle('🔒 Ticket Closed')
        .setDescription(`Closed by ${i.user}.\nStaff can press **Delete / Transcript** to save a log and remove this channel.`)],
    });
  }

  if (id === 'ticket_delete') return deleteWithTranscript(i);
}

async function onSelect(i) {
  if (i.customId !== 'edit_btncolor') return;
  if (!isOwner(i.user.id)) return deny(i);
  await i.deferUpdate();
  const val = i.values[0];
  if (!STYLE_MAP[val]) return i.editReply(editorPayload('⚠️ Invalid color.'));
  cfg.panel.buttonStyle = val;
  saveConfig();
  const n = await refreshPanels(i.client);
  return i.editReply(editorPayload(`✅ Button color set to **${val}** — ${n} live panel(s) updated.`));
}

async function onModal(i) {
  if (!i.customId.startsWith('edit_')) return;
  if (!isOwner(i.user.id)) return deny(i);
  if (i.isFromMessage()) await i.deferUpdate(); else await i.deferReply({ flags: EPHEMERAL });
  const notes = [];

  if (i.customId === 'edit_text_modal') {
    cfg.panel.title = i.fields.getTextInputValue('title').trim() || DEFAULTS.panel.title;
    cfg.panel.description = i.fields.getTextInputValue('description').trim() || DEFAULTS.panel.description;
    cfg.panel.footer = i.fields.getTextInputValue('footer').trim();
  } else if (i.customId === 'edit_look_modal') {
    const color = i.fields.getTextInputValue('color').trim();
    if (isValidHex(color)) cfg.panel.color = `#${color.replace('#', '').toUpperCase()}`;
    else notes.push(`⚠️ \`${color}\` is not a valid hex color — kept ${cfg.panel.color}.`);

    cfg.panel.buttonLabel = i.fields.getTextInputValue('label').trim();
    const emoji = i.fields.getTextInputValue('emoji').trim();
    if (!emoji || isValidEmoji(emoji)) cfg.panel.buttonEmoji = emoji;
    else notes.push(`⚠️ \`${emoji}\` is not a valid emoji — kept ${cfg.panel.buttonEmoji || 'none'}.`);
    if (!cfg.panel.buttonLabel && !cfg.panel.buttonEmoji) {
      cfg.panel.buttonLabel = 'Open Ticket';
      notes.push('⚠️ A button needs a label or emoji — label reset to "Open Ticket".');
    }
  } else return;

  saveConfig();
  const n = await refreshPanels(i.client);
  notes.unshift(`✅ Saved — ${n} live panel(s) updated.`);
  return i.editReply(editorPayload(notes.join('\n')));
}

async function onInteraction(i) {
  try {
    if (!i.inGuild()) return;
    if (i.isChatInputCommand()) return await onCommand(i);
    if (i.isButton()) return await onButton(i);
    if (i.isStringSelectMenu()) return await onSelect(i);
    if (i.isModalSubmit()) return await onModal(i);
  } catch (e) {
    log.error(`Interaction error (${i.customId || i.commandName}):`, e);
    const msg = { content: `❌ Something went wrong: ${e.message}`, flags: EPHEMERAL };
    try {
      if (i.deferred || i.replied) await i.followUp(msg);
      else await i.reply(msg);
    } catch { /* ignore */ }
  }
}

// ───────────────────────── Client lifecycle ─────────────────────────
function makeClient(withContent) {
  const intents = [GatewayIntentBits.Guilds];
  if (withContent) intents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
  const client = new Client({ intents });
  client.messageContent = withContent;

  client.once(Events.ClientReady, async (c) => {
    log.info(`Online as ${c.user.tag} in ${c.guilds.cache.size} server(s).`);
    log.info(`Invite link: https://discord.com/oauth2/authorize?client_id=${c.user.id}&permissions=268553232&scope=bot%20applications.commands`);
    if (!c.messageContent) {
      log.warn('MESSAGE CONTENT INTENT is disabled: transcripts will not include message text. Enable it in Developer Portal → Bot → Privileged Gateway Intents, then restart.');
    }
    if (!c.guilds.cache.size) log.warn('The bot is not in any server yet. Use the invite link above.');
    for (const guild of c.guilds.cache.values()) await registerGuildCommands(guild);
    if (REGISTER_ONLY) {
      log.info('REGISTER_OK');
      await c.destroy();
      process.exit(0);
    }
    for (const guild of c.guilds.cache.values()) await setupGuild(guild);
  });

  client.on(Events.GuildCreate, async (guild) => {
    log.info(`Joined "${guild.name}"`);
    await registerGuildCommands(guild);
    await setupGuild(guild);
  });
  client.on(Events.InteractionCreate, onInteraction);
  client.on(Events.Error, (e) => log.error('Client error:', e.message));
  return client;
}

async function main() {
  cfg = loadConfig();
  if (!cfg.token || /YOUR_|BOT_TOKEN/i.test(cfg.token)) fatal('No bot token set. Put your token in config.json ("token").');
  if (!/^\d{15,25}$/.test(cfg.ownerId)) log.warn('ownerId is missing/invalid in config.json — owner-only commands are disabled.');
  if (!cfg.staffRoleIds.length) log.warn('No staff roles configured. Use /staff add <role> (owner only).');
  if (cfg.panel.color && !isValidHex(cfg.panel.color)) {
    log.warn(`Invalid panel color "${cfg.panel.color}" — using default.`);
    cfg.panel.color = DEFAULTS.panel.color;
  }

  let withContent = true;
  for (;;) {
    const client = makeClient(withContent);
    try {
      await client.login(cfg.token);
      return;
    } catch (e) {
      try { await client.destroy(); } catch { /* ignore */ }
      if (e?.code === 'DisallowedIntents') {
        if (withContent) {
          log.warn('MESSAGE CONTENT INTENT is not enabled in the Developer Portal — retrying without it (transcripts will lack message text).');
          withContent = false;
          continue;
        }
        fatal('A required intent is disabled for this bot. Check Developer Portal → Bot → Privileged Gateway Intents.');
      }
      if (e?.code === 'TokenInvalid' || /invalid token|an invalid token/i.test(e?.message || '')) {
        fatal('INVALID BOT TOKEN. Reset it in the Developer Portal → Bot → Reset Token, then update config.json.');
      }
      fatal(`Login failed: ${e?.message || e}`);
    }
  }
}

process.on('unhandledRejection', (e) => log.error('Unhandled rejection:', e));
process.on('uncaughtException', (e) => log.error('Uncaught exception:', e));
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main();
