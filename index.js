// index.js - Complete Twitter Monitoring Bot v13.0 (Final: All Fixes + Polish)
// 🚀 Features: Webhook/polling, custom retries, parallel fetches, persistence, UI, threads filter
// Deploy: Zeabur/Railway. Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, USERS_TO_MONITOR, WEBHOOK_URL=https://your-app.zeabur.app/bot
// Test: /start, add user, check now. Health: /health

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');
const helmet = require('helmet');

// ==========================================
// 0. CONFIG
// ==========================================
const config = {
  CACHE_TTL: parseInt(process.env.CACHE_TTL || '30000'),
  CHECK_INTERVAL_MIN: parseInt(process.env.CHECK_INTERVAL_MIN || '40000'),
  CHECK_INTERVAL_MAX: parseInt(process.env.CHECK_INTERVAL_MAX || '50000'),
  MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '5'), // Lower for stability
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3'),
  USERNAME_REGEX: /^[a-zA-Z0-9_]{1,15}$/,
  PORT: parseInt(process.env.PORT || '8080'),
  WEBHOOK_URL: process.env.WEBHOOK_URL || null // e.g., https://your-app.zeabur.app/bot
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

const app = express();
app.use(helmet());
app.use(express.json()); // Webhook body

// Bot init: Webhook preferred
const botOptions = config.WEBHOOK_URL ? { webHook: { port: config.PORT, path: '/bot' } } : { polling: true, dropPendingUpdates: true };
const bot = new TelegramBot(token, botOptions);

// Set webhook
if (config.WEBHOOK_URL) {
  bot.setWebHook(config.WEBHOOK_URL)
    .then(() => console.log('✅ Webhook set'))
    .catch(err => console.error('❌ Webhook fail:', err.message));
  app.post('/bot', (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
} else {
  console.log('⚠️ Polling mode (single instance only)');
}

// ==========================================
// 1. SMART CACHE
// ==========================================
class SmartCache {
  constructor(ttl = config.CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
    this.stats = { hits: 0, misses: 0 };
  }

  get(key) {
    const cached = this.cache.get(key);
    if (!cached || Date.now() - cached.timestamp > this.ttl) {
      this.stats.misses++;
      if (cached) this.cache.delete(key);
      return null;
    }
    this.stats.hits++;
    return cached.data;
  }

  set(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
    if (this.cache.size > 1000) {
      // GC oldest 20%
      const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp).slice(0, Math.floor(this.cache.size * 0.2));
      entries.forEach(([k]) => this.cache.delete(k));
    }
  }

  getStats() { return { ...this.stats, size: this.cache.size }; }
  clear() { this.cache.clear(); this.stats = { hits: 0, misses: 0 }; }
}

const cache = new SmartCache();

// ==========================================
// 2. HTTP SETUP
// ==========================================
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'
];

function getRandomAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

const axiosInstance = axios.create({
  timeout: 10000, // Increased for stability
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 20 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 20 }),
  headers: { 'User-Agent': getRandomAgent(), 'Cache-Control': 'no-cache' }
});

const parser = new Parser({ timeout: 10000 });

// ==========================================
// 3. NITTER
// ==========================================
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net', 'https://nitter.woodland.cafe', 'https://nitter.poast.org',
  'https://xcancel.com', 'https://nitter.soopy.moe', 'https://nitter.lucabased.xyz',
  'https://nitter.freereddit.com', 'https://nitter.moomoo.me', 'https://nitter.perennialteks.com',
  'https://nitter.no-logs.com', 'https://nitter.projectsegfau.lt', 'https://nitter.eu'
];

// ==========================================
// 4. PERSISTENCE
// ==========================================
const FILES = {
  cache: path.join(__dirname, 'tweet_cache.json'),
  users: path.join(__dirname, 'monitored_users.json'),
  state: path.join(__dirname, 'user_state.json')
};

function loadJson(file, defaultValue = null) {
  const fileDefault = defaultValue || (file === FILES.cache || file === FILES.users ? [] : {});
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Type checks
      if ((file === FILES.cache || file === FILES.users) && !Array.isArray(parsed)) {
        console.warn(`⚠️ Invalid ${path.basename(file)} (not array), resetting`);
        return fileDefault;
      }
      if (file === FILES.state && typeof parsed !== 'object') {
        console.warn(`⚠️ Invalid ${path.basename(file)} (not object), resetting`);
        return fileDefault;
      }
      return parsed;
    }
  } catch (e) {
    console.error(`❌ Load ${path.basename(file)} fail:`, e.message);
  }
  return fileDefault;
}

function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`❌ Save ${path.basename(file)} fail:`, e.message);
  }
}

let sentTweetIds = new Set(loadJson(FILES.cache, []));
const userBootstrapState = loadJson(FILES.state, {});
let usersToMonitor = loadJson(FILES.users, []);
if (!usersToMonitor.length) {
  usersToMonitor = (process.env.USERS_TO_MONITOR || '').split(',').map(u => u.trim().replace('@', '')).filter(Boolean);
}

// ==========================================
// 5. FETCH WITH CUSTOM RETRY
// ==========================================
async function retry(fn, retries = config.MAX_RETRIES, delay = 1000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries) throw err;
      console.warn(`⚠️ Fetch retry \( {i + 1}/ \){retries}: ${err.message}`);
      await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
    }
  }
}

async function fetchSotwe(username) {
  const key = `sotwe_${username}`;
  if (cache.get(key)) return cache.get(key);

  try {
    const { data } = await axiosInstance.get(`https://api.sotwe.com/v3/user/${username}`);
    if (data?.data?.length) {
      const items = data.data.filter(t => !t.in_reply_to_status_id_str).map(t => ({
        id: t.id_str,
        text: t.full_text || t.text,
        createdAt: new Date(t.created_at).getTime(),
        media: (t.entities?.media || []).map(m => m.media_url_https),
        source: 'Sotwe'
      }));
      const result = { source: 'Sotwe⚡', items };
      cache.set(key, result);
      return result;
    }
  } catch {}
  return null;
}

async function fetchNitter(username) {
  const key = `nitter_${username}`;
  if (cache.get(key)) return cache.get(key);

  const instances = [...NITTER_INSTANCES].sort(() => Math.random() - 0.5).slice(0, 5);
  for (const inst of instances) {
    try {
      const feed = await parser.parseURL(`\( {inst}/ \){username}/rss`);
      if (feed.items?.length) {
        const items = feed.items
          .filter(item => /\/status\/\d+/.test(item.link))
          .map(item => {
            const idMatch = item.link.match(/\/status\/(\d+)/);
            return {
              id: idMatch?.[1],
              text: item.contentSnippet || item.title || '',
              createdAt: new Date(item.pubDate).getTime(),
              media: [],
              source: 'Nitter'
            };
          });
        const result = { source: `Nitter (${new URL(inst).hostname})`, items };
        cache.set(key, result);
        return result;
      }
    } catch {}
  }
  return null;
}

async function fetchTweets(username) {
  return retry(async () => {
    let data = await fetchSotwe(username);
    if (data) return data;
    data = await fetchNitter(username);
    if (data) return data;
    throw new Error(`Failed for @${username}`);
  }).catch(err => {
    console.error(`❌ Fetch fail @${username}:`, err.message);
    return null;
  });
}

// ==========================================
// 6. CHECK LOOP
// ==========================================
let lastCheck = null;
let activity = 0;

async function checkFeeds(manual = false) {
  if (manual) console.log('⏩ Manual scan');
  lastCheck = Date.now();
  let newTweets = 0;

  const batches = [];
  for (let i = 0; i < usersToMonitor.length; i += config.MAX_CONCURRENT) {
    batches.push(usersToMonitor.slice(i, i + config.MAX_CONCURRENT));
  }

  for (const batch of batches) {
    const promises = batch.map(async user => {
      const tweets = await fetchTweets(user);
      if (!tweets) return 0;

      const isBootstrap = !userBootstrapState[user];
      const sorted = tweets.items.sort((a, b) => a.createdAt - b.createdAt);
      let count = 0;

      for (const tweet of sorted) {
        if (!tweet.id || sentTweetIds.has(tweet.id)) continue;

        if (isBootstrap) {
          sentTweetIds.add(tweet.id);
        } else {
          const link = `https://x.com/\( {user}/status/ \){tweet.id}`;
          const time = new Date(tweet.createdAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
          const text = (tweet.text || '').replace(/&amp;/g, '&').slice(0, 800);
          const caption = `<b>🐦 @\( {user}:</b>\n<code> \){tweets.source}</code>\n\n\( {text}\n\n⏰ \){time} • <a href="${link}">🔗</a>`;

          try {
            if (tweet.media?.[0]) {
              await bot.sendPhoto(chatId, tweet.media[0], { caption, parse_mode: 'HTML' }).catch(() => 
                bot.sendMessage(chatId, caption, { parse_mode: 'HTML' })
              );
            } else {
              await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
            }
            console.log(`🔔 New: @${user}`);
            sentTweetIds.add(tweet.id);
            count++;
            newTweets++;
            activity++;
          } catch (e) {
            console.error(`❌ Send fail @${user}:`, e.message);
          }
          await new Promise(r => setTimeout(r, 1000)); // Rate limit
        }
      }

      if (isBootstrap) {
        userBootstrapState[user] = true;
        console.log(`✅ Bootstrapped @${user}`);
      }
      return count;
    });
    await Promise.allSettled(promises);
  }

  // Persist
  if (newTweets || Object.keys(userBootstrapState).length) {
    saveJson(FILES.cache, Array.from(sentTweetIds).slice(-5000)); // Larger cache
    saveJson(FILES.state, userBootstrapState);
  }

  if (manual) {
    const stats = cache.getStats();
    const msg = `✅ Scan complete!\n🔔 New: \( {newTweets}\n💾 Cache: \){stats.hits}/\( {stats.misses} ( \){stats.size})`;
    await bot.sendMessage(chatId, msg, { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD.reply_markup });
  }
}

// ==========================================
// 7. UI
// ==========================================
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [['🔄 Check Now', '📋 List Users'], ['➕ Add User', '➖ Remove User'], ['🏥 Health', '/stats']],
    resize_keyboard: true
  }
};

const userStates = {};

function validateUser(name) {
  return config.USERNAME_REGEX.test(name);
}

bot.on('message', async msg => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const cid = msg.chat.id;

  if (text === '/cancel' || text === '❌ Cancel') {
    delete userStates[cid];
    return bot.sendMessage(cid, '❌ Cancelled', MAIN_KEYBOARD);
  }

  const inputUser = text.split(' ')[0].trim().replace('@', '');
  if (userStates[cid] === 'WAITING_ADD') {
    if (!validateUser(inputUser)) {
      return bot.sendMessage(cid, '⚠️ Invalid username: 1-15 chars, letters/numbers/_ only', {
        reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true }
      });
    }
    if (usersToMonitor.includes(inputUser)) {
      return bot.sendMessage(cid, `⚠️ @${inputUser} already monitored`, MAIN_KEYBOARD);
    }
    usersToMonitor.push(inputUser);
    saveJson(FILES.users, usersToMonitor);
    bot.sendMessage(cid, `✅ Added @${inputUser}. Scanning...`, { parse_mode: 'HTML' });
    const tweets = await fetchTweets(inputUser);
    if (tweets?.items?.length) {
      tweets.items.forEach(t => sentTweetIds.add(t.id));
      userBootstrapState[inputUser] = true;
      saveJson(FILES.cache, Array.from(sentTweetIds));
      saveJson(FILES.state, userBootstrapState);
      bot.sendMessage(cid, `✅ Cached ${tweets.items.length} tweets`, MAIN_KEYBOARD);
    }
    delete userStates[cid];
    return;
  }

  switch (text) {
    case '🔄 Check Now':
      bot.sendMessage(cid, '⚡ Scanning...', { parse_mode: 'HTML' });
      checkFeeds(true);
      break;
    case '📋 List Users':
      const list = usersToMonitor.map(u => `• @${u}`).join('\n') || 'None';
      bot.sendMessage(cid, `<b>📋 Monitored:</b>\n\n${list}`, { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD.reply_markup });
      break;
    case '➕ Add User':
      userStates[cid] = 'WAITING_ADD';
      bot.sendMessage(cid, '✍️ Enter username (e.g., elonmusk):', {
        reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true }
      });
      break;
    case '➖ Remove User':
      if (!usersToMonitor.length) return bot.sendMessage(cid, 'Empty list', MAIN_KEYBOARD);
      const buttons = usersToMonitor.slice(0, 10).map(u => [{ text: `🗑️ @\( {u}`, callback_data: `RM_ \){u}` }]);
      bot.sendMessage(cid, '👇 Select to remove:', { reply_markup: { inline_keyboard: buttons } });
      break;
    case '🏥 Health':
      const stats = cache.getStats();
      const up = process.uptime();
      const failRate = stats.misses / (stats.hits + stats.misses) * 100 || 0;
      const healthMsg = `<b>🏥 Health:</b>\nUsers: \( {usersToMonitor.length}\nCache: \){stats.size}\nHits/Misses: \( {stats.hits}/ \){stats.misses}\nFail Rate: \( {failRate.toFixed(1)}%\nUptime: \){Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m`;
      bot.sendMessage(cid, healthMsg, { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD.reply_markup });
      break;
    case '/stats':
      const statsMsg = `<b>📈 Stats:</b>\nUsers: \( {usersToMonitor.length}\nTracked Tweets: \){sentTweetIds.size}\nActivity: \( {activity}\nLast Scan: \){lastCheck ? new Date(lastCheck).toLocaleString() : 'N/A'}`;
      bot.sendMessage(cid, statsMsg, { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD.reply_markup });
      break;
    case '/start':
    case '/help':
      bot.sendMessage(cid, `<b>⚡ X Monitor Bot v13.0</b>\n\nMonitor users for new posts via Telegram.\n\nCommands:\n• 🔄 Check Now\n• 📋 List Users\n• ➕ Add User\n• ➖ Remove User\n• 🏥 Health\n• /stats\n\n<i>Unofficial; fair use only.</i>`, { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD.reply_markup });
      break;
  }
});

bot.on('callback_query', query => {
  if (query.data.startsWith('RM_')) {
    const user = query.data.slice(3);
    const idx = usersToMonitor.indexOf(user);
    if (idx > -1) {
      usersToMonitor.splice(idx, 1);
      delete userBootstrapState[user];
      saveJson(FILES.users, usersToMonitor);
      saveJson(FILES.state, userBootstrapState);
      bot.answerCallbackQuery(query.id, { text: `Removed @${user}` });
      bot.sendMessage(query.message.chat.id, `❌ Removed @${user}`, { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD.reply_markup });
    }
  }
});

// ==========================================
// 8. HEALTH
// ==========================================
app.get('/health', (req, res) => {
  const stats = cache.getStats();
  const up = process.uptime();
  const failRate = stats.misses / (stats.hits + stats.misses) * 100 || 0;
  res.json({
    status: 'ok',
    version: '13.0',
    mode: config.WEBHOOK_URL ? 'Webhook' : 'Polling',
    users: usersToMonitor.length,
    cache: stats,
    tweets: sentTweetIds.size,
    uptime: `\( {Math.floor(up/3600)}h \){Math.floor((up%3600)/60)}m`,
    lastCheck: lastCheck ? new Date(lastCheck).toISOString() : null,
    failRate: `${failRate.toFixed(1)}%`
  });
});

app.listen(config.PORT, '0.0.0.0', () => console.log(`🏥 Server on ${config.PORT}`));

// ==========================================
// 9. STARTUP
// ==========================================
console.log('🚀 Booting v13.0...');
console.log(`📊 Users: ${usersToMonitor.join(', ') || 'None'}`);

// Initial
setTimeout(checkFeeds, 5000);

// Loop
const loop = () => {
  checkFeeds();
  const interval = Math.max(20000, config.CHECK_INTERVAL_MIN + (activity > 5 ? -10000 : 0) + Math.random() * (config.CHECK_INTERVAL_MAX - config.CHECK_INTERVAL_MIN));
  activity = Math.max(0, activity - 1);
  setTimeout(loop, interval);
};
setTimeout(loop, 10000);

// ==========================================
// 10. SHUTDOWN
// ==========================================
process.on('SIGINT', async () => {
  console.log('\n⏹️ Graceful shutdown...');
  if (config.WEBHOOK_URL) await bot.deleteWebHook();
  saveJson(FILES.cache, Array.from(sentTweetIds));
  saveJson(FILES.state, userBootstrapState);
  saveJson(FILES.users, usersToMonitor);
  console.log('✅ Saved');
  process.exit(0);
});
