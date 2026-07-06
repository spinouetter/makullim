/* 스케줄 표 스크린샷 생성기 (미리보기/공유용)
 * - 앱을 정적 서버로 띄우고, localStorage에 표시 설정을 주입해 스케줄 표만 캡처한다.
 * - 설정(테마·막공·배역 그룹 등)은 아래 CONFIG, 배우/대결 이름은 shows/<id>/*.json에서 읽는다(데이터 주도).
 *
 * 만들어지는 이미지(기본 OUT = <repo>/shots, 커밋 대상 아님):
 *   schedule_<group>.png            그룹별 전체 막공 리스트 1장
 *   billy_<group>_<배우>.png        '주역(빌리)' 필터를 배우별로 건 것(모든 장 높이 동일)
 *
 * 로컬 실행:  PW_CHROMIUM=/path/to/chrome node scripts/gen-schedule-shots.js [showId]
 * CI 실행:    npx playwright install chromium && node scripts/gen-schedule-shots.js [showId]
 * 옵션(환경변수): SHOTS_OUT=출력폴더  ONLY=base|billy(둘 중 하나만)  VW=폭(기본 400)
 */
const fs = require("fs"), http = require("http"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".json":"application/json",
  ".css":"text/css", ".svg":"image/svg+xml", ".woff2":"font/woff2", ".ttf":"font/ttf", ".png":"image/png",
  ".jpeg":"image/jpeg", ".jpg":"image/jpeg", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json" };

let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require("playwright-core")); }

// ── 설정(스크린샷 사양) ─────────────────────────────────────────────
const SHOW_ID = process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT,"shows","index.json"),"utf8")).default;
const VW = Number(process.env.VW) || 400;         // 모바일 가정 폭(px)
const DSF = 2;                                     // 캡처 배율
const LEAD_ROLE = "빌리";                          // 주역(오버레이 스크롤 기준 + 빌리 필터 대상)
const HIDE_COLS = ["좌석", "메모"];                // 완전히 숨길 고정 열(오버레이/스크롤로 대체)
const OUT = process.env.SHOTS_OUT || path.join(ROOT, "shots");
const ONLY = process.env.ONLY || "";               // "base" 또는 "billy"만 생성
// 배우 목록 그룹: 각 화면에 보일 배역 4개(첫 번째가 주역이어야 오버레이 스크롤이 자연스러움)
const GROUPS = [
  { name: "g1", show: ["빌리", "마이클", "데비", "성인빌리"] },
  { name: "g2", show: ["빌리", "Mrs. 윌킨슨", "아빠", "할머니"] },
];
// 막공/테마 등 표시 상태(요청 사양)
const STATE = {
  colorTheme: "tutu",
  lastShowRoleOn: true, lastShowPairOn: false,
  lastShowLeadOn: true, lastShowLeadRole: LEAD_ROLE,
  lastShowPairOnlyOn: true, lastShowPairRoles: [],
  floatDateOn: true,
};

// ── 공연 데이터에서 배역/대결 이름 읽기(하드코딩 금지) ──────────────
function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
const castsRaw = readJson(path.join(ROOT, "shows", SHOW_ID, "casts.json"));
const casts = Array.isArray(castsRaw) ? castsRaw : (castsRaw.casts || castsRaw.roles || []);
const ALL_ROLES = casts.filter(c => !c.group && Array.isArray(c.actors)).map(c => c.role);
const LEAD_ACTORS = (casts.find(c => c.role === LEAD_ROLE)?.actors || []).map(a => a.name);
let MATCH_NAMES = [];
try {
  const m = readJson(path.join(ROOT, "shows", SHOW_ID, "matches.json"));
  MATCH_NAMES = (Array.isArray(m) ? m : (m.matches || [])).map(x => x.name).filter(Boolean);
} catch { /* 대결 없음 */ }

// 그룹에서 숨길 컬럼: 안 보이는 배역 + 가격/티켓 + 모든 대결
function hiddenColsFor(group){
  return ALL_ROLES.filter(r => !group.show.includes(r))
    .concat(["__price__", "__ticket__"])
    .concat(MATCH_NAMES.map(n => "match:" + n));
}

const srv = http.createServer((q, r) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split("?")[0]));
  if (!fp.startsWith(ROOT)) { r.writeHead(403); r.end(); return; }
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    r.end(d);
  });
});

// 표시 설정 주입 → 리로드 → 표 폭/높이/가로스크롤 보정. fixedH가 있으면 그 높이로, contentH 반환.
async function prepare(page, port, opts){
  const { hidden, roleFilter } = opts;
  await page.evaluate(({ STATE, hidden, roleFilter }) => {
    const key = Object.keys(localStorage).find(k => k.startsWith("makollim:state:v1:"));
    const st = JSON.parse(localStorage.getItem(key) || "{}");
    Object.assign(st, STATE);
    st.scheduleHiddenCols = hidden;
    st.scheduleRoleFilter = roleFilter || {};
    localStorage.setItem(key, JSON.stringify(st));
  }, { STATE, hidden, roleFilter });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  return await page.evaluate(({ VW, LEAD_ROLE, HIDE_COLS, fixedH }) => {
    const table = document.querySelector("#scheduleTable");
    const wrap = document.querySelector(".table-scroll-wrap");
    // 고정 열(좌석·메모 등) 완전 숨김 — 헤더 th + 본문 td
    document.querySelectorAll("#scheduleHead th").forEach(th => {
      const t = th.innerText.replace(/\s+/g, " ").trim();
      if (HIDE_COLS.includes(t)) th.style.display = "none";
    });
    document.querySelectorAll("#scheduleBody td.seat-cell, #scheduleBody td.memo-cell").forEach(td => td.style.display = "none");
    // 오버레이(float-label) 폭 측정을 위해 min-width 해제 후 살짝 스크롤
    table.style.minWidth = "0px";
    wrap.scrollLeft = 120; wrap.dispatchEvent(new Event("scroll", { bubbles: true }));
    const overlay = document.querySelector(".float-label");
    const ovW = overlay ? Math.ceil(overlay.getBoundingClientRect().width) : 80;
    const leadOf = () => [...document.querySelectorAll("#scheduleHead th")]
      .find(t => t.innerText.replace(/\s+/g, " ").trim().startsWith(LEAD_ROLE));
    const leadNat = leadOf()?.offsetLeft || 0;
    // 배역 열들이 오버레이 오른쪽 영역을 채우도록 표 폭 강제(오른쪽 16px 여백)
    table.style.minWidth = (leadNat + (VW - ovW) - 16) + "px";
    // 헤더 float-cell은 비어 있어 경계 열 헤더가 왼쪽에 비침 → '날짜' 라벨로 덮음
    const hth = document.querySelector("#scheduleHead th.float-cell");
    if (hth) hth.innerHTML = `<div class="float-label" style="display:flex;box-sizing:border-box;width:${ovW}px;justify-content:flex-start;">날짜</div>`;
    // 전체 리스트가 한 장에: 세로 스크롤 제거 + 표 높이에 맞춤(또는 고정 높이)
    wrap.style.flex = "none"; wrap.style.maxHeight = "none"; wrap.style.overflowY = "visible";
    const contentH = table.offsetHeight;
    wrap.style.height = (fixedH || contentH) + "px";
    // 주역 열을 오버레이 바로 오른쪽에 오도록 가로 스크롤
    const leadLeft = leadOf()?.offsetLeft || leadNat;
    wrap.scrollLeft = Math.max(0, Math.min(wrap.scrollWidth - wrap.clientWidth, leadLeft - ovW - 2));
    wrap.dispatchEvent(new Event("scroll", { bubbles: true }));
    return { ovW, contentH };
  }, { VW, LEAD_ROLE, HIDE_COLS, fixedH: opts.fixedH || 0 });
}

async function shoot(page, file){
  await page.waitForTimeout(300);
  const el = await page.$(".table-scroll-wrap");
  await el.screenshot({ path: file });
}

srv.listen(0, "127.0.0.1", async () => {
  const port = srv.address().port;
  const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM, args: ["--no-sandbox"] } : {};
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage({ viewport: { width: VW, height: 2600 }, deviceScaleFactor: DSF, isMobile: true, hasTouch: true });
  page.on("pageerror", e => console.warn("  [pageerror]", e.message));
  await page.goto(`http://127.0.0.1:${port}/index.html?show=${encodeURIComponent(SHOW_ID)}`, { waitUntil: "networkidle" });
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`show=${SHOW_ID}  폭=${VW}  배역=${ALL_ROLES.length}개  ${LEAD_ROLE}=${LEAD_ACTORS.join("/")}  대결=${MATCH_NAMES.join("/")||"없음"}`);

  // 1) 그룹별 전체 막공 리스트 1장
  if (ONLY !== "billy") {
    for (const g of GROUPS) {
      await prepare(page, port, { hidden: hiddenColsFor(g) });
      const f = path.join(OUT, `schedule_${g.name}.png`);
      await shoot(page, f);
      console.log("base :", path.basename(f));
    }
  }

  // 2) 주역(빌리) 필터를 배우별로 — 모든 장 높이 동일(최댓값 기준)
  if (ONLY !== "base") {
    // PASS A: 콘텐츠 높이 측정
    const jobs = [];
    for (const g of GROUPS) for (const actor of LEAD_ACTORS) jobs.push({ g, actor });
    let maxH = 0;
    for (const j of jobs) {
      const { contentH } = await prepare(page, port, { hidden: hiddenColsFor(j.g), roleFilter: { [LEAD_ROLE]: [j.actor] } });
      j.h = contentH; if (contentH > maxH) maxH = contentH;
    }
    console.log("billy 최대 높이 =", maxH);
    // PASS B: 동일 높이로 캡처
    for (const j of jobs) {
      await prepare(page, port, { hidden: hiddenColsFor(j.g), roleFilter: { [LEAD_ROLE]: [j.actor] }, fixedH: maxH });
      const f = path.join(OUT, `billy_${j.g.name}_${j.actor}.png`);
      await shoot(page, f);
      console.log("billy:", path.basename(f), `(내용 ${j.h}px → ${maxH}px)`);
    }
  }

  await browser.close(); srv.close();
  console.log("완료 →", OUT);
  process.exit(0);
});
