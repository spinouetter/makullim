# 알려진 이슈 (KNOWN ISSUES)

해결되지 않았거나 보류 중인 문제를 기록합니다. 각 항목은 증상·환경·조사 내용·시도한 것·현재 상태를 남깁니다.

---

## KI-001 · Firefox 데스크탑: 텍스트 입력 "첫 포커스" 지연

- **상태:** 미해결(보류). 우선순위 낮음 — 세션당 사실상 1회만 발생하고, 기능 동작 자체에는 문제 없음.
- **등록일:** 2026-06-29

### 증상
- 데스크탑 **Firefox에서만** 발생. Chrome/Edge·모바일은 정상.
- 페이지 로드 후 텍스트 입력칸을 **처음 클릭할 때** 커서(캐럿)가 한 박자 늦게 생김.
- 한 번 입력칸에 포커스한 뒤(다른 셀을 클릭했다가 돌아와도)에는 지연 없이 즉시 입력됨.
- 영향 범위: 스케줄 좌석 입력칸, 티켓 관리 좌석 입력칸, 메모 등 **모든 텍스트 입력** 공통.

### 조사 (Firefox 152 + geckodriver 0.37, 헤드리스 계측)
- `pointerdown → focusin` 간격: 세션 **첫 포커스만 ~30ms**, 이후 전부 ~1ms.
- 같은 측정을 환경설정 토글로 반복:
  - `layout.spellcheckDefault=0`(맞춤법 끔): 첫 포커스 ~30ms → **맞춤법 무관**
  - `browser.formfill.enable=false`(폼 자동완성 끔): 첫 포커스 ~28ms → **자동완성 무관**
- 포커스 시 화면 스크롤(scroll-into-view): `scroll-behavior:auto`라 **즉시(0ms)** — 부드러운 스크롤 아님.
- 클릭 시 `renderSchedule` 등 재렌더 **호출 없음**, `updateFloatOverlay` ~0ms, 프레임 잼 없음.
- → **앱 JS/재렌더와 무관한, 브라우저 내부의 '문서 첫 포커스' 일회성 워밍업**으로 보임.

### 시도했으나 실제 Firefox에서 효과 없던 것
1. 입력에 `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"` 추가 → 체감 지연 그대로.
2. 로드 직후 화면 밖 임시 입력에 `focus({preventScroll:true})`/`blur` 워밍업 → 헤드리스에선 첫 `focus()`가 31ms→2ms로 줄었으나, **실제 Firefox에서는 체감 지연이 그대로**.
   - 시사점: 헤드리스로 재현된 ~30ms와 실제 사용자가 느끼는 지연의 원인이 **다를 수 있음**(실제 프로파일/확장/렌더 환경에 의존). 헤드리스(빈 프로파일)로는 진짜 원인을 재현하지 못함.

위 1·2 변경은 도움이 안 되어 **모두 되돌림**(코드는 0025 커밋 = `js/app.js?v=75` 상태 유지).

### 다음에 시도해 볼 만한 것
- 실제 Firefox 프로파일에서 `about:config`로 `layout.spellcheckDefault=0`, `browser.formfill.enable=false`를 직접 끄고 1차 격리(헤드리스가 아닌 실기기에서).
- 거대한 표(입력 123개+)에 대한 Firefox 레이아웃 비용 완화: 행/셀에 `contain: content` 또는 `content-visibility:auto` 실험(부작용 확인 필요).
- Firefox 확장(특히 폼/접근성 관련) 영향 여부 확인(안전 모드로 재현되는지).
- `performance` 프로파일러(Firefox 내장)로 첫 클릭 시 실제로 시간을 쓰는 구간 직접 캡처.
