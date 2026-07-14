# 배포 워크플로 설명 (`.github/workflows/`)

> 워크플로 변경은 `requests/NNNN.md`가 아니라 **이 문서 + git history**로 관리한다(가이드 CLAUDE.md §작업 방식).
> 변경 시 이 문서의 해당 항목을 갱신하고, 무엇을·왜 바꿨는지는 커밋 메시지에 남긴다.

## `pages.yml` — GitHub Pages 배포

정적 사이트를 GitHub Pages로 배포한다. **저장소를 빌드하지 않고** 몇 가지 산출물을 만들어 넣은 뒤 통째로 올린다.
전제: 저장소 Settings → Pages → Source = **GitHub Actions**.

### 트리거
- `push`(main): 커밋마다 배포(피날레 모양에 영향 줄 수 있는 변경 포함).
- `workflow_dispatch`: 수동 실행.
- `schedule`(매일 00:00 KST = 15:00 UTC): 공연이 끝나 '마지막 공연' 시드가 바뀌면 피날레 썸네일을 갱신.

### 단계
1. **checkout** — 저장소 체크아웃.
2. **공연 slug 스텁 생성 + 빌드 버전 주입** — `shows/index.json`의 각 공연 id에 대해 `shows/<id>.json`의 `slug`를 읽어 `/<slug>/index.html`을 만든다. `index.html`을 복사하며 `<!-- __SHOW__ -->` 마커를 `window.MAKULLIM_SHOW_ID="<id>";window.MAKULLIM_BUILD="<커밋 짧은 SHA>"`로 치환 → `/<slug>/` 접속 시 그 공연을 바로 로드. 루트 `index.html`의 마커에는 **빌드 버전만** 주입한다(스텁들이 원본 마커를 다 읽은 뒤 단계 마지막에 sed -i). **스텁은 배포물에만 있고 저장소엔 커밋하지 않는다.** slug가 예약 폴더명(css·js·data·fonts·shows·theatres·scripts·requests·images·json)과 겹치면 사고 방지를 위해 **실패** 처리.
   - **빌드 버전의 용도**: 앱(`js/app.js`의 `dataUrl()`)이 모든 데이터(JSON) 요청에 `?v=<빌드>`를 붙여 **브라우저 캐시를 활용**한다(요청 0042). 데이터는 커밋 시점에 확정되므로 배포가 바뀔 때만 URL이 바뀌면 항상 최신이 보장된다(`js?v=NN`과 같은 원리, 단 자동). 빌드 버전이 없으면(로컬 개발) 앱은 기존처럼 `cache:"no-store"`로 항상 새로 받는다. 매일 cron 재배포는 같은 커밋 SHA라 데이터 캐시가 유지된다(썸네일 이미지는 JSON 경로가 아니라 무관).
3. **Dropbox 키 주입** — Secret `DROPBOX_APP_KEY`가 있으면 `js/config.js`의 `__DROPBOX_APP_KEY__` 자리표시자에 sed로 주입(없으면 백업 기능 비활성으로 배포).
4. **피날레 썸네일 생성** — `scripts/gen-finale-preview.js`(playwright-core)로 각 공연 × **각 보드**(`finale-boards.json`의 visible)를 `?board=<id>&randomData=<시드>`로 렌더해 `shows/*/images/finale-preview-<boardId>.jpg` 생성(사진 많은 보드라 JPG로 용량↓). 갤러리(`finale.js buildThumbs`)가 이 **보드별 조합 이미지 1장**을 `<img>`로 받아 쓴다 → 개별 사진 다운로드·라이브 렌더 회피(없으면 라이브 폴백). 러너의 시스템 Google Chrome 재사용(없으면 playwright 크로미엄 설치로 폴백). **실패해도 배포는 계속**(앱이 라이브 보드로 폴백). 산출물은 배포물에만 포함(커밋 안 함).
5. **빌드 의존물 정리** — `node_modules`·`package*.json` 삭제(배포물 오염 방지), 실패해도 항상 실행.
6. **`.nojekyll`** 생성 후 `configure-pages` → `upload-pages-artifact`(path `.`) → `deploy-pages`. **`deploy-pages`는 간헐적 배포 API 실패에 대비해 최대 3회 재시도**(아티팩트 업로드는 1회만, 배포만 재시도해 중복 방지).

### concurrency
- `group: pages`, **`cancel-in-progress: false`** — 진행 중인 배포를 취소하지 않는다(취소 시 Pages 환경에 미완료 배포가 남아 이후 "Deployment failed, try again later"로 거부될 수 있음, GitHub 권장값).

### 필요한 것
- **Secret**: `DROPBOX_APP_KEY`(선택, 백업 기능용).
- 새 공연 추가 시: `shows/index.json`에 id, `shows/<id>.json`에 고유 `slug`. slug는 예약 폴더명과 겹치면 안 됨.

### 산출물(커밋 안 함, 배포물에만)
- `/<slug>/index.html`(공연 스텁), `shows/*/images/finale-preview-*.jpg`(보드별 썸네일), 주입된 `js/config.js`.
