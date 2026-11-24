/** Fresh named OPFS roots only. Changing __bmePickVault changes the native picker stand-in, not
 * app state; the run must still click the real Open Vault / switch-vault controls. */
export async function installVault(context, { name }) {
    await context.addInitScript(({ name }) => {
        const grant = handle => {
            handle.queryPermission = async () => 'granted';
            handle.requestPermission = async () => 'granted';
            return handle;
        };
        const original = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (...args) {
            return grant(await original.apply(this, args));
        };
        window.__bmePickVault = name;
        window.showDirectoryPicker = async () => grant(await (await navigator.storage.getDirectory()).getDirectoryHandle(window.__bmePickVault, { create: true }));
    }, { name });
}

export async function seedVault(page, { name, files }) {
    await page.evaluate(async ({ name, files }) => {
        const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name, { create: true });
        for (const [path, text] of Object.entries(files)) {
            const parts = path.split('/');
            let directory = root;
            for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, { create: true });
            const handle = await directory.getFileHandle(parts.at(-1), { create: true });
            const writer = await handle.createWritable();
            await writer.write(text);
            await writer.close();
        }
    }, { name, files });
}

/** Fresh native read each attempt; only Chrome's transient NotReadableError is retryable. */
export async function readWitness(page, { name, path, attempts = 20, record = () => {} }) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const result = await page.evaluate(async ({ name, path }) => {
            try {
                const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(name);
                const parts = path.split('/');
                let directory = root;
                for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part);
                const handle = await directory.getFileHandle(parts.at(-1));
                return { ok: true, text: await (await handle.getFile()).text() };
            } catch (error) { return { ok: false, name: error.name, message: error.message }; }
        }, { name, path });
        if (result.ok) return result.text;
        if (result.name !== 'NotReadableError' || attempt === attempts) {
            const error = new Error(`HarnessFault: ${result.name}: ${result.message}`);
            error.name = result.name;
            throw error;
        }
        record({ type: 'native-read-retry', attempt, name, path });
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}

/** Async predicates are awaited by page.evaluate, never handed to waitForFunction. */
export async function waitForVault(page, condition, { arg, timeoutMs = 10000, intervalMs = 50, record = () => {} } = {}) {
    const end = Date.now() + timeoutMs;
    let polls = 0;
    let value;
    while (Date.now() < end) {
        value = await page.evaluate(condition, arg);
        polls++;
        if (value === true) { record({ type: 'vault-condition', polls, value }); return; }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error(`HarnessFault: vault condition timed out after ${polls} awaited reads; last=${JSON.stringify(value)}`);
}
