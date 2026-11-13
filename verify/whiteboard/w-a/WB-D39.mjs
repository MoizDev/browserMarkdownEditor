import assert from 'node:assert/strict';
import { runArm, frames } from './lib/browser.mjs';
import { setup, shapePaint, saved, waitStrokes } from './lib/files.mjs';

function light() { localStorage.setItem('theme', 'light'); }
function dark() { localStorage.setItem('theme', 'dark'); }
for (const host of ['notebook', 'pdf']) for (const theme of ['light', 'dark']) {
  await runArm('WB-D39', `${host}-${theme}-new-sheet`, async h => {
    const name = await setup(h, host);
    const before = await shapePaint(h), beforeCapture = await h.capture('sheet1-paper');
    assert(before.some(s => s.type === 'image'), 'Initial sheet must visibly contain its backdrop');
    await h.page.getByRole('button', { name: 'Page 1', exact: true }).click();
    await h.page.getByRole('button', { name: 'Create new page', exact: true }).click();
    await frames(h.page, 5);
    const emptySecond = await shapePaint(h), emptyCapture = await h.capture('sheet2-no-ink');
    await h.draw(.2, .5); await waitStrokes(h, name, 1);
    const second = await shapePaint(h), after = await saved(h, name, 'second-sheet');
    assert.equal(after.sheets.length, 2, 'Second sheet creation was not persisted');
    return { theme, witness: { firstSheetBackdropCount: before.filter(s => s.type === 'image').length,
      secondSheetBackdropCount: second.filter(s => s.type === 'image').length,
      savedSheets: after.sheets.length, savedStrokes: after.strokes.length },
      reproduced: !second.some(s => s.type === 'image'), before, emptySecond, second, after,
      captures: [beforeCapture, emptyCapture, await h.capture('sheet2-ink')],
      loss: 'One newly-created second sheet per host and theme. Existing imported sheets and all page-size variants are not covered.' };
  }, { init: theme === 'light' ? light : dark });
}
