# canvas-companion
Canvas dashboard Chrome extension that injects a live assignment panel with due dates, course grouping, and quick done/strike tracking directly into Canvas LMS.
Co authored by Claude Sonnet 4.6

# Why?
I used to use BetterCanvas, it then refactored into BetterCampus which was really buggy, had a subscription model, had popups between every page navigation, and AI integrated into it which was too much for me. I just wanted a minimalist todo list under each course card so this does that.

# Canvas Companion

A lightweight Chrome extension that injects upcoming assignment data directly into your Canvas LMS dashboard — no more clicking into each course to see what's due.

---

## Installation

> **Requires Chrome** (or any Chromium-based browser — Edge, Brave, Arc, etc.)

### Step 1 — Download & unzip

Download the repo as a folder. It can live anywhere, but **don't delete it** — Chrome loads the extension directly from it.

### Step 2 — Open Chrome Extensions

Go to `chrome://extensions` in your address bar, or open the menu → **More Tools → Extensions**.

### Step 3 — Enable Developer Mode

Toggle **Developer mode** on in the top-right corner of the Extensions page.

### Step 4 — Load the extension

Click **Load unpacked**, then select the folder. Canvas Companion will appear in your extensions list.


## First-Time Setup

1. Click the Canvas Companion icon in your toolbar.
2. Enter your Canvas domain — for example `canvas.pdx.edu`. Don't include `https://`.
3. Click **Check Connection**.
   - Chrome will ask you to grant permission for that specific domain. Click **Allow**.
   - The extension will confirm it can reach your Canvas account using your existing login session. **No API token is needed** — just make sure you're already logged into Canvas in Chrome.
   - Note, you might have to do this step twice.
4. Once connected, reload any open Canvas tab. Assignment panels will appear automatically on your dashboard.

> If you ever switch schools or Canvas domains, open the popup and use the **Change** button in the Connection section.

---

## Usage

### Dashboard panels

After setup, every course card on your Canvas dashboard will show a panel at the bottom listing upcoming assignments within your configured window. Each row shows:

- **Assignment title** — click it to open the assignment directly
- **Type label** — Assignment, Quiz, Discussion, etc.
- **Due date badge** — color-coded by urgency:
  - 🟢 Green — due comfortably in the future
  - 🟡 Amber — due within 48 hours
  - 🔴 Red — overdue or due within 1 hour

### Marking assignments as done

Click **anywhere on an assignment row except the title** to mark it as done. Depending on your setting in the Options page, done items will either:

- **Hide** — the row disappears entirely
- **Strike through** — the row stays visible but is crossed out and dimmed

Click the row again to undo.

Done state is saved locally and persists across page reloads and browser restarts.

---

## Settings

### Popup (quick settings)

Open the extension popup for day-to-day controls:

| Setting | What it does |
|---|---|
| **Assignments due within X days** | How far ahead to look. Set to 30 to see a month of work at a glance. |
| **Include overdue items** | Whether to show assignments that are already past due. |

Changes take effect after reloading your Canvas tab.

### Options page (advanced settings)

Right-click the extension icon → **Options**, or use the gear icon in the popup. Additional controls include:

| Setting | What it does |
|---|---|
| **Canvas Domain** | Edit your domain without going through the full setup flow. |
| **API Token** | Optional. Only needed if the badge counter stops working. See below. |
| **Open links in new tab** | Controls whether assignment links open in a new tab or the current one (popup behavior). |
| **When marking as done** | Choose between Hide and Strike Through. |
| **Due date display** | Relative ("3d left") vs. absolute ("Apr 22") date labels. |
| **Show overdue items** | Same as the popup toggle. |
| **Look ahead (days)** | Same as the popup slider. |
| **Reset Dismissed Items** | Brings back any assignments you've hidden. |
| **Clear All Data** | Wipes all settings — use if you want to start fresh. |

---

## API Token (optional)

You **do not need an API token** for the dashboard panels to work. The extension uses your existing Canvas login session.

A token is only useful for the **badge counter** on the extension icon — the background process that updates the count runs outside the Canvas page and can't always access your session cookie. If the badge shows `!` or stops updating, add a token:

1. In Canvas, go to **Account → Settings → Approved Integrations**
2. Click **New Access Token**, give it a name, and copy the token
3. Open Canvas Companion Options and paste it into the API Token field
4. Save and the badge will resume working

---

## How It Works

| Component | Role |
|---|---|
| `content.js` | Runs on your Canvas dashboard page. Fetches assignments from the Canvas Planner API using your session cookie, then injects panels into each course card. |
| `content.css` | Styles for the injected panels. Namespaced with `.cc-*` to avoid conflicts with Canvas's own styles. |
| `popup.js / popup.html` | The setup and quick-settings UI you see when clicking the icon. Handles domain input, permission requests, and display preferences. |
| `background.js` | A service worker that refreshes the badge count every 15 minutes. |
| `options.js / options.html` | The full advanced settings page. |
| `manifest.json` | Declares permissions. No Canvas domain is hardcoded — the extension works with any Canvas instance. |

### Why no hardcoded domain?

Most Canvas extensions hardcode a specific school's URL (e.g. `canvas.pdx.edu`), which means they only work for students at that school. Canvas Companion instead requests permission for whatever domain you enter during setup, using Chrome's `optional_host_permissions` API. This means it works at any institution running Canvas — just enter your domain and go.

### Why no API token for the dashboard?

The dashboard panels run inside the Canvas page itself as a content script, so the browser automatically sends your session cookie with every request. This is exactly how Canvas's own pages make API calls. The token is only needed for the background badge, which runs in an isolated service worker context where session cookies aren't accessible.

---

## Troubleshooting

**Panels aren't showing on my dashboard**
- Make sure you're on the actual dashboard page (the one with the course cards), not a course or assignments page.
- Try reloading the Canvas tab after installing or changing settings.
- Open `chrome://extensions`, find Canvas Companion, and make sure it's enabled.

**"Not logged in" error during setup**
- Log into Canvas in Chrome first, then try the connection check again.

**I see fewer assignments than expected**
- Increase the **Assignments due within X days** value in the popup. The default is 7 — change it to 30 for a full month.
- Toggle **Include overdue items** on if you want to see past-due work.

**The badge counter shows `!`**
- Add an API token in the Options page (see above).

**I changed my domain and now panels don't appear**
- Use the **Change** button inside the popup — this goes through the full permission flow for the new domain. Editing the domain directly in Options won't re-register the content script.

**Panels disappeared after a Chrome update**
- Open the popup, confirm your domain is still saved, and reload Canvas. Chrome extension updates can occasionally clear registered content scripts; the background script re-registers them on startup automatically.

---

## File List

```
src/
├── manifest.json       Extension config — permissions, no hardcoded domain
├── background.js       Service worker — badge updates
├── content.js          Dashboard injection — assignment fetching and panel rendering
├── content.css         Injected panel styles
├── popup.html          Setup + quick-settings UI
├── popup.js            Popup logic — domain setup, permission flow, settings
├── popup.css           Popup styles
├── options.html        Advanced settings page
├── options.js          Options page logic
├── options.css         Options page styles
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```
---
