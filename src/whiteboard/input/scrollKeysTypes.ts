export type PagedScrollKey = 'PageUp' | 'PageDown' | 'Home' | 'End' | 'Space' | 'ShiftSpace'
export interface KeyboardNavigationPriority {
  readonly paged: boolean
  readonly hasSelection: boolean
  readonly keyboardCursorActive: boolean
  scroll(key: PagedScrollKey): boolean
  nudge(direction: string, coarse: boolean): boolean
  pan(direction: string, coarse: boolean): boolean
}
