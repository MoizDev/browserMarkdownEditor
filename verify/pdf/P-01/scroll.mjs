// Functional real-app reproduction/sanity, not a timed coverage benchmark.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { openBrowser } from '../../lib/browser.mjs';
import { serveApp } from '../../lib/serve.mjs';
import { installVault, seedVault } from '../../lib/vault.mjs';
import { argumentsOf, portNumber } from './common.mjs';

const options = argumentsOf(process.argv.slice(2), ['prepared', 'fixture', 'out', 'port', 'mode'], ['prepared', 'fixture', 'out', 'mode']);
if (!['reproduce', 'candidate'].includes(options.mode)) throw new Error('Mode is reproduce or candidate');
const prepared = JSON.parse(await readFile(resolve(options.prepared))), fixture = await readFile(resolve(options.fixture));
const out = resolve(options.out); await mkdir(out, { recursive: true });
const result = { mode: options.mode, cpuThrottlingRate: 4, source: prepared.identity.commit, fixtureSha256: createHash('sha256').update(fixture).digest('hex'), cases: [],
    loss: 'Functional rAF geometry: exposed unpainted canvas area, not screencast-truth timing/blank-rate acceptance. Synthetic wheel, one generated dense40 document.' };
let server, opened;
async function settle(page) {
    await page.waitForFunction(() => {
        const scroll = document.querySelector('.pdf-viewer-scroll');
        if (!scroll) return false;
        const v = scroll.getBoundingClientRect(), preference = document.querySelector('.editor-slot-header [aria-label="Word emphasis"]')?.getAttribute('aria-pressed');
        let visible = 0;
        for (const box of document.querySelectorAll('.pdf-viewer-page')) {
            const b = box.getBoundingClientRect();
            if (Math.min(b.bottom, v.bottom) <= Math.max(b.top, v.top) || Math.min(b.right, v.right) <= Math.max(b.left, v.left)) continue;
            visible++;
            const canvas = box.querySelector('canvas'), c = canvas.getBoundingClientRect();
            if (!canvas.width || canvas.dataset.nativeEmphasis !== preference || Math.abs(canvas.width / c.width - Math.min(devicePixelRatio, 2)) > 0.03 ||
                c.top > Math.max(b.top, v.top) + 0.5 || c.bottom < Math.min(b.bottom, v.bottom) - 0.5 ||
                c.left > Math.max(b.left, v.left) + 0.5 || c.right < Math.min(b.right, v.right) - 0.5) return false;
        }
        return visible > 0;
    }, null, { timeout: 30000 });
}
try {
    server = await serveApp({ root: prepared.root, scratch: prepared.scratch, port: portNumber(options.port), mode: prepared.mode, build: false });
    opened = await openBrowser({ contextOptions: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'dark' } });
    result.browser = opened.identity;
    for (const theme of options.mode === 'reproduce' ? ['dark'] : ['dark', 'light']) {
        const context = theme === 'dark' ? opened.context : await opened.browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' });
        const row = { theme, screenshots: [] }; result.cases.push(row);
        try {
            await installVault(context, { name: 'P01-scroll' });
            await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//u, route => route.abort());
            await context.addInitScript(() => {
                window.__p01 = { active: false, frames: [] };
                const frame = () => {
                    const state = window.__p01, scroll = document.querySelector('.pdf-viewer-scroll');
                    if (state.active && scroll) {
                        const v = scroll.getBoundingClientRect(); let area = 0, missing = 0;
                        const visiblePages = [];
                        document.querySelectorAll('.pdf-viewer-page').forEach((box, index) => {
                            const b = box.getBoundingClientRect(), left = Math.max(b.left, v.left), right = Math.min(b.right, v.right), top = Math.max(b.top, v.top), bottom = Math.min(b.bottom, v.bottom);
                            if (right <= left || bottom <= top) return;
                            const need = (right - left) * (bottom - top), canvas = box.querySelector('canvas'), c = canvas.getBoundingClientRect();
                            const painted = canvas.width > 0 && canvas.height > 0 && canvas.dataset.nativeEmphasis !== undefined;
                            const covered = painted ? Math.max(0, Math.min(right, c.right) - Math.max(left, c.left)) * Math.max(0, Math.min(bottom, c.bottom) - Math.max(top, c.top)) : 0;
                            area += need; missing += Math.max(0, need - covered); visiblePages.push(index + 1);
                        });
                        state.frames.push({ scrollTop: scroll.scrollTop, area, missing, visiblePages });
                    }
                    requestAnimationFrame(frame);
                };
                requestAnimationFrame(frame);
            });
            const page = await context.newPage();
            await page.goto(server.url);
            await seedVault(page, { name: 'P01-scroll', files: { 'dense.pdf': fixture, 'note.md': '# A quiet note\n' } });
            await page.getByRole('button', { name: 'Open Vault', exact: true }).click();
            if (theme === 'light') await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click();
            await page.locator('.tree-item').filter({ hasText: 'dense.pdf' }).first().click();
            for (let n = 0; n < 3; n++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
            await page.getByLabel('Page number', { exact: true }).fill('16');
            await page.keyboard.press('Enter');
            await settle(page);
            const scroll = page.locator('.pdf-viewer-scroll'), bounds = await scroll.boundingBox();
            await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
            row.start = await scroll.evaluate(el => el.scrollTop);
            const cdp = await context.newCDPSession(page);
            await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
            await page.evaluate(() => { window.__p01.active = true; });
            const shots = [];
            for (let n = 0; n < 320; n++) {
                if (n === 40) {
                    await page.locator('.editor-slot-header').getByRole('button', { name: 'Word emphasis', exact: true }).click();
                    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
                }
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, deltaX: 0, deltaY: 25 });
                await new Promise(resolve => setTimeout(resolve, 16)); // Input cadence, not a readiness wait.
                if (n === 160) {
                    const path = join(out, `${theme}-moving.png`); row.screenshots.push(path);
                    shots.push(page.screenshot({ path })); // Do not pause the wheel stream for a screenshot.
                }
            }
            row.frames = await page.evaluate(() => { window.__p01.active = false; return window.__p01.frames; });
            await Promise.all(shots);
            row.distance = (await scroll.evaluate(el => el.scrollTop)) - row.start;
            row.holeFrames = row.frames.filter(frame => frame.missing > 0.5).length;
            row.maxMissingFraction = Math.max(...row.frames.map(frame => frame.area ? frame.missing / frame.area : 1));
            row.pages = [...new Set(row.frames.flatMap(frame => frame.visiblePages))];
            if (row.distance < 7900 || row.pages.length < 4 || row.frames.some(frame => frame.area <= 0)) throw new Error('Scroll witness did not traverse positive page area and three page boundaries');
            if (options.mode === 'candidate') {
                await settle(page);
                for (let n = 0; n < 4; n++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
                await settle(page);
                let path = join(out, `${theme}-zoom.png`); row.screenshots.push(path); await page.screenshot({ path });
                for (const dpr of [1, 2]) {
                    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: dpr, mobile: false });
                    await settle(page);
                    row[`density${dpr}`] = await page.evaluate(() => ({ dpr: devicePixelRatio, width: document.querySelector('.pdf-viewer-scroll').clientWidth }));
                    path = join(out, `${theme}-dpr${dpr}.png`); row.screenshots.push(path); await page.screenshot({ path });
                }
                if (row.holeFrames) throw new Error(`Steady scroll exposed blank page area in ${row.holeFrames} frames`);
            } else if (!row.holeFrames) throw new Error('Unfixed run did not reproduce exposed blank page area');
            await cdp.detach();
            row.goalMet = true;
        } catch (error) { row.error = { name: error.name, message: error.message }; }
        finally { await context.close(); }
    }
} catch (error) { result.error = { name: error.name, message: error.message }; }
finally {
    await opened?.close(); await server?.stop();
    result.goalMet = !result.error && result.cases.length > 0 && result.cases.every(row => row.goalMet);
    await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
console.log(JSON.stringify({ goalMet: result.goalMet, cases: result.cases.map(({ theme, holeFrames, maxMissingFraction, distance, error }) => ({ theme, holeFrames, maxMissingFraction, distance, error })) }));
if (!result.goalMet) process.exitCode = 1;
