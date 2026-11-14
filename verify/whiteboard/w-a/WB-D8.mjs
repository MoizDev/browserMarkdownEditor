import assert from 'node:assert/strict';
import { runArm, frames } from './lib/browser.mjs';
import { hosts, setup, saved, waitStrokes, shapePaint } from './lib/files.mjs';

async function zoom(h) {
  const name = await h.page.getByRole('button', { name: /^Zoom —/ }).getAttribute('aria-label');
  const percent = Number(name?.match(/([\d.]+)%/)?.[1]);
  assert(percent > 0, 'Visible Zoom control missing'); return percent;
}
const contacts = (c, distance) => [{ x: c.x - distance / 2, y: c.y }, { x: c.x + distance / 2, y: c.y }];
for (const host of hosts) for (const continuation of (process.env.CONTINUATIONS ?? 'archived-sequence,lift-during-pinch,move-after-pinch').split(',')) await runArm('WB-D8', `${host}-${continuation}`, async h => {
  const name = await setup(h, host);
  await h.draw(.3, .3); await waitStrokes(h, name, 1);
  const baseline = await saved(h, name, 'baseline');
  const before = await zoom(h), a = await h.point(.35, .45), c = await h.point(.6, .55);
  const mark = await h.mark();
  await h.canvas().focus(); await h.chord('d');
  await h.pointer('mouseMoved', a, { buttons: 0 }); await h.pointer('mousePressed', a);
  await h.pointer('mouseMoved', { x: a.x + 80, y: a.y + 20 });
  await h.touch('touchStart', contacts(c, 60));
  if (continuation === 'archived-sequence') { await h.touch('touchMove', contacts(c, 120)); await frames(h.page, 2); }
  else for (let i = 1; i <= 8; i++) { await h.touch('touchMove', contacts(c, 60 + 60 * i / 8)); await frames(h.page, 0); }
  const duringPinch = await zoom(h), pinchCapture = await h.capture('pen-and-pinch');
  if (continuation === 'move-after-pinch') await h.pointer('mouseMoved', { x: a.x + 120, y: a.y + 30 });
  await h.pointer('mouseReleased', continuation === 'move-after-pinch' ? { x: a.x + 120, y: a.y + 30 } : { x: a.x + 80, y: a.y + 20 });
  await frames(h.page);
  const penUp = await zoom(h);
  if (continuation !== 'archived-sequence') { await h.touch('touchMove', contacts(c, 160)); await frames(h.page); }
  const heldTouch = await zoom(h);
  await h.touch('touchEnd', []); await h.page.waitForTimeout(5500);
  const afterPinch = await saved(h, name, 'after-pinch'), liveAfterPinch = await shapePaint(h);
  // A tool key here would reset the unfinished draw state and hide the very
  // joined-stroke defect being observed. The next contact is pen input only.
  await h.stroke([{ x: a.x, y: a.y + 160 }, { x: a.x + 80, y: a.y + 180 }, { x: a.x + 160, y: a.y + 160 }]);
  await h.page.waitForTimeout(5500);
  const afterNext = await saved(h, name, 'after-next-pen'), liveAfterNext = await shapePaint(h);
  const freshBefore = await zoom(h);
  const fresh = await h.point(.6, .6);
  await h.touch('touchStart', contacts(fresh, 60));
  for (let i = 1; i <= 8; i++) { await h.touch('touchMove', contacts(fresh, 60 + 60 * i / 8)); await frames(h.page, 0); }
  await h.touch('touchEnd', []); await frames(h.page, 5);
  const freshAfter = await zoom(h);
  const receipts = await h.page.evaluate(() => window.__wa.events);
  assert(receipts.some(e => e.kind === 'pen' && e.type === 'pointerdown' && e.trusted), 'Trusted pen witness missing');
  assert(receipts.some(e => e.type === 'touchstart' && e.touches.length === 2 && e.trusted), 'Trusted two-touch witness missing');
  assert(freshAfter / freshBefore > 1.5, 'No-pen pinch positive control did not zoom');
  const penIds = liveAfterPinch.filter(s => s.type === 'draw').map(s => s.id);
  const nextIds = liveAfterNext.filter(s => s.type === 'draw').map(s => s.id);
  const separateStrokeAdded = nextIds.some(id => !penIds.includes(id));
  return { witness: { baselineSavedStrokes: baseline.strokes.length, zoomBefore: before,
    zoomDuringPen: duringPinch, zoomAtPenUp: penUp, heldTouchMoved: continuation !== 'archived-sequence', zoomAfterHeldTouchMove: heldTouch,
    savedAfterPinch: afterPinch.strokes.length, incompleteAfterPinch: afterPinch.strokes.filter(s => !s.props.isComplete).length,
    savedAfterNext: afterNext.strokes.length, separateStrokeAdded, freshPinchRatio: freshAfter / freshBefore },
    reproduced: duringPinch !== before && (!separateStrokeAdded || afterPinch.strokes.length < 2),
    baseline, afterPinch, afterNext, liveAfterPinch, liveAfterNext,
    postMarkerWrites: (await h.writes(name)).filter(w => w.id > mark), captures: [pinchCapture, await h.capture('fresh-pinch-control')],
    loss: 'Trusted CDP logical contacts are not physical palm rejection or digitizer latency. No trusted pen pointercancel source is exposed by dispatchMouseEvent; that later filter-release facet is not claimed here.' };
}, { hasTouch: true });
