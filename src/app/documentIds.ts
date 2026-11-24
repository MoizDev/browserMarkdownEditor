/** Session-unique document ids (see OpenTab.id). Never persisted — the stored
 *  session records paths, so these are re-minted on restore. They must never
 *  REPEAT within a page load, not merely differ among the documents open at one
 *  moment: the editor-state cache can still hold a closed document's state
 *  until EditorPane next prunes it (after a stay in the graph view, which
 *  unmounts it), and a recycled id would hand that state — text and undo
 *  history — to a different document. The monotonic counter guarantees it;
 *  keep it that way. */
let docSeq = 0;
export function newTabId(): string {
  return `d${(++docSeq).toString(36)}`;
}
