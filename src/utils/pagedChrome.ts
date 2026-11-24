/** How far below a paged view's top edge (a notebook, read-only or editable, and a PDF in Annotate) its first page opens and
 *  scrolls back to: under the board's top strip (40px from the view's top) and, while editing, the paper bar below it (to
 *  92px, 96px in a narrow pane where it is 50px tall), with 8px clear. The panes pass it as the camera's top inset and the
 *  zoom-to-fit commands use the same, so a fit and the view agree. At 16px the top of page 1 opened 24px under the strip and
 *  76px under the paper bar, and no scroll could reach it (measured: view top 72px, page top 88px, strip to 112px, paper bar
 *  118px to 164px). One value for both routes: an editable copy opens at the read-only view's camera. */
export const PAGED_TOP_INSET = 104;
