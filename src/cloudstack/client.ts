import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { canonicalQuery, expiresIn, Params, sign } from "./sign";
import type {
  AsyncJobResult,
  FirewallRule,
  LoadBalancerRule,
  Network,
  PortForwardingRule,
  PublicIpAddress,
  SshKeyPair,
  VirtualMachine,
} from "./types";

export interface ApiKeyCredentials {
  kind: "apikey";
  endpoint: string;
  apiKey: string;
  secretKey: string;
}

export interface SessionCredentials {
  kind: "session";
  endpoint: string;
  username: string;
  domain: string;
  sessionKey: string;
  /** login 응답의 Set-Cookie (JSESSIONID, sessionkey 등) */
  cookies: Record<string, string>;
}

export type Credentials = ApiKeyCredentials | SessionCredentials;

export interface ClientOptions {
  /** 학내 CloudStack 처럼 자체서명 인증서를 쓰는 엔드포인트용. 기본 false. */
  allowSelfSigned?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class CloudStackError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly errorCode?: number
  ) {
    super(message);
    this.name = "CloudStackError";
  }
}

/** 세션 만료·키 무효 등 HTTP 401. 다시 로그인해야 한다. */
export class AuthError extends CloudStackError {
  constructor(message: string, httpStatus?: number, errorCode?: number) {
    super(message, httpStatus, errorCode);
    this.name = "AuthError";
  }
}

/**
 * 사용자가 넣는 주소 형태가 제각각이라(관리 UI 주소, /client, /client/api) API 엔드포인트로 맞춘다.
 *   http://cs.example.ac.kr:8080/client  -> http://cs.example.ac.kr:8080/client/api
 *   https://cloud.example.com            -> https://cloud.example.com/client/api
 */
export function normalizeEndpoint(input: string): string {
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) {
    throw new CloudStackError("엔드포인트는 http:// 또는 https:// 로 시작해야 한다: " + input);
  }
  const u = new URL(s);
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/") path = "/client/api";
  else if (path.endsWith("/client")) path = path + "/api";
  else if (!path.endsWith("/api")) path = path + "/client/api";
  u.pathname = path;
  u.search = "";
  u.hash = "";
  return u.toString();
}

interface RawResponse {
  status: number;
  body: string;
  setCookies: string[];
}

function parseSetCookies(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const first = h.split(";")[0];
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function postForm(
  endpoint: string,
  body: string,
  extraHeaders: Record<string, string>,
  opts: ClientOptions
): Promise<RawResponse> {
  const u = new URL(endpoint);
  const isHttps = u.protocol === "https:";
  const mod = isHttps ? https : http;
  const agent = isHttps
    ? new https.Agent({ rejectUnauthorized: !opts.allowSelfSigned })
    : undefined;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body).toString(),
          Accept: "application/json",
          ...extraHeaders,
        },
        timeout: opts.timeoutMs ?? 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const sc = res.headers["set-cookie"];
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [],
          });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("요청 시간 초과: " + u.host)));
    req.on("error", reject);
    req.end(body);
  });
}

/** CloudStack 응답은 최상위 키가 하나다(listvirtualmachinesresponse 등). 이름 규칙이 예외적인 명령이 있어 키 하나면 그대로 쓴다. */
function unwrap(command: string, status: number, text: string): any {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ");
    throw new CloudStackError(
      `JSON 이 아닌 응답 (HTTP ${status}). 엔드포인트 주소를 확인할 것: ${snippet}`,
      status
    );
  }
  const expected = command.toLowerCase() + "response";
  const keys = Object.keys(json ?? {});
  const inner =
    json?.[expected] ?? (keys.length === 1 ? json[keys[0]] : undefined) ?? json;
  const errorCode: number | undefined = inner?.errorcode;
  const errorText: string | undefined = inner?.errortext;
  if (status === 401 || errorCode === 401) {
    throw new AuthError(errorText ?? "인증 실패 (HTTP 401)", status, errorCode);
  }
  if (status >= 400 || errorCode) {
    throw new CloudStackError(
      `${command} 실패 (HTTP ${status}, errorcode ${errorCode ?? "-"}): ${errorText ?? text.slice(0, 200)}`,
      status,
      errorCode
    );
  }
  return inner;
}

/**
 * login API 로 세션을 얻는다.
 * - 서버는 JSESSIONID 와 HttpOnly sessionkey 쿠키를 내려준다.
 * - 이후 요청은 기본 설정(CookieAndParameter)에서 쿠키와 sessionkey 파라미터를 모두 검사하므로 둘 다 보낸다.
 * - domain 은 도메인 경로다. 비우면 ROOT(/) 로 간주된다.
 */
export async function loginWithPassword(
  endpointInput: string,
  username: string,
  password: string,
  domain: string,
  opts: ClientOptions = {}
): Promise<SessionCredentials> {
  const endpoint = normalizeEndpoint(endpointInput);
  const params: Params = { command: "login", username, password, response: "json" };
  if (domain.trim()) params.domain = domain.trim();
  opts.log?.(`login ${username}@${domain || "/"} -> ${endpoint}`);
  const res = await postForm(endpoint, canonicalQuery(params), {}, opts);
  const inner = unwrap("login", res.status, res.body);
  const cookies = parseSetCookies(res.setCookies);
  const sessionKey: string | undefined = inner?.sessionkey ?? cookies["sessionkey"];
  if (!sessionKey) {
    throw new CloudStackError("login 응답에 sessionkey 가 없다. 서버 버전과 설정을 확인할 것.");
  }
  if (!cookies["JSESSIONID"]) {
    throw new CloudStackError("login 응답에 JSESSIONID 쿠키가 없다. 리버스 프록시가 쿠키를 지우는지 확인할 것.");
  }
  return { kind: "session", endpoint, username, domain: domain.trim() || "/", sessionKey, cookies };
}

export class CloudStackClient {
  constructor(private creds: Credentials, private opts: ClientOptions = {}) {}

  get credentials(): Credentials {
    return this.creds;
  }

  async call<T = any>(command: string, params: Params = {}): Promise<T> {
    const all: Params = { ...params, command, response: "json" };
    const headers: Record<string, string> = {};
    let body: string;
    if (this.creds.kind === "apikey") {
      all.apiKey = this.creds.apiKey;
      all.signatureVersion = "3";
      all.expires = expiresIn(600);
      const signature = sign(all, this.creds.secretKey);
      body = canonicalQuery(all) + "&signature=" + encodeURIComponent(signature);
    } else {
      all.sessionkey = this.creds.sessionKey;
      headers.Cookie = cookieHeader(this.creds.cookies);
      body = canonicalQuery(all);
    }
    this.opts.log?.(`-> ${command}`);
    const res = await postForm(this.creds.endpoint, body, headers, this.opts);
    // 세션 모드에서 서버가 쿠키를 갱신하면 따라간다.
    if (this.creds.kind === "session" && res.setCookies.length) {
      this.creds = {
        ...this.creds,
        cookies: { ...this.creds.cookies, ...parseSetCookies(res.setCookies) },
      };
    }
    return unwrap(command, res.status, res.body) as T;
  }

  /**
   * 계정이 볼 수 있는 VM 전부. 프로젝트 소속 자원은 projectid=-1 로 따로 요청해야 나오므로
   * 두 번 조회해 id 로 합친다. 프로젝트 조회 실패는 무시한다.
   */
  async listVirtualMachines(): Promise<VirtualMachine[]> {
    return this.listWithProjects<VirtualMachine>("listVirtualMachines", "virtualmachine");
  }

  /** 포트포워딩 규칙. 버전에 따라 VM 필터 파라미터가 없어서 전부 받아 클라이언트에서 거른다. */
  async listPortForwardingRules(): Promise<PortForwardingRule[]> {
    return this.listWithProjects<PortForwardingRule>("listPortForwardingRules", "portforwardingrule");
  }

  async getNetwork(id: string): Promise<Network | undefined> {
    return (await this.listWithProjects<Network>("listNetworks", "network", { id }))[0];
  }

  /** 네트워크에 할당된 공인 IP (Source NAT IP 포함) */
  async listPublicIpAddresses(networkId: string): Promise<PublicIpAddress[]> {
    return this.listWithProjects<PublicIpAddress>("listPublicIpAddresses", "publicipaddress", {
      associatednetworkid: networkId,
      allocatedonly: "true",
    });
  }

  async listLoadBalancerRules(publicIpId: string): Promise<LoadBalancerRule[]> {
    return this.listWithProjects<LoadBalancerRule>("listLoadBalancerRules", "loadbalancerrule", { publicipid: publicIpId });
  }

  async listFirewallRules(ipAddressId: string): Promise<FirewallRule[]> {
    return this.listWithProjects<FirewallRule>("listFirewallRules", "firewallrule", { ipaddressid: ipAddressId });
  }

  /**
   * 공인 IP:publicPort → VM:privatePort TCP 포트포워딩.
   * openfirewall=false: 비 VPC 에서 기본값 true 는 출발지 제한 없는 방화벽 규칙을 같이 만든다.
   */
  async createPortForwardingRule(p: {
    ipAddressId: string;
    vmId: string;
    publicPort: number;
    privatePort: number;
  }): Promise<PortForwardingRule> {
    return this.runJob<PortForwardingRule>(
      "createPortForwardingRule",
      {
        ipaddressid: p.ipAddressId,
        virtualmachineid: p.vmId,
        protocol: "tcp",
        publicport: String(p.publicPort),
        publicendport: String(p.publicPort),
        privateport: String(p.privatePort),
        privateendport: String(p.privatePort),
        openfirewall: "false",
      },
      "portforwardingrule"
    );
  }

  async createFirewallRule(p: { ipAddressId: string; port: number; cidrs: string[] }): Promise<FirewallRule> {
    return this.runJob<FirewallRule>(
      "createFirewallRule",
      {
        ipaddressid: p.ipAddressId,
        protocol: "tcp",
        startport: String(p.port),
        endport: String(p.port),
        cidrlist: p.cidrs.join(","),
      },
      "firewallrule"
    );
  }

  async deletePortForwardingRule(id: string): Promise<void> {
    await this.runJob("deletePortForwardingRule", { id });
  }

  async deleteFirewallRule(id: string): Promise<void> {
    await this.runJob("deleteFirewallRule", { id });
  }

  /** MAP 파라미터는 tags[0].key=..&tags[0].value=.. 형식이다. */
  async createTags(resourceType: string, resourceIds: string[], tags: Record<string, string>): Promise<void> {
    const params: Params = { resourcetype: resourceType, resourceids: resourceIds.join(",") };
    Object.entries(tags).forEach(([k, v], i) => {
      params[`tags[${i}].key`] = k;
      params[`tags[${i}].value`] = v;
    });
    await this.runJob("createTags", params);
  }

  /** 비동기 명령을 보내고 끝날 때까지 기다려 jobresult(또는 그 안의 field)를 돌려준다. */
  async runJob<T = any>(command: string, params: Params, field?: string): Promise<T> {
    const r = await this.call<any>(command, params);
    if (!r?.jobid) throw new CloudStackError(`${command} 응답에 jobid 가 없다`);
    const done = await this.waitForJob(r.jobid);
    return (field ? done.jobresult?.[field] : done.jobresult) as T;
  }

  private async listWithProjects<T extends { id: string }>(
    command: string,
    field: string,
    base: Params = {}
  ): Promise<T[]> {
    const [own, proj] = await Promise.all([
      this.listAll<T>(command, field, { ...base, listall: "true" }),
      this.listAll<T>(command, field, { ...base, listall: "true", projectid: "-1" }).catch((e) => {
        if (e instanceof AuthError) throw e;
        this.opts.log?.(`${command} projectid=-1 실패(무시): ${e.message}`);
        return [] as T[];
      }),
    ]);
    const byId = new Map<string, T>();
    for (const x of [...own, ...proj]) byId.set(x.id, x);
    return [...byId.values()];
  }

  async listSshKeyPairs(): Promise<SshKeyPair[]> {
    return this.listAll<SshKeyPair>("listSSHKeyPairs", "sshkeypair", { listall: "true" });
  }

  async registerSshKeyPair(name: string, publicKey: string): Promise<SshKeyPair> {
    const r = await this.call<any>("registerSSHKeyPair", { name, publickey: publicKey });
    return r?.keypair ?? r;
  }

  async startVirtualMachine(id: string): Promise<string> {
    return (await this.call<any>("startVirtualMachine", { id })).jobid;
  }

  async stopVirtualMachine(id: string): Promise<string> {
    return (await this.call<any>("stopVirtualMachine", { id })).jobid;
  }

  /** VM 이 Stopped 상태여야 한다(서버가 거부함). */
  async resetSshKey(id: string, keypair: string): Promise<string> {
    return (await this.call<any>("resetSSHKeyForVirtualMachine", { id, keypair })).jobid;
  }

  async logout(): Promise<void> {
    if (this.creds.kind === "session") {
      await this.call("logout").catch(() => undefined);
    }
  }

  /** 250ms 에서 시작해 두 배씩 늘려 maxIntervalMs 까지 기다리며 폴링한다. */
  async waitForJob(
    jobId: string,
    timeoutMs = 10 * 60 * 1000,
    maxIntervalMs = 2000
  ): Promise<AsyncJobResult> {
    const deadline = Date.now() + timeoutMs;
    let intervalMs = Math.min(250, maxIntervalMs);
    for (;;) {
      const r = await this.call<AsyncJobResult>("queryAsyncJobResult", { jobid: jobId });
      if (r.jobstatus === 1) return r;
      if (r.jobstatus === 2) {
        const text = r.jobresult?.errortext ?? JSON.stringify(r.jobresult);
        throw new CloudStackError(`비동기 작업 실패: ${text}`, undefined, r.jobresult?.errorcode);
      }
      if (Date.now() > deadline) throw new CloudStackError(`비동기 작업 시간 초과: ${jobId}`);
      await new Promise((res) => setTimeout(res, intervalMs));
      intervalMs = Math.min(intervalMs * 2, maxIntervalMs);
    }
  }

  /**
   * 첫 요청은 page/pagesize 없이 보내 서버 기본 페이지 크기(default.page.size)만큼 받는다.
   * pagesize 를 임의로 크게 주면 서버 최대값을 넘을 때 오류가 나므로, 남은 페이지는
   * 첫 응답 크기를 pagesize 로 삼아 이어 받는다.
   */
  private async listAll<T>(command: string, field: string, base: Params): Promise<T[]> {
    const first = await this.call<any>(command, base);
    const out: T[] = [...(first?.[field] ?? [])];
    const count: number = first?.count ?? out.length;
    const pageSize = out.length;
    for (let page = 2; pageSize > 0 && out.length < count && page <= 1000; page++) {
      const r = await this.call<any>(command, { ...base, page: String(page), pagesize: String(pageSize) });
      const items: T[] = r?.[field] ?? [];
      if (!items.length) break;
      out.push(...items);
    }
    return out;
  }
}
