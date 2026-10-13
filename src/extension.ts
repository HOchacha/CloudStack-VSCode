import { promises as fs } from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AddressPreference, pickTarget, SshTarget } from "./addressing";
import { AuthStore, promptLogin } from "./auth";
import { AuthError, ClientOptions, CloudStackClient, Credentials } from "./cloudstack/client";
import type { Network, VirtualMachine } from "./cloudstack/types";
import {
  DEFAULT_PORT_RANGE,
  defaultNetworkId,
  isPortConflict,
  managedFirewallFor,
  managedRulesFor,
  notExposableReason,
  parseCidrList,
  parsePortRange,
  pickPublicIp,
  planExposure,
  TAG_MANAGED,
  TAG_MANAGED_VALUE,
  TAG_PF,
  TAG_VM,
} from "./exposure";
import {
  editConfigFile,
  expandHome,
  HostEntry,
  listManagedEntries,
  makeAlias,
  upsertEntries,
} from "./sshConfig";
import {
  findRemoteSshExtension,
  markRemotePlatformLinux,
  openRemote,
  openSshTerminal,
  removeRemotePlatform,
  resolveSshConfigPath,
  sshCommandLine,
} from "./remote";
import { VmItem, VmTreeProvider } from "./vmTree";

const USERS_KEY = "cloudstack.sshUsers"; // vmId -> SSH 사용자명
const SSH_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;

let log: vscode.LogOutputChannel;
let auth: AuthStore;
let client: CloudStackClient | undefined;
let tree: VmTreeProvider;
let ctx: vscode.ExtensionContext;
let refreshTimer: NodeJS.Timeout | undefined;

function clientOptions(): ClientOptions {
  const cfg = vscode.workspace.getConfiguration("cloudstack");
  return {
    allowSelfSigned: cfg.get<boolean>("allowSelfSignedCertificate", false),
    log: (l) => log.debug(l),
  };
}

async function setClient(c: Credentials | undefined): Promise<void> {
  client = c ? new CloudStackClient(c, clientOptions()) : undefined;
  await vscode.commands.executeCommand("setContext", "cloudstack.loggedIn", !!client);
  if (!client) tree.setLoggedOut();
}

/** CloudStack 호출 공통 처리: 401 이면 세션을 버리고 재로그인을 권한다. */
async function withClient<T>(fn: (c: CloudStackClient) => Promise<T>): Promise<T | undefined> {
  if (!client) {
    const pick = await vscode.window.showWarningMessage("CloudStack 에 로그인되어 있지 않다.", "로그인");
    if (pick) await vscode.commands.executeCommand("cloudstack.login");
    return undefined;
  }
  try {
    const r = await fn(client);
    // 세션 쿠키가 갱신됐을 수 있으므로 저장해 둔다.
    if (client.credentials.kind === "session") await auth.save(client.credentials);
    return r;
  } catch (e: any) {
    if (e instanceof AuthError) {
      log.warn(`인증 실패: ${e.message}`);
      await auth.clear();
      await setClient(undefined);
      const pick = await vscode.window.showErrorMessage(
        "CloudStack 세션이 만료됐거나 키가 유효하지 않다.",
        "다시 로그인"
      );
      if (pick) await vscode.commands.executeCommand("cloudstack.login");
      return undefined;
    }
    log.error(e?.stack ?? String(e));
    throw e;
  }
}

async function refresh(): Promise<void> {
  if (!client) return;
  try {
    const data = await withClient(async (c) => {
      const [vms, rules] = await Promise.all([
        c.listVirtualMachines(),
        // 포트포워딩 권한이 없는 계정(Shared/Basic Zone 등)에서도 목록은 보이게 한다.
        c.listPortForwardingRules().catch((e) => {
          log.warn(`listPortForwardingRules 실패: ${e.message}`);
          return [];
        }),
      ]);
      return { vms, rules };
    });
    if (!data) return;
    const jumpHost = vscode.workspace.getConfiguration("cloudstack.ssh").get<string>("jumpHost")?.trim() || undefined;
    tree.setData(data.vms, data.rules, jumpHost);
    await pruneSshConfig(new Set(data.vms.map((v) => v.id)));
  } catch (e: any) {
    tree.setError(`목록을 가져오지 못했다: ${e.message}`);
  }
}

/** 삭제된 VM 의 SSH config 항목과 remotePlatform 설정을 지운다. */
async function pruneSshConfig(existing: Set<string>): Promise<void> {
  const configPath = resolveSshConfigPath();
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }
  const stale = listManagedEntries(text).filter((e) => !existing.has(e.vmId));
  if (!stale.length) return;
  await editConfigFile(configPath, (t) => upsertEntries(t, [], existing));
  await removeRemotePlatform(stale.map((s) => s.alias));
  log.info(`삭제된 VM 항목 ${stale.length}개를 SSH config 에서 지웠다`);
}

function scheduleAutoRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  const sec = vscode.workspace.getConfiguration("cloudstack").get<number>("refreshIntervalSeconds", 0);
  if (sec && sec >= 10) refreshTimer = setInterval(() => void refresh(), sec * 1000);
}

/** 명령 팔레트에서 부르면 VM 을 고르게 한다. */
async function resolveItem(arg: unknown, filter?: (vm: VirtualMachine) => boolean): Promise<VmItem | undefined> {
  if (arg instanceof VmItem) return arg;
  if (!client) {
    await vscode.commands.executeCommand("cloudstack.login");
    if (!client) return undefined;
  }
  if (!tree.getVms().length) await refresh();
  const vms = tree.getVms().filter(filter ?? (() => true));
  if (!vms.length) {
    vscode.window.showInformationMessage("고를 수 있는 VM 이 없다.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    vms.map((vm) => ({ label: vm.displayname || vm.name, description: vm.state, detail: vm.zonename, vm })),
    { title: "VM 선택", matchOnDescription: true }
  );
  return pick ? tree.itemFor(pick.vm) : undefined;
}

async function ensureRunning(item: VmItem): Promise<VmItem | undefined> {
  if (item.vm.state === "Running") return item;
  if (item.vm.state !== "Stopped") {
    vscode.window.showWarningMessage(`VM 상태가 ${item.vm.state} 이다. Running 이 된 뒤 다시 시도할 것.`);
    return undefined;
  }
  const pick = await vscode.window.showInformationMessage(
    `${item.label} 이(가) 중지 상태다. 시작한 뒤 접속할까?`,
    "시작 후 접속"
  );
  if (!pick) return undefined;
  const ok = await runVmJob(item, "start");
  if (!ok) return undefined;
  const fresh = tree.getVms().find((v) => v.id === item.vm.id);
  return fresh && fresh.state === "Running" ? tree.itemFor(fresh) : undefined;
}

async function chooseTarget(item: VmItem): Promise<SshTarget | undefined> {
  const sshCfg = vscode.workspace.getConfiguration("cloudstack.ssh");
  const pref = sshCfg.get<AddressPreference>("addressPreference", "auto");
  const jumpHost = sshCfg.get<string>("jumpHost")?.trim();
  // 외부에서 닿는 경로(Static NAT/포트포워딩)가 없고 점프 호스트도 없으면 공인 IP 노출을 제안한다.
  const hasPublic = item.candidates.some((c) => c.kind !== "private");
  if (!hasPublic && !jumpHost && pref !== "private") {
    const t = await offerExposure(item);
    if (t === "cancel") return undefined;
    if (t) return t;
  }
  if (!item.candidates.length) {
    vscode.window.showErrorMessage(
      "이 VM 에는 SSH 로 닿을 주소가 없다. Static NAT 이나 22번 포트포워딩을 설정하거나, 설정에서 점프 호스트를 지정할 것."
    );
    return undefined;
  }
  const auto = pickTarget(item.candidates, pref);
  if (auto) return auto;
  const pick = await vscode.window.showQuickPick(
    item.candidates.map((c) => ({ label: c.label, target: c })),
    { title: `${item.label}: SSH 경로 선택` }
  );
  return pick?.target;
}

// ---------------------------------------------------------------------------
// Isolated 네트워크 VM 을 공인 IP 로 여는 기능
// ---------------------------------------------------------------------------

class UserFacingError extends Error {}
const exposing = new Set<string>();

function exposeSettings() {
  const c = vscode.workspace.getConfiguration("cloudstack.expose");
  return {
    mode: c.get<"ask" | "auto" | "never">("mode", "ask"),
    portRange: c.get<string>("portRange", DEFAULT_PORT_RANGE) || DEFAULT_PORT_RANGE,
    allowedCidrs: (c.get<string>("allowedCidrs", "") ?? "").trim(),
  };
}

/** 사용자가 고른 경우에만 외부 서비스(api.ipify.org)로 내 공인 IPv4 를 확인한다. */
function detectMyPublicIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get("https://api.ipify.org", { timeout: 10000 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const ip = body.trim();
        if (res.statusCode === 200 && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) resolve(ip);
        else reject(new Error(`공인 IP 확인 실패 (HTTP ${res.statusCode})`));
      });
    });
    req.on("timeout", () => req.destroy(new Error("공인 IP 확인 시간 초과")));
    req.on("error", reject);
  });
}

async function askAllowedCidrs(): Promise<string[] | undefined> {
  const configured = exposeSettings().allowedCidrs;
  if (configured) return parseCidrList(configured);
  const pick = await vscode.window.showQuickPick(
    [
      {
        label: "$(globe) 내 현재 공인 IP 만",
        detail: "api.ipify.org 로 확인한다. 학내망 안에서 학내 공인 IP 로 접속하면 출발지 주소가 달라 막힐 수 있다.",
        value: "myip" as const,
      },
      {
        label: "$(edit) 허용 대역 직접 입력",
        detail: "예: 학교 대역 203.0.113.0/24. 여러 개는 쉼표로 구분한다.",
        value: "manual" as const,
      },
      {
        label: "$(warning) 모든 곳에서 허용 (0.0.0.0/0)",
        detail: "인터넷 전체에서 SSH 무차별 대입 시도를 받는다. 비밀번호 로그인을 끈 VM 에서만 쓸 것.",
        value: "any" as const,
      },
    ],
    { title: "SSH 를 허용할 출발지", ignoreFocusOut: true }
  );
  if (!pick) return undefined;
  if (pick.value === "any") return ["0.0.0.0/0"];

  if (pick.value === "myip") {
    try {
      return [`${await detectMyPublicIp()}/32`];
    } catch (e: any) {
      vscode.window.showWarningMessage(`${e.message}. 직접 입력할 것.`);
    }
  }
  const input = await vscode.window.showInputBox({
    title: "SSH 허용 대역 (CIDR)",
    prompt: "IPv4 CIDR, 쉼표로 여러 개. 주소만 넣으면 /32 로 처리한다.",

    ignoreFocusOut: true,
    validateInput: (v) => {
      try {
        parseCidrList(v);
        return undefined;
      } catch (e: any) {
        return e.message;
      }
    },
  });
  return input ? parseCidrList(input) : undefined;
}

/** 공인 경로가 없는 VM 에 노출을 제안한다. "cancel" 이면 접속 자체를 멈춘다. */
async function offerExposure(item: VmItem): Promise<SshTarget | "cancel" | undefined> {
  const { mode } = exposeSettings();
  if (mode === "never") return undefined;
  const networkId = defaultNetworkId(item.vm);
  if (!networkId) return undefined;
  let network: Network | undefined;
  try {
    network = await withClient((c) => c.getNetwork(networkId));
  } catch (e: any) {
    log.warn(`네트워크 조회 실패: ${e.message}`);
    return undefined;
  }
  if (!client) return "cancel"; // 세션 만료로 로그아웃됨
  const reason = notExposableReason(network);
  if (reason) {
    vscode.window.showWarningMessage(`${item.label}: 외부에서 닿는 SSH 경로가 없다. ${reason} 사설 IP 로 시도한다.`);
    return undefined;
  }
  if (mode === "ask") {
    const pick = await vscode.window.showWarningMessage(
      `${item.label} 은(는) Isolated 네트워크 ${network!.name} 에 있어 외부에서 닿는 SSH 경로가 없다. 네트워크의 공인 IP 에 SSH 포트포워딩을 만들까?`,
      "포트포워딩 만들기",
      "사설 IP 로 시도"
    );
    if (!pick) return "cancel";
    if (pick !== "포트포워딩 만들기") return undefined;
  }
  return (await exposeSsh(item, network)) ?? "cancel";
}

/**
 * 공인 IP:빈 포트 → VM:22 포트포워딩(openfirewall=false)과, 고른 출발지만 허용하는 방화벽 규칙을 만든다.
 * 방화벽 생성이 실패하면 포트포워딩을 지운다. 포트 충돌로 거절되면 다음 포트로 다시 시도한다.
 */
async function exposeSsh(item: VmItem, knownNetwork?: Network): Promise<SshTarget | undefined> {
  const vm = item.vm;
  if (exposing.has(vm.id)) {
    vscode.window.showInformationMessage(`${item.label}: 이미 여는 중이다.`);
    return undefined;
  }
  const networkId = defaultNetworkId(vm);
  if (!networkId) {
    vscode.window.showErrorMessage(`${item.label}: 기본 NIC 의 네트워크를 알 수 없다.`);
    return undefined;
  }
  exposing.add(vm.id);
  try {
    const network = knownNetwork ?? (await withClient((c) => c.getNetwork(networkId)));
    if (!client) return undefined;
    const reason = notExposableReason(network);
    if (reason) throw new UserFacingError(reason);
    const range = parsePortRange(exposeSettings().portRange);
    const cidrs = await askAllowedCidrs();
    if (!cidrs) return undefined;

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `${item.label}: 공인 IP 로 SSH 여는 중…` },
      () =>
        withClient(async (c) => {
          const [ips, pfRules] = await Promise.all([c.listPublicIpAddresses(networkId), c.listPortForwardingRules()]);
          const chosen = pickPublicIp(ips, networkId);
          const [lbRules, fwRules] = chosen
            ? await Promise.all([
                c.listLoadBalancerRules(chosen.id).catch((e) => {
                  log.warn(`listLoadBalancerRules 실패(무시): ${e.message}`);
                  return [];
                }),
                c.listFirewallRules(chosen.id),
              ])
            : [[], []];
          const rejected: number[] = [];
          for (let attempt = 0; attempt < 5; attempt++) {
            const plan = planExposure({ vm, network, ips, pfRules, lbRules, fwRules, portRange: range, rejectedPorts: rejected });
            if (!plan.ok) throw new UserFacingError(plan.reason);
            let pf;
            try {
              pf = await c.createPortForwardingRule({ ipAddressId: plan.ip.id, vmId: vm.id, publicPort: plan.publicPort, privatePort: 22 });
            } catch (e: any) {
              if (!(e instanceof AuthError) && isPortConflict(e.message)) {
                log.info(`포트 ${plan.publicPort} 충돌, 다음 포트로: ${e.message}`);
                rejected.push(plan.publicPort);
                continue;
              }
              throw e;
            }
            let fw;
            try {
              fw = await c.createFirewallRule({ ipAddressId: plan.ip.id, port: plan.publicPort, cidrs });
            } catch (e: any) {
              await c.deletePortForwardingRule(pf.id).catch((err) =>
                log.error(`롤백 실패: 포트포워딩 ${pf.id} 를 UI 에서 지울 것 (${err.message})`)
              );
              if (!(e instanceof AuthError) && isPortConflict(e.message)) {
                rejected.push(plan.publicPort);
                continue;
              }
              throw e;
            }
            // 태그가 없으면 '공인 SSH 닫기' 가 규칙을 찾지 못한다. 실패해도 접속은 되므로 경고만 남긴다.
            await c
              .createTags("PortForwardingRule", [pf.id], { [TAG_MANAGED]: TAG_MANAGED_VALUE, [TAG_VM]: vm.id })
              .catch((e) => log.warn(`포트포워딩 태그 실패: ${e.message}`));
            await c
              .createTags("FirewallRule", [fw.id], { [TAG_MANAGED]: TAG_MANAGED_VALUE, [TAG_VM]: vm.id, [TAG_PF]: pf.id })
              .catch((e) => log.warn(`방화벽 태그 실패: ${e.message}`));
            return { ip: plan.ip.ipaddress, port: plan.publicPort, warning: plan.warning };
          }
          throw new UserFacingError("포트 충돌이 계속 나서 멈췄다. 잠시 뒤 다시 시도할 것.");
        })
    );
    if (!result) return undefined;
    log.info(`${vm.name}: ${result.ip}:${result.port} → 22 공개 (허용 ${cidrs.join(", ")})`);
    if (result.warning) vscode.window.showWarningMessage(result.warning);
    await refresh();
    return {
      kind: "portForward",
      host: result.ip,
      port: result.port,
      viaJumpHost: false,
      label: `포트포워딩 ${result.ip}:${result.port} → 22 (이 확장이 생성)`,
    };
  } catch (e: any) {
    vscode.window.showErrorMessage(`${item.label}: 공인 IP 로 SSH 열기 실패: ${e.message}`);
    return undefined;
  } finally {
    exposing.delete(vm.id);
  }
}

async function exposeCommand(arg: unknown): Promise<void> {
  const item = await resolveItem(arg);
  if (!item) return;
  const managed = managedRulesFor(item.vm.id, tree.getRules());
  if (!managed.length) {
    const t = await exposeSsh(item);
    if (t) vscode.window.showInformationMessage(`${item.label}: ${t.host}:${t.port} 로 SSH 를 열었다.`);
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `${item.label}: 이미 ${managed.map((r) => `${r.ipaddress}:${r.publicport}`).join(", ")} 로 열려 있다.`,
    "허용 대역 변경"
  );
  if (pick) await changeAllowedCidrs(item);
}

/**
 * 같은 포트에 출발지 대역이 겹치는 방화벽 규칙을 두 개 둘 수 없어서(서버가 충돌로 거절)
 * 기존 규칙을 먼저 지우고 새로 만든다. 그 사이 잠깐 새 접속이 막힌다.
 */
async function changeAllowedCidrs(item: VmItem): Promise<void> {
  const cidrs = await askAllowedCidrs();
  if (!cidrs) return;
  const managed = managedRulesFor(item.vm.id, tree.getRules());
  await vscode.window
    .withProgress({ location: vscode.ProgressLocation.Notification, title: `${item.label}: 허용 대역 변경 중…` }, () =>
      withClient(async (c) => {
        for (const pf of managed) {
          const ipId = pf.ipaddressid;
          if (!ipId) continue;
          for (const fw of managedFirewallFor(pf.id, await c.listFirewallRules(ipId))) await c.deleteFirewallRule(fw.id);
          const fw = await c.createFirewallRule({ ipAddressId: ipId, port: Number(pf.publicport), cidrs });
          await c
            .createTags("FirewallRule", [fw.id], { [TAG_MANAGED]: TAG_MANAGED_VALUE, [TAG_VM]: item.vm.id, [TAG_PF]: pf.id })
            .catch((e) => log.warn(`방화벽 태그 실패: ${e.message}`));
        }
      })
    )
    .then(
      () => vscode.window.showInformationMessage(`${item.label}: 허용 대역을 ${cidrs.join(", ")} 로 바꿨다.`),
      (e: any) => vscode.window.showErrorMessage(`허용 대역 변경 실패: ${e.message}`)
    );
}

async function unexposeCommand(arg: unknown): Promise<void> {
  const item = await resolveItem(arg);
  if (!item) return;
  const managed = managedRulesFor(item.vm.id, tree.getRules());
  if (!managed.length) {
    vscode.window.showInformationMessage(`${item.label}: 이 확장이 만든 공인 SSH 규칙이 없다.`);
    return;
  }
  const ok = await vscode.window.showWarningMessage(
    `${item.label}: ${managed.map((r) => `${r.ipaddress}:${r.publicport}`).join(", ")} 의 SSH 포트포워딩과 방화벽 규칙을 지울까?`,
    { modal: true },
    "닫기"
  );
  if (!ok) return;
  await vscode.window
    .withProgress({ location: vscode.ProgressLocation.Notification, title: `${item.label}: 공인 SSH 닫는 중…` }, () =>
      withClient(async (c) => {
        for (const pf of managed) {
          if (pf.ipaddressid) {
            for (const fw of managedFirewallFor(pf.id, await c.listFirewallRules(pf.ipaddressid))) await c.deleteFirewallRule(fw.id);
          }
          await c.deletePortForwardingRule(pf.id);
        }
      })
    )
    .then(
      () => vscode.window.showInformationMessage(`${item.label}: 공인 SSH 를 닫았다.`),
      (e: any) => vscode.window.showErrorMessage(`공인 SSH 닫기 실패: ${e.message}`)
    );
  await refresh();
}

async function sshUserFor(vm: VirtualMachine, forcePrompt = false): Promise<string | undefined> {
  const users = ctx.globalState.get<Record<string, string>>(USERS_KEY, {});
  if (!forcePrompt && users[vm.id]) return users[vm.id];
  const def = vscode.workspace.getConfiguration("cloudstack.ssh").get<string>("defaultUser")?.trim();
  if (!forcePrompt && def && SSH_USER_RE.test(def)) return def;
  const user = await vscode.window.showInputBox({
    title: `${vm.displayname || vm.name}: SSH 사용자명`,
    prompt: "템플릿마다 다르다. 예: Ubuntu 클라우드 이미지 ubuntu, Rocky Linux rocky, 직접 만든 템플릿은 root 인 경우가 많다.",
    value: users[vm.id] ?? def ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (SSH_USER_RE.test(v.trim()) ? undefined : "영문·숫자·_ . - 만, 32자 이하"),
  });
  if (!user) return undefined;
  await ctx.globalState.update(USERS_KEY, { ...users, [vm.id]: user.trim() });
  return user.trim();
}

/** 접속 전 공통 단계: Running 확인 → 경로 선택 → 사용자 → SSH config 기록. 별칭을 돌려준다. */
async function prepareSsh(arg: unknown): Promise<{ alias: string; item: VmItem; configPath: string } | undefined> {
  let item = await resolveItem(arg);
  if (!item) return undefined;
  item = await ensureRunning(item);
  if (!item) return undefined;
  const target = await chooseTarget(item);
  if (!target) return undefined;
  const user = await sshUserFor(item.vm);
  if (!user) return undefined;

  const sshCfg = vscode.workspace.getConfiguration("cloudstack.ssh");
  const identity = sshCfg.get<string>("identityFile")?.trim();
  const jumpHost = sshCfg.get<string>("jumpHost")?.trim();
  const alias = makeAlias(item.vm.name, item.vm.id);
  const entry: HostEntry = {
    vmId: item.vm.id,
    alias,
    hostName: target.host,
    port: target.port,
    user,
    identityFile: identity ? expandHome(identity) : undefined,
    proxyJump: target.viaJumpHost && jumpHost ? jumpHost : undefined,
  };
  const configPath = resolveSshConfigPath();
  const r = await editConfigFile(configPath, (t) => upsertEntries(t, [entry]));
  if (r.changed) log.info(`${r.path} 에 ${alias} 기록 (${target.label}, user=${user})`);
  return { alias, item, configPath };
}

async function connect(arg: unknown, newWindow: boolean): Promise<void> {
  const remoteExt = findRemoteSshExtension();
  if (!remoteExt) {
    const pick = await vscode.window.showWarningMessage(
      "Remote - SSH 확장이 없다. 설치하면 VM 안의 파일을 VS Code 창으로 바로 연다.",
      "Remote - SSH 설치",
      "SSH 터미널로 열기"
    );
    if (pick === "Remote - SSH 설치") {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", "ms-vscode-remote.remote-ssh");
      vscode.window.showInformationMessage("설치가 끝나면 다시 접속을 누를 것.");
    } else if (pick === "SSH 터미널로 열기") {
      await openTerminal(arg);
    }
    return;
  }
  const prep = await prepareSsh(arg);
  if (!prep) return;
  await markRemotePlatformLinux(prep.alias);
  const folder = vscode.workspace.getConfiguration("cloudstack.ssh").get<string>("openPath")?.trim();
  log.info(`Remote-SSH(${remoteExt.id}) 로 ${prep.alias} 열기`);
  await openRemote(prep.alias, newWindow, folder);
}

async function openTerminal(arg: unknown): Promise<void> {
  const prep = await prepareSsh(arg);
  if (!prep) return;
  openSshTerminal(prep.alias, String(prep.item.label), prep.configPath);
}

async function copySshCommand(arg: unknown): Promise<void> {
  const prep = await prepareSsh(arg);
  if (!prep) return;
  const cmd = sshCommandLine(prep.alias, prep.configPath);
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(`복사했다: ${cmd}`);
}

async function runVmJob(item: VmItem, op: "start" | "stop"): Promise<boolean> {
  const name = String(item.label);
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${name} ${op === "start" ? "시작" : "중지"} 중…` },
    () =>
      withClient(async (c) => {
        const job = op === "start" ? await c.startVirtualMachine(item.vm.id) : await c.stopVirtualMachine(item.vm.id);
        await c.waitForJob(job);
        return true;
      })
  ).then(
    (v) => v,
    (e: any) => {
      vscode.window.showErrorMessage(`${name} ${op === "start" ? "시작" : "중지"} 실패: ${e.message}`);
      return false;
    }
  );
  await refresh();
  return !!r;
}

async function stopVm(arg: unknown): Promise<void> {
  const item = await resolveItem(arg, (vm) => vm.state === "Running");
  if (!item) return;
  const ok = await vscode.window.showWarningMessage(
    `${item.label} 을(를) 중지할까? 저장하지 않은 작업은 사라진다.`,
    { modal: true },
    "중지"
  );
  if (ok) await runVmJob(item, "stop");
}

async function startVm(arg: unknown): Promise<void> {
  const item = await resolveItem(arg, (vm) => vm.state === "Stopped");
  if (item) await runVmJob(item, "start");
}

const PUBKEY_RE = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;

async function registerSshKey(): Promise<void> {
  const sshDir = path.join(os.homedir(), ".ssh");
  let pubs: string[] = [];
  try {
    pubs = (await fs.readdir(sshDir)).filter((f) => f.endsWith(".pub")).map((f) => path.join(sshDir, f));
  } catch {
    /* ~/.ssh 없음 */
  }
  const OTHER = "$(folder-opened) 다른 파일 선택…";
  const pick = await vscode.window.showQuickPick([...pubs, OTHER], {
    title: "CloudStack 에 등록할 공개키",
    placeHolder: pubs.length ? undefined : "~/.ssh 에 공개키가 없다. ssh-keygen -t ed25519 로 먼저 만들 것",
  });
  if (!pick) return;
  let pubPath = pick;
  if (pick === OTHER) {
    const sel = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.file(sshDir) });
    if (!sel?.length) return;
    pubPath = sel[0].fsPath;
  }
  const publicKey = (await fs.readFile(pubPath, "utf8")).trim();
  if (!PUBKEY_RE.test(publicKey) || publicKey.includes("\n")) {
    vscode.window.showErrorMessage("OpenSSH 공개키 한 줄이 아니다. 개인키를 고르지 않았는지 확인할 것.");
    return;
  }
  const defName = `vscode-${os.hostname()}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
  const name = await vscode.window.showInputBox({
    title: "CloudStack 키페어 이름",
    value: defName,
    validateInput: (v) => (/^[A-Za-z0-9._-]{1,64}$/.test(v) ? undefined : "영문·숫자·. _ - 만"),
  });
  if (!name) return;
  const ok = await withClient((c) => c.registerSshKeyPair(name, publicKey)).catch((e: any) => {
    vscode.window.showErrorMessage(`키 등록 실패: ${e.message}`);
    return undefined;
  });
  if (!ok) return;
  const privPath = pubPath.replace(/\.pub$/, "");
  const cfg = vscode.workspace.getConfiguration("cloudstack.ssh");
  const hasPriv = await fs.stat(privPath).then(() => true, () => false);
  const actions = hasPriv && !cfg.get<string>("identityFile") ? ["이 키를 접속에 사용"] : [];
  const sel = await vscode.window.showInformationMessage(
    `키페어 '${name}' 를 등록했다. 새 VM 을 만들 때 고르거나, 중지된 VM 에 'SSH 키 교체' 로 넣을 수 있다.`,
    ...actions
  );
  if (sel) await cfg.update("identityFile", privPath, vscode.ConfigurationTarget.Global);
}

async function resetSshKey(arg: unknown): Promise<void> {
  const item = await resolveItem(arg, (vm) => vm.state === "Stopped");
  if (!item) return;
  if (item.vm.state !== "Stopped") {
    vscode.window.showWarningMessage("CloudStack 은 중지된 VM 에만 키 교체를 허용한다. 먼저 중지할 것.");
    return;
  }
  const pairs = await withClient((c) => c.listSshKeyPairs());
  if (!pairs) return;
  if (!pairs.length) {
    const p = await vscode.window.showInformationMessage("등록된 키페어가 없다.", "공개키 등록");
    if (p) await registerSshKey();
    return;
  }
  const pick = await vscode.window.showQuickPick(
    pairs.map((k) => ({ label: k.name, description: k.fingerprint })),
    { title: `${item.label}: 넣을 키페어` }
  );
  if (!pick) return;
  const ok = await vscode.window
    .withProgress({ location: vscode.ProgressLocation.Notification, title: "SSH 키 교체 중…" }, () =>
      withClient(async (c) => {
        await c.waitForJob(await c.resetSshKey(item.vm.id, pick.label));
        return true;
      })
    )
    .then(
      (v) => v,
      (e: any) => {
        vscode.window.showErrorMessage(`키 교체 실패: ${e.message}`);
        return false;
      }
    );
  if (ok) {
    vscode.window.showInformationMessage(
      `키페어 '${pick.label}' 를 지정했다. VM 을 시작하면 게스트 안에서 키가 적용된다(cloud-init 또는 cloud-set-guest-sshkey 필요).`
    );
  }
  await refresh();
}

async function login(): Promise<void> {
  try {
    const creds = await promptLogin(client?.credentials ?? (await auth.load()), clientOptions());
    if (!creds) return;
    await auth.save(creds);
    await setClient(creds);
    log.info(`로그인: ${creds.endpoint} (${creds.kind === "session" ? creds.username : "API key"})`);
    await refresh();
  } catch (e: any) {
    log.error(e?.stack ?? String(e));
    vscode.window.showErrorMessage(`로그인 실패: ${e.message}`);
  }
}

async function logout(): Promise<void> {
  await client?.logout();
  await auth.clear();
  await setClient(undefined);
  log.info("로그아웃");
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  log = vscode.window.createOutputChannel("CloudStack", { log: true });
  auth = new AuthStore(context.secrets);
  tree = new VmTreeProvider();
  const view = vscode.window.createTreeView("cloudstack.vms", { treeDataProvider: tree, showCollapseAll: false });

  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    log,
    view,
    reg("cloudstack.login", login),
    reg("cloudstack.logout", logout),
    reg("cloudstack.refresh", refresh),
    reg("cloudstack.connect", (a) => connect(a, true)),
    reg("cloudstack.connectCurrentWindow", (a) => connect(a, false)),
    reg("cloudstack.openTerminal", openTerminal),
    reg("cloudstack.copySshCommand", copySshCommand),
    reg("cloudstack.setSshUser", async (a) => {
      const item = await resolveItem(a);
      if (item) await sshUserFor(item.vm, true);
    }),
    reg("cloudstack.startVm", startVm),
    reg("cloudstack.stopVm", stopVm),
    reg("cloudstack.registerSshKey", registerSshKey),
    reg("cloudstack.resetSshKey", resetSshKey),
    reg("cloudstack.exposeSsh", exposeCommand),
    reg("cloudstack.unexposeSsh", unexposeCommand),
    reg("cloudstack.openSshConfig", async () => {
      const p = resolveSshConfigPath();
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(p));
      } catch {
        vscode.window.showInformationMessage(`아직 파일이 없다: ${p}`);
      }
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) void refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("cloudstack.refreshIntervalSeconds")) scheduleAutoRefresh();
      if (e.affectsConfiguration("cloudstack.ssh.jumpHost")) void refresh();
      if (e.affectsConfiguration("cloudstack.expose.allowedCidrs")) {
        try {
          const v = exposeSettings().allowedCidrs;
          if (v) parseCidrList(v);
        } catch (err: any) {
          vscode.window.showErrorMessage(`cloudstack.expose.allowedCidrs: ${err.message}`);
        }
      }
      if (e.affectsConfiguration("cloudstack.allowSelfSignedCertificate") && client) {
        client = new CloudStackClient(client.credentials, clientOptions());
      }
    }),
    { dispose: () => refreshTimer && clearInterval(refreshTimer) }
  );

  await setClient(await auth.load());
  scheduleAutoRefresh();
  if (client && view.visible) await refresh();
}

export function deactivate(): void {
  if (refreshTimer) clearInterval(refreshTimer);
}
