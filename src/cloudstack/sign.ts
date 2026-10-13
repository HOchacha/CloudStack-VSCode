import { createHmac } from "crypto";

export type Params = Record<string, string>;

/**
 * 서버(ApiServer.verifyRequest)와 같은 값 인코딩.
 * 서버는 java.net.URLEncoder.encode(value, UTF-8) 후 "+" 를 "%20" 으로 바꾼다.
 * URLEncoder 는 A-Z a-z 0-9 . - * _ 만 그대로 두고 나머지를 %XX 로 바꾼다.
 * encodeURIComponent 는 ! ~ ' ( ) * 를 그대로 두므로, * 를 뺀 ! ~ ' ( ) 를 추가로 인코딩한다.
 */
export function csEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!~'()]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/**
 * 서명 전 문자열(소문자화 전). 서버는 파라미터 이름을 Collections.sort 로 정렬한다.
 * Java String 자연 순서는 UTF-16 코드 단위 비교이고, JS 기본 sort 도 같다.
 * 같은 문자열을 POST 본문으로도 쓴다.
 */
export function canonicalQuery(params: Params): string {
  return Object.keys(params)
    .filter((k) => k.toLowerCase() !== "signature")
    .sort()
    .map((k) => `${k}=${csEncode(params[k])}`)
    .join("&");
}

/** 전체 문자열을 소문자로 바꾼 뒤 secret key 로 HMAC-SHA1, Base64. */
export function sign(params: Params, secretKey: string): string {
  const toSign = canonicalQuery(params).toLowerCase();
  return createHmac("sha1", secretKey).update(toSign).digest("base64");
}

/**
 * signatureVersion=3 의 expires 형식: yyyy-MM-dd'T'HH:mm:ssZ (예: 2026-10-12T07:40:00+0000).
 * 서버는 POST/타임스탬프 강제 설정이 켜져 있으면 expires 가 현재+15분을 넘는 요청을 거부한다.
 */
export function expiresIn(seconds: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() + seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+0000`
  );
}
