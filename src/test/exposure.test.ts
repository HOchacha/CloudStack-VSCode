import { strict as assert } from "assert";
import { test } from "node:test";
import type { FirewallRule, Network, PortForwardingRule, PublicIpAddress, VirtualMachine } from "../cloudstack/types";
import {
  findFreePort,
  isPortConflict,
  managedFirewallFor,
  managedRulesFor,
  notExposableReason,
  parseCidrList,
  parsePortRange,
  pickPublicIp,
  planExposure,
  usedPublicPorts,
} from "../exposure";

const services = (...names: string[]) => names.map((name) => ({ name }));
const isoNet: Network = { id: "n1", name: "student-net", type: "Isolated", service: services("SourceNat", "PortForwarding", "Firewall") };
const vm: VirtualMachine = { id: "vm-a", name: "a", state: "Running", nic: [{ ipaddress: "10.1.1.5", isdefault: true, networkid: "n1" }] };

const snat: PublicIpAddress = { id: "ip1", ipaddress: "198.51.100.10", issourcenat: true, associatednetworkid: "n1", state: "Allocated" };
const extra: PublicIpAddress = { id: "ip2", ipaddress: "203.0.113.5", issourcenat: false, associatednetworkid: "n1", state: "Allocated" };

const pf = (r: Partial<PortForwardingRule>): PortForwardingRule => ({
  id: "r",
  ipaddress: "198.51.100.10",
  ipaddressid: "ip1",
  protocol: "tcp",
  privateport: "80",
  publicport: "22000",
  virtualmachineid: "other",
  ...r,
});

test("노출 대상 판별: Isolated 만, VPC·Shared·서비스 없음은 이유와 함께 거절", () => {
  assert.equal(notExposableReason(isoNet), undefined);
  assert.match(notExposableReason(undefined)!, /찾지 못했다/);
  assert.match(notExposableReason({ ...isoNet, vpcid: "v" })!, /VPC/);
  assert.match(notExposableReason({ ...isoNet, type: "Shared" })!, /Shared/);
  assert.match(notExposableReason({ ...isoNet, service: services("SourceNat") })!, /PortForwarding, Firewall/);
});

test("공인 IP 선택: Source NAT 우선, Static NAT·다른 네트워크·해제 중인 IP 제외", () => {
  assert.equal(pickPublicIp([extra, snat], "n1")?.id, "ip1");
  assert.equal(pickPublicIp([{ ...snat, isstaticnat: true }, extra], "n1")?.id, "ip2");
  assert.equal(pickPublicIp([{ ...snat, associatednetworkid: "n2" }], "n1"), undefined);
  assert.equal(pickPublicIp([{ ...snat, state: "Releasing" }], "n1"), undefined);
});

test("사용 중 포트: 같은 IP 의 포트포워딩 범위·로드밸런서·방화벽 규칙, ipaddressid 없으면 주소로 비교", () => {
  const used = usedPublicPorts(
    "ip1",
    "198.51.100.10",
    [
      pf({ publicport: "22000", publicendport: "22002" }),
      pf({ ipaddressid: undefined, publicport: "22005" }),
      pf({ ipaddressid: "ip2", ipaddress: "203.0.113.5", publicport: "22003" }),
    ],
    [{ id: "lb", publicipid: "ip1", publicport: "22003" }],
    [{ id: "fw", ipaddressid: "ip1", protocol: "tcp", startport: "22004", endport: "22004" }]
  );
  assert.deepEqual(used, [
    [22000, 22002],
    [22005, 22005],
    [22003, 22003],
    [22004, 22004],
  ]);
  assert.equal(findFreePort([22000, 22999], used), 22006);
  assert.equal(findFreePort([22000, 22002], used), undefined);
});

test("계획: 거절된 포트는 건너뛰고, 범위가 차면 이유를 돌려준다", () => {
  const base = { vm, network: isoNet, ips: [snat], pfRules: [pf({})], lbRules: [], fwRules: [] as FirewallRule[] };
  const p1 = planExposure({ ...base, portRange: [22000, 22999] });
  assert.ok(p1.ok && p1.publicPort === 22001 && p1.ip.id === "ip1");
  const p2 = planExposure({ ...base, portRange: [22000, 22999], rejectedPorts: [22001] });
  assert.ok(p2.ok && p2.publicPort === 22002);
  const p3 = planExposure({ ...base, portRange: [22000, 22000] });
  assert.ok(!p3.ok && /모두 사용 중/.test(p3.reason));
  const p4 = planExposure({ ...base, ips: [], portRange: [22000, 22999] });
  assert.ok(!p4.ok && /공인 IP 가 없다/.test(p4.reason));
});

test("포트 지정 없이 TCP 전체를 여는 방화벽 규칙이 있으면 경고한다", () => {
  const p = planExposure({
    vm,
    network: isoNet,
    ips: [snat],
    pfRules: [],
    lbRules: [],
    fwRules: [{ id: "all", ipaddressid: "ip1", protocol: "tcp", cidrlist: "0.0.0.0/0" }],
    portRange: [22000, 22999],
  });
  assert.ok(p.ok && /허용 대역 제한이 효과가 없다/.test(p.warning ?? ""));
});

test("포트 범위·CIDR 파싱", () => {
  assert.deepEqual(parsePortRange(" 22000 - 22999 "), [22000, 22999]);
  for (const bad of ["22000", "0-10", "100-50", "1-70000", "a-b"]) assert.throws(() => parsePortRange(bad), Error, bad);
  assert.deepEqual(parseCidrList("203.0.113.0/24, 192.0.2.7 ,0.0.0.0/0"), ["203.0.113.0/24", "192.0.2.7/32", "0.0.0.0/0"]);
  for (const bad of ["", "300.1.1.1", "1.2.3.4/33", "10.0.0.0/8\nx", "::1/128", "1.2.3"]) {
    assert.throws(() => parseCidrList(bad), Error, JSON.stringify(bad));
  }
});

test("이 확장이 만든 규칙만 태그로 고른다", () => {
  const mine = pf({ id: "m", virtualmachineid: "vm-a", tags: [{ key: "cloudstack-vscode-managed", value: "ssh" }, { key: "cloudstack-vscode-vm", value: "vm-a" }] });
  const manual = pf({ id: "u", virtualmachineid: "vm-a" });
  const otherVm = pf({ id: "o", virtualmachineid: "vm-b", tags: [{ key: "cloudstack-vscode-managed", value: "ssh" }, { key: "cloudstack-vscode-vm", value: "vm-b" }] });
  assert.deepEqual(managedRulesFor("vm-a", [mine, manual, otherVm]).map((r) => r.id), ["m"]);
  const fws: FirewallRule[] = [
    { id: "f1", protocol: "tcp", tags: [{ key: "cloudstack-vscode-managed", value: "ssh" }, { key: "cloudstack-vscode-pf", value: "m" }] },
    { id: "f2", protocol: "tcp", tags: [{ key: "cloudstack-vscode-pf", value: "m" }] },
    { id: "f3", protocol: "tcp" },
  ];
  assert.deepEqual(managedFirewallFor("m", fws).map((r) => r.id), ["f1"]);
});

test("포트 충돌 오류 판별 (FirewallManagerImpl 메시지)", () => {
  assert.ok(isPortConflict("비동기 작업 실패: The range specified, 22003-22003, conflicts with rule 5 which has 22003-22003"));
  assert.ok(!isPortConflict("비동기 작업 실패: Unable to find ip address"));
});
