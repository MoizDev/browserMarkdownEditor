---
name: verify-in-browser
description: How to actually verify a change in this repo — there is no test suite, so verification means driving the running app headlessly with Playwright against an OPFS-stubbed vault. Load before writing any verification script, before driving the app, and before claiming a change works.
---

# Verifying a change

**There is no test suite and no test runner.** `npm run typecheck` and `npm run lint` are the
static gates; everything behavioural is verified by driving the running app. A change is not
verified because it typechecks.

## The harness, step by step

Each step below exists because skipping it produces a *working change that looks broken*.

1. **Run the dev server on a port of your own:** `npm run dev -- --port <PORT> --strictPort`.
   Not Vite's default 5173, and not 5199 — the developer may already be on either.

2. **Stub `window.showDirectoryPicker` with OPFS**, in an `addInitScript` *before* the page loads.
   The native picker cannot open headless.

3. **Patch `queryPermission` / `requestPermission` to return `'granted'`** — on the handle you
   return *and* on the result of `FileSystemDirectoryHandle.prototype.getDirectoryHandle`.
   Otherwise a restored vault asks for a user gesture that never comes.

4. **Seed fixture notes into OPFS after `page.goto` has landed on the real origin**, with
   `getFileHandle` + `createWritable`. `navigator.storage.getDirectory` is `undefined` on
   `about:blank`, which has no storage bucket. Re-seed every run — OPFS is per browser context.

5. **Press `⌘E` before testing anything about the caret, typing, or cell editing.** Files open in
   Reading mode by default, where nothing is editable.

6. **Selectors:** the editor is `.cm-content` inside `.cm-scroller`. Chromium only, by design.

7. **`await document.fonts.ready` before asserting a column width.** Google Fonts is the app's one
   outbound request and a font arriving late re-triggers the table fit.

8. **Suppressed browser menus are asserted, not screenshotted.** To check the app's own context menu
   replaced the browser's, assert `defaultPrevented` on the `contextmenu` event — the OS menu never
   appears in a screenshot either way.

## Sketch

```js
await page.addInitScript(() => {
  const grant = (h) => {
    h.queryPermission = async () => 'granted'
    h.requestPermission = async () => 'granted'
    return h
  }
  const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle
  FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...a) {
    return grant(await getDir.apply(this, a))
  }
  window.showDirectoryPicker = async () => grant(await navigator.storage.getDirectory())
})
await page.goto(`http://localhost:${PORT}/`)   // seed OPFS only AFTER this line
```

## What to check beyond the change itself

Per the repo's standing instruction: be picky about the UI. If something on screen is visibly
wrong — misaligned, flickering, mis-sized — fix it even if it is not what you were sent to do.
