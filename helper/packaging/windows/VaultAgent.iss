; VaultAgent-Setup.exe: unsigned, per-user (no admin prompt).
;
;   iscc /DAppVersion=1.2.3 /DBinaryPath=path\to\vaultagent.exe /DOutputDir=path\to\out helper\packaging\windows\VaultAgent.iss
;
; Installs %LOCALAPPDATA%\VaultAgent\vaultagent.exe, then `vaultagent.exe install`
; (run from [Code], not [Run], so a failure is reported instead of ignored)
; registers the per-user logon task "VaultAgent" and starts it. The panel's
; Uninstall runs unins000.exe /VERYSILENT, whose [UninstallRun] drops the task and
; stops the helper before the files go, so Apps & Features stays in step.

#ifndef AppVersion
  #error Pass /DAppVersion=x.y.z
#endif
#ifndef BinaryPath
  #error Pass /DBinaryPath=path\to\vaultagent.exe
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
; File version info takes digits only: 1.2.3-rc.1 -> 1.2.3.
#define NumericVersion Copy(AppVersion, 1, Pos("-", AppVersion + "-") - 1)

[Setup]
; Fixed forever: Inno finds the previous install (and its uninstaller) by this id.
AppId={{6B0C3F0E-8F2A-4E57-9D1B-5A4C7E2B9F31}
AppName=VaultAgent
AppVersion={#AppVersion}
AppVerName=VaultAgent {#AppVersion}
AppPublisher=browserMarkdownEditor
AppComments=Lets the browserMarkdownEditor agent panel talk to Claude Code, Codex and OpenCode on this computer.
VersionInfoVersion={#NumericVersion}
PrivilegesRequired=lowest
DefaultDirName={localappdata}\VaultAgent
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
UsePreviousAppDir=no
; An x64 binary; Windows on Arm runs it under emulation.
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=VaultAgent-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
; The running helper is stopped by PrepareToInstall below, not by Restart Manager prompts.
CloseApplications=no
RestartApplications=no
UninstallDisplayName=VaultAgent
UninstallDisplayIcon={app}\vaultagent.exe

[Messages]
WelcomeLabel2=VaultAgent lets the Markdown editor in your browser talk to the AI agents already on this computer: Claude Code, Codex and OpenCode.%n%nIt runs in the background with no window and starts when you sign in. The agents it starts can read and change the notes in the vault you open, and their edits land in the editor live. They also run with the same access to this computer as in your terminal, without asking first.
FinishedLabel=VaultAgent is running. Go back to the editor and press Connect in the agent panel.

[Files]
Source: "{#BinaryPath}"; DestDir: "{app}"; DestName: "vaultagent.exe"; Flags: ignoreversion

[UninstallRun]
Filename: "{app}\vaultagent.exe"; Parameters: "uninstall-service"; Flags: runhidden waituntilterminated; RunOnceId: "StopVaultAgent"

[UninstallDelete]
Type: files; Name: "{app}\vaultagent.log"
Type: files; Name: "{app}\vaultagent.log.1"
Type: dirifempty; Name: "{app}"

[Code]
{ A reinstall must replace a running vaultagent.exe: stop the task and any helper first. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/End /TN VaultAgent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM vaultagent.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

{ Registers the logon task and starts the helper. [Run] would ignore a failure and still say "running". }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    exit;
  WizardForm.StatusLabel.Caption := 'Starting VaultAgent...';
  if not Exec(ExpandConstant('{app}\vaultagent.exe'), 'install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
    SuppressibleMsgBox('VaultAgent was installed but could not be set to start when you sign in (error ' + IntToStr(ResultCode) + ').' + #13#10#13#10 +
      'Details are in ' + ExpandConstant('{app}\vaultagent.log') + '.', mbError, MB_OK, IDOK);
end;
