import { HELPER_PORTS, type AgentId } from '../../shared/vaultAgentProtocol.ts';
import { createClaudeAdapter } from './agents/claude.ts';
import { createCodexAdapter } from './agents/codex.ts';
import { createOpencodeAdapter } from './agents/opencode.ts';
import type { AgentAdapter } from './agents/types.ts';
import { BAKED_ORIGINS, HELPER_VERSION, RELEASES_BASE_URL } from './buildInfo.ts';
import { activeRunCount } from './connection.ts';
import { install, selfUninstall, uninstall, uninstallService } from './install/index.ts';
import { installLayout } from './install/layout.ts';
import { ensurePtyHost } from './install/ptyhost.ts';
import { logError, setLogFile } from './log.ts';
import { ensureDir, sessionsRootFor } from './paths.ts';
import { makeOriginPolicy } from './security.ts';
import { findRunningHelper, helperPlatform, startServer } from './server.ts';
import { compareVersions } from '../../shared/vaultAgentProtocol.ts';
import { runCapture } from './proc.ts';
import { chooseBackend, ptyHostBinaryPath } from './terminal/backend.ts';
import { TerminalManager } from './terminal/manager.ts';
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
    const terminals = new TerminalManager({ backend: chooseBackend(platform, layout, !noRegister) });
    const updater = noRegister ? undefined : createUpdater({
        platform,
        layout,
        currentVersion: HELPER_VERSION,
        releasesBase: RELEASES_BASE_URL,
        activeRuns: activeRunCount,
        stopServer: () => {
            void terminals.closeAll();
            server?.stop();
        },
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
                terminals,
                ptyHostBinary: noRegister || platform !== 'macos' ? undefined : ptyHostBinaryPath(layout),
            },
        });
    } catch (e) {
        logError('could not bind a port', e);
        process.exit(1);
    }
    if (!noRegister) {
        cleanupLeftovers(layout.appDir);
        void ensurePtyHost(layout).catch(e => logError('could not set up the PTY host', e));
    }
    if (noRegister || dev) process.stdout.write(`VaultAgent ${HELPER_VERSION} listening on http://127.0.0.1:${server.port}${dev ? ' (dev origins allowed)' : ''}\n`);
    let stopping = false;
    const stop = () => {
        if (stopping) return;
        stopping = true;
        void terminals.closeAll().finally(() => {
            server?.stop();
            process.exit(0);
        });
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}

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
                process.stderr.write('vaultagent install: run it from a compiled helper (npm run helper:build), not from source.\n');
                process.exit(2);
            }
            try {
                const l = await install({ platform, root, skipLaunchctl: flag(args, '--no-launchctl') });
                process.stdout.write(`VaultAgent ${HELPER_VERSION} installed at ${l.binary}${root ? ' (layout only, not registered)' : ' and set to start at login'}.\n`);
                await notify('VaultAgent installed', 'It runs in the background and starts at login. Go back to the editor and press Connect.');
            } catch (e) {
                logError('install failed', e);
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

function isCompiled(): boolean {
    return Bun.main.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(Bun.main);
}

main().catch(e => {
    process.stderr.write(`vaultagent: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
});
