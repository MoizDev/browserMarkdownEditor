import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { pin, pinnedChrome } from './paths.mjs';

/** A fresh context, never the user's profile. The browser comes from `pinnedChromePath()`
 * (`BME_CHROME_PATH`, else the installer's cache); a missing one fails naming the installer.
 * @param {{executablePath?: string, contextOptions?: import('playwright').BrowserContextOptions,
 *   launchOptions?: import('playwright').LaunchOptions, debuggingPort?: number}} options
 */
export async function openBrowser({ executablePath, contextOptions = {}, launchOptions = {}, debuggingPort } = {}) {
    const require = createRequire(import.meta.url);
    const driverVersion = require('playwright/package.json').version;
    if (`playwright@${driverVersion}` !== pin.driver) throw new Error(`Unpinned Playwright: ${driverVersion}; expected ${pin.driver}`);
    executablePath ??= await pinnedChrome();
    const { chromium } = await import('playwright');
    const args = [...(launchOptions.args ?? [])];
    if (debuggingPort !== undefined) {
        if (!Number.isInteger(debuggingPort) || debuggingPort < 1024 || debuggingPort > 65535) throw new Error('Pass a debuggingPort from your own assigned range');
        if (args.some(arg => /^--remote-debugging-(?:port|address)/.test(arg) || /^--remote-allow-origins=.*\*/.test(arg))) throw new Error('Conflicting or wildcard debugging arguments are forbidden');
        // An occupied port could belong to the user's browser. Never discover or
        // attach to it accidentally; this is our fresh, privately launched browser.
        const probe = createServer();
        await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(debuggingPort, '127.0.0.1', resolve); });
        await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
        args.push(`--remote-debugging-port=${debuggingPort}`, '--remote-debugging-address=127.0.0.1');
    }
    const browser = await chromium.launch({ ...launchOptions, args, headless: true, executablePath });
    try {
        const version = browser.version();
        if (version !== pin.version) throw new Error(`Unpinned Chrome: ${version}; expected ${pin.version}`);
        // Do not block service workers via Playwright: its injected blocker throws in opaque frames.
        const context = await browser.newContext(contextOptions);
        return { browser, context, identity: { version, executablePath, driverVersion, freshContext: true,
            ...(debuggingPort === undefined ? {} : { debuggingPort, debuggingAddress: '127.0.0.1' }) },
            async close() { await browser.close(); } };
    } catch (error) {
        await browser.close();
        throw error;
    }
}
