/**
 * utils/selectors.js — stable selector documentation
 *
 * Keep this in sync with content/content.js SELECTORS.
 * Purpose: central place to document ChatGPT DOM signals and
 * fallback strategies, so porting to Firefox/Safari or fixing after a DOM change
 * only needs editing here.
 *
 * Last verified: Sep 2025 - Jun 2026 via:
 *  - cdn.jsdelivr.net/@zenalexa/unicli (a[href*="/c/"])
 *  - qqrm userscript (history-item-*-options, delete-chat-menu-item, modal-delete-conversation-confirmation)
 *  - BulkChatDeleter & qcrao/bulk-delete-chatGPT
 *
 * All selectors avoid brittle Tailwind class names; prefer data-testid, role, href.
 */

export const SELECTORS = {
  // Conversation anchors — href is most stable
  conversationLink: 'a[href*="/c/"]',
  conversationIdPattern: /\/c\/([^/?#]+)/,

  // Options button (⋯) — appears on hover
  optionsButtonExact: 'button[data-testid^="history-item-"][data-testid$="-options"]',
  optionsButtonAriaFallback: 'button[aria-label*="options" i], button[aria-label*="More" i]',

  // Menu after clicking options (Radix UI portal — outside nav)
  menuContent: '[data-radix-menu-content][role="menu"], div[role="menu"], [role="menu"]',
  menuItem: '[role="menuitem"]',
  deleteMenuItemExact: 'div[role="menuitem"][data-testid="delete-chat-menu-item"]',
  deleteMenuItemFallback: '[data-testid="delete-chat-menu-item"]', // any tag

  // Confirmation dialog
  confirmModalExact: 'div[data-testid="modal-delete-conversation-confirmation"]',
  confirmModalFallback: 'div[role="dialog"]',
  confirmButtonExact: 'button[data-testid="delete-conversation-confirm-button"]',

  // Sidebar containers (tried in order)
  sidebarCandidates: [
    'nav[aria-label*="Chat history" i]',
    'nav[aria-label*="history" i]',
    'nav',
    'aside',
    '#history',
    '[data-testid="history"]',
  ],
};

// Firefox / Safari port note:
// - Replace `chrome.*` with `browser.*` (WebExtensions polyfill) — logic is identical.
// - Manifest: add `browser_specific_settings.gecko.id` for Firefox.
// - No other changes needed; DOM is the same.
