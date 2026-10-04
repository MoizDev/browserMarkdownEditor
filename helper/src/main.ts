// VaultAgent — the local helper that lets the browserMarkdownEditor panel run
// Claude Code, Codex or OpenCode against the open vault.
//
//   vaultagent serve [--dev] [--no-register]   run the helper (what the login item starts)
//   vaultagent install [--root <dir>]          copy into place + register at login
//   vaultagent uninstall [--root <dir>]        undo install (keeps ~/.bme-agent-sessions)
//   vaultagent uninstall-service               Windows uninstaller hook: drop the task, stop helpers
//   vaultagent --version
//   vaultagent                                 = install (a Linux double-click, a terminal run)
//
// --dev also accepts http://localhost:* / http://127.0.0.1:* origins (the Vite
// dev server). --no-register: a foreground run (dev, CI smoke) — log to stderr,
// never touch the installed layout, refuse `helper.uninstall` and `helper.update`.
// An installed `serve` can update itself from the panel (update.ts).

import { HELPER_PORTS, type AgentId } from '../../shared/vaultAgentProtocol.ts';
import { createClaudeAdapter } from './agents/claude.ts';
import { createCodexAdapter } from './agents/codex.ts';
import { createOpencodeAdapter } from './agents/opencode.ts';
import type { AgentAdapter } from './agents/types.ts';
import { BAKED_ORIGINS, HELPER_VERSION, RELEASES_BASE_URL } from './buildInfo.ts';
import { activeRunCount } from './connection.ts';
import { install, selfUninstall, uninstall, uninstallService } from './install/index.ts';
import { installLayout } from './install/layout.ts';
import { logError, setLogFile } from './log.ts';
import { ensureDir, sessionsRootFor } from './paths.ts';
import { makeOriginPolicy } from './security.ts';
import { findRunningHelper, helperPlatform, startServer } from './server.ts';
import { compareVersions } from '../../shared/vaultAgentProtocol.ts';
import { runCapture } from './proc.ts';
import { cleanupLeftovers, createUpdater } from './update.ts';

function flag(args: string[], name: string): boolean {
    return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
    return v;
}

async function serve(args: string[]): Promise<void> {
    const dev = flag(args, '--dev');
    const noRegister = flag(args, '--no-register');
    const platform = helperPlatform();
    if (!noRegister) setLogFile(installLayout(platform).logFile);

    process.on('uncaughtException', e => logError('uncaught exception', e));
    process.on('unhandledRejection', e => logError('unhandled rejection', e));

    const running = await findRunningHelper(HELPER_PORTS);
    if (running && !noRegister && compareVersions(running.version, HELPER_VERSION) >= 0) {
        // A clean exit: launchd's KeepAlive (SuccessfulExit=false) will not respawn us.
        process.exit(0);
    }

    const sessionsRoot = ensureDir(sessionsRootFor());
    const adapters: Record<AgentId, AgentAdapter> = {
        claude: createClaudeAdapter({ sessionsRoot }),
        codex: createCodexAdapter({ sessionsRoot }),
        opencode: createOpencodeAdapter({ sessionsRoot }),
    };
    const layout = installLayout(platform);
    let server: ReturnType<typeof startServer> | undefined;
    const updater = noRegister ? undefined : createUpdater({
        platform,
        layout,
        currentVersion: HELPER_VERSION,
        releasesBase: RELEASES_BASE_URL,
        activeRuns: activeRunCount,
        stopServer: () => server?.stop(),
    });
    try {
        server = startServer({
            ports: HELPER_PORTS,
            policy: makeOriginPolicy(BAKED_ORIGINS, dev),
            context: {
                sessionsRoot,
                platform,
                adapters,
                uninstall: noRegister ? undefined : () => void selfUninstall(platform),
                updater,
            },
        });
    } catch (e) {
        logError('could not bind a port', e);
        // Non-zero: launchd / Task Scheduler / systemd retry later.
        process.exit(1);
    }
    if (!noRegister) cleanupLeftovers(layout.appDir);
    if (noRegister || dev) process.stdout.write(`VaultAgent ${HELPER_VERSION} listening on http://127.0.0.1:${server.port}${dev ? ' (dev origins allowed)' : ''}\n`);
    const stop = () => {
        server?.stop();
        process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

/** Linux double-click: there is no terminal to print to. */
async function notify(title: string, body: string): Promise<void> {
    if (helperPlatform() !== 'linux' || process.stdout.isTTY) return;
    await runCapture(['notify-send', title, body], { timeoutMs: 5000 });
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const cmd = args[0] && !args[0].startsWith('--') ? args[0] : args.length === 0 ? 'install' : args[0];
    const platform = helperPlatform();
    switch (cmd) {
        case '--version':
        case '-v':
            process.stdout.write(`${HELPER_VERSION}\n`);
            return;
        case 'serve':
            await serve(args.slice(1));
            return;
        case 'install': {
            const root = option(args, '--root');
            if (!root && !isCompiled()) {
                // From source, "this executable" is the bun runtime itself: it
                // would be installed as vaultagent and started with `serve`.
                process.stderr.write('vaultagent install: run it from a compiled helper (npm run helper:build), not from source.\n');
                process.exit(2);
            }
            try {
                const l = await install({ platform, root, skipLaunchctl: flag(args, '--no-launchctl') });
                process.stdout.write(`VaultAgent ${HELPER_VERSION} installed at ${l.binary}${root ? ' (layout only, not registered)' : ' and set to start at login'}.\n`);
                await notify('VaultAgent installed', 'It runs in the background and starts at login. Go back to the editor and press Connect.');
            } catch (e) {
                logError('install failed', e);
                // Also in the log file: the Windows installer runs us without a console.
                if (!root) {
                    setLogFile(installLayout(platform).logFile);
                    logError('install failed', e);
                }
                await notify('VaultAgent could not be installed', e instanceof Error ? e.message : 'Unknown error');
                process.exit(1);
            }
            return;
        }
        case 'uninstall':
            await uninstall({ platform, root: option(args, '--root') });
            process.stdout.write('VaultAgent removed. Your chats in ~/.bme-agent-sessions were kept.\n');
            return;
        case 'uninstall-service':
            if (platform === 'windows') await uninstallService();
            return;
        default:
            process.stderr.write(`usage: vaultagent [serve [--dev] [--no-register] | install [--root DIR] | uninstall [--root DIR] | uninstall-service | --version]\n`);
            process.exit(2);
    }
}

/** A `bun build --compile` executable, not `bun helper/src/main.ts`. */
function isCompiled(): boolean {
    return Bun.main.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(Bun.main);
}

main().catch(e => {
    // A usage error (`--root` with no value …): one line, not a stack trace.
    process.stderr.write(`vaultagent: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
});
