import type { Modifiers } from './tool'
import type { KeyboardCursor } from './keyboardCursorTypes'
import type { KeyboardNavigationPriority } from './scrollKeysTypes'

export interface KeyBinding {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly key: string
  readonly shift?: boolean
  readonly alt?: boolean
  readonly accel?: boolean
  readonly repeat?: boolean
  /** Dispatched like any binding but never listed: the listed sibling (Cmd+=) is the chord a person reads. */
  readonly alias?: boolean
  /** Listed in the shortcuts dialog but never dispatched: a momentary mode, or a family the dispatcher reads from the key itself. */
  readonly dialogOnly?: boolean
  /** The key cap the dialog shows in place of the dispatch key, such as the four arrows as one cap. */
  readonly chordKey?: string
  /** Still works while the keyboard-shortcuts preference is off: Delete, and the accessibility keys the preference never silences. */
  readonly required?: boolean
}

// This one table supplies both dispatch and the shortcut dialog.
export const boardBindings: readonly KeyBinding[] = [
  { id: 'tool.select', group: 'tools', label: 'Select', key: 'v' },
  { id: 'tool.hand', group: 'tools', label: 'Hand', key: 'h' },
  { id: 'tool.pen', group: 'tools', label: 'Draw', key: 'd' },
  { id: 'tool.pen', group: 'tools', label: 'Draw', key: 'b', alias: true },
  { id: 'tool.pen', group: 'tools', label: 'Draw', key: 'x', alias: true },
  { id: 'tool.eraser', group: 'tools', label: 'Eraser', key: 'e' },
  { id: 'tool.connector', group: 'tools', label: 'Arrow', key: 'a' },
  { id: 'tool.text', group: 'tools', label: 'Text', key: 't' },
  { id: 'tool.sticky', group: 'tools', label: 'Note', key: 'n' },
  { id: 'figure.rectangle', group: 'tools', label: 'Rectangle', key: 'r' },
  { id: 'figure.ellipse', group: 'tools', label: 'Ellipse', key: 'o' },
  { id: 'figure.last', group: 'tools', label: 'Last figure', key: 'g' },
  { id: 'tool.polyline', group: 'tools', label: 'Line', key: 'l' },
  { id: 'tool.highlighter', group: 'tools', label: 'Highlight', key: 'd', shift: true },
  { id: 'tool.laser', group: 'tools', label: 'Laser', key: 'k' },
  { id: 'tool.frame', group: 'tools', label: 'Frame', key: 'f' },
  { id: 'tool.lock', group: 'tools', label: 'Tool lock', key: 'q' },
  // The bar's tools by position: 1–9 and 0 (the tenth) press the Nth tool the bar shows, not a fixed tool.
  ...(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const).map(key => ({ id: `tool.bar.${key}`, group: 'tools', label: `Toolbar tool ${key}`, key })),
  // Comma presses the pointer at the keyboard cursor and lifting the key releases it (K§10.6).
  { id: 'pointer.hold', group: 'tools', label: 'Pointer down', key: ',' },
  { id: 'style.white', group: 'preferences', label: 'White', key: 't', alt: true },
  { id: 'style.fill', group: 'preferences', label: 'Fill', key: 'f', alt: true },
  { id: 'style.linedFill', group: 'preferences', label: 'Lined fill', key: 'f', alt: true, shift: true },
  { id: 'style.sample', group: 'preferences', label: 'Sample style', key: 'q', shift: true },
  { id: 'preferences.focus', group: 'preferences', label: 'Focus mode', key: '.', accel: true },
  { id: 'preferences.theme', group: 'preferences', label: 'Toggle theme', key: '/', accel: true },
  { id: 'preferences.grid', group: 'preferences', label: 'Toggle grid', key: "'", accel: true },
  { id: 'help.shortcuts', group: 'accessibility', label: 'Keyboard shortcuts', key: '/', accel: true, alt: true, required: true },
  // Cmd/Ctrl+K toggles the command palette. Inside a text edit the board's keys do not run, so the editor keeps it.
  { id: 'commandPalette.open', group: 'accessibility', label: 'Command palette', key: 'k', accel: true },
  { id: 'accessibility.repeat', group: 'accessibility', label: 'Repeat announcement', key: 'r', alt: true, required: true },
  { id: 'accessibility.contextMenu', group: 'accessibility', label: 'Open context menu', key: 'Enter', accel: true, shift: true, required: true },
  { id: 'edit.start', group: 'edit', label: 'Edit selected text', key: 'Enter' },
  // K§10.8: Cmd/Ctrl+Enter moves focus into the style panel. Enter (above) is the edit key, so this replaces the old
  // Cmd/Ctrl+Enter alias for editing. It is a required accessibility action, so the shortcuts preference does not stop it.
  { id: 'style.adjust', group: 'accessibility', label: 'Adjust shape styles', key: 'Enter', accel: true, required: true },
  { id: 'undo', group: 'edit', label: 'Undo', key: 'z', accel: true },
  { id: 'redo', group: 'edit', label: 'Redo', key: 'z', accel: true, shift: true },
  { id: 'delete', group: 'edit', label: 'Delete', key: 'Delete', required: true },
  { id: 'delete', group: 'edit', label: 'Delete', key: 'Backspace', required: true, alias: true },
  { id: 'select.all', group: 'edit', label: 'Select all', key: 'a', accel: true },
  { id: 'select.next', group: 'edit', label: 'Select next', key: 'Tab', repeat: true },
  { id: 'select.previous', group: 'edit', label: 'Select previous', key: 'Tab', shift: true, repeat: true },
  { id: 'group', group: 'edit', label: 'Group', key: 'g', accel: true },
  { id: 'ungroup', group: 'edit', label: 'Ungroup', key: 'g', accel: true, shift: true },
  { id: 'frame.toggle', group: 'edit', label: 'Frame selection', key: 'g', accel: true, alt: true },
  { id: 'frame.remove', group: 'edit', label: 'Remove frame', key: 'g', accel: true, alt: true, shift: true },
  { id: 'lock', group: 'edit', label: 'Lock', key: 'l', shift: true },
  { id: 'duplicate', group: 'edit', label: 'Duplicate', key: 'd', accel: true },
  // The clipboard chords run from the view's own keydown, which handles them before this table sees them (native copy and paste
  // events are never routed here); these rows name them for the shortcuts dialog. Plain Paste is the native paste event, not listed.
  { id: 'clipboard.pastePlain', group: 'edit', label: 'Paste as plain text', key: 'v', accel: true, shift: true },
  { id: 'clipboard.pasteAtCursor', group: 'edit', label: 'Paste at cursor', key: 'v', accel: true, alt: true },
  { id: 'clipboard.pastePlainAtCursor', group: 'edit', label: 'Paste plain text at cursor', key: 'v', accel: true, alt: true, shift: true },
  { id: 'clipboard.copyPng', group: 'edit', label: 'Copy as PNG', key: 'c', accel: true, shift: true },
  { id: 'media.insert', group: 'edit', label: 'Insert media', key: 'u', accel: true },
  // Before text.italic, which shares Cmd/Ctrl+I: the board's dispatch skips text-formatting, so italic stays a text-editor key.
  { id: 'embed.insert', group: 'edit', label: 'Insert embed', key: 'i', accel: true },
  { id: 'media.invert', group: 'edit', label: 'Invert image colours', key: 'i' },
  { id: 'arrange.back', group: 'edit', label: 'Send to back', key: '[' },
  { id: 'arrange.backward', group: 'edit', label: 'Send backward', key: '[', alt: true },
  { id: 'arrange.forward', group: 'edit', label: 'Bring forward', key: ']', alt: true },
  { id: 'arrange.front', group: 'edit', label: 'Bring to front', key: ']' },
  { id: 'align.left', group: 'transform', label: 'Align left', key: 'a', alt: true },
  { id: 'align.center', group: 'transform', label: 'Align center', key: 'h', alt: true },
  { id: 'align.right', group: 'transform', label: 'Align right', key: 'd', alt: true },
  { id: 'align.top', group: 'transform', label: 'Align top', key: 'w', alt: true },
  { id: 'align.middle', group: 'transform', label: 'Align middle', key: 'v', alt: true },
  { id: 'align.bottom', group: 'transform', label: 'Align bottom', key: 's', alt: true },
  { id: 'distribute.horizontal', group: 'transform', label: 'Distribute horizontally', key: 'h', alt: true, shift: true },
  { id: 'distribute.vertical', group: 'transform', label: 'Distribute vertically', key: 'v', alt: true, shift: true },
  { id: 'rotate.clockwise', group: 'transform', label: 'Rotate clockwise', key: '.', shift: true },
  { id: 'rotate.counterclockwise', group: 'transform', label: 'Rotate counterclockwise', key: ',', shift: true },
  { id: 'rotate.fineClockwise', group: 'transform', label: 'Rotate clockwise finely', key: '.', alt: true, shift: true },
  { id: 'rotate.fineCounterclockwise', group: 'transform', label: 'Rotate counterclockwise finely', key: ',', alt: true, shift: true },
  { id: 'flip.horizontal', group: 'transform', label: 'Flip horizontal', key: 'h', shift: true },
  { id: 'flip.vertical', group: 'transform', label: 'Flip vertical', key: 'v', shift: true },
  { id: 'scale.enlarge', group: 'transform', label: 'Enlarge', key: '=', accel: true, alt: true, shift: true },
  { id: 'scale.shrink', group: 'transform', label: 'Shrink', key: '-', accel: true, alt: true, shift: true },
  { id: 'flatten', group: 'transform', label: 'Flatten', key: 'f', shift: true },
  // Arrow keys are read from the key itself (navigation), so these entries exist to dispatch the accel form and to list the family.
  ...(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).flatMap(key => [
    { id: `nudge.${key}`, group: 'transform', label: `Nudge ${key.slice(5).toLowerCase()}`, key, repeat: true, alias: true },
    { id: `nudge.coarse.${key}`, group: 'transform', label: `Nudge ${key.slice(5).toLowerCase()} farther`, key, shift: true, repeat: true, alias: true },
    { id: `select.neighbour.${key}`, group: 'edit', label: `Select ${key.slice(5).toLowerCase()}`, key, accel: true, alias: true },
  ]),
  { id: 'nudge.move', group: 'transform', label: 'Move shape', key: 'ArrowUp', chordKey: '↑→↓←', dialogOnly: true },
  { id: 'nudge.faster', group: 'transform', label: 'Move shape faster', key: 'ArrowUp', shift: true, chordKey: '↑→↓←', dialogOnly: true },
  { id: 'select.direction', group: 'edit', label: 'Select shape in direction', key: 'ArrowUp', accel: true, chordKey: '↑→↓←', dialogOnly: true },
  { id: 'select.child', group: 'edit', label: 'Select child', key: 'ArrowDown', accel: true, shift: true },
  { id: 'select.parent', group: 'edit', label: 'Select parent', key: 'ArrowUp', accel: true, shift: true },
  { id: 'text.bold', group: 'text-formatting', label: 'Bold', key: 'b', accel: true },
  { id: 'text.italic', group: 'text-formatting', label: 'Italic', key: 'i', accel: true },
  { id: 'text.underline', group: 'text-formatting', label: 'Underline', key: 'u', accel: true },
  { id: 'text.strike', group: 'text-formatting', label: 'Strikethrough', key: 's', accel: true, shift: true },
  { id: 'text.highlight', group: 'text-formatting', label: 'Highlight', key: 'h', accel: true, shift: true },
  { id: 'text.code', group: 'text-formatting', label: 'Inline code', key: 'e', accel: true },
  { id: 'text.bullets', group: 'text-formatting', label: 'Bulleted list', key: '8', accel: true, shift: true },
  { id: 'text.numbered', group: 'text-formatting', label: 'Numbered list', key: '7', accel: true, shift: true },
  { id: 'text.link', group: 'text-formatting', label: 'Link', key: 'k', accel: true, shift: true },
  ...(['0', '1', '2', '3', '4', '5', '6'] as const).map(key => ({ id: `text.heading.${key}`, group: 'text-formatting', label: key === '0' ? 'Paragraph' : `Heading ${key}`, key, accel: true, alt: true })),
  // Cmd/Ctrl+= and Cmd/Ctrl+- are the browser's zoom keys: the board takes them so the page itself never zooms (K§5).
  { id: 'camera.zoomIn', group: 'view', label: 'Zoom in', key: '=', accel: true, repeat: true },
  { id: 'camera.zoomIn', group: 'view', label: 'Zoom in', key: '=', repeat: true, alias: true },
  { id: 'camera.zoomOut', group: 'view', label: 'Zoom out', key: '-', accel: true, repeat: true },
  { id: 'camera.zoomOut', group: 'view', label: 'Zoom out', key: '-', repeat: true, alias: true },
  { id: 'camera.zoomInCursor', group: 'view', label: 'Zoom in at cursor', key: '=', accel: true, shift: true, repeat: true },
  { id: 'camera.zoomInCursor', group: 'view', label: 'Zoom in at cursor', key: '=', shift: true, repeat: true, alias: true },
  { id: 'camera.zoomOutCursor', group: 'view', label: 'Zoom out at cursor', key: '-', accel: true, shift: true, repeat: true },
  { id: 'camera.zoomOutCursor', group: 'view', label: 'Zoom out at cursor', key: '-', shift: true, repeat: true, alias: true },
  { id: 'zoom.hold', group: 'view', label: 'Zoom to an area (hold)', key: 'z', dialogOnly: true },
  { id: 'zoom.quick', group: 'view', label: 'Quick zoom while holding Z', key: 'z', shift: true, dialogOnly: true },
  { id: 'camera.reset', group: 'view', label: 'Reset zoom', key: '0', shift: true },
  { id: 'camera.fit', group: 'view', label: 'Zoom to fit', key: '1', shift: true },
  { id: 'camera.selection', group: 'view', label: 'Zoom to selection', key: '2', shift: true },
  // Both axes walk the sheets: Left/Up back and Right/Down forward, each route listed in the shortcut sheet (R-4).
  { id: 'sheet.previous', group: 'view', label: 'Previous sheet', key: 'ArrowLeft', alt: true },
  { id: 'sheet.previous', group: 'view', label: 'Previous sheet', key: 'ArrowUp', alt: true, alias: true },
  { id: 'sheet.next', group: 'view', label: 'Next sheet', key: 'ArrowRight', alt: true },
  { id: 'sheet.next', group: 'view', label: 'Next sheet', key: 'ArrowDown', alt: true, alias: true },
  // Space held pages the camera by one viewport with an arrow; the dispatcher reads Space itself (K§10.5).
  { id: 'pan.camera', group: 'accessibility', label: 'Pan camera', key: ' ', chordKey: 'Space ↑→↓←', dialogOnly: true },
]

const keyNames: Readonly<Record<string, string>> = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }

/** The chord a person reads for a binding: modifiers then the key cap, joined with symbols on Mac and "+" elsewhere. */
export function bindingChord(binding: KeyBinding, mac: boolean): string {
  // Delete and Backspace draw the ⌫ cap on Mac, where the key is the one that erases backwards; elsewhere the name is clearer.
  const keyCap = binding.chordKey ?? (binding.key.length === 1 ? binding.key.toUpperCase()
    : binding.key === 'Delete' || binding.key === 'Backspace' ? (mac ? '⌫' : 'Del') : keyNames[binding.key] ?? binding.key)
  return [binding.accel ? (mac ? '⌘' : 'Ctrl') : '', binding.alt ? (mac ? '⌥' : 'Alt') : '', binding.shift ? (mac ? '⇧' : 'Shift') : '', keyCap]
    .filter(Boolean).join(mac ? '' : '+')
}

export interface ShortcutGroup {
  readonly id: string
  readonly label: string
  readonly bindings: readonly { readonly id: string; readonly label: string; readonly chord: string }[]
}

/** `paperHost` drops the theme row: on notebooks and PDF ink Mod+/ does nothing (R-26), so it is not advertised. */
export function shortcutGroups(mac: boolean, paperHost = false): readonly ShortcutGroup[] {
  const groups = new Map<string, { id: string; label: string; chord: string }[]>()
  for (const binding of boardBindings) {
    if (binding.alias || (paperHost && binding.id === 'preferences.theme')) continue
    const rows = groups.get(binding.group) ?? []
    rows.push({ id: `${binding.id}:${binding.accel ? 'mod-' : ''}${binding.alt ? 'alt-' : ''}${binding.shift ? 'shift-' : ''}${binding.key}`, label: binding.label, chord: bindingChord(binding, mac) })
    groups.set(binding.group, rows)
  }
  const labels: Record<string, string> = { tools: 'Tools', preferences: 'Preferences', edit: 'Edit', view: 'View', transform: 'Transform', 'text-formatting': 'Text formatting', accessibility: 'Accessibility' }
  return Object.entries(labels).map(([id, label]) => ({ id, label, bindings: groups.get(id) ?? [] }))
}

export interface KeyboardActions {
  readonly visible: () => boolean
  readonly enabled: () => boolean
  readonly shortcutsEnabled?: () => boolean
  readonly modalOpen: () => boolean
  readonly editing: () => boolean
  run(id: string, event: KeyboardEvent): boolean
  modifierChanged?(modifiers: Modifiers): void
  readonly cursor?: KeyboardCursor
  navigation?(): KeyboardNavigationPriority
  gestureActive?(): boolean
  /** Printable text on a selected editable node is offered only for keys no shortcut binds: a bound key is a shortcut. */
  typeText?(text: string): boolean
  clearLatches(): void
}

function textOwned(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]')) return true
  const listbox = target.closest('[role="listbox"]')
  return !!listbox && listbox !== root
}

// The browser's zoom keys belong to the page, so the board takes them while it has the keyboard (catalogue I§1.5).
const BROWSER_ZOOM_KEYS: ReadonlySet<string> = new Set(['+', '0'])

export function installKeyboard(root: HTMLElement, actions: KeyboardActions, mac: boolean): () => void {
  // The shortcut each held key started, by physical key. A held key may repeat the shortcut it started and nothing else:
  // releasing Shift mid-hold must not turn a repeating Shift+Arrow into a plain Arrow (K§0.2, K§15.6).
  const started = new Map<string, string>()
  let spaceHeld = false
  const keydown = (event: KeyboardEvent): void => {
    if (root.contains(event.target as Node)) {
      const accelDown = mac ? event.metaKey : event.ctrlKey
      if (accelDown && !event.altKey && BROWSER_ZOOM_KEYS.has(event.key)) event.preventDefault()
      // Windows opens the menu bar when Alt is released alone; a gesture or zoom that Alt joins must not reach it.
      if (event.key === 'Alt' && actions.gestureActive?.()) event.preventDefault()
    }
    if (event.defaultPrevented || !actions.visible() || actions.modalOpen() || actions.editing() || textOwned(event.target, root) || event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.getModifierState('AltGraph')) return
    if (!root.contains(event.target as Node)) return
    actions.modifierChanged?.({ shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel: mac ? event.metaKey : event.ctrlKey })
    const accel = mac ? event.metaKey : event.ctrlKey
    const otherAccel = mac ? event.ctrlKey : event.metaKey
    if (otherAccel) return
    const code = event.code || event.key
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    const modifiers: Modifiers = { shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel }
    const cursor = actions.cursor
    const consume = (): void => { event.preventDefault(); event.stopPropagation() }
    // A press that fired a shortcut records it; its repeats may only fire that same shortcut again.
    const mayRepeat = (id: string): boolean => !event.repeat || started.get(code) === id
    const fired = (id: string): void => { if (!event.repeat) started.set(code, id); consume() }
    if (cursor?.active && accel && !event.altKey && !event.shiftKey && key === 'z' && cursor.undo()) { consume(); return }
    if (cursor?.active && !accel && !event.altKey) {
      const moves: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
      const delta = moves[event.key]
      if (delta) { cursor.move(delta[0], delta[1], event.shiftKey, modifiers); consume(); return }
      if (event.key === 'Enter' && !event.repeat && cursor.enter(modifiers)) { consume(); return }
      if (event.key === 'Escape' && cursor.escape()) { consume(); return }
    }
    if (event.key === 'Escape') {
      if (actions.run('escape', event)) consume()
      return
    }
    const navigation = actions.navigation?.()
    if (navigation && !accel && !event.altKey && !cursor?.active) {
      const scrollKey = event.key === ' ' ? (event.shiftKey ? 'ShiftSpace' : 'Space') : event.key
      if (navigation.paged && !actions.gestureActive?.() && (scrollKey === 'PageUp' || scrollKey === 'PageDown' || scrollKey === 'Home' || scrollKey === 'End' || scrollKey === 'Space' || scrollKey === 'ShiftSpace')) {
        if (navigation.scroll(scrollKey)) { consume(); return }
      }
      if (/^Arrow(Left|Right|Up|Down)$/.test(event.key) && actions.shortcutsEnabled?.() !== false) {
        // Space held pages the camera; otherwise an arrow nudges a selection or pans the view (K§10.4, K§10.5).
        const paging = spaceHeld && !!navigation.page
        const id = paging ? 'camera.page' : navigation.hasSelection && actions.enabled() ? (event.shiftKey ? 'nudge.coarse' : 'nudge') : (event.shiftKey ? 'pan.coarse' : 'pan')
        if (!mayRepeat(id)) { consume(); return }
        const handled = paging ? navigation.page!(event.key)
          : navigation.hasSelection && actions.enabled() ? navigation.nudge(event.key, event.shiftKey) : navigation.pan(event.key, event.shiftKey)
        if (handled) { fired(id); return }
      }
    }
    const physical: Record<string, string> = { Period: '.', Comma: ',', Equal: '=', Minus: '-', Slash: '/', Quote: "'", BracketLeft: '[', BracketRight: ']' }
    const letter = /^Key([A-Z])$/.exec(event.code)
    // A layout whose letters are not ASCII (Cyrillic, Greek) still reaches the letter bindings by its physical key.
    const matchingKey = event.shiftKey && /^Digit[012]$/.test(event.code) ? event.code.slice(-1)
      : event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(-1).toLowerCase()
      : (event.altKey || event.shiftKey || accel) && physical[event.code] ? physical[event.code]
      : letter && !/^[\x20-\x7e]$/.test(event.key) ? letter[1].toLowerCase() : key
    const binding = boardBindings.find(item => !item.dialogOnly && item.key === matchingKey && !!item.shift === event.shiftKey && !!item.alt === event.altKey && !!item.accel === accel)
    // A bound key is a shortcut before it is text: ⇧/ opens the shortcuts dialog and never types '?' into a label.
    // Space is never the first character of a new label: it holds the camera (K§10.5), so it does not start editing.
    if (actions.enabled() && !accel && !event.altKey && !event.ctrlKey && !event.metaKey && !binding
      && event.key.length === 1 && event.key !== ' ' && actions.typeText?.(event.key)) {
      consume(); return
    }
    if (actions.shortcutsEnabled?.() !== false && !accel && !event.altKey && (event.key === ' ' || key === 'z')) {
      if (!event.repeat && actions.run(event.key === ' ' ? 'pan.hold' : 'zoom.hold', event)) {
        if (event.key === ' ') spaceHeld = true
        consume()
      }
      return
    }
    if (!binding || binding.group === 'text-formatting' || (event.repeat && !binding.repeat)) return
    if (!mayRepeat(binding.id)) { consume(); return }
    if (actions.shortcutsEnabled?.() === false && !binding.required) return
    if (!actions.enabled() && !(['view', 'accessibility'].includes(binding.group) || binding.id === 'tool.select' || binding.id === 'tool.hand' || binding.id.startsWith('select.') || binding.id.startsWith('preferences.'))) return
    if (actions.run(binding.id, event)) fired(binding.id)
  }
  const keyup = (event: KeyboardEvent): void => {
    started.delete(event.code || event.key)
    if (actions.visible() && !actions.modalOpen() && !actions.editing() && root.contains(document.activeElement)) {
      // macOS still reports metaKey on Meta's own key-up, so the release is read as released here (catalogue I§1.4).
      const accel = mac ? event.key !== 'Meta' && event.metaKey : event.ctrlKey
      actions.modifierChanged?.({ shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel })
    }
    if (event.key === ' ' || event.code === 'Space') { spaceHeld = false; actions.run('pan.release', event) }
    if (event.key.toLowerCase() === 'z' || event.code === 'KeyZ') actions.run('zoom.release', event)
    if (event.key === ',' || event.code === 'Comma') actions.run('pointer.release', event)
  }
  const clear = (): void => { started.clear(); spaceHeld = false; actions.clearLatches() }
  const blur = (): void => { clear() }
  const focusout = (event: FocusEvent): void => {
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) clear()
  }
  root.addEventListener('focusout', focusout)
  root.addEventListener('keydown', keydown)
  window.addEventListener('keyup', keyup)
  window.addEventListener('blur', blur)
  return () => { root.removeEventListener('focusout', focusout); root.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); clear() }
}
