import assert from 'node:assert/strict';
import { runArm, frames } from './lib/browser.mjs';
import { setup, seedPdf, saved, waitStrokes, exportNotebook, pdfFiles } from './lib/files.mjs';
import { inkRegions, readerCapture } from './lib/output.mjs';

for (const host of ['notebook', 'pdf']) await runArm('WB-D21', `${host}-two-sheets`, async h => {
  const blank = await seedPdf();
  const name = await setup(h, host, { 'FlattenedBefore.pdf': blank, 'FlattenedAfter.pdf': blank });
  if (host === 'notebook') await h.page.getByRole('button', { name: '+ Page', exact: true }).click();
  await h.draw(.3, .3); await waitStrokes(h, name, 1);
  const firstRegions = await inkRegions(h), first = await saved(h, name, 'sheet1');
  assert.equal(firstRegions.length, 1, 'First-sheet ink paint witness missing');
  async function output(label) {
    if (host === 'notebook') await exportNotebook(h);
    const bytes = await h.read(host === 'notebook' ? name.replace(/\.notebook$/, '.pdf') : name);
    await h.artifact(`${label}.pdf`, bytes); return bytes;
  }
  const beforePdf = await output('before');
  await h.page.getByRole('button', { name: 'Page 1', exact: true }).click();
  await h.page.getByRole('button', { name: 'Create new page', exact: true }).click(); await frames(h.page, 4);
  await h.draw(.2, .5); await waitStrokes(h, name, 2);
  const second = await saved(h, name, 'sheet2');
  assert.equal(second.sheets.length, 2, 'Actual second whiteboard sheet was not created');
  assert.equal(second.strokes.length, 2, 'Both sheet strokes must remain in editable bytes');
  const afterPdf = await output('after'), capture = await h.capture('second-sheet');
  const secondStroke = second.strokes.find(s => !first.strokes.some(before => before.id === s.id));
  assert(secondStroke, 'Second sheet did not persist a separate stroke');
  const page = first.backdrops[0];
  // Today's newly-created sheet has no backdrop and starts at 100% zoom. Its
  // saved ink origin plus the known 100-CSS-pixel gesture bounds supplies a
  // conservative output ROI without borrowing the editor's private camera.
  const secondRegion = { x: (secondStroke.x - page.x - 10) / page.props.w,
    y: (secondStroke.y - page.y - 10) / page.props.h,
    width: 120 / page.props.w, height: 40 / page.props.h };
  const regions = [firstRegions[0], secondRegion];
  await h.seed({ 'FlattenedBefore.pdf': beforePdf, 'FlattenedAfter.pdf': afterPdf });
  const beforePixels = await readerCapture(h, 'FlattenedBefore.pdf', regions, 'before-reader');
  const afterPixels = await readerCapture(h, 'FlattenedAfter.pdf', regions, 'after-reader');
  assert(beforePixels.regions[0].darkPixels > 20, 'First output never showed the first ink; missing defect witness');
  assert(afterPixels.regions[1].darkPixels > 20, 'Second-sheet output never showed its ink');
  return { witness: { savedSheets: second.sheets.length, savedStrokes: second.strokes.length,
    beforeFirstInkDarkPixels: beforePixels.regions[0].darkPixels,
    afterFirstInkDarkPixels: afterPixels.regions[0].darkPixels,
    afterSecondInkDarkPixels: afterPixels.regions[1].darkPixels },
    reproduced: afterPixels.regions[0].darkPixels < beforePixels.regions[0].darkPixels * .25,
    first, second, beforePixels, afterPixels,
    physicalPages: { before: (await pdfFiles(beforePdf)).pages, after: (await pdfFiles(afterPdf)).pages },
    capture, loss: 'Two sheets, one controlled ink region each, on the first physical page. Other physical-page combinations and cross-page shapes are not exhaustively sampled.' };
});
