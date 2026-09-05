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
  // Constants & selectors — FIXED for Bugs 1,5,6,7
  // ---------------------------------------------------------------------------

  // Use required data attributes per bug fixes
  const ATTR_CHECKBOX = 'data-chat-bulk-checkbox'; // Bug6
  const ATTR_UI = 'data-chat-bulk-delete-ui'; // Bug2 idempotent
  const ATTR_ROW = 'data-cbd-row'; // internal row marker, keeps stable mapping
  const ATTR_INJECTED = 'data-cbd-injected'; // legacy, kept for migration
  // Keep ATTR_PANEL for backwards compat but not used for floating
  const ATTR_PANEL = 'data-cbd-panel';

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
  // State — Bug5: maintain Set<stableId>, not DOM position
  // ---------------------------------------------------------------------------

  /** @type {Set<string>} conversation ids — stable IDs from href */
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
  // Conversation detection — Bug7: use stable href ID, never title/index
  // ---------------------------------------------------------------------------

  function isConversationLinkElement(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return false;
    const href = anchor.getAttribute('href') || '';
    const id = getConversationIdFromHref(href);
    if (!id) return false;
    // Exclude links that are not in sidebar history.
    // We allow links anywhere initially, but filter out:
    // - links inside our own panel (data-chat-bulk-delete-ui)
    // - links with /g/ (GPTs), /project, /share etc.
    if (anchor.closest(`[${ATTR_UI}]`) || anchor.closest(`[${ATTR_PANEL}]`)) return false;
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
  // Checkbox injection — Bugs 1,5,6 fixed
  // ---------------------------------------------------------------------------

  function syncSelectionToUI() {
    // Update all injected checkboxes to reflect Set state — survives re-render
    const boxes = document.querySelectorAll(`input[${ATTR_CHECKBOX}]`);
    for (const box of boxes) {
      const cid = box.dataset.conversationId;
      if (!cid) continue;
      // @ts-ignore
      box.checked = selectedIds.has(cid);
      // Update row highlight
      const row = box.closest(`[${ATTR_ROW}]`) || box.closest(`[${ATTR_UI}]`)?.parentElement || box.parentElement;
      // More precise: find row via closest that contains the anchor
      const actualRow = box.closest('.cbd-row') || box.parentElement;
      if (actualRow instanceof HTMLElement) {
        actualRow.classList.toggle('cbd-selected', selectedIds.has(cid));
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
          // keep selectedIds per Bug5 - do not auto-deselect
        }
      }
    }

    let injectedCount = 0;
    for (const [id, info] of found) {
      const { anchor, row } = info;
      if (!row) continue;

      // Bug6: do NOT duplicate checkboxes — check exact conversation element
      // Use required attribute data-chat-bulk-checkbox
      if (row.querySelector(`[${ATTR_CHECKBOX}]`)) {
        // Reconcile: ensure existing checkbox reflects current Set (survives re-render)
        const existing = row.querySelector(`input[${ATTR_CHECKBOX}]`);
        if (existing instanceof HTMLInputElement) {
          // Ensure dataset still correct
          if (existing.dataset.conversationId !== id) {
            existing.dataset.conversationId = id;
          }
          existing.checked = selectedIds.has(id);
          row.classList.toggle('cbd-selected', selectedIds.has(id));
        }
        // Also ensure row has marker
        if (!row.hasAttribute(ATTR_ROW)) row.setAttribute(ATTR_ROW, id);
        continue;
      }
      // Also check anchor level duplicate (in case row was not found correctly)
      if (anchor.hasAttribute(ATTR_CHECKBOX) || anchor.querySelector(`[${ATTR_CHECKBOX}]`)) continue;

      // Create wrapper + checkbox — Bug1: bind directly to stable conversationId via dataset
      const wrapper = document.createElement('span');
      wrapper.className = 'cbd-checkbox-wrapper';
      wrapper.setAttribute(ATTR_ROW, id); // mark wrapper row
      // Ensure wrapper doesn't capture row click unless checkbox clicked
      wrapper.addEventListener('click', (e) => e.stopPropagation());

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'cbd-checkbox';
      cb.setAttribute(ATTR_CHECKBOX, 'true');
      cb.dataset.conversationId = id; // Bug1: stable ID binding
      cb.setAttribute('aria-label', `Select conversation: ${info.title}`);
      cb.checked = selectedIds.has(id);
      // Bug1 fix: single change handler reading event.currentTarget.dataset.conversationId
      // Never use document.querySelectorAll(...)[index] inside handler
      cb.addEventListener('change', (event) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLInputElement)) return;
        const cid = target.dataset.conversationId;
        if (!cid) return;
        event.stopPropagation();
        if (target.checked) {
          selectedIds.add(cid);
        } else {
          selectedIds.delete(cid);
        }
        // Update UI and persist
        syncSelectionToUI();
        try {
          ext.storage.local.set({ cbd_selectedIds: Array.from(selectedIds) });
        } catch {}
      });
      // Only stop propagation on click to prevent opening conversation; do NOT preventDefault
      cb.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      wrapper.appendChild(cb);

      // Insert wrapper before anchor, or as first child of row
      try {
        // If row is the anchor's direct parent, insert before anchor
        if (anchor.parentElement === row) {
          row.insertBefore(wrapper, anchor);
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

    updateControlsUI();
    return found.size;
  }

  // ---------------------------------------------------------------------------
  // Filter logic — Bug8: filter only hides, never deselects
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
      row.style.display = 'none';
    }
  }

  function applyFilter(query) {
    filterQuery = (query || '').trim().toLowerCase();
    for (const [, info] of detected) {
      if (info.row) applyFilterToRow(info.row, info.title);
    }
    updateControlsUI();
  }

  // ---------------------------------------------------------------------------
  // Controls UI — Bug2: single sidebar UI, idempotent
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
    // Bug2 idempotent: exactly ONE UI instance
    if (document.querySelector(`[${ATTR_UI}="true"]`)) return;
    if (document.getElementById('cbd-sidebar-controls')) return;
    const container = findSidebarContainer();
    if (!container) {
      log('sidebar container not found, skipping sidebar controls injection');
      return;
    }

    const controls = document.createElement('div');
    controls.id = 'cbd-sidebar-controls';
    controls.setAttribute(ATTR_UI, 'true');
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
        const v = e.target.value || '';
        applyFilter(v);
      });
      filterClear?.addEventListener('click', () => {
        const inp = document.getElementById('cbd-sidebar-filter');
        if (inp) inp.value = '';
        applyFilter('');
      });

      log('sidebar controls injected into', container);
    } catch (e) {
      log('failed to inject sidebar controls', e);
      controls.remove();
    }
  }

  // REMOVED: createFloatingPanel and makeDraggable — Bug2 single UI requirement
  // floating panel deleted completely

  function updateControlsUI() {
    const total = detected.size;
    const selected = selectedIds.size;

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
  }

  function updateProgress(current, total, id) {
    const info = detected.get(id);
    const title = info ? info.title : id;
    const text = `Deleting ${current}/${total}: ${title}`;
    const el = document.getElementById('cbd-sidebar-progress');
    if (!el) return;
    el.hidden = false;
    el.textContent = text;
    el.classList.add('cbd-progress-active');
    const sidebarBtn = document.getElementById('cbd-sidebar-delete');
    if (sidebarBtn) sidebarBtn.textContent = `⏳ ${current}/${total}…`;
  }

  function clearProgress() {
    const el = document.getElementById('cbd-sidebar-progress');
    if (el) { el.hidden = true; el.textContent = ''; el.classList.remove('cbd-progress-active'); }
    updateControlsUI();
  }

  // ---------------------------------------------------------------------------
  // Bulk selection handlers — Bug9 fixed
  // ---------------------------------------------------------------------------

  function handleSelectAll() {
    // Bug9: select all detected, not unrelated elements, not filtered subset
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
    syncSelectionToUI();
    try { ext.storage.local.set({ cbd_selectedIds: [] }); } catch {}
  }

  // ---------------------------------------------------------------------------
  // Confirmation & toast (Bug4: remove large Deletion Complete modal)
  // ---------------------------------------------------------------------------

  function createOverlay() {
    const overlay = document.createElement('div');
    overlay.id = 'cbd-overlay';
    overlay.className = 'cbd-overlay';
    overlay.setAttribute(ATTR_PANEL, 'overlay');
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
      const onKey = (e) => {
        if (e.key === 'Escape') { window.removeEventListener('keydown', onKey); finish(false); }
      };
      window.addEventListener('keydown', onKey);
      setTimeout(() => {
        if (isLarge && check) check.focus();
        else okBtn?.focus();
      }, 50);
    });
  }

  // Bug4: small toast instead of large modal
  function showToast(text) {
    let toast = document.getElementById('cbd-toast');
    if (toast) toast.remove();
    toast = document.createElement('div');
    toast.id = 'cbd-toast';
    toast.className = 'cbd-toast';
    toast.textContent = text;
    document.body.appendChild(toast);
    // trigger animation
    requestAnimationFrame(() => toast.classList.add('cbd-toast-show'));
    setTimeout(() => {
      toast.classList.remove('cbd-toast-show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------------
  // Deletion — sequential, cautious — Bug10 preserved
  // ---------------------------------------------------------------------------

  async function deleteSingleConversation(id) {
    const info = detected.get(id);
    const title = info ? info.title : id;

    let anchor = findConversationAnchor(id);
    if (!anchor) {
      throw new Error(`Conversation not found in sidebar. Scroll to load it, then try again. (id: ${id})`);
    }
    anchor.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    await sleep(80);

    const row = findConversationRow(anchor);
    if (!row) throw new Error(`Row container not found for "${title}"`);
    let optionsButton = findOptionsButton(row, anchor);
    if (!optionsButton) {
      const near = anchor.closest('li, div')?.querySelector('button');
      if (near) optionsButton = near;
    }
    if (!optionsButton) {
      throw new Error(`Options button (⋯) not found for "${title}". ChatGPT UI may have changed. See README debugging.`);
    }

    await revealOptionsButton(row);
    await sleep(100);
    optionsButton = findOptionsButton(row, anchor) || optionsButton;
    if (!optionsButton || !optionsButton.isConnected) throw new Error(`Options button became detached for "${title}"`);
    optionsButton.style.opacity = '1';
    optionsButton.click();
    log(`clicked options for ${title} (${id})`);

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
    deleteItem.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    await sleep(40);
    if (deleteItem instanceof HTMLElement) deleteItem.click();
    else deleteItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    log(`clicked Delete for ${title}`);

    await sleep(150);
    let modal = null;
    const modalStart = performance.now();
    while (performance.now() - modalStart < 2600) {
      modal = findConfirmModal();
      if (modal) break;
      await sleep(90);
    }
    if (!modal) {
      await sleep(400);
      if (!findConversationAnchor(id)) {
        log(`no confirm modal but anchor gone — treating as success for ${title}`);
        return;
      }
      dispatchEscape();
      throw new Error(`Confirmation dialog not found for "${title}".`);
    }

    let confirmBtn = findConfirmButton(modal);
    if (!confirmBtn) {
      dispatchEscape();
      throw new Error(`Confirm button not found for "${title}".`);
    }
    await waitUntilEnabled(confirmBtn, 1800);
    if (confirmBtn.disabled || confirmBtn.getAttribute('aria-disabled') === 'true') {
      throw new Error(`Confirm button stayed disabled for "${title}".`);
    }
    if (!modal.isConnected) throw new Error(`Confirmation dialog closed unexpectedly for "${title}".`);
    confirmBtn.click();
    log(`clicked Confirm for ${title}`);

    const modalGone = await waitUntilGone(() => findConfirmModal(), 3500);
    if (!modalGone) {
      log(`warning: modal still present after confirm for ${title}, pressing Escape`);
      dispatchEscape();
      await sleep(300);
    }

    await sleep(400);
    const anchorGone = await waitUntilGone(() => findConversationAnchor(id), 3500);
    if (!anchorGone) {
      const stillAnchor = findConversationAnchor(id);
      if (stillAnchor) {
        log(`anchor still present after confirm for ${title} — may be slow; treating as failure?`);
        await sleep(800);
        if (findConversationAnchor(id)) {
          throw new Error(`Conversation still present after deletion (maybe not deleted): "${title}"`);
        }
      }
    }

    dispatchEscape();
    await sleep(200);
  }

  async function bulkDeleteSequential(ids) {
    isDeleting = true;
    cancelRequested = false;
    updateControlsUI();

    const succeeded = [];
    const failed = [];

    const addCancel = () => {
      const area = document.getElementById('cbd-sidebar-progress');
      if (!area || area.querySelector('.cbd-cancel-btn')) return;
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
        selectedIds.delete(id);
        log(`✓ deleted ${info ? info.title : id} (${i + 1}/${ids.length})`);
        await sleep(650);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`✗ failed to delete ${info ? info.title : id}: ${msg}`);
        failed.push({ id, title: info ? info.title : id, error: msg });
        dispatchEscape();
        await sleep(500);
      }
      try { ext.storage.local.set({ cbd_selectedIds: Array.from(selectedIds) }); } catch {}
      syncSelectionToUI();
    }

    isDeleting = false;
    clearProgress();
    syncSelectionToUI();
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
    log(`starting bulk delete of ${ids.length} conversations`);
    const result = await bulkDeleteSequential(ids);

    // Bug4: no large modal, just toast + update count
    if (result.succeeded.length) {
      showToast(`${result.succeeded.length} conversation${result.succeeded.length===1?'':'s'} deleted${result.failed.length? `, ${result.failed.length} failed`:''}`);
    } else if (result.failed.length) {
      showToast(`${result.failed.length} deletion${result.failed.length===1?'':'s'} failed`);
    } else if (result.cancelled) {
      showToast('Deletion cancelled');
    }
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
        if (!document.querySelector(`[${ATTR_UI}="true"]`)) {
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
      let shouldScan = false;
      for (const mut of mutations) {
        const target = mut.target;
        if (target instanceof HTMLElement) {
          if (target.closest(`[${ATTR_UI}]`) || target.closest(`[${ATTR_CHECKBOX}]`) || target.closest('.cbd-')) {
            if (mut.addedNodes.length) {
              let isOurNode = false;
              for (const n of mut.addedNodes) {
                if (n instanceof HTMLElement && (n.hasAttribute(ATTR_CHECKBOX) || n.hasAttribute(ATTR_UI) || n.classList.contains('cbd-checkbox-wrapper'))) {
                  isOurNode = true; break;
                }
              }
              if (isOurNode) continue;
            } else {
              continue;
            }
          }
        }
        for (const node of [...mut.addedNodes]) {
          if (node instanceof HTMLElement) {
            if (node.matches && node.matches(SELECTORS.conversationLink)) { shouldScan = true; break; }
            if (node.querySelector && node.querySelector(SELECTORS.conversationLink)) { shouldScan = true; break; }
          }
        }
        if (shouldScan) break;
        for (const node of [...mut.removedNodes]) {
          if (node instanceof HTMLElement) {
            if (node.matches && node.matches(SELECTORS.conversationLink)) { shouldScan = true; break; }
            if (node.querySelector && node.querySelector(SELECTORS.conversationLink)) { shouldScan = true; break; }
          }
        }
        if (shouldScan) break;
        if (mut.type === 'attributes' && mut.target instanceof HTMLElement) {
          if (mut.target.matches(SELECTORS.conversationLink)) { shouldScan = true; break; }
        }
      }
      if (!shouldScan && detected.size === 0) {
        const links = document.querySelectorAll(SELECTORS.conversationLink);
        if (links.length > 0) shouldScan = true;
      }
      if (shouldScan) scheduleScan(250);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: false,
      characterData: false
    });

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
  }

  function setupMessageListener() {
    try {
      ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.type) return;
        switch (msg.type) {
          case 'CBD_TOGGLE_PANEL': {
            // Bug2: floating panel removed, toggle sidebar UI instead
            const panel = document.querySelector(`[${ATTR_UI}="true"]`);
            if (panel instanceof HTMLElement) {
              const willShow = panel.style.display === 'none';
              panel.style.display = willShow ? '' : 'none';
              sendResponse({ visible: willShow });
            } else {
              createSidebarControls();
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
  // Init — idempotent
  // ---------------------------------------------------------------------------

  function init() {
    if (window.__CBD_INITIALIZED) {
      log('already initialized, skipping');
      return;
    }
    window.__CBD_INITIALIZED = true;

    log('initializing Chat Bulk Delete…');
    // Only sidebar UI — no floating panel (Bug2)
    createSidebarControls();
    injectCheckboxes();
    setupObserver();
    setupMessageListener();
    restoreSelectionFromStorage();

    let quickScans = 0;
    const quickInterval = setInterval(() => {
      quickScans++;
      injectCheckboxes();
      if (quickScans >= 5) clearInterval(quickInterval);
    }, 2000);
    setInterval(() => {
      if (!isDeleting) injectCheckboxes();
    }, 5000);

    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        log('navigation detected to', lastUrl);
        scheduleScan(500);
        setTimeout(() => {
          if (!document.querySelector(`[${ATTR_UI}="true"]`)) createSidebarControls();
        }, 800);
      }
    }, 1000);

    log('ready — detected', detected.size, 'conversations');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 800);
  }
  window.addEventListener('load', () => setTimeout(() => {
    if (!document.querySelector(`[${ATTR_UI}="true"]`)) init();
    else scheduleScan(0);
  }, 1000));

})();
