const TWITCH_GQL = 'https://gql.twitch.tv/gql';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const POLL_MS = 15000;
const POINTS_QUERY = `query($channelId: ID!) {
  channel(id: $channelId) {
    id
    self {
      communityPoints {
        balance
        availableClaim { id }
      }
    }
  }
}`;

// ── Non-channel Twitch path blocklist ──
// Single-segment paths that are NOT channel pages - skip them entirely
// so we don't waste GQL calls resolving non-existent user IDs.
const NON_CHANNEL_PATHS = new Set([
  'search', 'directory', 'following', 'subscriptions', 'downloads',
  'prime', 'store', 'drops', 'wallet', 'inventory', 'settings',
  'jobs', 'turbo', 'bits', 'moderator', 'friends', 'notifications',
]);

let currentChannel = extractChannel();
let authToken = null;
let authTokenPending = null;
let integrityToken = null;
let lastIntegrityFetch = 0;

// ── Module-level claimed state ──
// Persist across scrape interval cycles; reset on channel change.
const claimedDropIds = new Set();
const claimedFallbackKeys = new Set();

// ── Fix 9: Prevent concurrent fetchDropMetadata calls ──
let fetchDropMetadataInFlight = false;

console.log('[Twitch Miner] Content script loaded (background-only mode)');

function extractChannel() {
  try {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    const slug = parts[0].toLowerCase();
    // Skip non-channel paths
    if (NON_CHANNEL_PATHS.has(slug)) return null;
    return slug;
  } catch { return null; }
}

function getAuthToken() {
  return authToken;
}

function fetchAuthToken() {
  if (authTokenPending) return authTokenPending;
  authTokenPending = new Promise((resolve, reject) => {
    console.log('[Twitch Miner] Requesting auth token from background...');
    const timeout = setTimeout(() => {
      console.warn('[Twitch Miner] Auth token request timed out');
      authTokenPending = null;
      reject(new Error('timeout'));
    }, 5000);
    try {
      chrome.runtime.sendMessage({ type: 'GET_AUTH_TOKEN' }, (token) => {
        clearTimeout(timeout);
        if (token) {
          authToken = token;
          console.log('[Twitch Miner] Auth token received, length:', token.length);
          authTokenPending = null;
          resolve(token);
        } else {
          console.log('[Twitch Miner] No auth token found in cookies');
          authTokenPending = null;
          resolve(null);
        }
      });
    } catch (err) {
      clearTimeout(timeout);
      authTokenPending = null;
      reject(err);
    }
  });
  return authTokenPending;
}

async function refreshIntegrityToken() {
  if (integrityToken && Date.now() - lastIntegrityFetch < 240000) return integrityToken;
  const token = getAuthToken();
  try {
    const headers = {
      'Client-Id': CLIENT_ID,
      'Content-Type': 'application/json',
    };
    if (token) headers['Authorization'] = `OAuth ${token}`;
    const res = await fetch('https://gql.twitch.tv/integrity', {
      method: 'POST',
      headers,
      body: '{}',
    });
    const data = await res.json();
    if (data.token) {
      integrityToken = data.token;
      lastIntegrityFetch = Date.now();
      console.log('[Twitch Miner] Integrity token refreshed, expires:', data.expiration);
    }
  } catch (err) {
    console.error('[Twitch Miner] Integrity fetch failed:', err);
  }
  return integrityToken;
}

// Build the standard headers Twitch's first-party web client sends. Shared by
// both the ad-hoc and persisted-query request helpers.
async function buildGqlHeaders() {
  const token = getAuthToken();
  if (!token) {
    console.log('[Twitch Miner] No auth-token cookie found');
    return null;
  }
  await refreshIntegrityToken();
  const headers = {
    'Client-Id': CLIENT_ID,
    'Content-Type': 'application/json',
    'Authorization': `OAuth ${token}`,
  };
  if (integrityToken) {
    headers['Client-Integrity'] = integrityToken;
  }
  return headers;
}

async function gql(query, variables = {}) {
  const headers = await buildGqlHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
    });
    const json = await res.json();
    if (json.errors) {
      console.warn('[Twitch Miner] GQL error:', JSON.stringify(json.errors));
    } else if (json.data) {
      console.log('[Twitch Miner] GQL success:', Object.keys(json.data).join(', '));
    }
    return json;
  } catch (err) {
    console.error('[Twitch Miner] GQL request failed:', err);
    return null;
  }
}

// Persisted-query (APQ) request. Twitch's first-party operations are registered
// as persisted queries keyed by a sha256 hash; some mutations - notably
// claimDropRewards - are accepted more reliably in this form than as an ad-hoc
// query string. Falls back to gql() at the call site if the hash is stale.
async function gqlPersisted(operationName, sha256Hash, variables = {}) {
  const headers = await buildGqlHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(TWITCH_GQL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        operationName,
        variables,
        extensions: { persistedQuery: { version: 1, sha256Hash } },
      }),
    });
    const json = await res.json();
    if (json.errors) {
      console.warn('[Twitch Miner] Persisted GQL error:', JSON.stringify(json.errors));
    }
    return json;
  } catch (err) {
    console.error('[Twitch Miner] Persisted GQL request failed:', err);
    return null;
  }
}

// Channel-based drops query - gets campaign metadata + personal progress
// for the current channel. Requires auth + channel ID.
const DROPS_QUERY = `query($channelID: ID!) {
  channel(id: $channelID) {
    id
    viewerDropCampaigns {
      id
      name
      status
      startAt
      endAt
      game { id displayName boxArtURL }
      timeBasedDrops {
        id
        name
        requiredMinutesWatched
        endAt
        self { currentMinutesWatched isClaimed }
        benefitEdges {
          benefit { id name imageAssetURL }
        }
      }
    }
  }
}`;

const INVENTORY_QUERY = `query {
  currentUser {
    inventory {
      dropCampaignsInProgress {
        id
        timeBasedDrops { id self { currentMinutesWatched isClaimed dropInstanceID } }
      }
    }
  }
}`;

// A drop campaign has ended once Twitch flags it EXPIRED/DELETED or its endAt is
// in the past. Twitch's viewerDropCampaigns can keep returning a just-ended
// campaign for a while, and on a page refresh that stale entry would otherwise be
// cached and re-emitted as a live campaign - surfacing an un-completable drop and
// driving endless auto-claim retries. Treat such campaigns as gone so we never
// pick them back up as new. Guard the date parse so an unparseable/absent endAt
// (or a status field Twitch omits) never falsely marks an active campaign ended.
function isCampaignEnded(c) {
  if (!c) return true;
  const status = typeof c.status === 'string' ? c.status.toUpperCase() : '';
  if (status === 'EXPIRED' || status === 'DELETED') return true;
  if (c.endAt) {
    const end = Date.parse(c.endAt);
    if (!isNaN(end) && end <= Date.now()) return true;
  }
  return false;
}

// dropId -> { current: <minutes watched>, claimed: <bool>, instanceId: <claimable instance id|null> }
let inventoryProgress = {};
let inventoryFetchTime = 0;
let inventoryInFlight = false;

let dropCache = {};
let dropCacheChannel = null;
let dropCacheTime = 0;
let dropCacheErrorTime = 0;

// ── Claim debounce state ──
const CLAIM_DEBOUNCE_MS = 8000;
const CLAIM_MAX_RETRIES = 3;
let claimState = {
  inProgress: false,
  lastAttempt: 0,
  retryCount: 0,
  currentDropId: null,
};

function canAttemptClaim(dropId) {
  const now = Date.now();
  if (claimState.inProgress) return false;
  if (now - claimState.lastAttempt < CLAIM_DEBOUNCE_MS) return false;
  if (claimState.currentDropId !== dropId) {
    claimState.retryCount = 0;
    claimState.currentDropId = dropId;
  }
  return claimState.retryCount < CLAIM_MAX_RETRIES;
}

function recordClaimAttempt(dropId, success) {
  claimState.lastAttempt = Date.now();
  claimState.inProgress = false;
  if (success) {
    claimState.retryCount = 0;
    claimState.currentDropId = null;
  } else {
    claimState.retryCount++;
  }
}

// ── Campaign state builder ──
// Transforms raw GQL cache data into a campaign model with sequential drop
// statuses (locked → active → complete → claimed / gql_claimed) and cumulative progress.
//
// GQL isClaimed is permanent (persists across sessions). Only emit status
// 'claimed' for drops claimed THIS session (tracked in claimedDropIds Set).
// Drops that GQL says are claimed but we didn't claim this session get status
// 'gql_claimed' - background stores them as locked, popup renders "✓ Prev".
function buildCampaignState(cached) {
  const drops = cached.drops.map(d => {
    const req = d.requiredMinutes || 0;
    const invEntry = inventoryProgress[d.id];
    // Both sources report the same per-tier (capped) watched minutes but refresh
    // on different TTLs (inventory 30s, channel metadata 120s), and
    // viewerDropCampaigns.self lags to 0 early in a session. Take the max so the
    // UI always shows the most recent value and never regresses to a stale lower
    // one when whichever source happens to be lagging is picked.
    const invCur = (invEntry && typeof invEntry.current === 'number') ? invEntry.current : 0;
    const cur = Math.max(invCur, d.currentMinutes || 0);
    return {
      id: d.id,
      name: d.name,
      benefitName: d.benefitName,
      benefitImage: d.benefitImage || '',
      requiredMinutes: req,
      currentMinutes: cur,
      progress: req > 0 ? Math.min(100, Math.round((cur / req) * 100)) : 0,
      instanceId: invEntry?.instanceId || null,
      claimed: false,
      status: 'locked',
    };
  });

  if (!drops.length) return null;

  // Find first unclaimed drop → that's the ACTIVE one.
  // Distinguish this-session claims (claimedDropIds) from stale GQL isClaimed.
  let firstUnclaimed = -1;
  for (let i = 0; i < drops.length; i++) {
    const thisSessionClaimed = claimedDropIds.has(drops[i].id);
    const invClaim = inventoryProgress[drops[i].id];
    const gqlClaimed = invClaim ? invClaim.claimed : cached.drops[i].isClaimed;
    const isClaimed = thisSessionClaimed || gqlClaimed;

    if (isClaimed) {
      drops[i].progress = 100;
      if (thisSessionClaimed) {
        drops[i].claimed = true;
        drops[i].status = 'claimed';
      } else {
        // GQL says claimed but not this session → gql_claimed
        drops[i].status = 'gql_claimed';
      }
    } else if (firstUnclaimed === -1) {
      firstUnclaimed = i;
    }
  }

  if (firstUnclaimed >= 0) {
    const active = drops[firstUnclaimed];
    active.status = active.progress >= 100 ? 'complete' : 'active';
  }

  // Cumulative campaign: top tier defines completion; watched minutes are shared across tiers.
  const totalRequired = drops.reduce((m, d) => Math.max(m, d.requiredMinutes), 0);
  const watched = drops.reduce((m, d) => Math.max(m, d.currentMinutes), 0);
  const totalEarned = Math.min(watched, totalRequired);

  return {
    id: cached.id,
    name: cached.name,
    gameName: cached.gameName || '',
    gameImage: cached.gameImage || '',
    campaignProgress: totalRequired > 0 ? Math.round((totalEarned / totalRequired) * 100) : 0,
    totalRequiredSeconds: totalRequired * 60,
    totalEarnedSeconds: Math.round(totalEarned * 60),
    activeDropIndex: firstUnclaimed,
    drops,
  };
}

// ── DOM progress scraper ──
// Reads what Twitch actually displays, used when GQL shows 0 but DOM shows real progress.
function scrapeDomDropProgress(container) {
  if (!container) return null;

  // Strategy 1: aria progressbar (standard Twitch widget)
  const bar = container.querySelector('[role="progressbar"]');
  if (bar) {
    const vn = parseInt(bar.getAttribute('aria-valuenow'), 10);
    const vm = parseInt(bar.getAttribute('aria-valuemax'), 10);
    if (!isNaN(vn) && !isNaN(vm) && vm > 0) {
      return { current: vn, max: vm, percent: Math.round((vn / vm) * 100) };
    }
  }

  // Strategy 2: percentage text (e.g. "80% complete", "75% of")
  const text = (container.innerText || '').replace(/[\u200B-\u200D\uFEFF]/g, '');
  const pctMatch = text.match(/(\d+)%/);
  if (pctMatch) {
    return { percent: parseInt(pctMatch[1], 10) };
  }

  // Strategy 3: fraction text (e.g. "48 / 60 minutes")
  const fracMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:min|hr|hour)/i);
  if (fracMatch) {
    const cur = parseInt(fracMatch[1], 10);
    const max = parseInt(fracMatch[2], 10);
    if (max > 0) return { current: cur, max: max, percent: Math.round((cur / max) * 100) };
  }

  return null;
}

function normalizeCampaign(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ── Strict campaign matching ──
// Contains + length-diff ≤ 6 gate. Multiple candidates → closest by character
// difference, or null if tied.
function matchCampaign(domKey, cache) {
  if (!domKey) return null;
  if (cache[domKey]) return cache[domKey];

  const candidates = [];
  for (const [key, val] of Object.entries(cache)) {
    if ((key.includes(domKey) || domKey.includes(key)) &&
        Math.abs(key.length - domKey.length) <= 6) {
      candidates.push({ key, val, diff: Math.abs(key.length - domKey.length) });
    }
  }

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].val;

  // Multiple candidates - return closest by character difference, or null if tied
  candidates.sort((a, b) => a.diff - b.diff);
  if (candidates[0].diff === candidates[1].diff) return null;
  return candidates[0].val;
}

// ── Fetch drop metadata via GQL ──
// Fix 9: Module-level inFlight guard prevents concurrent GQL calls from
// the two call sites (runPoll and detectDropsFromDOM) during warm-up.
async function fetchDropMetadata(channelName) {
  if (!channelName) return;
  // TTL guard at the very top - skip expensive getUserId() when cache is fresh
  if (dropCacheChannel === channelName && Date.now() - dropCacheTime < 120000) return;
  if (dropCacheErrorTime && Date.now() - dropCacheErrorTime < 10000) return;

  // Fix 9: Prevent concurrent in-flight GQL calls
  if (fetchDropMetadataInFlight) return;
  fetchDropMetadataInFlight = true;

  try {
    const channelId = await getUserId(channelName);
    if (!channelId) {
      console.log('[Twitch Miner] Could not resolve channel ID for:', channelName);
      return;
    }

    const result = await gql(DROPS_QUERY, { channelID: channelId });
    if (!result) return; // No auth token - retry next poll
    const campaigns = result?.data?.channel?.viewerDropCampaigns;

    if (!campaigns) {
      dropCacheErrorTime = Date.now();
      return;
    }

    // Fix 4: CLEAR_DROPS removed from here - setActiveChannel atomic clear
    // handles the stale dom-* orphan problem.

    dropCache = {};
    dropCacheChannel = channelName;
    dropCacheTime = Date.now();
    for (const c of campaigns) {
      if (!c.timeBasedDrops?.length) continue;
      // Skip campaigns that have already ended - never re-cache a stale/expired
      // campaign as if it were a live one to track.
      if (isCampaignEnded(c)) {
        console.log('[Twitch Miner] Skipping ended campaign:', c.name, '| status:', c.status, '| endAt:', c.endAt);
        continue;
      }
      // Drop tiers can expire individually while the campaign is still active.
      // Drop any tier past its own endAt so a closed tier isn't shown as active.
      const liveDrops = c.timeBasedDrops.filter(d => !(d.endAt && !isNaN(Date.parse(d.endAt)) && Date.parse(d.endAt) <= Date.now()));
      if (!liveDrops.length) continue;
      const key = normalizeCampaign(c.name);
      dropCache[key] = {
        id: c.id,
        name: c.name,
        gameName: c.game?.displayName || '',
        gameImage: c.game?.boxArtURL || '',
        drops: liveDrops.map(d => {
          const req = d.requiredMinutesWatched || 0;
          const cur = d.self?.currentMinutesWatched ?? 0;
          const claimedFromGql = d.self?.isClaimed === true;
          console.log('[Twitch Miner] Drop:', d.name, '| required:', req, 'min | current:', cur, 'min | isClaimed:', claimedFromGql, '| self:', JSON.stringify(d.self));
          return {
            id: d.id,
            name: d.name,
            requiredMinutes: req,
            currentMinutes: cur,
            isClaimed: claimedFromGql,
            benefitName: d.benefitEdges?.[0]?.benefit?.name || d.name,
            benefitImage: d.benefitEdges?.[0]?.benefit?.imageAssetURL || '',
          };
        }),
      };
    }
    console.log('[Twitch Miner] Drop cache updated for', channelName, Object.keys(dropCache).length, 'campaigns');
  } finally {
    fetchDropMetadataInFlight = false;
  }
}

// ── Live per-tier drop progress from the user inventory ──
// viewerDropCampaigns.self.currentMinutesWatched lags to 0 early in a session;
// inventory.dropCampaignsInProgress carries the real minutes Twitch's UI shows.
// Refreshed on a 30s TTL. User-global (no channel id needed).
async function fetchInventory() {
  if (Date.now() - inventoryFetchTime < 30000) return;
  if (inventoryInFlight) return;
  inventoryInFlight = true;
  try {
    const result = await gql(INVENTORY_QUERY);
    const camps = result?.data?.currentUser?.inventory?.dropCampaignsInProgress;
    if (!camps) return; // auth/integrity not ready - keep previous map
    const map = {};
    for (const c of camps) {
      for (const d of (c.timeBasedDrops || [])) {
        map[d.id] = {
          current: d.self?.currentMinutesWatched ?? 0,
          claimed: d.self?.isClaimed === true,
          // Present only once the drop is completed and a reward is claimable.
          // This is the ID required by the claimDropRewards mutation.
          instanceId: d.self?.dropInstanceID || null,
        };
      }
    }
    inventoryProgress = map;
    inventoryFetchTime = Date.now();
  } finally {
    inventoryInFlight = false;
  }
}

// ── Populate module-level Sets from session storage ──
function restoreClaimedFlags() {
  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (response) => {
    if (!response?.drops) return;
    for (const [campaignId, campaign] of Object.entries(response.drops)) {
      // Restore claimed flags for individual drops
      for (const drop of (campaign.drops || [])) {
        if (drop.claimed) claimedDropIds.add(drop.id);
      }
      // Restore fallback-claimed flag for campaigns with dom-* IDs
      if (campaignId.startsWith('dom-') && campaign.drops?.some(d => d.claimed)) {
        claimedFallbackKeys.add(campaignId.slice(4));
      }
    }
  });
}

function isContextValid() {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function sendMessage(type, data = {}) {
  if (!isContextValid()) return;
  const payload = {
    ...data,
    channelName: data.channelName || currentChannel,
  };
  try {
    chrome.runtime.sendMessage({ type, data: payload }).catch(err => {
      if (err?.message?.includes('Extension context invalidated')) { stopPolling(); return; }
      console.warn('[Twitch Miner] sendMessage failed:', type, err?.message || err);
    });
  } catch (err) {
    if (err?.message?.includes('Extension context invalidated')) { stopPolling(); return; }
    console.warn('[Twitch Miner] sendMessage error:', type, err?.message || err);
  }
}

// Fix 2: Promise-based sendMessage that waits for sendResponse ack
function sendMessageAsync(type, data = {}) {
  if (!isContextValid()) return Promise.resolve(null);
  const payload = {
    ...data,
    channelName: data.channelName || currentChannel,
  };
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, data: payload }, (response) => {
        resolve(response || null);
      });
    } catch (err) {
      if (err?.message?.includes('Extension context invalidated')) { stopPolling(); }
      else console.warn('[Twitch Miner] sendMessageAsync error:', type, err?.message || err);
      resolve(null);
    }
  });
}

// Cache of channel login -> profile image URL, populated when resolving user IDs.
const channelAvatars = {};

async function getUserId(login) {
  const result = await gql('query($login: String!) { user(login: $login) { id profileImageURL(width: 70) } }', { login });
  const user = result?.data?.user;
  const id = user?.id || null;
  if (user?.profileImageURL && login) channelAvatars[login.toLowerCase()] = user.profileImageURL;
  if (id) console.log('[Twitch Miner] Resolved', login, '->', id);
  else console.log('[Twitch Miner] Failed to resolve user ID for:', login, 'result:', result?.data);
  return id;
}

async function checkAndClaimChannelPoints(channel) {
  channel = channel || currentChannel;
  if (!channel) return { status: 'no_channel', error: 'Not on a channel page' };

  const channelId = await getUserId(channel);
  if (!channelId) {
    console.log('[Twitch Miner] Could not resolve channel ID for:', channel);
    return { status: 'no_channel_id', error: `Could not resolve channel ID for "${channel}"` };
  }

  const result = await gql(POINTS_QUERY, { channelId });
  if (!result) {
    console.log('[Twitch Miner] GQL returned null - likely auth/integrity failure');
    return { status: 'gql_null', error: 'GQL request failed (auth or integrity token issue)' };
  }

  if (result.errors) {
    const msgs = result.errors.map(e => e.message).join('; ');
    console.log('[Twitch Miner] Channel points query failed:', msgs);
    return { status: 'gql_error', error: msgs };
  }

  const cp = result?.data?.channel?.self?.communityPoints;
  if (!cp) {
    const keys = result?.data?.channel ? Object.keys(result.data.channel).join(', ') : 'no channel';
    console.log('[Twitch Miner] communityPoints not found. Channel keys:', keys);
    return { status: 'schema_mismatch', error: `communityPoints not in response. Channel has: ${keys}` };
  }

  const claim = cp?.availableClaim;

  if (!claim?.id) {
    console.log('[Twitch Miner] Channel points balance:', cp.balance, '- no claim available');
    if (typeof cp.balance === 'number') {
      sendMessage('POINTS_BALANCE', { balance: cp.balance, channelName: channel });
    }
    return { status: 'ok', balance: cp.balance };
  }

  console.log('[Twitch Miner] Found claimable points, claimID:', claim.id);
  const balanceBefore = cp.balance;
  let claimed = false;

  if (clickClaimButton()) {
    console.log('[Twitch Miner] Claimed via DOM click');
    claimed = true;
  } else {
    const claimResult = await claimChannelPoints(channelId, claim.id);
    if (claimResult.ok) {
      console.log('[Twitch Miner] Claimed via GQL mutation');
      claimed = true;
    } else {
      return { status: 'claim_failed', balance: cp.balance, error: claimResult.error || 'Claim mutation failed' };
    }
  }

  const postResult = await gql(POINTS_QUERY, { channelId });
  const postCp = postResult?.data?.channel?.self?.communityPoints;
  const newBalance = typeof postCp?.balance === 'number' ? postCp.balance : null;
  const delta = (typeof balanceBefore === 'number' && newBalance !== null && newBalance > balanceBefore)
    ? newBalance - balanceBefore
    : 50;

  sendMessage('POINTS_CLAIMED', { amount: delta, channelName: channel, avatar: channelAvatars[channel.toLowerCase()] });
  if (newBalance !== null) {
    sendMessage('POINTS_BALANCE', { balance: newBalance, channelName: channel });
  }
  return { status: 'claimed', balance: newBalance, amount: delta };
}

function clickClaimButton() {
  // Twitch's "Claim Bonus" button - try multiple known selectors
  const selectors = [
    'button[aria-label="Claim Bonus"]',
    '.claimable-bonus__icon',
    '[data-test-selector="community-points-summary"] button',
    '.community-points-summary button',
    'button[class*="claimable"]',
    'div[class*="claimable-bonus"] button',
  ];
  for (const sel of selectors) {
    try {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        console.log('[Twitch Miner] Clicking claim button via selector:', sel);
        btn.click();
        return true;
      }
    } catch {}
  }
  return false;
}

async function claimChannelPoints(channelId, claimId) {
  const result = await gql(
    'mutation($input: ClaimCommunityPointsInput!) { claimCommunityPoints(input: $input) { __typename } }',
    { input: { channelID: channelId, claimID: claimId } }
  );
  if (result?.data?.claimCommunityPoints) {
    console.log('[Twitch Miner] GQL mutation succeeded');
    return { ok: true };
  }
  const errDetail = result?.errors
    ? result.errors.map(e => e.message).join('; ')
    : (result ? JSON.stringify(result).slice(0, 200) : 'null response');
  console.warn('[Twitch Miner] Claim failed:', errDetail);
  return { ok: false, error: errDetail };
}

// ── GQL claimDrop mutation ──
// Claims a completed drop reward. `dropInstanceId` is the inventory
// self.dropInstanceID - present only once the drop is complete. Runs from the
// page (www.twitch.tv) context so the request carries a trusted Origin; the
// service worker / extension origin would be rejected by Twitch.
// Twitch's registered persisted-query hash for the claim mutation. Used by the
// official web client; the most reliable way to claim. If Twitch rotates it the
// call returns PersistedQueryNotFound and we transparently fall back to the
// ad-hoc mutation string below.
const CLAIM_DROP_HASH = 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930';

async function claimDrop(dropInstanceId) {
  if (!dropInstanceId) {
    return { ok: false, error: 'No claimable drop instance yet (still in progress or not synced from inventory)' };
  }
  const variables = { input: { dropInstanceID: dropInstanceId } };

  // Try, in order, the request forms most likely to be accepted by Twitch:
  // 1) the persisted query the web client uses, 2) an ad-hoc mutation string.
  const attempts = [
    { name: 'persisted', run: () => gqlPersisted('DropsPage_ClaimDropRewards', CLAIM_DROP_HASH, variables) },
    { name: 'ad-hoc', run: () => gql('mutation($input: DropsPage_ClaimDropRewardsInput!) { claimDropRewards(input: $input) { status } }', variables) },
  ];

  let lastErr = 'null response';
  for (const attempt of attempts) {
    const result = await attempt.run();
    if (result?.data?.claimDropRewards) {
      console.log('[Twitch Miner] claimDrop succeeded for instance:', dropInstanceId,
        '| via:', attempt.name, '| status:', result.data.claimDropRewards.status);
      return { ok: true };
    }
    if (result?.errors) {
      lastErr = result.errors.map(e => e.message).join('; ');
    } else if (result) {
      lastErr = JSON.stringify(result).slice(0, 200);
    }
    console.warn('[Twitch Miner] claimDrop', attempt.name, 'attempt failed:', lastErr);
  }
  console.warn('[Twitch Miner] claimDrop GQL failed (all methods):', lastErr);
  return { ok: false, error: lastErr };
}

// ── Claim-on-demand handler (popup "Claim" button) ──
// Runs in the page context. Prefers the GQL claim using the inventory
// dropInstanceID; falls back to clicking a visible DOM claim button when no
// instance id is available (e.g. DOM-fallback campaigns).
async function handleClaimDropRequest(data = {}) {
  const dropId = typeof data.dropId === 'string' ? data.dropId : '';
  let instanceId = typeof data.dropInstanceId === 'string' ? data.dropInstanceId : '';
  if (!dropId && !instanceId) return { ok: false, error: 'Missing drop identifier' };

  // If the popup had no synced instance id, pull a fresh inventory so we can
  // claim via GQL instead of relying on a visible DOM button.
  if (!instanceId && dropId) {
    inventoryFetchTime = 0;
    await fetchInventory();
    instanceId = inventoryProgress[dropId]?.instanceId || '';
  }

  // Primary path: GQL claim with the inventory instance id.
  if (instanceId) {
    const res = await claimDrop(instanceId);
    if (res.ok) {
      if (dropId) claimedDropIds.add(dropId);
      sendMessage('DROP_CLAIMED', {
        campaignId: data.campaignId,
        dropId: dropId || instanceId,
        dropName: data.dropName || '',
        gameImage: '',
        dropImage: '',
      });
      // Force a fresh inventory pull on the next scan so isClaimed/progress sync.
      inventoryFetchTime = 0;
      return { ok: true };
    }
    // Fall through to DOM click if GQL didn't take.
  }

  // Fallback path: click a visible "claim" button if one is on the page.
  const domContainer = document.querySelector('.community-highlight') || document.body;
  const buttons = domContainer.querySelectorAll('button:not([disabled])');
  for (const btn of buttons) {
    const txt = (btn.textContent || '').toLowerCase();
    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
    if ((txt.includes('claim') || aria.includes('claim')) && btn.offsetParent !== null) {
      btn.click();
      if (dropId) claimedDropIds.add(dropId);
      sendMessage('DROP_CLAIMED', {
        campaignId: data.campaignId,
        dropId: dropId || instanceId,
        dropName: data.dropName || '',
        gameImage: '',
        dropImage: '',
      });
      inventoryFetchTime = 0;
      return { ok: true };
    }
  }

  return { ok: false, error: instanceId
    ? 'Claim was not accepted by Twitch - try the inventory page'
    : 'No claimable instance found yet - open inventory or wait for the next sync' };
}

// Receive claim-on-demand requests relayed from the popup via the background.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only accept messages from this extension (popup/background relay).
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'CLAIM_DROP_REQUEST') {
    handleClaimDropRequest(message.data).then(sendResponse);
    return true; // async response
  }
});

async function detectDropsFromDOM() {
  if (!isContextValid()) return;
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 1) return;
  if (!currentChannel) return;

  // No auth = logged out. Every GQL call would just return null, so skip the
  // scan to avoid spamming the API/console. runPoll() reports the no_auth state
  // to the popup so the user sees a "log in" notice.
  if (!authToken) {
    try { await fetchAuthToken(); } catch { }
    if (!authToken) return;
  }

  await fetchDropMetadata(currentChannel);
  await fetchInventory();
  const hasCache = Object.keys(dropCache).length > 0;
  const domContainer = document.querySelector('.community-highlight');

  const supplemented = [];
  if (hasCache) {
    for (const cached of Object.values(dropCache)) {
      const campaign = buildCampaignState(cached);
      if (!campaign || !campaign.drops.length) continue;

      supplemented.push(campaign);
    }
  }

  // ── Send campaign progress ──
  for (const campaign of supplemented) {
    sendMessage('CAMPAIGN_PROGRESS', {
      campaignId: campaign.id,
      campaignName: campaign.name,
      gameName: campaign.gameName,
      gameImage: campaign.gameImage,
      campaignProgress: campaign.campaignProgress,
      totalRequiredSeconds: campaign.totalRequiredSeconds,
      totalEarnedSeconds: campaign.totalEarnedSeconds,
      activeDropIndex: campaign.activeDropIndex,
      drops: campaign.drops.map(d => ({
        id: d.id,
        name: d.benefitName,
        image: d.benefitImage,
        requiredSeconds: d.requiredMinutes * 60,
        currentSeconds: d.currentMinutes * 60,
        progress: d.progress,
        status: d.status,
        instanceId: d.instanceId || null,
      })),
    });
  }

  // ── Claim detection (debounced) ──
  // Do NOT early-return when the highlight banner is absent. GQL auto-claim
  // below needs no on-page element, and .community-highlight only appears
  // intermittently, so gating on it would stop auto-claim from ever firing.

  // Find a DOM claim button only when the highlight banner is present (a quick
  // path when available). GQL claimDrop is the reliable fallback below.
  let claimBtn = null;
  if (domContainer) {
    const allButtons = domContainer.querySelectorAll('button:not([disabled])');
    for (const btn of allButtons) {
      const txt = (btn.textContent || '').toLowerCase();
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (txt.includes('claim') || aria.includes('claim')) {
        claimBtn = btn;
        break;
      }
    }
  }

  // Use supplemented campaigns - same data that was reported above
  if (supplemented.length > 0) {
    for (const campaign of supplemented) {
      if (campaign.activeDropIndex < 0) continue;
      const active = campaign.drops[campaign.activeDropIndex];
      if (active.status !== 'complete') continue;

      if (!canAttemptClaim(active.id)) {
        console.log('[Twitch Miner] Claim debounced for:', active.benefitName);
        continue;
      }

      if (claimBtn) {
        // DOM click path - primary claim method
        console.log('[Twitch Miner] Drop ready - auto-claiming tier:', active.benefitName);
        claimState.inProgress = true;
        claimedDropIds.add(active.id);

        // 500ms delay for Twitch's React state to settle before clicking
        await new Promise(r => setTimeout(r, 500));
        claimBtn.click();

        sendMessage('DROP_CLAIMED', {
          campaignId: campaign.id,
          dropId: active.id,
          dropName: active.benefitName,
          gameImage: campaign.gameImage,
          dropImage: active.benefitImage,
        });

        recordClaimAttempt(active.id, true);
        return;
      }

      // GQL claimDrop fallback - uses the inventory instance id for this drop
      console.log('[Twitch Miner] No DOM claim button - trying GQL claimDrop for:', active.benefitName);
      claimState.inProgress = true;
      let instanceId = active.instanceId;
      if (!instanceId) {
        // Completed drop whose dropInstanceID hasn't synced yet - force a fresh
        // inventory pull so we can claim via GQL right away.
        inventoryFetchTime = 0;
        await fetchInventory();
        instanceId = inventoryProgress[active.id]?.instanceId || null;
      }
      const result = await claimDrop(instanceId);
      if (result && result.ok) {
        claimedDropIds.add(active.id);
        sendMessage('DROP_CLAIMED', {
          campaignId: campaign.id,
          dropId: active.id,
          dropName: active.benefitName,
          gameImage: campaign.gameImage,
          dropImage: active.benefitImage,
        });
        recordClaimAttempt(active.id, true);
      } else {
        // Don't consume retry budget on GQL failures - mutation may be wrong.
        // Stamp lastAttempt so the debounce throttles retries (and the inventory
        // refresh above) to once per CLAIM_DEBOUNCE_MS instead of every scan.
        console.error('[Twitch Miner] GQL claimDrop failed (not counting as retry):', result?.error);
        claimState.inProgress = false;
        claimState.lastAttempt = Date.now();
      }
      return;
    }
  }

  // Fallback: no GQL data - use DOM progress bar (requires the highlight DOM)
  if (!hasCache && domContainer) {
    const progressBar = domContainer.querySelector('[role="progressbar"].tw-progress-bar');
    if (!progressBar) return;
    const highlightEl = domContainer.querySelector('[class*="dropsHighlight"]');
    const lines = (highlightEl?.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
    const domName = lines[1] || lines[0] || '';
    const domKey = normalizeCampaign(domName);

    // Use claimedFallbackKeys Set instead of window flag
    if (claimedFallbackKeys.has(domKey)) return;

    const valuenow = parseInt(progressBar.getAttribute('aria-valuenow'), 10);
    const valuemaxAttr = parseInt(progressBar.getAttribute('aria-valuemax'), 10);
    const hasRealMax = !isNaN(valuemaxAttr) && valuemaxAttr > 0;
    const valuemax = hasRealMax ? valuemaxAttr : 100;
    if (!isNaN(valuenow) && valuemax > 0) {
      const fallbackProgress = Math.min(100, Math.max(0, Math.round((valuenow / valuemax) * 100)));
      const fallbackId = domKey ? 'dom-' + domKey.slice(0, 48) : 'dom-unknown';

      // Twitch's drop progress bar reports watched/required MINUTES in its aria
      // attributes. The downstream fields are in seconds, so convert. When
      // aria-valuemax is absent we only have a percentage (valuemax defaulted to
      // 100), so emit 0 for the absolute times and let the popup show % only
      // rather than display a wrong duration like "60s" for an hour-long drop.
      const reqSecs = hasRealMax ? valuemax * 60 : 0;
      const curSecs = hasRealMax ? valuenow * 60 : 0;

      sendMessage('CAMPAIGN_PROGRESS', {
        campaignId: fallbackId,
        campaignName: domName || 'Unknown Drop',
        gameName: currentChannel || 'Unknown',
        gameImage: '',
        campaignProgress: fallbackProgress,
        totalRequiredSeconds: reqSecs,
        totalEarnedSeconds: curSecs,
        activeDropIndex: 0,
        drops: [{
          id: fallbackId + '-drop0',
          name: domName || 'Unknown Drop',
          image: '',
          requiredSeconds: reqSecs,
          currentSeconds: curSecs,
          progress: fallbackProgress,
          status: fallbackProgress >= 100 ? 'complete' : 'active',
        }],
      });

      if (claimBtn && canAttemptClaim(fallbackId + '-drop0')) {
        claimState.inProgress = true;
        console.log('[Twitch Miner] Drop ready - auto-claiming via DOM button (fallback)');
        claimedFallbackKeys.add(domKey);
        // 500ms delay before clicking
        await new Promise(r => setTimeout(r, 500));
        claimBtn.click();
        sendMessage('DROP_CLAIMED', {
          campaignId: fallbackId,
          dropId: fallbackId + '-drop0',
          dropName: domName || '',
          gameImage: '',
          dropImage: '',
        });
        recordClaimAttempt(fallbackId + '-drop0', true);
      }
    }
  }
}

// ── Tab-focus reporting ──
// With several Twitch channels open in different tabs, the popup must follow
// the tab the user is actually looking at. The background tracks a single
// "active channel", but it was only set on page load / navigation - never when
// the user switched browser tabs. So we claim active-channel status whenever
// this tab becomes visible/focused, then refresh its data so the popup shows
// the right channel and its campaign. Mining continues in all tabs regardless;
// only the popup's view changes.
let lastFocusReport = 0;
async function reportActiveIfFocused() {
  if (!currentChannel) return;
  if (document.visibilityState !== 'visible') return;
  const now = Date.now();
  if (now - lastFocusReport < 1000) return; // debounce rapid focus/visibility events
  lastFocusReport = now;
  // Set this tab's channel as active (clears any other channel's drops in the
  // background), then poll so the focused channel's points/drops repopulate.
  await sendMessageAsync('CHANNEL_ACTIVE', { channel: currentChannel });
  runPoll();
}

function setupTabFocusReporting() {
  document.addEventListener('visibilitychange', reportActiveIfFocused);
  window.addEventListener('focus', reportActiveIfFocused);
}

function setupRaidDetection() {
  // Watch for the raid banner overlay that appears when a channel you're
  // watching starts a raid to another channel. Auto-join when detected.
  let raidJoined = false;

  // Expose reset for handleUrlChange to clear state on navigation
  window.__twitchMinerResetRaid = () => { raidJoined = false; };

  const observer = new MutationObserver(() => {
    if (raidJoined) return;

    // Try multiple known selectors for Twitch's raid UI
    const joinBtn =
      document.querySelector('button[data-a-target="raid-join-button"]') ||
      document.querySelector('[data-test-selector="raid-join-button"]') ||
      document.querySelector('.raid-banner__join-button button');

    if (joinBtn) {
      console.log('[Twitch Miner] Raid detected, auto-joining...');
      raidJoined = true;
      joinBtn.click();
      sendMessage('RAID_JOINED');

      // Reset flag after raid completes so we detect future raids
      setTimeout(() => { raidJoined = false; }, 60000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  console.log('[Twitch Miner] Raid detection active');
}

let lastPath = window.location.pathname;

// Fix 2: Waits for CHANNEL_ACTIVE background acknowledgement before starting
// polls - prevents CAMPAIGN_PROGRESS messages from racing ahead of the
// channel-switch atomic clear in setActiveChannel.
async function handleUrlChange() {
  const newChannel = extractChannel();
  if (newChannel === currentChannel) return;

  const wasOnChannel = !!currentChannel;
  currentChannel = newChannel;
  console.log('[Twitch Miner] Channel changed to:', currentChannel);

  if (window.__twitchMinerResetRaid) window.__twitchMinerResetRaid();
  dropCache = {}; dropCacheChannel = null; dropCacheTime = 0; dropCacheErrorTime = 0;

  // Clear claimed Sets synchronously before async repopulation
  claimedDropIds.clear();
  claimedFallbackKeys.clear();
  restoreClaimedFlags();

  // Leaving channel - stop polling
  if (!currentChannel) {
    if (wasOnChannel) {
      console.log('[Twitch Miner] Left channel - pausing collection');
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    }
    return;
  }

  // Entering or switching - wait for channel ack + auth before starting polls
  await sendMessageAsync('CHANNEL_ACTIVE', { channel: currentChannel });
  await fetchAuthToken().catch(() => {});

  if (!wasOnChannel) {
    console.log('[Twitch Miner] Entered channel - starting collection');
    runPoll();
    if (!pollInterval) pollInterval = setInterval(runPoll, POLL_MS);
    setupRaidDetection();
  } else {
    console.log('[Twitch Miner] Switched channel - running immediate poll');
    runPoll();
  }
}

// Fix 3: Removed the standalone fetchDropMetadata(channel) from the top -
// detectDropsFromDOM() (called at bottom) already fetches it. Keeping both
// was a duplicate that could race.

async function runPoll() {
  if (!isContextValid()) { stopPolling(); return; }
  const channel = currentChannel;
  if (!channel) return;

  let pollStatus = 'ok';
  let pollError = null;
  let pollBalance = null;

  if (!authToken) {
    try { await fetchAuthToken(); } catch { }
  }
  if (!authToken) {
    console.log('[Twitch Miner] No auth token yet, skipping points poll');
    sendMessage('POLL_STATUS', { status: 'no_auth', error: 'No Twitch auth-token cookie found. Are you logged in?', channel });
    return;
  }
  console.log('[Twitch Miner] Polling: channel=', channel);

  const cpResult = await checkAndClaimChannelPoints(channel);
  if (cpResult) {
    pollStatus = cpResult.status;
    pollError = cpResult.error || null;
    pollBalance = cpResult.balance;
  }

  sendMessage('POLL_STATUS', {
    status: pollStatus,
    error: pollError,
    channel,
    balance: pollBalance,
  });

  // Also scan drops now - auth is ready and we're already polling points
  detectDropsFromDOM();
}

let pollInterval = null;

// ── Self-scheduling drop scan loop ──
// Replaces setInterval(detectDropsFromDOM, 3000) which could stack
// concurrent GQL calls if one iteration exceeds 3 seconds.
async function dropScanLoop() {
  // Stop the loop once the extension is reloaded/uninstalled - the orphaned
  // content script would otherwise keep hitting Twitch's GQL endpoint forever.
  if (!isContextValid()) { stopPolling(); return; }
  await detectDropsFromDOM();
  setTimeout(dropScanLoop, 3000);
}

// Fix 3: init() is now async - fetches auth token before starting
// dropScanLoop so GQL calls don't fail on the first cycle.
// Fix 2: waits for CHANNEL_ACTIVE ack before starting polls so
// CAMPAIGN_PROGRESS messages arrive after the channel is set.
async function init() {
  console.log('[Twitch Miner] Starting collection');

  restoreClaimedFlags();

  if (currentChannel) {
    // Fix 2: Wait for channel acknowledgement so background sets activeChannel
    await sendMessageAsync('CHANNEL_ACTIVE', { channel: currentChannel });

    // Fix 3: Fetch auth before starting any GQL-dependent work
    await fetchAuthToken().catch(() => {});

    runPoll();
    pollInterval = setInterval(runPoll, POLL_MS);
    setupRaidDetection();
  }

  // Follow browser-tab focus so the popup tracks the channel the user is viewing
  // when multiple Twitch tabs are open.
  setupTabFocusReporting();
  lastFocusReport = Date.now(); // init already sent CHANNEL_ACTIVE above

  // Fix 3: dropScanLoop starts AFTER auth is available
  dropScanLoop();

  setInterval(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      handleUrlChange();
    }
  }, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
