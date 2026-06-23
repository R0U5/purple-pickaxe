const STORAGE_KEY = 'twitchMinerSession';

let cachedSession = null;
let savePromise = null;

// Serialize session bootstrapping so the service-worker-start load and any
// fresh-session reset (browser launch / install) can't race each other.
let bootPromise = Promise.resolve();
let freshBooted = false;

function boot(fresh) {
  bootPromise = bootPromise.then(async () => {
    if (fresh) {
      // New browser session or install/update: wipe everything, including the
      // points history, so each session starts with a clean slate.
      freshBooted = true;
      await createNewSession();
      return;
    }
    // Service-worker (re)start mid-session. MV3 workers spin down when idle and
    // restart on events, so this fires often - we must keep accumulated points
    // here and only drop the ephemeral drops. Skip if a fresh boot already ran
    // in this worker lifetime.
    if (freshBooted) return;
    await initSession();
  });
  return bootPromise;
}

// Every service-worker start (covers mid-session restarts).
boot(false).then(() => reevaluateActiveChannel());
// Fires only on a genuine new browser session / install/update → clean slate.
chrome.runtime.onStartup.addListener(() => boot(true));
chrome.runtime.onInstalled.addListener(() => boot(true));

// Single-segment Twitch paths that are not channel pages (mirrors content.js).
const NON_CHANNEL_PATHS = new Set([
  'search', 'directory', 'following', 'subscriptions', 'downloads',
  'prime', 'store', 'drops', 'wallet', 'inventory', 'settings',
  'jobs', 'turbo', 'bits', 'moderator', 'friends', 'notifications',
]);

function isChannelUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'www.twitch.tv') return false;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return false;
    return !NON_CHANNEL_PATHS.has(parts[0].toLowerCase());
  } catch {
    return false;
  }
}

// Reset all per-channel session state. Centralized so the badge, timer, drops
// and per-visit points all clear together wherever a channel session ends.
function endChannelSession(session) {
  session.activeChannel = null;
  session.activeChannelAt = 0;
  session.activeChannelTabId = null;
  session.currentChannelPoints = 0;
  session.drops = {};
  session.totalDropsThisSession = 0;
}

// End the channel session when no open tab is on a Twitch channel page, so the
// badge and popup stop showing stale points. This covers tab close/navigation,
// where a destroyed content script can't send CHANNEL_INACTIVE itself.
async function reevaluateActiveChannel() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: '*://www.twitch.tv/*' });
  } catch {
    return;
  }
  if (tabs.some(t => isChannelUrl(t.url))) return;
  const session = await getSessionData();
  if (session.activeChannel) {
    endChannelSession(session);
    await persistSession();
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  // If the closed tab owned the active channel, end the session right away so
  // the badge doesn't keep showing a closed channel's points while other
  // channel tabs remain. A remaining tab re-asserts itself when next focused.
  const session = await getSessionData();
  if (session.activeChannel && session.activeChannelTabId === tabId) {
    endChannelSession(session);
    await persistSession();
    return;
  }
  reevaluateActiveChannel();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A url change means a tab navigated - re-check whether any channel remains.
  if (changeInfo.url) reevaluateActiveChannel();
});

function isValidOrigin(sender) {
  return sender.id === chrome.runtime.id;
}

function sanitizeString(val, maxLen = 256) {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

function sanitizeUrl(val) {
  if (typeof val !== 'string') return '';
  try {
    const url = new URL(val.trim().slice(0, 2048));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function sanitizeId(val) {
  if (typeof val !== 'string') return '';
  return val.replace(/[^a-zA-Z0-9_.:\-]/g, '').slice(0, 64);
}

// Drop instance IDs can be longer, base64-ish tokens - keep the broader charset.
function sanitizeInstanceId(val) {
  if (typeof val !== 'string') return '';
  return val.trim().replace(/[^A-Za-z0-9_.:\-=+/]/g, '').slice(0, 200);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isValidOrigin(sender)) {
    console.warn('Ignored message from untrusted origin:', sender.id);
    return;
  }

  switch (message.type) {
    case 'POINTS_CLAIMED':
      recordPointClaim(message.data, sender.tab?.id);
      break;
    case 'WATCH_STREAK_CLAIMED':
      recordWatchStreak(message.data, sender.tab?.id);
      break;
    case 'RAID_JOINED':
      recordRaid(message.data, sender.tab?.id);
      break;
    case 'CAMPAIGN_PROGRESS':
      updateCampaignProgress(message.data);
      break;
    case 'CAMPAIGN_SNAPSHOT':
      reconcileCampaigns(message.data);
      break;
    case 'DROP_CLAIMED':
      recordDropClaim(message.data);
      break;
    case 'POINTS_BALANCE':
      updatePointsBalance(message.data);
      break;
    case 'CHANNEL_ACTIVE':
      // Fix 2: Acknowledge so content.js can sequence polls after channel set
      setActiveChannel(message.data, sender.tab?.id).then(() => sendResponse({ ok: true }));
      return true;
    case 'CHANNEL_INACTIVE':
      // Left a channel (navigated to a non-channel page). Ends the channel
      // session so the timer stops. Guarded to only clear when the leaving tab
      // owned the active channel, so other open channel tabs aren't disturbed.
      clearActiveChannel(message.data).then(() => sendResponse({ ok: true }));
      return true;
    case 'POLL_STATUS':
      setPollStatus(message.data);
      break;
    case 'GET_SESSION':
      getSessionData().then(sendResponse);
      return true;
    case 'GET_AUTH_TOKEN':
      // Try both cookie names Twitch might use
      chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth-token' }, (cookie) => {
        if (cookie) {
          sendResponse(cookie.value);
        } else {
          chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'auth_token' }, (c2) => {
            sendResponse(c2 ? c2.value : null);
          });
        }
      });
      return true;
    case 'GET_INTEGRITY_TOKEN':
      chrome.cookies.get({ url: 'https://www.twitch.tv', name: 'i_token' }, (cookie) => {
        sendResponse(cookie ? cookie.value : null);
      });
      return true;
    case 'RESET_SESSION':
      resetSession();
      sendResponse({ ok: true });
      break;
  }
});



async function initSession() {
  // One-time migration from the previously corrupted storage key.
  const OLD_KEY = 'twitch\u2026sion'; // U+2026 ellipsis - historical bad key
  if (OLD_KEY !== STORAGE_KEY) {
    const legacy = await chrome.storage.local.get(OLD_KEY);
    if (legacy[OLD_KEY]) {
      const current = await chrome.storage.local.get(STORAGE_KEY);
      if (!current[STORAGE_KEY]) {
        await chrome.storage.local.set({ [STORAGE_KEY]: legacy[OLD_KEY] });
      }
      await chrome.storage.local.remove(OLD_KEY);
    }
  }
  const data = await chrome.storage.local.get(STORAGE_KEY);
  if (!data[STORAGE_KEY]) {
    await createNewSession();
  } else {
    cachedSession = migrateSession(data[STORAGE_KEY]);
  }
  // NEVER carry old drops across browser/extension restarts.
  // They're ephemeral - content script repopulates fresh on every page load.
  cachedSession.drops = {};
  cachedSession.totalDropsThisSession = 0;
  await persistSession();
}

function migrateSession(session) {
  if (!session.recentChannels) {
    session.recentChannels = Object.keys(session.points || {});
  }
  return session;
}

function createNewSession() {
  cachedSession = {
    id: Date.now().toString(),
    startTime: Date.now(),
    points: {},
    watchStreaks: {},
    raids: 0,
    drops: {},
    pointsBalances: {},
    recentChannels: [],
    totalDropsThisSession: 0,
    activeChannel: null,
    activeChannelAt: 0,
    activeChannelTabId: null,
    currentChannelPoints: 0,
  };
  return persistSession();
}

async function getSessionData() {
  // Ensure session bootstrap (load or fresh reset) has settled before use.
  try { await bootPromise; } catch {}
  if (cachedSession) {
    migrateSession(cachedSession);
    return cachedSession;
  }
  const data = await chrome.storage.local.get(STORAGE_KEY);
  cachedSession = data[STORAGE_KEY] || null;
  if (!cachedSession) {
    createNewSession();
  } else {
    cachedSession = migrateSession(cachedSession);
  }
  return cachedSession;
}

function persistSession() {
  savePromise = chrome.storage.local.set({ [STORAGE_KEY]: cachedSession }).then(() => {
    updateBadge(cachedSession);
  }).catch(err => {
    console.error('[Twitch Miner] Failed to save session:', err);
  });
  return savePromise;
}

function updateBadge(session) {
  // Show only the points claimed on the current channel during this visit, and
  // nothing when there's no active channel. currentChannelPoints resets on
  // every channel change, so the badge reflects "this channel, right now".
  const pts = session.activeChannel ? (session.currentChannelPoints || 0) : 0;
  const text = pts > 0 ? formatNum(pts) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#9146ff' });
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

async function recordPointClaim(data, tabId) {
  // Note: point totals are NOT accumulated here. They're derived from the
  // authoritative balance in updatePointsBalance (see there), which is immune
  // to double counting. This only records claim metadata: avatar, recency
  // ordering, and the claim count.
  const session = await getSessionData();
  const channel = sanitizeString(data.channelName) || 'unknown';
  const key = channel.toLowerCase();
  if (!session.points[key]) {
    session.points[key] = { total: 0, count: 0, avatar: sanitizeUrl(data.avatar), firstSeen: Date.now() };
  }
  session.points[key].count = (session.points[key].count || 0) + 1;
  session.points[key].lastSeen = Date.now();
  const cleanAvatar = sanitizeUrl(data.avatar);
  if (cleanAvatar) session.points[key].avatar = cleanAvatar;

  if (!session.recentChannels) session.recentChannels = [];
  const idx = session.recentChannels.indexOf(key);
  if (idx >= 0) session.recentChannels.splice(idx, 1);
  session.recentChannels.unshift(key);
  if (session.recentChannels.length > 5) session.recentChannels.length = 5;

  await persistSession();
}

async function recordWatchStreak(data, tabId) {
  const session = await getSessionData();
  const channel = sanitizeString(data.channelName) || 'unknown';
  const key = channel.toLowerCase();
  if (!session.watchStreaks[key]) {
    session.watchStreaks[key] = { count: 0, avatar: sanitizeUrl(data.avatar), firstSeen: Date.now() };
  }
  session.watchStreaks[key].count += 1;
  session.watchStreaks[key].lastSeen = Date.now();
  const cleanAvatar = sanitizeUrl(data.avatar);
  if (cleanAvatar) session.watchStreaks[key].avatar = cleanAvatar;
  await persistSession();
}

async function recordRaid(data, tabId) {
  const session = await getSessionData();
  session.raids += 1;
  await persistSession();
}

// Fix 8+2: Validate that the incoming CAMPAIGN_PROGRESS matches the current
// active channel before writing. Discards stale messages from the previous
// channel that arrive during the channel-switch ack window.
async function updateCampaignProgress(data) {
  const session = await getSessionData();

  // Fix 8: Discard stale messages from previous channels
  const incomingChannel = sanitizeString(data.channelName);
  if (incomingChannel && session.activeChannel && incomingChannel !== session.activeChannel) {
    return;
  }

  const campaignId = sanitizeId(data.campaignId);
  if (!campaignId) return;

  if (!session.drops[campaignId]) {
    session.drops[campaignId] = {
      gameName: sanitizeString(data.gameName),
      gameImage: sanitizeUrl(data.gameImage),
      campaignName: sanitizeString(data.campaignName),
      drops: [],
    };
  }

  const campaign = session.drops[campaignId];
  // Monotonic: never decrease campaign-level progress
  const newProgress = typeof data.campaignProgress === 'number' ? data.campaignProgress : 0;
  if (newProgress >= (campaign.campaignProgress || 0)) {
    campaign.campaignProgress = newProgress;
  }
  if (typeof data.totalRequiredSeconds === 'number') campaign.totalRequiredSeconds = data.totalRequiredSeconds;
  const newEarned = typeof data.totalEarnedSeconds === 'number' ? data.totalEarnedSeconds : 0;
  if (newEarned >= (campaign.totalEarnedSeconds || 0)) {
    campaign.totalEarnedSeconds = newEarned;
  }
  campaign.activeDropIndex = typeof data.activeDropIndex === 'number' ? data.activeDropIndex : -1;
  campaign.gameName = sanitizeString(data.gameName) || campaign.gameName;
  campaign.gameImage = sanitizeUrl(data.gameImage) || campaign.gameImage;
  campaign.campaignName = sanitizeString(data.campaignName) || campaign.campaignName;

  // Replace drops array entirely - no merging. Every CAMPAIGN_PROGRESS
  // is a complete snapshot from the content script's latest GQL+DOM scan.
  const incoming = Array.isArray(data.drops) ? data.drops : [];
  const newDrops = [];
  for (const inc of incoming) {
    const dropId = sanitizeId(inc.id);
    if (!dropId) continue;
    const prevDrop = campaign.drops.find(d => d.id === dropId);
    const dropData = {
      id: dropId,
      name: sanitizeString(inc.name),
      image: sanitizeUrl(inc.image),
      requiredSeconds: typeof inc.requiredSeconds === 'number' ? inc.requiredSeconds : 0,
      currentSeconds: typeof inc.currentSeconds === 'number' ? inc.currentSeconds : 0,
      progress: typeof inc.progress === 'number' ? Math.min(Math.max(0, inc.progress), 100) : 0,
      status: sanitizeString(inc.status) || 'locked',
      // Only 'claimed' status → claimed:true. gql_claimed stays false (locked storage).
      claimed: inc.status === 'claimed',
      // Inventory dropInstanceID - needed by the popup "Claim" button. Preserve a
      // previously-seen instance id if the latest snapshot lacks one.
      instanceId: sanitizeInstanceId(inc.instanceId) || (prevDrop?.instanceId || null),
    };

    // Monotonic guards - never decrease progress or regress status
    if (prevDrop) {
      if (prevDrop.claimed) {
        // This-session claim always wins
        dropData.claimed = true;
        dropData.status = 'claimed';
        dropData.progress = Math.max(dropData.progress, prevDrop.progress || 100);
        dropData.currentSeconds = Math.max(dropData.currentSeconds, prevDrop.currentSeconds || 0);
      } else {
        if (dropData.progress < prevDrop.progress) {
          dropData.progress = prevDrop.progress;
          dropData.currentSeconds = prevDrop.currentSeconds;
        }
        if (dropData.currentSeconds < prevDrop.currentSeconds) {
          dropData.currentSeconds = prevDrop.currentSeconds;
        }
        // Preserve gql_claimed - never regress to locked/active
        const prevStatus = prevDrop.status;
        if ((prevStatus === 'claimed' || prevStatus === 'gql_claimed' || prevStatus === 'complete') &&
            (dropData.status === 'active' || dropData.status === 'locked')) {
          dropData.status = prevStatus;
        }
      }
    }
    newDrops.push(dropData);
  }
  campaign.drops = newDrops;

  await persistSession();
}

// Prune campaigns the content script no longer reports as live (ended or no
// longer returned by GQL), so the drops window reflects reality. Campaigns with
// a drop claimed this session are kept so earned rewards stay visible.
async function reconcileCampaigns(data) {
  const session = await getSessionData();
  // Only act on the active channel - ignore late snapshots from a previous one.
  const incomingChannel = sanitizeString(data.channelName);
  if (incomingChannel && session.activeChannel && incomingChannel !== session.activeChannel) return;

  const liveIds = new Set((Array.isArray(data.liveIds) ? data.liveIds : []).map(sanitizeId).filter(Boolean));
  let changed = false;
  for (const [id, campaign] of Object.entries(session.drops || {})) {
    if (liveIds.has(id)) continue;
    const hasClaim = (campaign.drops || []).some(d => d.claimed);
    if (hasClaim) continue;
    delete session.drops[id];
    changed = true;
  }
  if (changed) {
    session.totalDropsThisSession = Object.values(session.drops)
      .reduce((sum, c) => sum + (c.drops || []).filter(d => d.claimed).length, 0);
    await persistSession();
  }
}

async function recordDropClaim(data) {
  const session = await getSessionData();
  const campaignId = sanitizeId(data.campaignId);
  if (!campaignId) return;
  if (!session.drops[campaignId]) {
    session.drops[campaignId] = { gameName: sanitizeString(data.gameName), gameImage: sanitizeUrl(data.gameImage), campaignName: sanitizeString(data.campaignName), drops: [] };
  }
  const campaign = session.drops[campaignId];
  const dropId = sanitizeId(data.dropId);
  if (!dropId) return;
  const existing = campaign.drops.findIndex(d => d.id === dropId);
  if (existing >= 0) {
    campaign.drops[existing].claimed = true;
    campaign.drops[existing].status = 'claimed';
    campaign.drops[existing].claimedAt = Date.now();
    campaign.drops[existing].progress = 100;
    const cleanImg = sanitizeUrl(data.dropImage);
    if (cleanImg) campaign.drops[existing].image = cleanImg;
  } else {
    campaign.drops.push({
      id: dropId,
      name: sanitizeString(data.dropName),
      image: sanitizeUrl(data.dropImage),
      required: typeof data.required === 'number' ? data.required : 100,
      progress: 100,
      status: 'claimed',
      claimed: true,
      claimedAt: Date.now(),
    });
  }
  session.totalDropsThisSession = Object.values(session.drops)
    .reduce((sum, c) => sum + c.drops.filter(d => d.claimed).length, 0);
  await persistSession();
}

async function updatePointsBalance(data) {
  const session = await getSessionData();
  const channel = sanitizeString(data.channelName) || 'unknown';
  const key = channel.toLowerCase();
  const balance = typeof data.balance === 'number' ? data.balance : null;

  session.pointsBalances[channel] = {
    balance: balance ?? 0,
    lastUpdated: Date.now(),
  };

  // Points mined are derived from Twitch's authoritative balance: accumulate
  // only increases above a per-channel high-water mark. The balance is ground
  // truth, so this counts every gain exactly once - immune to double-reporting,
  // multiple tabs, or service-worker restarts - and can never inflate. The
  // read/raise of hwm below is synchronous (no await), so concurrent messages
  // can't both add the same gain.
  if (balance !== null) {
    let p = session.points[key];
    if (!p) {
      p = session.points[key] = { total: 0, hwm: balance, count: 0, avatar: '', firstSeen: Date.now() };
    } else if (typeof p.hwm !== 'number') {
      p.hwm = balance; // establish baseline for entries created before a balance
    } else if (balance > p.hwm) {
      const gain = balance - p.hwm;
      p.total = (p.total || 0) + gain;
      p.hwm = balance;
      if (session.activeChannel && key === session.activeChannel.toLowerCase()) {
        session.currentChannelPoints = (session.currentChannelPoints || 0) + gain;
      }
    }
    p.lastSeen = Date.now();
  }

  await persistSession();
}

// Fix 5: Only clear drops when switching to a non-null channel that differs
// from the current active channel. Do not clear or update on transient null
// values (navigation blips where extractChannel returns null briefly).
// Fix 2: Atomic channel-change drop clear - if the new channel differs,
// wipe drops and reset the session counter under the same async lock.
// No more fire-and-forget CLEAR_DROPS race from content.js.
async function setActiveChannel(data, tabId) {
  const session = await getSessionData();
  const newChannel = sanitizeString(data.channel) || null;
  // Fix 5: Only clear when switching to a real (non-null) channel
  if (newChannel && newChannel !== session.activeChannel) {
    session.drops = {};
    session.totalDropsThisSession = 0;
    // Reset the per-visit points so the badge/stat restart for the new channel.
    session.currentChannelPoints = 0;
    // Stamp when this channel session began. Only on an actual channel change -
    // CHANNEL_ACTIVE also fires on focus pings and re-entry, and the timer must
    // measure time on the current channel, not be reset by those.
    session.activeChannelAt = Date.now();
  }
  // Fix 5: Only update activeChannel if non-null
  if (newChannel) {
    session.activeChannel = newChannel;
    // Remember which tab owns the active channel so closing that exact tab can
    // end the session even when other channel tabs remain open.
    if (typeof tabId === 'number') session.activeChannelTabId = tabId;
  }
  await persistSession();
}

// End the current channel session. Only clears when the channel being left is
// the one currently active, so navigating away in one tab doesn't wipe the
// session of another focused channel tab.
async function clearActiveChannel(data) {
  const session = await getSessionData();
  const left = sanitizeString(data?.channel);
  if (left && left === session.activeChannel) {
    endChannelSession(session);
    await persistSession();
  }
}

async function setPollStatus(data) {
  const session = await getSessionData();
  session.lastPoll = {
    status: sanitizeString(data.status) || 'unknown',
    error: sanitizeString(data.error) || null,
    channel: sanitizeString(data.channel) || null,
    balance: typeof data.balance === 'number' ? data.balance : null,
    at: Date.now(),
  };
  await persistSession();
}

async function resetSession() {
  await createNewSession();
}
