# styles/

Styles are co-located with their modules:

- `content/content.css` — injected into ChatGPT pages (namespace `.cbd-*`)
- `popup/popup.css` — styles for the extension popup

Both use CSS custom properties under `:root --cbd-*` and include light-theme support via `html.light` / `html[data-theme="light"]`.
