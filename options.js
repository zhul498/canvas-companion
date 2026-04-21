'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Canvas Companion — options.js
//
//  Advanced settings page. The primary domain setup now lives in the popup.
//  This page handles:
//    • Optional API token (only needed for background badge updates when
//      cookie-based auth fails in the service worker context)
//    • Behavior preferences (link target, done behavior, date format)
//    • Display preferences (show overdue, lookahead days)
//    • Data management (reset dismissed items, clear all)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  domain:       '',
  token:        '',       // Optional: only used by background.js for badge
  newTab:       true,
  doneBehavior: 'hide',
  dateFormat:   'relative',
  showOverdue:  true,
  lookahead:    7,        // default changed from 14 → 7 to match popup default
};

async function loadSettings() {
  return new Promise((resolve) => chrome.storage.sync.get(DEFAULTS, resolve));
}

async function saveSettings(settings) {
  return new Promise((resolve) => chrome.storage.sync.set(settings, resolve));
}

async function init() {
  const settings = await loadSettings();

  // Populate fields
  document.getElementById('domain').value            = settings.domain || '';
  document.getElementById('token').value             = settings.token  || '';
  document.getElementById('new-tab').checked         = settings.newTab;
  document.getElementById('show-overdue').checked    = settings.showOverdue;
  document.getElementById('lookahead').value         = settings.lookahead;

  document.querySelectorAll('input[name="done-behavior"]').forEach((r) => {
    r.checked = r.value === settings.doneBehavior;
  });
  document.querySelectorAll('input[name="date-format"]').forEach((r) => {
    r.checked = r.value === settings.dateFormat;
  });

  // Toggle token visibility
  document.getElementById('toggle-token').addEventListener('click', () => {
    const inp  = document.getElementById('token');
    inp.type   = inp.type === 'password' ? 'text' : 'password';
  });

  // Test connection (uses token if provided, cookie auth otherwise)
  document.getElementById('test-btn').addEventListener('click', testConnection);

  // Save all settings
  document.getElementById('save-btn').addEventListener('click', async () => {
    await doSave();
    const msg = document.getElementById('save-msg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2500);
    // Ask background to refresh its badge with the new token/domain
    chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });
  });

  // Reset dismissed items
  document.getElementById('clear-dismissed').addEventListener('click', () => {
    if (!confirm('Reset all dismissed items? They will reappear in the popup.')) return;
    chrome.storage.local.set({ dismissed: [], strikethrough: [] });
  });

  // Clear everything
  document.getElementById('clear-all').addEventListener('click', () => {
    if (!confirm('Clear ALL Canvas Companion data including domain and settings?\nYou will need to set up the extension again.')) return;
    chrome.storage.sync.clear();
    chrome.storage.local.clear();
    location.reload();
  });
}

async function doSave() {
  const settings = {
    domain:       document.getElementById('domain').value.trim()
                    .replace(/^https?:\/\//, '').replace(/\/$/, ''),
    token:        document.getElementById('token').value.trim(),
    newTab:       document.getElementById('new-tab').checked,
    showOverdue:  document.getElementById('show-overdue').checked,
    lookahead:    parseInt(document.getElementById('lookahead').value, 10) || 7,
    doneBehavior: document.querySelector('input[name="done-behavior"]:checked')?.value || 'hide',
    dateFormat:   document.querySelector('input[name="date-format"]:checked')?.value || 'relative',
  };
  await saveSettings(settings);
  return settings;
}

/**
 * Test the Canvas connection.
 * Prefers token auth if a token is entered; falls back to cookie auth.
 * Provides clear instructions if neither works.
 */
async function testConnection() {
  const domain = document.getElementById('domain').value.trim()
    .replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token  = document.getElementById('token').value.trim();
  const result = document.getElementById('test-result');

  result.textContent  = 'Testing…';
  result.className    = 'test-result';

  if (!domain) {
    result.textContent = '⚠ Please enter a Canvas domain first.';
    result.classList.add('error');
    return;
  }

  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;

  try {
    const res = await fetch(
      `https://${domain}/api/v1/users/self/profile`,
      { headers, credentials: 'include' }
    );

    if (res.ok) {
      const data   = await res.json();
      const name   = data.name || data.login_id || 'User';
      const method = token ? 'API token' : 'session cookie';
      result.textContent = `✓ Connected as "${name}" via ${method} (${domain})`;
      result.classList.add('success');
    } else if (res.status === 401) {
      result.innerHTML = token
        ? '✗ Invalid token — check <strong>Account → Settings → Approved Integrations</strong> in Canvas.'
        : '✗ Not logged in and no token provided. Log into Canvas in this browser, or add an API token below.';
      result.classList.add('error');
    } else {
      result.textContent = `✗ Server returned ${res.status}. Double-check your domain.`;
      result.classList.add('error');
    }
  } catch {
    result.textContent = `✗ Could not reach ${domain}. Check your domain spelling and internet connection.`;
    result.classList.add('error');
  }
}

document.addEventListener('DOMContentLoaded', init);
