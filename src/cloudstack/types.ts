// CloudStack API 응답 중 이 확장이 쓰는 필드만 정의한다. 버전마다 빠지는 필드가 있어 대부분 optional 이다.

export interface Nic {
  id?: string;
  ipaddress?: string;
  ip6address?: string;
  isdefault?: boolean;
  networkid?: string;
  networkname?: string;
  type?: string;
}

export interface VirtualMachine {
  id: string;
  name: string;
  displayname?: string;
  state: string;
  zonename?: string;
  templatename?: string;
  templatedisplaytext?: string;
  osdisplayname?: string;
  serviceofferingname?: string;
  cpunumber?: number;
  memory?: number;
  nic?: Nic[];
  /** Static NAT 이 켜져 있을 때만 채워진다. */
  publicip?: string;
  publicipid?: string;
  /** 4.17 이전: 단일 키페어 이름 */
  keypair?: string;
  /** 4.17 이후: 쉼표로 구분된 키페어 이름들 */
  keypairs?: string;
  account?: string;
  project?: string;
  created?: string;
}

export interface ResourceTagEntry {
  key: string;
  value: string;
}

export interface PortForwardingRule {
  id: string;
  /** 규칙이 걸린 공인 IP */
  ipaddress: string;
  ipaddressid?: string;
  protocol: string;
  privateport: string;
  privateendport?: string;
  publicport: string;
  publicendport?: string;
  virtualmachineid: string;
  vmguestip?: string;
  state?: string;
  tags?: ResourceTagEntry[];
}

export interface FirewallRule {
  id: string;
  ipaddressid?: string;
  ipaddress?: string;
  protocol: string;
  startport?: string | number;
  endport?: string | number;
  /** 쉼표로 구분된 CIDR */
  cidrlist?: string;
  state?: string;
  tags?: ResourceTagEntry[];
}

export interface LoadBalancerRule {
  id: string;
  publicipid?: string;
  publicip?: string;
  publicport: string;
  privateport?: string;
}

export interface NetworkService {
  name: string;
}

export interface Network {
  id: string;
  name: string;
  /** Isolated / Shared / L2 */
  type: string;
  /** VPC tier 면 채워진다 */
  vpcid?: string;
  cidr?: string;
  service?: NetworkService[];
}

export interface PublicIpAddress {
  id: string;
  ipaddress: string;
  issourcenat?: boolean;
  isstaticnat?: boolean;
  associatednetworkid?: string;
  vpcid?: string;
  state?: string;
}

export interface SshKeyPair {
  id?: string;
  name: string;
  fingerprint?: string;
}

export interface AsyncJobResult {
  jobid: string;
  /** 0 진행 중, 1 성공, 2 실패 */
  jobstatus: number;
  jobresultcode?: number;
  jobresult?: any;
}
