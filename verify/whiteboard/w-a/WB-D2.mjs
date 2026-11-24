import assert from 'node:assert/strict';
import { runArm, frames } from './lib/browser.mjs';
import { setup, waitStrokes, shapePaint, saved } from './lib/files.mjs';

await runArm('WB-D2', 'delete-undo', async h => {
  const name = await setup(h, 'notebook');
  await h.page.getByRole('button', { name: '+ Page', exact: true }).click();
  const pageNumber = h.page.getByRole('textbox', { name: 'Page number', exact: true });
  await pageNumber.fill('2'); await pageNumber.press('Enter'); await frames(h.page, 4);
  await h.draw(.3, .3); await waitStrokes(h, name, 1);
  await h.draw(.5, .5); await waitStrokes(h, name, 2);
  const before = await saved(h, name, 'before');
  assert.equal(before.paper.pageCount, 2, 'Two physical pages required');
  await h.page.getByRole('button', { name: 'Delete the last page', exact: true }).click();
  const dialog = await h.page.getByRole('dialog').innerText();
  assert.match(dialog, /2 strokes/, 'Both strokes must be on the last page');
  await h.page.getByRole('button', { name: 'Delete page', exact: true }).click();
  await frames(h.page);
  const deleted = await shapePaint(h), deletedCapture = await h.capture('deleted');
  await h.canvas().focus(); await h.chord('Mod+z'); await frames(h.page);
  const immediate = await shapePaint(h), undoCapture = await h.capture('one-undo');
  await h.page.waitForTimeout(2500);
  const after = await saved(h, name, 'one-undo');
  return { witness: { beforeStrokes: before.strokes.length,
    deletedStrokes: deleted.filter(s => s.type === 'draw').length,
    undoPaintedStrokes: immediate.filter(s => s.type === 'draw').length,
    undoSavedStrokes: after.strokes.length, undoSavedPageCount: after.paper.pageCount },
    reproduced: after.strokes.length !== 2, before, after, dialog, deleted, immediate,
    captures: [deletedCapture, undoCapture, await h.capture('one-undo-settled')],
    loss: 'One real notebook page-delete/Undo sequence; not exhaustive history interleavings.' };
});
