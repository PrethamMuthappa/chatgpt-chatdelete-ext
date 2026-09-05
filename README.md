# Chat Bulk Delete — Chrome Extension (Manifest V3)

Bulk-select and bulk-delete **entire conversations** in the ChatGPT web UI (`https://chatgpt.com` / `https://chat.openai.com`) via the *native* ChatGPT interface. No API hacks, no token extraction, no external servers.

> **Safety-first:** selects are kept as IDs, deletions are strictly sequential, require explicit confirmation, and show a summary of successes/failures. Nothing is sent anywhere.

---

## Features

- ✅ Checkboxes next to every conversation in the ChatGPT sidebar
- ✅ Persistent selection (IDs, not just DOM nodes) survives sidebar re-renders
- ✅ Handles lazy-loaded / infinite-scroll conversations (MutationObserver + rescan)
- ✅ Floating panel + optional inline sidebar controls:
  - **Select All / Clear**
  - **Selected count**
  - **🗑 Delete Selected**
  - **Filter** — live text filter that only affects the extension's view (does not call ChatGPT search)
  - **Select Filtered** when a filter is active
- ✅ Strong confirmation before deletion (extra warning + required checkbox for >10 items)
- ✅ Sequential deletion through ChatGPT's own UI: **⋯ → Delete → Confirm → wait → next**
- ✅ Progress + cancel, per-item error handling, end summary (`Successfully deleted: X / Failed: Y`)
- ✅ No backend, no telemetry, local only
- ✅ Chrome/Chromium Manifest V3, plain HTML/CSS/JS, Firefox/Safari-portable structure

---

## Project Structure

```
chatdelete/
├── manifest.json                 # Chrome MV3 (service_worker) — default for chrome://extensions
├── manifest.chrome.json          # Chrome MV3 copy (identical to manifest.json)
├── manifest.firefox.json         # Firefox MV3 (scripts + gecko id + data_collection_permissions)
├── content/
│   ├── content.js                # Main injected logic (detect, inject, delete)
│   └── content.css               # Injected styles (namespaced .cbd-*)
├── popup/
│   ├── popup.html
│   ├── popup.js                  # Talks to content script; no external requests
│   └── popup.css
├── background/
│   ├── service-worker.js         # Chrome service_worker (MV3)
│   └── background.js             # Firefox background scripts (MV3 scripts) — cross-browser
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── utils/selectors.js            # Stable selector docs
└── README.md
```

> The spec suggested `/styles/ /utils/` — here `content/content.css` and `popup/popup.css` play that role; logic in `content/content.js` is intentionally plain JS with comments, split by section, so adding `/utils/selectors.js` later is trivial. No build step.

---

## Installation (Chrome / Chromium)

1. **Download or clone** this folder to your computer, e.g. `chatdelete/`.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in top-right).
4. Click **Load unpacked**.
5. Select the `chatdelete` folder (the one containing `manifest.json` / `manifest.chrome.json`). The default `manifest.json` is the Chrome MV3 build (`background.service_worker`).
6. You should see **Chat Bulk Delete v1.0.0** appear with a green check icon.
7. Open `https://chatgpt.com` and log in. A floating panel appears bottom-right; checkboxes appear in the sidebar within ~1–2 s. If not, click the extension icon → **Rescan**.

To update after editing code: go to `chrome://extensions` → click the ↻ **Reload** button on the extension card, then refresh ChatGPT.

## Installation (Firefox 109+ / 155)

Firefox 155 does **not** enable `background.service_worker` by default; it requires `background.scripts`. The project provides two manifests:

- `manifest.json` / `manifest.chrome.json` → Chrome (MV3 `service_worker`)
- `manifest.firefox.json` → Firefox (MV3 `scripts` + `browser_specific_settings.gecko`)

**Exact steps for `about:debugging` (no overwrite needed, picker accepts any manifest name):**

1. Open Firefox.
2. Go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…**.
4. In the file picker, choose **All Files** (or `*.json`) if needed and select `chatdelete/manifest.firefox.json`. (If your picker only shows `manifest.json`, temporarily copy: `cp manifest.firefox.json manifest.json` then select that file, or use `web-ext` below.)
5. You should see **Chat Bulk Delete** appear in the Temporary Extensions list with no errors (0 errors, 2 `innerHTML` warnings are expected).
6. Open `https://chatgpt.com/` and log in.
7. Refresh the page (`F5`) and wait 1–2 s for React hydration.
8. Verify the floating panel bottom-right and checkboxes in the sidebar.
9. If checkboxes don't appear, open the extension popup → **Rescan** or scroll the sidebar.

**Alternative (no file-picker quirk) via `web-ext`:**

```bash
npm i -g web-ext
web-ext run --source-dir=/Users/pretham/Documents/projects/chatdelete --target=firefox --start-url=https://chatgpt.com --manifest manifest.firefox.json
# or copy first:
cp manifest.firefox.json manifest.json && web-ext run --source-dir=. --target=firefox
```

**To restore Chrome after testing Firefox copy:**
```bash
cp manifest.chrome.json manifest.json
```

**Why two manifests?** `web-ext lint` error `BACKGROUND_SERVICE_WORKER_NOFALLBACK` requires Firefox MV3 `background.scripts` fallback when using `service_worker`. Chrome MV3 rejects `scripts`. Separate manifests keep each browser lint-clean without overwriting.

---

## How to Use

1. **Open ChatGPT** — `https://chatgpt.com` — and wait for the conversation history to load.
2. **Checkboxes** — each conversation row gets a checkbox on the left. Clicking the checkbox **does not** open the conversation.
3. **Select**:
   - Click individual checkboxes.
   - **Select All** — selects all currently loaded conversations (scroll to load more first).
   - **Clear** — deselects all.
   - **Filter** — type text (e.g. `interview`) to filter the sidebar to matching titles; **Select Filtered** then selects only the visible filtered set. Clearing the filter restores all rows. Filtering never calls ChatGPT's server.
4. **Delete**:
   - Click **🗑 Delete Selected (N)** in either the floating panel or the sidebar controls.
   - A confirmation modal appears: *“Delete N conversations? This action cannot be undone.”*
   - For **>10** items an extra warning and a required checkbox (*“I understand…”*) appears.
   - Confirm to start. Deletions run **one by one**:
     ```
     Open ⋯ → Click Delete → Confirm in dialog → wait for row to disappear → next
     ```
   - Progress shows `Deleting 3/12: <title>` with a **Cancel** button.
5. **Result** — a summary modal shows `Successfully deleted: X / Failed: Y` and the list of failed titles/errors, with a **Retry failed** button.
6. **Hide/show panel** — click **×** on the panel to hide; reopen via the extension icon → **Show / Hide Panel**. Panel is draggable via its header and minimizable via **—**.

---

## How Conversation Detection Works

**Goal:** find only conversation entries, not folders, GPTs, projects, settings, or placeholders.

**Primary signal — href:** `a[href*="/c/"]` filtered by `\/c\/([^/?#]+)` (see `CONVERSATION_ID_RE`). This excludes `/g/`, `/share/`, etc. Verified across 2024–2026 community scripts (`chatgpt-exporter`, `BulkChatDeleter`, `qqrm`).

**Secondary signals — visibility & location:**

```js
// content/content.js: isConversationLinkElement()
// - anchor must be HTMLAnchorElement with /c/<id>
// - not inside our own panel ( [data-cbd-panel] )
// - href must not contain /g/, /project, /share
// - must be visible (getBoundingClientRect().width/height > 0) or have title text
```

**Row container — stable DOM walk:** `findConversationRow(anchor)` walks up ≤6 parents looking for:
- `<li>` (semantic list)
- an element that already contains an options button `button[data-testid^="history-item-"][data-testid$="-options"]`
- else fallback to `anchor.parentElement`

This avoids hardcoding Tailwind class names like `group/conversation-turn` that change every few months.

**Deduplication:** by conversation ID extracted from href, not by DOM node identity.

**Dynamic loading:** ChatGPT virtualizes / lazy-loads. A `MutationObserver` on `document.documentElement` watches for added/removed `a[href*="/c/"]`, plus scroll listeners, plus a 5 s periodic rescan. Duplicates are avoided via `data-cbd-injected` attribute on rows.

**Filtering:** purely client-side title substring match; implemented by toggling `display:none` on the row (`applyFilter()`). Does not touch ChatGPT's own search.

**Date grouping (optional, not implemented):** ChatGPT sometimes groups by headings (“Today”, “Yesterday”, “Previous 7 Days”). Parsing these headings is unreliable (localized strings, missing when scrolled). We intentionally do not implement “Older than 30 days” selection to avoid false deletes; if needed you can filter by title pattern or add a heading-aware extension later.

---

## How Deletion Works

We **drive the existing UI**; we do not call `https://chatgpt.com/backend-api/...` or read cookies.

For each selected ID in order:

```
1. findConversationAnchor(id)              → a[href="/c/<id>"]
2. findConversationRow(anchor)             → closest li / wrapper
3. findOptionsButton(row)                  → button[data-testid^="history-item-"][data-testid$="-options"]
                                           fallback: button[aria-label*="options"]
4. revealOptionsButton(row)                → dispatch pointerenter/mouseenter + force opacity:1
5. click optionsButton                     → opens Radix menu
6. wait 1.8–2.6s for findDeleteMenuItem() → div[role="menuitem"][data-testid="delete-chat-menu-item"]
                                           fallback: [role="menuitem"] with text "Delete"
7. click deleteItem
8. wait 1.5–2.6s for findConfirmModal()    → div[data-testid="modal-delete-conversation-confirmation"]
9. findConfirmButton(modal)                → button[data-testid="delete-conversation-confirm-button"]
                                           fallback: button text "Delete" inside modal
10. waitUntilEnabled(button)
11. click confirm
12. waitUntilGone(modal)
13. waitUntilGone(a[href*="/c/<id>"])      → verify row disappeared (up to 3.5s)
14. sleep 650ms, dispatch Escape, next item
```

**Sequential & cautious:** no parallel deletes; menus/dialogs can only be open one at a time. Delays (`sleep 80–650ms`) let React settle.

**Error handling:** any step can throw; we catch, push `{id, title, error}` to `failed[]`, `dispatchEscape()` to close stray menus, sleep 500 ms, and continue. At the end `showSummaryModal()` reports `Succeeded: X / Failed: Y` with titles and a retry button.

**Why not API?** Using `fetch("/backend-api/conversation/<id>", {method:"PATCH", body:{is_visible:false}})` would be faster but bypasses the user's visible confirmation flow, risks auth breakage when OpenAI rotates, and violates the requirement *“do not make undocumented authenticated API requests.”* UI automation is slower but transparent and respects ChatGPT's own auth.

---

## Debugging if ChatGPT Changes its DOM

OpenAI changes attributes every few months. Here's how to fix it in <5 min:

### 1. Open DevTools on ChatGPT

`F12` → **Elements** tab.

### 2. Inspect a conversation row

Hover a conversation in the sidebar → right-click the title → **Inspect**. Look for:

```html
<a href="/c/abc123..." ...>My Title</a>
<button data-testid="history-item-abc123-options" aria-label="Open conversation options">
```

Note the `data-testid` prefix and the `href` shape.

### 3. Inspect the delete flow manually

Click the `⋯` → Inspect the menu that appears (it may be portalled to `body`):

```html
<div role="menu" data-radix-menu-content>
  <div role="menuitem" data-testid="delete-chat-menu-item">Delete</div>
</div>
```

Click **Delete** → Inspect the confirmation dialog:

```html
<div data-testid="modal-delete-conversation-confirmation" role="dialog">
  <button data-testid="delete-conversation-confirm-button">Delete</button>
</div>
```

### 4. Compare with `SELECTORS` in `content/content.js:21`

```js
const SELECTORS = {
  conversationLink: 'a[href*="/c/"]',
  optionsButtonExact: 'button[data-testid^="history-item-"][data-testid$="-options"]',
  deleteMenuItemExact: 'div[role="menuitem"][data-testid="delete-chat-menu-item"]',
  confirmModalExact: 'div[data-testid="modal-delete-conversation-confirmation"]',
  confirmButtonExact: 'button[data-testid="delete-conversation-confirm-button"]',
  // ...
};
```

Update any selector that no longer matches. The fallbacks (aria-label search, textContent === "Delete") often keep things working even before you update.

### 5. Test in console

With the page open, run in DevTools console:

```js
// Should list conversations
document.querySelectorAll('a[href*="/c/"]')
// Should find an options button after hovering a row
document.querySelector('button[data-testid^="history-item-"][data-testid$="-options"]')
// Debug helper exposed by the extension
__CBD.detected  // list of {id,title,url}
__CBD.selectedIds
__CBD.rescan()
```

If `__CBD.detected` is empty but `querySelectorAll('a[href*="/c/"]')` finds links, check `isConversationLinkElement` filtering (maybe new href shape).

### 6. Reload extension

After editing `content/content.js`, go to `chrome://extensions` → ↻ Reload, then refresh ChatGPT.

**Console logs:** the extension logs with prefix `[CBD]` — filter console for `CBD`.

---

## Known Limitations

- Only conversations **currently loaded in the sidebar** can be selected/deleted. If you have 1 000 chats but only scrolled to load 50, “Select All” selects 50. Scroll to load more before selecting.
- Deletion is **irreversible** (OpenAI purges within 30 days). Use filters and the preview list carefully.
- The extension does **not** delete end-side “memory” or backend backups — it mirrors what the UI delete does.
- **Date-based selection** (“older than 30 days”) is not included because heading text is localized/unreliably present. Filter by title instead; or extend `applyFilter()` to parse headings if your locale is stable.
- **Pinned / archived / shared** chats may not appear in the main history list and thus are not selected.
- ChatGPT may briefly show a **grayed row** while deleting — we wait for confirmation modal to close and row to disappear; on slow networks a row may briefly remain — the summary will flag it as failed — just retry.
- Works as **Chrome extension**; Firefox/Safari need a small manifest tweak (`browser_specific_settings`), JS is otherwise portable.
- ChatGPT may show **“Clear all”** in Settings — that is not affected; we only delete selected rows.

---

## Permissions

- `storage` — to remember selected IDs and panel visibility.
- `host_permissions: https://chatgpt.com/*, https://chat.openai.com/*` — to inject the content script only on ChatGPT.

No `cookies`, `webRequest`, `activeTab` beyond messaging.

---

## Privacy

- No backend, no analytics, no telemetry.
- No conversation titles/contents/URLs leave the browser.
- Code is plain JS, auditable in `content/content.js`.

---

## Test Checklist

Manual tests (perform on a test account first):

- [ ] **0 selected** — Delete button disabled, no confirmation shown.
- [ ] **1 selected** — delete one chat, confirm row disappears, success count 1.
- [ ] **2–5 selected** — sequential deletion, progress updates, final summary.
- [ ] **10+ selected** — extra warning + required checkbox; confirm works; progress counts correctly.
- [ ] **Select All** — selects all loaded; Clear resets.
- [ ] **Filter** — type substring, list filters, Select Filtered works, clearing filter restores.
- [ ] **Sidebar re-render** — toggle ChatGPT's sidebar closed/open, selection persists, no duplicate checkboxes.
- [ ] **Scrolling** — scroll sidebar to lazy-load more chats, new rows get checkboxes, Select All after scroll includes new ones.
- [ ] **Open a conversation after selecting others** — selecting does not navigate; clicking the title still opens the chat; selection remains.
- [ ] **Deleting one conversation** — modal flow succeeds, row gone.
- [ ] **Deleting multiple** — sequential, no parallel menus, each delete waits for prior.
- [ ] **Cancellation at confirmation dialog** — Cancel keeps selection, deletes nothing.
- [ ] **Cancel mid-run** — progress Cancel stops after current item, summary shows cancelled.
- [ ] **One deletion failing** — e.g., manually remove an anchor before delete, or simulate missing options button; continue to next; summary shows failed title.
- [ ] **ChatGPT page refresh** — selection stored? (currently via `chrome.storage.local`, should restore). If not, it's acceptable to re-select.
- [ ] **Extension reload** — reload at `chrome://extensions`, refresh ChatGPT, panel reappears, scanning works.
- [ ] **Light / dark theme** — panel readable in both.
- [ ] **Panel hide/show** — × hides, extension icon → Show/Hide restores, — minimizes.
- [ ] **No console errors** — filter console for `[CBD]`, ensure no infinite MutationObserver loops (check Performance).

---

## Development Notes

- No build, no bundler, no framework. Edit files and reload.
- Logs: `console.log('[CBD]', ...)` in `content/content.js`.
- Debug globals: `window.__CBD` in ChatGPT page console.
- If adding `/utils/`, move `SELECTORS`, `sleep`, `waitForElement` there and import via ES modules (add `"type":"module"` to manifest `background` — but keep content script as plain script for broader compat).

---

## License

MIT — do whatever you want, no warranty. Use only on your own account.
