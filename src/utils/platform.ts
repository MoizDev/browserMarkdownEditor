import { RELEASE_ASSETS, RELEASE_DOWNLOAD_BASE } from '../../shared/vaultAgentProtocol';
import type { AgentId } from '../../shared/vaultAgentProtocol';

export type OsKind = 'macos' | 'windows' | 'linux' | 'other';
export type CpuArch = 'x64' | 'arm64';

interface UADataLike {
    platform?: string;
    brands?: Array<{ brand: string }>;
    getHighEntropyValues?(hints: string[]): Promise<{ architecture?: string; bitness?: string }>;
}

function uaData(): UADataLike | undefined {
    return (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
}

export function detectOs(): OsKind {
    const platform = uaData()?.platform?.toLowerCase() ?? '';
    if (platform) {
        if (platform === 'macos') return 'macos';
        if (platform === 'windows') return 'windows';
        if (platform === 'linux') return 'linux';
        return 'other';
    }
    const ua = navigator.userAgent;
    if (/CrOS|Android/i.test(ua)) return 'other';
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux/i.test(ua)) return 'linux';
    return 'other';
}

export function isChromium(): boolean {
    const brands = uaData()?.brands;
    if (brands) return brands.some(b => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand));
    return /Chrome\//.test(navigator.userAgent) && typeof WebSocket === 'function';
}

export async function detectArch(): Promise<CpuArch> {
    try {
        const values = await uaData()?.getHighEntropyValues?.(['architecture', 'bitness']);
        if (values?.architecture?.toLowerCase().startsWith('arm')) return 'arm64';
    } catch { /* hints refused — assume x64 */ }
    return 'x64';
}

export interface InstallerAsset {
    url: string;
    fileName: string;
    label: string;
}

export function installerAsset(os: OsKind, arch: CpuArch = 'x64'): InstallerAsset | null {
    let fileName: string;
    let label: string;
    switch (os) {
        case 'macos': fileName = RELEASE_ASSETS.macos; label = 'macOS'; break;
        case 'windows': fileName = RELEASE_ASSETS.windows; label = 'Windows'; break;
        case 'linux':
            fileName = arch === 'arm64' ? RELEASE_ASSETS['linux-arm64'] : RELEASE_ASSETS['linux-x64'];
            label = `Linux (${arch === 'arm64' ? 'ARM64' : 'x64'})`;
            break;
        default: return null;
    }
    return { url: `${RELEASE_DOWNLOAD_BASE}/${fileName}`, fileName, label };
}

export interface GuideStep {
    text: string;
    command?: string;
}

export function openInstallerSteps(os: OsKind, arch: CpuArch = 'x64'): GuideStep[] {
    switch (os) {
        case 'macos':
            return [
                { text: 'Open VaultAgent.pkg from your Downloads.' },
                { text: 'If macOS blocks it: System Settings → Privacy & Security → Open Anyway, then follow the installer.' },
            ];
        case 'windows':
            return [
                { text: 'Run VaultAgent-Setup.exe from your Downloads.' },
                { text: 'If Windows SmartScreen appears: More info → Run anyway, then follow the installer.' },
            ];
        case 'linux': {
            const file = arch === 'arm64' ? RELEASE_ASSETS['linux-arm64'] : RELEASE_ASSETS['linux-x64'];
            return [
                { text: 'Run it once from a terminal; it installs itself as a background service:', command: `chmod +x ~/Downloads/${file} && ~/Downloads/${file}` },
            ];
        }
        default:
            return [];
    }
}

export const AGENT_LOGIN_HINTS: Record<AgentId, { commands: string[]; note?: string }> = {
    claude: { commands: ['claude'], note: 'then type /login' },
    codex: { commands: ['codex login'] },
    opencode: { commands: ['opencode auth login'] },
};
