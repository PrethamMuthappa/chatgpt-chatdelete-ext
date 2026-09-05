const ext = (typeof browser !== 'undefined' ? browser : chrome);
// Background service worker (Manifest V3)
// Minimal — required for Manifest V3. Could handle future cross-browser
// messaging, but all work is done in the content script.
// Keep it light to avoid persistence issues.

ext.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[CBD] Chat Bulk Delete installed');
  } else if (details.reason === 'update') {
    console.log('[CBD] Chat Bulk Delete updated to', ext.runtime.getManifest().version);
  }
});

// Optional: toolbar click fallback when popup is not shown.
// Supports both MV3 `action` and MV2 `browserAction` for cross-browser use.
const actionApi = ext.action ?? ext.browserAction;

try {
  actionApi?.onClicked?.addListener(async (tab) => {
    if (!tab?.id) return;
    try {
      await ext.tabs.sendMessage(tab.id, { type: 'CBD_TOGGLE_PANEL' });
    } catch {
      // No content script on this page — ignore
    }
  });
} catch (e) {
  console.log('[CBD] action.onClicked not available', e);
}
