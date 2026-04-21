'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Canvas Companion — background.js  (service worker)
//
//  Responsibilities:
//    1. On install / update: defensively re-register the content script so
//       it isn't lost if the extension was updated or reinstalled.
//    2. Refresh the badge counter on a timer and on demand.
//
//  NOTE: chrome.permissions.request() and chrome.scripting.registerContentScripts()
//  are both called from popup.js (they need a user-gesture or extension-page
//  context). The background only needs to re-register on startup as a safety net.
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_ID = 'cc-main';

// ── Startup / install ─────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // Re-register the content script for the saved domain (if any).
  // Dynamic registrations survive restarts, but an extension *update*
  // can clear them, so we always re-register here to be safe.
  await safeReregister();

  chrome.alarms.create('badge-refresh', { periodInMinutes: 15 });
  updateBadge();
});

// Re-register on service-worker startup too (handles browser restart edge cases)
chrome.runtime.onStartup.addListener(safeReregister);

// ── Alarm & message handlers ──────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'badge-refresh') updateBadge();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'REFRESH_BADGE') updateBadge();
});

// ── Content script registration ───────────────────────────────────────────────

/**
 * Re-register (or update) the content script for the currently saved domain.
 * Called on install/update/startup. It's a no-op if no domain is stored yet.
 */
async function safeReregister() {
  const domain = await getStoredDomain();
  if (!domain) return;

  await registerContentScript(domain).catch((err) => {
    console.warn('[CC] Could not re-register content script:', err.message);
  });
}

/**
 * Register the content script for `domain`, creating or updating the
 * existing registration as needed.
 *
 * @param {string} domain — e.g. "canvas.pdx.edu"
 */
async function registerContentScript(domain) {
  const def = {
    id: SCRIPT_ID,
    matches: [`https://${domain}/*`],
    js: ['content.js'],
    css: ['content.css'],
    runAt: 'document_idle',
    persistAcrossSessions: true, // Survives browser restarts (Chrome 96+)
  };

  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });

  if (existing.length > 0) {
    await chrome.scripting.updateContentScripts([def]);
  } else {
    await chrome.scripting.registerContentScripts([def]);
  }
}

// ── Badge ─────────────────────────────────────────────────────────────────────

/**
 * Fetch the todo count and update the extension badge.
 *
 * Auth strategy (in order):
 *   1. Cookie-based (credentials: 'include') — works if the user is logged in
 *      and the extension has host permission for the domain.
 *   2. API token fallback — for users who configured a token in Options.
 *
 * The badge is silently cleared on any failure to avoid alarming the user.
 */
async function updateBadge() {
  const domain = await getStoredDomain();
  if (!domain) {
    setBadge('');
    return;
  }

  // Try cookie auth first (no token needed if user is already logged in)
  const cookieHeaders = {};
  const token = await getSetting('token');
  if (token) cookieHeaders['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(
      `https://${domain}/api/v1/users/self/todo?per_page=50`,
      {
        credentials: 'include', // send Canvas session cookie
        headers: cookieHeaders, // also send token if available
      }
    );

    if (!res.ok) {
      setBadge('');
      return;
    }

    const todos = await res.json();
    const count = todos.length;

    if (count > 0) {
      chrome.action.setBadgeBackgroundColor({ color: '#E66000' });
      setBadge(count > 99 ? '99+' : String(count));
    } else {
      setBadge('');
    }
  } catch {
    // Network error — silently clear badge
    setBadge('');
  }
}

function setBadge(text) {
  chrome.action.setBadgeText({ text });
}

// ── Storage helpers ───────────────────────────────────────────────────────────

async function getStoredDomain() {
  return getSetting('domain');
}

async function getSetting(key) {
  return new Promise((resolve) => {
    chrome.storage.sync.get([key], (r) => resolve(r[key] || null));
  });
}
