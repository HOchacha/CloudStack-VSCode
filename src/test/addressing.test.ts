import { strict as assert } from "assert";
import { test } from "node:test";
import { pickTarget, sshCandidates } from "../addressing";
import type { PortForwardingRule, VirtualMachine } from "../cloudstack/types";

const vm: VirtualMachine = {
  id: "vm-1",
  name: "web",
  state: "Running",
  nic: [
    { ipaddress: "10.0.0.9", isdefault: false },
    { ipaddress: "10.1.1.20", isdefault: true },
  ],
};

const rule = (r: Partial<PortForwardingRule>): PortForwardingRule => ({
  id: "r",
  ipaddress: "203.0.113.5",
  protocol: "tcp",
  privateport: "22",
  publicport: "2201",
  virtualmachineid: "vm-1",
  state: "Active",
  ...r,
});

test("우선순위: Static NAT → 포트포워딩 → 기본 NIC 사설 IP", () => {
  const c = sshCandidates({ ...vm, publicip: "198.51.100.7" }, [rule({})]);
  assert.deepEqual(
    c.map((x) => [x.kind, x.host, x.port]),
    [
      ["staticNat", "198.51.100.7", 22],
      ["portForward", "203.0.113.5", 2201],
      ["private", "10.1.1.20", 22],
    ]
  );
});

test("범위 포트포워딩은 오프셋으로 계산하고, UDP·다른 VM·22 미포함·비활성 규칙은 무시한다", () => {
  const c = sshCandidates(vm, [
    rule({ privateport: "20", privateendport: "30", publicport: "2020", publicendport: "2030" }),
    rule({ protocol: "udp" }),
    rule({ virtualmachineid: "other" }),
    rule({ privateport: "80", publicport: "8080" }),
    rule({ state: "Revoke" }),
  ]);
  assert.deepEqual(c.filter((x) => x.kind === "portForward").map((x) => x.port), [2022]);
});

test("점프 호스트가 있으면 사설 IP 후보에 표시한다", () => {
  const c = sshCandidates(vm, [], { jumpHost: "bastion" });
  assert.equal(c.length, 1);
  assert.equal(c[0].viaJumpHost, true);
});

test("pickTarget 설정별 선택", () => {
  const c = sshCandidates(vm, [rule({})]);
  assert.equal(pickTarget(c, "auto")?.kind, "portForward");
  assert.equal(pickTarget(c, "public")?.kind, "portForward");
  assert.equal(pickTarget(c, "private")?.kind, "private");
  assert.equal(pickTarget(c, "ask"), undefined);
  assert.equal(pickTarget(sshCandidates(vm, []), "public"), undefined);
});
