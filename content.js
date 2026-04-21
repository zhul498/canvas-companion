"use strict";

// ─────────────────────────────────────────────────────────────────────────────
//  Canvas Companion — content.js  (v2.1)
//
//  Injected into the Canvas LMS dashboard at runtime via
//  chrome.scripting.registerContentScripts() after the user sets up their domain.
//
//  Changes in v2.1:
//    - Switched from /users/self/todo  →  /planner/items with explicit date range.
//      The old endpoint has a hard ~7-day server-side cap that Canvas controls;
//      planner/items lets us request any window (e.g. 30 days).
//    - Rows are now built with createElement so each gets a real click handler.
//    - Clicking a row (but NOT the title link) toggles struck/dismissed state,
//      honouring the doneBehavior setting from Options.
//    - Struck/dismissed keys are persisted to chrome.storage.local and restored
//      on every page load — no in-memory caching between navigations.
// ─────────────────────────────────────────────────────────────────────────────

const CC = "cc"; // CSS namespace prefix — must match content.css
const INJECTED = "data-cc-done"; // Sentinel attribute so we never double-inject

// ── Settings ──────────────────────────────────────────────────────────────────
// Keys must match the DEFAULTS objects in popup.js and options.js.

const SYNC_DEFAULTS = {
  lookahead: 7,
  showOverdue: true,
  doneBehavior: "hide", // 'hide' | 'strike'
};

const LOCAL_DEFAULTS = {
  cc_dismissed: [], // array of item keys hidden by the user
  cc_struck: [], // array of item keys struck through by the user
};

function getSyncSettings() {
  return new Promise((r) => chrome.storage.sync.get(SYNC_DEFAULTS, r));
}

function getLocalState() {
  return new Promise((r) => chrome.storage.local.get(LOCAL_DEFAULTS, r));
}

function saveLocalState(dismissedSet, struckSet) {
  return chrome.storage.local.set({
    cc_dismissed: [...dismissedSet],
    cc_struck: [...struckSet],
  });
}

// ── Canvas Planner API ────────────────────────────────────────────────────────

/**
 * Fetch ALL planner items within the relevant date window, following pagination.
 *
 * Why planner/items instead of users/self/todo?
 *   The todo endpoint has a hard server-side cap of ~7 days regardless of what
 *   the client requests.  The planner endpoint accepts explicit start_date /
 *   end_date parameters and returns everything in that range.
 *
 * Auth: cookie-based — this script runs on the Canvas page itself, so the
 * browser sends the session cookie automatically.  No API token needed.
 *
 * @param {number}  lookaheadDays — how many future days to include
 * @param {boolean} showOverdue   — whether to include past-due items
 */
async function fetchPlannerItems(lookaheadDays, showOverdue) {
  // Build the date window
  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(now.getDate() + lookaheadDays);

  // For overdue items, look back up to 60 days.  If overdue is off, start today.
  const startDate = new Date(now);
  if (showOverdue) startDate.setDate(now.getDate() - 60);

  // Canvas expects YYYY-MM-DD
  const fmt = (d) => d.toISOString().split("T")[0];

  const items = [];
  let url = `/api/v1/planner/items?start_date=${fmt(startDate)}&end_date=${fmt(endDate)}&per_page=50`;

  while (url) {
    const res = await fetch(url);

    if (!res.ok) {
      console.warn(`[CC] planner/items returned ${res.status}`);
      break;
    }

    const page = await res.json();
    items.push(...page);

    // Follow Canvas pagination via the Link response header
    // Format: <https://…>; rel="next", <https://…>; rel="last"
    const link = res.headers.get("Link") || "";
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return items;
}

// ── Item data helpers (planner item shape) ────────────────────────────────────
// Planner items look like:
//   { course_id, plannable_id, plannable_type, plannable_date,
//     plannable: { title, due_at, html_url, submission_types }, submissions }

/** Unique storage key for an item — used to track struck/dismissed state. */
function itemKey(item) {
  return `cc_${item.course_id}_${item.plannable_type}_${item.plannable_id}`;
}

function getDueAt(item) {
  // prefer the specific due_at over the plannable_date (which can be an override)
  return item.plannable?.due_at || item.plannable_date || null;
}

function getItemName(item) {
  return item.plannable?.title || item.plannable?.name || "Untitled";
}

function getItemUrl(item) {
  // The planner API sometimes omits html_url on the plannable object.
  // If it is present, use it directly (it is already a full URL).
  if (item.plannable?.html_url) return item.plannable.html_url;

  // Otherwise, construct a reliable URL from the parts we always have.
  const cid = item.course_id;
  const pid = item.plannable_id;
  if (!cid || !pid) return null;

  switch (item.plannable_type) {
    case "assignment":
      return `/courses/${cid}/assignments/${pid}`;
    case "quiz":
      return `/courses/${cid}/quizzes/${pid}`;
    case "discussion_topic":
      return `/courses/${cid}/discussion_topics/${pid}`;
    // Wiki pages use a URL slug, not a numeric ID
    case "wiki_page":
      return `/courses/${cid}/pages/${item.plannable?.url || pid}`;
    case "calendar_event":
      return `/calendar_events/${pid}`;
    default:
      return `/courses/${cid}`;
  }
}

function getItemType(item) {
  switch (item.plannable_type) {
    case "quiz":
      return "Quiz";
    case "discussion_topic":
      return "Discussion";
    case "wiki_page":
      return "Page";
    case "calendar_event":
      return "Event";
    case "planner_note":
      return "Note";
    default: {
      const types = item.plannable?.submission_types || [];
      if (types.includes("discussion_topic")) return "Discussion";
      if (types.includes("online_upload")) return "File Upload";
      if (types.includes("media_recording")) return "Media";
      return "Assignment";
    }
  }
}

// ── Grouping ──────────────────────────────────────────────────────────────────

/**
 * Group planner items by course ID, sorted soonest-due first.
 * Items without a course_id (personal notes, etc.) are skipped because
 * we have no card to inject them into.
 *
 * @param {Array} items — raw planner items from the API
 * @returns {Map<string, Array>}  courseId → items[]
 */
function groupByCourse(items) {
  const map = new Map();

  for (const item of items) {
    // Skip items not attached to a course (can't match to a dashboard card)
    if (!item.course_id) continue;

    const cid = String(item.course_id);
    if (!map.has(cid)) map.set(cid, []);
    map.get(cid).push(item);
  }

  // Sort each bucket soonest-due first; undated items go to the end
  for (const [, bucket] of map) {
    bucket.sort((a, b) => {
      const da = getDueAt(a);
      const db = getDueAt(b);
      if (!da && !db) return 0;
      if (!da) return 1;
      if (!db) return -1;
      return new Date(da) - new Date(db);
    });
  }

  return map;
}

// ── Due date formatting ───────────────────────────────────────────────────────

/**
 * @returns {{ label: string, status: 'overdue'|'soon'|'ok' }}
 * 'soon'   = due within 48 h
 * 'overdue'= past due OR due within 1 h (shown in red either way)
 */
function formatDue(dueAt) {
  if (!dueAt) return { label: "No due date", status: "ok" };

  const due = new Date(dueAt);
  const now = new Date();
  const diffMs = due - now;
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffD = Math.floor(diffMs / 86_400_000);

  if (diffMs < 0) {
    const ageD = Math.ceil(Math.abs(diffMs) / 86_400_000);
    return {
      label: ageD === 1 ? "1d overdue" : `${ageD}d overdue`,
      status: "overdue",
    };
  }
  if (diffMs < 48 * 3_600_000) {
    if (diffH < 1) return { label: "< 1h left", status: "overdue" };
    if (diffH < 24) return { label: `${diffH}h left`, status: "soon" };
    return { label: "Tomorrow", status: "soon" };
  }

  const label = due.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return { label, status: "ok" };
}

// ── Strike / dismiss toggle ───────────────────────────────────────────────────

/**
 * Toggle the done-state of a row element, then persist the change.
 *
 * @param {string}  key          — itemKey() for this assignment
 * @param {Element} rowEl        — the .cc-row DOM element
 * @param {string}  doneBehavior — 'hide' | 'strike'
 * @param {Set}     dismissedSet — shared mutable Set, updated in-place
 * @param {Set}     struckSet    — shared mutable Set, updated in-place
 */
async function toggleDone(key, rowEl, doneBehavior, dismissedSet, struckSet) {
  const alreadyDone = dismissedSet.has(key) || struckSet.has(key);

  // Always clear both states first (handles switching doneBehavior mid-session)
  dismissedSet.delete(key);
  struckSet.delete(key);
  rowEl.classList.remove(`${CC}-row--struck`, `${CC}-row--dismissed`);

  if (!alreadyDone) {
    // Not done yet → mark it
    if (doneBehavior === "strike") {
      struckSet.add(key);
      rowEl.classList.add(`${CC}-row--struck`);
    } else {
      // 'hide' (default)
      dismissedSet.add(key);
      rowEl.classList.add(`${CC}-row--dismissed`);
    }
  }
  // If alreadyDone: we just cleared the state → item is "un-done"

  await saveLocalState(dismissedSet, struckSet);
}

// ── HTML escaping ─────────────────────────────────────────────────────────────

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Panel / row builders ──────────────────────────────────────────────────────

/**
 * Build a single assignment row element.
 * Clicking the row (but NOT the title link) toggles struck/dismissed.
 * Clicking the title link navigates to the assignment as normal.
 *
 * @param {object} item
 * @param {string} doneBehavior
 * @param {Set}    dismissedSet  — shared; mutated by click handler
 * @param {Set}    struckSet     — shared; mutated by click handler
 * @returns {Element}
 */
function buildRow(item, doneBehavior, dismissedSet, struckSet) {
  const key = itemKey(item);
  const name = getItemName(item);
  const url = getItemUrl(item);
  const type = getItemType(item);
  const dueAt = getDueAt(item);
  const { label, status } = formatDue(dueAt);

  // ── Outer row ──────────────────────────────────────────────────────────────
  const row = document.createElement("div");
  row.className = `${CC}-row`;
  row.dataset.ccKey = key;
  row.title = "Click anywhere except the title to mark as done";

  // Restore persisted state
  if (dismissedSet.has(key)) row.classList.add(`${CC}-row--dismissed`);
  if (struckSet.has(key)) row.classList.add(`${CC}-row--struck`);

  // ── Left body: title + type ────────────────────────────────────────────────
  const body = document.createElement("div");
  body.className = `${CC}-row-body`;

  const link = document.createElement("a");
  link.className = `${CC}-name`;
  link.href = url || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = name;
  link.textContent = name;

  const typeEl = document.createElement("span");
  typeEl.className = `${CC}-type`;
  typeEl.textContent = type;

  body.appendChild(link);
  body.appendChild(typeEl);

  // ── Right: due date badge ──────────────────────────────────────────────────
  const badge = document.createElement("span");
  badge.className = `${CC}-badge ${CC}-badge--${status}`;
  badge.textContent = label;
  if (dueAt) badge.title = new Date(dueAt).toLocaleString();

  row.appendChild(body);
  row.appendChild(badge);

  // ── Click handler ──────────────────────────────────────────────────────────
  // The row itself handles toggle; the <a> child handles navigation.
  // If the click lands on the <a> or anything inside it, we do nothing and let
  // the browser follow the link as normal.
  row.addEventListener("click", (e) => {
    if (e.target.closest(`.${CC}-name`)) return; // let the link do its thing
    e.preventDefault();
    toggleDone(key, row, doneBehavior, dismissedSet, struckSet);
  });

  return row;
}

/**
 * Build and inject (or replace) the Canvas Companion panel on a course card.
 *
 * @param {Element} card         — .ic-DashboardCard
 * @param {Array}   items        — planner items for this course (sorted)
 * @param {string}  doneBehavior
 * @param {Set}     dismissedSet
 * @param {Set}     struckSet
 */
function buildPanel(card, items, doneBehavior, dismissedSet, struckSet) {
  // Remove any stale panel from a previous injection cycle
  card.querySelector(`.${CC}-panel`)?.remove();

  const panel = document.createElement("div");
  panel.className = `${CC}-panel`;

  if (!items || items.length === 0) {
    // All clear for this course within the lookahead window
    panel.innerHTML = `
      <div class="${CC}-empty">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
             stroke="currentColor" stroke-width="2.8"
             stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        No upcoming assignments
      </div>`;
  } else {
    const list = document.createElement("div");
    list.className = `${CC}-list`;

    for (const item of items) {
      list.appendChild(buildRow(item, doneBehavior, dismissedSet, struckSet));
    }

    panel.appendChild(list);
  }

  // Canvas card HTML varies slightly across versions — try known containers
  const target =
    card.querySelector(".ic-DashboardCard__box") ||
    card.querySelector(".ic-DashboardCard__content") ||
    card;

  target.appendChild(panel);
  card.setAttribute(INJECTED, "1");
}

// ── Card discovery ────────────────────────────────────────────────────────────

/** Extract the numeric course ID from a dashboard card's /courses/:id link. */
function courseIdFromCard(card) {
  const a = card.querySelector('a[href*="/courses/"]');
  if (!a) return null;
  const m = a.getAttribute("href").match(/\/courses\/(\d+)/);
  return m ? m[1] : null;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

// These are populated fresh on every init() call — no cross-navigation caching.
let _byCourse = new Map();
let _doneBehavior = "hide";
let _dismissed = new Set();
let _struck = new Set();
let _observing = false;

/** Inject panels into any un-injected cards currently in the DOM. */
function injectAll() {
  const cards = document.querySelectorAll(
    `.ic-DashboardCard:not([${INJECTED}])`,
  );
  if (!cards.length) return;

  cards.forEach((card) => {
    const cid = courseIdFromCard(card);
    if (!cid) return;
    buildPanel(
      card,
      _byCourse.get(cid) || [],
      _doneBehavior,
      _dismissed,
      _struck,
    );
  });
}

/**
 * Watch for cards that Canvas's React runtime renders after our script fires.
 * Debounced to avoid thrashing during batch DOM mutations.
 */
function startObserver() {
  if (_observing) return;
  _observing = true;

  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(injectAll, 150);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/**
 * Main entry point — called on every fresh page load and SPA navigation.
 * Always fetches fresh data; nothing is cached between calls.
 */
async function init() {
  // Only run on the dashboard — Canvas uses a few different URL shapes for it
  const path = window.location.pathname;
  const onDashboard =
    path === "/" ||
    path === "" ||
    path.startsWith("/dashboard") ||
    /^\/?($|\?)/.test(path);

  if (!onDashboard) return;

  try {
    // Step 1: fetch settings first (fast — local storage read)
    const [settings, localState] = await Promise.all([
      getSyncSettings(),
      getLocalState(),
    ]);

    // Step 2: fetch planner items using those settings (network — can be slow)
    const items = await fetchPlannerItems(
      settings.lookahead,
      settings.showOverdue,
    );

    // Populate module-level state (reset fresh — no caching from prior calls)
    _doneBehavior = settings.doneBehavior;
    _dismissed = new Set(localState.cc_dismissed);
    _struck = new Set(localState.cc_struck);
    _byCourse = groupByCourse(items);

    injectAll();
    startObserver();
  } catch (err) {
    // Never crash the Canvas page
    console.warn("[Canvas Companion] init error:", err);
  }
}

// Fire immediately — content scripts run at document_idle so DOM is ready
init();

// ── SPA navigation detection ──────────────────────────────────────────────────
// Canvas uses pushState/replaceState; DOMContentLoaded never fires again.
// We poll the path and re-run init() when it changes.

let _lastPath = window.location.pathname;

setInterval(() => {
  const cur = window.location.pathname;
  if (cur === _lastPath) return;
  _lastPath = cur;

  // Strip injected markers so panels rebuild from scratch
  document
    .querySelectorAll(`[${INJECTED}]`)
    .forEach((el) => el.removeAttribute(INJECTED));

  // Reset everything — init() will repopulate from fresh data
  _observing = false;
  _byCourse = new Map();
  _dismissed = new Set();
  _struck = new Set();

  init();
}, 800);
