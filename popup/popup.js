const ext = (typeof browser !== 'undefined' ? browser : chrome);
// Popup script — talks to content script via ext.tabs messaging.
// No external requests.

const els = {
  dot: document.getElementById('status-dot'),
  text: document.getElementById('status-text'),
  detail: document.getElementById('status-detail'),
  detected: document.getElementById('stat-detected'),
  selected: document.getElementById('stat-selected'),
  status: document.getElementById('stat-status'),
  btnToggle: document.getElementById('btn-toggle-panel'),
  btnSelectAll: document.getElementById('btn-select-all'),
  btnClear: document.getElementById('btn-clear'),
  btnRescan: document.getElementById('btn-rescan'),
};

function setStatus(kind, text, detail) {
  els.dot.className = 'status-dot ' + (kind || '');
  els.text.textContent = text;
  els.detail.textContent = detail || '';
}

async function getActiveTab() {
  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendToContent(type, payload = {}) {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error('No active tab');
  const url = tab.url || '';
  if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) {
    throw new Error('Not on ChatGPT');
  }
  return new Promise((resolve, reject) => {
    ext.tabs.sendMessage(tab.id, { type, ...payload }, (resp) => {
      if (ext.runtime.lastError) {
        reject(new Error(ext.runtime.lastError.message));
      } else {
        resolve(resp);
      }
    });
  });
}

async function refresh() {
  try {
    const tab = await getActiveTab();
    const url = tab?.url || '';
    if (!url.includes('chatgpt.com') && !url.includes('chat.openai.com')) {
      setStatus('warn', 'Open chatgpt.com', 'Navigate to https://chatgpt.com and log in. The bulk-delete panel will appear automatically.');
      els.detected.textContent = '—';
      els.selected.textContent = '—';
      els.status.textContent = 'idle';
      return;
    }
    setStatus('', 'Contacting page…', 'If this hangs, refresh ChatGPT and reopen the popup.');
    const state = await sendToContent('CBD_GET_STATE');
    if (!state) throw new Error('No response — refresh ChatGPT');
    els.detected.textContent = String(state.detectedCount ?? 0);
    els.selected.textContent = String(state.selectedCount ?? 0);
    els.status.textContent = state.isDeleting ? 'deleting…' : 'ready';
    if (state.detectedCount === 0) {
      setStatus('warn', 'No conversations found', 'ChatGPT may still be loading. Scroll the sidebar or click Rescan.');
    } else if (state.selectedCount > 0) {
      setStatus('ok', `${state.selectedCount} selected`, `${state.selectedCount} of ${state.detectedCount} loaded conversations selected. Use the page's floating panel to delete.`);
    } else {
      setStatus('ok', 'Ready', `${state.detectedCount} conversations loaded. Checkboxes are in the sidebar.`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Receiving end does not exist') || msg.includes('No response')) {
      setStatus('warn', 'Content script not ready', 'Refresh ChatGPT (F5), wait 2 seconds, then reopen this popup.');
      els.detected.textContent = '—';
      els.selected.textContent = '—';
      els.status.textContent = '—';
    } else if (msg.includes('Not on ChatGPT')) {
      setStatus('warn', 'Not on ChatGPT', 'Go to https://chatgpt.com');
      els.detected.textContent = '—';
      els.selected.textContent = '—';
      els.status.textContent = '—';
    } else {
      setStatus('err', 'Error', msg);
    }
  }
}

els.btnToggle.addEventListener('click', async () => {
  try {
    await sendToContent('CBD_TOGGLE_PANEL');
    setTimeout(refresh, 300);
  } catch (e) {
    setStatus('err', 'Toggle failed', e.message);
  }
});

els.btnSelectAll.addEventListener('click', async () => {
  try { await sendToContent('CBD_SELECT_ALL'); setTimeout(refresh, 300); } catch (e) { setStatus('err', 'Failed', e.message); }
});
els.btnClear.addEventListener('click', async () => {
  try { await sendToContent('CBD_CLEAR'); setTimeout(refresh, 300); } catch (e) { setStatus('err', 'Failed', e.message); }
});
els.btnRescan.addEventListener('click', async () => {
  try {
    els.btnRescan.disabled = true;
    els.btnRescan.textContent = 'Scanning…';
    await sendToContent('CBD_RESCAN');
    setTimeout(() => { els.btnRescan.disabled = false; els.btnRescan.textContent = 'Rescan'; refresh(); }, 800);
  } catch (e) {
    els.btnRescan.disabled = false;
    els.btnRescan.textContent = 'Rescan';
    setStatus('err', 'Rescan failed', e.message);
  }
});

document.getElementById('link-help')?.addEventListener('click', (e) => {
  e.preventDefault();
  ext.tabs.create({ url: 'https://help.openai.com/en/articles/8809935' });
});

refresh();
// Auto refresh every 2s while popup open
const iv = setInterval(refresh, 2000);
window.addEventListener('unload', () => clearInterval(iv));
