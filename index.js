// Multi‑bot runner compatible with your Firebase admin panel
require('dotenv').config();

const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// 1) Firebase Admin init: set GOOGLE_APPLICATION_CREDENTIALS env to your service account JSON
admin.initializeApp({
credential: admin.credential.applicationDefault(),
databaseURL: process.env.FIREBASE_DB_URL
});

const rtdb = admin.database();

// In‑memory registry: botId -> { bot, chats: Map<string, boolean> }
const registry = new Map();

async function startBot(botId, token, chatsObj) {
if (!token) return;

// Stop old instance if any
await stopBot(botId);

const bot = new Telegraf(token);

// Build chat flags
const chatFlags = new Map();
if (chatsObj && typeof chatsObj === 'object') {
Object.entries(chatsObj).forEach(([cid, cfg]) => {
chatFlags.set(String(cid), !!(cfg && cfg.active));
});
}

// Approve join requests only if that chat is active
bot.on('chat_join_request', async (ctx) => {
try {
const chatId = ctx.chatJoinRequest.chat.id;
const userId = ctx.chatJoinRequest.from.id;
const allowed = chatFlags.get(String(chatId));
if (!allowed) return;
await ctx.telegram.approveChatJoinRequest(chatId, userId);
console.log([${botId}] approved user=${userId} chat=${chatId});
} catch (e) {
console.error([${botId}] approve error:, e);
}
});

// Simple liveness command
bot.command('ping', (ctx) => ctx.reply('pong'));

try {
await bot.launch();
console.log([${botId}] launched);
} catch (e) {
console.error([${botId}] launch failed:, e.message);
return;
}

registry.set(botId, { bot, chats: chatFlags });
}

async function stopBot(botId) {
const item = registry.get(botId);
if (!item) return;
try {
// stop() is sync in most Telegraf; this try/catch is defensive
item.bot.stop();
} catch (_) {}
registry.delete(botId);
console.log([${botId}] stopped);
}

// Watch one bot node for active/token/chats changes
function watchBotNode(botId) {
const baseRef = rtdb.ref(bots/${botId});

// Any change to the bot node
baseRef.on('value', async (snap) => {
const data = snap.val();
if (!data) {
await stopBot(botId);
return;
}
const token = data.token;
const active = !!data.active;
const chats = data.chats || {};
if (active) {
  await startBot(botId, token, chats);
} else {
  await stopBot(botId);
}
});

// Chats sub‑tree live updates without restarting bot
rtdb.ref(bots/${botId}/chats).on('value', (snap) => {
const entry = registry.get(botId);
if (!entry) return;
entry.chats.clear();
const val = snap.val() || {};
Object.entries(val).forEach(([cid, cfg]) => {
entry.chats.set(String(cid), !!(cfg && cfg.active));
});
console.log([${botId}] chats updated: ${entry.chats.size});
});
}

// Watch root for add/remove of bots
function watchBotsRoot() {
const root = rtdb.ref('bots');

root.on('child_added', (snap) => {
const botId = snap.key;
watchBotNode(botId);
});

root.on('child_removed', async (snap) => {
const botId = snap.key;
await stopBot(botId);
});

root.once('value').then((s) => {
console.log(Watching bots... found=${s.numChildren()});
});
}

// Graceful shutdown
async function shutdown() {
console.log('Shutting down…');
for (const botId of Array.from(registry.keys())) {
await stopBot(botId);
}
process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
watchBotsRoot();
const port = process.env.PORT || 3000;
// Optional health server (uncomment if needed)
// require('http').createServer((_, res) => { res.writeHead(200); res.end('OK'); }).listen(port);
console.log(Runner up on port ${port});
