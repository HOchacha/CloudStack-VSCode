import * as vscode from "vscode";
import { sshCandidates, SshTarget } from "./addressing";
import type { PortForwardingRule, VirtualMachine } from "./cloudstack/types";
import { managedRulesFor } from "./exposure";

const STATE_ORDER: Record<string, number> = { Running: 0, Starting: 1, Stopping: 2, Stopped: 3 };

function stateIcon(state: string): vscode.ThemeIcon {
  switch (state) {
    case "Running":
      return new vscode.ThemeIcon("vm-running", new vscode.ThemeColor("testing.iconPassed"));
    case "Starting":
    case "Stopping":
    case "Migrating":
      return new vscode.ThemeIcon("loading~spin");
    case "Stopped":
      return new vscode.ThemeIcon("vm-outline", new vscode.ThemeColor("disabledForeground"));
    case "Error":
      return new vscode.ThemeIcon("vm", new vscode.ThemeColor("testing.iconFailed"));
    default:
      return new vscode.ThemeIcon("vm");
  }
}

function md(text: string): string {
  // 서버에서 온 문자열을 마크다운 툴팁에 넣기 전에 특수문자를 이스케이프한다.
  return text.replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, "\\$&");
}

export class VmItem extends vscode.TreeItem {
  constructor(
    readonly vm: VirtualMachine,
    readonly candidates: SshTarget[],
    readonly managedRules: PortForwardingRule[] = []
  ) {
    super(vm.displayname || vm.name, vscode.TreeItemCollapsibleState.None);
    const best = candidates[0];
    this.id = vm.id;
    this.description = `${vm.state}${best ? " · " + best.host + (best.port !== 22 ? ":" + best.port : "") : ""}`;
    this.iconPath = stateIcon(vm.state);
    // 메뉴 when 절: vm.running / vm.stopped, 이 확장이 연 공인 SSH 가 있으면 .exposed 가 붙는다
    this.contextValue = `vm.${vm.state.toLowerCase()}${managedRules.length ? ".exposed" : ""}`;

    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = false;
    tip.appendMarkdown(`**${md(vm.displayname || vm.name)}** \`${md(vm.state)}\`\n\n`);
    const rows: [string, string | undefined][] = [
      ["이름", vm.name],
      ["ID", vm.id],
      ["Zone", vm.zonename],
      ["템플릿", vm.templatedisplaytext || vm.templatename],
      ["OS", vm.osdisplayname],
      ["Offering", vm.serviceofferingname],
      ["사양", vm.cpunumber && vm.memory ? `${vm.cpunumber} vCPU / ${vm.memory} MiB` : undefined],
      ["SSH 키페어", vm.keypairs || vm.keypair],
      ["계정", vm.project ? `${vm.account} (프로젝트 ${vm.project})` : vm.account],
    ];
    for (const [k, v] of rows) if (v) tip.appendMarkdown(`- ${k}: ${md(String(v))}\n`);
    for (const n of vm.nic ?? []) {
      tip.appendMarkdown(`- NIC: ${md(n.ipaddress ?? "-")} (${md(n.networkname ?? "")}${n.isdefault ? ", 기본" : ""})\n`);
    }
    if (managedRules.length) {
      tip.appendMarkdown(
        `- 공인 SSH(이 확장이 생성): ${managedRules.map((r) => md(`${r.ipaddress}:${r.publicport}`)).join(", ")}\n`
      );
    }
    if (candidates.length) {
      tip.appendMarkdown(`\n**SSH 경로 (우선순위 순)**\n`);
      candidates.forEach((c, i) => tip.appendMarkdown(`${i + 1}. ${md(c.label)}\n`));
    } else {
      tip.appendMarkdown(`\nSSH 로 닿을 주소가 없다.\n`);
    }
    this.tooltip = tip;
  }
}

export class InfoItem extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.contextValue = "info";
  }
}

export class VmTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private vms: VirtualMachine[] = [];
  private rules: PortForwardingRule[] = [];
  private error: string | undefined;
  private loggedIn = false;
  private jumpHost: string | undefined;

  setLoggedOut(): void {
    this.loggedIn = false;
    this.vms = [];
    this.rules = [];
    this.error = undefined;
    this.emitter.fire();
  }

  setData(vms: VirtualMachine[], rules: PortForwardingRule[], jumpHost: string | undefined): void {
    this.loggedIn = true;
    this.vms = vms;
    this.rules = rules;
    this.jumpHost = jumpHost;
    this.error = undefined;
    this.emitter.fire();
  }

  setError(message: string): void {
    this.error = message;
    this.emitter.fire();
  }

  getVms(): VirtualMachine[] {
    return this.vms;
  }

  getRules(): PortForwardingRule[] {
    return this.rules;
  }

  itemFor(vm: VirtualMachine): VmItem {
    return new VmItem(
      vm,
      sshCandidates(vm, this.rules, { jumpHost: this.jumpHost }),
      managedRulesFor(vm.id, this.rules)
    );
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  getChildren(e?: vscode.TreeItem): vscode.TreeItem[] {
    if (e || !this.loggedIn) return []; // 로그인 전에는 viewsWelcome 이 보인다
    const items: vscode.TreeItem[] = [];
    if (this.error) {
      items.push(new InfoItem(this.error, "error", { command: "cloudstack.refresh", title: "새로고침" }));
    }
    if (!this.vms.length && !this.error) {
      items.push(new InfoItem("이 계정에 VM 이 없다", "info"));
    }
    const sorted = [...this.vms].sort(
      (a, b) =>
        (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9) ||
        (a.displayname || a.name).localeCompare(b.displayname || b.name)
    );
    for (const vm of sorted) items.push(this.itemFor(vm));
    return items;
  }
}
