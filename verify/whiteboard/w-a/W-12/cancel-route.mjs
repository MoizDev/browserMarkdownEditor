import assert from 'node:assert/strict';
import { runArm, frames } from '../lib/browser.mjs';
import { setup, hosts } from '../lib/files.mjs';

async function zoom(h) {
  const label = await h.page.getByRole('button', { name: /^Zoom —/ }).getAttribute('aria-label');
  const n = Number(label?.match(/([\d.]+)%/)?.[1]); assert(n > 0); return n;
}
async function pinch(h) {
  const c = await h.point(.65, .65), pair = d => [{ x: c.x - d / 2, y: c.y }, { x: c.x + d / 2, y: c.y }];
  const before = await zoom(h);
  await h.touch('touchStart', pair(60)); await h.touch('touchMove', pair(120));
  await h.touch('touchEnd', []); await frames(h.page, 8);
  return { before, after: await zoom(h), ratio: await zoom(h) / before };
}
const results = [];
for (const host of hosts) for (const fraction of (process.env.FRACTIONS ?? '.25,.5,.75').split(',').map(Number)) {
  results.push(await runArm('W-12-cancel', `${host}-native-selected-text-${fraction}`, async h => {
    await setup(h, host);
    const control = await pinch(h);
    assert(control.ratio > 1.5, 'CANCEL-HARNESS: initial no-pen pinch control failed');
    const point = await h.point(.2, .3), text = 'Original selected text for a native pen drag';
    await h.canvas().focus(); await h.chord('t'); await h.page.mouse.click(point.x, point.y);
    const input = h.canvas().locator('[contenteditable="true"]:visible').first();
    await input.waitFor(); await h.page.keyboard.insertText(text); await h.chord('Mod+a');
    const selection = await h.page.evaluate(() => {
      const s = getSelection(), rects = s?.rangeCount ? [...s.getRangeAt(0).getClientRects()] : [];
      const r = rects.find(r => r.width > 0 && r.height > 0 && r.x < innerWidth && r.y < innerHeight && r.right > 0 && r.bottom > 0);
      return { text: s?.toString(), rect: r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null };
    });
    assert(selection.text?.includes(text) && selection.rect?.width > 0, 'CANCEL-HARNESS: real native text selection absent');
    await h.capture('selected-text-before-pen');
    const r = selection.rect, viewport = await h.canvas().boundingBox();
    const left = Math.max(r.x, viewport.x + 16), right = Math.min(r.x + r.width, viewport.x + viewport.width - 16);
    assert(right - left > 10, 'CANCEL-HARNESS: selected text has no visible drag origin');
    const a = { x: left + (right - left) * fraction, y: r.y + r.height / 2 };
    assert(await h.page.evaluate(p => !!document.elementFromPoint(p.x, p.y)?.closest('[data-legacy-board]'), a),
      'CANCEL-HARNESS: pen-down must actually start inside the legacy pane');
    const dragEvents = [];
    h.cdp.on('Input.dragIntercepted', event => dragEvents.push(event));
    await h.cdp.send('Input.setInterceptDrags', { enabled: true });
    const eventMark = await h.page.evaluate(() => window.__wa.events.length);
    await h.pointer('mouseMoved', a, { buttons: 0 }); await h.pointer('mousePressed', a);
    await h.page.waitForTimeout(180);
    for (const distance of [5, 15, 35, 80]) {
      await h.pointer('mouseMoved', { x: a.x + distance, y: a.y + 20 }); await h.page.waitForTimeout(30);
    }
    await h.page.waitForTimeout(250);
    const events = await h.page.evaluate(mark => window.__wa.events.slice(mark), eventMark);
    const cancelled = events.find(e => e.type === 'pointercancel' && e.kind === 'pen' && e.trusted);
    const browserState = await input.evaluate(el => ({ touchAction: getComputedStyle(el).touchAction,
      draggable: el.draggable, selection: getSelection()?.toString(), element: el.tagName }));
    if (!cancelled) {
      await h.pointer('mouseReleased', { x: a.x + 80, y: a.y + 20 });
      await h.cdp.send('Input.setInterceptDrags', { enabled: false });
      return { status: 'NOT COVERED', route: 'actual board native selected-text drag',
        reason: 'No trusted pointercancel with pointerType pen was emitted; no synthetic cancel substituted.',
        witness: { trustedPenCancel: false, nativeDrags: dragEvents.length },
        control, selection, browserState, dragEvents, routeEvents: events, capture: await h.capture('no-trusted-cancel'),
        loss: 'This route on pinned headless Chrome does not provide the pen-cancel release proof or its up-only mutant.' };
    }
    if (dragEvents.length) {
      await h.cdp.send('Input.dispatchDragEvent', { type: 'dragCancel', x: a.x + 80, y: a.y + 20, data: dragEvents.at(-1).data });
    }
    await h.cdp.send('Input.setInterceptDrags', { enabled: false });
    await h.chord('Escape'); await h.chord('Escape');
    const afterCancel = await pinch(h);
    const later = await h.page.evaluate(mark => window.__wa.events.slice(mark), eventMark);
    const cancelIndex = later.findIndex(e => e.type === 'pointercancel' && e.kind === 'pen' && e.trusted);
    const interveningPenUp = later.slice(cancelIndex + 1).some(e => e.type === 'pointerup' && e.kind === 'pen');
    return { status: interveningPenUp ? 'NOT COVERED' : 'trusted-route-observed',
      passed: !interveningPenUp && afterCancel.ratio > 1.5,
      failures: !interveningPenUp && afterCancel.ratio <= 1.5 ? ['cancel-release'] : [],
      witness: { trustedPenCancel: true, interveningPenUp, nativeDrags: dragEvents.length, freshPinchRatio: afterCancel.ratio },
      control, selection, browserState, dragEvents, routeEvents: later, afterCancel,
      capture: await h.capture('after-trusted-cancel'),
      loss: 'Native selected-text drag supplies browser pen cancellation, not an inking/palm hardware proof. A subsequent pen-up would invalidate the release-only-by-cancel witness.' };
  }, { hasTouch: true }));
}
const covered = results.filter(r => r.status === 'trusted-route-observed');
const expected = process.env.EXPECT_FAILURE;
if (expected) {
  assert(covered.length, 'NO MUTANT PROOF: no trusted pen-cancel route');
  assert(covered.every(r => r.failures.includes(expected)), `Mutant not rejected by ${expected}`);
  console.log(`MUTANT REJECTED by ${expected} on ${covered.length} trusted cancel routes`);
} else if (covered.length) {
  assert(covered.every(r => r.passed), 'cancel-release failed on a trusted route');
  console.log(`PASS cancel-release: ${covered.length} trusted routes`);
} else console.log('NOT COVERED: no qualifying trusted pen-cancel route; no up-only mutant proof claimed');
