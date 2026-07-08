# Air3 Live

INMO Air3(스마트글라스) 카메라 → 사무실 PC **실시간 WebRTC 송출** 시스템.
선박에서 Starlink 너머로 지연 1초 내외, 자동 화질 적응.

```
[Air3 안경] ─┐                                    ┌─ [사무실 PC]
 broadcaster │  (1) 앞단(정적) = GitHub Pages       │  viewer
   (PWA)     │  (2) 시그널링 WSS + /ice-config      │  (북마크)
             │      = Oracle 무료 VM (Node+Caddy)   │
             └─ (3) 미디어 릴레이 = Cloudflare ─────┘
                    Realtime TURN (무료 1,000GB/월)
```

## 왜 이 구성인가
- **WebRTC**: 서브초 지연 + 자동 화질 적응 → 위성 지터에 강함.
- **TURN 필수**: Starlink는 CGNAT(이중 NAT)라 STUN만으로 P2P가 자주 실패. Cloudflare Realtime TURN이 릴레이. (coturn 자체운영 불필요)
- **HTTPS 필수**: 브라우저는 보안 컨텍스트에서만 `getUserMedia`(카메라) 허용.
- **PWA**: APK/스토어 불필요. Air3 크롬으로 URL 열고 "홈에 추가"만.
- **앞단/서버 분리**: 앞단(GitHub Pages)엔 비밀값 없음. Cloudflare 토큰은 VM `.env`에만.

## 폴더 구성
```
air3-live/
├─ server.js                시그널링(WS, room 1:N) + Cloudflare TURN 발급 + CORS + .env 로더
├─ package.json             deps: express, ws
├─ public/                  ← GitHub Pages로 배포되는 앞단
│  ├─ config.js             SERVER_URL(시그널링 도메인). 비밀값 없음
│  ├─ index.html            진입 페이지
│  ├─ broadcaster.html      현장 송출(카메라, 프리셋, 자동재연결/ICE restart, wake lock)
│  ├─ viewer.html           사무실 시청(자동표시, 실측 kbps/해상도/fps)
│  ├─ manifest.webmanifest / sw.js / icon-*.png   PWA
├─ deploy/
│  ├─ Caddyfile             자동 HTTPS 리버스 프록시(HTTP+WS)
│  ├─ air3-live.service     systemd
│  ├─ .env.example          서버 비밀값 템플릿
│  └─ turnserver.conf       coturn 자체호스팅 대안(옵션)
├─ tools/
│  ├─ gen-icons.js          PWA 아이콘 생성(의존성 없음)
│  └─ test-signaling.js     시그널링 프로토콜 스모크 테스트
├─ .github/workflows/pages.yml   public/ 자동 배포
└─ .gitignore               node_modules/, .env 제외
```

## 로컬 검증
```bash
npm install
node --check server.js
PORT=8099 node server.js &          # 서버 기동
curl localhost:8099/healthz          # {"ok":true,...}
curl localhost:8099/ice-config       # CF 키 있으면 turn: 포함 + hasTurn:true
PORT=8099 node tools/test-signaling.js   # 12/12 통과해야 함
```
> 브라우저 앞단은 `public/`을 서버가 그대로 서빙하므로 `http://localhost:8099/`로도 확인 가능.
> 실제 CF TURN 응답은 인터넷 접속되는 환경(VM)에서 검증.

## 배포

### A. Cloudflare TURN
대시보드 → Realtime → TURN → 앱 생성.
- **TURN Key ID**: `7d2f8f63d8032fc6a79e67970fab0b96` (앱 `remote-snsys`)
- **API Token**: VM `.env`의 `CF_TURN_API_TOKEN`에만 보관. ⚠️ 핸드오프 문서에 노출된 적 있으므로 **테스트 후 Roll/재발급**.

### B. Oracle 무료 VM
1. cloud.oracle.com → Start for free. **홈 리전은 변경 불가** → Osaka/Tokyo 우선(영상은 Cloudflare 중계라 리전 영향 작음).
2. Compute → Instances → Create: Ubuntu 22.04/24.04, Shape **VM.Standard.E2.1.Micro**(AMD), **Assign public IPv4 ON**, SSH key **Save private key**.
3. 방화벽 **이중**으로 80/443 열기:
   - 클라우드: VCN → Security Lists → Default → Add Ingress `0.0.0.0/0` 포트 80, 443
   - OS: 아래 iptables

### C. VM 서버 설치 (SSH 접속 후)
```bash
# OS 방화벽
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo apt-get install -y iptables-persistent && sudo netfilter-persistent save

# 코드 배치
sudo mkdir -p /opt/air3-live
git clone https://github.com/<본인>/air3-live.git /tmp/a && sudo cp -r /tmp/a/. /opt/air3-live/
cd /opt/air3-live

# Node 20 + deps
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs && npm install --omit=dev

# .env (새 Cloudflare 토큰으로)
sudo cp deploy/.env.example /opt/air3-live/.env
sudo nano /opt/air3-live/.env       # CF_TURN_API_TOKEN 채우기
sudo chown www-data:www-data /opt/air3-live/.env && sudo chmod 600 /opt/air3-live/.env

# Caddy (자동 HTTPS) — Caddyfile 도메인 수정 후
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
sudo mkdir -p /var/log/caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo nano /etc/caddy/Caddyfile   # 도메인 수정
sudo systemctl reload caddy

# 서비스 등록
sudo cp deploy/air3-live.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now air3-live

# 검증
curl https://<시그널링도메인>/ice-config   # hasTurn:true 면 성공
journalctl -u air3-live -f
```

### D. 도메인
회사 서브도메인(예 `air3-signal.snsys.net`)의 **A 레코드 → VM 공인 IP**. (Caddy 인증서 발급 전에 먼저 연결되어 있어야 함)

### E. GitHub Pages
1. `public/config.js`의 `SERVER_URL`을 `https://<시그널링도메인>`으로 수정.
2. 저장소 push(main) → Settings → Pages → Source: **GitHub Actions**.
3. 배포 주소: `https://<user>.github.io/air3-live/`

## 화질 튜닝
`public/broadcaster.html`의 `PRESETS`. 위성이 좁으면 UI에서 `720p·20fps·1.1Mbps` 또는 `480p·20fps·0.6Mbps` 선택.

## 보안
- Cloudflare API Token은 VM `.env`에만. `config.js`엔 비밀값 없음.
- 운영 시 `ALLOW_ORIGIN`을 `*` 대신 실제 Pages 주소로 좁히기.
- 노출된 토큰은 반드시 재발급 후 `.env`만 교체(코드 수정 불필요).

## 현장 리스크 체크리스트 (소프트웨어 밖)
- Oracle 이중 방화벽(클라우드 Security List + OS iptables) — 미접속 원인 1위.
- Mixed content: 앞단 https ↔ 시그널링은 반드시 https/wss(Caddy).
- 선내 Wi-Fi 커버리지(기관실·갑판하부), Air3 발열/배터리(장시간 시 보조배터리), 명판 판독 화질(정지화면 확대 보완), 방폭(ATEX) 구역 반입 규정.
```
