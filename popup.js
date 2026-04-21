'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Canvas Companion — popup.js
//
//  The popup serves as the settings + setup panel.
//  It handles:
//    • First-run domain setup with connection validation
//    • Requesting host permissions for the user's Canvas domain
//    • Dynamically registering (or updating) the content script
//    • Display settings: lookahead window, overdue toggle
//    • Domain change / re-check flows
// ─────────────────────────────────────────────────────────────────────────────

const SCRIPT_ID = 'cc-main'; // Must match background.js

// ── Storage helpers ───────────────────────────────────────────────────────────

const SETTING_DEFAULTS = {
  domain: '',
  lookahead: 7,
  showOverdue: true,
};

async function getSettings() {
  return new Promise((r) => chrome.storage.sync.get(SETTING_DEFAULTS, r));
}

async function saveSettings(patch) {
  return new Promise((r) => chrome.storage.sync.set(patch, r));
}

// ── Permission helpers ────────────────────────────────────────────────────────

/**
 * Request host permission for the given domain.
 * Must be called directly in a user-gesture handler (button click).
 * Chrome will show its own permission prompt to the user.
 *
 * @param {string} domain — e.g. "canvas.pdx.edu"
 * @returns {boolean} whether the permission was granted
 */
async function requestHostPermission(domain) {
  return chrome.permissions.request({
    origins: [`https://${domain}/*`],
  });
}

// ── Connection check ──────────────────────────────────────────────────────────

/**
 * Ping the Canvas todo API using cookie-based auth.
 * Works because we have host permission AND the user is already logged in.
 *
 * Throws a typed error so the caller can show a meaningful message.
 */
async function testConnection(domain) {
  let res;
  try {
    res = await fetch(
      `https://${domain}/api/v1/users/self/todo?per_page=1`,
      { credentials: 'include' } // use the browser's Canvas session cookie
    );
  } catch {
    throw { kind: 'network' };
  }

  if (res.status === 401) throw { kind: 'auth' };
  if (!res.ok)            throw { kind: 'http', status: res.status };
  return true;
}

// ── Content script registration ───────────────────────────────────────────────

/**
 * Register (or update) the content script for `domain`.
 * Called after a successful connection check.
 *
 * Registered scripts persist across browser restarts (persistAcrossSessions).
 * If the domain changes, we call updateContentScripts to swap the match pattern.
 */
async function registerContentScript(domain) {
  const def = {
    id: SCRIPT_ID,
    matches: [`https://${domain}/*`],
    js: ['content.js'],
    css: ['content.css'],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };

  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [SCRIPT_ID],
  });

  if (existing.length > 0) {
    await chrome.scripting.updateContentScripts([def]);
  } else {
    await chrome.scripting.registerContentScripts([def]);
  }
}

// ── Combined "check and save" flow ────────────────────────────────────────────

/**
 * Full setup sequence triggered by the user clicking "Check Connection":
 *   1. Sanitise domain input
 *   2. Request host permission (Chrome shows its own dialog)
 *   3. Test connection via cookie auth
 *   4. Save domain to storage
 *   5. Register content script
 *   6. Tell background to refresh its badge
 *
 * Returns the sanitised domain string on success, or throws on failure.
 */
async function checkAndSave(rawDomain) {
  const domain = rawDomain
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '');

  if (!domain) throw { kind: 'empty' };

  // Step 1 — permission (must happen inside a user gesture, which this is)
  const granted = await requestHostPermission(domain);
  if (!granted) throw { kind: 'denied' };

  // Step 2 — validate the connection
  await testConnection(domain);

  // Step 3 — persist domain
  await saveSettings({ domain });

  // Step 4 — register content script for this domain
  await registerContentScript(domain);

  // Step 5 — refresh badge in background
  chrome.runtime.sendMessage({ type: 'REFRESH_BADGE' });

  return domain;
}

// ── UI utilities ──────────────────────────────────────────────────────────────

function showView(id) {
  document.getElementById('view-setup').classList.toggle('hidden', id !== 'view-setup');
  document.getElementById('view-settings').classList.toggle('hidden', id !== 'view-settings');
}

/**
 * Display a status message below a form.
 * @param {string} elId    — element ID of the status container
 * @param {'ok'|'error'|'info'} kind
 * @param {string} text
 */
function showStatus(elId, kind, text) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = text;
  el.className = `status-msg status-msg--${kind}`;
  el.classList.remove('hidden');
}

function hideStatus(elId) {
  document.getElementById(elId)?.classList.add('hidden');
}

function setConnPill(kind, text) {
  const pill = document.getElementById('conn-pill');
  pill.textContent = text;
  pill.className = `conn-pill conn-pill--${kind}`;
}

function setInputError(rowId, on) {
  document.getElementById(rowId)?.classList.toggle('input-row--error', on);
}

function setButtonLoading(btn, loading, originalText) {
  btn.disabled = loading;
  btn.textContent = loading ? 'Checking…' : originalText;
}

// ── Setup view ────────────────────────────────────────────────────────────────

function initSetupView() {
  const checkBtn = document.getElementById('setup-check-btn');
  const input    = document.getElementById('setup-domain-input');

  // Allow pressing Enter in the input
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') checkBtn.click();
  });

  checkBtn.addEventListener('click', async () => {
    const raw = input.value;
    hideStatus('setup-status');
    setInputError('setup-input-row', false);
    setButtonLoading(checkBtn, true, 'Check Connection');

    try {
      const domain = await checkAndSave(raw);
      showStatus('setup-status', 'ok', '✓ Connected! Reload your Canvas tab to see assignments.');
      // Small delay so the user can read the success message
      setTimeout(() => initSettingsView(domain), 1200);
    } catch (err) {
      setInputError('setup-input-row', true);
      showStatus('setup-status', 'error', errorMessage(err));
    } finally {
      setButtonLoading(checkBtn, false, 'Check Connection');
    }
  });
}

// ── Settings view ─────────────────────────────────────────────────────────────

async function initSettingsView(domain) {
  showView('view-settings');

  // Update header Open-Canvas link
  const link = document.getElementById('open-canvas-link');
  link.href = `https://${domain}`;
  link.classList.remove('hidden');

  document.getElementById('domain-display').textContent = domain;

  // Load saved display settings into the form
  const settings = await getSettings();
  document.getElementById('lookahead-input').value   = settings.lookahead;
  document.getElementById('show-overdue-toggle').checked = settings.showOverdue;

  // ── Async connection ping ──
  setConnPill('checking', 'Checking…');
  try {
    await testConnection(domain);
    setConnPill('ok', '✓ Connected');
  } catch (err) {
    setConnPill('error', errorMessage(err, true));
  }

  // ── Re-check button ────────────────────────────────────────────────────────
  document.getElementById('recheck-btn').addEventListener('click', async () => {
    setConnPill('checking', 'Checking…');
    try {
      await testConnection(domain);
      setConnPill('ok', '✓ Connected');
    } catch (err) {
      setConnPill('error', errorMessage(err, true));
    }
  });

  // ── Change domain toggle ───────────────────────────────────────────────────
  document.getElementById('show-change-btn').addEventListener('click', () => {
    const form = document.getElementById('change-domain-form');
    const isHidden = form.classList.contains('hidden');
    form.classList.toggle('hidden', !isHidden);
    if (isHidden) {
      document.getElementById('change-domain-input').value = domain;
      document.getElementById('change-domain-input').focus();
      hideStatus('change-status');
    }
  });

  document.getElementById('cancel-change-btn').addEventListener('click', () => {
    document.getElementById('change-domain-form').classList.add('hidden');
    hideStatus('change-status');
  });

  // ── Change domain — check & save ───────────────────────────────────────────
  const changeBtn = document.getElementById('change-check-btn');
  changeBtn.addEventListener('click', async () => {
    const raw = document.getElementById('change-domain-input').value;
    hideStatus('change-status');
    setInputError('change-input-row', false);
    setButtonLoading(changeBtn, true, 'Check & Save');

    try {
      const newDomain = await checkAndSave(raw);
      domain = newDomain; // update closure variable
      document.getElementById('domain-display').textContent = newDomain;
      document.getElementById('open-canvas-link').href = `https://${newDomain}`;
      showStatus('change-status', 'ok', '✓ Saved! Reload Canvas to apply.');
      setConnPill('ok', '✓ Connected');
    } catch (err) {
      setInputError('change-input-row', true);
      showStatus('change-status', 'error', errorMessage(err));
    } finally {
      setButtonLoading(changeBtn, false, 'Check & Save');
    }
  });

  // ── Display settings ───────────────────────────────────────────────────────
  document.getElementById('save-display-btn').addEventListener('click', async () => {
    const lookahead    = parseInt(document.getElementById('lookahead-input').value, 10);
    const showOverdue  = document.getElementById('show-overdue-toggle').checked;

    if (isNaN(lookahead) || lookahead < 1) {
      document.getElementById('lookahead-input').focus();
      return;
    }

    await saveSettings({ lookahead, showOverdue });

    const confirm = document.getElementById('save-confirm');
    confirm.classList.remove('hidden');
    setTimeout(() => confirm.classList.add('hidden'), 2000);
  });
}

// ── Error message helper ──────────────────────────────────────────────────────

/**
 * Map typed errors to user-friendly strings.
 * @param {object} err — structured error from checkAndSave / testConnection
 * @param {boolean} short — use short form for the pill
 */
function errorMessage(err, short = false) {
  switch (err?.kind) {
    case 'empty':   return 'Please enter a domain.';
    case 'denied':  return 'Permission not granted. Please click "Allow" when prompted.';
    case 'auth':    return short
      ? '✗ Not logged in'
      : 'Not logged in. Log into Canvas in this browser first, then try again.';
    case 'network': return short
      ? '✗ Unreachable'
      : 'Could not reach that domain. Check the spelling and your internet connection.';
    case 'http':    return short
      ? `✗ Error ${err.status}`
      : `Server returned ${err.status}. Double-check your domain.`;
    default:        return short ? '✗ Failed' : 'Something went wrong. Please try again.';
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function init() {
  // Wire up the options page button (available in both views)
  document.getElementById('open-options-btn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const { domain } = await getSettings();

  if (!domain) {
    showView('view-setup');
    initSetupView();
  } else {
    await initSettingsView(domain);
  }
}

document.addEventListener('DOMContentLoaded', init);
