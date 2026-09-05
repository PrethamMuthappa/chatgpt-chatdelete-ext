// Background script for Firefox (background.scripts)
// Also compatible with Chrome service_worker when used via manifest.chrome.json fallback.
// This file runs as a persistent/event background page in Firefox.
// Keep it minimal — all heavy logic is in the content script (content/content.js).
// No network requests, no token handling.

const ext = (typeof browser !== 'undefined' ? browser : chrome);

ext.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[CBD] Chat Bulk Delete installed');
  } else if (details.reason === 'update') {
    console.log('[CBD] Chat Bulk Delete updated to', ext.runtime.getManifest().version);
  }
});

// Optional: toolbar click fallback when popup is not shown.
// In MV3 Firefox/Chrome, `action` is the MV3 API; in MV2 Firefox it is `browserAction`.
// We support both so the file works regardless of manifest_version.
const actionApi = ext.action ?? ext.browserAction;

try {
  actionApi?.onClicked?.addListener(async (tab) => {
    // If a popup is defined (default_popup), this event won't fire.
    // Keep as fallback for future builds without popup.
    if (!tab?.id) return;
    try {
      await ext.tabs.sendMessage(tab.id, { type: 'CBD_TOGGLE_PANEL' });
    } catch {
      // No content script yet (e.g., not on chatgpt.com) — ignore
    }
  });
} catch (e) {
  console.log('[CBD] action.onClicked not available', e);
}
