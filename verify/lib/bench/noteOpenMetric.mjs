import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const browserPin = JSON.parse(await readFile(new URL('../../browser-pin.json', import.meta.url), 'utf8'));

export const noteSentinel = 'Benchmark sentinel cedar seven forty two';
export const noteFixtureText = `# ${noteSentinel}\n\nNon-default browser benchmark fixture.\n`;

// These two functions ARE the metric definition: prep never dispatches the
// measured gesture, and the page receives a real mouse pointerdown afterwards.
// Hashing only this implementation + fixture keeps floor commits from changing
// their own definition key; a logic/fixture change necessarily makes a new key.
export function installNoteObservation({ sentinel }) {
    const data = { rafTimes: [], longTasks: [], hookEvents: [], start: null, end: null, hooked: false };
    window.__benchObservation = data;
    new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(x => ({ startTime: x.startTime, duration: x.duration }))))
        .observe({ type: 'longtask', buffered: true });
    document.addEventListener('pointerdown', event => {
        const row = event.target.closest('.tree-item');
        if (!/^first-note(?:\.md)?$/.test(row?.querySelector('.tree-item-label')?.textContent.trim() ?? '') || data.start !== null) return;
        // Old input delivery split into1.2ms vs14–24ms Playwright RAF pairs.
        // Start at received input instead, not at a driver call or a prior click.
        data.start = event.timeStamp; data.receivedAt = performance.now();
        performance.mark('bme-note-open-start', { startTime: data.start });
        const frame = time => {
            data.rafTimes.push(time);
            const node = document.querySelector('.cm-content');
            const box = node?.getBoundingClientRect();
            if (node?.textContent.includes(sentinel) && box?.width > 0 && box?.height > 0 && getComputedStyle(node).visibility !== 'hidden') {
                requestAnimationFrame(() => {
                    data.end = performance.now(); performance.mark('bme-first-note-paint');
                    performance.measure('bme-note-open-to-paint', 'bme-note-open-start', 'bme-first-note-paint');
                });
            } else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }, true);
}
export async function prepareNoteOpen(page) {
    await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
    const row = page.locator('.tree-item').filter({ has: page.locator('.tree-item-label', { hasText: /^first-note(?:\.md)?$/ }) });
    await row.click({ trial: true });
    const box = await row.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) throw new Error('Prepared note row is not visible');
    if (await page.evaluate(() => window.__benchObservation.start !== null)) throw new Error('Trial preparation unexpectedly delivered the measured input');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
export async function dispatchNoteOpen(page, point) {
    await page.mouse.click(point.x, point.y);
}
export function noteOpenLatency(observation) {
    return observation.end - observation.start;
}
const implementation = { fixture: noteFixtureText, observation: installNoteObservation.toString(),
    prepare: prepareNoteOpen.toString(), dispatch: dispatchNoteOpen.toString(), readout: noteOpenLatency.toString(),
    browser: { version: browserPin.version, driver: browserPin.driver } };
export function noteDefinition(temperature = 'cold') {
    if (!['cold', 'warm'].includes(temperature)) throw new Error('Explicit cold/warm definition required');
    return Object.freeze({ id: 'noteOpenToPaintMs', version: 1, unit: 'ms', temperature,
        setup: 'Open vault, resolve row, wait for actionability/stability and obtain coordinates BEFORE timing.',
        start: 'Trusted note-row pointerdown.timeStamp as received by the page.',
        end: 'Existing visible-sentinel DOM + next-RAF paint proxy, backed by screenshot and trace.',
        loss: 'Not photon latency; excludes vault acquisition and driver actionability waits.',
        hash: createHash('sha256').update(JSON.stringify({ implementation, temperature })).digest('hex') });
}
export const noteOpenDefinition = noteDefinition();
