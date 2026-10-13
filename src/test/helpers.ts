/** 서버 쪽 java.net.URLEncoder.encode(v, UTF-8).replaceAll("\\+", "%20") 를 바이트 단위로 따로 구현한 기준값 */
export function javaUrlEncode(v: string): string {
  let out = "";
  for (const b of Buffer.from(v, "utf8")) {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9.*_-]/.test(c)) out += c;
    else if (c === " ") out += "+";
    else out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out.replace(/\+/g, "%20");
}
