# Probe fields → controls → permitted read-outs

Every read below first passes the fetched-package-marker, exact-path/provider and object-schema
guards. This table describes **eligibility**, not a green result. The actual same-run journal is
required. `PAIR` means A/B/A app-written fixtures with known differing **leaf-value sets**, compared
with independently read saved bytes; a leaf with no contrast is **UNCONTROLLED**. `ACTION` means the
named actual input/control must complete in this run and host kind. After an edit, PAIR alone does
not qualify a field. `UNCONTROLLED` fields and descendants must not count in any parity row.

Read-out keys: **A** actual agent bridge reply; **X** real controls/accessibility; **F** saved bytes;
**P** actual paint/download; **S** browser storage; **N** network. A controlled field can still be
**UNMAPPED**: it is then not compared, even though it may help diagnose a legacy defect. Opaque ids
are fixture aliases, not identical strings across engines. A summaries are rounded/page-relative;
F is checkpoint data, not a draft. No raw legacy enum/object is made a native schema by this table.

| Field | Checked read path | Same-run control / status | New-engine read-out and loss |
| --- | --- | --- | --- |
| nodes.length | store.allRecords user-shape projection | ACTION draw → bounded Undo sequence → Redo; actual ink/DOM count | A/F count for the declared sheet/checkpoint; not all-sheet count inferred from a current-sheet reply |
| nodes[].id | shape.id | PAIR, if actual id sets differ | A/F alias membership; never literal cross-engine ids |
| nodes[].kind | shape.type → neutral kind | PAIR, only differing kind sets | A/F semantic kind; no equality of vendor subtype vocabulary |
| nodes[].subkind | draw/highlight type | PAIR, only differing subkind sets | F semantic pen/highlighter; validate paint separately |
| nodes[].figure | props.geo | PAIR if contrasting | A/F figure name mapping; not a renderer algorithm |
| nodes[].title | props.name | PAIR if contrasting | A/F untruncated title |
| nodes[].parent | parentId | PAIR if contrasting | F alias hierarchy at checkpoint; exact unsaved parent UNMAPPED |
| nodes[].order | index | PAIR if contrasting | F/A relative rank within parent, never opaque key equality |
| nodes[].position.x | page transform.e | UNCONTROLLED | F composed local transforms; A AABB is not this origin |
| nodes[].position.y | page transform.f | UNCONTROLLED | Same; no exact draft-origin equality |
| nodes[].localPosition.x | shape.x | PAIR if contrasting | F local x after save; not rounded AABB x |
| nodes[].localPosition.y | shape.y | PAIR if contrasting | F local y after save; not rounded AABB y |
| nodes[].size.width | props.w / geometry.w | UNCONTROLLED | F declared dimensions only; derived renderer bounds are not stored dimensions |
| nodes[].size.height | props.h / geometry.h | UNCONTROLLED | Same; font-derived height needs its own oracle |
| nodes[].bounds.x | getShapePageBounds.x | UNCONTROLLED | A coarse AABB or P; no 1e-6 raw geometry claim |
| nodes[].bounds.y | getShapePageBounds.y | UNCONTROLLED | Same |
| nodes[].bounds.width | getShapePageBounds.w | UNCONTROLLED | Same; distinguish outline and centreline |
| nodes[].bounds.height | getShapePageBounds.h | UNCONTROLLED | Same |
| nodes[].rotation | shape.rotation | PAIR if contrasting | F local radians / A rounded degrees + P; conversions explicit |
| nodes[].page | backdrop containing vertical centre | UNCONTROLLED | A/F/P physical page, accounting for intended anchoring differences |
| nodes[].pageLocalPosition.x | position.x − backdrop.x | UNCONTROLLED | A coarse page AABB / F local anchor, not identical origins |
| nodes[].pageLocalPosition.y | position.y − backdrop.y | UNCONTROLLED | Same |
| nodes[].sheet | getAncestorPageId | UNCONTROLLED | A/F sheet alias; not physical page |
| nodes[].swatch | props.color | PAIR if contrasting | A/F chosen name plus P actual pigment |
| nodes[].resolvedSwatch.* | checked current theme role object | UNCONTROLLED | **UNMAPPED raw dictionary**; P pigment is a different assertion |
| nodes[].width | props.scale | PAIR if contrasting | **UNMAPPED raw legacy scale**; X/F/P actual width with declared conversion |
| nodes[].fill | props.fill | PAIR if contrasting | A/F semantic fill + P |
| nodes[].dash | props.dash | PAIR if contrasting | A/F semantic dash + P |
| nodes[].opacity | shape.opacity | PAIR if contrasting | F + X/P blend; A omits exact opacity |
| nodes[].font | props.font | PAIR if contrasting | F/X chosen font + P; not proof of actual fallback face |
| nodes[].textSize | props.size | PAIR if contrasting | F/X semantic size; not CSS px by declaration |
| nodes[].alignment | props.textAlign / align | PAIR if contrasting | F/X/P semantic alignment |
| nodes[].verticalAlignment | props.verticalAlign | PAIR if contrasting | F/X/P |
| nodes[].plainText | rich document text / props.text | PAIR if contrasting | F or untruncated A/X complete text |
| nodes[].richMarks | checked rich nodes' marks/path | PAIR if contrasting | F semantic spans/lists; **raw legacy paths are UNMAPPED** |
| nodes[].richText | checked rich document | PAIR if contrasting | F semantic structure; **raw editor-tree equality UNMAPPED** |
| nodes[].locked | shape.isLocked | PAIR if contrasting | F lock + actual forbidden-action/X control; not inherited lock inferred |
| nodes[].styles.* | optional record style members | UNCONTROLLED aggregate | Only individually mapped semantic fields above, not raw style-object equality |
| nodes[].connector.start | props.start | UNCONTROLLED | F/P endpoint semantics, not private route algorithm |
| nodes[].connector.end | props.end | UNCONTROLLED | Same |
| nodes[].connector.startAttachment.* | checked binding props | UNCONTROLLED | A target alias + F anchor semantics + moved-target P; vendor-only flags unmapped |
| nodes[].connector.endAttachment.* | checked binding props | UNCONTROLLED | Same |
| nodes[].connector.startHead | props.arrowheadStart | UNCONTROLLED | F/P |
| nodes[].connector.endHead | props.arrowheadEnd | UNCONTROLLED | F/P |
| nodes[].connector.bend | props.bend | UNCONTROLLED | F/P, not exact legacy routing internals |
| nodes[].connector.kind | props.kind | UNCONTROLLED | F/P semantic connector type |
| nodes[].connector.labelPosition | props.labelPosition | UNCONTROLLED | F/P |
| nodes[].connector.elbowMidPoint | props.elbowMidPoint | UNCONTROLLED | **UNMAPPED vendor flag** absent a declared native mapping |
| nodes[].polyline.points | props.points / public legacy decoder | UNCONTROLLED | F ordered vertices + P; no exact draft table |
| nodes[].polyline.spline | props.spline | UNCONTROLLED | F/P semantic spline |
| nodes[].ink.segments | props.segments / public legacy decoder | UNCONTROLLED | F persisted samples only; format helper is not independent codec proof |
| nodes[].ink.points | decoded ordered samples | UNCONTROLLED | F + trusted input/P; omitted pressure's derived .5 is not stored pressure |
| nodes[].ink.isPen | props.isPen | UNCONTROLLED | **UNMAPPED draft/vendor flag**; input receipts are not admission |
| nodes[].ink.isClosed | props.isClosed | UNCONTROLLED | F closed semantics + P; no draft guarantee |
| nodes[].ink.isComplete | props.isComplete | UNCONTROLLED | **UNMAPPED live flag**; observe commit/save/Undo instead |
| nodes[].ink.scale | props.scale | UNCONTROLLED | Native width conversion + P, not identical scale |
| nodes[].ink.scaleX | props.scaleX | UNCONTROLLED | Native geometry/F/P; not identical resize representation |
| nodes[].ink.scaleY | props.scaleY | UNCONTROLLED | Same |
| nodes[].media.* | checked referenced asset record | UNCONTROLLED | F actual bytes/hash/MIME/dimensions + N/P; not legacy tokens/data URLs |
| nodes[].crop | props.crop | PAIR if contrasting | F/P normalized against original dimensions |
| nodes[].flipX | props.flipX | PAIR if contrasting | F/P |
| nodes[].flipY | props.flipY | PAIR if contrasting | F/P |
| nodes[].altText | props.altText | PAIR if contrasting | F/X |
| nodes[].inverted | meta.inverted | PAIR if contrasting | F/P, not app theme |
| nodes[].url | props.url | PAIR if contrasting | F/X destination; navigation is a separate behaviour |
| nodes[].autoWidth | props.autoSize | PAIR if contrasting | F/X width semantics + P |
| nodes[].playback.* | persisted playing/time/autoplay | UNCONTROLLED | F only specified persisted fields + X/P playback |
| nodes[].htmlVideo.* | actual HTMLVideoElement | UNCONTROLLED | **UNMAPPED raw DOM clock/readiness object**; X/P supported playback only |
| nodes[].paintedText.* | actual text-parent DOM/CSS | UNCONTROLLED | **UNMAPPED raw CSS/font/line metadata**; F/X semantics + N/P actual glyphs |
| nodes[].metadata | checked shape meta JSON payload | PAIR only if a known contrasting payload exists | F only declared preserved user data; structural/runtime meta not a native field |
| nodes[].metadata.* | individual opaque meta children | UNCONTROLLED unless separately mapped/controlled | A changed payload does not qualify every unchanged child |
| session.selection | getSelectedShapeIds | ACTION empty click → painted stroke → Escape; actual id/paint | A/X authored selection aliases; legacy backdrop ids are not invented native nodes |
| session.currentTool | getCurrentToolId | ACTION Select → Draw → Select, probe + actual aria-pressed each step | X real pressed tool + next gesture; nested private tool-state ids not compared |
| session.canUndo | getCanUndo | ACTION draw / bounded actual Undo / Redo + button enabled state and node effects | X + A/F/P consequence, not only an icon |
| session.canRedo | getCanRedo | Same ACTION in the opposite direction | Same |
| session.camera.x | −getCamera.x | ACTION real pan, before/after | A drawing camera with translation conversion; exact paged absolute value **UNMAPPED** |
| session.camera.y | −getCamera.y | ACTION real pan, before/after | Same |
| session.camera.zoom | getCamera.z | ACTION ctrl-wheel + painted stroke grows | A drawing zoom; paged relative fit zoom needs an explicit semantic conversion |
| session.viewport.css.x | checked screen box.x | UNCONTROLLED | X/P actual visible region rectangle; use DOM directly until controlled |
| session.viewport.css.y | checked screen box.y | UNCONTROLLED | Same; fixed 72px is not a changing-field control |
| session.viewport.css.width | checked screen box.w | ACTION real viewport resize + actual DOM rectangle | X/P; hidden 1px mirror is not the viewport |
| session.viewport.css.height | checked screen box.h | Same ACTION | Same |
| session.viewport.world.x | checked page box.x | ACTION real pan | A drawing viewport at declared precision; exact paged value **UNMAPPED** |
| session.viewport.world.y | checked page box.y | Same ACTION | Same |
| session.viewport.world.width | checked page box.w | ACTION zoom changes extent | Same |
| session.viewport.world.height | checked page box.h | Same ACTION | Same |
| session.toolLocked | instance.isToolLocked | UNCONTROLLED | X checked lock / repeated creation; hidden raw flag otherwise unmapped |
| session.penOnly | instance.isPenMode | UNCONTROLLED | X Exit pen mode + actual follow-on touch admission; not raw mode equality |
| session.input.pointing | inputs.isPointing | UNCONTROLLED | **UNMAPPED admitted-state boolean**; receipts/outcomes are different assertions |
| session.input.panning | inputs.isPanning | UNCONTROLLED | Same |
| session.input.pinching | inputs.isPinching | UNCONTROLLED | Same |
| session.input.hovering | old missing inputs.isHovering | **UNAVAILABLE**, not returned as false | Original planning JSON silently omitted it; no parity equality |
| session.input.modifiers.shift | inputs.getShiftKey | UNCONTROLLED | **UNMAPPED grace/admitted-state flag**; real key receipts are not this value |
| session.input.modifiers.alt | inputs.getAltKey | UNCONTROLLED | Same |
| session.input.modifiers.ctrl | inputs.getCtrlKey | UNCONTROLLED | Same; input calibration is not parity sign-off |
| session.input.modifiers.meta | inputs.getMetaKey | UNCONTROLLED | Same |
| session.preferences.* | checked user preferences JSON | UNCONTROLLED | X/S each documented choice only; raw object/id/defaults **UNMAPPED** |
| session.viewPreferences.grid | instance.isGridMode | UNCONTROLLED | X/S + P grid |
| session.viewPreferences.focus | instance.isFocusMode | UNCONTROLLED | X/S + P |
| session.viewPreferences.debug | instance.isDebugMode | UNCONTROLLED | X/S/P if part of target UI |
| session.viewPreferences.edgeScrolling | old inferred speed >0 | **UNAVAILABLE**, no invented default | X/S actual documented semantic choice only |
| session.viewPreferences.edgeScrollSpeed | old undefined preference ??1 | **UNAVAILABLE**, no invented 1 | Raw resolved default speed otherwise **UNMAPPED** |
| session.viewPreferences.pasteAtCursor | old undefined preference ??false | **UNAVAILABLE**, no invented false | X/S actual documented semantic choice only |
| session.colourMode | getColorMode | UNCONTROLLED | X app/allowed colour choice + P; target paper is fixed light |
| session.palette.* | checked resolved theme JSON | UNCONTROLLED | **UNMAPPED raw dictionary**; actual pigments/goldens are different assertions |
| session.nextStyles.* | checked instance.stylesForNextShape | UNCONTROLLED | X no-selection choice + actual next A/F/P node; not a hidden raw map |
| session.currentSheet | getCurrentPageId, checked membership | UNCONTROLLED | X/A current name/index + F aliases |
| session.sheets[].id | checked getPages record.id | UNCONTROLLED | X/A/F aliases, not literal ids |
| session.sheets[].name | checked page.name | UNCONTROLLED | X/A/F complete names |
| session.sheets[].order | checked page.index | UNCONTROLLED | F/X relative rank, never opaque key equality |
| session.editing | getEditingShapeId | UNCONTROLLED | X focused named editor + A/F node alias; hidden state ids unmapped |
| session.exportBackground | instance.exportBackground | UNCONTROLLED | X checkbox + actual P exported alpha |
| session.pages[].index | backdrop physical-page metadata | UNCONTROLLED | F original PDF/paper + A/X/P; physical page differs from sheet |
| session.pages[].id | checked backdrop record.id | UNCONTROLLED alias only | **UNMAPPED structural record**; use only to classify legacy selection evidence |
| session.pages[].x | checked backdrop.x | UNCONTROLLED | F page model + P landmarks, not a native backdrop record |
| session.pages[].y | checked backdrop.y | UNCONTROLLED | Same |
| session.pages[].width | checked backdrop.props.w | UNCONTROLLED | F PDF MediaBox/Rotate/paper + P |
| session.pages[].height | checked backdrop.props.h | UNCONTROLLED | Same |
| session.pages[].locked | checked backdrop.isLocked | ACTION real Unlock all (legacy defect reference) | **UNMAPPED raw structural lock**; target proves inability to damage paper |
| session.pages[].asset.* | checked referenced asset | UNCONTROLLED | **UNMAPPED structural tokens/meta**; F/P source and paint |
| session.pages[].raster.* | actual backdrop img dimensions/state | UNCONTROLLED | **UNMAPPED ordinary-arm bitmap object**; P clarity or separate authorized bench gate |
| session.backdrops[].index | alias of pages[].index | UNCONTROLLED | Same physical-page limit; not a separate source |
| session.backdrops[].id | alias of pages[].id | UNCONTROLLED alias only | Structural token, never literal native id equality |
| session.backdrops[].x | alias of pages[].x | UNCONTROLLED | F/P landmarks, not a native backdrop record |
| session.backdrops[].y | alias of pages[].y | UNCONTROLLED | Same |
| session.backdrops[].width | alias of pages[].width | UNCONTROLLED | F/P physical geometry |
| session.backdrops[].height | alias of pages[].height | UNCONTROLLED | Same |
| session.backdrops[].locked | alias of pages[].locked | ACTION same real Unlock all | Same raw structural-lock gap; do not double-count the alias |
| session.backdrops[].asset.* | alias of pages[].asset | UNCONTROLLED | Structural metadata/tokens unmapped |
| session.backdrops[].raster.* | alias of pages[].raster | UNCONTROLLED | Ordinary-arm bitmap object unmapped |
| paper.paper.* | independently saved notebook paper/default blank | UNCONTROLLED | F/X paper semantics + P; blank defaults are not a changing-field control |
| paper.pages[] | alias of session.pages[] | Corresponding statuses above | Same structural-record limits |
| synchronized | live document vs independent saved user records | UNCONTROLLED as parity quantity | **UNMAPPED full private-store equality**; use declared F/A checkpoint subset |
| pending | no observer exists | **UNAVAILABLE**, throws | A completed post-action write / clean UI / F witness, not a fake pending getter |
| export | private getSvgString/toImage combinations | **UNAVAILABLE**, throws | Actual UI download/clipboard/capture; no private API equivalence claim |
| worldToCSS | arithmetic from camera/viewport above | No additional control claim | Inherits both source controls/precision; exact paged-camera gap remains |
| cssToWorld | inverse arithmetic from same read-outs | No additional control claim | Same |
| binding | observer-owned epoch/WeakMap token | ACTION controls require it unchanged for one document | Bookkeeping only, not a model id or new-engine read-out |

Opaque JSON rows (`.*`) cover the whole payload **and every descendant**; no unlisted child is
implicitly controlled. A concrete future child needs its own mapped row/control before it counts.
Private handles (if explicitly requested) have object guards but are **UNCONTROLLED/UNMAPPED** until
an actual grip drag proves its target and outcome; a count/appearance is not hit-geometry proof.

Each probe-only comparison must retain this loss: **the arms use different observation surfaces;
a wrong mapping could pass while behaviour differs. Unmapped fields are not compared.** This
package's functional controls are not claims of physical-device fidelity or precise picture parity.
