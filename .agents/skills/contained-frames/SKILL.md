---
name: contained-frames
description: The app's opaque sandboxed iframes — the shared createContainedFrame mechanics, the fixed first-party bootstraps built and CSP-hashed at build time (EPUB reader, PDF engine broker, whiteboard SVG/video/clipboard-HTML parsers, provider embeds), and the embed consent/containment profile. Load before changing src/platform/containedFrame*, src/platform/embed*, build/embedFrame.mjs, build/whiteboardSvgFrames.mjs, build/pdfContainedAssets.ts, src/epub/build-frame.mjs, any *FrameHost / bridge that calls createContainedFrame, or before parsing untrusted bytes or framing a provider anywhere new.
---

# Opaque frames and embeds

This origin holds the vault's directory handle and, through the terminal, a shell. Anything that
parses untrusted bytes as a browser document (SVG, HTML, video, an EPUB's XHTML) or shows a foreign
site does it inside an **opaque frame**: `sandbox="allow-scripts"` with no `allow-same-origin`, so the
frame's origin is `null` and it cannot reach the app's DOM, storage or handles. The only line back is
one private `MessagePort`.

## The mechanics: `src/platform/containedFrame.ts`

`createContainedFrame({ html, init, onMessage, onFailure, signal?, hidden?, credentialless?,
permissionPolicy?, className?, ariaLabel? })` returns `{ frame, port, mount(container), dispose() }`.

- Fixed attributes: `sandbox="allow-scripts"`, `referrerPolicy="no-referrer"`, an `allow` policy that
  denies camera/mic/geolocation/clipboard/fullscreen/sensors (a profile may pass a stricter one, never
  document data).
- `mount()` sets `srcdoc = html` and appends. On the **first** `load` it posts `init` with
  `port2` transferred (target `'*'`, which is correct: the frame's origin is opaque). A **second**
  `load` means the frame navigated → `onFailure('navigation')` and dispose. A failed handoff →
  `'handoff'`; a `messageerror` on the port → `'messageerror'`. Every failure disposes.
- `dispose()` is idempotent: closes both ports, removes listeners and the element. Aborting `signal`
  disposes (the signal is attached in `mount`, so an already-aborted signal throws there).
- **The `html` is always a generated first-party bootstrap. Never document, provider or user HTML.**
  The lint rule `bme/html-sinks` (`eslint.rules.ts`, allow-list in `eslint.config.ts`) admits
  `srcdoc` **only** in `containedFrame.ts` and only from the identifier `frameHTML`, which is why the
  code copies `options.html` into a `const frameHTML` first. JSX `srcDoc` is banned everywhere.
- The caller owns everything above mechanics: its CSP, its bootstrap identity, its readiness
  deadline, and **validating every message** (version, random token, identity, expected type, rate).

## The profiles (every caller of `createContainedFrame`)

| Caller | Bootstrap built by | CSP highlights |
|---|---|---|
| EPUB reader `src/epub/bridge.ts` | `src/epub/build-frame.mjs` → committed `src/epub/reader-frame.html` + `.integrity.json` (Vite plugin `contained-epub-frame` reruns it at every dev/build start and on HMR) | `img-src blob:` `font-src blob:` `style-src 'unsafe-inline'`; see `epub-reader` |
| PDF engine broker `src/pdf/contained/bridge.ts` | `build/pdfContainedAssets.ts` → `virtual:pdf-engine-broker` (in memory) | `'wasm-unsafe-eval' blob:` + `worker-src blob:`; frame only spawns workers, never sees PDF bytes; see `pdf-and-drawings` |
| SVG header/raster `src/whiteboard/media/svgFrameHost.ts` | `build/whiteboardSvgFrames.mjs` → `virtual:whiteboard-svg-frames` | `img-src blob:` for the image profile, `'none'` for XML |
| Video poster/duration `src/whiteboard/media/videoFrameHost.ts` | same module (`videoFrame`) | `media-src blob:` only |
| Clipboard HTML `src/whiteboard/clipboard/htmlFrameHost.ts` | same module (`clipboardHtmlFrame`) | everything `'none'` |
| Provider embeds `src/platform/embedContainment.ts` | `build/embedFrame.mjs` → `virtual:contained-embed` | `frame-src` = exactly the manifest origins |

Shared build primitive: `src/platform/containedFrameBuild.mjs` (`bundleContainedRuntime` = esbuild IIFE,
minified, `chrome120`; `hashInlineScript` refuses a runtime containing `</script`). Every CSP is
`default-src 'none'` + `script-src 'sha256-<hash of the exact inline IIFE>'` + `script-src-attr 'none'`,
then only what that profile needs. The hash is of the minified bytes that land in the page, so a
bootstrap is always regenerated from source, never hand-edited.

**The worker-style transport** (SVG, video, clipboard HTML share it): a 32-hex random `token` plus the
board's `BoardJobIdentity`; the frame answers `ready`; bytes go in 192 KiB `chunk`s, each `ack`ed with
its sequence number; `finish` asks for one `result`. The host refuses a reply with the wrong token,
identity, type or sequence, more than 120 messages a second, or anything after `error`; it closes any
transferable it refuses (`closeWorkerResult`). Hidden frames are positioned off-layout
(`position:fixed;width:0;height:0;visibility:hidden`), mounted on `document.body`, and disposed in
`finally` — one frame per request (SVG frames refuse a second `request`). Byte caps: SVG 5 MiB,
video 10 MiB, clipboard HTML `SECURITY_LIMITS.clipboardHtmlBytes`. Each also has a deadline (video
10 s, clipboard 5 s, SVG uses the caller's signal); the video frame holds a `cpuGovernor` permit and
the clipboard frame a memory-governor lease for its whole life.

**Adding a profile:** a new entry module, a CSP that starts from `'none'` everywhere, bundling via
`bundleContainedRuntime` in a Vite plugin (in-memory virtual module preferred; the EPUB frame is
committed only because it carries an integrity inventory), the same token + identity + typed-reply
validation, and one frame per job disposed in `finally`. Never add `allow-same-origin`,
`allow-popups`, `allow-forms` or `allow-top-navigation`.

`printBoard.ts` is not a contained frame: it loads the app's **own** generated PDF blob into Chrome's
PDF viewer to print. Nothing from the document becomes HTML there.

## Provider embeds (the whiteboard's YouTube/Figma/… cards)

Two nested frames. The **wrapper** is a contained frame whose bootstrap is `embedBootstrap.ts`; it
creates the **inner** `credentialless` iframe, also `sandbox="allow-scripts"`, no-referrer, with the
long deny-all `EMBED_PERMISSIONS` policy, and only appends it (with the bound URL) on a private `load`.
Provider `window` messages are ignored: nothing the provider sends reaches the app.

Who owns what:
- **Platform** (`src/platform/embed*`, imports nothing app-specific): `embedPolicy.ts` holds
  `EMBED_PROFILE`, the curated `EMBED_PROVIDER_ORIGINS` list, `EMBED_PERMISSIONS`, and the validators
  (exact public HTTPS origins only, no ports/IPs/local TLDs/own origin; an embed URL must equal
  `origin + pathname` — no query, no hash). `embedContainment.types.ts` is the public contract;
  `embedContainment.ts` is the constructor and `isEmbedContainmentApproved`.
- **App** (`src/utils/nativeEmbedHost.ts`): builds the manifest from `EMBED_PROVIDER_ORIGINS`, lazy-
  imports the platform constructor on first use, refuses a manifest that differs from its own.
- **Whiteboard** (`src/whiteboard/media/embed.ts`, `host/nativeEmbeds.ts`): maps a pasted link to a
  canonical provider URL (`resolveEmbedCandidate`, the provider grammar), runs `checkContentUrl`, and
  calls `activateEmbed` **only for an explicit per-node Load**. Consent is session-only: it is never
  written to the model, so undo, copy, restore, reopen and a vault switch cannot replay it. Hide,
  close, source change and view replacement end it. Placement, clipping and the paint/omission
  handshake live in `platform/render/embedPresentation.ts` (`rendering-platform`).

Rules that are easy to break:
- **Approval is the private registry, nothing else.** `createEmbedContainment` mounts the wrapper,
  waits for its `ready` (which reports `credentialless: true`), and only then registers the returned
  frozen object in a module `WeakMap`. `isEmbedContainmentApproved` re-checks that entry *and* the live
  frame (connected, same `contentWindow`, exact sandbox/allow/referrer/srcdoc, `credentialless`, no
  `src`). An object with matching fields, a `() => true`, or a saved flag is not approval. A
  `MutationObserver` on the frame's security attributes fails the lease the moment one changes.
- **No native `credentialless` support → inert placeholder**, never a weaker frame.
- `load()` acknowledges that the inner frame was created, not that the provider played or where it
  ended up. A wrapper CSP `frame-src` violation (provider redirected off-manifest) fails the lease as
  `'blocked'`. Never inspect a foreign frame's location, and never widen permissions for a provider.
- **The `signal` passed in is the whole consent lease**, not a setup timeout; the platform owns the
  5 s handshake deadline. `unload()` and `dispose()` both revoke the lease; another Load needs a new
  constructor call.
- Capture, export and print draw a local static placeholder — never the foreign DOM and never an
  automatic load. Credentialless means no cookies, not no tracking: provider subresources use the
  network once the person clicked Load.
- Adding a provider = an origin in `EMBED_PROVIDER_ORIGINS` (it flows into the wrapper CSP and the
  app manifest) plus its URL grammar in the whiteboard's provider table. Both, or it is not offered.

## Build plumbing traps

- `build/embedFrame.mjs` bundles eagerly at `buildStart`, watches every bundled input, and on HMR
  invalidates the virtual module and forces a full reload. `build/whiteboardSvgFrames.mjs` only adds
  watch files (no HMR handler): after editing an SVG/video/clipboard entry, reload the page.
- `build/pdfContainedAssets.ts` clears its cached bundles at `buildStart` and on any HMR touch of
  `src/pdf/`, `src/platform/workers/`, `containedFrameBuild.mjs` and a few utils.
- A failed EPUB frame generation deletes both generated files first, so a stale bootstrap can never
  ship with a new hash.
