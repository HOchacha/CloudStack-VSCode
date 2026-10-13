import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { after, before, test } from "node:test";
import { IP_SNAT, MockServer, startMockCloudStack, vmId } from "./mockCloudStack";

// --- 실제 확장 코드(out/extension.js)를 가짜 vscode 모듈과 가짜 HOME 으로 돌린다 ---
const HOME = mkdtempSync(path.join(os.tmpdir(), "khhome-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "vscode") return require.resolve("./fakeVscode");
  return origResolve.call(this, request, ...rest);
};
const fake = require("./fakeVscode") as typeof import("./fakeVscode");
const ext = require("../extension") as typeof import("../extension");

const CONFIG = path.join(HOME, ".ssh", "config");
const ALIAS1 = "cloudstack--vm-1-00000000";
const ALIAS0 = "cloudstack--vm-0-00000000";
const ALIAS2 = "cloudstack--vm-2-00000000";

let mock: MockServer;
let ctx: ReturnType<typeof fake.makeContext>;

function sshG(alias: string): Record<string, string> {
  const out = execFileSync("ssh", ["-G", "-F", CONFIG, alias], { encoding: "utf8" });
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0 && !(line.slice(0, i) in map)) map[line.slice(0, i)] = line.slice(i + 1);
  }
  return map;
}

function items(): any[] {
  return fake.recorded.treeProvider.getChildren();
}

function vmItem(name: string): any {
  const it = items().find((i) => i.vm?.name === name);
  assert.ok(it, `트리에 ${name} 이 없다`);
  return it;
}

before(async () => {
  mock = await startMockCloudStack();
  fake.installedExtensions.add("ms-vscode-remote.remote-ssh");
  fake.settings["cloudstack.ssh.jumpHost"] = "student@bastion.example.ac.kr";
  ctx = fake.makeContext();
  await ext.activate(ctx as any);
});
after(() => mock.close());

test("활성화 직후에는 로그아웃 상태", () => {
  assert.equal(fake.recorded.contexts["cloudstack.loggedIn"], false);
  assert.deepEqual(items(), []);
});

test("로그인: 주소 → 방식 → 도메인/사용자/비밀번호, 비밀번호는 저장하지 않는다", async () => {
  fake.responders.input = (o) =>
    ({
      "CloudStack 로그인 (1/3): 주소": mock.endpoint,
      "CloudStack 로그인 (3/3): 도메인": "/students",
      "CloudStack 로그인 (3/3): 사용자명": "student",
      "CloudStack 로그인 (3/3): 비밀번호": "pa ss&word",
    })[o.title as string];
  fake.responders.quickPick = (list) => list.find((i: any) => i.value === "session");
  await fake.commands.executeCommand("cloudstack.login");

  assert.equal(fake.recorded.contexts["cloudstack.loggedIn"], true);
  assert.deepEqual(
    items().map((i) => `${i.vm.name}:${i.contextValue}`),
    ["vm-1:vm.running", "vm-2:vm.running", "vm-3:vm.running", "vm-4:vm.running", "vm-0:vm.stopped"]
  );
  const stored = [...ctx._secrets.values()].join("");
  assert.ok(stored.includes("SK123"));
  assert.ok(!stored.includes("pa ss&word"), "비밀번호가 SecretStorage 에 남으면 안 된다");
  assert.equal(fake.settings["cloudstack.endpoint"], mock.endpoint + "/api");
});

test("새 창 접속: 포트포워딩 경로로 SSH config 를 쓰고 Remote-SSH 빈 창을 연다", async () => {
  fake.resetRecorded();
  fake.responders.input = (o) => (/SSH 사용자명/.test(o.title) ? "ubuntu" : undefined);
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-1"));

  const g = sshG(ALIAS1);
  assert.equal(g.hostname, "203.0.113.5");
  assert.equal(g.port, "2201");
  assert.equal(g.user, "ubuntu");
  assert.equal(g.hostkeyalias, ALIAS1);
  assert.equal(g.proxyjump, undefined, "공인 경로에는 점프 호스트를 붙이지 않는다");

  const open = fake.recorded.executed.find((e) => e.id === "vscode.newWindow");
  assert.deepEqual(open?.args[0], { remoteAuthority: `ssh-remote+${ALIAS1}`, reuseWindow: false });
  assert.equal(fake.settings["remote.SSH.remotePlatform"][ALIAS1], "linux");
});

test("현재 창 + openPath: 한 번 정한 사용자는 다시 묻지 않고 vscode.openFolder 로 연다", async () => {
  fake.resetRecorded();
  fake.settings["cloudstack.ssh.openPath"] = "/home/ubuntu/project";
  let asked = 0;
  fake.responders.input = () => {
    asked++;
    return undefined;
  };
  await fake.commands.executeCommand("cloudstack.connectCurrentWindow", vmItem("vm-1"));
  assert.equal(asked, 0);
  const open = fake.recorded.executed.find((e) => e.id === "vscode.openFolder");
  assert.equal(open?.args[0].toString(), `vscode-remote://ssh-remote+${ALIAS1}/home/ubuntu/project`);
  assert.deepEqual(open?.args[1], { forceNewWindow: false });
  delete fake.settings["cloudstack.ssh.openPath"];
});

test("중지된 VM: 시작 확인 → 비동기 작업 대기 → 사설 IP + 점프 호스트로 접속", async () => {
  fake.resetRecorded();
  fake.responders.message = (_l, _t, its) => (its.includes("시작 후 접속") ? "시작 후 접속" : undefined);
  fake.responders.input = (o) => (/SSH 사용자명/.test(o.title) ? "root" : undefined);
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-0"));

  assert.ok(mock.state.seen.some((s) => s.command === "startVirtualMachine"));
  assert.equal(vmItem("vm-0").contextValue, "vm.running");
  const g = sshG(ALIAS0);
  assert.equal(g.hostname, "10.1.1.10");
  assert.equal(g.user, "root");
  assert.equal(g.proxyjump, "student@bastion.example.ac.kr");
  assert.ok(fake.recorded.executed.some((e) => e.id === "vscode.newWindow"));
});

test("SSH 명령 복사", async () => {
  await fake.commands.executeCommand("cloudstack.copySshCommand", vmItem("vm-1"));
  assert.equal(fake.recorded.clipboard, `ssh ${ALIAS1}`);
});

test("Remote-SSH 가 없으면 설치 또는 터미널을 권하고, 터미널은 ssh <별칭> 으로 연다", async () => {
  fake.resetRecorded();
  fake.installedExtensions.clear();
  fake.responders.message = (_l, _t, its) => (its.includes("SSH 터미널로 열기") ? "SSH 터미널로 열기" : undefined);
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-1"));
  assert.equal(fake.recorded.terminals.length, 1);
  assert.equal(fake.recorded.terminals[0].shellPath, "ssh");
  assert.deepEqual(fake.recorded.terminals[0].shellArgs, [ALIAS1]);
  assert.ok(!fake.recorded.executed.some((e) => e.id === "vscode.newWindow"));
  fake.installedExtensions.add("ms-vscode-remote.remote-ssh");
});

// ---------------------------------------------------------------------------
// Isolated 네트워크 VM 을 공인 IP 로 여는 흐름
// 모의 서버의 Source NAT IP 198.51.100.10 에서 22000(포트포워딩), 22001(LB), 22002(방화벽)는 이미 쓰는 중이다.
// ---------------------------------------------------------------------------

const pfCreates = () => mock.state.seen.filter((s) => s.command === "createPortForwardingRule");

test("공인 경로 없는 Isolated VM: 제안 → 허용 대역 입력 → 포트 충돌 재시도 → 포트포워딩+방화벽+태그 → 접속", async () => {
  delete fake.settings["cloudstack.ssh.jumpHost"];
  await fake.commands.executeCommand("cloudstack.refresh");
  fake.resetRecorded();
  mock.state.hiddenConflictPorts = [22003]; // 다른 사용자가 방금 22003 을 잡은 상황
  fake.responders.message = (_l, t, its) => (/포트포워딩을 만들까/.test(t) ? "포트포워딩 만들기" : undefined);
  fake.responders.quickPick = (list, o) => (o?.title === "SSH 를 허용할 출발지" ? list.find((i: any) => i.value === "manual") : undefined);
  fake.responders.input = (o) =>
    o.title === "SSH 허용 대역 (CIDR)" ? "203.0.113.0/24, 192.0.2.7" : /SSH 사용자명/.test(o.title) ? "ubuntu" : undefined;

  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-2"));

  const creates = pfCreates();
  assert.deepEqual(creates.map((c) => c.params.publicport), ["22003", "22004"], "22000-22002 는 건너뛰고, 22003 충돌 뒤 22004");
  assert.ok(creates.every((c) => c.params.openfirewall === "false" && c.params.privateport === "22" && c.params.ipaddressid === IP_SNAT));

  const rule = mock.state.pfRules.find((r) => r.virtualmachineid === vmId(2))!;
  assert.equal(rule.publicport, "22004");
  assert.deepEqual(rule.tags, [
    { key: "cloudstack-vscode-managed", value: "ssh" },
    { key: "cloudstack-vscode-vm", value: vmId(2) },
  ]);
  const fws = mock.state.fwRules.filter((r) => r.startport === "22004");
  assert.equal(fws.length, 1, "출발지 제한 없는 자동 방화벽 규칙이 생기면 안 된다");
  assert.equal(fws[0].cidrlist, "203.0.113.0/24,192.0.2.7/32");
  assert.ok(fws[0].tags?.some((t) => t.key === "cloudstack-vscode-pf" && t.value === rule.id));

  const g = sshG(ALIAS2);
  assert.equal(g.hostname, "198.51.100.10");
  assert.equal(g.port, "22004");
  assert.equal(vmItem("vm-2").contextValue, "vm.running.exposed");
  assert.ok(fake.recorded.executed.some((e) => e.id === "vscode.newWindow"));
});

test("이미 연 VM 에 다시 접속하면 규칙을 새로 만들지 않는다", async () => {
  const before = pfCreates().length;
  fake.resetRecorded();
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-2"));
  assert.equal(pfCreates().length, before);
  assert.ok(fake.recorded.executed.some((e) => e.id === "vscode.newWindow"));
});

test("허용 대역 변경: 기존 방화벽 규칙을 지우고 새 대역으로 만든다", async () => {
  fake.responders.message = (_l, _t, its) => (its.includes("허용 대역 변경") ? "허용 대역 변경" : undefined);
  fake.responders.quickPick = (list) => list.find((i: any) => i.value === "any");
  await fake.commands.executeCommand("cloudstack.exposeSsh", vmItem("vm-2"));
  const fws = mock.state.fwRules.filter((r) => r.startport === "22004");
  assert.equal(fws.length, 1);
  assert.equal(fws[0].cidrlist, "0.0.0.0/0");
});

test("공인 SSH 닫기: 이 확장이 만든 포트포워딩과 방화벽만 지운다", async () => {
  fake.responders.message = (_l, _t, its) => (its.includes("닫기") ? "닫기" : undefined);
  await fake.commands.executeCommand("cloudstack.unexposeSsh", vmItem("vm-2"));
  assert.ok(!mock.state.pfRules.some((r) => r.virtualmachineid === vmId(2)));
  assert.ok(!mock.state.fwRules.some((r) => r.startport === "22004"));
  assert.ok(mock.state.pfRules.some((r) => r.id === "r1") && mock.state.pfRules.some((r) => r.id === "r2"), "다른 규칙은 그대로");
  assert.ok(mock.state.fwRules.some((r) => r.id === "fw-old"));
  assert.equal(vmItem("vm-2").contextValue, "vm.running");
});

test("VPC tier VM 은 만들지 않고 이유를 알린 뒤 사설 IP 로 시도한다", async () => {
  fake.resetRecorded();
  const before = pfCreates().length;
  fake.responders.message = () => undefined;
  fake.responders.input = (o) => (/SSH 사용자명/.test(o.title) ? "ubuntu" : undefined);
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-4"));
  assert.equal(pfCreates().length, before);
  assert.ok(fake.recorded.messages.some((m) => m.level === "warn" && /VPC/.test(m.text)));
  assert.equal(sshG("cloudstack--vm-4-00000000").hostname, "10.1.1.14");
});

test("제안을 닫으면 접속하지 않고, mode=never 면 묻지 않는다", async () => {
  fake.resetRecorded();
  fake.responders.message = () => undefined;
  fake.responders.input = (o) => (/SSH 사용자명/.test(o.title) ? "ubuntu" : undefined);
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-3"));
  assert.ok(fake.recorded.messages.some((m) => /포트포워딩을 만들까/.test(m.text)));
  assert.ok(!fake.recorded.executed.some((e) => e.id === "vscode.newWindow"));

  fake.resetRecorded();
  fake.settings["cloudstack.expose.mode"] = "never";
  await fake.commands.executeCommand("cloudstack.connect", vmItem("vm-3"));
  assert.ok(!fake.recorded.messages.some((m) => /포트포워딩을 만들까/.test(m.text)));
  assert.ok(fake.recorded.executed.some((e) => e.id === "vscode.newWindow"));
  delete fake.settings["cloudstack.expose.mode"];
});

test("서버에서 VM 이 지워지면 새로고침 때 SSH config 항목과 remotePlatform 을 정리한다", async () => {
  mock.state.vms = mock.state.vms.filter((v) => v.name !== "vm-1");
  await fake.commands.executeCommand("cloudstack.refresh");
  const text = readFileSync(CONFIG, "utf8");
  assert.ok(!text.includes(ALIAS1));
  assert.ok(text.includes(ALIAS0));
  assert.equal(fake.settings["remote.SSH.remotePlatform"][ALIAS1], undefined);
});

test("세션이 만료되면 저장된 세션을 지우고 다시 로그인을 권한다", async () => {
  fake.resetRecorded();
  fake.responders.message = () => undefined;
  mock.state.sessionValid = false;
  await fake.commands.executeCommand("cloudstack.refresh");
  assert.equal(fake.recorded.contexts["cloudstack.loggedIn"], false);
  assert.equal(ctx._secrets.size, 0);
  assert.ok(fake.recorded.messages.some((m) => m.level === "error" && m.items.includes("다시 로그인")));
  assert.deepEqual(items(), []);
});
