# CloudStack-VSCode (프로토타입)

VS Code 에서 CloudStack 계정으로 로그인하면 내 VM 목록이 사이드바에 나오고, 클릭 한 번으로 Remote-SSH 원격 창을 연다.

## 동작 방식

```
[CloudStack 사이드바] --login / 서명 API--> [CloudStack 관리 서버]
        │ listVirtualMachines, listPortForwardingRules
        ▼
접속 클릭 → SSH 경로 선택 → ~/.ssh/config 의 CloudStack-VSCode 블록에 Host 항목 기록
        ▼
vscode.newWindow / vscode.openFolder (authority = ssh-remote+<별칭>)
        ▼
Remote - SSH 확장이 ssh 로 VM 에 접속하고 VS Code Server 설치
```

이 확장은 SSH 연결을 직접 하지 않는다. 별칭을 SSH config 에 써 두고 Remote-SSH 에 넘긴다. Coder 의 VS Code 확장과 같은 구조다.

## 설치

1. VS Code → 확장 → `…` → **VSIX에서 설치…** → `cloudstack-vscode-0.3.0.vsix`
2. **Remote - SSH**(`ms-vscode-remote.remote-ssh`) 설치. 없으면 접속할 때 설치를 권하고, 대신 SSH 터미널로 열 수도 있다.

## 사용

1. 왼쪽 Activity Bar 의 CloudStack 아이콘 → **로그인**
   - 주소: 관리 UI 주소(`http://host:8080/client`)를 그대로 넣어도 된다.
   - 방식: 사용자명/비밀번호(UI 로그인과 같음) 또는 API Key/Secret Key.
2. VM 행의 `$(remote)` 버튼 → 새 창에서 접속. 우클릭 메뉴에 현재 창 접속, SSH 터미널, 명령 복사, 시작/중지, SSH 키 교체가 있다.
3. 처음 접속할 때 SSH 사용자명을 묻고 VM 별로 기억한다.

### SSH 경로 선택 규칙

| 순서 | 경로 | 조건 |
|---|---|---|
| 1 | Static NAT 공인 IP:22 | VM 에 Static NAT 이 켜져 있음 |
| 2 | 포트포워딩 공인 IP:포트 | TCP 규칙의 사설 포트 범위에 22 포함 (범위 규칙은 오프셋 계산) |
| 3 | 기본 NIC 사설 IP:22 | 같은 네트워크/VPN 이거나 `cloudstack.ssh.jumpHost` 로 점프 호스트 지정 |

`cloudstack.ssh.addressPreference` 로 바꿀 수 있다(`auto`/`public`/`private`/`ask`).

### Isolated 네트워크 VM 을 공인 IP 로 열기

1·2번 경로가 없고 점프 호스트도 없으면, 접속할 때 네트워크 공인 IP 에 SSH 를 열지 묻는다(`cloudstack.expose.mode`). 우클릭 **공인 IP 로 SSH 열기**로 직접 열 수도 있다.

1. VM 기본 NIC 의 네트워크가 Isolated(VPC tier 아님)이고 PortForwarding·Firewall 서비스가 있는지 확인한다.
2. 그 네트워크의 공인 IP 를 고른다. Source NAT IP 를 먼저 쓰고(새 IP 를 할당하지 않는다), Static NAT 이 걸린 IP 는 뺀다.
3. `cloudstack.expose.portRange`(기본 22000-22999)에서 빈 포트를 고른다. 같은 IP 의 포트포워딩·로드밸런서·방화벽 규칙이 쓰는 포트는 건너뛴다. 기존 방화벽 규칙이 연 포트를 피하는 이유는, 그 포트에 포트포워딩을 걸면 기존 규칙의 출발지로도 열려서 고른 허용 대역이 의미가 없어지기 때문이다.
4. 허용할 출발지를 묻는다: 내 현재 공인 IP(api.ipify.org 로 확인) / 대역 직접 입력 / 전체(0.0.0.0/0). `cloudstack.expose.allowedCidrs` 를 정해 두면 묻지 않는다.
5. `createPortForwardingRule`(공인 IP:포트 → VM:22, `openfirewall=false`) 후 `createFirewallRule`(그 포트, 고른 CIDR 만). 비 VPC 네트워크에서 `openfirewall` 기본값은 true 이고 이때 자동 생성되는 방화벽 규칙은 출발지를 제한하지 않는다. `createPortForwardingRule` 의 `cidrlist` 는 VPC tier 에서만 쓰인다. 그래서 둘을 나눠 만든다.
6. 서버가 포트 충돌로 거절하면 다음 포트로 다시 시도한다(최대 5회). 방화벽 생성이 실패하면 만든 포트포워딩을 지운다.
7. 두 규칙에 태그(`cloudstack-vscode-managed=ssh`, `cloudstack-vscode-vm=<VM id>`, 방화벽에는 `cloudstack-vscode-pf=<규칙 id>`)를 단다. **공인 SSH 닫기**와 **허용 대역 변경**은 이 태그가 있는 규칙만 건드린다. CloudStack UI 의 규칙 Tags 에서도 보인다.

허용 대역 변경은 기존 방화벽 규칙을 먼저 지우고 새로 만든다. 같은 포트에 출발지가 겹치는 방화벽 규칙 두 개는 서버가 충돌로 거절하기 때문이다. 그 사이 잠깐 새 접속이 막힌다.

학내망 안에서 학내 공인 IP 로 접속하면 출발지가 NAT 되지 않아 api.ipify.org 가 본 주소와 다를 수 있다. 이때는 학내 사설 대역도 허용 대역에 넣어야 한다.

## 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `cloudstack.endpoint` | (빈 값) | CloudStack 주소. 첫 로그인 때 채워진다 |
| `cloudstack.allowSelfSignedCertificate` | `false` | HTTPS 자체서명 인증서 허용 |
| `cloudstack.ssh.defaultUser` | (빈 값) | 기본 SSH 사용자. 비우면 VM 마다 묻는다 |
| `cloudstack.ssh.identityFile` | (빈 값) | 개인키 경로. 지정하면 `IdentitiesOnly yes` 도 함께 쓴다 |
| `cloudstack.ssh.jumpHost` | (빈 값) | 사설 IP 접속 때 `ProxyJump` 값 |
| `cloudstack.ssh.addressPreference` | `auto` | 경로 선택 방식 |
| `cloudstack.ssh.configFile` | (빈 값) | 기록할 SSH config. 비우면 `remote.SSH.configFile` → `~/.ssh/config` |
| `cloudstack.ssh.openPath` | (빈 값) | 접속 후 열 원격 폴더. 비우면 빈 원격 창 |
| `cloudstack.refreshIntervalSeconds` | `0` | 자동 새로고침 주기(초) |
| `cloudstack.expose.mode` | `ask` | 공인 경로 없는 Isolated VM 에 SSH 를 열지: `ask`/`auto`/`never` |
| `cloudstack.expose.portRange` | `22000-22999` | 공인 IP 쪽 포트 범위 |
| `cloudstack.expose.allowedCidrs` | (빈 값) | SSH 허용 출발지 CIDR(쉼표 구분). 비우면 열 때마다 묻는다 |

## SSH config 에 쓰는 내용

```
# --- START CLOUDSTACK-VSCODE --- managed by the CloudStack-VSCode extension. Edits inside this block are overwritten.
Host cloudstack--web-server-6f9c1a2b
  # cloudstack-vm-id 6f9c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b
  HostName 203.0.113.5
  Port 2201
  User ubuntu
  HostKeyAlias cloudstack--web-server-6f9c1a2b
# --- END CLOUDSTACK-VSCODE ---
```

- 블록은 파일의 첫 `Host`/`Match` 줄 앞에 넣는다. ssh 는 옵션마다 처음 나온 값을 쓰므로, 파일 끝의 `Host *` 에 있는 `User` 등이 이 항목을 덮지 않는다. 맨 위 전역 옵션은 그대로 전역으로 남는다.
- `HostKeyAlias` 를 VM 별칭으로 둔다. CloudStack 은 삭제된 VM 의 IP 를 새 VM 에 다시 주므로, IP 기준으로 known_hosts 를 쓰면 호스트 키 불일치 경고가 난다.
- 서버에서 온 값은 형식 검증 뒤에만 쓴다. VM 이름은 별칭 생성에만 쓰고 `[a-z0-9-]` 로 걸러낸다. 줄바꿈으로 `ProxyCommand` 를 끼워 넣는 공격(Coder 확장 GHSA-5jhf-4v56-p5c8 와 같은 유형)을 막기 위해서다.
- 서버에서 지워진 VM 의 항목은 새로고침 때 지운다. 파일은 임시 파일에 쓴 뒤 rename 한다. 심볼릭 링크면 링크 대상을 고친다.

## 자격 증명

- VS Code SecretStorage(OS 키체인)에 저장한다.
- 비밀번호 로그인은 비밀번호를 저장하지 않는다. 서버가 준 세션(JSESSIONID, sessionkey)만 저장하고, 만료되면(HTTP 401) 지우고 다시 로그인을 권한다.
- API Key 요청은 `signatureVersion=3` 과 10분 뒤 `expires` 를 붙여 서명한다. 서버의 POST/타임스탬프 강제 설정이 켜져 있어도 통과한다(서버 한도는 현재+15분).

## VM 쪽 요구사항

- sshd 가 돌고, 내 공개키가 들어가 있어야 한다. **SSH 공개키 등록** 명령으로 `~/.ssh/*.pub` 를 CloudStack 키페어로 올리고, VM 생성 때 고르거나 중지된 VM 에 **SSH 키 교체**로 넣는다(CloudStack 은 중지 상태에서만 키 교체를 허용한다).
- Remote-SSH 원격 창을 쓰려면 VS Code Server 요구사항(kernel 4.18+, glibc 2.28+, libstdc++ 3.4.25+, bash, curl 또는 wget)을 맞춰야 한다. Ubuntu 18.04, RHEL/CentOS 7 은 안 된다. 그런 VM 은 **SSH 터미널 열기**를 쓴다.

## 한계 (프로토타입)

- CloudStack API 에 직접 붙는다. 별도 백엔드(OIDC, 권한 검사)와 터널 게이트웨이는 없다. 다른 플랫폼 API 를 쓰려면 `src/cloudstack/client.ts` 의 `CloudStackClient` 자리를 바꾸면 된다.
- 네트워크 도달성은 Static NAT/포트포워딩/점프 호스트, 그리고 위의 공인 IP 노출에 기댄다. VPC tier 는 Network ACL 을 고쳐야 해서 아직 자동으로 열지 않는다.
- 공인 IP 노출은 VM 마다 공인 포트 하나를 SSH 로 연다. 허용 대역을 0.0.0.0/0 으로 두면 인터넷 전체의 무차별 대입 대상이 된다. 터널 게이트웨이가 생기면 이 기능은 대체 대상이다.
- 실제 VS Code 창과 실제 CloudStack 에서는 아직 시험하지 않았다. 테스트는 CloudStack 인증 규칙을 소스대로 구현한 모의 서버와 가짜 `vscode` 모듈로 돌린다.

## 개발

```bash
npm install
npm test          # 컴파일 + 48개 테스트 (OpenSSH 클라이언트 필요: ssh -G 로 config 해석 확인)
npm run package   # cloudstack-vscode-0.3.0.vsix
```

| 파일 | 역할 |
|---|---|
| `src/extension.ts` | 명령, 접속 흐름, 세션 만료 처리 |
| `src/cloudstack/client.ts` | login 세션 / API key 서명 요청, 목록 페이지 이어받기, 비동기 작업 대기 |
| `src/cloudstack/sign.ts` | 서명 문자열 (서버 `ApiServer.verifyRequest` 와 같은 정렬·인코딩) |
| `src/addressing.ts` | SSH 경로 후보 계산 |
| `src/exposure.ts` | Isolated 네트워크 공인 IP 노출 계획(대상 판별, IP·포트 선택, CIDR 검증, 태그 규칙) |
| `src/sshConfig.ts` | SSH config 블록 편집과 값 검증 |
| `src/remote.ts` | Remote-SSH 계열 확장 탐지, 원격 창 열기, 터미널 |
| `src/vmTree.ts` | 사이드바 트리 |
