import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';

export const markers = ['bme-perf-hooks-plant-7f3a', '__perf', 'fullRenders', 'windowChars', 'widgetsBuilt', 'slicedChars', 'l1Ms', 'l3Ms'];
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function fail(reason) {
    const error = new Error(reason);
    error.gateReason = reason;
    throw error;
}

export async function assertIdentity(arm) {
    const identity = JSON.parse(await readFile(arm.identity, 'utf8'));
    assert.equal(identity.mode, { P: 'production', B: 'benchmark', D: 'development' }[arm.kind], 'identity mode');
    const base = identity.baseRoot;
    const git = (...args) => execFileSync('git', ['-C', base, ...args], { encoding: 'utf8' }).trim();
    assert.equal(git('rev-parse', 'HEAD'), identity.commit, 'the build base is the recorded commit');
    assert.equal(git('status', '--porcelain'), '', 'the recorded source base must still be clean');
    if (identity.tree !== 'clean') {
        assert.ok(arm.patch, 'a mutant identity must name its patch');
        assert.equal(sha256(await readFile(arm.patch)), identity.tree.patchSha256, 'mutant patch identity');
    }
    if (arm.kind === 'D') {
        assert.equal(identity.tree, 'clean', 'dev source must be clean');
        assert.equal(await realpath(base), await realpath(identity.root), 'dev source is the worktree');
        for (const [file, hash] of Object.entries(identity.sources)) {
            assert.equal(sha256(await readFile(identity.root + '/' + file)), hash, `dev source identity ${file}`);
        }
        // The dev server is a local process in our assigned port. Bind its
        // actual cwd/config to the clean worktree, not merely a supplied label.
        const pids = [...new Set(execFileSync('lsof', ['-nP', `-iTCP:${new URL(arm.url).port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split(/\s+/))];
        assert.equal(pids.length, 1, 'one dev listener');
        const cwd = execFileSync('lsof', ['-a', '-p', pids[0], '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))?.slice(1);
        assert.equal(await realpath(cwd), await realpath(identity.root), 'the dev server runs in this worktree');
        const command = execFileSync('ps', ['-p', pids[0], '-o', 'command='], { encoding: 'utf8' });
        assert.ok(command.includes(`--config ${arm.serverConfig}`), 'the dev process uses the recorded scratch config');
        const config = await readFile(arm.serverConfig, 'utf8');
        assert.ok(config.includes(`root: '${identity.root}'`) || config.includes(`root: "${identity.root}"`), 'the dev config root is the clean worktree');
    }
    return identity;
}

export function observe(context, arm, identity) {
    const pending = [], scripts = [], supplemental = [], errors = [];
    const origin = new URL(arm.url).origin;
    const record = (url, bytes, list, resourceType) => {
        try {
            assert.equal(new URL(url).origin, origin, 'scanned bytes come from this preview origin');
            const path = decodeURIComponent(new URL(url).pathname).replace(/^\//, '');
            const hash = sha256(bytes);
            if (arm.kind !== 'D') {
                assert.ok(identity.files[path], `every scanned body has a manifest entry: ${path}`);
                assert.equal(hash, identity.files[path], `served body identity ${url}`);
            }
            const text = bytes.toString('utf8');
            list.push({ url, sha256: hash, resourceType, anchors: markers.filter(marker => text.includes(marker)) });
        } catch (error) {
            error.invalidExecution = true;
            throw error;
        }
    };
    context.on('response', response => {
        const request = response.request(), url = response.url();
        if (new URL(url).origin !== origin) return;
        const type = request.resourceType(), mime = response.headers()['content-type'] || '';
        if (type !== 'script' && !/javascript|ecmascript/.test(mime)) return;
        pending.push((async () => {
            assert.ok(response.ok(), `script response succeeded: ${url}`);
            record(url, await response.body(), scripts, type);
        })().catch(error => errors.push(error.stack)));
    });
    return {
        async finish() {
            let consumed = 0;
            while (consumed < pending.length) {
                const batch = pending.slice(consumed);
                consumed += batch.length;
                await Promise.all(batch);
            }
            if (errors.length) throw Object.assign(new Error(`Script body/identity collection failed: ${errors.join('\n')}`), { invalidExecution: true });
            assert.ok(scripts.length, 'the browser must fetch application scripts');
            if (arm.kind !== 'D') {
                const fetched = new Set(scripts.map(script => decodeURIComponent(new URL(script.url).pathname).replace(/^\//, '')));
                // Supplemental bytes still come through this browser context
                // from this preview; Node supplied paths, never asserted content.
                for (const path of Object.keys(identity.files).filter(path => /\.(?:m?js)$/.test(path) && !fetched.has(path))) {
                    const response = await context.request.get(new URL(path, arm.url).href).catch(error => {
                        error.invalidExecution = true;
                        throw error;
                    });
                    if (!response.ok()) throw Object.assign(new Error(`Supplemental script fetch failed: ${path}`), { invalidExecution: true });
                    const body = await response.body().catch(error => {
                        error.invalidExecution = true;
                        throw error;
                    });
                    record(response.url(), body, supplemental, 'supplemental-context-fetch');
                }
            }
            const result = { scripts, supplemental, sourceTextLoss: arm.kind === 'D' ? 'dev source text carries dead guarded code; absence is behavioural, not a text claim' : null };
            if (arm.kind === 'P') {
                for (const script of [...scripts, ...supplemental]) {
                    if (script.anchors.length) fail(`FAIL P-anchor ${script.anchors[0]} ${script.url}`);
                }
            } else if (arm.kind === 'B') {
                for (const marker of markers) {
                    if (!scripts.some(script => script.anchors.includes(marker))) fail(`FAIL B-control missing-fetched-anchor ${marker}`);
                }
            }
            return result;
        },
        snapshot: () => ({ scripts, supplemental, errors }),
    };
}
