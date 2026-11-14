import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fastGuard, generatedVault, documentFixtures, openDocument, saveNote } from '../lib/fast.mjs';

// 4 s idle-prefetch timeout + 2 s index cap + 1 s margin. A functional
// observation interval shared with the visible-PDF control, NOT a timing gate.
const prefetchWait = 7000;
await fastGuard('X-LAZY', async ({ session }) => {
    const base = await generatedVault(), documents = await documentFixtures();
    for (const [label, extra, positive] of [
        ['markdown', {}, false], ['garbage-pdf', { '.Garbage/hidden.pdf': documents['sample.pdf'] }, false],
        ['visible-pdf', { 'sample.pdf': documents['sample.pdf'] }, true],
    ]) {
        await session({ label, files: { ...base, ...extra } }, async ({ page, app, check, meta, vaultName, report, traffic }) => {
            const manifest = JSON.parse(await readFile(join(app.distDir, '.vite/manifest.json'), 'utf8'));
            const closure = roots => {
                const files = new Set(), seen = new Set();
                const visit = key => {
                    if (seen.has(key)) return;
                    seen.add(key);
                    const entry = manifest[key];
                    if (!entry) throw new Error(`Missing build-manifest entry: ${key}`);
                    files.add(entry.file);
                    for (const asset of [...(entry.assets ?? []), ...(entry.css ?? [])]) files.add(asset);
                    for (const dependency of entry.imports ?? []) visit(dependency);
                };
                roots.forEach(visit);
                return files;
            };
            const initial = closure(Object.keys(manifest).filter(key => manifest[key].isEntry));
            const roots = Object.keys(manifest).filter(key => /^src\/(?:components\/(?:PdfPane|DrawingPane|NotebookPane|PdfAnnotateCanvas|EpubPane)\.|utils\/pdfWorker\.|platform\/render\/)/.test(key));
            await check('PDF and canvas entries identified by source in manifest', true,
                ['PdfPane', 'DrawingPane', 'NotebookPane'].every(name => roots.some(key => key.includes(`/${name}.`))));
            const heavy = [...closure(roots)].filter(file => !initial.has(file));
            const pdf = [...closure(roots.filter(key => /\/(?:PdfPane|pdfWorker)\./.test(key)))].filter(file => !initial.has(file));
            const wasm = app.identity.files.filter(file => /\.wasm$/.test(file.path)).map(file => file.path);
            meta.manifestClassification = { roots, initial: [...initial], heavy, pdf, wasm, prefetchWaitMs: prefetchWait };
            await openDocument(page, 'Welcome.md');
            await saveNote(page, vaultName, 'Welcome.md', '# Welcome\n\nBME-VAULT-v1 edited.\n', report);
            await page.getByRole('button', { name: 'Search', exact: true }).click();
            await page.getByRole('textbox', { name: 'Search vault', exact: true }).fill('BME-VAULT-v1');
            await page.locator('.search-file-group').first().waitFor();
            await page.getByRole('button', { name: 'Neural Brain — graph view', exact: true }).click();
            await page.locator('.graph-view canvas').waitFor();
            await page.waitForTimeout(prefetchWait);
            const requested = new Set((await traffic.read()).filter(row => row.origin === new URL(app.url).origin).map(row => new URL(row.url).pathname.slice(1)));
            const fetched = heavy.filter(file => requested.has(file));
            meta.heavyFetched = fetched;
            await check('hidden Garbage PDF absent from visible tree', 0, await page.locator('.tree-item[data-path*=".Garbage"]').count());
            if (positive) await check('visible PDF positive control fetched PDF entry within same wait', true, pdf.some(file => requested.has(file)));
            else {
                await check('Markdown-only fetched no heavy chunks', [], fetched);
                await check('Markdown-only fetched no emitted wasm', [], wasm.filter(file => requested.has(file)));
            }
        });
    }
});
