import { strict as assert } from "assert";
import { after, before, test } from "node:test";
import {
  AuthError,
  CloudStackClient,
  loginWithPassword,
  normalizeEndpoint,
} from "../cloudstack/client";
import { API_KEY, MockServer, SECRET, startMockCloudStack } from "./mockCloudStack";

let mock: MockServer;
before(async () => {
  mock = await startMockCloudStack();
});
after(() => mock.close());

test("엔드포인트 정규화", () => {
  assert.equal(normalizeEndpoint("http://cs.example.ac.kr:8080/client"), "http://cs.example.ac.kr:8080/client/api");
  assert.equal(normalizeEndpoint("http://cs.example.ac.kr:8080/client/"), "http://cs.example.ac.kr:8080/client/api");
  assert.equal(normalizeEndpoint("https://cloud.example.com"), "https://cloud.example.com/client/api");
  assert.equal(normalizeEndpoint(" https://cloud.example.com/client/api?x=1 "), "https://cloud.example.com/client/api");
  assert.throws(() => normalizeEndpoint("cloud.example.com"));
});

test("비밀번호 로그인 → 세션으로 목록 조회(페이지 이어받기)", async () => {
  const creds = await loginWithPassword(mock.endpoint, "student", "pa ss&word", "/students");
  assert.equal(creds.sessionKey, "SK123");
  assert.equal(creds.cookies.JSESSIONID, "JS1");
  const c = new CloudStackClient(creds);
  const vms = await c.listVirtualMachines();
  assert.deepEqual(vms.map((v) => v.name), ["vm-0", "vm-1", "vm-2", "vm-3", "vm-4"]);
  const listCalls = mock.state.seen.filter((s) => s.command === "listVirtualMachines");
  assert.equal(listCalls[0].params.pagesize, undefined, "첫 요청은 pagesize 없이");
  assert.equal(listCalls.at(-1)!.params.pagesize, "2");
  const nonLogin = mock.state.seen.filter((s) => s.command !== "login");
  assert.ok(!nonLogin.some((s) => "password" in s.params), "세션 요청에 비밀번호가 실리면 안 된다");
});

test("잘못된 비밀번호는 AuthError", async () => {
  await assert.rejects(loginWithPassword(mock.endpoint, "student", "wrong", "/students"), AuthError);
});

test("API key 서명 요청(signatureVersion 3) 이 서버 검증을 통과한다", async () => {
  const c = new CloudStackClient({ kind: "apikey", endpoint: normalizeEndpoint(mock.endpoint), apiKey: API_KEY, secretKey: SECRET });
  const rules = await c.listPortForwardingRules();
  assert.equal(rules[0].publicport, "2201");
  const kp = await c.registerSshKeyPair("my key~(1)", "ssh-ed25519 AAAAC3Nz+/= me@pc");
  assert.equal(kp.name, "my key~(1)");
  assert.equal(mock.state.seen.at(-1)!.params.signatureVersion, "3");
});

test("틀린 secret key 는 AuthError", async () => {
  const c = new CloudStackClient({ kind: "apikey", endpoint: normalizeEndpoint(mock.endpoint), apiKey: API_KEY, secretKey: "nope" });
  await assert.rejects(c.listVirtualMachines(), AuthError);
});

test("만료된 세션은 AuthError", async () => {
  const c = new CloudStackClient({
    kind: "session",
    endpoint: normalizeEndpoint(mock.endpoint),
    username: "student",
    domain: "/",
    sessionKey: "OLD",
    cookies: { JSESSIONID: "OLD" },
  });
  await assert.rejects(c.listVirtualMachines(), AuthError);
});

test("비동기 작업 폴링", async () => {
  const creds = await loginWithPassword(mock.endpoint, "student", "pa ss&word", "/students");
  const c = new CloudStackClient(creds);
  mock.state.jobPolls = 0;
  const job = await c.startVirtualMachine("00000000-0000-4000-8000-000000000000");
  const r = await c.waitForJob(job, 5000, 10);
  assert.equal(r.jobstatus, 1);
  assert.equal(mock.state.jobPolls, 2);
});

test("JSON 이 아닌 응답은 주소 확인 안내와 함께 실패", async () => {
  const c = new CloudStackClient({
    kind: "apikey",
    endpoint: mock.endpoint.replace("/client", "/wrong/api"),
    apiKey: API_KEY,
    secretKey: SECRET,
  });
  await assert.rejects(c.call("listZones"), /JSON 이 아닌 응답 \(HTTP 404\)/);
});
