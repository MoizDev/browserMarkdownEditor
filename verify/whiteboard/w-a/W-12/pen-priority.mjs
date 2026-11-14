import assert from 'node:assert/strict';
import { runArm, frames, hash } from '../lib/browser.mjs';
import { hosts, setup, waitStrokes, saved, shapePaint } from '../lib/files.mjs';
import { observeWindowTouchListeners, windowTouchState } from './window-touch.mjs';

const contacts = (c, distance) => [{ x: c.x - distance / 2, y: c.y }, { x: c.x + distance / 2, y: c.y }];
async function zoom(h) {
  const label = await h.page.getByRole('button', { name: /^Zoom —/ }).getAttribute('aria-label');
  const value = Number(label?.match(/([\d.]+)%/)?.[1]);
  assert(value > 0, 'W12-HARNESS: no visible zoom control'); return value;
}
const results = [];
for (const host of hosts) for (const order of (process.env.ORDERS ?? 'lift-during-pinch,move-after-pinch').split(',')) {
  const result = await runArm('W-12', `${host}-${order}`, async h => {
    const name = await setup(h, host);
    assert.equal(h.meta.mode, 'production', 'W12-HARNESS: production build required');
    assert(await h.canvas().evaluate(el => !!el.closest('[data-legacy-board]')), 'W12-HARNESS: legacy root marker absent');
    assert(await h.page.evaluate(() => navigator.maxTouchPoints > 0), 'W12-HARNESS: touch-capable context required');
    await h.draw(.3, .3); await waitStrokes(h, name, 1);
    const baseline = await saved(h, name, 'baseline'), reference = (await shapePaint(h)).find(s => s.id === baseline.strokes[0].id);
    assert(reference, 'W12-HARNESS: baseline reference ink not painted');
    const r = reference.rect, clip = { x: Math.floor(r.x) - 4, y: Math.floor(r.y) - 4,
      width: Math.ceil(r.width) + 8, height: Math.ceil(r.height) + 8 };
    const referenceBefore = await h.page.screenshot({ clip });
    await h.artifact('reference-before.png', referenceBefore);
    await h.page.evaluate(() => {
      window.__w12Later = [];
      for (const type of ['pointerdown', 'pointermove', 'pointerup']) {
        window.addEventListener(type, e => {
          if (e.pointerType === 'touch' || e.type.startsWith('touch')) window.__w12Later.push({ type, id: e.pointerId, trusted: e.isTrusted });
        }, { capture: true, passive: true });
      }
    });
    const registrationsBeforePen = await windowTouchState(h.page);
    const beforeZoom = await zoom(h), a = await h.point(.35, .45), c = await h.point(.6, .55);
    const marker = await h.mark();
    await h.canvas().focus(); await h.chord('d');
    await h.pointer('mouseMoved', a, { buttons: 0 }); await h.pointer('mousePressed', a);
    // The product's touch listeners are armed by pen-down, not at boot. Add
    // this passive observer afterwards so it really is behind that filter.
    await h.page.evaluate(() => {
      for (const type of ['touchstart', 'touchmove', 'touchend']) window.addEventListener(type, e => {
        window.__w12Later.push({ type, trusted: e.isTrusted });
      }, { capture: true, passive: true });
    });
    const registrationsArmed = await windowTouchState(h.page);
    await h.pointer('mouseMoved', { x: a.x + 80, y: a.y + 20 });
    await h.touch('touchStart', contacts(c, 60));
    for (let i = 1; i <= 8; i++) await h.touch('touchMove', contacts(c, 60 + 60 * i / 8));
    await frames(h.page, 3);
    const duringZoom = await zoom(h), referenceDuring = await h.page.screenshot({ clip });
    await h.artifact('reference-during.png', referenceDuring);
    if (order === 'move-after-pinch') await h.pointer('mouseMoved', { x: a.x + 120, y: a.y + 30 });
    const end = order === 'move-after-pinch' ? { x: a.x + 120, y: a.y + 30 } : { x: a.x + 80, y: a.y + 20 };
    await h.pointer('mouseReleased', end); await frames(h.page, 3);
    const penUpZoom = await zoom(h), laterAtPenUp = await h.page.evaluate(() => window.__w12Later.length);
    await h.touch('touchMove', contacts(c, 160)); await frames(h.page, 3);
    const heldTouchZoom = await zoom(h), referenceAfter = await h.page.screenshot({ clip });
    await h.artifact('reference-after-pen-up.png', referenceAfter);
    const blockedReceipts = await h.page.evaluate(() => window.__w12Later);
    await h.touch('touchEnd', []); await h.page.waitForTimeout(5500);
    const afterPinch = await saved(h, name, 'after-pinch'), paintedPinch = await shapePaint(h);
    // No focus/tool key: an unfinished stroke must not be healed by setup before
    // the next separate physical contact gets its own id.
    await h.stroke([{ x: a.x, y: a.y + 160 }, { x: a.x + 80, y: a.y + 180 }, { x: a.x + 160, y: a.y + 160 }]);
    await h.page.waitForTimeout(5500);
    const afterNext = await saved(h, name, 'after-next'), paintedNext = await shapePaint(h);
    const freshBefore = await zoom(h), fresh = await h.point(.6, .6);
    await h.touch('touchStart', contacts(fresh, 60));
    for (let i = 1; i <= 8; i++) await h.touch('touchMove', contacts(fresh, 60 + 60 * i / 8));
    await h.touch('touchEnd', []); await frames(h.page, 8);
    const freshAfter = await zoom(h), laterReceipts = await h.page.evaluate(() => window.__w12Later);
    const events = await h.page.evaluate(() => window.__wa.events);
    assert(events.some(e => e.trusted && e.kind === 'pen' && e.type === 'pointerdown'), 'W12-HARNESS: trusted pen absent');
    assert(events.some(e => e.trusted && e.type === 'touchstart' && e.touches.length === 2), 'W12-HARNESS: two trusted contacts absent');
    const pinchIds = paintedPinch.filter(s => s.type === 'draw').map(s => s.id);
    const registrationsAfter = await windowTouchState(h.page);
    const failures = [];
    if (registrationsBeforePen.appActive.some(e => e.capture)) failures.push('earlier-window-capture-touch-listener');
    if (registrationsArmed.appActive.filter(e => e.capture && e.passive === false).length !== 4) failures.push('window-touch-arming-control');
    if (registrationsAfter.appActive.some(e => e.passive === false)) failures.push('window-touch-cleanup');
    if (duringZoom !== beforeZoom || penUpZoom !== beforeZoom) failures.push('pen-pinch-zoom');
    if (hash(referenceBefore) !== hash(referenceDuring)) failures.push('reference-pixels-during-pen');
    if (heldTouchZoom !== beforeZoom || hash(referenceBefore) !== hash(referenceAfter)
      || blockedReceipts.length > laterAtPenUp) failures.push('held-touch-after-pen-up');
    if (afterPinch.strokes.length !== 2 || afterPinch.strokes.some(s => !s.props.isComplete)) failures.push('pen-stroke-complete');
    if (afterNext.strokes.length !== 3 || afterNext.strokes.some(s => !s.props.isComplete)
      || !paintedNext.some(s => s.type === 'draw' && !pinchIds.includes(s.id))) failures.push('separate-next-contact');
    if (freshAfter / freshBefore < 1.7 || freshAfter / freshBefore > 2.3) failures.push('fresh-pinch-control');
    if (blockedReceipts.length || laterReceipts.length <= blockedReceipts.length) failures.push('capture-order-control');
    return { passed: failures.length === 0, failures, witness: { host, order, beforeZoom, duringZoom, penUpZoom, heldTouchZoom,
      persistedPinchStrokes: afterPinch.strokes.length, persistedNextStrokes: afterNext.strokes.length,
      allPinchStrokesComplete: afterPinch.strokes.every(s => s.props.isComplete),
      freshPinchRatio: freshAfter / freshBefore, laterListenerBlockedReceipts: blockedReceipts.length,
      leakedReceiptsAfterPenUp: blockedReceipts.length - laterAtPenUp,
      laterListenerFreshReceipts: laterReceipts.length - blockedReceipts.length },
      baseline, afterPinch, afterNext, paintedPinch, paintedNext, blockedReceipts,
      windowTouchRegistrations: { beforePen: registrationsBeforePen, armed: registrationsArmed,
        after: registrationsAfter },
      writesAfterMarker: (await h.writes(name)).filter(w => w.id > marker), capture: await h.capture('after-control'),
      loss: 'Trusted CDP logical contacts are not a physical pen display, palm rejection or pen-to-photon measurement. Cancel has a separate trusted-route search.' };
  }, { hasTouch: true, init: observeWindowTouchListeners });
  results.push(result);
}
const expected = process.env.EXPECT_FAILURE;
if (expected) {
  assert(results.every(r => r.failures.includes(expected)), `Mutant was not rejected by its named guard ${expected}`);
  console.log(`MUTANT REJECTED by ${expected} on ${results.length} arms`);
} else {
  assert(results.every(r => r.passed), JSON.stringify(results.map(r => ({ arm: r.arm, failures: r.failures })), null, 2));
  console.log(`PASS W-12 pen priority: ${results.length} arms`);
}
