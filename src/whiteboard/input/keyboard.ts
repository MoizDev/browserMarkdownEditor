import type { Modifiers } from './tool'

export interface KeyBinding {
  readonly id: string
  readonly group: string
  readonly label: string
  readonly key: string
  readonly shift?: boolean
  readonly alt?: boolean
  readonly accel?: boolean
  readonly repeat?: boolean
}

// This one table supplies both dispatch and the shortcut dialog.
export const boardBindings: readonly KeyBinding[] = [
  { id: 'tool.select', group: 'tools', label: 'Select', key: 'v' },
  { id: 'tool.hand', group: 'tools', label: 'Hand', key: 'h' },
  { id: 'tool.pen', group: 'tools', label: 'Draw', key: 'd' },
  { id: 'tool.pen', group: 'tools', label: 'Draw', key: 'b' },
  { id: 'tool.pen', group: 'tools', label: 'Draw', key: 'x' },
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
  { id: 'style.white', group: 'preferences', label: 'White', key: 't', alt: true },
  { id: 'style.fill', group: 'preferences', label: 'Fill', key: 'f', alt: true },
  { id: 'style.linedFill', group: 'preferences', label: 'Lined fill', key: 'f', alt: true, shift: true },
  { id: 'style.sample', group: 'preferences', label: 'Sample style', key: 'q', shift: true },
  { id: 'preferences.focus', group: 'preferences', label: 'Focus mode', key: '.', accel: true },
  { id: 'preferences.theme', group: 'preferences', label: 'Toggle theme', key: '/', accel: true },
  { id: 'preferences.grid', group: 'preferences', label: 'Toggle grid', key: "'", accel: true },
  { id: 'help.shortcuts', group: 'accessibility', label: 'Keyboard shortcuts', key: '/', shift: true },
  { id: 'accessibility.repeat', group: 'accessibility', label: 'Repeat announcement', key: 'r', alt: true },
  { id: 'accessibility.contextMenu', group: 'accessibility', label: 'Open context menu', key: 'Enter', accel: true, shift: true },
  { id: 'edit.start', group: 'edit', label: 'Edit selected text', key: 'Enter', accel: true },
  { id: 'undo', group: 'edit', label: 'Undo', key: 'z', accel: true },
  { id: 'redo', group: 'edit', label: 'Redo', key: 'z', accel: true, shift: true },
  { id: 'delete', group: 'edit', label: 'Delete', key: 'Delete' },
  { id: 'delete', group: 'edit', label: 'Delete', key: 'Backspace' },
  { id: 'select.all', group: 'edit', label: 'Select all', key: 'a', accel: true },
  { id: 'select.next', group: 'edit', label: 'Select next', key: 'Tab' },
  { id: 'select.previous', group: 'edit', label: 'Select previous', key: 'Tab', shift: true },
  { id: 'group', group: 'edit', label: 'Group', key: 'g', accel: true },
  { id: 'ungroup', group: 'edit', label: 'Ungroup', key: 'g', accel: true, shift: true },
  { id: 'lock', group: 'edit', label: 'Lock', key: 'l', shift: true },
  { id: 'duplicate', group: 'edit', label: 'Duplicate', key: 'd', accel: true },
  { id: 'media.insert', group: 'edit', label: 'Insert media', key: 'u', accel: true },
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
  ...(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'] as const).flatMap(key => [
    { id: `nudge.${key}`, group: 'transform', label: `Nudge ${key.slice(5).toLowerCase()}`, key, repeat: true },
    { id: `nudge.coarse.${key}`, group: 'transform', label: `Nudge ${key.slice(5).toLowerCase()} farther`, key, shift: true, repeat: true },
    { id: `select.neighbour.${key}`, group: 'edit', label: `Select ${key.slice(5).toLowerCase()}`, key, accel: true },
  ]),
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
  ...(['0', '1', '2', '3', '4', '5', '6'] as const).map(key => ({ id: `text.heading.${key}`, group: 'text-formatting', label: key === '0' ? 'Paragraph' : `Heading ${key}`, key, accel: true, alt: true })),
  { id: 'camera.zoomIn', group: 'view', label: 'Zoom in', key: '=', repeat: true },
  { id: 'camera.zoomOut', group: 'view', label: 'Zoom out', key: '-', repeat: true },
  { id: 'camera.zoomInCursor', group: 'view', label: 'Zoom in at cursor', key: '=', shift: true, repeat: true },
  { id: 'camera.zoomOutCursor', group: 'view', label: 'Zoom out at cursor', key: '-', shift: true, repeat: true },
  { id: 'camera.reset', group: 'view', label: 'Reset zoom', key: '0', shift: true },
  { id: 'camera.fit', group: 'view', label: 'Zoom to fit', key: '1', shift: true },
  { id: 'camera.selection', group: 'view', label: 'Zoom to selection', key: '2', shift: true },
  { id: 'sheet.previous', group: 'view', label: 'Previous sheet', key: 'ArrowLeft', alt: true },
  { id: 'sheet.next', group: 'view', label: 'Next sheet', key: 'ArrowRight', alt: true },
]

export interface ShortcutGroup {
  readonly id: string
  readonly label: string
  readonly bindings: readonly { readonly id: string; readonly label: string; readonly chord: string }[]
}

export function shortcutGroups(mac: boolean): readonly ShortcutGroup[] {
  const groups = new Map<string, { id: string; label: string; chord: string }[]>()
  for (const binding of boardBindings) {
    const parts = [binding.accel ? (mac ? '⌘' : 'Ctrl') : '', binding.alt ? (mac ? '⌥' : 'Alt') : '', binding.shift ? (mac ? '⇧' : 'Shift') : '', binding.key.length === 1 ? binding.key.toUpperCase() : binding.key].filter(Boolean)
    const rows = groups.get(binding.group) ?? []
    rows.push({ id: `${binding.id}:${binding.accel ? 'mod-' : ''}${binding.alt ? 'alt-' : ''}${binding.shift ? 'shift-' : ''}${binding.key}`, label: binding.label, chord: parts.join(mac ? '' : '+') })
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
  clearLatches(): void
}

function textOwned(target: EventTarget | null, root: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"]')) return true
  const listbox = target.closest('[role="listbox"]')
  return !!listbox && listbox !== root
}

export function installKeyboard(root: HTMLElement, actions: KeyboardActions, mac: boolean): () => void {
  const keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !actions.visible() || actions.modalOpen() || actions.editing() || textOwned(event.target, root) || event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.getModifierState('AltGraph')) return
    if (!root.contains(event.target as Node)) return
    actions.modifierChanged?.({ shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel: mac ? event.metaKey : event.ctrlKey })
    const accel = mac ? event.metaKey : event.ctrlKey
    const otherAccel = mac ? event.ctrlKey : event.metaKey
    if (otherAccel) return
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (event.key === 'Escape') {
      if (actions.run('escape', event)) { event.preventDefault(); event.stopPropagation() }
      return
    }
    if (actions.shortcutsEnabled?.() !== false && !accel && !event.altKey && (event.key === ' ' || key === 'z')) {
      if (!event.repeat && actions.run(event.key === ' ' ? 'pan.hold' : 'zoom.hold', event)) { event.preventDefault(); event.stopPropagation() }
      return
    }
    const physical: Record<string, string> = { Period: '.', Comma: ',', Equal: '=', Minus: '-', Slash: '/', Quote: "'", BracketLeft: '[', BracketRight: ']' }
    const matchingKey = event.shiftKey && /^Digit[012]$/.test(event.code) ? event.code.slice(-1)
      : event.altKey && /^Key[A-Z]$/.test(event.code) ? event.code.slice(-1).toLowerCase()
      : (event.altKey || event.shiftKey || accel) && physical[event.code] ? physical[event.code] : key
    const binding = boardBindings.find(item => item.key === matchingKey && !!item.shift === event.shiftKey && !!item.alt === event.altKey && !!item.accel === accel)
    if (!binding || binding.group === 'text-formatting' || (event.repeat && !binding.repeat)) return
    if (actions.shortcutsEnabled?.() === false && binding.id !== 'accessibility.repeat') return
    if (!actions.enabled() && !(['view', 'accessibility'].includes(binding.group) || binding.id === 'tool.select' || binding.id === 'tool.hand' || binding.id.startsWith('select.') || binding.id.startsWith('preferences.'))) return
    if (actions.run(binding.id, event)) { event.preventDefault(); event.stopPropagation() }
  }
  const keyup = (event: KeyboardEvent): void => {
    if (actions.visible() && !actions.modalOpen() && !actions.editing() && root.contains(document.activeElement)) {
      actions.modifierChanged?.({ shift: event.shiftKey, alt: event.altKey, control: event.ctrlKey, accel: mac ? event.metaKey : event.ctrlKey })
    }
    if (event.key === ' ' || event.code === 'Space') actions.run('pan.release', event)
    if (event.key.toLowerCase() === 'z' || event.code === 'KeyZ') actions.run('zoom.release', event)
  }
  const blur = (): void => { actions.clearLatches() }
  root.addEventListener('keydown', keydown)
  window.addEventListener('keyup', keyup)
  window.addEventListener('blur', blur)
  return () => { root.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); actions.clearLatches() }
}
