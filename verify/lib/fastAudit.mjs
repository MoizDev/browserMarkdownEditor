import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceMap } from 'node:module';

/** Native invocation ledger. Reports are copied BEFORE the first await; a late
 * report can resolve a trash destination but cannot authorize earlier I/O. */
export async function installFastAudit(context, vaultName) {
    await context.addInitScript(({ vaultName }) => {
        if (window !== window.top || typeof FileSystemDirectoryHandle !== 'function') return;
        const audit = window.__bmeFastAudit = { enabled: true, calls: [] };
        const getDir = FileSystemDirectoryHandle.prototype.getDirectoryHandle;
        const root = async () => getDir.call(await navigator.storage.getDirectory(), vaultName);
        const capture = (op, handle, name) => {
            if (!audit.enabled) return null;
            const call = { op, t: performance.now(), stack: new Error().stack,
                reports: structuredClone(window.__perf?.vault?.reports() ?? []) };
            audit.calls.push(call);
            call.resolved = (async () => {
                const parts = await (await root()).resolve(handle);
                if (!parts) throw new Error('Audited I/O escaped the fixture vault');
                call.path = [...parts, ...(name === undefined ? [] : [name])].join('/');
            })().catch(error => { call.fault = error.message; });
            return call;
        };
        FileSystemDirectoryHandle.prototype.getDirectoryHandle = async function (name, options) {
            const call = options?.create ? capture('directory', this, name) : null;
            try { const result = await getDir.call(this, name, options); if (call) call.ok = true; return result; }
            catch (error) { if (call) call.error = error.name; throw error; }
        };
        const remove = FileSystemDirectoryHandle.prototype.removeEntry;
        FileSystemDirectoryHandle.prototype.removeEntry = async function (name, options) {
            const call = capture('remove', this, name);
            try { const result = await remove.call(this, name, options); if (call) call.ok = true; return result; }
            catch (error) { if (call) call.error = error.name; throw error; }
        };
        const writable = FileSystemFileHandle.prototype.createWritable;
        FileSystemFileHandle.prototype.createWritable = async function (...args) {
            const call = capture('write', this);
            try { const result = await writable.apply(this, args); if (call) call.ok = true; return result; }
            catch (error) { if (call) call.error = error.name; throw error; }
        };
    }, { vaultName });
}

export async function readFastAudit(page) {
    return page.evaluate(async () => {
        const calls = window.__bmeFastAudit.calls;
        await Promise.all(calls.map(call => call.resolved));
        return { calls: calls.map(call => Object.fromEntries(Object.entries(call).filter(([key]) => key !== 'resolved'))),
            reports: window.__perf?.vault?.reports() ?? [] };
    });
}

/** Source maps are emitted to scratch, never requested by the browser. Keep the
 * sanctioned owners explicit: a new removeEntry elsewhere is NOT a new baseline. */
export async function checkProductionRemovals(audit, distDir) {
    const owners = new Set(['displaceInto', 'retireAsset', 'restoreAsset', 'restoreFromTrash',
        'deleteFromTrash', 'emptyTrash', 'moveFile', 'renameFile']);
    const maps = new Map();
    return Promise.all(audit.calls.filter(call => call.op === 'remove').map(async call => {
        for (const frame of call.stack.matchAll(/https?:\/\/[^\s)]+:(\d+):(\d+)/g)) {
            const file = new URL(frame[0].replace(/:\d+:\d+$/, '')).pathname.slice(1);
            let entry = maps.get(file);
            if (!entry) {
                try {
                    const payload = JSON.parse(await readFile(join(distDir, `${file}.map`), 'utf8'));
                    entry = { map: new SourceMap(payload), payload };
                    maps.set(file, entry);
                } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            }
            const original = entry.map.findEntry(Number(frame[1]) - 1, Number(frame[2]) - 1);
            if (!original.originalSource?.endsWith('/src/context/FileSystemContext.tsx')) continue;
            const index = entry.payload.sources.findIndex(source => original.originalSource.endsWith(source.replace(/^(?:\.\.\/)+/, '')));
            const source = entry.payload.sourcesContent[index];
            if (!source) throw new Error('Removal source map has no source content');
            const lines = source.split('\n'), offset = lines.slice(0, original.originalLine).join('\n').length;
            const declarations = [...source.slice(0, offset).matchAll(/(?:async function\s+(\w+)\s*\(|const\s+(\w+)\s*=\s*useCallback\s*\()/g)];
            const declaration = declarations.at(-1), owner = declaration?.[1] ?? declaration?.[2];
            if (owners.has(owner) && lines[original.originalLine].includes('.removeEntry(')) {
                return { path: call.path, owner, source: original.originalSource, line: original.originalLine + 1 };
            }
        }
        throw new Error(`Unmatched production removal: ${call.path}\n${call.stack}`);
    }));
}

/** Every mutating native invocation, not just successful removals, has an opener.
 * A trash-done resolves the actual copy destination and pairs to that opener. */
export function matchVaultReports(audit) {
    const done = audit.reports.filter(report => report.op === 'trash-done');
    for (const close of done) {
        const open = audit.reports.find(report => report.seq === close.opens);
        if (!open || open.to !== undefined || close.path !== open.path || close.caller !== open.caller || close.t < open.t) {
            throw new Error(`Invalid trash completion ${JSON.stringify(close)}`);
        }
        if (done.filter(report => report.opens === open.seq).length !== 1) throw new Error('Duplicated trash completion');
    }
    return audit.calls.map(call => {
        if (call.fault || !call.path) throw new Error(`Unresolved native I/O: ${JSON.stringify(call)}`);
        const matches = call.reports.filter(report => {
            if (report.t > call.t || report.op === 'trash-done') return false;
            if (call.op === 'remove') return report.path === call.path && ['trash', 'move', 'retire', 'restore', 'empty-trash'].includes(report.op);
            const destination = report.to ?? done.find(close => close.opens === report.seq)?.to;
            if (call.op === 'write') return (report.op === 'write' ? report.path : destination) === call.path;
            return destination?.startsWith(`${call.path}/`) && ['trash', 'move', 'retire', 'restore'].includes(report.op);
        });
        if (!matches.length) throw new Error(`Native ${call.op} without preceding matching report: ${call.path}`);
        return { op: call.op, path: call.path, opener: matches.at(-1).seq };
    });
}
