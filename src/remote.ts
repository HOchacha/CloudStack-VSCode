import * as vscode from "vscode";
import { defaultConfigPath, expandHome } from "./sshConfig";

/**
 * 설치된 Remote-SSH 계열 확장을 찾는다. 목록과 예외 규칙은 Coder VS Code 확장(src/remote/sshExtension.ts)과 같다.
 * - Microsoft VS Code: ms-vscode-remote.remote-ssh
 * - Cursor: anysphere.remote-ssh, VSCodium: jeanp413.open-remote-ssh
 * - Windsurf/Antigravity 확장은 ssh 를 -F 없이 띄워 configFile 설정을 무시하고 항상 ~/.ssh/config 를 읽는다.
 */
const REMOTE_SSH_IDS = [
  "ms-vscode-remote.remote-ssh",
  "anysphere.remote-ssh",
  "jeanp413.open-remote-ssh",
  "codeium.windsurf-remote-openssh",
  "google.antigravity-remote-openssh",
] as const;

const IGNORES_CONFIG_FILE = new Set<string>([
  "codeium.windsurf-remote-openssh",
  "google.antigravity-remote-openssh",
]);

export function findRemoteSshExtension(): vscode.Extension<unknown> | undefined {
  for (const id of REMOTE_SSH_IDS) {
    const ext = vscode.extensions.getExtension(id);
    if (ext) return ext;
  }
  return undefined;
}

/** 우선순위: 이 확장 설정 > Remote-SSH 의 remote.SSH.configFile > ~/.ssh/config */
export function resolveSshConfigPath(): string {
  const own = vscode.workspace.getConfiguration("cloudstack.ssh").get<string>("configFile")?.trim();
  if (own) return expandHome(own);
  const ext = findRemoteSshExtension();
  if (ext && !IGNORES_CONFIG_FILE.has(ext.id)) {
    const rs = vscode.workspace.getConfiguration("remote.SSH").get<string>("configFile")?.trim();
    if (rs) return expandHome(rs);
  }
  return defaultConfigPath();
}

/** Remote-SSH 가 접속할 때마다 OS 를 묻지 않도록 별칭을 linux 로 등록한다(Coder 도 같은 설정을 쓴다). */
export async function markRemotePlatformLinux(alias: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("remote.SSH");
  const cur = cfg.get<Record<string, string>>("remotePlatform") ?? {};
  if (cur[alias] === "linux") return;
  await cfg.update("remotePlatform", { ...cur, [alias]: "linux" }, vscode.ConfigurationTarget.Global);
}

export async function removeRemotePlatform(aliases: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("remote.SSH");
  const cur = { ...(cfg.get<Record<string, string>>("remotePlatform") ?? {}) };
  let changed = false;
  for (const a of aliases) {
    if (a in cur) {
      delete cur[a];
      changed = true;
    }
  }
  if (changed) await cfg.update("remotePlatform", cur, vscode.ConfigurationTarget.Global);
}

/**
 * Remote-SSH 로 연다. authority 는 `ssh-remote+<SSH config 의 Host 별칭>`.
 * - 경로가 있으면 vscode.openFolder (문서화된 API 명령)
 * - 없으면 vscode.newWindow + remoteAuthority 로 빈 원격 창(Coder 확장이 같은 호출을 쓴다)
 */
export async function openRemote(alias: string, newWindow: boolean, folder?: string): Promise<void> {
  const authority = `ssh-remote+${alias}`;
  if (folder && folder.trim()) {
    await vscode.commands.executeCommand(
      "vscode.openFolder",
      vscode.Uri.from({ scheme: "vscode-remote", authority, path: folder.trim() }),
      { forceNewWindow: newWindow }
    );
    return;
  }
  await vscode.commands.executeCommand("vscode.newWindow", {
    remoteAuthority: authority,
    reuseWindow: !newWindow,
  });
}

/** Remote-SSH 없이도 쓸 수 있는 대안. VS Code Server 요구사항(glibc 2.28+)을 못 맞추는 VM 에도 된다. */
export function sshArgs(alias: string, configPath: string): string[] {
  return configPath === defaultConfigPath() ? [alias] : ["-F", configPath, alias];
}

/** 터미널에 붙여 넣을 명령. 기본 경로가 아니면 -F 를 붙인다. */
export function sshCommandLine(alias: string, configPath: string): string {
  return ["ssh", ...sshArgs(alias, configPath).map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a))].join(" ");
}

export function openSshTerminal(alias: string, label: string, configPath: string): void {
  const term = vscode.window.createTerminal({
    name: `SSH: ${label}`,
    shellPath: "ssh",
    shellArgs: sshArgs(alias, configPath),
    iconPath: new vscode.ThemeIcon("terminal"),
  });
  term.show();
}
