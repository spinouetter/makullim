/* =========================================================
   gen-woojin-board.mjs — '비밀 피날레'(김우진 빌리 정산판) SVG 생성기
   - 배경: finale-board-woojin-bg.jpg(업로드 빌리 포스터, 김우진 본인)
   - 흰 여백(로고 아래·소년 오른쪽)에 배역별 섹션 배치:
       배역 영문 헤딩 + 밑줄 → 원형 얼굴 사진 → 이름 → 파란 숫자판(함께 관극수)
   - 김우진 빌리가 메인 → 빌리 사진 생략(배경이 곧 김우진), 이름·관극수만.
   - 마이클은 김우진의 짝(빌리×마이클) → 상단에 큰 한 줄로 강조.
   - 각 셀은 <g id="fn-cell-{slot}-{i}">로 감싼다 → finale.js가 관극수 0(미관극) 배우를
     통째 숨길 수 있게(링·숫자판까지) 함.
   - 슬롯 id는 finale 규칙(fn-name/fn-photo/fn-cnt-{roleId}-{i}). 값은 finale.js가 채움.
   실행:  node scripts/gen-woojin-board.mjs
   출력:  shows/betm-skorea-2026/images/finale-board-woojin.svg
   ========================================================= */
import fs from "fs";

const OUT_ID = process.argv[2] || "woojin";   // 출력 파일 id(woojin·woojin2…). 레이아웃·배경은 동일, 파일명만 분리.
const SHOW = "shows/betm-skorea-2026";
const casts = JSON.parse(fs.readFileSync(`${SHOW}/casts.json`, "utf8"));
const isCover = r => /^(cover|standby|alternative)$/.test(r || "");
// 주연(cast)만 — 커버·스탠바이는 이 정산판에서 제외(관극수 0인 배우 제외 요청과도 부합)
const mainNames = id => { const c = casts.find(x => x.id === id); return c && !c.group ? c.actors.filter(a => !isCover(a.role)).map(a => a.name) : []; };

// 배역 영문 라벨(헤딩)
const LABEL = {
  billy:"BILLY", michael:"MICHAEL", debbie:"DEBBIE", small_boy:"SMALL BOY", tall_boy:"TALL BOY",
  mrs_wilkinson:"MRS. WILKINSON", dad:"DAD", grandma:"GRANDMA", tony:"TONY", dead_mum:"DEAD MUM",
  old_billy:"OLDER BILLY", george:"GEORGE", mr_braithwaite:"MR. BRAITHWAITE",
  ballet_girls:"BALLET GIRLS", ensemble:"ENSEMBLE", ashington:"ASHINGTON", bedlington:"BEDLINGTON"
};

// 발레걸즈·앙상블 개별 배우 수(김우진 회차, casting_by_date 기준) — 슬롯 개수 결정용.
//  (값=내/전체는 finale.js가 런타임에 채움. 여기선 몇 칸 그릴지만 계산)
const sched = JSON.parse(fs.readFileSync(`${SHOW}/schedule.json`, "utf8"));
const cbd = JSON.parse(fs.readFileSync(`${SHOW}/casting_by_date.json`, "utf8"));
const balletCast = casts.find(c => c.id === "ballet_girls");
const balletKeys = (balletCast.members || []).map(m => m.fullName || m.role);
const wjKeys = sched.filter(p => ((p.cast || {})["빌리"] || []).includes("김우진")).map(p => `${p.date} ${p.time}`);
// 개별 발레 배우별 김우진 회차 출연수
const balletCnt = {}, ensSet = new Set();
wjKeys.forEach(k => { const d = cbd[k]; if(!d) return;
  balletKeys.forEach(rk => { if(d[rk]) balletCnt[d[rk]] = (balletCnt[d[rk]] || 0) + 1; });
  (d["앙상블"] || []).forEach(e => ensSet.add(Array.isArray(e) ? e[0] : e));
});
// 발레걸즈 구성: adult(상시=byTeam 없음) + Ashington(byTeam) + Bedlington(byTeam). 김우진과 함께 오른 배우만.
const withWJ = names => names.filter(n => (balletCnt[n] || 0) > 0);
const ADULT_N = withWJ((balletCast.members || []).filter(m => !m.byTeam && m.name).map(m => m.name)).length;
const ASH_N   = withWJ((balletCast.members || []).filter(m => m.byTeam && m.byTeam["애싱턴"]).map(m => m.byTeam["애싱턴"])).length;
const BED_N   = withWJ((balletCast.members || []).filter(m => m.byTeam && m.byTeam["베들링턴"]).map(m => m.byTeam["베들링턴"])).length;
const ENS_N = ensSet.size;
// 배역 줄 묶음(한 줄 최대 6명). 마이클은 상단 강조 줄로 따로.
const ROWS = [
  ["debbie","old_billy"],
  ["tony","dad","dead_mum","mrs_wilkinson"],
  ["grandma","george","mr_braithwaite"],
  ["tall_boy","small_boy"]
];

const VB_W = 840, POSTER_H = 1262, VB_H = 1385;   // 발레·앙상블 위로, 우측 정렬
const EXT_BG = "#f3f2f0";   // 확장 영역 배경 = 포스터 빈 공간 회색
const CX0 = 300, CW = 528 - 0.3*58;   // 콘텐츠 폭 — 오른쪽 여백을 0.3*사진(d58)만큼 늘림
const BLUE = "#2f6bcf", BLUE_D = "#1f4e9e", INK = "#20303f", RING = "#9fbdea";
const PH = "images/%ED%94%8C%EB%A0%88%EC%9D%B4%EC%8A%A4%ED%99%80%EB%8D%94.jpeg";   // 플레이스홀더.jpeg
const esc = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

let out = [], defs = [];
const P = s => out.push(s);

// 원형 사진 셀(그룹으로 감쌈): 사진 + 링 + 이름 + 파란 숫자판.
function cell(slot, i, cx, top, d, big, small){
  const r = d/2, cy = top + r, clip = `clip-${slot}-${i}`;
  const nameFs = big ? 14 : (small ? Math.max(8, d*0.24) : 12), nameY = cy + r + (big ? 16 : (small ? Math.max(9, d*0.26) : 12));
  const pw = big ? Math.max(52, d*0.72) : (small ? d*0.86 : Math.max(46, d*0.82));   // '내/전체' 분수 들어갈 폭
  const ph = big ? 18 : (small ? Math.max(9, d*0.28) : 15), py = nameY + (big ? 7 : (small ? 4 : 6));
  const cntFs = big ? 12 : (small ? Math.max(7, d*0.2) : 10.5);
  defs.push(`<clipPath id="${clip}"><circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"/></clipPath>`);
  P(`<g id="fn-cell-${slot}-${i}">`);
  P(`  <image id="fn-photo-${slot}-${i}" x="${(cx-r).toFixed(1)}" y="${top.toFixed(1)}" width="${d.toFixed(1)}" height="${d.toFixed(1)}" preserveAspectRatio="xMidYMin slice" clip-path="url(#${clip})" xlink:href="${PH}"/>`);
  P(`  <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="${RING}" stroke-width="${big?1.6:1.2}"/>`);
  P(`  <text id="fn-name-${slot}-${i}" x="${cx.toFixed(1)}" y="${nameY.toFixed(1)}" text-anchor="middle" font-family="IBM Plex Sans KR Medm, sans-serif" font-size="${nameFs}" fill="${INK}"> </text>`);
  if(!small){   // 발레·앙상블(small)은 숫자판 없이 사진+이름만
    P(`  <rect x="${(cx-pw/2).toFixed(1)}" y="${py.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" rx="${(ph/2).toFixed(1)}" fill="${BLUE}"/>`);
    P(`  <text id="fn-cnt-${slot}-${i}" x="${cx.toFixed(1)}" y="${(py+ph-(big?5:4.2)).toFixed(1)}" text-anchor="middle" font-family="IBM Plex Sans KR Medm, sans-serif" font-size="${cntFs}" font-weight="700" fill="#ffffff">0</text>`);
  }
  P(`</g>`);
}
function heading(label, x, y, w, fs){
  P(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Anton, sans-serif" font-size="${fs||15}" letter-spacing="0.5" fill="${BLUE_D}">${esc(label)}</text>`);
  P(`<line x1="${x.toFixed(1)}" y1="${(y+5).toFixed(1)}" x2="${(x+w).toFixed(1)}" y2="${(y+5).toFixed(1)}" stroke="${BLUE_D}" stroke-width="1"/>`);
}
// 한 줄(여러 배역)을 그리드로 배치. 배역들을 가로로 이어 붙이고 줄 전체를 영역 안에서 가운데 정렬.
//  o: { x0, w, pitch, d, hfs, label }  (기본=상단 6칸 그리드)
const CELL_PITCH = CW/6, CELL_D = 58;   // 상단 6칸 그리드가 새 CW를 꽉 채우도록
function renderRow(roles, yTop, o){
  o = o || {};
  const x0 = o.x0 != null ? o.x0 : CX0, w = o.w != null ? o.w : CW;
  const pitch = o.pitch || CELL_PITCH, d = o.d || CELL_D, hfs = o.hfs || 12.5, lbl = o.label || {};
  const counts = roles.map(r => Math.max(1, mainNames(r).length));
  const total = counts.reduce((a, b) => a + b, 0);
  let x = x0 + (w - total*pitch) / 2;
  roles.forEach((roleId, ri) => {
    const n = counts[ri], blockW = n*pitch;
    // 헤딩·실선을 셀(사진)에 맞춤: 왼쪽=첫 사진 왼끝(alignLeft), 오른쪽 끝=마지막 사진 오른끝(alignRight)
    const firstLeft = x + pitch/2 - d/2, lastRight = x + (n - 0.5)*pitch + d/2;
    const hx = o.alignLeft ? firstLeft : x + 2;
    const lineEnd = o.alignRight ? lastRight : (x + 2 + blockW - 8);
    heading(lbl[roleId] || LABEL[roleId] || roleId, hx, yTop + 14, lineEnd - hx, hfs);
    for(let i=0;i<n;i++) cell(roleId, i, x + pitch*(i+0.5), yTop + 24, d, false);
    x += blockW;
  });
}

// ===== 문서 =====
P(`<?xml version="1.0" encoding="UTF-8"?>`);
P(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${VB_W} ${VB_H}" font-size="12px">`);
P(`__DEFS__`);
P(`<rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="${EXT_BG}"/>`);   // 확장 영역(포스터 아래) = 빈 공간 회색
P(`<image x="0" y="0" width="${VB_W}" height="${POSTER_H}" preserveAspectRatio="none" xlink:href="/shows/betm-skorea-2026/images/finale-board-woojin-bg.jpg"/>`);

// 빌리(김우진)는 배경 포스터가 곧 본인 → 이름·관극수·타이틀 문구 없이 배경으로만.

// ── MICHAEL: 김우진의 짝(빌리×마이클) → 큰 한 줄로 강조 (헤딩·실선을 셀에 맞춤) ──
//   구성(칸 수·피치·크기)은 그대로 두고, 오른끝을 다른 줄(그리드 오른끝=gridRight)에 맞춰 오른쪽 정렬.
{
  const mNames = mainNames("michael"), n = Math.max(1, mNames.length), d = 80, mp = CW/n;
  const gRight = CX0 + CW - CELL_PITCH/2 + CELL_D/2;   // 두 번째 줄 오른끝(그리드 오른끝)
  const cxOf = i => (gRight - d/2) - mp*(n - 1 - i);   // 맨 오른쪽 마이클 오른끝 = gRight
  const firstLeft = cxOf(0) - d/2, lastRight = gRight;
  heading("MICHAEL", firstLeft, 495, lastRight - firstLeft, 18);
  for(let i=0;i<n;i++) cell("michael", i, cxOf(i), 512, d, true);
}

// ── 세로 배치: 각 줄 '문자 탑'(헤딩 glyphTop)이 '이전 줄 단추 보톰 + 지정 간격'이 되게 ──
//   간격(위→아래): michael→debbie 25 · debbie→tony 24 · tony→grandma 24 · grandma→tallboy 24 · tallboy→ballet 12 · ballet→ensemble 9
const GRID_HTOP = 2.8, GRID_BB = 115, MICH_BB = 633;   // 그리드 헤딩 glyphTop=yTop+2.8, 단추 보톰=yTop+115, 마이클 단추 보톰(고정)
const Y_DEBBIE = (MICH_BB           + 25) - GRID_HTOP;
const Y_TONY   = (Y_DEBBIE + GRID_BB + 24) - GRID_HTOP;
const Y_GRAND  = (Y_TONY   + GRID_BB + 24) - GRID_HTOP;
const Y_TALL   = (Y_GRAND  + GRID_BB + 24) - GRID_HTOP;
renderRow(ROWS[0], Y_DEBBIE, { alignLeft:true, alignRight:true });
renderRow(ROWS[1], Y_TONY,   { alignLeft:true, alignRight:true });

// ── 아래 두 줄(할머니·조지·브웨 / 톨보이·스몰보이) 왼쪽 + 오른쪽 좌석맵 ──
const SHORT = { mr_braithwaite:"BRAITH." };            // 좁은 칸용 짧은 라벨
const leftBig = { x0:200, w:352, pitch:70, d:58, hfs:12, label:SHORT };
renderRow(ROWS[2], Y_GRAND, { ...leftBig, alignRight:true });   // 할머니·조지·브웨
renderRow(ROWS[3], Y_TALL,  leftBig);                           // 톨보이·스몰보이
// 좌석맵(오른쪽) — 오른끝은 그리드 오른끝, 바닥은 톨보이 숫자단추 바닥에 맞춤(비율 258:262 유지)
const gridRight = CX0 + CW - CELL_PITCH/2 + CELL_D/2;   // 맨 오른쪽 셀(전수미) 사진 오른쪽 끝
const smH = (Y_TALL + GRID_BB) - (Y_GRAND + 24), smW = smH * (258/262);
const smX = gridRight - smW;
heading("SEAT MAP", smX, Y_GRAND + 14, smW, 12.5);
P(`<rect id="fn-seatbox" x="${smX.toFixed(1)}" y="${(Y_GRAND + 24).toFixed(1)}" width="${smW.toFixed(1)}" height="${smH.toFixed(1)}" fill="none"/>`);

// ── 배역 순서 이어서: 톨보이 아래로. 오른쪽 끝=다른 줄(gridRight)에 정렬, 왼쪽은 소년 발 위까지 확장(겹침 허용) ──
const EX_L = 40, EX_R = gridRight;
// 하위그룹들을 한 줄에 배치하되 셀 바깥이 [EX_L, EX_R]에 딱 맞게(오른쪽 정렬). 팀(teamId)은 함께관극수를 선 위·오른쪽.
function groupRow(groups, yTop, d){
  const totalN = groups.reduce((s, g) => s + g.n, 0); if(totalN <= 0) return;
  const pitch = totalN > 1 ? (EX_R - EX_L - d) / (totalN - 1) : 0;
  const cxOf = i => EX_L + d/2 + i*pitch;   // i번째 셀 중심
  let idx = 0;
  groups.forEach(g => {
    if(g.n <= 0) return;
    const firstLeft = cxOf(idx) - d/2, lastRight = cxOf(idx + g.n - 1) + d/2;
    heading(g.label, firstLeft, yTop + 14, lastRight - firstLeft, 13);
    if(g.teamId)   // 팀 함께관극수(내/전체) — 실선 위쪽, 오른쪽 정렬(값은 finale.js가 채움)
      P(`<text id="fn-group-${g.teamId}" x="${lastRight.toFixed(1)}" y="${(yTop + 12).toFixed(1)}" text-anchor="end" font-family="IBM Plex Sans KR Medm, sans-serif" font-size="12" font-weight="700" fill="${BLUE_D}">0</text>`);
    for(let i=0;i<g.n;i++){ cell(g.slot, i, cxOf(idx), yTop + 24, d, false, true); idx++; }
  });
}
// ── 발레·앙상블: small 헤딩 glyphTop=yTop+1.9, 발레 이름 바닥=yTop+24+d+max(9,d*0.26) ──
const SMALL_HTOP = 1.9, BALLET_D = 48, ENS_D = 38;
const Y_BALLET = (Y_TALL + GRID_BB + 12) - SMALL_HTOP;                        // 톨보이 단추 보톰 + 12
const balletBottom = Y_BALLET + 24 + BALLET_D + Math.max(9, BALLET_D*0.26);   // 발레 이름 baseline(바닥)
const Y_ENS = (balletBottom + 9) - SMALL_HTOP;                                // 발레 이름 바닥 + 9
// 발레걸즈: adult(상시) + 애싱턴 + 베들링턴 = 한 줄(4·5·5)
groupRow([
  { slot:"ballet_girls",            label:"BALLET GIRLS", n:ADULT_N, teamId:null },
  { slot:"ballet_girls_ashington",  label:"ASHINGTON",    n:ASH_N,   teamId:"ashington" },
  { slot:"ballet_girls_bedlington", label:"BEDLINGTON",   n:BED_N,   teamId:"bedlington" }
], Y_BALLET, BALLET_D);
// 앙상블 — 발레 바로 아래
groupRow([{ slot:"ensemble", label:"ENSEMBLE", n:ENS_N, teamId:null }], Y_ENS, ENS_D);

P(`</svg>`);

const svg = out.join("\n").replace("__DEFS__", `<defs>\n${defs.join("\n")}\n</defs>`);
const dest = `${SHOW}/images/finale-board-${OUT_ID}.svg`;
fs.writeFileSync(dest, svg);
console.log("wrote", dest, svg.length, "bytes");
