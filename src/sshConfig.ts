import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 사용자 SSH config 안에 이 확장 전용 블록을 두고 그 안만 고친다.
 * Coder 확장이 같은 방식(마커로 감싼 블록)을 쓴다.
 *
 * 보안 원칙: 서버(CloudStack)에서 온 값은 그대로 쓰지 않는다.
 * VM 이름 같은 자유 텍스트는 별칭 생성에만 쓰고 [a-z0-9-] 로 걸러낸다.
 * IP·포트·사용자명·경로는 형식 검증을 통과해야만 쓴다. 줄바꿈이 섞이면
 * ProxyCommand 같은 지시어를 끼워 넣어 로컬에서 임의 명령을 실행시킬 수 있기 때문이다.
 */

export const BLOCK_START =
  "# --- START CLOUDSTACK-VSCODE --- managed by the CloudStack-VSCode extension. Edits inside this block are overwritten.";
export const BLOCK_END = "# --- END CLOUDSTACK-VSCODE ---";
const START_PREFIX = "# --- START CLOUDSTACK-VSCODE ---";
export const ALIAS_PREFIX = "cloudstack--";
const VMID_MARK = "# cloudstack-vm-id ";

export interface HostEntry {
  vmId: string;
  alias: string;
  hostName: string;
  port: number;
  user: string;
  identityFile?: string;
  proxyJump?: string;
}

export class SshConfigValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshConfigValueError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALIAS_RE = /^cloudstack--[a-z0-9-]{1,64}$/;
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;
const HOSTNAME_RE =
  /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const PROXYJUMP_RE = /^[A-Za-z0-9_.@:\[\],%-]+$/;

export function isValidHost(h: string): boolean {
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return v4.slice(1).every((o) => Number(o) <= 255);
  if (h.includes(":")) return /^[0-9A-Fa-f:.]{2,45}$/.test(h);
  return HOSTNAME_RE.test(h);
}

export function makeAlias(vmName: string, vmId: string): string {
  if (!UUID_RE.test(vmId)) throw new SshConfigValueError(`VM id 형식이 아니다: ${vmId}`);
  const slug =
    vmName
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32)
      .replace(/-$/, "") || "vm";
  return `${ALIAS_PREFIX}${slug}-${vmId.replace(/-/g, "").slice(0, 8).toLowerCase()}`;
}

export function validateEntry(e: HostEntry): void {
  if (!UUID_RE.test(e.vmId)) throw new SshConfigValueError(`VM id 형식 오류: ${JSON.stringify(e.vmId)}`);
  if (!ALIAS_RE.test(e.alias)) throw new SshConfigValueError(`별칭 형식 오류: ${JSON.stringify(e.alias)}`);
  if (!isValidHost(e.hostName)) throw new SshConfigValueError(`호스트 주소 형식 오류: ${JSON.stringify(e.hostName)}`);
  if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535)
    throw new SshConfigValueError(`포트 범위 오류: ${e.port}`);
  if (!USER_RE.test(e.user)) throw new SshConfigValueError(`SSH 사용자명 형식 오류: ${JSON.stringify(e.user)}`);
  if (e.identityFile !== undefined) {
    if (!e.identityFile || /[\r\n\0"]/.test(e.identityFile) || e.identityFile.length > 1024)
      throw new SshConfigValueError(`IdentityFile 경로 오류: ${JSON.stringify(e.identityFile)}`);
  }
  if (e.proxyJump !== undefined) {
    if (!PROXYJUMP_RE.test(e.proxyJump) || e.proxyJump.startsWith("-"))
      throw new SshConfigValueError(`점프 호스트 형식 오류: ${JSON.stringify(e.proxyJump)}`);
  }
}

export function renderEntry(e: HostEntry): string[] {
  validateEntry(e);
  const lines = [
    `Host ${e.alias}`,
    `  ${VMID_MARK}${e.vmId}`,
    `  HostName ${e.hostName}`,
    `  Port ${e.port}`,
    `  User ${e.user}`,
    // known_hosts 를 IP 가 아니라 VM 기준으로 저장한다. CloudStack 은 삭제된 VM 의 IP 를
    // 새 VM 에 재할당하므로 IP 기준이면 호스트 키 불일치 경고가 난다.
    `  HostKeyAlias ${e.alias}`,
  ];
  if (e.identityFile) {
    lines.push(`  IdentityFile "${e.identityFile}"`);
    // ssh-agent 에 키가 많으면 MaxAuthTries 를 넘겨 "Too many authentication failures" 로 끊긴다.
    lines.push(`  IdentitiesOnly yes`);
  }
  if (e.proxyJump) lines.push(`  ProxyJump ${e.proxyJump}`);
  return lines;
}

interface ParsedEntry {
  vmId?: string;
  lines: string[];
}

function parseBlock(blockLines: string[]): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  let cur: ParsedEntry | undefined;
  for (const raw of blockLines) {
    if (/^\s*Host\s+/i.test(raw)) {
      cur = { lines: [raw] };
      entries.push(cur);
      continue;
    }
    if (!cur) continue; // 블록 안 Host 이전 줄은 버린다
    if (raw.trim() === "") continue;
    const t = raw.trim();
    if (t.startsWith(VMID_MARK)) cur.vmId = t.slice(VMID_MARK.length).trim();
    cur.lines.push(raw);
  }
  return entries;
}

function findBlock(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((l) => l.trim().startsWith(START_PREFIX));
  if (start < 0) return undefined;
  const rel = lines.slice(start + 1).findIndex((l) => l.trim() === BLOCK_END);
  if (rel < 0) {
    throw new SshConfigValueError(
      "SSH config 에 CloudStack-VSCode 시작 마커만 있고 끝 마커가 없다. 손으로 정리한 뒤 다시 시도할 것."
    );
  }
  return { start, end: start + 1 + rel };
}

/** 블록 안의 (VM id, 별칭) 목록 */
export function listManagedEntries(configText: string): { vmId: string; alias: string }[] {
  const lines = configText.split(/\r?\n/);
  const b = findBlock(lines);
  if (!b) return [];
  return parseBlock(lines.slice(b.start + 1, b.end))
    .filter((e) => !!e.vmId)
    .map((e) => ({ vmId: e.vmId!, alias: e.lines[0].trim().split(/\s+/)[1] ?? "" }));
}

/**
 * 블록 안 항목을 추가/교체하고, keepVmIds 가 주어지면 그 밖의 항목은 지운다.
 * 블록이 없으면 첫 Host/Match 줄 앞에 넣는다. ssh 는 옵션마다 처음 나온 값을 쓰므로
 * 사용자 파일 끝의 `Host *` 보다 앞에 있어야 User 등이 덮이지 않는다. 맨 위 전역 옵션보다
 * 앞에 넣으면 그 전역 옵션이 마지막 Host 에 묶여 버리므로 첫 Host/Match 직전이 맞는 위치다.
 */
export function upsertEntries(
  configText: string,
  upserts: HostEntry[],
  keepVmIds?: Set<string>
): string {
  const eol = configText.includes("\r\n") ? "\r\n" : "\n";
  const lines = configText === "" ? [] : configText.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const block = findBlock(lines);
  const existing = block ? parseBlock(lines.slice(block.start + 1, block.end)) : [];

  const byId = new Map<string, string[]>();
  const order: string[] = [];
  for (const e of existing) {
    if (!e.vmId || !UUID_RE.test(e.vmId)) continue; // 식별 불가 항목은 버린다
    if (!byId.has(e.vmId)) order.push(e.vmId);
    byId.set(e.vmId, e.lines);
  }
  for (const u of upserts) {
    const rendered = renderEntry(u);
    if (!byId.has(u.vmId)) order.push(u.vmId);
    byId.set(u.vmId, rendered);
  }
  const finalIds = order.filter((id) => !keepVmIds || keepVmIds.has(id));

  const blockLines: string[] = [];
  if (finalIds.length) {
    blockLines.push(BLOCK_START);
    finalIds.forEach((id, i) => {
      if (i > 0) blockLines.push("");
      blockLines.push(...byId.get(id)!);
    });
    blockLines.push(BLOCK_END);
  }

  let out: string[];
  if (block) {
    const before = lines.slice(0, block.start);
    let after = lines.slice(block.end + 1);
    if (!blockLines.length && after.length && after[0].trim() === "") after = after.slice(1);
    out = [...before, ...blockLines, ...after];
  } else if (!blockLines.length) {
    out = lines;
  } else {
    const firstHost = lines.findIndex((l) => /^\s*(Host|Match)\s/i.test(l));
    if (firstHost >= 0) {
      out = [...lines.slice(0, firstHost), ...blockLines, "", ...lines.slice(firstHost)];
    } else {
      const sep = lines.length && lines[lines.length - 1].trim() !== "" ? [""] : [];
      out = [...lines, ...sep, ...blockLines];
    }
  }
  return out.length ? out.join(eol) + eol : "";
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function defaultConfigPath(): string {
  return path.join(os.homedir(), ".ssh", "config");
}

/**
 * 원자적으로 파일을 고친다(임시 파일에 쓰고 rename).
 * 심볼릭 링크(dotfiles 관리)면 링크 대상 파일을 고쳐서 링크가 일반 파일로 바뀌지 않게 한다.
 */
export async function editConfigFile(
  filePath: string,
  mutate: (text: string) => string
): Promise<{ changed: boolean; path: string }> {
  let target = filePath;
  try {
    target = await fs.realpath(filePath);
  } catch {
    /* 없는 파일 */
  }
  let text = "";
  let mode = 0o600;
  try {
    text = await fs.readFile(target, "utf8");
    mode = (await fs.stat(target)).mode & 0o777;
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw e;
  }
  const next = mutate(text);
  if (next === text) return { changed: false, path: target };
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.cloudstack-vscode-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tmp, next, { encoding: "utf8", mode });
  try {
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
  return { changed: true, path: target };
}
