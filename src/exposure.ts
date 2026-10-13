import type {
  FirewallRule,
  LoadBalancerRule,
  Network,
  PortForwardingRule,
  PublicIpAddress,
  ResourceTagEntry,
  VirtualMachine,
} from "./cloudstack/types";

/**
 * Isolated 네트워크 VM 을 공인 IP 로 SSH 접속할 수 있게 여는 계획을 세운다(순수 함수만).
 *
 * 만드는 것
 * - 포트포워딩: 공인 IP:<빈 포트> → VM:22 (createPortForwardingRule, openfirewall=false)
 * - 방화벽:    공인 IP:<같은 포트> TCP, 사용자가 고른 CIDR 만 허용 (createFirewallRule)
 *
 * openfirewall 을 끄는 이유: 비 VPC 네트워크에서 기본값은 true 이고, 이때 자동으로 만들어지는
 * 방화벽 규칙은 출발지를 제한하지 않는다. createPortForwardingRule 의 cidrlist 는 VPC tier 에서만 쓰인다.
 *
 * 만든 규칙에는 태그(cloudstack-vscode-managed=ssh, cloudstack-vscode-vm=<VM id>, 방화벽에는 cloudstack-vscode-pf=<규칙 id>)를 달아
 * 나중에 이 확장이 만든 것만 찾아 지울 수 있게 한다.
 */

export const TAG_MANAGED = "cloudstack-vscode-managed";
export const TAG_MANAGED_VALUE = "ssh";
export const TAG_VM = "cloudstack-vscode-vm";
export const TAG_PF = "cloudstack-vscode-pf";

export const DEFAULT_PORT_RANGE = "22000-22999";

function hasTag(tags: ResourceTagEntry[] | undefined, key: string, value: string): boolean {
  return !!tags?.some((t) => t.key === key && t.value === value);
}

export function isManagedRule(r: { tags?: ResourceTagEntry[] }): boolean {
  return hasTag(r.tags, TAG_MANAGED, TAG_MANAGED_VALUE);
}

/** 이 확장이 VM 에 만든 SSH 포트포워딩 규칙 */
export function managedRulesFor(vmId: string, rules: PortForwardingRule[]): PortForwardingRule[] {
  return rules.filter((r) => r.virtualmachineid === vmId && isManagedRule(r) && hasTag(r.tags, TAG_VM, vmId));
}

/** PF 규칙에 딸린, 이 확장이 만든 방화벽 규칙 */
export function managedFirewallFor(pfRuleId: string, rules: FirewallRule[]): FirewallRule[] {
  return rules.filter((r) => isManagedRule(r) && hasTag(r.tags, TAG_PF, pfRuleId));
}

export function defaultNetworkId(vm: VirtualMachine): string | undefined {
  const nics = vm.nic ?? [];
  return (nics.find((n) => n.isdefault) ?? nics[0])?.networkid;
}

/** 열 수 없으면 이유를, 열 수 있으면 undefined */
export function notExposableReason(network: Network | undefined): string | undefined {
  if (!network) return "VM 의 네트워크 정보를 찾지 못했다.";
  if (network.vpcid) {
    return `VPC tier(${network.name}) 는 아직 자동으로 열지 않는다. Network ACL 에서 22번 수신을 허용해야 하기 때문이다.`;
  }
  if (network.type !== "Isolated") {
    return `${network.type} 네트워크(${network.name}) 는 대상이 아니다. Shared 네트워크 VM 은 IP 로 바로 라우팅된다.`;
  }
  const svc = new Set((network.service ?? []).map((s) => s.name));
  const missing = ["PortForwarding", "Firewall"].filter((s) => !svc.has(s));
  if (missing.length) return `네트워크 오퍼링에 ${missing.join(", ")} 서비스가 없다.`;
  return undefined;
}

/**
 * 네트워크에 할당된 공인 IP 중 하나를 고른다. Source NAT IP 를 먼저 쓴다(IP 를 새로 할당하지 않기 위해).
 * Static NAT 이 걸린 IP 는 포트포워딩을 걸 수 없으므로 뺀다.
 */
export function pickPublicIp(ips: PublicIpAddress[], networkId: string): PublicIpAddress | undefined {
  const usable = ips.filter(
    (ip) =>
      ip.associatednetworkid === networkId &&
      !ip.isstaticnat &&
      (!ip.state || ip.state === "Allocated")
  );
  return usable.find((ip) => ip.issourcenat) ?? usable[0];
}

export function parsePortRange(s: string): [number, number] {
  const m = s.trim().match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
  if (!m) throw new Error(`포트 범위 형식은 시작-끝 이다 (예: ${DEFAULT_PORT_RANGE}): ${s}`);
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (lo < 1 || hi > 65535 || lo > hi) throw new Error(`포트 범위가 1-65535 를 벗어나거나 거꾸로다: ${s}`);
  return [lo, hi];
}

function toInt(v: string | number | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * 같은 공인 IP 에서 이미 쓰는 공인 포트 구간. 프로토콜과 무관하게 피한다.
 * 기존 방화벽 규칙이 연 포트도 피한다. 그 포트에 포트포워딩을 걸면 기존 규칙의 출발지 대역으로도
 * 열려 버려서, 사용자가 고른 허용 대역이 의미가 없어지기 때문이다.
 */
export function usedPublicPorts(
  ipId: string,
  ipAddress: string,
  pfRules: PortForwardingRule[],
  lbRules: LoadBalancerRule[],
  fwRules: FirewallRule[] = []
): [number, number][] {
  const out: [number, number][] = [];
  for (const r of pfRules) {
    const sameIp = r.ipaddressid ? r.ipaddressid === ipId : r.ipaddress === ipAddress;
    if (!sameIp) continue;
    const lo = toInt(r.publicport);
    const hi = toInt(r.publicendport) ?? lo;
    if (lo !== undefined && hi !== undefined) out.push([lo, hi]);
  }
  for (const r of lbRules) {
    const sameIp = r.publicipid ? r.publicipid === ipId : r.publicip === ipAddress;
    const p = toInt(r.publicport);
    if (sameIp && p !== undefined) out.push([p, p]);
  }
  for (const r of fwRules) {
    const sameIp = r.ipaddressid ? r.ipaddressid === ipId : r.ipaddress === ipAddress;
    if (!sameIp) continue;
    const lo = toInt(r.startport);
    const hi = toInt(r.endport) ?? lo;
    if (lo !== undefined && hi !== undefined) out.push([lo, hi]);
  }
  return out;
}

/** 포트 지정 없이 TCP 전체를 여는 방화벽 규칙(있으면 허용 대역 제한이 효과가 없다) */
export function openAllTcpRules(ipId: string, fwRules: FirewallRule[]): FirewallRule[] {
  return fwRules.filter(
    (r) =>
      (!r.ipaddressid || r.ipaddressid === ipId) &&
      /^(tcp|all)$/i.test(r.protocol ?? "") &&
      toInt(r.startport) === undefined
  );
}

export function findFreePort(range: [number, number], used: [number, number][]): number | undefined {
  for (let p = range[0]; p <= range[1]; p++) {
    if (!used.some(([lo, hi]) => p >= lo && p <= hi)) return p;
  }
  return undefined;
}

export type ExposurePlan =
  | { ok: true; networkId: string; ip: PublicIpAddress; publicPort: number; warning?: string }
  | { ok: false; reason: string };

export function planExposure(args: {
  vm: VirtualMachine;
  network: Network | undefined;
  ips: PublicIpAddress[];
  pfRules: PortForwardingRule[];
  lbRules: LoadBalancerRule[];
  /** 고른 공인 IP 의 방화벽 규칙 */
  fwRules: FirewallRule[];
  portRange: [number, number];
  /** 이번 시도에서 서버가 충돌로 거절한 포트 */
  rejectedPorts?: number[];
}): ExposurePlan {
  const reason = notExposableReason(args.network);
  if (reason) return { ok: false, reason };
  const networkId = args.network!.id;
  const ip = pickPublicIp(args.ips, networkId);
  if (!ip) {
    return { ok: false, reason: `네트워크(${args.network!.name}) 에 쓸 수 있는 공인 IP 가 없다. VM 을 한 번 시작해 네트워크를 구성하거나 UI 에서 IP 를 할당할 것.` };
  }
  const used = usedPublicPorts(ip.id, ip.ipaddress, args.pfRules, args.lbRules, args.fwRules);
  for (const p of args.rejectedPorts ?? []) used.push([p, p]);
  const port = findFreePort(args.portRange, used);
  if (port === undefined) {
    return { ok: false, reason: `${ip.ipaddress} 의 포트 ${args.portRange[0]}-${args.portRange[1]} 가 모두 사용 중이다. cloudstack.expose.portRange 를 넓힐 것.` };
  }
  const openAll = openAllTcpRules(ip.id, args.fwRules);
  const warning = openAll.length
    ? `${ip.ipaddress} 에는 포트를 지정하지 않고 TCP 전체를 여는 방화벽 규칙(${openAll.map((r) => r.cidrlist ?? "?").join(" / ")})이 이미 있다. 이 규칙 때문에 허용 대역 제한이 효과가 없다.`
    : undefined;
  return { ok: true, networkId, ip, publicPort: port, warning };
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/;

/** "203.0.113.0/24, 192.0.2.7" → ["203.0.113.0/24", "192.0.2.7/32"]. 형식이 틀리면 예외. */
export function parseCidrList(s: string): string[] {
  const parts = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) throw new Error("CIDR 을 하나 이상 넣을 것");
  return parts.map((p) => {
    const m = p.match(IPV4);
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255)) throw new Error(`IPv4 CIDR 이 아니다: ${p}`);
    const bits = m[5] === undefined ? 32 : Number(m[5]);
    if (bits > 32) throw new Error(`프리픽스 길이는 0-32: ${p}`);
    return `${m[1]}.${m[2]}.${m[3]}.${m[4]}/${bits}`;
  });
}

/** 서버가 포트 충돌로 거절한 경우인지 (다른 포트로 다시 시도할 가치가 있는지) */
export function isPortConflict(message: string): boolean {
  return /conflict/i.test(message);
}
