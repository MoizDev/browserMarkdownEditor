import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const pin = JSON.parse(await readFile(new URL('../browser-pin.json', import.meta.url), 'utf8'));
const defaultExecutable = join('/Users/adham/Developer/bme-impl/scratch/browsers', pin.version, pin.executable);

/** A fresh context, never the user's profile. The caller holds a bme-lock run grant.
 * @param {{executablePath?: string, contextOptions?: import('playwright').BrowserContextOptions,
 *   launchOptions?: import('playwright').LaunchOptions}} options
 */
export async function openBrowser({ executablePath = process.env.BME_CHROME_PATH ?? defaultExecutable,
    contextOptions = {}, launchOptions = {} } = {}) {
    const require = createRequire(import.meta.url);
    const driverVersion = require('playwright/package.json').version;
    if (`playwright@${driverVersion}` !== pin.driver) throw new Error(`Unpinned Playwright: ${driverVersion}; expected ${pin.driver}`);
    await access(executablePath);
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ ...launchOptions, headless: true, executablePath });
    try {
        const version = browser.version();
        if (version !== pin.version) throw new Error(`Unpinned Chrome: ${version}; expected ${pin.version}`);
        // Do not block service workers via Playwright: its injected blocker throws in opaque frames.
        const context = await browser.newContext(contextOptions);
        return { browser, context, identity: { version, executablePath, driverVersion, freshContext: true },
            async close() { await browser.close(); } };
    } catch (error) {
        await browser.close();
        throw error;
    }
}
