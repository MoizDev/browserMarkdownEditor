// Where an installed VaultAgent lives, per OS. Fixed paths on purpose: a
// reinstall overwrites the same files, so there is never a second copy.
// `root` (install/uninstall --root) replaces the home folder and ignores the
// environment, so CI and the tests can check the exact layout in a temp dir.

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { HelperPlatform } from '../../../shared/vaultAgentProtocol.ts';

export const LAUNCHD_LABEL = 'dev.bme.vaultagent';
export const WINDOWS_TASK = 'VaultAgent';
export const SYSTEMD_UNIT = 'vaultagent.service';

export interface InstallLayout {
    platform: HelperPlatform;
    home: string;
    /** Folder holding the binary (removed whole on uninstall). */
    appDir: string;
    binary: string;
    logFile: string;
    /** macOS plist / Linux systemd unit. Windows registers a task (no file). */
    registrationFile: string | null;
    /** Linux: XDG autostart fallback when there is no systemd user session. */
    autostartFile: string | null;
}

export function installLayout(platform: HelperPlatform, root?: string, env: NodeJS.ProcessEnv = process.env): InstallLayout {
    const home = root ?? homedir();
    const fromEnv = (key: string, fallback: string) => (!root && env[key] && env[key]!.trim() ? env[key]! : fallback);
    if (platform === 'macos') {
        const appDir = join(home, 'Library', 'Application Support', 'VaultAgent');
        return {
            platform, home, appDir,
            binary: join(appDir, 'vaultagent'),
            logFile: join(home, 'Library', 'Logs', 'VaultAgent.log'),
            registrationFile: join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`),
            autostartFile: null,
        };
    }
    if (platform === 'windows') {
        const appDir = join(fromEnv('LOCALAPPDATA', join(home, 'AppData', 'Local')), 'VaultAgent');
        return {
            platform, home, appDir,
            binary: join(appDir, 'vaultagent.exe'),
            logFile: join(appDir, 'vaultagent.log'),
            registrationFile: null,
            autostartFile: null,
        };
    }
    const config = fromEnv('XDG_CONFIG_HOME', join(home, '.config'));
    const appDir = join(fromEnv('XDG_DATA_HOME', join(home, '.local', 'share')), 'vaultagent');
    return {
        platform, home, appDir,
        binary: join(appDir, 'vaultagent'),
        logFile: join(fromEnv('XDG_STATE_HOME', join(home, '.local', 'state')), 'vaultagent', 'vaultagent.log'),
        registrationFile: join(config, 'systemd', 'user', SYSTEMD_UNIT),
        autostartFile: join(config, 'autostart', 'vaultagent.desktop'),
    };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ~/Library/LaunchAgents/dev.bme.vaultagent.plist — absolute paths: launchd expands no `~`. */
export function launchdPlist(l: InstallLayout): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(l.binary)}</string>
		<string>serve</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<!-- Restart after a crash, but not after a clean exit (uninstall, "already running"). -->
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<!-- Standard, not Background: the agent runs it spawns are what the user is
	     waiting on, and Background throttles CPU and I/O for the whole job. -->
	<key>ProcessType</key>
	<string>Standard</string>
	<key>StandardOutPath</key>
	<string>/dev/null</string>
	<key>StandardErrorPath</key>
	<string>${xml(l.logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit(l: InstallLayout): string {
    const q = (s: string) => `"${s.replace(/(["\\])/g, '\\$1')}"`;
    return `[Unit]
Description=VaultAgent (browserMarkdownEditor AI agent helper)

[Service]
ExecStart=${q(l.binary)} serve
Restart=on-failure
RestartSec=5
StandardOutput=null

[Install]
WantedBy=default.target
`;
}

export function autostartDesktop(l: InstallLayout): string {
    const q = (s: string) => `"${s.replace(/(["\\`$])/g, '\\$1')}"`;
    return `[Desktop Entry]
Type=Application
Name=VaultAgent
Comment=browserMarkdownEditor AI agent helper
Exec=${q(l.binary)} serve
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

/**
 * Task Scheduler definition. The logon trigger and the principal both name the
 * current user: an unscoped logon trigger means "any user" and needs admin
 * rights; scoped, a standard user can register it.
 */
export function windowsTaskXml(l: InstallLayout, userId: string): string {
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>VaultAgent — the browserMarkdownEditor AI agent helper.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>true</Hidden>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(l.binary)}</Command>
      <Arguments>serve</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
