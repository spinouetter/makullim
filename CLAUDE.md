# CLAUDE.md — 막울림(makullim) 작업 가이드

## 프로젝트
- **막울림(makullim)** = 뮤지컬 관극 트래커. **바닐라 JS/HTML/CSS 정적 웹앱**(빌드 프레임워크 없음), **GitHub Pages** 배포(커스텀 도메인 `makollim.com`).
- 데이터는 **로컬 저장소 파일 + 브라우저 localStorage**(관극 기록·설정)만 사용. 서버 없음. Dropbox 백업은 선택 기능.
- 화면: **Schedule / Statistics / Seat map / Finale / Settings** 탭.

## 작업 방식 (중요)
- **작업을 시작하기 전에 반드시 `git pull`(권장: `git pull --rebase origin main`)로 최신 origin/main을 받는다.** 다른 협업자/에이전트가 동시에 작업 중이라 원격이 앞서 있을 수 있다. 커밋·push 전에도 `git fetch`로 원격 변경을 다시 확인하고, 분기됐으면 rebase 후 진행한다.
- 작업은 기본적으로 **`requests/NNNN.md`** 요청한다. 다만 대화도 가능하다.
  - `TEMPLATE.md` 복사 → "## 요청 (작성: Spinouetter)" 칸만 사용자가 채운다.
  - Claude는 같은 파일의 **정리/할 일/결정 사항/상태** 칸과 **첫 줄 제목**(`# 요청 #NNNN — 제목`)을 채운다. 요청 칸은 건드리지 않는다. 규칙 전체는 `requests/README.md`.
  - 대화로 요청된 것 중 아래에 해당하는 내용이 있다면 **`requests/NNNN.md`**를 Claude가 직접 작성한다.
    - **코어 함수(`js/` 코드: app.js·finale.js 등)** 에 변경이 발생하는 경우에만 작성한다.
    - **코어가 아닌 것(작성 안 함): `css`, `index.html`, 순수 공연 데이터(`shows/<id>/*.json`·이미지) 등.**
    - **워크플로(`.github/workflows/`) 변경은 requests가 아니라 별도 설명 문서(`.github/workflows/README.md`) + git history로 관리한다.**
  - 아래의 경우에는 그럼에도 불구하고 **`requests/NNNN.md`**를 작성하지 않는다.
    - 마이너한 버그 수정: 그 기능을 요청한 `requests/NNNN.md`를 **찾으면 거기에 반영하고, 커밋 메시지(git log)에 어느 요청(#NNNN)에서 잘못된 것인지 명시**한다. **못 찾으면 무시**(새 문서 안 만듦).
- **커밋은 항상 먼저 물어본다.**
  - 커밋하기 전에 문서를 먼저 업데이트 한다. 그리고 다시 한 번 물어본다.
    - 규칙에 따라 **`requests/NNNN.md`**를 업데이트 하거나 작성한다.
    - **`HISTORY.md`(루트)** 맨 위에 한 줄 요약(날짜+요청번호+요약)을 추가한다.
      - 공연의 데이터베이스일 경우 기록하지 않는다.
      - 마이너한 버그 수정의 경우 기록하지 않는다.
      - 최근 3개 HISTORY 항목 중 이번 수정을 담을 수 있는 게 있으면 **새 줄을 추가하지 않는다**(생략).
- **push는 요청할 때만.** ("커밋해줘"는 커밋만, "push해줘"는 push까지.)
- **incremental 수정은 합쳐서(squash) push한다.** 같은 작업을 다듬는 연속 커밋(레이블 변경, 정렬 조정, 곧바로 이어지는 후속 수정 등)은 커밋을 쪼개 쌓지 말고, push 전에 아직 push하지 않은 로컬 커밋끼리 하나로 합쳐(amend / `git reset --soft` 후 재커밋) 최종 한 커밋으로 push한다. 이미 push된 커밋은 히스토리를 다시 쓰지 않는다.
- git author는 로컬 설정된 `Spinouetter <spinouetter@gmail.com>`를 사용한다.
- 커밋 메시지는 한국어 한 줄 요약 + `— NNNN`(요청번호), 본문에 상세를 적는다.
- **커밋 서명(verified/unverified)은 경고하지 않는다.** 이 저장소는 커밋이 unverified로 남아도 무방하다. unverified라는 이유로 경고·차단·재서명·확인 요청을 하지 않고 그대로 진행한다.

## 저장소 구조
```
index.html            # 앱 셸(루트). <!-- __SHOW__ --> 마커에 배포 시 공연 id 주입
css/  js/  fonts/      # 공유 자원 (app.js, finale.js, config.js, dropbox.js / styles.css)
data/                 # 공연 공용 데이터 (holidays.json 등)
theatres/             # 좌석 도면 JSON (공연이 참조)
shows/
  index.json          #  { default, shows:[id...] }
  <id>.json           #  공연 정의(slug·제목·기간·theatre·stats 프리셋 등)
  <id>/               #  공연별 데이터
    casts.json schedule.json grades.json matches.json casting_by_date.json
    images/           #  배우 사진(축소본)·finale-board.svg·logo.svg·placeholder
    finale-boards/  finale-boards.json
scripts/              # 배포용 보조(gen-finale-preview.js 등)
sync-cast.py          # 배우 사진 축소 동기화 도구
requests/  HISTORY.md  README.md  KNOWN_ISSUES.md
.github/workflows/pages.yml   # 빌드/배포(슬러그 스텁 생성·Dropbox 키 주입·썸네일 생성)
```

## 멀티 공연 규칙 (요청 0038)
- 공연은 `shows/<id>/`에 데이터, `shows/<id>.json`에 정의(+`slug`). 목록·기본값은 `shows/index.json`.
- 접속 경로 `/<slug>/` = 그 공연. 루트 `/`는 기본 공연으로 리다이렉트(로컬 제외). `?show=<id>`도 지원.
- 배포 시 Action이 `index.html`을 복사하며 `<!-- __SHOW__ -->` 마커를 `window.MAKULLIM_SHOW_ID="<id>"`로 치환해 슬러그 스텁을 만든다(저장소엔 커밋 안 함).
- **경로 규칙**: 공연별 자원은 **공연 폴더 상대 경로**, 공유 자원은 **루트 절대 경로**(`/css`, `/js`…)로 참조.
- **공연 id는 불변**(localStorage 키 `makollim:state:v1:<id>`·Dropbox 백업이 id 기준). slug만 바꿔도 됨.

## 코딩 원칙
- **하드코딩 금지 · 데이터 주도**: 배역명·프리셋·고정조합 등은 코드가 아니라 공연 정의/데이터(JSON)에서 온다(요청 0039). 새 공연을 넣어도 코드 수정이 없어야 한다.
- 자원 참조 뒤 **캐시 버전 쿼리**(`app.js?v=NN`, `finale-board.svg?v=NN` 등) — 파일 바꾸면 버전도 올린다.
- 사용자 입력·이름·배역 등은 **`escHtml`로 이스케이프**(텍스트·속성 모두).
- localStorage는 공연 `id`로 네임스페이스. 데이터 로딩은 표준 경로 규칙을 따른다.

## 배우 사진 / Finale
- 배우 사진 **원본은 `temp/cast/`**(로컬 전용, `temp/`는 .gitignore). 파일명 = `배우이름.jpeg`. 변경하면 **`python3 sync-cast.py [공연id]`** 실행 → 680px·품질82·EXIF보정으로 축소해 `shows/<id>/images/`에 복사. **원본은 커밋 안 하고 축소본만 커밋**(원본이 수 MB~20MB).
- Finale는 캐스트보드 SVG(`shows/<id>/images/finale-board.svg`)의 슬롯 `<text id="fn-name-…">`·`fn-cnt-…`를 `textContent`로 채우고, 사진 `<image id="fn-photo-…">`에 `images/<이름>.jpeg`(없으면 `플레이스홀더.jpeg`)를 **cover·상단정렬**(`preserveAspectRatio="xMidYMin slice"`)로 넣는다. 배역 매핑·구조는 메모리 `billy-finale-board-svg` 참고.
- 관극 수는 통계 4모드(first/start/all/weighted)로 계산. 좌석 영역은 실제 좌석 다이어그램으로 교체.

## 로컬 개발 · 테스트
- 서버: `python3 -m http.server 8000`(저장소 루트). 브라우저에서 `/?show=<id>` 또는 슬러그 확인.
- **커밋 전 미리보기 확인**을 선호: headless Chromium(Selenium/Playwright) 스크린샷으로 렌더/에러(SEVERE) 확인. 좌석맵·Finale 등 시각 변경은 특히.
- 배포는 push 시 Action(`pages.yml`)이 슬러그 스텁·Dropbox 키·Finale 썸네일 생성 후 전체를 Pages에 업로드.

## 작업 스타일 · 주의
- 사용자는 **반복적으로 다듬는다**: SVG를 다시 그려 주거나("다시 그릴게"), 미리보기 후 문제없으면 커밋. 요청이 여러 번 정정될 수 있으니 그때그때 반영.
- **데이터 오류를 정정**해 준다(예: 존재하지 않는 좌석·이름 오타). 준 자료가 이전과 다르면 최신 지시를 따른다.
- 내가 만들지 않은 미추적 파일은 **함부로 지우거나 커밋하지 않는다**.
- 큰 이진/원본(고해상 사진·거대 SVG)은 **저장소에 넣지 않는다**(축소본만).

## 참고 문서
- `requests/README.md` — 요청 워크플로 상세 · `TEMPLATE.md`
- `HISTORY.md` — 완료 작업 한 줄 기록(최신이 위)
- `KNOWN_ISSUES.md` — 알려진 이슈
- `CASTING_BOARD.md` — **캐스트보드 사진 판독·대조·기록 절차**(에이전트용). 캐스팅 보드 이미지가 올라오면 이 문서대로 처리한다.

<!-- Spinouetter 메모: 이 아래에 자유롭게 추가/수정하세요.
     예) 특정 배역 처리 규칙, 자주 쓰는 명령, 하지 말아야 할 것 등 -->
