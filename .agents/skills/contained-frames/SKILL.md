---
name: contained-frames
description: First-party opaque iframe mechanics and the embed containment profile. Load before changing platform/containedFrame, platform/embed*, build/embedFrame, or an embed containment consumer.
---

# Opaque frames and embeds

- `src/platform/containedFrame.ts` owns mechanics only: scripts-only sandbox, no-referrer,
  one private port, first-load handoff and navigation teardown. Callers own fixed first-party
  bootstraps and protocol validation. Never pass document/provider HTML as its `html`.
- Embed's public contract is `platform/embedContainment.types.ts`; its constructor and proof
  query are `platform/embedContainment.ts`. App owns the curated versioned exact-origin
  manifest and factory injection. Whiteboard owns provider resource grammar, canonical URL
  creation, explicit per-embed Load, current-source checks and visibility/source teardown.
- `createEmbedContainment` mounts only the local wrapper and awaits its private handshake.
  `isEmbedContainmentApproved` checks the private runtime registry, native credentialless
  support and the live configured wrapper. Matching fields, a fixed true callback or a saved
  certificate are not approval. Unsupported/failed initialization stays an inert placeholder.
- The bootstrap creates/configures a detached credentialless inner frame before acknowledging
  readiness. Only private `load` appends it with the exact bound URL. Provider window messages
  are ignored. Neither side permits same-origin, popup, form or top-navigation sandbox grants;
  both frames receive the fixed deny permission policy.
- `build/embedFrame.mjs` eagerly bundles/hashes the actual fixed bootstrap at dev/build startup,
  then supplies those same bytes/hash through `virtual:contained-embed`. No vendor reader or
  drawing engine belongs here. CSP denies everything except the exact inline script hash and
  the manifest's exact frame origins. User HTML never enters `srcdoc`.
- `load()` acknowledges frame creation, not playback or the provider's cross-origin final URL.
  A wrapper CSP frame refusal revokes the lease; do not inspect foreign frame location or
  weaken permissions to accommodate a provider. Provider subresources may use the network
  after consent; credentialless does not mean zero tracking or zero ephemeral storage.
- The optional abort signal covers the **whole consent lease**, not a setup-only timeout.
  The platform owns handshake deadlines. Unload/dispose revokes the whole lease; hide, close,
  source change, vault switch and reopen must never preserve/replay activation. Capture/export
  uses a local static placeholder, never the foreign DOM or an automatic load.
