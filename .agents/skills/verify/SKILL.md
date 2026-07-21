---
name: verify
description: Build, launch, and drive this app headlessly to verify editor changes end-to-end.
---

# Verifying browserMarkdownEditor changes

Vite + React app; the surface is the browser GUI (CodeMirror live-preview editor).

## Launch

```bash
npm run dev -- --port 5199   # background it
```

## Drive headlessly (Playwright)

The vault opens via `window.showDirectoryPicker` (File System Access API), which
can't show a native picker headless. Stub it with OPFS in `addInitScript`:

```js
await page.addInitScript(() => {
  const patch = (h) => {
    if (!h.queryPermission) h.queryPermission = async () => 'granted';
    if (!h.requestPermission) h.requestPermission = async () => 'granted';
    return h;
  };
  window.showDirectoryPicker = async () => patch(await navigator.storage.getDirectory());
  const orig = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
  FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...a) {
    return patch(await orig.apply(this, a));
  };
});
```

Then seed test notes into OPFS with `page.evaluate` (getFileHandle + createWritable)
BEFORE clicking "Open Vault". OPFS is per-browser-context — reseed every run.

## Gotchas

- Files open in **Reading mode** by default; press `Meta+e` to switch to editing
  before testing cursor-reveal / typing behavior.
- The editor is `.cm-content` inside `.cm-scroller`; scroll via
  `document.querySelector('.cm-scroller').scrollTop = ...`.
- Theme toggle button text: "Switch to Light Mode" / "Switch to Dark Mode"
  (bottom of the sidebar). Theme = `data-theme` attribute on `<html>` (absent = dark).
- Mermaid/KaTeX labels live in nested spans/foreignObject — assert on screenshots,
  not `textContent`.
