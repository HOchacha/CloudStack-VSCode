import { strict as assert } from "assert";
import { test } from "node:test";
import { canonicalQuery, csEncode, expiresIn, sign } from "../cloudstack/sign";
import { javaUrlEncode } from "./helpers";


test("공식 문서 서명 예제와 같은 값이 나온다", () => {
  // docs.cloudstack.apache.org Developer's Guide "Signing API Requests" 의 Python 예제
  const params = {
    apiKey: "plgWJfZK4gyS3mOMTVmjUVg-X-jlWlnfaUJ9GAbBbf9EdM-kAYMmAiLqzzq1ElZLYq_u38zCm0bewzGUdP66mg",
    command: "listUsers",
    response: "json",
  };
  const secret = "VDaACYb0LV9eNjTetIOElcVQkvJck_J_QljX_FcHRj87ZKiy0z0ty0ZsYBkoXkY9b7eq1EhwJaw7FF3akA3KBQ";
  assert.equal(sign(params, secret), "TTpdDq/7j/J58XCRHomKoQXEQds=");
});

test("값 인코딩이 Java URLEncoder + %20 치환과 같다", () => {
  const samples = [
    "hello world",
    "a+b=c&d/e?f",
    "~tilde*star!bang'quote(paren)",
    "한글 키페어",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGxx+/= user@host",
    "emoji 🚀",
    "",
  ];
  for (const s of samples) assert.equal(csEncode(s), javaUrlEncode(s), JSON.stringify(s));
});

test("정렬은 대소문자 구분(Java Collections.sort)이고 signature 는 뺀다", () => {
  const q = canonicalQuery({ response: "json", Zeta: "1", apiKey: "k", command: "x", signature: "s" });
  assert.equal(q, "Zeta=1&apiKey=k&command=x&response=json");
});

test("expires 형식은 yyyy-MM-ddTHH:mm:ss+0000", () => {
  const e = expiresIn(600, new Date(Date.UTC(2026, 9, 12, 7, 30, 5)));
  assert.equal(e, "2026-10-12T07:40:05+0000");
});
