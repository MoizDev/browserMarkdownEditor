import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fastGuard, fastRoot, documentFixtures, openDocument } from '../lib/fast.mjs';

await fastGuard('X-ORIGIN', async ({ session, report }) => {
    const documents = await documentFixtures();
    const html = await readFile(join(fastRoot, 'index.html'), 'utf8');
    const declared = [...new Set([...html.matchAll(/https:\/\/[^\s"'<>]+/g)].map(match => new URL(match[0]).origin))].sort();
    let baseline;
    await session({ label: 'markdown-origin', files: { 'Welcome.md': documents['Welcome.md'] } }, async ({ page, app, check, traffic, meta }) => {
        await openDocument(page, 'Welcome.md');
        await page.evaluate(() => document.fonts.ready);
        baseline = [...new Set((await traffic.read()).filter(row => /^https?:/.test(row.url) && row.origin !== new URL(app.url).origin).map(row => row.origin))].sort();
        meta.declaredFontOrigins = declared;
        await check('Markdown baseline uses only index.html origins', [], baseline.filter(origin => !declared.includes(origin)));
    });
    report.data.markdownBaseline = baseline;
    for (const path of Object.keys(documents)) {
        await session({ label: `origin-${path.replaceAll('.', '-')}`, files: documents }, async ({ page, app, check, traffic, meta }) => {
            await openDocument(page, path);
            await page.evaluate(() => document.fonts.ready);
            // Let idle document-kind prefetch finish too; a late CDN dependency
            // is still a new outward request, even when opening already worked.
            await page.waitForTimeout(5000);
            const foreign = (await traffic.read()).filter(row => /^https?:/.test(row.url) && row.origin !== new URL(app.url).origin);
            meta.foreignRequests = foreign;
            await check(`${path} adds no foreign origin`, [], [...new Set(foreign.map(row => row.origin))].filter(origin => !baseline.includes(origin)));
        });
    }
});
