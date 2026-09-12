---
name: verify-in-browser
description: How to actually verify a change in this repo — there is no test suite, so verification means Playwright driving the running app in headless Chromium against an OPFS-stubbed vault. Load before writing any verification script, before driving the app, and before claiming a change works.
---

# Verifying a change

**There is no test suite and no test runner.** `npm run typecheck` and `npm run lint` are the
static gates; everything behavioural is verified by Playwright driving the running app in headless
Chromium. A change is not verified because it typechecks.

**Playwright is not a repo dependency.** Nothing in `package.json` pulls it and there is no
`node_modules/playwright`; it resolves out of the npx cache
(`~/.npm/_npx/*/node_modules/playwright`), and the harness hard-filters that cache on **1.63**.
`channel: 'chrome'` (step 7) additionally needs Google Chrome installed, or the launch fails outright.

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

6. **Selectors:** the editor is `.cm-content` inside `.cm-scroller`. Chromium only, by design. The
   welcome screen carries up to **two** `.welcome-btn`s, and the second one opens a *different*
   vault: `Open Vault` (always — the picker) plus either `Open '<linked vault>'` (a hash naming a
   known vault whose grant has lapsed) or `Restore '<previous vault>'` (a stored handle whose grant
   has lapsed). Never both — the linked branch returns before the stored one is reached. Match
   `{ name: 'Open Vault', exact: true }`; a loose `{ name: 'Open' }` is ambiguous on the linked
   screen. `aria-label="Open another vault"` exists only once a vault is already open, and
   `.vault-menu-row` only inside that menu.

7. **A reload with a vault open CRASHES Playwright's BUNDLED Chromium** (both `chromium` and
   `chrome-headless-shell`, 153.0.8010.12 under Playwright 1.63): reading the OPFS handle back out of
   IndexedDB kills the renderer *and* the browser with no crash log. The trigger is narrower than
   "a reload": it is any READ of a stored handle, so the **second** vault you open dies inside
   `rememberVault`'s `isSameEntry` sweep over the list (the first is fine — `readList` returns `[]`,
   so nothing is deserialized). It tracks the **browser build**, not headedness and not the app:
   on identical app code the *installed Chrome* channel survives it, headless.

   So, two ways to test reload / restore-on-load / two vaults — say which you took:
   - **`chromium.launch({ headless: true, channel: 'chrome' })`, no shim.** Still headless, but the
     installed Google Chrome instead of the bundled build, so the real structured-clone path is the
     one under test (`indexedDB.databases()` → `keyval-store`, no `__h_idb:` keys). Measured: Chrome
     151.0.7922.138 survived **14 of 14** reloads that deserialize the stored handle, across 4
     sessions (dev server and `vite preview`), plus both second-vault opens — while the bundled 153
     died on the first such reload in both controls. Prefer this. It is not permanent, though: the
     surviving build is whichever Chrome is installed, and the crashing one is the *newer* of the
     two, so a Chrome update can inherit the bug — if this arm starts dying too, fall back to the
     shim rather than reading it as an app regression.
   - **`page.route`-intercept the `idb-keyval` module** with a localStorage shim storing
     `{__handle: name}`, re-resolved from the OPFS root — **pack/unpack recursively**, because
     `recent-vaults` is an array of objects each holding a handle, not a bare handle. Works on the
     bundled build, but the real structured-clone path then goes unexercised. (Deleting the
     `keyval-store` database before the reload and re-opening through the picker dodges the read
     instead — and dodges what you were testing, if that was the restore.)

   **A `goto` that differs only in the `#hash` does not reload** — it navigates in-page, the restore
   effect never re-runs, and a link-opens-a-note probe silently proves nothing. Force it
   (`page.reload()`), and assert you did: set a `window` marker before, check it is gone after.

8. **`await document.fonts.ready` before asserting a column width.** Two fonts re-trigger the table
   fit when they land, and only one of them is a request you could watch for. The app reaches **two**
   Google hosts: `index.html` links a `fonts.googleapis.com` stylesheet (Fira Code) and preconnects
   `fonts.gstatic.com`, and a chosen text font adds a second stylesheet at runtime (`App.tsx`'s
   `google-font-link`) — but the request that moves layout is the **gstatic woff2**, fetched only for
   a face something actually renders, so a default load makes no font request at all. **KaTeX's faces
   are bundled locally** and a table holding maths re-fits when they arrive too (`tableFit`'s
   `mathProbe`). Offline is not an exemption.

9. **Suppressed browser menus are asserted, not screenshotted.** To check the app's own context menu
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
