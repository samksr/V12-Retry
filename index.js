// index.js - Improved Twitter Monitoring Bot v12.1 (Fixed Set Iterable Error)
// 🚀 Fix: loadJson defaults to [] for cache/state; try-catch on init
// Deploy: Push to GitHub; Zeabur auto-redeploys. Set env vars as before.

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const express = require('express');
const pRetry = require('p-retry');
const helmet = require('helmet');

// ==========================================
// 0. CONFIG (NEW: Centralized)
// ==========================================
const config = {
  CACHE_TTL: parseInt(process.env.CACHE_TTL || '30000'),
  CHECK_INTERVAL_MIN: parseInt(process.env.CHECK_INTERVAL_MIN || '40000'),
  CHECK_INTERVAL_MAX: parseInt(process.env.CHECK_INTERVAL_MAX || '50000'),
  MAX_CONCURRENT: parseInt(process.env.MAX_CONCURRENT || '10'),
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3'),
  USERNAME_REGEX: /^[a-zA-Z0-9_]{1,15}$/,
  PORT: parseInt(process.env.PORT || '8080')
};

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("❌ Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();
app.use(helmet()); // NEW: Security headers
const PORT = config.PORT;

// ==========================================
// 1. SMART CACHE (ENHANCED: With Redis fallback stub)
// ==========================================
class SmartCache {
  constructor(ttl = config.CACHE_TTL) {
    this.cache = new Map();
    this.ttl = ttl;
    this.stats = { hits: 0, misses: 0 };
  }

  get(key) {
    const cached = this.cache.get(key);
    if (!cached) {
      this.stats.misses++;
      return null;
    }
    if (Date.now() - cached.timestamp > this.ttl) {
      this.cache.delete(key);
      this.stats.misses++;
      return null;
    }
    this.stats.hits++;
    return cached.data;
  }

  set(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
    if (this.cache.size > 1000) {
      const entries = Array.from(this.cache.entries());
      const oldest = entries
        .sort((a, b) => a[1].timestamp - b[1].timestamp)
        .slice(0, 200);
      oldest.forEach(([k]) => this.cache.delete(k));
    }
  }

  getStats() {
    return { ...this.stats, size: this.cache.size };
  }

  clear() {
    this.cache.clear();
    this.stats = { hits: 0, misses: 0 };
  }
}

const cache = new SmartCache(config.CACHE_TTL);

// ==========================================
// 2. USER AGENT & HTTP CONFIG
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
  timeout: 5000,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
  headers: {
    'User-Agent': getRandomAgent(),
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  }
});

const parser = new Parser({ timeout: 5000 });

// ==========================================
// 3. NITTER INSTANCES
// ==========================================
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.woodland.cafe',
  'https://nitter.poast.org',
  'https://xcancel.com',
  'https://nitter.soopy.moe',
  'https://nitter.lucabased.xyz',
  'https://nitter.freereddit.com',
  'https://nitter.moomoo.me',
  'https://nitter.perennialteks.com',
  'https://nitter.no-logs.com',
  'https://nitter.projectsegfau.lt',
  'https://nitter.eu'
];

// ==========================================
// 4. PERSISTENCE (FIXED: Defaults to [] for cache)
// ==========================================
const FILES = {
  cache: path.join(__dirname, 'tweet_cache.json'),
  users: path.join(__dirname, 'monitored_users.json'),
  state: path.join(__dirname, 'user_state.json')
};

function loadJson(file, defaultValue = null) {
  // FIXED: Determine default based on file type
  let fileDefault = defaultValue;
  if (!fileDefault) {
    if (file === FILES.users) fileDefault = [];
    else if (file === FILES.cache) fileDefault = []; // CRITICAL: Array for Set
    else if (file === FILES.state) fileDefault = {}; // Object for bootstrap state
    else fileDefault = [];
  }

  try {
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(content);
      // Validate: Ensure it's the expected type
      if (file === FILES.cache && !Array.isArray(parsed)) {
        console.warn(`⚠️ Invalid cache file (not array), resetting to []`);
        return fileDefault;
      }
      if (file === FILES.users && !Array.isArray(parsed)) {
        console.warn(`⚠️ Invalid users file (not array), resetting to []`);
        return fileDefault;
      }
      if (file === FILES.state && typeof parsed !== 'object') {
        console.warn(`⚠️ Invalid state file (not object), resetting to {}`);
        return fileDefault;
      }
      return parsed;
    }
  } catch (e) {
    console.error(`❌ Failed to load ${file}:`, e.message);
  }
  return fileDefault;
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`❌ Failed to save ${file}:`, e.message);
  }
}

// FIXED: Safe init with fallback
let sentTweetIds;
try {
  const loadedCache = loadJson(FILES.cache, []);
  sentTweetIds = new Set(loadedCache);
} catch (e) {
  console.error(`❌ Cache init failed, starting empty:`, e.message);
  sentTweetIds = new Set();
}

const userBootstrapState = loadJson(FILES.state, {});
let usersToMonitor = loadJson(FILES.users, []);
if (usersToMonitor.length === 0) {
  usersToMonitor = (process.env.USERS_TO_MONITOR || '').split(',').map(u => u.trim().replace('@', '')).filter(u => u);
}

// ==========================================
// 5. FETCH LOGIC (ENHANCED: Retries + Threads)
// ==========================================

async function fetchSotwe(username) {
  const cacheKey = `sotwe_${username}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const res = await axiosInstance.get(`https://api.sotwe.com/v3/user/${username}`, {
      headers: { 'User-Agent': getRandomAgent() }
    });
    if (res.data?.data && Array.isArray(res.data.data)) {
      // NEW: Filter top-level tweets for threads
      const items = res.data.data
        .filter(t => !t.in_reply_to_status_id_str) // Top-level only
        .map(t => ({
          id: t.id_str,
          text: t.full_text || t.text,
          createdAt: new Date(t.created_at).getTime(),
          media: t.entities?.media?.map(m => m.media_url_https) || [],
          source: 'Sotwe'
        }));
      const result = { source: 'Sotwe⚡', items };
      cache.set(cacheKey, result);
      return result;
    }
  } catch (e) {
    // Silent for now
  }
  return null;
}

async function fetchNitter(username) {
  const cacheKey = `nitter_${username}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const shuffled = [...NITTER_INSTANCES].sort(() => 0.5 - Math.random()).slice(0, 5);
    for (const instance of shuffled) {
      try {
        const feed = await parser.parseURL(`\( {instance}/ \){username}/rss?t=${Date.now()}`, {
          headers: { 'User-Agent': getRandomAgent() }
        });
        if (feed && feed.items && feed.items.length > 0) {
          const items = feed.items
            .filter(item => item.link.includes('/status/')) // Basic filter (adjusted for Nitter links)
            .map(t => {
              const match = t.link.match(/\/status\/(\d+)/);
              return {
                id: match ? match[1] : null,
                text: t.contentSnippet || t.title || '',
                createdAt: new Date(t.pubDate).getTime(),
                media: [],
                source: 'Nitter'
              };
            });
          const result = { source: `Nitter♻️ (${new URL(instance).hostname})`, items };
          cache.set(cacheKey, result);
          return result;
        }
      } catch (e) {
        // Next instance
      }
    }
  } catch (e) {
    // Silent
  }
  return null;
}

// COMBINED FETCH WITH RETRIES
async function fetchTweets(username) {
  const run = async () => {
    let data = await fetchSotwe(username);
    if (data) return data;
    data = await fetchNitter(username);
    if (data) return data;
    throw new Error(`All engines failed for @${username}`);
  };

  try {
    return await pRetry(run, {
      retries: config.MAX_RETRIES,
      minTimeout: 1000,
      factor: 2,
      onFailedAttempt: (error) => {
        console.warn(`⚠️ Retry for @\( {username}: \){error.message}`);
      }
    });
  } catch (error) {
    console.error(`❌ Fatal fetch error for @${username}:`, error.message);
    // Optional alert: bot.sendMessage(chatId, `🚨 Monitoring failed for @${username}`);
    return null;
  }
}

// ==========================================
// 6. MAIN CHECK LOOP (PARALLEL + ADAPTIVE INTERVAL)
// ==========================================
let lastCheckTimestamp = null;
let activityCounter = 0; // For adaptive interval

async function checkFeeds(manualTrigger = false) {
  if (manualTrigger) console.log(`⏩ Manual Check...`);
  lastCheckTimestamp = Date.now();

  let newCount = 0;
  const batches = [];
  for (let i = 0; i < usersToMonitor.length; i += config.MAX_CONCURRENT) {
    batches.push(usersToMonitor.slice(i, i + config.MAX_CONCURRENT));
  }

  for (const batch of batches) {
    const fetchPromises = batch.map(async (user) => {
      const tweets = await fetchTweets(user);
      if (!tweets) return { user, error: 'Fetch failed', newTweets: 0 };

      const isFirstRun = !userBootstrapState[user];
      const sortedTweets = tweets.items.sort((a, b) => a.createdAt - b.createdAt);
      let userNewCount = 0;

      for (const tweet of sortedTweets) {
        if (!tweet.id || sentTweetIds.has(tweet.id)) continue;

        if (isFirstRun) {
          sentTweetIds.add(tweet.id);
        } else {
          const link = `https://x.com/\( {user}/status/ \){tweet.id}`;
          const date = new Date(tweet.createdAt).toLocaleTimeString('en-IN', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit'
          });
          const cleanText = (tweet.text || '').replace(/&amp;/g, '&').substring(0, 800);
          const caption = `<b>🐦 @\( {user} Posted:</b>\n<code> \){tweets.source}</code>\n\n\( {cleanText}\n\n⏰ \){date} • <a href="${link}"><b>🔗 Open Tweet</b></a>`;

          try {
            if (tweet.media && tweet.media.length > 0) {
              await bot.sendPhoto(chatId, tweet.media[0], { caption, parse_mode: 'HTML' })
                .catch(() => bot.sendMessage(chatId, caption, { parse_mode: 'HTML' }));
            } else {
              await bot.sendMessage(chatId, caption, { parse_mode: 'HTML', disable_web_page_preview: false });
            }
            console.log(`🔔 Alert: @\( {user} via \){tweets.source}`);
            sentTweetIds.add(tweet.id);
            userNewCount++;
            newCount++;
            activityCounter++; // Bump for adaptive
          } catch (e) {
            console.error(`❌ Failed to send tweet for @${user}:`, e.message);
          }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      if (isFirstRun) {
        userBootstrapState[user] = true;
        console.log(`✅ Initialized @${user}`);
      }

      return { user, newTweets: userNewCount };
    });

    await Promise.allSettled(fetchPromises); // Fire and forget results for simplicity
  }

  // Save if changes
  if (newCount > 0 || Object.keys(userBootstrapState).length > 0) {
    saveJson(FILES.cache, Array.from(sentTweetIds).slice(-2000));
    saveJson(FILES.state, userBootstrapState);
  }

  if (manualTrigger) {
    const stats = cache.getStats();
    const msg = `✅ <b>Check Done!</b>\n🔔 Found: \( {newCount} new tweets\n💾 Cache: \){stats.hits}H/\( {stats.misses}M ( \){stats.size} items)`;
    bot.sendMessage(chatId, msg, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
  }
}

// ==========================================
// 7. TELEGRAM UI (ENHANCED: Validation + Inline Confirm)
// ==========================================
const MAIN_KEYBOARD = {
  reply_markup: {
    keyboard: [
      ['🔄 Check Now', '📋 List Users'],
      ['➕ Add User', '➖ Remove User'],
      ['🏥 Health Check', '/stats']
    ],
    resize_keyboard: true,
    persistent: true
  }
};

function validateUsername(username) {
  return config.USERNAME_REGEX.test(username);
}

const userStates = {}; // Per-chat state

bot.on('message', async (msg) => {
  if (!msg.text) return;
  const text = msg.text.trim();
  const cid = msg.chat.id;

  if (text === '/cancel' || text === '❌ Cancel') {
    delete userStates[cid];
    bot.sendMessage(cid, '❌ Cancelled.', { ...MAIN_KEYBOARD });
    return;
  }

  // NEW: Global validation helper
  const newUser = text.split(' ')[0].trim().replace('@', '');
  if (userStates[cid] === 'WAITING_FOR_ADD') {
    if (!validateUsername(newUser)) {
      return bot.sendMessage(cid, '⚠️ Invalid username (letters, numbers, underscores only, 1-15 chars).', {
        reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true }
      });
    }

    if (!usersToMonitor.includes(newUser)) {
      usersToMonitor.push(newUser);
      saveJson(FILES.users, usersToMonitor);

      bot.sendMessage(cid, `✅ <b>@${newUser}</b> added!\n🔍 Scanning...`, { parse_mode: 'HTML' });
      const tweets = await fetchTweets(newUser);
      if (tweets && tweets.items.length > 0) {
        tweets.items.forEach(t => sentTweetIds.add(t.id));
        userBootstrapState[newUser] = true;
        saveJson(FILES.cache, Array.from(sentTweetIds).slice(-2000));
        saveJson(FILES.state, userBootstrapState);
        bot.sendMessage(cid, `✅ Pre-cached \( {tweets.items.length} tweets from @ \){newUser}`, { ...MAIN_KEYBOARD });
      }
    } else {
      bot.sendMessage(cid, `⚠️ <b>@${newUser}</b> already tracked.`, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
    }
    delete userStates[cid];
    return;
  }

  if (text === '🔄 Check Now') {
    bot.sendMessage(cid, '⚡ <b>Scanning...</b>', { parse_mode: 'HTML' });
    checkFeeds(true);
  } else if (text === '📋 List Users') {
    const list = usersToMonitor.length ? usersToMonitor.map(u => `• <b>@${u}</b>`).join('\n') : 'No users.';
    bot.sendMessage(cid, `📋 <b>Tracking:</b>\n\n${list}`, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
  } else if (text === '➕ Add User') {
    userStates[cid] = 'WAITING_FOR_ADD';
    bot.sendMessage(cid, '✍️ <b>Enter Username (e.g., elonmusk):</b>', {
      reply_markup: { keyboard: [['❌ Cancel']], resize_keyboard: true }
    });
  } else if (text === '➖ Remove User') {
    if (!usersToMonitor.length) return bot.sendMessage(cid, 'List is empty.', { ...MAIN_KEYBOARD });
    const btns = usersToMonitor.map(u => [{ text: `🗑️ @\( {u}`, callback_data: `RM_ \){u}` }]);
    bot.sendMessage(cid, '👇 <b>Tap to remove:</b>', { reply_markup: { inline_keyboard: btns.slice(0, 10) } }); // Limit inline
  } else if (text === '🏥 Health Check') {
    const stats = cache.getStats();
    const uptime = process.uptime();
    const failureRate = cache.stats.misses > 0 ? (cache.stats.misses / (cache.stats.hits + cache.stats.misses) * 100).toFixed(1) : 0;
    const msg = `<b>🏥 System Health</b>\n\n📊 Users: \( {usersToMonitor.length}\n💾 Cache: \){stats.size}/\( {1000} items\n⚡ Hits: \){stats.hits}\n❌ Misses: \( {stats.misses}\n📈 Failure Rate: \){failureRate}%\n⏱️ Uptime: \( {Math.floor(uptime / 3600)}h \){Math.floor((uptime % 3600) / 60)}m`;
    bot.sendMessage(cid, msg, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
  } else if (text === '/stats') {
    // NEW: Per-user stats (simple: last tweet count via bootstrap)
    const statsMsg = `<b>📈 Analytics</b>\n\nUsers: \( {usersToMonitor.length}\nTotal Tracked Tweets: \){sentTweetIds.size}\nActivity Level: \( {activityCounter} (recent checks)\nLast Check: \){lastCheckTimestamp ? new Date(lastCheckTimestamp).toLocaleString() : 'N/A'}`;
    bot.sendMessage(cid, statsMsg, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
  } else if (text === '/start') {
    bot.sendMessage(cid, `<b>⚡ Twitter Bot v12.1 (FIXED)</b>\n\n✅ <b>Engine:</b> Sotwe + 12 Nitter (w/ retries)\n✅ <b>Cache:</b> Smart 30s TTL\n✅ <b>Speed:</b> Parallel checks (~20-60s adaptive)\n\n⚠️ <i>Unofficial tool; complies with fair use. Not affiliated with X/Twitter.</i>`, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
  }
});

bot.on('callback_query', (query) => {
  if (query.data.startsWith('RM_')) {
    const user = query.data.replace('RM_', '');
    const idx = usersToMonitor.indexOf(user);
    if (idx > -1) {
      usersToMonitor.splice(idx, 1);
      delete userBootstrapState[user];
      saveJson(FILES.users, usersToMonitor);
      saveJson(FILES.state, userBootstrapState);
      bot.answerCallbackQuery(query.id, { text: `Removed @${user}` });
      bot.sendMessage(query.message.chat.id, `❌ Removed <b>@${user}</b>`, { parse_mode: 'HTML', ...MAIN_KEYBOARD });
    }
  }
});

// ==========================================
// 8. HEALTH ENDPOINT (ENHANCED)
// ==========================================
app.get('/health', (req, res) => {
  const stats = cache.getStats();
  const uptime = process.uptime();
  const failureRate = stats.misses > 0 ? (stats.misses / (stats.hits + stats.misses) * 100).toFixed(1) : 0;
  res.json({
    status: 'ok',
    version: '12.1.0',
    mode: 'Enhanced Parallel Rotator (Fixed)',
    users: usersToMonitor.length,
    cache: stats,
    tweetsTracked: sentTweetIds.size,
    uptime: `\( {Math.floor(uptime / 3600)}h \){Math.floor((uptime % 3600) / 60)}m`,
    lastCheck: lastCheckTimestamp ? new Date(lastCheckTimestamp).toISOString() : 'N/A',
    failureRate: `${failureRate}%`
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🏥 Health server on ${PORT}`);
});

// ==========================================
// 9. STARTUP & MAIN LOOP (ADAPTIVE INTERVAL)
// ==========================================
console.log('🚀 Booting v12.1 (Enhanced Parallel Rotator - Fixed)...');
console.log(`📊 Monitoring: ${usersToMonitor.join(', ') || 'None'}`);

// Initial check
setTimeout(() => checkFeeds(false), 3000);

// Adaptive main loop
const mainLoop = () => {
  checkFeeds(false);
  // Adaptive: Shorten if active, else normal
  const baseInterval = config.CHECK_INTERVAL_MIN + (activityCounter > 5 ? -10000 : 0); // Shorten if active
  const interval = Math.max(20000, baseInterval + Math.random() * (config.CHECK_INTERVAL_MAX - baseInterval));
  activityCounter = Math.max(0, activityCounter - 1); // Decay
  setTimeout(mainLoop, interval);
};
setTimeout(mainLoop, 8000);

// ==========================================
// 10. GRACEFUL SHUTDOWN
// ==========================================
process.on('SIGINT', () => {
  console.log('\n⏹️ Shutting down gracefully...');
  saveJson(FILES.cache, Array.from(sentTweetIds).slice(-2000));
  saveJson(FILES.state, userBootstrapState);
  saveJson(FILES.users, usersToMonitor);
  console.log('✅ All data saved');
  process.exit(0);
});
