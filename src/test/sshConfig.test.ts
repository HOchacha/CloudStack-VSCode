import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { promises as fs, mkdtempSync } from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import {
  BLOCK_END,
  BLOCK_START,
  editConfigFile,
  HostEntry,
  listManagedEntries,
  makeAlias,
  SshConfigValueError,
  upsertEntries,
} from "../sshConfig";

const ID_A = "6f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const ID_B = "11111111-2222-4333-8444-555555555555";

const entryA: HostEntry = {
  vmId: ID_A,
  alias: makeAlias("Web Server #1", ID_A),
  hostName: "203.0.113.5",
  port: 2201,
  user: "ubuntu",
  identityFile: "/home/me/.ssh/id_ed25519",
};
const entryB: HostEntry = {
  vmId: ID_B,
  alias: makeAlias("db", ID_B),
  hostName: "10.1.1.20",
  port: 22,
  user: "root",
  proxyJump: "student@bastion.example.ac.kr",
};

/** OpenSSH 가 실제로 이 파일을 어떻게 해석하는지 ssh -G 로 확인한다 */
function sshG(configText: string, alias: string): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "khcfg-"));
  const f = path.join(dir, "config");
  require("fs").writeFileSync(f, configText);
  const out = execFileSync("ssh", ["-G", "-F", f, alias], { encoding: "utf8" });
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0 && !(line.slice(0, i) in map)) map[line.slice(0, i)] = line.slice(i + 1);
  }
  return map;
}

test("별칭은 [a-z0-9-] 와 VM id 앞 8자리로 만든다", () => {
  assert.equal(entryA.alias, "cloudstack--web-server-1-6f9c1a2b");
  assert.equal(makeAlias("\nProxyCommand evil", ID_B), "cloudstack--proxycommand-evil-11111111");
  assert.equal(makeAlias("한글이름", ID_B), "cloudstack--vm-11111111");
  assert.throws(() => makeAlias("x", "not-a-uuid"), SshConfigValueError);
});

test("빈 파일에 블록을 만든다", () => {
  const out = upsertEntries("", [entryA]);
  assert.ok(out.startsWith(BLOCK_START + "\n"));
  assert.ok(out.endsWith(BLOCK_END + "\n"));
  assert.deepEqual(listManagedEntries(out), [{ vmId: ID_A, alias: entryA.alias }]);
});

test("전역 옵션 뒤, 첫 Host 앞에 넣어 Host * 보다 먼저 적용된다 (ssh -G 확인)", () => {
  const user = [
    "# 내 설정",
    "ServerAliveInterval 60",
    "",
    "Host github.com",
    "  User git",
    "",
    "Host *",
    "  User root",
    "  Port 2222",
    "",
  ].join("\n");
  const out = upsertEntries(user, [entryA, entryB]);
  const lines = out.split("\n");
  assert.equal(lines.indexOf("ServerAliveInterval 60"), 1, "전역 옵션은 맨 위에 그대로");
  assert.ok(lines.indexOf(BLOCK_START) < lines.indexOf("Host github.com"));

  const a = sshG(out, entryA.alias);
  assert.equal(a.hostname, "203.0.113.5");
  assert.equal(a.port, "2201");
  assert.equal(a.user, "ubuntu", "Host * 의 User root 에 덮이면 안 된다");
  assert.equal(a.hostkeyalias, entryA.alias);
  assert.equal(a.identityfile, "/home/me/.ssh/id_ed25519");
  assert.equal(a.identitiesonly, "yes");
  assert.equal(a.serveraliveinterval, "60", "전역 옵션은 여전히 적용");

  const b = sshG(out, entryB.alias);
  assert.equal(b.hostname, "10.1.1.20");
  assert.equal(b.proxyjump, "student@bastion.example.ac.kr");
  assert.equal(b.user, "root");
});

test("같은 VM 을 다시 기록하면 교체되고, 같은 내용이면 파일이 바뀌지 않는다", () => {
  const once = upsertEntries("Host x\n  User y\n", [entryA]);
  assert.equal(upsertEntries(once, [entryA]), once);
  const moved = upsertEntries(once, [{ ...entryA, hostName: "198.51.100.7", port: 22 }]);
  assert.equal(sshG(moved, entryA.alias).hostname, "198.51.100.7");
  assert.equal((moved.match(/^Host cloudstack--/gm) ?? []).length, 1);
});

test("삭제된 VM 항목을 지우고, 다 지우면 블록도 없앤다", () => {
  const user = "Host x\n  User y\n";
  const both = upsertEntries(user, [entryA, entryB]);
  const onlyB = upsertEntries(both, [], new Set([ID_B]));
  assert.deepEqual(listManagedEntries(onlyB).map((e) => e.vmId), [ID_B]);
  const none = upsertEntries(onlyB, [], new Set());
  assert.equal(none, user);
});

test("CRLF 파일은 CRLF 를 유지한다", () => {
  const out = upsertEntries("Host x\r\n  User y\r\n", [entryA]);
  assert.ok(!/[^\r]\n/.test(out), "LF 단독 줄바꿈이 섞이면 안 된다");
});

test("줄바꿈·이상한 값으로 지시어를 끼워 넣을 수 없다", () => {
  const bad: Partial<HostEntry>[] = [
    { user: "root\n  ProxyCommand touch /tmp/pwned" },
    { hostName: "1.2.3.4\nProxyCommand x" },
    { hostName: "999.1.1.1" },
    { port: 70000 },
    { identityFile: '/tmp/a"\nProxyCommand x' },
    { proxyJump: "-oProxyCommand=x" },
    { proxyJump: "host ProxyCommand" },
    { vmId: "../../etc" },
  ];
  for (const b of bad) {
    assert.throws(() => upsertEntries("", [{ ...entryA, ...b }]), SshConfigValueError, JSON.stringify(b));
  }
});

test("끝 마커 없이 시작 마커만 있으면 고치지 않고 오류", () => {
  assert.throws(() => upsertEntries(BLOCK_START + "\nHost a\n", [entryA]), SshConfigValueError);
});

test("파일 쓰기: 새 파일은 0600, 심볼릭 링크는 링크를 유지하고 대상을 고친다", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "khfile-"));
  const fresh = path.join(dir, "sub", "config");
  await editConfigFile(fresh, (t) => upsertEntries(t, [entryA]));
  assert.equal((await fs.stat(fresh)).mode & 0o777, 0o600);

  const real = path.join(dir, "dotfiles-config");
  await fs.writeFile(real, "Host x\n  User y\n", { mode: 0o644 });
  const link = path.join(dir, "config-link");
  await fs.symlink(real, link);
  const r = await editConfigFile(link, (t) => upsertEntries(t, [entryB]));
  assert.equal(r.path, await fs.realpath(real));
  assert.ok((await fs.lstat(link)).isSymbolicLink());
  assert.ok((await fs.readFile(real, "utf8")).includes(entryB.alias));
  assert.equal((await fs.stat(real)).mode & 0o777, 0o644, "기존 권한 유지");
});
