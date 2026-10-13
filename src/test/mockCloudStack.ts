import { createHmac } from "crypto";
import * as http from "http";
import { AddressInfo } from "net";
import type {
  FirewallRule,
  LoadBalancerRule,
  Network,
  PortForwardingRule,
  PublicIpAddress,
  ResourceTagEntry,
  VirtualMachine,
} from "../cloudstack/types";
import { javaUrlEncode } from "./helpers";

/**
 * CloudStack 관리 서버 흉내. 인증 규칙은 ApiServlet/ApiServer 소스와 같게 구현한다.
 * - login: JSESSIONID + HttpOnly sessionkey 쿠키, 응답 본문에 sessionkey
 * - 세션 요청: 쿠키와 sessionkey 파라미터 모두 검사(기본값 CookieAndParameter)
 * - API key 요청: 이름 대소문자 구분 정렬 → URLEncoder 인코딩 → 소문자 → HMAC-SHA1
 *   signatureVersion=3 이면 expires 가 현재 이후, 현재+15분 이내
 * - 목록: 기본 페이지 크기 2, pagesize 가 2 를 넘으면 오류
 */
export const API_KEY = "testApiKey";
export const SECRET = "testSecret~*";
export const DEFAULT_PAGE = 2;

export const NET_ISO = "net-iso";
export const NET_VPC = "net-vpc-tier";
export const IP_SNAT = "ip-snat";
export const IP_EXTRA = "ip-extra";

export const vmId = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;

/**
 * vm-0: 중지, Isolated   vm-1: 실행, Isolated, 별도 공인 IP 에 22번 포트포워딩(태그 없음)
 * vm-2, vm-3: 실행, Isolated, 공인 경로 없음   vm-4: 실행, VPC tier
 */
export function makeVms(): VirtualMachine[] {
  return Array.from({ length: 5 }, (_, i) => ({
    id: vmId(i),
    name: `vm-${i}`,
    state: i === 0 ? "Stopped" : "Running",
    zonename: "zone1",
    nic: [{ ipaddress: `10.1.1.${10 + i}`, isdefault: true, networkid: i === 4 ? NET_VPC : NET_ISO }],
  }));
}

const isolatedServices = () =>
  ["SourceNat", "StaticNat", "PortForwarding", "Firewall", "Lb"].map((name) => ({ name }));

export interface MockState {
  vms: VirtualMachine[];
  networks: Network[];
  publicIps: PublicIpAddress[];
  pfRules: PortForwardingRule[];
  fwRules: FirewallRule[];
  lbRules: LoadBalancerRule[];
  /** 다른 사용자가 먼저 잡은 것처럼 서버가 충돌로 거절할 포트 */
  hiddenConflictPorts: number[];
  sessionValid: boolean;
  jobPolls: number;
  seen: { command: string; params: Record<string, string> }[];
}

function initialState(): MockState {
  return {
    vms: makeVms(),
    networks: [
      { id: NET_ISO, name: "student-net", type: "Isolated", cidr: "10.1.1.0/24", service: isolatedServices() },
      { id: NET_VPC, name: "tier-web", type: "Isolated", vpcid: "vpc-1", cidr: "10.2.1.0/24", service: isolatedServices() },
    ],
    publicIps: [
      { id: IP_SNAT, ipaddress: "198.51.100.10", issourcenat: true, isstaticnat: false, associatednetworkid: NET_ISO, state: "Allocated" },
      { id: IP_EXTRA, ipaddress: "203.0.113.5", issourcenat: false, isstaticnat: false, associatednetworkid: NET_ISO, state: "Allocated" },
    ],
    pfRules: [
      // vm-1 의 기존 SSH (태그 없음 → 확장이 만든 것이 아님)
      { id: "r1", ipaddress: "203.0.113.5", ipaddressid: IP_EXTRA, protocol: "tcp", privateport: "22", privateendport: "22", publicport: "2201", publicendport: "2201", virtualmachineid: vmId(1), state: "Active" },
      // Source NAT IP 의 22000 은 vm-3 웹서버가 쓰고 있다
      { id: "r2", ipaddress: "198.51.100.10", ipaddressid: IP_SNAT, protocol: "tcp", privateport: "80", privateendport: "80", publicport: "22000", publicendport: "22000", virtualmachineid: vmId(3), state: "Active" },
    ],
    // 22001 은 로드밸런서, 22002 는 누군가 열어 둔 방화벽 규칙
    lbRules: [{ id: "lb1", publicipid: IP_SNAT, publicip: "198.51.100.10", publicport: "22001", privateport: "8080" }],
    fwRules: [{ id: "fw-old", ipaddressid: IP_SNAT, ipaddress: "198.51.100.10", protocol: "tcp", startport: "22002", endport: "22002", cidrlist: "0.0.0.0/0", state: "Active" }],
    hiddenConflictPorts: [],
    sessionValid: true,
    jobPolls: 0,
    seen: [],
  };
}

export interface MockServer {
  endpoint: string;
  state: MockState;
  close(): Promise<void>;
}

function reply(
  res: http.ServerResponse,
  status: number,
  key: string,
  body: object,
  headers: Record<string, string | string[]> = {}
) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ [key]: body }));
}

function verifySignature(p: Record<string, string>): boolean {
  if (p.apiKey !== API_KEY || !p.signature) return false;
  const unsigned = Object.keys(p)
    .filter((k) => k.toLowerCase() !== "signature")
    .sort()
    .map((k) => `${k}=${javaUrlEncode(p[k])}`)
    .join("&")
    .toLowerCase();
  const expected = createHmac("sha1", SECRET).update(unsigned).digest("base64");
  if (expected !== p.signature) return false;
  if (p.signatureVersion === "3") {
    const m = p.expires?.match(/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\+0000$/);
    if (!m) return false;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (t < Date.now() || t > Date.now() + 15 * 60 * 1000) return false;
  }
  return true;
}

function cookiesOf(req: http.IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k) out[k] = v.join("=");
  }
  return out;
}

let seq = 0;
const newId = (prefix: string) => `${prefix}-${++seq}`;

function parseTags(p: Record<string, string>): ResourceTagEntry[] {
  const out: ResourceTagEntry[] = [];
  for (let i = 0; p[`tags[${i}].key`] !== undefined; i++) out.push({ key: p[`tags[${i}].key`], value: p[`tags[${i}].value`] });
  return out;
}

function overlaps(a: [number, number], b: [number, number]) {
  return a[0] <= b[1] && b[0] <= a[1];
}

export async function startMockCloudStack(): Promise<MockServer> {
  const state: MockState = initialState();
  /** jobid → 완료 결과. 첫 조회는 진행 중으로 답한다. */
  const jobs = new Map<string, { polls: number; status: 1 | 2; result: any }>();
  const job = (status: 1 | 2, result: any) => {
    const id = newId("job");
    jobs.set(id, { polls: 0, status, result });
    return id;
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/client/api") {
        res.writeHead(404).end("<html>not found</html>");
        return;
      }
      const p = Object.fromEntries(new URLSearchParams(body));
      const command = p.command;
      const key = command.toLowerCase() + "response";
      state.seen.push({ command, params: p });

      if (command === "login") {
        if (p.username === "student" && p.password === "pa ss&word" && p.domain === "/students") {
          state.sessionValid = true;
          reply(res, 200, "loginresponse", { sessionkey: "SK123", username: "student" }, {
            "Set-Cookie": [
              "JSESSIONID=JS1; Path=/client; HttpOnly",
              "sessionkey=SK123; Path=/client; HttpOnly; SameSite=Lax",
            ],
          });
        } else {
          reply(res, 401, "loginresponse", { errorcode: 401, errortext: "Failed to authenticate user" });
        }
        return;
      }

      const ck = cookiesOf(req);
      const sessionOk =
        state.sessionValid && ck.JSESSIONID === "JS1" && ck.sessionkey === "SK123" && p.sessionkey === "SK123";
      if (!sessionOk && !verifySignature(p)) {
        reply(res, 401, key, { errorcode: 401, errortext: "unable to verify user credentials" });
        return;
      }

      const filterBy = <T>(items: T[], pairs: [string, keyof T][]) =>
        items.filter((x) => pairs.every(([param, field]) => p[param] === undefined || (x as any)[field] === p[param]));
      const list = (field: string, items: any[]) => reply(res, 200, key, { count: items.length, [field]: items });

      switch (command) {
        case "listVirtualMachines": {
          if (p.pagesize && +p.pagesize > DEFAULT_PAGE) {
            reply(res, 431, key, { errorcode: 431, errortext: "Page size can't exceed max allowed page size value: 2" });
            return;
          }
          const size = p.pagesize ? +p.pagesize : DEFAULT_PAGE;
          const page = p.page ? +p.page : 1;
          reply(res, 200, key, {
            count: state.vms.length,
            virtualmachine: state.vms.slice((page - 1) * size, page * size),
          });
          return;
        }
        case "listPortForwardingRules":
          list("portforwardingrule", filterBy(state.pfRules, [["ipaddressid", "ipaddressid"]]));
          return;
        case "listNetworks":
          list("network", filterBy(state.networks, [["id", "id"]]));
          return;
        case "listPublicIpAddresses":
          list("publicipaddress", filterBy(state.publicIps, [["associatednetworkid", "associatednetworkid"]]));
          return;
        case "listLoadBalancerRules":
          list("loadbalancerrule", filterBy(state.lbRules, [["publicipid", "publicipid"]]));
          return;
        case "listFirewallRules":
          list("firewallrule", filterBy(state.fwRules, [["ipaddressid", "ipaddressid"]]));
          return;
        case "createPortForwardingRule": {
          const ip = state.publicIps.find((x) => x.id === p.ipaddressid);
          const range: [number, number] = [+p.publicport, +(p.publicendport ?? p.publicport)];
          const clash =
            state.hiddenConflictPorts.includes(range[0]) ||
            state.pfRules.some((r) => r.ipaddressid === p.ipaddressid && overlaps(range, [+r.publicport, +(r.publicendport ?? r.publicport)]));
          if (!ip || !p.virtualmachineid || !p.privateport || p.protocol !== "tcp") {
            reply(res, 431, key, { errorcode: 431, errortext: "missing parameter" });
            return;
          }
          if (clash) {
            state.hiddenConflictPorts = state.hiddenConflictPorts.filter((x) => x !== range[0]);
            reply(res, 200, key, { id: newId("pf"), jobid: job(2, { errorcode: 537, errortext: `The range specified, ${range[0]}-${range[1]}, conflicts with rule X which has ${range[0]}-${range[1]}` }) });
            return;
          }
          const rule: PortForwardingRule = {
            id: newId("pf"),
            ipaddress: ip.ipaddress,
            ipaddressid: ip.id,
            protocol: "tcp",
            privateport: p.privateport,
            privateendport: p.privateendport ?? p.privateport,
            publicport: p.publicport,
            publicendport: p.publicendport ?? p.publicport,
            virtualmachineid: p.virtualmachineid,
            state: "Active",
            tags: [],
          };
          state.pfRules.push(rule);
          // openfirewall 기본값(true)이면 출발지 제한 없는 방화벽 규칙이 같이 생긴다 (비 VPC)
          if (p.openfirewall !== "false") {
            state.fwRules.push({ id: newId("fw"), ipaddressid: ip.id, ipaddress: ip.ipaddress, protocol: "tcp", startport: p.publicport, endport: p.publicendport ?? p.publicport, cidrlist: "0.0.0.0/0", tags: [] });
          }
          reply(res, 200, key, { id: rule.id, jobid: job(1, { portforwardingrule: rule }) });
          return;
        }
        case "createFirewallRule": {
          const ip = state.publicIps.find((x) => x.id === p.ipaddressid);
          const rule: FirewallRule = {
            id: newId("fw"),
            ipaddressid: p.ipaddressid,
            ipaddress: ip?.ipaddress,
            protocol: p.protocol,
            startport: p.startport,
            endport: p.endport,
            cidrlist: p.cidrlist,
            state: "Active",
            tags: [],
          };
          state.fwRules.push(rule);
          reply(res, 200, key, { id: rule.id, jobid: job(1, { firewallrule: rule }) });
          return;
        }
        case "deletePortForwardingRule":
          state.pfRules = state.pfRules.filter((r) => r.id !== p.id);
          reply(res, 200, key, { jobid: job(1, { success: true }) });
          return;
        case "deleteFirewallRule":
          state.fwRules = state.fwRules.filter((r) => r.id !== p.id);
          reply(res, 200, key, { jobid: job(1, { success: true }) });
          return;
        case "createTags": {
          const pool: { id: string; tags?: ResourceTagEntry[] }[] =
            p.resourcetype === "PortForwardingRule" ? state.pfRules : p.resourcetype === "FirewallRule" ? state.fwRules : [];
          for (const id of (p.resourceids ?? "").split(",")) {
            const r = pool.find((x) => x.id === id);
            if (r) r.tags = [...(r.tags ?? []), ...parseTags(p)];
          }
          reply(res, 200, key, { jobid: job(1, { success: true }) });
          return;
        }
        case "startVirtualMachine": {
          const vm = state.vms.find((v) => v.id === p.id);
          if (vm) vm.state = "Running";
          reply(res, 200, key, { jobid: job(1, {}) });
          return;
        }
        case "stopVirtualMachine": {
          const vm = state.vms.find((v) => v.id === p.id);
          if (vm) vm.state = "Stopped";
          reply(res, 200, key, { jobid: job(1, {}) });
          return;
        }
        case "queryAsyncJobResult": {
          state.jobPolls++;
          const j = jobs.get(p.jobid);
          if (!j) {
            reply(res, 431, key, { errorcode: 431, errortext: "no such job" });
            return;
          }
          j.polls++;
          reply(res, 200, key, j.polls < 2 ? { jobid: p.jobid, jobstatus: 0 } : { jobid: p.jobid, jobstatus: j.status, jobresult: j.result });
          return;
        }
        case "registerSSHKeyPair":
          // 응답 키 이름이 명령 소문자와 다를 때도 처리하는지 본다
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ registerSSHKeyPairResponse: { keypair: { name: p.name, fingerprint: "aa:bb" } } }));
          return;
        default:
          reply(res, 200, key, {});
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/client`,
    state,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
