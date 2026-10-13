import type { PortForwardingRule, VirtualMachine } from "./cloudstack/types";

export type TargetKind = "staticNat" | "portForward" | "private";

export interface SshTarget {
  kind: TargetKind;
  host: string;
  port: number;
  /** private 주소일 때 설정의 점프 호스트를 쓴다 */
  viaJumpHost: boolean;
  label: string;
}

export type AddressPreference = "auto" | "public" | "private" | "ask";

function defaultNicIp(vm: VirtualMachine): string | undefined {
  const nics = vm.nic ?? [];
  const nic = nics.find((n) => n.isdefault) ?? nics[0];
  return nic?.ipaddress;
}

function toInt(s: string | undefined): number | undefined {
  if (s === undefined || s === "") return undefined;
  const n = Number(s);
  return Number.isInteger(n) ? n : undefined;
}

/**
 * VM 의 sshd(기본 22)에 닿는 주소 후보를 우선순위 순으로 만든다.
 * 1) Static NAT 공인 IP  2) 포트포워딩(사설 포트 범위에 22 포함)  3) 기본 NIC 사설 IP
 * 포트포워딩은 범위 규칙(예: 공인 2200-2210 → 사설 22-32)도 오프셋으로 계산한다.
 */
export function sshCandidates(
  vm: VirtualMachine,
  rules: PortForwardingRule[],
  opts: { sshPort?: number; jumpHost?: string } = {}
): SshTarget[] {
  const sshPort = opts.sshPort ?? 22;
  const out: SshTarget[] = [];

  if (vm.publicip) {
    out.push({
      kind: "staticNat",
      host: vm.publicip,
      port: sshPort,
      viaJumpHost: false,
      label: `Static NAT ${vm.publicip}:${sshPort}`,
    });
  }

  for (const r of rules) {
    if (r.virtualmachineid !== vm.id) continue;
    if ((r.protocol ?? "").toLowerCase() !== "tcp") continue;
    if (r.state && !/^(active|add)$/i.test(r.state)) continue;
    const privStart = toInt(r.privateport);
    const privEnd = toInt(r.privateendport) ?? privStart;
    const pubStart = toInt(r.publicport);
    if (privStart === undefined || privEnd === undefined || pubStart === undefined) continue;
    if (sshPort < privStart || sshPort > privEnd) continue;
    const port = pubStart + (sshPort - privStart);
    out.push({
      kind: "portForward",
      host: r.ipaddress,
      port,
      viaJumpHost: false,
      label: `포트포워딩 ${r.ipaddress}:${port} → ${sshPort}`,
    });
  }

  const priv = defaultNicIp(vm);
  if (priv) {
    const viaJumpHost = !!opts.jumpHost;
    out.push({
      kind: "private",
      host: priv,
      port: sshPort,
      viaJumpHost,
      label: viaJumpHost
        ? `사설 IP ${priv}:${sshPort} (점프 호스트 ${opts.jumpHost} 경유)`
        : `사설 IP ${priv}:${sshPort} (같은 네트워크/VPN 에서만 도달)`,
    });
  }
  return out;
}

/** 설정에 따라 후보 하나를 고른다. "ask" 이거나 후보가 없으면 undefined (호출 측이 사용자에게 묻는다). */
export function pickTarget(
  candidates: SshTarget[],
  pref: AddressPreference
): SshTarget | undefined {
  if (pref === "ask") return undefined;
  if (pref === "private") return candidates.find((c) => c.kind === "private");
  if (pref === "public") return candidates.find((c) => c.kind !== "private");
  return candidates[0];
}
