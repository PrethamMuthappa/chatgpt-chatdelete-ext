# Chat Bulk Delete

**Bulk-select and bulk-delete your ChatGPT conversations — right from the sidebar.**

This extension adds checkboxes next to your ChatGPT chats so you can select many at once and delete them together. It uses ChatGPT's own delete buttons — no hacks, no external servers, everything stays in your browser.

> Works on `chatgpt.com` and `chat.openai.com`. Deletes **entire conversations**, not individual messages.

---

## 📸 Screenshots & Examples

> **Add your own images here — this space is for you.**

### Example 1 — Sidebar with checkboxes

<!-- Replace this placeholder with your image -->
<!-- 1. Take a screenshot of the sidebar with checkboxes -->
<!-- 2. Save it as docs/images/sidebar.png -->
<!-- 3. Uncomment the line below -->

<!-- ![Sidebar with checkboxes](docs/images/sidebar.png) -->

```
[ Your sidebar screenshot here ]
docs/images/sidebar.png
```

### Example 2 — Bulk delete in action

<!-- ![Bulk delete](docs/images/bulk-delete.png) -->

```
[ Your bulk-delete screenshot here ]
docs/images/bulk-delete.png
```

### Example 3 — Filter & selection

<!-- ![Filter example](docs/images/filter.png) -->

```
[ Your filter screenshot here ]
docs/images/filter.png
```

> Tip: Create a folder `docs/images/` and drop your `.png` / `.jpg` files there. Then uncomment the `![...](...)` lines above.

---

## ✨ What it does

- Adds a small checkbox next to every chat in the left sidebar
- Lets you pick one, many, or all chats
- Shows how many you picked: `3 selected`
- One button to delete all selected — with a confirmation first
- Nothing leaves your browser

---

## 🚀 Quick Install

### Chrome / Edge / Brave (Chromium)

1. Download this folder (`chatdelete`) to your computer
2. Open `chrome://extensions` in your browser
3. Turn on **Developer mode** (top-right switch)
4. Click **Load unpacked**
5. Select the `chatdelete` folder
6. Open [chatgpt.com](https://chatgpt.com) and log in — you’ll see checkboxes in the sidebar

To update: go to `chrome://extensions` → click ↻ **Reload** on the card → refresh ChatGPT.

### Firefox (109+ / 155)

Firefox needs a different manifest (`background.scripts`).

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.firefox.json` (choose *All Files* in the picker if needed) — or simply select `manifest.json` (now Firefox-ready)
4. Open [chatgpt.com](https://chatgpt.com) → refresh the page
5. Checkboxes appear in the sidebar

> Both `manifest.json` and `manifest.firefox.json` now work in Firefox. `manifest.chrome.json` is kept for Chrome.

---

## 🎮 How to use

1. **Find your chats** in the left sidebar on ChatGPT
2. **Tick the boxes** you want to remove — clicking the box *does not* open the chat
3. **On top of the sidebar** you’ll see:
   ```
   Bulk Select          3 selected
   [ Select All ]  [ Clear ]
   [ Filter conversations... ]
   [ 🗑 Delete Selected (3) ]
   ```
4. **Filter** (optional): type `interview` to only show matching chats — your selection stays even when filtered
5. **Delete**: click **🗑 Delete Selected** → confirm `Delete 3 conversations?` → they are deleted one-by-one (safe & slow, not all at once)
6. You’ll see a small toast `3 conversations deleted` — no big popup to close

**Buttons explained:**
- **Select All** = select every loaded chat (scroll down first to load more)
- **Clear** = unselect everything
- **Filter** = just hides chats from view, doesn’t delete or deselect

---

## 🔒 Privacy & Safety

- No backend, no tracking, no analytics
- No conversation titles or contents are sent anywhere
- Uses ChatGPT’s own delete UI (`⋯ → Delete → Confirm`) — same as you clicking manually
- Always asks `Delete N conversations? This cannot be undone.` — big deletes (>10) need an extra checkbox
- If one delete fails, it shows which one and continues

---

## 🛠 Troubleshooting

**Don’t see checkboxes?**
- Scroll the sidebar a bit or click the extension icon → **Rescan**
- Refresh ChatGPT (`F5`) and wait 2 seconds

**Delete didn’t work?**
- ChatGPT changed its UI — check the “For developers” section below for how to fix selectors

**Filter text is hard to read?**
- Fixed in v1.0 — input now adapts to light/dark mode. If still unreadable, refresh and check theme.

---

## ⚠️ Limitations

- Only chats **already loaded** in the sidebar can be selected — scroll to load more first
- Deletion is permanent (OpenAI deletes within 30 days) — be careful
- Archived / shared chats may not appear in the list
- No “older than 30 days” auto-select — titles can be same, so we only use stable IDs from the link `/c/<id>`

---

## 👨‍💻 For developers

<details>
<summary>Click to expand technical details</summary>

### Project structure
```
chatdelete/
├── manifest.json              # Firefox-ready (scripts)
├── manifest.chrome.json       # Chrome MV3 (service_worker)
├── manifest.firefox.json      # Firefox MV3 (scripts + gecko)
├── content/
│   ├── content.js             # Main logic — checkboxes, selection, delete queue
│   └── content.css            # Styles (namespace .cbd-*)
├── popup/                     # Browser action popup (no external requests)
├── background/                # Minimal — logs install, fallback toggle
├── icons/
├── utils/selectors.js
└── README.md
```

### How detection works (stable)
- Finds `a[href*="/c/"]` → extracts ID with `/\/c\/([^/?#]+)/`
- Ignores `/g/`, `/share`, `/project`, and own UI
- Finds row by walking up to `<li>` or element containing `button[data-testid^="history-item-"][data-testid$="-options"]`
- Dedup by ID, not DOM index; checkbox is bound via `dataset.conversationId` + `event.currentTarget`

### How deletion works (UI-driven)
For each stable ID in order:
1. `findConversationAnchor(id)` → `a[href="/c/<id>"]`
2. `findConversationRow` → `findOptionsButton` → `revealOptionsButton` → click `⋯`
3. Wait for `div[role="menuitem"][data-testid="delete-chat-menu-item"]` → click **Delete**
4. Wait for `div[data-testid="modal-delete-conversation-confirmation"]` → click `button[data-testid="delete-conversation-confirm-button"]`
5. Wait for modal + anchor to disappear → next. Errors recorded, continue when safe.

### Debugging if ChatGPT changes DOM
1. `F12` → Elements → inspect `a[href="/c/..."]` and `button[data-testid^="history-item-"][data-testid$="-options"]`
2. Compare with `SELECTORS` in `content/content.js:46`
3. Test in console: `document.querySelectorAll('a[href*="/c/"]')`, `__CBD.detected`, `__CBD.selectedIds`, `__CBD.rescan()`
4. Edit selectors → `chrome://extensions` → Reload → refresh ChatGPT

### Permissions
- `storage` — remember selection
- `host_permissions: https://chatgpt.com/*, https://chat.openai.com/*` — inject only on ChatGPT

No `cookies` / `webRequest` / external calls.

</details>

---

## 📋 Test checklist (try on a test account first)

- [ ] Click only one checkbox → only that one selected
- [ ] Select All → all loaded checked
- [ ] Clear → all unchecked
- [ ] Type in filter → text visible (light & dark)
- [ ] Filter hides but selected count stays
- [ ] Delete 1 → only that one gone
- [ ] Delete 2–3 → exactly those gone
- [ ] Refresh → only one Bulk Select UI
- [ ] Scroll → new chats get checkboxes, no duplicates

---

## 📄 License

MIT — do what you want, no warranty. Use only on your own account.

---

### 👉 Add your images

Create `docs/images/` and add:
- `sidebar.png` — sidebar with checkboxes
- `bulk-delete.png` — delete confirmation
- `filter.png` — filter in action

Then uncomment the image lines at the top of this file.
