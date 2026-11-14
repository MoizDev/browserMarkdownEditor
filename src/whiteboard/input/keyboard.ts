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
  { id: 'style.white', group: 'style', label: 'White', key: 't', alt: true },
  { id: 'style.fill', group: 'style', label: 'Fill', key: 'f', alt: true },
  { id: 'style.linedFill', group: 'style', label: 'Lined fill', key: 'f', alt: true, shift: true },
  { id: 'style.sample', group: 'style', label: 'Sample style', key: 'q', shift: true },
  { id: 'undo', group: 'edit', label: 'Undo', key: 'z', accel: true },
  { id: 'redo', group: 'edit', label: 'Redo', key: 'z', accel: true, shift: true },
  { id: 'delete', group: 'edit', label: 'Delete', key: 'Delete' },
  { id: 'delete', group: 'edit', label: 'Delete', key: 'Backspace' },
  { id: 'camera.zoomIn', group: 'view', label: 'Zoom in', key: '=', repeat: true },
  { id: 'camera.zoomOut', group: 'view', label: 'Zoom out', key: '-', repeat: true },
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
    rows.push({ id: `${binding.id}:${binding.key}`, label: binding.label, chord: parts.join(mac ? '' : '+') })
    groups.set(binding.group, rows)
  }
  return [...groups].map(([id, bindings]) => ({ id, label: id[0].toUpperCase() + id.slice(1), bindings }))
}

export interface KeyboardActions {
  readonly visible: () => boolean
  readonly enabled: () => boolean
  readonly modalOpen: () => boolean
  readonly editing: () => boolean
  run(id: string, event: KeyboardEvent): boolean
  clearLatches(): void
}

function textOwned(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], [role="menu"], [role="listbox"]')
}

export function installKeyboard(root: HTMLElement, actions: KeyboardActions, mac: boolean): () => void {
  const keydown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || !actions.visible() || actions.modalOpen() || actions.editing() || textOwned(event.target) || event.isComposing || event.keyCode === 229 || event.key === 'Dead' || event.getModifierState('AltGraph')) return
    if (!root.contains(event.target as Node)) return
    const accel = mac ? event.metaKey : event.ctrlKey
    const otherAccel = mac ? event.ctrlKey : event.metaKey
    if (otherAccel) return
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (event.key === 'Escape') {
      if (actions.run('escape', event)) { event.preventDefault(); event.stopPropagation() }
      return
    }
    if (!actions.enabled()) return
    if (!accel && !event.altKey && (event.key === ' ' || key === 'z')) {
      if (!event.repeat && actions.run(event.key === ' ' ? 'pan.hold' : 'zoom.hold', event)) { event.preventDefault(); event.stopPropagation() }
      return
    }
    const matchingKey = event.shiftKey && /^Digit[012]$/.test(event.code) ? event.code.slice(-1)
      : event.altKey && /^Key[TF]$/.test(event.code) ? event.code.slice(-1).toLowerCase() : key
    const binding = boardBindings.find(item => item.key === matchingKey && !!item.shift === event.shiftKey && !!item.alt === event.altKey && !!item.accel === accel)
    if (!binding || (event.repeat && !binding.repeat)) return
    if (actions.run(binding.id, event)) { event.preventDefault(); event.stopPropagation() }
  }
  const keyup = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.code === 'Space') actions.run('pan.release', event)
    if (event.key.toLowerCase() === 'z' || event.code === 'KeyZ') actions.run('zoom.release', event)
  }
  const blur = (): void => { actions.clearLatches() }
  root.addEventListener('keydown', keydown)
  window.addEventListener('keyup', keyup)
  window.addEventListener('blur', blur)
  return () => { root.removeEventListener('keydown', keydown); window.removeEventListener('keyup', keyup); window.removeEventListener('blur', blur); actions.clearLatches() }
}
