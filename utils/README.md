# utils/

- `selectors.js` — central documentation of stable ChatGPT selectors. Import or copy into `content/content.js` when porting.

Firefox/Safari port:

- Change `chrome.storage` / `chrome.runtime` to `browser.*` (or use `chrome` with polyfill — both work in Firefox).
- Add to `manifest.json`:

```json
"browser_specific_settings": {
  "gecko": { "id": "chat-bulk-delete@example.com" }
}
```

No logic changes needed.
