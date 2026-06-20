let session = null;
let tickInterval = null;
let refreshInterval = null;
let inventoryTabId = null;
let hadDrops = null;

// Fix 6: Stability debounce for tab switching - only switch tabs when
// the drop state has been unchanged for at least 4 seconds, preventing
// flicker during channel navigation.
let hadDropsStable = null;
let hadDropsStableAt = 0;

function openInventory() {
  if (inventoryTabId !== null) {
    chrome.tabs.get(inventoryTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        inventoryTabId = null;
        chrome.tabs.create({ url: 'https://www.twitch.tv/drops/inventory' }, (t) => { if (t) inventoryTabId = t.id; });
      } else {
        chrome.tabs.update(inventoryTabId, { active: true });
        chrome.windows.update(tab.windowId, { focused: true });
      }
    });
  } else {
    chrome.tabs.create({ url: 'https://www.twitch.tv/drops/inventory' }, (t) => { if (t) inventoryTabId = t.id; });
  }
}

const STATUS_DISCONNECTED = 'disconnected';
const STATUS_IDLE = 'idle';
const STATUS_ACTIVE = 'active';
let connectionStatus = STATUS_DISCONNECTED;
let lastActivity = 0;

document.addEventListener('DOMContentLoaded', () => {
  loadSession();
  setupTabs();
  setupReset();
  setupAuthBanner();
  startTick();
  startRefresh();
  pingContentScript();
});

function setupAuthBanner() {
  const btn = document.getElementById('authBannerBtn');
  if (btn) btn.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.twitch.tv/login' });
  });
}

function startTick() {
  tickInterval = setInterval(() => updateSessionTime(), 1000);
}

function startRefresh() {
  // Poll background for updated session data every 2s
  refreshInterval = setInterval(() => loadSession(), 2000);
}

function pingContentScript() {
  // Check if content script is alive by querying for active tab
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return;
      const tab = tabs && tabs[0];
      if (tab && tab.url && tab.url.includes('twitch.tv')) {
        connectionStatus = STATUS_IDLE;
        updateConnectionDot();
      }
    });
  } catch {
    // tabs permission not available - assume connected
    connectionStatus = STATUS_IDLE;
    updateConnectionDot();
  }
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function setupReset() {
  document.getElementById('resetBtn').addEventListener('click', () => {
    if (confirm('Reset session? All current session data will be lost.')) {
      chrome.runtime.sendMessage({ type: 'RESET_SESSION' }, () => loadSession());
    }
  });
}

function loadSession() {
  chrome.runtime.sendMessage({ type: 'GET_SESSION' }, (response) => {
    if (!response) return;
    const prevChannel = session ? session.activeChannel : null;
    const prevKey = prevChannel ? prevChannel.toLowerCase() : null;
    const prevTotal = prevKey ? (session?.points?.[prevKey]?.total || 0) : 0;
    session = response;
    render();
    const key = response.activeChannel ? response.activeChannel.toLowerCase() : null;
    const newTotal = key ? (response.points?.[key]?.total || 0) : 0;
    if (newTotal > prevTotal) {
      lastActivity = Date.now();
      connectionStatus = STATUS_ACTIVE;
    } else if (connectionStatus === STATUS_ACTIVE && Date.now() - lastActivity > 30000) {
      connectionStatus = STATUS_IDLE;
    }
    updateConnectionDot();
  });
}

function updateConnectionDot() {
  const dot = document.getElementById('connectionDot');
  if (!dot) return;
  dot.className = 'connection-dot ' + connectionStatus;
  dot.title = connectionStatus === STATUS_ACTIVE ? 'Active - collecting'
    : connectionStatus === STATUS_IDLE ? 'Connected - waiting'
    : 'No Twitch tab detected';
}

// Balance for the currently active (focused) channel. Tries an exact key match
// first, then a case-insensitive fallback, since balances are keyed by the
// channel name as reported by the content script.
function balanceForActiveChannel(session) {
  const active = session.activeChannel;
  if (!active) return 0;
  const balances = session.pointsBalances || {};
  if (balances[active] && typeof balances[active].balance === 'number') {
    return balances[active].balance;
  }
  const lc = active.toLowerCase();
  for (const [k, v] of Object.entries(balances)) {
    if (k.toLowerCase() === lc && typeof v?.balance === 'number') return v.balance;
  }
  return 0;
}

// The user is logged out when the most recent poll reported no_auth and that
// report is fresh (polls run every ~15s). Staleness matters: if all Twitch tabs
// are closed, polling stops and an old no_auth must not linger as a false alarm.
function isLoggedOut(session) {
  const lp = session && session.lastPoll;
  if (!lp || lp.status !== 'no_auth') return false;
  return typeof lp.at === 'number' && (Date.now() - lp.at) < 45000;
}

function updateAuthBanner() {
  const banner = document.getElementById('authBanner');
  if (!banner) return;
  banner.style.display = isLoggedOut(session) ? 'flex' : 'none';
}

function render() {
  if (!session) return;
  updateAuthBanner();
  // Preserve the campaign id (the storage key) so the Claim button can report
  // which campaign was claimed back to the background.
  const drops = Object.entries(session.drops || {}).map(([id, c]) => ({ ...c, id: c.id || id }));

  // Show/hide drops UI based on whether drops data exists
  const hasDrops = drops.some(c => c.drops && c.drops.length > 0);
  const dropsTab = document.querySelector('.tab[data-tab="drops"]');
  const dropsCard = document.querySelector('.drops-card');
  if (dropsTab) dropsTab.style.display = hasDrops ? '' : 'none';
  if (dropsCard) dropsCard.style.display = hasDrops ? '' : 'none';

  // Fix 6: Stability-gated tab switching - only switch after 4s of unchanged state.
  // `hadDrops` is the baseline for edge detection: the last state we actually
  // ACTED on. It must NOT be overwritten on every render - doing so consumes the
  // `hasDrops !== hadDrops` edge before the 4s stability window elapses, so the
  // auto-switch would never fire and the drops/progress UI would never surface.
  const now = Date.now();
  if (hasDrops !== hadDropsStable) {
    hadDropsStable = hasDrops;
    hadDropsStableAt = now;
  }
  const isStable = (now - hadDropsStableAt) >= 4000;
  if (hadDrops === null) {
    // First render - establish the baseline without auto-switching.
    hadDrops = hasDrops;
  } else if (isStable && hasDrops !== hadDrops) {
    if (hasDrops) {
      // Drops just appeared - switch to drops tab
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      if (dropsTab) dropsTab.classList.add('active');
      document.getElementById('tab-drops').classList.add('active');
    } else {
      // Drops disappeared - switch back to points tab
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      const pointsTab = document.querySelector('.tab[data-tab="points"]');
      if (pointsTab) pointsTab.classList.add('active');
      document.getElementById('tab-points').classList.add('active');
    }
    // Only advance the baseline once we've acted on the stable transition.
    hadDrops = hasDrops;
  }

  const key = session.activeChannel ? session.activeChannel.toLowerCase() : null;
  const channelPoints = key ? (session.points[key]?.total || 0) : 0;

  // Balance must reflect the active (focused) channel, not whichever tab polled
  // most recently - otherwise with several Twitch tabs open the number flips
  // between channels on each poll.
  const activeBalance = balanceForActiveChannel(session);

  document.getElementById('totalPoints').textContent = channelPoints;
  document.getElementById('pointsBalance').textContent = activeBalance.toLocaleString();
  const activeCampaigns = Object.values(session.drops || {});
  const totalCampaignDrops = activeCampaigns.reduce((sum, c) =>
    sum + (c.drops || []).filter(d => d.claimed || d.status === 'gql_claimed').length, 0);
  document.getElementById('totalDrops').textContent = totalCampaignDrops || 0;
  document.getElementById('activeChannels').textContent = session.activeChannel || '-';

  document.getElementById('sessionStart').textContent = formatTime(session.startTime);
  updateSessionTime();

  renderPoints();
  renderDrops(drops);
}

function updateSessionTime() {
  if (!session) return;
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  document.getElementById('sessionTime').textContent = formatDuration(elapsed);
}

function renderPoints() {
  const container = document.getElementById('pointsList');
  container.innerHTML = '';
  let recent = session.recentChannels || [];
  if (!recent.length) {
    recent = Object.keys(session.points || {}).slice(0, 5);
  }
  if (!recent.length) {
    container.innerHTML = '<div class="empty-state">No points claimed this session</div>';
    return;
  }
  for (const key of recent) {
    const p = session.points[key];
    if (!p || !p.total) continue;
    const item = container.appendChild(document.createElement('div'));
    item.className = 'channel-item';
    item.title = `Open twitch.tv/${key}`;
    item.style.cursor = 'pointer';
    item.addEventListener('click', () => {
      chrome.tabs.create({ url: `https://www.twitch.tv/${key}` });
    });

    const avatar = item.appendChild(document.createElement('div'));
    avatar.className = 'channel-avatar';
    if (p.avatar) {
      const img = avatar.appendChild(document.createElement('img'));
      img.src = p.avatar;
      img.alt = '';
    }

    const info = item.appendChild(document.createElement('div'));
    info.className = 'channel-info';

    const cname = info.appendChild(document.createElement('div'));
    cname.className = 'channel-name';
    cname.textContent = key;

    const pts = item.appendChild(document.createElement('div'));
    pts.className = 'channel-points';
    const total = p.total || 0;
    pts.textContent = p.count > 1 ? `+${total.toLocaleString()} (${p.count}x)` : `+${total.toLocaleString()}`;
  }
}

function renderDrops(campaigns) {
  const container = document.getElementById('dropsList');
  container.innerHTML = '';
  const active = campaigns.filter(c => c.drops && c.drops.length);
  if (!active.length) {
    container.innerHTML = '<div class="empty-state">No drops this session</div>';
    return;
  }

  // Sort campaigns by first drop's required time (shortest first)
  active.sort((a, b) => {
    const aMin = (a.drops && a.drops[0]) ? (a.drops[0].requiredSeconds || a.drops[0].required || 0) : Infinity;
    const bMin = (b.drops && b.drops[0]) ? (b.drops[0].requiredSeconds || b.drops[0].required || 0) : Infinity;
    return aMin - bMin;
  });

  for (const c of active) {
    const campaign = container.appendChild(document.createElement('div'));
    campaign.className = 'drop-campaign';

    // ── Campaign header ──
    const game = campaign.appendChild(document.createElement('div'));
    game.className = 'drop-game';
    if (c.gameImage) {
      const img = game.appendChild(document.createElement('img'));
      img.className = 'drop-game-icon';
      img.src = c.gameImage;
      img.alt = '';
      img.loading = 'lazy';
    }
    game.appendChild(document.createTextNode(c.gameName || c.campaignName || 'Unknown'));

    const cname = campaign.appendChild(document.createElement('div'));
    cname.className = 'drop-campaign-name';
    cname.textContent = c.campaignName || '';

    // ── Campaign-level cumulative progress bar ──
    const totalReqSecs = c.totalRequiredSeconds || 0;
    const dropCount = (c.drops || []).length;

    // Fix 7: Skip campaign bar when there's no requirement data (0s/0s), or when
    // the campaign has a single drop - the campaign bar would just duplicate that
    // drop's own bar below it.
    if (totalReqSecs > 0 && dropCount > 1) {
      const campaignProgress = typeof c.campaignProgress === 'number' ? c.campaignProgress : 0;
      const totalEarnedSecs = c.totalEarnedSeconds || 0;
      const remainingSecs = Math.max(0, totalReqSecs - totalEarnedSecs);
      const totalReq = formatDurationCompact(totalReqSecs);
      const totalEarned = formatDurationCompact(totalEarnedSecs);
      const remaining = formatRemaining(remainingSecs);

      const campBarRow = campaign.appendChild(document.createElement('div'));
      campBarRow.className = 'campaign-bar-row';

      const campBarLabel = campBarRow.appendChild(document.createElement('span'));
      campBarLabel.className = 'campaign-bar-label';
      campBarLabel.textContent = remaining
        ? `Campaign ${totalEarned}/${totalReq}  -  ${remaining} left`
        : `Campaign ${totalEarned}/${totalReq}`;

      const campBarPct = campBarRow.appendChild(document.createElement('span'));
      campBarPct.className = 'campaign-bar-pct';
      campBarPct.textContent = `${campaignProgress}%`;

      const campBarTrack = campaign.appendChild(document.createElement('div'));
      campBarTrack.className = 'campaign-bar-track';
      const campBarFill = campBarTrack.appendChild(document.createElement('div'));
      campBarFill.className = 'campaign-bar-fill';
      if (campaignProgress >= 100) campBarFill.classList.add('claimed');
      campBarFill.style.width = `${campaignProgress}%`;
    }

    // ── Per-drop list ──
    // Sort drops by requiredSeconds (tier order)
    const sorted = [...c.drops].sort((a, b) => {
      const aReq = a.requiredSeconds || a.required || 0;
      const bReq = b.requiredSeconds || b.required || 0;
      return aReq - bReq;
    });

    for (const d of sorted) {
      const dropStatus = d.status || (d.claimed ? 'claimed' : 'locked');

      const item = campaign.appendChild(document.createElement('div'));
      item.className = 'drop-item';
      item.style.cursor = 'pointer';
      item.title = 'Open Twitch drops inventory';
      item.addEventListener('click', openInventory);

      const header = item.appendChild(document.createElement('div'));
      header.className = 'drop-header';

      if (d.image) {
        const icon = header.appendChild(document.createElement('img'));
        icon.className = 'drop-icon';
        icon.src = d.image;
        icon.alt = '';
        icon.loading = 'lazy';
      }

      const name = header.appendChild(document.createElement('span'));
      name.className = 'drop-name';
      name.textContent = d.name || 'Drop';

      // Status badge + time label
      const badge = header.appendChild(document.createElement('span'));
      badge.className = 'drop-badge';

      const reqSecs = d.requiredSeconds || (d.required || 0);
      const reqStr = reqSecs > 0 ? formatDurationCompact(reqSecs) : '';

      switch (dropStatus) {
        case 'claimed':
          badge.textContent = 'Claimed';
          badge.classList.add('drop-badge-claimed');
          break;
        case 'gql_claimed':
          // Previously claimed (from GQL in an earlier session)
          badge.textContent = 'Claimed';
          badge.classList.add('drop-badge-prev');
          break;
        case 'complete':
          badge.textContent = 'Ready to claim';
          badge.classList.add('drop-badge-ready');
          break;
        case 'active': {
          const curStr = formatDurationCompact(d.currentSeconds || 0);
          badge.textContent = `${d.progress || 0}% - ${curStr} / ${reqStr}`;
          badge.classList.add('drop-badge-active');
          break;
        }
        case 'locked':
        default: {
          const pct = d.progress || 0;
          badge.textContent = reqStr ? `Locked (${reqStr}) · ${pct}%` : `Locked · ${pct}%`;
          badge.classList.add('drop-badge-locked');
          break;
        }
      }

      // Per-drop mini progress bar
      const barTrack = item.appendChild(document.createElement('div'));
      barTrack.className = 'drop-bar-track';

      const barFill = barTrack.appendChild(document.createElement('div'));
      barFill.className = 'drop-bar-fill';
      if (dropStatus === 'claimed') barFill.classList.add('claimed');
      if (dropStatus === 'gql_claimed') barFill.classList.add('gql-claimed');
      if (dropStatus === 'complete') barFill.classList.add('complete');
      if (dropStatus === 'locked') barFill.classList.add('locked');
      if (dropStatus === 'active') barFill.classList.add('active');

      if (dropStatus === 'claimed' || dropStatus === 'gql_claimed') {
        barFill.style.width = '100%';
      } else {
        barFill.style.width = `${d.progress || 0}%`;
      }

      // ── Claim button for completed (ready-to-claim) drops ──
      if (dropStatus === 'complete') {
        const claimBtn = item.appendChild(document.createElement('button'));
        claimBtn.className = 'drop-claim-btn';
        claimBtn.textContent = 'Claim Drop';
        claimBtn.addEventListener('click', (ev) => {
          ev.stopPropagation(); // don't trigger the row's open-inventory handler
          requestClaim(c, d, claimBtn);
        });
      }
    }
  }
}

// Ask the active Twitch tab (via the background relay) to claim a completed drop.
// On success the content script emits DROP_CLAIMED, so a refresh reflects it.
function requestClaim(campaign, drop, btnEl) {
  if (btnEl.disabled) return;
  btnEl.disabled = true;
  btnEl.classList.add('claiming');
  btnEl.textContent = 'Claiming…';

  chrome.runtime.sendMessage({
    type: 'CLAIM_DROP',
    data: {
      campaignId: campaign.id || campaign.campaignId,
      dropId: drop.id,
      dropInstanceId: drop.instanceId || '',
      dropName: drop.name || '',
    },
  }, (res) => {
    btnEl.classList.remove('claiming');
    if (chrome.runtime.lastError || !res || !res.ok) {
      btnEl.disabled = false;
      btnEl.classList.add('claim-error');
      btnEl.textContent = 'Retry claim';
      const msg = (res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'Claim failed';
      btnEl.title = msg;
      setTimeout(() => btnEl.classList.remove('claim-error'), 2500);
    } else {
      btnEl.classList.add('claim-done');
      btnEl.textContent = '✓ Claimed';
      loadSession();
    }
  });
}

// Format remaining time as Xh Ym (e.g. "2h 30m")
function formatRemaining(secs) {
  if (secs <= 0) return '';
  const totalMin = Math.ceil(secs / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatDurationCompact(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  return h % 1 === 0 ? `${h}h` : `${h.toFixed(1)}h`;
}

function formatDuration(secs) {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (rm > 0) return s ? `${h}h ${rm}m ${s}s` : `${h}h ${rm}m`;
  return s ? `${h}h ${s}s` : `${h}h`;
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
