import * as vscode from "vscode";
import {
  ClientOptions,
  CloudStackClient,
  Credentials,
  loginWithPassword,
  normalizeEndpoint,
} from "./cloudstack/client";

const SECRET_KEY = "cloudstack.credentials";

/**
 * 자격 증명은 VS Code SecretStorage(OS 키체인: macOS Keychain, Windows 자격 증명 관리자, Linux libsecret)에 둔다.
 * 비밀번호는 저장하지 않는다. 세션 모드는 login 이 돌려준 세션 키만 저장하고, 세션이 만료되면 다시 로그인한다.
 */
export class AuthStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(): Promise<Credentials | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const c = JSON.parse(raw) as Credentials;
      return c && (c.kind === "apikey" || c.kind === "session") ? c : undefined;
    } catch {
      return undefined;
    }
  }

  async save(c: Credentials): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(c));
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}

function validateEndpoint(v: string): string | undefined {
  try {
    normalizeEndpoint(v);
    return undefined;
  } catch (e: any) {
    return e.message;
  }
}

/** 로그인 대화 흐름. 취소하면 undefined. */
export async function promptLogin(
  previous: Credentials | undefined,
  opts: ClientOptions
): Promise<Credentials | undefined> {
  const cfg = vscode.workspace.getConfiguration("cloudstack");
  const endpointInput = await vscode.window.showInputBox({
    title: "CloudStack 로그인 (1/3): 주소",
    prompt: "관리 UI 주소를 넣으면 된다. 예: http://cloud.example.ac.kr:8080/client",
    value: previous?.endpoint ?? cfg.get<string>("endpoint") ?? "",
    ignoreFocusOut: true,
    validateInput: validateEndpoint,
  });
  if (!endpointInput) return undefined;
  const endpoint = normalizeEndpoint(endpointInput);

  const method = await vscode.window.showQuickPick(
    [
      {
        label: "$(account) 사용자명 / 비밀번호",
        detail: "CloudStack UI 로그인과 같다. 세션이 만료되면 다시 로그인해야 한다.",
        value: "session" as const,
      },
      {
        label: "$(key) API Key / Secret Key",
        detail: "UI 프로필 → Generate Keys 로 만든 키. 세션 만료가 없다.",
        value: "apikey" as const,
      },
    ],
    { title: "CloudStack 로그인 (2/3): 인증 방식", ignoreFocusOut: true }
  );
  if (!method) return undefined;

  if (method.value === "session") {
    const domain = await vscode.window.showInputBox({
      title: "CloudStack 로그인 (3/3): 도메인",
      prompt: "도메인 경로. 모르면 비워 둔다(ROOT = /).",
      value: previous?.kind === "session" ? previous.domain : "/",
      ignoreFocusOut: true,
    });
    if (domain === undefined) return undefined;
    const username = await vscode.window.showInputBox({
      title: "CloudStack 로그인 (3/3): 사용자명",
      value: previous?.kind === "session" ? previous.username : "",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : "사용자명을 입력할 것"),
    });
    if (!username) return undefined;
    const password = await vscode.window.showInputBox({
      title: "CloudStack 로그인 (3/3): 비밀번호",
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return undefined;
    const creds = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "CloudStack 로그인 중…" },
      () => loginWithPassword(endpoint, username.trim(), password, domain, opts)
    );
    await rememberEndpoint(endpoint);
    return creds;
  }

  const apiKey = await vscode.window.showInputBox({
    title: "CloudStack 로그인 (3/3): API Key",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "API Key 를 입력할 것"),
  });
  if (!apiKey) return undefined;
  const secretKey = await vscode.window.showInputBox({
    title: "CloudStack 로그인 (3/3): Secret Key",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Secret Key 를 입력할 것"),
  });
  if (!secretKey) return undefined;
  const creds: Credentials = { kind: "apikey", endpoint, apiKey: apiKey.trim(), secretKey: secretKey.trim() };
  // 키가 맞는지 가벼운 호출로 확인한다.
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "API 키 확인 중…" },
    () => new CloudStackClient(creds, opts).call("listCapabilities")
  );
  await rememberEndpoint(endpoint);
  return creds;
}

async function rememberEndpoint(endpoint: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("cloudstack");
  if (!cfg.get<string>("endpoint")) {
    await cfg.update("endpoint", endpoint, vscode.ConfigurationTarget.Global);
  }
}
