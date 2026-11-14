import assert from 'node:assert/strict';
import { runArm } from './lib/browser.mjs';
import { setup, saved, waitStrokes, shapePaint } from './lib/files.mjs';

for (const host of ['notebook', 'pdf']) await runArm('WB-D6', `${host}-unlock`, async h => {
  const name = await setup(h, host);
  await h.draw(.3, .3); await waitStrokes(h, name, 1);
  const initial = await saved(h, name, 'initial');
  assert(initial.backdrops.length && initial.backdrops.every(s => s.isLocked), 'Locked backdrop fixture required');
  await h.page.getByRole('button', { name: 'Menu', exact: true }).click();
  await h.page.getByRole('menuitem', { name: 'Edit', exact: true }).hover();
  await h.page.getByRole('menuitem', { name: 'Unlock all', exact: true }).click();
  await h.page.waitForTimeout(3500);
  const unlocked = await saved(h, name, 'unlocked');
  await h.canvas().focus(); await h.chord('v');
  const point = await h.point(.6, .5), marker = await h.mark();
  await h.page.mouse.move(point.x, point.y); await h.page.mouse.down();
  await h.page.mouse.move(point.x + 100, point.y + 80, { steps: 8 }); await h.page.mouse.up();
  await h.page.waitForTimeout(3500);
  const moved = await saved(h, name, 'moved'), moveCapture = await h.capture('backdrop-moved');
  await h.chord('Backspace'); await h.page.waitForTimeout(3500);
  const deleted = await saved(h, name, 'deleted'), deletedCapture = await h.capture('backdrop-deleted');
  await h.chord('Mod+z'); await h.page.waitForTimeout(3500);
  const restored = await saved(h, name, 'undo-delete');
  await h.page.mouse.click(point.x, point.y, { button: 'right' });
  const contextMenu = await h.page.getByRole('menu').allTextContents();
  const beforePage = initial.backdrops[0], afterPage = moved.backdrops.find(s => s.id === beforePage.id);
  return { witness: { initiallyLocked: initial.backdrops.every(s => s.isLocked),
    unlocked: unlocked.backdrops.some(s => !s.isLocked),
    backdropMoved: !!afterPage && (beforePage.x !== afterPage.x || beforePage.y !== afterPage.y),
    deletedBackdropCount: initial.backdrops.length - deleted.backdrops.length,
    unchangedInkPosition: initial.strokes.every(s => moved.strokes.some(n => n.id === s.id && n.x === s.x && n.y === s.y)),
    destructiveWrites: (await h.writes(name)).filter(w => w.id > marker && w.closed !== null).length },
    reproduced: unlocked.backdrops.some(s => !s.isLocked) && deleted.backdrops.length < initial.backdrops.length,
    initial, unlocked, moved, deleted, restored, contextMenu, painted: await shapePaint(h),
    captures: [moveCapture, deletedCapture, await h.capture('backdrop-context-menu')],
    loss: 'The page-original PDF bytes are retained in the artifacts; this does not claim that deleting a backdrop destroys the PDF original. Keyboard protection has its own WB-D33 arm; eraser-specific removal is not yet counted.' };
});
