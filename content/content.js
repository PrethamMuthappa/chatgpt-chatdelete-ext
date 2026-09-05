/**
 * Chat Bulk Delete — content script
 * Runs on https://chatgpt.com/* and https://chat.openai.com/*
 *
 * Design goals:
 * - Detect conversations via stable signals (href "/c/<id>", not brittle class names).
 * - Inject checkboxes without breaking ChatGPT UI; clicks on checkbox do NOT navigate.
 * - Keep selection as Set<id> so re-renders survive.
 * - Drive the *existing* ChatGPT delete UI (open menu → Delete → Confirm) sequentially.
 * - All local, no external APIs, no token extraction.
 *
 * Current ChatGPT DOM (as of mid-2025 / early-2026, verified via open-source
 * scripts & live structure research):
 *   Conversation link:          a[href*="/c/"] where href matches /\/c\/[^/?#]+/
 *   Options button:             button[data-testid^="history-item-"][data-testid$="-options"]
 *                               fallback: button[aria-label*="options" i] inside the same row
 *   Radix menu:                 [data-radix-menu-content][role="menu"] or div[role="menu"]
 *   Delete menu item:           div[role="menuitem"][data-testid="delete-chat-menu-item"]
 *                               fallback: [role="menuitem"] whose textContent === "Delete"
 *   Confirmation modal:         div[data-testid="modal-delete-conversation-confirmation"]
 *   Confirm button:             button[data-testid="delete-conversation-confirm-button"]
 *
 * If OpenAI changes these data-testid values, see README "Debugging if ChatGPT changes its DOM".
 */

(() => {
  'use strict';

  // Firefox/Safari portability: use `browser` if present, else `chrome`
  const ext = (typeof browser !== 'undefined' ? browser : chrome);

  // ---------------------------------------------------------------------------
  // Constants & selectors
  // ---------------------------------------------------------------------------

  const ATTR_INJECTED = 'data-cbd-injected';
  const ATTR_CHECKBOX = 'data-cbd-checkbox';
  const ATTR_PANEL = 'data-cbd-panel';
  const ATTR_ROW = 'data-cbd-row';

  // Regex to extract conversation id from /c/<id> links. ChatGPT ids are
  // typically uuid-like or 24-char hex; be permissive so we don't miss new formats.
  const CONVERSATION_ID_RE = /\/c\/([^/?#]+)/;

  // Selectors ordered by stability (most stable first)
  const SELECTORS = {
    // Primary: any anchor whose href contains /c/
    conversationLink: 'a[href*="/c/"]',
    // Options button shown on hover (three dots)
    optionsButtonExact: 'button[data-testid^="history-item-"][data-testid$="-options"]',
    optionsButtonAria: 'button[aria-label*="options" i], button[aria-label*="More" i]',
    // Radix / menu container after clicking options
    menuContent: '[data-radix-menu-content][role="menu"], div[role="menu"], [role="menu"]',
    menuItem: '[role="menuitem"]',
    deleteMenuItemExact: 'div[role="menuitem"][data-testid="delete-chat-menu-item"]',
    deleteMenuItemByTestId: '[data-testid="delete-chat-menu-item"]',
    // Confirmation dialog after clicking Delete
    confirmModalExact: 'div[data-testid="modal-delete-conversation-confirmation"]',
    confirmModalFallback: 'div[role="dialog"]',
    confirmButtonExact: 'button[data-testid="delete-conversation-confirm-button"]',
    // Sidebar containers — tried in order
    sidebarCandidates: [
      'nav[aria-label*="Chat history" i]',
      'nav[aria-label*="history" i]',
      'nav',
      'aside',
      '#history',
      '[data-testid="history"]',
      '[aria-label="Chat history"]'
    ]
  };

  const LOG_PREFIX = '[CBD]';

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** @type {Set<string>} conversation ids */
  const selectedIds = new Set();
  /** @type {Map<string, {id:string, url:string, title:string, anchor:HTMLAnchorElement, row:HTMLElement}>} */
  const detected = new Map();

  let isDeleting = false;
  let cancelRequested = false;
  let observer = null;
  let scanTimer = null;
  let filterQuery = '';

  // expose for debugging in console: window.__CBD
  // allows manual selector testing after DOM changes
  const debug = {
    get selectedIds() { return Array.from(selectedIds); },
    get detected() { return Array.from(detected.entries()).map(([id, v]) => ({ id, title: v.title, url: v.url })); },
    rescan: () => scheduleScan(0),
    SELECTORS,
  };
  // @ts-ignore
  window.__CBD = debug;

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function isVisible(el) {
    if (!(el instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      // opacity 0 is used for hidden options buttons — those are technically
      // "not visible" but we still want to find their containers. Caller decides.
      // For conversation links we want width/height check instead.
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getConversationIdFromHref(href) {
    if (!href) return null;
    try {
      const m = href.match(CONVERSATION_ID_RE);
      return m ? m[1] : null;
    } catch { return null; }
  }

  function findConversationAnchor(id) {
    // Prefer exact link; fallback to contains. Use dataset to avoid our panel links.
    const exact = document.querySelector(`a[href="/c/${CSS.escape(id)}"]`);
    if (exact instanceof HTMLAnchorElement) return exact;
    const all = document.querySelectorAll(SELECTORS.conversationLink);
    for (const a of all) {
      if (!(a instanceof HTMLAnchorElement)) continue;
      const cid = getConversationIdFromHref(a.getAttribute('href') || '');
      if (cid === id) return a;
    }
    return null;
  }

  /**
   * Find the row container for a conversation anchor.
   * The row is the closest element that also contains the options button.
   * We walk up parents and check for a button matching options selectors
   * or a <li> wrapper. This avoids hardcoding class names.
   *
   * Stable signals used:
   *  - presence of options button with data-testid^="history-item-"
   *  - <li> element (semantic list)
   *  - anchor's direct parent that groups anchor + button
   */
  function findConversationRow(anchor) {
    if (!anchor) return null;
    // If we already tagged the row, return it
    let candidate = anchor.closest(`[${ATTR_ROW}]`);
    if (candidate instanceof HTMLElement) return candidate;

    let el = anchor.parentElement;
    let depth = 0;
    while (el && depth < 6) {
      // Row typically contains at least one options button or is a <li>
      if (el.tagName === 'LI') return el;
      // Check if this element contains an options button
      if (el.querySelector(SELECTORS.optionsButtonExact) || el.querySelector(SELECTORS.optionsButtonAria)) {
        return el;
      }
      // Heuristic: element that directly wraps anchor and has sibling button
      // Check parent has 2+ children and contains anchor
      el = el.parentElement;
      depth++;
    }
    // Fallback: immediate parent as row
    return anchor.parentElement instanceof HTMLElement ? anchor.parentElement : null;
  }

  function findOptionsButton(row, anchor) {
    if (!row) return null;
    let btn = row.querySelector(SELECTORS.optionsButtonExact);
    if (btn instanceof HTMLButtonElement) return btn;
    // Fallback aria
    btn = row.querySelector(SELECTORS.optionsButtonAria);
    if (btn instanceof HTMLButtonElement) return btn;
    // Broader search: any button inside row that has aria-label containing options/more
    const buttons = row.querySelectorAll('button');
    for (const b of buttons) {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('option') || label.includes('more') || label.includes('open')) {
        return b;
      }
    }
    // Sometimes options button is outside row but near anchor in DOM tree?
    // Try anchor's parent siblings
    let sibling = anchor.parentElement;
    if (sibling) {
      const btn2 = sibling.querySelector('button');
      if (btn2) return btn2;
    }
    return null;
  }

  function findDeleteMenuItem() {
    // Exact
    let el = document.querySelector(SELECTORS.deleteMenuItemExact);
    if (el) return el;
    el = document.querySelector(SELECTORS.deleteMenuItemByTestId);
    if (el) return el;
    // Search all menu items for text "Delete" (case-insensitive) and maybe red/destructive style
    const items = document.querySelectorAll(SELECTORS.menuItem);
    for (const item of items) {
      const txt = (item.textContent || '').trim().toLowerCase();
      // Must be visible and inside an open menu
      if (txt === 'delete' || txt.startsWith('delete')) {
        // Ensure it's visible (menus that are closed are hidden)
        const style = window.getComputedStyle(item);
        if (style.display !== 'none' && item.getBoundingClientRect().height > 0) {
          return item;
        }
      }
    }
    // Fallback: any element inside a menu with "Delete"
    const menus = document.querySelectorAll(SELECTORS.menuContent);
    for (const menu of menus) {
      const candidates = menu.querySelectorAll('button, div[role="menuitem"], [data-testid*="delete" i]');
      for (const c of candidates) {
        const txt = (c.textContent || '').trim().toLowerCase();
        if (txt.includes('delete')) {
          if (c.getBoundingClientRect().height > 0) return c;
        }
      }
    }
    return null;
  }

  function findConfirmModal() {
    let m = document.querySelector(SELECTORS.confirmModalExact);
    if (m instanceof HTMLElement) return m;
    // Fallback: look for dialog containing confirm button
    const dialogs = document.querySelectorAll(SELECTORS.confirmModalFallback);
    for (const d of dialogs) {
      if (d.querySelector(SELECTORS.confirmButtonExact)) return d;
      // Look for dialog with "Delete" button and text about deletion
      const txt = (d.textContent || '').toLowerCase();
      if (txt.includes('delete') && txt.includes('conversation')) {
        // Must be visible/modal
        if (d.getBoundingClientRect().height > 0) return d;
      }
    }
    return null;
  }

  function findConfirmButton(modal) {
    if (modal) {
      let btn = modal.querySelector(SELECTORS.confirmButtonExact);
      if (btn instanceof HTMLButtonElement) return btn;
      // fallback inside modal: button with text Delete
      const btns = modal.querySelectorAll('button');
      for (const b of btns) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'delete' || t === 'confirm') return b;
      }
    }
    // global fallback
    let btn = document.querySelector(SELECTORS.confirmButtonExact);
    if (btn instanceof HTMLButtonElement) return btn;
    // generic
    const allBtns = document.querySelectorAll('div[role="dialog"] button, [data-testid*="modal"] button');
    for (const b of allBtns) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (t === 'delete') return b;
    }
    return null;
  }

  function dispatchEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  async function waitForElement(getter, { timeout = 2000, interval = 80 } = {}) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      const el = typeof getter === 'string' ? document.querySelector(getter) : getter();
      if (el) {
        // ensure visible if HTMLElement
        if (el instanceof HTMLElement) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) return el;
          // still return if we found it but hidden? caller may handle
          return el;
        }
        return el;
      }
      await sleep(interval);
    }
    return null;
  }

  async function waitUntilGone(selectorOrGetter, timeout = 2500, interval = 100) {
    const start = performance.now();
    const getEl = typeof selectorOrGetter === 'string'
      ? () => document.querySelector(selectorOrGetter)
      : selectorOrGetter;
    while (performance.now() - start < timeout) {
      const el = getEl();
      if (!el) return true;
      if (el instanceof HTMLElement) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width === 0 && rect.height === 0) return true;
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        // also check detached
        if (!el.isConnected) return true;
      }
      await sleep(interval);
    }
    return false;
  }

  async function waitUntilEnabled(btn, timeout = 2000) {
    const start = performance.now();
    while (performance.now() - start < timeout) {
      if (!btn.disabled && btn.getAttribute('aria-disabled') !== 'true') return true;
      await sleep(80);
    }
    return !btn.disabled;
  }

  async function revealOptionsButton(row) {
    if (!row) return;
    // Dispatch hover events that ChatGPT uses to reveal the button
    const events = ['pointerenter', 'mouseenter', 'mouseover', 'mousemove'];
    for (const type of events) {
      row.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));
      if (row.parentElement) row.parentElement.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
    // Also directly make the button visible as fallback (does not break UI)
    const btn = findOptionsButton(row, row.querySelector('a[href*="/c/"]'));
    if (btn instanceof HTMLElement) {
      // Force visible styles; ChatGPT uses opacity 0 + pointer-events none until hover
      btn.style.opacity = '1';
      btn.style.visibility = 'visible';
      btn.style.pointerEvents = 'auto';
      // Some UIs wrap button in a div that is hidden; ensure row hover state
      btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    }
    await sleep(60);
  }

  // ---------------------------------------------------------------------------
  // Conversation detection
  // ---------------------------------------------------------------------------

  function isConversationLinkElement(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;
    const href = anchor.getAttribute('href') || '';
    const id = getConversationIdFromHref(href);
    if (!id) return false;
    // Exclude links that are not in sidebar history.
    // We allow links anywhere initially, but filter out:
    // - links inside our own panel
    // - links with /g/ (GPTs), /project, /share etc.
    if (anchor.closest(`[${ATTR_PANEL}]`)) return false;
    if (href.includes('/g/') || href.includes('/share/') || href.includes('/project')) return false;
    // Must have non-empty title (or at least be visible)
    // Title may be empty for loading placeholders; skip those.
    const text = (anchor.textContent || '').trim();
    // Some rows use inner divs; still check visibility
    if (!isVisible(anchor) && text.length === 0) return false;
    return true;
  }

  function detectConversations() {
    const links = document.querySelectorAll(SELECTORS.conversationLink);
    const seen = new Set();
    /** @type {Map<string, {id:string, url:string, title:string, anchor:HTMLAnchorElement, row:HTMLElement}>} */
    const found = new Map();

    for (const link of links) {
      if (!isConversationLinkElement(link)) continue;
      const href = link.getAttribute('href') || '';
      const id = getConversationIdFromHref(href);
      if (!id || seen.has(id)) continue;
      seen.add(id);

      // Determine title: prefer anchor's innerText, else aria-label
      let title = (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim();
      // Truncate long titles for display
      if (title.length > 80) title = title.slice(0, 77) + '…';
      if (!title) title = '(untitled)';

      const anchor = link;
      const row = findConversationRow(anchor);

      // Distinguish conversation items from folders/navigation:
      // If row is not found or row is inside header/nav that isn't history, skip?
      // We can at least ensure row is inside a nav/aside or a list container.
      // For now accept all with row; the href check already filters most.
      const url = href.startsWith('http') ? href : `https://chatgpt.com${href.startsWith('/') ? href : `/${href}`}`;

      found.set(id, {
        id,
        url,
        title,
        anchor,
        row: row || anchor.parentElement
      });
    }

    return found;
  }

  // ---------------------------------------------------------------------------
  // Checkbox injection
  // ---------------------------------------------------------------------------

  function syncSelectionToUI() {
    // Update all injected checkboxes to reflect Set state
    const boxes = document.querySelectorAll(`input[${ATTR_CHECKBOX}]`);
    for (const box of boxes) {
      const id = box.getAttribute(ATTR_CHECKBOX);
      if (!id) continue;
      // @ts-ignore
      box.checked = selectedIds.has(id);
      // Update row highlight
      const row = box.closest(`[${ATTR_ROW}]`) || box.parentElement;
      if (row instanceof HTMLElement) {
        row.classList.toggle('cbd-selected', selectedIds.has(id));
      }
    }
    updateControlsUI();
  }

  function toggleSelection(id, checked) {
    if (checked) selectedIds.add(id);
    else selectedIds.delete(id);
    syncSelectionToUI();
    // Persist to storage for popup
    try {
      ext.storage.local.set({ cbd_selectedIds: Array.from(selectedIds) });
    } catch {}
  }

  function injectCheckboxes() {
    const found = detectConversations();
    // Update global detected map (preserve existing entries' refs but update title/anchor)
    // Remove stale entries that no longer in DOM
    for (const [id, info] of found) {
      detected.set(id, info);
    }
    // Clean up detached: if id not in found but still in detected, check if anchor still connected
    for (const [id, info] of Array.from(detected.entries())) {
      if (!found.has(id)) {
        if (!info.anchor.isConnected) {
          detected.delete(id);
          // also deselect if it was deleted externally?
          // keep selectedIds? Spec says maintain IDs, so don't auto-remove.
        }
      }
    }

    let injectedCount = 0;
    for (const [id, info] of found) {
      const { anchor, row } = info;
      if (!row) continue;

      // Avoid duplicate: check row already has our checkbox
      if (row.hasAttribute(ATTR_INJECTED) && row.getAttribute(ATTR_INJECTED) === id) {
        // Ensure checkbox state is correct
        continue;
      }
      if (row.querySelector(`input[${ATTR_CHECKBOX}="${CSS.escape(id)}"]`)) {
        row.setAttribute(ATTR_INJECTED, id);
        continue;
      }
      // Also check anchor level duplicate
      if (anchor.hasAttribute(ATTR_INJECTED)) continue;

      // Create wrapper + checkbox
      const wrapper = document.createElement('span');
      wrapper.className = 'cbd-checkbox-wrapper';
      wrapper.setAttribute(ATTR_ROW, id); // mark wrapper
      // Ensure wrapper doesn't capture row click unless checkbox clicked
      wrapper.addEventListener('click', (e) => e.stopPropagation());

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'cbd-checkbox';
      cb.setAttribute(ATTR_CHECKBOX, id);
      cb.setAttribute('aria-label', `Select conversation: ${info.title}`);
      cb.checked = selectedIds.has(id);
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        // toggle manually to avoid double
        const next = !selectedIds.has(id);
        cb.checked = next;
        toggleSelection(id, next);
      });
      cb.addEventListener('change', (e) => {
        // Fallback if click not handled
        e.stopPropagation();
        toggleSelection(id, cb.checked);
      });

      wrapper.appendChild(cb);

      // Insert wrapper before anchor, or as first child of row
      // Try to keep layout: row is often flex with anchor as first child.
      // Insert before anchor for best visual integration.
      try {
        // If row is the anchor's direct parent, insert before anchor
        if (anchor.parentElement === row) {
          row.insertBefore(wrapper, anchor);
          // Make row flex if needed
          if (window.getComputedStyle(row).display !== 'flex') {
            // Don't force if it breaks; check if we need to set
            // We use CSS to handle flex, not inline forced.
          }
        } else {
          // Anchor may be nested deeper; insert wrapper as sibling before anchor's container
          // Find the direct child of row that contains anchor
          let child = anchor;
          while (child.parentElement && child.parentElement !== row) {
            child = child.parentElement;
          }
          if (child.parentElement === row) {
            row.insertBefore(wrapper, child);
          } else {
            // Fallback: prepend to row
            row.prepend(wrapper);
          }
        }
        row.setAttribute(ATTR_INJECTED, id);
        row.setAttribute(ATTR_ROW, id);
        row.classList.add('cbd-row');
        if (selectedIds.has(id)) row.classList.add('cbd-selected');
        injectedCount++;

        // Apply filter visibility if needed
        applyFilterToRow(row, info.title);
      } catch (err) {
        log('failed to inject checkbox for', id, err);
      }
    }

    if (injectedCount > 0) {
      log(`injected ${injectedCount} checkboxes (total detected: ${found.size})`);
    }

    // Clean up checkboxes for deleted rows: remove wrappers where row no longer contains anchor
    // (handled via MutationObserver re-scan, but we can keep)

    updateControlsUI();
    return found.size;
  }

  // ---------------------------------------------------------------------------
  // Filter logic
  // ---------------------------------------------------------------------------

  function applyFilterToRow(row, title) {
    if (!row) return;
    if (!filterQuery) {
      row.classList.remove('cbd-filter-hidden');
      row.style.display = '';
      return;
    }
    const q = filterQuery.toLowerCase();
    const matches = title.toLowerCase().includes(q);
    if (matches) {
      row.classList.remove('cbd-filter-hidden');
      row.style.display = '';
    } else {
      row.classList.add('cbd-filter-hidden');
      // We don't use display:none globally because it may break virtual lists.
      // Instead use our CSS class that hides via opacity + pointer-events + height?
      // For now use display:none to truly filter, as spec expects filtered view.
      // Use important via inline? We'll set display none.
      row.style.display = 'none';
    }
  }

  function applyFilter(query) {
    filterQuery = (query || '').trim().toLowerCase();
    for (const [, info] of detected) {
      if (info.row) applyFilterToRow(info.row, info.title);
    }
    // Also update floating panel list if we have a list view (not needed)
    updateControlsUI();
  }

  // ---------------------------------------------------------------------------
  // Controls UI — sidebar injection + floating panel
  // ---------------------------------------------------------------------------

  function findSidebarContainer() {
    // Try candidate selectors
    for (const sel of SELECTORS.sidebarCandidates) {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement && el.isConnected) {
        // Verify it contains conversations
        if (el.querySelector(SELECTORS.conversationLink)) return el;
      }
    }
    // Fallback: find the common ancestor of all conversation links
    const links = document.querySelectorAll(SELECTORS.conversationLink);
    if (links.length === 0) return null;
    // Find parent that contains many links (>3)
    let candidate = links[0].parentElement;
    let depth = 0;
    while (candidate && depth < 8) {
      const count = candidate.querySelectorAll(SELECTORS.conversationLink).length;
      if (count >= 3) return candidate;
      candidate = candidate.parentElement;
      depth++;
    }
    // Fallback to nav
    return document.querySelector('nav');
  }

  function createSidebarControls() {
    if (document.getElementById('cbd-sidebar-controls')) return;
    const container = findSidebarContainer();
    if (!container) {
      log('sidebar container not found, skipping sidebar controls injection');
      return;
    }

    const controls = document.createElement('div');
    controls.id = 'cbd-sidebar-controls';
    controls.setAttribute(ATTR_PANEL, 'sidebar');
    controls.innerHTML = `
      <div class="cbd-sidebar-header">
        <span class="cbd-sidebar-title">Bulk Select</span>
        <span class="cbd-sidebar-count" id="cbd-sidebar-count">0 selected</span>
      </div>
      <div class="cbd-sidebar-actions">
        <button id="cbd-sidebar-select-all" class="cbd-btn cbd-btn-secondary" title="Select all conversations currently loaded">Select All</button>
        <button id="cbd-sidebar-clear" class="cbd-btn cbd-btn-secondary" title="Clear selection">Clear</button>
      </div>
      <div class="cbd-sidebar-search">
        <input id="cbd-sidebar-filter" class="cbd-input" placeholder="Filter conversations…" autocomplete="off" />
        <button id="cbd-sidebar-filter-clear" class="cbd-btn-icon" title="Clear filter">×</button>
      </div>
      <button id="cbd-sidebar-delete" class="cbd-btn cbd-btn-danger cbd-delete-btn" disabled>🗑 Delete Selected</button>
      <div id="cbd-sidebar-progress" class="cbd-progress" hidden></div>
    `;

    // Insert near top of sidebar — try before first conversation, or prepend to nav
    try {
      const firstLink = container.querySelector(SELECTORS.conversationLink);
      if (firstLink) {
        // Find list container that holds links
        let listContainer = firstLink.closest('div, ul, ol, nav');
        // Walk up to find element that is direct child of sidebar container
        let insertBefore = null;
        let cur = firstLink;
        while (cur && cur.parentElement && cur.parentElement !== container) {
          cur = cur.parentElement;
        }
        insertBefore = cur;
        if (insertBefore && insertBefore.parentElement === container) {
          container.insertBefore(controls, insertBefore);
        } else {
          container.prepend(controls);
        }
      } else {
        container.prepend(controls);
      }

      // Wire events
      const selectAllBtn = controls.querySelector('#cbd-sidebar-select-all');
      const clearBtn = controls.querySelector('#cbd-sidebar-clear');
      const filterInput = controls.querySelector('#cbd-sidebar-filter');
      const filterClear = controls.querySelector('#cbd-sidebar-filter-clear');
      const deleteBtn = controls.querySelector('#cbd-sidebar-delete');

      selectAllBtn?.addEventListener('click', () => handleSelectAll());
      clearBtn?.addEventListener('click', () => handleClear());
      deleteBtn?.addEventListener('click', () => handleDeleteSelected());

      filterInput?.addEventListener('input', (e) => {
        const v = (e.target).value || '';
        applyFilter(v);
        // sync floating filter if present
        const floatingFilter = document.getElementById('cbd-filter');
        if (floatingFilter && floatingFilter.value !== v) floatingFilter.value = v;
      });
      filterClear?.addEventListener('click', () => {
        const inp = document.getElementById('cbd-sidebar-filter');
        if (inp) inp.value = '';
        const floatingFilter = document.getElementById('cbd-filter');
        if (floatingFilter) floatingFilter.value = '';
        applyFilter('');
      });

      log('sidebar controls injected into', container);
    } catch (e) {
      log('failed to inject sidebar controls', e);
      controls.remove();
    }
  }

  function createFloatingPanel() {
    if (document.getElementById('cbd-floating-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'cbd-floating-panel';
    panel.setAttribute(ATTR_PANEL, 'floating');
    panel.innerHTML = `
      <div class="cbd-panel-header" id="cbd-panel-header">
        <div class="cbd-panel-title">
          <span class="cbd-panel-icon">☑</span>
          <span>Chat Bulk Delete</span>
          <span class="cbd-panel-badge" id="cbd-badge">0</span>
        </div>
        <div class="cbd-panel-actions">
          <button id="cbd-minimize" class="cbd-btn-icon" title="Minimize">—</button>
          <button id="cbd-close-panel" class="cbd-btn-icon" title="Hide panel (reopen via extension icon)">×</button>
        </div>
      </div>
      <div class="cbd-panel-body" id="cbd-panel-body">
        <div class="cbd-stats" id="cbd-stats">No conversations selected</div>
        <div class="cbd-filter-row">
          <input id="cbd-filter" class="cbd-input" placeholder="Filter conversations…" autocomplete="off" />
          <button id="cbd-filter-clear" class="cbd-btn-icon" title="Clear filter">×</button>
        </div>
        <div class="cbd-controls">
          <button id="cbd-select-all" class="cbd-btn cbd-btn-secondary">Select All</button>
          <button id="cbd-clear" class="cbd-btn cbd-btn-secondary">Clear</button>
          <button id="cbd-select-filtered" class="cbd-btn cbd-btn-secondary" hidden>Select Filtered</button>
        </div>
        <button id="cbd-delete" class="cbd-btn cbd-btn-danger cbd-delete-btn" disabled>🗑 Delete Selected</button>
        <div id="cbd-progress" class="cbd-progress" hidden></div>
        <div class="cbd-footer-note">Drives the native ChatGPT delete UI. No external requests.</div>
      </div>
    `;
    document.body.appendChild(panel);

    // Make draggable via header
    makeDraggable(panel, panel.querySelector('#cbd-panel-header'));

    // Wire events
    panel.querySelector('#cbd-minimize')?.addEventListener('click', () => {
      const body = panel.querySelector('#cbd-panel-body');
      if (body) body.hidden = !body.hidden;
      const btn = panel.querySelector('#cbd-minimize');
      if (btn) btn.textContent = body.hidden ? '+' : '—';
    });
    panel.querySelector('#cbd-close-panel')?.addEventListener('click', () => {
      panel.style.display = 'none';
    });
    panel.querySelector('#cbd-select-all')?.addEventListener('click', () => handleSelectAll());
    panel.querySelector('#cbd-clear')?.addEventListener('click', () => handleClear());
    panel.querySelector('#cbd-select-filtered')?.addEventListener('click', () => handleSelectFiltered());
    panel.querySelector('#cbd-delete')?.addEventListener('click', () => handleDeleteSelected());
    const filterInput = panel.querySelector('#cbd-filter');
    filterInput?.addEventListener('input', (e) => {
      const v = (e.target).value || '';
      applyFilter(v);
      const sidebarFilter = document.getElementById('cbd-sidebar-filter');
      if (sidebarFilter && sidebarFilter.value !== v) sidebarFilter.value = v;
      // toggle Select Filtered button
      const selFiltered = document.getElementById('cbd-select-filtered');
      if (selFiltered) selFiltered.hidden = !v.trim();
    });
    panel.querySelector('#cbd-filter-clear')?.addEventListener('click', () => {
      const inp = document.getElementById('cbd-filter');
      if (inp) inp.value = '';
      const sidebarFilter = document.getElementById('cbd-sidebar-filter');
      if (sidebarFilter) sidebarFilter.value = '';
      applyFilter('');
      const selFiltered = document.getElementById('cbd-select-filtered');
      if (selFiltered) selFiltered.hidden = true;
    });

    log('floating panel created');
  }

  function makeDraggable(panel, handle) {
    if (!handle || !panel) return;
    let startX = 0, startY = 0, origX = 0, origY = 0, dragging = false;
    handle.style.cursor = 'move';
    handle.addEventListener('mousedown', (e) => {
      // don't drag when clicking buttons
      if (e.target instanceof HTMLElement && e.target.closest('button')) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = panel.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      // Switch to left/top positioning if using right/bottom
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = origX + 'px';
      panel.style.top = origY + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      panel.style.left = (origX + dx) + 'px';
      panel.style.top = (origY + dy) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }

  function updateControlsUI() {
    const total = detected.size;
    const selected = selectedIds.size;

    // Update floating panel
    const badge = document.getElementById('cbd-badge');
    if (badge) badge.textContent = String(selected);
    const stats = document.getElementById('cbd-stats');
    if (stats) {
      if (selected === 0) stats.textContent = total ? `No selection — ${total} conversations loaded` : 'Scanning…';
      else stats.textContent = `${selected} selected / ${total} loaded`;
    }
    const deleteBtn = document.getElementById('cbd-delete');
    if (deleteBtn) {
      deleteBtn.disabled = selected === 0 || isDeleting;
      deleteBtn.textContent = selected ? `🗑 Delete Selected (${selected})` : '🗑 Delete Selected';
      deleteBtn.classList.toggle('cbd-btn-danger-active', selected > 0);
    }
    const sidebarCount = document.getElementById('cbd-sidebar-count');
    if (sidebarCount) {
      sidebarCount.textContent = selected ? `${selected} selected` : '0 selected';
      if (total) sidebarCount.title = `${total} conversations loaded`;
    }
    const sidebarDelete = document.getElementById('cbd-sidebar-delete');
    if (sidebarDelete) {
      sidebarDelete.disabled = selected === 0 || isDeleting;
      sidebarDelete.textContent = selected ? `🗑 Delete Selected (${selected})` : '🗑 Delete Selected';
    }
    // Update title for select filtered button
    const selFiltered = document.getElementById('cbd-select-filtered');
    if (selFiltered && filterQuery) {
      const filteredTitles = Array.from(detected.values()).filter(v => v.title.toLowerCase().includes(filterQuery));
      selFiltered.textContent = `Select Filtered (${filteredTitles.length})`;
    }
  }

  function updateProgress(current, total, id) {
    const info = detected.get(id);
    const title = info ? info.title : id;
    const text = `Deleting ${current}/${total}: ${title}`;
    const els = [document.getElementById('cbd-progress'), document.getElementById('cbd-sidebar-progress')];
    for (const el of els) {
      if (!el) continue;
      el.hidden = false;
      el.textContent = text;
      el.classList.add('cbd-progress-active');
    }
    // Also update delete button to show progress
    const btn = document.getElementById('cbd-delete');
    if (btn) btn.textContent = `⏳ ${current}/${total}…`;
    const sidebarBtn = document.getElementById('cbd-sidebar-delete');
    if (sidebarBtn) sidebarBtn.textContent = `⏳ ${current}/${total}…`;
  }

  function clearProgress() {
    for (const id of ['cbd-progress', 'cbd-sidebar-progress']) {
      const el = document.getElementById(id);
      if (el) { el.hidden = true; el.textContent = ''; el.classList.remove('cbd-progress-active'); }
    }
    updateControlsUI();
  }

  // ---------------------------------------------------------------------------
  // Bulk selection handlers
  // ---------------------------------------------------------------------------

  function handleSelectAll() {
    // Select all currently detected conversations, respecting filter if active?
    // Spec says Select All should select all. If filter is active, we débat:
    // Provide both: Select All selects everything, Select Filtered selects filtered.
    // Here Select All selects all *visible* (filtered) if filter active? Spec example
    // shows filter should narrow selection? Safer: if filter active, select only filtered.
    // We'll do: if filter active, select filtered; otherwise select all.
    if (filterQuery) {
      handleSelectFiltered();
      // Also offer to select all via second click? For now select filtered.
      // If user wants all, clear filter then Select All.
      // To handle spec correctly, change: Select All always selects all regardless of filter.
      // So we need to decide. We'll make Select All select all detected, ignore filter,
      // and Select Filtered button handles filtered.
      // For minimal confusion, if filter active and user clicked Select All (floating or sidebar),
      // we select all filtered? We already handled via Select Filtered.
      // Let's change behavior: Select All always selects all.
      // But we already returned filtered? Let's correct:
      // If called from Select All and filter active, select all anyway — user can use Clear Filter.
      // We will implement: Select All selects all.
    }
    // Select all detected
    for (const id of detected.keys()) selectedIds.add(id);
    syncSelectionToUI();
    try { ext.storage.local.set({ cbd_selectedIds: Array.from(selectedIds) }); } catch {}
  }

  function handleSelectFiltered() {
    if (!filterQuery) {
      handleSelectAll();
      return;
    }
    const q = filterQuery;
    for (const [id, info] of detected) {
      if (info.title.toLowerCase().includes(q)) selectedIds.add(id);
    }
    syncSelectionToUI();
    try { ext.storage.local.set({ cbd_selectedIds: Array.from(selectedIds) }); } catch {}
  }

  function handleClear() {
    selectedIds.clear();
    // clear filter as well? No, keep filter
    syncSelectionToUI();
    try { ext.storage.local.set({ cbd_selectedIds: [] }); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Confirmation & summary modals (our own, not ChatGPT's)
  // ---------------------------------------------------------------------------

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'cbd-overlay';
    overlay.className = 'cbd-overlay';
    overlay.setAttribute(ATTR_PANEL, 'overlay');
    // Clicking overlay background cancels (but not clicking modal)
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    return overlay;
  }

  function showConfirmationDialog(count) {
    return new Promise((resolve) => {
      const overlay = createOverlay();
      const modal = document.createElement('div');
      modal.className = 'cbd-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      const isLarge = count > 10;
      const extraWarning = isLarge
        ? `<div class="cbd-warning cbd-warning-strong">⚠️ You are about to permanently delete <strong>${count}</strong> conversations. This action cannot be undone.</div>`
        : '';

      // For large selections, require checkbox confirmation
      const checkboxHtml = isLarge
        ? `<label class="cbd-confirm-check"><input type="checkbox" id="cbd-confirm-check" /> I understand this will permanently delete ${count} conversations</label>`
        : '';

      modal.innerHTML = `
        <div class="cbd-modal-header">Confirm Deletion</div>
        <div class="cbd-modal-body">
          <p>Delete <strong>${count}</strong> conversation${count === 1 ? '' : 's'}? This action cannot be undone.</p>
          ${extraWarning}
          ${checkboxHtml}
          <div class="cbd-modal-list" id="cbd-modal-list"></div>
        </div>
        <div class="cbd-modal-footer">
          <button id="cbd-confirm-cancel" class="cbd-btn cbd-btn-secondary">Cancel</button>
          <button id="cbd-confirm-ok" class="cbd-btn cbd-btn-danger" ${isLarge ? 'disabled' : ''}>Delete ${count} conversation${count === 1 ? '' : 's'}</button>
        </div>
      `;
      overlay.appendChild(modal);

      // Show preview of titles (first 6)
      const listEl = modal.querySelector('#cbd-modal-list');
      if (listEl) {
        const titles = Array.from(selectedIds).slice(0, 6).map(id => {
          const info = detected.get(id);
          return info ? info.title : id;
        });
        if (titles.length) {
          const ul = document.createElement('ul');
          ul.className = 'cbd-modal-preview';
          for (const t of titles) {
            const li = document.createElement('li');
            li.textContent = t;
            ul.appendChild(li);
          }
          if (selectedIds.size > 6) {
            const li = document.createElement('li');
            li.textContent = `…and ${selectedIds.size - 6} more`;
            li.className = 'cbd-muted';
            ul.appendChild(li);
          }
          listEl.appendChild(ul);
        }
      }

      const okBtn = modal.querySelector('#cbd-confirm-ok');
      const cancelBtn = modal.querySelector('#cbd-confirm-cancel');
      const check = modal.querySelector('#cbd-confirm-check');

      if (check) {
        check.addEventListener('change', () => {
          okBtn.disabled = !check.checked;
        });
      }

      let resolved = false;
      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        overlay.remove();
        resolve(value);
      };

      okBtn?.addEventListener('click', () => finish(true));
      cancelBtn?.addEventListener('click', () => finish(false));
      // Escape closes
      const onKey = (e) => {
        if (e.key === 'Escape') { window.removeEventListener('keydown', onKey); finish(false); }
      };
      window.addEventListener('keydown', onKey);
      // Focus OK if not large, else focus checkbox
      setTimeout(() => {
        if (isLarge && check) check.focus();
        else okBtn?.focus();
      }, 50);
    });
  }

  function showSummaryModal(succeeded, failed, cancelled) {
    const overlay = createOverlay();
    const modal = document.createElement('div');
    modal.className = 'cbd-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const failedList = failed.length
      ? `<ul class="cbd-summary-list">${failed.map(f => `<li><strong>${escapeHtml(f.title || f.id)}</strong><br><span class="cbd-muted">${escapeHtml(f.error || 'Unknown error')}</span></li>`).join('')}</ul>`
      : '<p class="cbd-muted">No failures.</p>';

    const succeededList = succeeded.length && failed.length
      ? `<details class="cbd-details"><summary>Show successful (${succeeded.length})</summary><ul class="cbd-summary-list">${succeeded.map(id => {
            const info = detected.get(id);
            return `<li>${escapeHtml(info ? info.title : id)}</li>`;
          }).join('')}</ul></details>`
      : '';

    modal.innerHTML = `
      <div class="cbd-modal-header">${cancelled ? 'Deletion Cancelled' : 'Deletion Complete'}</div>
      <div class="cbd-modal-body">
        <div class="cbd-summary-grid">
          <div class="cbd-summary-card cbd-summary-success">
            <div class="cbd-summary-number">${succeeded.length}</div>
            <div class="cbd-summary-label">Successfully deleted</div>
          </div>
          <div class="cbd-summary-card ${failed.length ? 'cbd-summary-error' : ''}">
            <div class="cbd-summary-number">${failed.length}</div>
            <div class="cbd-summary-label">Failed</div>
          </div>
        </div>
        ${failed.length ? `<div class="cbd-summary-section"><h4>Failed conversations</h4>${failedList}</div>` : ''}
        ${succeededList}
        <p class="cbd-muted" style="margin-top:12px;">Tip: If some failed, scroll the sidebar to ensure they are loaded, then try again. ChatGPT may have changed its UI — see README debugging.</p>
      </div>
      <div class="cbd-modal-footer">
        <button id="cbd-summary-close" class="cbd-btn cbd-btn-primary">Close</button>
        ${failed.length ? '<button id="cbd-summary-retry" class="cbd-btn cbd-btn-secondary">Retry failed</button>' : ''}
      </div>
    `;
    overlay.appendChild(modal);

    modal.querySelector('#cbd-summary-close')?.addEventListener('click', () => overlay.remove());
    modal.querySelector('#cbd-summary-retry')?.addEventListener('click', () => {
      overlay.remove();
      // Re-select failed ids and retry
      selectedIds.clear();
      for (const f of failed) selectedIds.add(f.id);
      syncSelectionToUI();
      handleDeleteSelected();
    });
    // Escape
    const onKey = (e) => { if (e.key === 'Escape') { window.removeEventListener('keydown', onKey); overlay.remove(); } };
    window.addEventListener('keydown', onKey);
    setTimeout(() => modal.querySelector('#cbd-summary-close')?.focus(), 50);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Deletion — sequential, cautious
  // ---------------------------------------------------------------------------

  async function deleteSingleConversation(id) {
    const info = detected.get(id);
    const title = info ? info.title : id;

    // 1) Locate anchor
    let anchor = findConversationAnchor(id);
    if (!anchor) {
      throw new Error(`Conversation not found in sidebar. Scroll to load it, then try again. (id: ${id})`);
    }
    // Ensure anchor is scrolled into view (helps with virtualized lists)
    anchor.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    await sleep(80);

    // 2) Find row & options button
    const row = findConversationRow(anchor);
    if (!row) throw new Error(`Row container not found for "${title}"`);
    let optionsButton = findOptionsButton(row, anchor);
    if (!optionsButton) {
      // Try broader search near anchor
      const near = anchor.closest('li, div')?.querySelector('button');
      if (near) optionsButton = near;
    }
    if (!optionsButton) {
      throw new Error(`Options button (⋯) not found for "${title}". ChatGPT UI may have changed. See README debugging.`);
    }

    // 3) Reveal & click options
    await revealOptionsButton(row);
    await sleep(100);
    // Re-find in case DOM changed after hover
    optionsButton = findOptionsButton(row, anchor) || optionsButton;
    if (!optionsButton || !optionsButton.isConnected) throw new Error(`Options button became detached for "${title}"`);
    // Ensure visible
    optionsButton.style.opacity = '1';
    optionsButton.click();
    log(`clicked options for ${title} (${id})`);

    // 4) Wait for menu + find Delete item
    await sleep(180);
    let deleteItem = null;
    const menuStart = performance.now();
    while (performance.now() - menuStart < 2600) {
      deleteItem = findDeleteMenuItem();
      if (deleteItem) break;
      await sleep(90);
    }
    if (!deleteItem) {
      dispatchEscape();
      await sleep(150);
      throw new Error(`Delete menu item not found for "${title}". The options menu did not appear.`);
    }
    // Verify deleteItem is inside an open menu
    // Click it
    deleteItem.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await sleep(40);
    if (deleteItem instanceof HTMLElement) deleteItem.click();
    else deleteItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    log(`clicked Delete for ${title}`);

    // 5) Wait for confirmation modal
    await sleep(150);
    let modal = null;
    const modalStart = performance.now();
    while (performance.now() - modalStart < 2600) {
      modal = findConfirmModal();
      if (modal) break;
      await sleep(90);
    }
    if (!modal) {
      // Maybe menu click already triggered immediate deletion (Grok does this, but ChatGPT requires confirm)
      // Check if anchor disappeared
      await sleep(400);
      if (!findConversationAnchor(id)) {
        log(`no confirm modal but anchor gone — treating as success for ${title}`);
        return;
      }
      dispatchEscape();
      throw new Error(`Confirmation dialog not found for "${title}".`);
    }

    // 6) Find & click confirm button
    let confirmBtn = findConfirmButton(modal);
    if (!confirmBtn) {
      dispatchEscape();
      throw new Error(`Confirm button not found for "${title}".`);
    }
    await waitUntilEnabled(confirmBtn, 1800);
    if (confirmBtn.disabled || confirmBtn.getAttribute('aria-disabled') === 'true') {
      throw new Error(`Confirm button stayed disabled for "${title}".`);
    }
    // Extra safety: ensure modal still open
    if (!modal.isConnected) throw new Error(`Confirmation dialog closed unexpectedly for "${title}".`);
    confirmBtn.click();
    log(`clicked Confirm for ${title}`);

    // 7) Wait for modal to close
    const modalGone = await waitUntilGone(() => findConfirmModal(), 3500);
    if (!modalGone) {
      log(`warning: modal still present after confirm for ${title}, pressing Escape`);
      dispatchEscape();
      await sleep(300);
    }

    // 8) Wait for deletion to complete — anchor removal or grayed state
    // ChatGPT turns row gray while API call in progress, then removes after ~1-2s.
    // We wait for anchor to disappear, but don't fail if it stays (maybe slow).
    await sleep(400);
    const anchorGone = await waitUntilGone(() => findConversationAnchor(id), 3500);
    if (!anchorGone) {
      // Check if row is still there but maybe marked as deleting?
      const stillAnchor = findConversationAnchor(id);
      if (stillAnchor) {
        log(`anchor still present after confirm for ${title} — may be slow; treating as failure?`);
        // Consider it still success if modal gone, but warn caller
        // For reliability, require anchor gone; otherwise record failure
        // Let's check if row has opacity 0.5 or similar? Not reliable.
        // We'll do one more wait:
        await sleep(800);
        if (findConversationAnchor(id)) {
          throw new Error(`Conversation still present after deletion (maybe not deleted): "${title}"`);
        }
      }
    }

    // Verify: ensure menu closed
    dispatchEscape();
    await sleep(200);
  }

  async function bulkDeleteSequential(ids) {
    isDeleting = true;
    cancelRequested = false;
    updateControlsUI();

    const succeeded = [];
    const failed = [];

    // Add cancel button to progress areas
    const addCancel = () => {
      const areas = [document.getElementById('cbd-progress'), document.getElementById('cbd-sidebar-progress')];
      for (const area of areas) {
        if (!area || area.querySelector('.cbd-cancel-btn')) continue;
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.className = 'cbd-btn cbd-btn-secondary cbd-cancel-btn';
        cancelBtn.addEventListener('click', () => {
          cancelRequested = true;
          cancelBtn.textContent = 'Cancelling…';
          cancelBtn.disabled = true;
        });
        area.appendChild(document.createElement('br'));
        area.appendChild(cancelBtn);
      }
    };

    for (let i = 0; i < ids.length; i++) {
      if (cancelRequested) {
        log('deletion cancelled by user');
        break;
      }
      const id = ids[i];
      const info = detected.get(id);
      updateProgress(i + 1, ids.length, id);
      addCancel();
      try {
        await deleteSingleConversation(id);
        succeeded.push(id);
        // Remove from selection & detected after success
        selectedIds.delete(id);
        // The anchor should be gone; but keep detected map cleanup to observer
        log(`✓ deleted ${info ? info.title : id} (${i + 1}/${ids.length})`);
        // Small delay between deletions to let React settle
        await sleep(650);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`✗ failed to delete ${info ? info.title : id}: ${msg}`);
        failed.push({ id, title: info ? info.title : id, error: msg });
        // Close any stray menus/modals before next
        dispatchEscape();
        await sleep(500);
        // Continue to next — but if many failures (>3) maybe UI changed, abort?
        // We'll continue anyway; caller will show summary.
      }
      // Persist selection after each deletion
      try { ext.storage.local.set({ cbd_selectedIds: Array.from(selectedIds) }); } catch {}
      syncSelectionToUI();
    }

    isDeleting = false;
    clearProgress();
    syncSelectionToUI();

    // Remove empty filter hides? Re-apply
    // After deletions, trigger rescan
    scheduleScan(0);

    const cancelled = cancelRequested;
    cancelRequested = false;
    return { succeeded, failed, cancelled };
  }

  async function handleDeleteSelected() {
    if (isDeleting) return;
    if (selectedIds.size === 0) {
      alert('No conversations selected.');
      return;
    }
    const count = selectedIds.size;
    const confirmed = await showConfirmationDialog(count);
    if (!confirmed) return;

    const ids = Array.from(selectedIds);
    // Double-check IDs still correspond to detected? Keep as is — user may have selected via filter
    log(`starting bulk delete of ${ids.length} conversations`);
    const result = await bulkDeleteSequential(ids);

    // Show summary
    showSummaryModal(result.succeeded, result.failed, result.cancelled);

    // After success, clear selection for succeeded? Already removed.
    // If all succeeded, selected should be empty.
    // Trigger rescan
    scheduleScan(500);
  }

  // ---------------------------------------------------------------------------
  // Observer & initialization
  // ---------------------------------------------------------------------------

  function scheduleScan(delay = 250) {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      try {
        injectCheckboxes();
        // If sidebar controls not yet injected, try again
        if (!document.getElementById('cbd-sidebar-controls')) {
          createSidebarControls();
        }
      } catch (e) {
        log('scan error', e);
      }
    }, delay);
  }

  function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own UI
      let shouldScan = false;
      for (const mut of mutations) {
        const target = mut.target;
        if (target instanceof HTMLElement) {
          if (target.closest(`[${ATTR_PANEL}]`) || target.closest(`[${ATTR_CHECKBOX}]`) || target.closest('.cbd-')) {
            // Check if added nodes are our checkboxes — ignore
            if (mut.addedNodes.length) {
              let isOurNode = false;
              for (const n of mut.addedNodes) {
                if (n instanceof HTMLElement && (n.hasAttribute(ATTR_CHECKBOX) || n.hasAttribute(ATTR_PANEL) || n.classList.contains('cbd-checkbox-wrapper'))) {
                  isOurNode = true; break;
                }
              }
              if (isOurNode) continue;
            } else {
              continue;
            }
          }
        }
        // If any added node contains a conversation link, we should scan
        for (const node of [...mut.addedNodes]) {
          if (node instanceof HTMLElement) {
            if (node.matches && node.matches(SELECTORS.conversationLink)) { shouldScan = true; break; }
            if (node.querySelector && node.querySelector(SELECTORS.conversationLink)) { shouldScan = true; break; }
          }
        }
        if (shouldScan) break;
        // Also if removed nodes contained conversation links, scan to update counts
        for (const node of [...mut.removedNodes]) {
          if (node instanceof HTMLElement) {
            if (node.matches && node.matches(SELECTORS.conversationLink)) { shouldScan = true; break; }
            if (node.querySelector && node.querySelector(SELECTORS.conversationLink)) { shouldScan = true; break; }
          }
        }
        if (shouldScan) break;
        // Attribute changes on links? treat as scan trigger but throttled
        if (mut.type === 'attributes' && mut.target instanceof HTMLElement) {
          if (mut.target.matches(SELECTORS.conversationLink)) { shouldScan = true; break; }
        }
      }
      // Fallback: if we haven't detected any conversations yet, scan periodically anyway
      if (!shouldScan && detected.size === 0) {
        // Check if new links appeared without mutation? (unlikely)
        const links = document.querySelectorAll(SELECTORS.conversationLink);
        if (links.length > 0) shouldScan = true;
      }
      if (shouldScan) scheduleScan(250);
    });

    // Observe documentElement with sensible filters — avoid observing every characterData mutation
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

    // Throttled scroll listener for lazy-loaded sidebar: when user scrolls sidebar, new items may load
    const sidebar = findSidebarContainer();
    if (sidebar) {
      sidebar.addEventListener('scroll', () => scheduleScan(300), { passive: true });
    }
    window.addEventListener('scroll', () => scheduleScan(400), { passive: true });

    log('MutationObserver set up');
  }

  function restoreSelectionFromStorage() {
    try {
      ext.storage.local.get(['cbd_selectedIds'], (res) => {
        if (res && Array.isArray(res.cbd_selectedIds)) {
          for (const id of res.cbd_selectedIds) selectedIds.add(id);
          syncSelectionToUI();
          log('restored selection', selectedIds.size);
        }
      });
    } catch {}
    // Also restore panel visibility
    try {
      ext.storage.local.get(['cbd_panelHidden'], (res) => {
        if (res && res.cbd_panelHidden) {
          const p = document.getElementById('cbd-floating-panel');
          if (p) p.style.display = 'none';
        }
      });
    } catch {}
  }

  // Handle messages from popup
  function setupMessageListener() {
    try {
      ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type) return;
        switch (msg.type) {
          case 'CBD_TOGGLE_PANEL': {
            const panel = document.getElementById('cbd-floating-panel');
            if (panel) {
              const willShow = panel.style.display === 'none';
              panel.style.display = willShow ? '' : 'none';
              try { ext.storage.local.set({ cbd_panelHidden: !willShow }); } catch {}
              sendResponse({ visible: willShow });
            } else {
              createFloatingPanel();
              sendResponse({ visible: true });
            }
            break;
          }
          case 'CBD_GET_STATE': {
            sendResponse({
              selectedCount: selectedIds.size,
              detectedCount: detected.size,
              isDeleting,
              selectedIds: Array.from(selectedIds),
              detected: Array.from(detected.entries()).map(([id, v]) => ({ id, title: v.title, url: v.url }))
            });
            break;
          }
          case 'CBD_SELECT_ALL': handleSelectAll(); sendResponse({ ok: true }); break;
          case 'CBD_CLEAR': handleClear(); sendResponse({ ok: true }); break;
          case 'CBD_RESCAN': scheduleScan(0); sendResponse({ ok: true }); break;
          default: break;
        }
        return true;
      });
    } catch (e) {
      log('message listener setup failed', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  function init() {
    if (window.__CBD_INITIALIZED) {
      log('already initialized, skipping');
      return;
    }
    window.__CBD_INITIALIZED = true;

    log('initializing Chat Bulk Delete…');
    // Create UI
    createFloatingPanel();
    createSidebarControls();
    // Initial scan
    injectCheckboxes();
    // Observer
    setupObserver();
    setupMessageListener();
    restoreSelectionFromStorage();

    // Periodic re-scan as safety net for virtualized lists (every 2s for first 10s, then 5s)
    let quickScans = 0;
    const quickInterval = setInterval(() => {
      quickScans++;
      injectCheckboxes();
      if (quickScans >= 5) clearInterval(quickInterval);
    }, 2000);
    setInterval(() => {
      if (!isDeleting) injectCheckboxes();
    }, 5000);

    // Handle SPA navigation (ChatGPT uses pushState without full reload)
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('navigation detected to', lastUrl);
        scheduleScan(500);
        // Re-inject sidebar controls if nav changed
        setTimeout(() => {
          if (!document.getElementById('cbd-sidebar-controls')) createSidebarControls();
        }, 800);
      }
    }, 1000);

    // Keyboard shortcut: Ctrl+Shift+D toggles panel? optional, not required
    log('ready — detected', detected.size, 'conversations');
  }

  // Wait for DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Delay slightly to let ChatGPT's React hydrate
    setTimeout(init, 800);
  }
  // Also try again after window load
  window.addEventListener('load', () => setTimeout(() => {
    if (!document.getElementById('cbd-floating-panel')) init();
    else scheduleScan(0);
  }, 1000));

})();
