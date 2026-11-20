# 🎫 CJH Ticket Client

A production-ready **Discord.js v14** ticket bot with auto-setup, strict private ticket channels, staff roles, transcripts and a **live panel editor** — plus a one-command Ubuntu VPS installer (PM2).

## ⚡ One-line install (Ubuntu VPS)

> Replace `YOUR_GITHUB_USERNAME` with your GitHub username (also edit `REPO_URL` at the top of `install.sh`).

```bash
curl -fsSL https://raw.githubusercontent.com/aksh93356-alt/CJH-Ticket-Client/main/install.sh | sudo bash
```

Already root? You can also use:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/aksh93356-alt/CJH-Ticket-Client/main/install.sh)
```

Choose **1) Install CJH Ticket Bot (Free)**, then enter your Bot Token, Owner Discord ID and Staff Role ID. The bot goes online and builds the ticket category, `#open-ticket` channel and panel automatically.

## 🤖 Discord Developer Portal setup

1. Create an application → **Bot** tab → copy the token.
2. Under **Privileged Gateway Intents**, enable **Message Content Intent** (needed for message text in transcripts; the bot still runs without it, with a warning).
3. Invite the bot with the link printed in the logs (it requests: Manage Channels, Manage Roles, View/Send/Embed/Attach/Read History) using scopes `bot applications.commands`.
4. Make sure the bot's role is in the server (it does not need to be above staff roles).

## ✨ Features

- **Auto-setup on startup:** finds (or creates) the category + `#open-ticket` channel and posts the panel.
- **Private tickets:** `ticket-<username>` channels; `@everyone` hidden; only opener, Owner, staff roles and the bot can see/write.
- **Ticket controls:** Claim, Close (with confirmation), Delete/Transcript (saves `.txt` to `transcripts/`, sends it to you, the opener by DM and an optional log channel).
- **One open ticket per user.**
- **No database:** settings in `config.json`, ticket state in channel topics.

## 🧰 Slash commands

| Command | Who | What |
|---|---|---|
| `/setup [channel]` | Owner | Send / re-send the ticket panel |
| `/staff add <role>` / `/staff remove <role>` / `/staff list` | Owner | Manage staff roles for new tickets |
| `/add <user>` / `/remove <user>` | Owner + Staff | Add/remove a user in a ticket |
| `/ticket edit` | Owner | Edit title, description, color, footer, button label/emoji/color live |

## 🗂️ Files

```
CJH-Ticket-Client/
├── index.js
├── package.json
├── config.example.json
├── install.sh
├── .gitignore
└── README.md
```

## 🔧 Manual run

```bash
npm install
cp config.example.json config.json   # edit token / ownerId / staffRoleIds
node index.js
```

Optional `config.json` keys: `panelChannelId` (use an existing channel), `panelChannelName`, `categoryName`, `logChannelId` (transcript log channel).

## 🩺 Troubleshooting

- **Invalid token:** reset it in the Developer Portal and re-run option 1.
- **Slash commands missing:** re-invite with the `applications.commands` scope.
- **"Missing permissions" warning:** re-invite using the generated invite link.
- **Logs:** `pm2 logs cjh-ticket-bot` or installer option 2.
