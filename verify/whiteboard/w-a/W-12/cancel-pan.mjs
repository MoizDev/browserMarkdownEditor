import assert from 'node:assert/strict';
import { runArm, frames } from '../lib/browser.mjs';
import { setup, hosts } from '../lib/files.mjs';

async function zoom(h) {
  const label = await h.page.getByRole('button', { name: /^Zoom —/ }).getAttribute('aria-label');
  const n = Number(label?.match(/([\d.]+)%/)?.[1]); assert(n > 0); return n;
}
async function pinch(h) {
  const c = await h.point(.6, .6), points = d => [{ x: c.x - d / 2, y: c.y }, { x: c.x + d / 2, y: c.y }];
  const before = await zoom(h);
  await h.touch('touchStart', points(60)); await h.touch('touchMove', points(120));
  await h.touch('touchEnd', []); await frames(h.page, 8);
  return { before, after: await zoom(h), ratio: await zoom(h) / before };
}
const results = [];
for (const host of hosts) results.push(await runArm('W-12-cancel-pan', `${host}-native-pan`, async h => {
  await setup(h, host); const control = await pinch(h);
  assert(control.ratio > 1.5, 'PAN-CANCEL-HARNESS: fresh pinch control failed');
  await h.canvas().focus(); await h.chord('d');
  const a = await h.point(.35, .35);
  const ancestors = await h.page.evaluate(a => {
    const result = []; let el = document.elementFromPoint(a.x, a.y);
    while (el) {
      const css = getComputedStyle(el);
      result.push({ tag: el.tagName, class: el.getAttribute('class'), touchAction: css.touchAction, overflow: css.overflow });
      el = el.parentElement;
    }
    return result;
  }, a);
  const mark = await h.page.evaluate(() => window.__wa.events.length);
  await h.pointer('mouseMoved', a, { buttons: 0 }); await h.pointer('mousePressed', a);
  for (const dy of [10, 40, 100, 180, 240]) {
    await h.pointer('mouseMoved', { x: a.x, y: a.y + dy }); await h.page.waitForTimeout(35);
  }
  await h.page.waitForTimeout(200);
  const route = await h.page.evaluate(mark => window.__wa.events.slice(mark), mark);
  const cancelled = route.some(e => e.trusted && e.kind === 'pen' && e.type === 'pointercancel');
  if (!cancelled) {
    await h.pointer('mouseReleased', { x: a.x, y: a.y + 240 });
    return { status: 'NOT COVERED', witness: { trustedPenCancel: false }, control, ancestors, route,
      capture: await h.capture('native-pan-no-cancel'),
      reason: 'Real pen input on the unchanged canvas emitted no trusted pen cancel; no touch-action or scroll geometry was invented.',
      loss: 'The real host has touch-action restrictions; CDP pen input on pinned Chrome does not supply a native pan takeover cancellation proof.' };
  }
  const fresh = await pinch(h), events = await h.page.evaluate(mark => window.__wa.events.slice(mark), mark);
  const at = events.findIndex(e => e.trusted && e.kind === 'pen' && e.type === 'pointercancel');
  const penUp = events.slice(at + 1).some(e => e.kind === 'pen' && e.type === 'pointerup');
  return { status: penUp ? 'NOT COVERED' : 'trusted-route-observed', passed: !penUp && fresh.ratio > 1.5,
    failures: !penUp && fresh.ratio <= 1.5 ? ['cancel-release'] : [],
    witness: { trustedPenCancel: true, interveningPenUp: penUp, freshPinchRatio: fresh.ratio },
    control, fresh, ancestors, route: events, capture: await h.capture('native-pan-after-cancel'),
    loss: 'Browser pan takeover is not physical pen-display or palm hardware evidence.' };
}, { hasTouch: true }));
const covered = results.filter(r => r.status === 'trusted-route-observed');
if (process.env.EXPECT_FAILURE) {
  assert(covered.length, 'NO MUTANT PROOF: no trusted native-pan pen-cancel route');
  assert(covered.every(r => r.failures.includes(process.env.EXPECT_FAILURE)), 'Named cancel-release guard did not reject mutant');
} else if (covered.length) assert(covered.every(r => r.passed), 'cancel-release failed');
else console.log('NOT COVERED: unchanged real-host native-pan input emitted no trusted pen cancel');
