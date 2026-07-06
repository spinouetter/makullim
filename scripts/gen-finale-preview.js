/* 피날레 '관극 인증 이미지' 미리보기 썸네일 생성기 (GitHub Action용)
 * - 앱을 정적 서버로 띄우고 ?show=<id>&randomData=<시드> 로 보드를 렌더(관극수·좌석수 랜덤, 사진 없으면 플레이스홀더)
 * - shows/index.json의 모든 공연을 순회, 렌더된 보드 SVG를 PNG로 캡처해
 *   shows/<id>/images/finale-preview.jpg 에 저장
 * 로컬 실행:  PW_CHROMIUM=/path/to/chrome node scripts/gen-finale-preview.js
 * CI 실행:    npx playwright install chromium && node scripts/gen-finale-preview.js
 */
const fs = require("fs"), http = require("http"), path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript", ".json":"application/json",
  ".css":"text/css", ".svg":"image/svg+xml", ".woff2":"font/woff2", ".ttf":"font/ttf", ".png":"image/png",
  ".jpeg":"image/jpeg", ".jpg":"image/jpeg", ".ico":"image/x-icon", ".webmanifest":"application/manifest+json" };

let chromium;
try { ({ chromium } = require("playwright")); }
catch { ({ chromium } = require("playwright-core")); }

const srv = http.createServer((q, r) => {
  const fp = path.join(ROOT, decodeURIComponent(q.url.split("?")[0]));
  if (!fp.startsWith(ROOT)) { r.writeHead(403); r.end(); return; }
  fs.readFile(fp, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" });
    r.end(d);
  });
});

// 공연 1개 렌더·캡처 (page는 재사용)
async function capture(page, port, id) {
  const OUT = path.join(ROOT, "shows", id, "images", "finale-preview.jpg");
  const errs = [];
  const onErr = e => errs.push(e.message);
  page.on("pageerror", onErr);
  try {
    // 1) 앱을 먼저 열어 '마지막(가장 최근에 끝난) 공연 id'를 시드로 계산
    //    → 같은 공연이 마지막인 동안엔 커밋해도 동일한 이미지가 나옴(공연이 끝나면 시드 변경)
    await page.goto(`http://127.0.0.1:${port}/index.html?show=${encodeURIComponent(id)}`, { waitUntil: "networkidle" });
    const seed = await page.evaluate(() => {
      const ps = (typeof performanceData !== "undefined" && performanceData && performanceData.performances) || [];
      const ended = ps.filter(p => (typeof isEnded === "function") ? isEnded(p) : true);
      const pool = ended.length ? ended : ps;
      let last = "";
      pool.forEach(p => { const k = (p.date || "") + " " + (p.time || ""); if (k > last) last = k; });
      return last.trim() || "makullim-finale";
    });
    console.log(`[${id}] 시드(마지막 공연 id):`, seed);

    // 2) 시드 기반 랜덤 데이터로 보드 렌더
    await page.goto(`http://127.0.0.1:${port}/index.html?show=${encodeURIComponent(id)}&randomData=${encodeURIComponent(seed)}`, { waitUntil: "networkidle" });
    await page.evaluate(() => {
      document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
      document.getElementById("page-finale").classList.add("active");
    });
    await page.evaluate(async () => { if (window.renderFinaleBoard) await window.renderFinaleBoard(); });
    await page.waitForSelector("#finaleBoardSvg", { state: "attached", timeout: 20000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch {}
    await page.waitForTimeout(1800);   // fitRoleLabels 등 후처리 대기
    // 보드 SVG만 캡처 박스에 담고, 나머지 페이지(헤더·갤러리)는 숨겨서 보드만 캡처
    await page.evaluate(() => {
      const svg = document.getElementById("finaleBoardSvg");
      svg.removeAttribute("style");
      svg.style.cssText = "display:block;width:760px;height:auto;";
      const box = document.createElement("div");
      box.id = "capbox"; box.style.cssText = "width:760px;background:#fff;";
      box.appendChild(svg);
      document.body.prepend(box);
      [...document.body.children].forEach(el => { if (el !== box) el.style.display = "none"; });
      document.documentElement.style.background = "#fff"; document.body.style.cssText = "margin:0;background:#fff;";
    });
    await page.waitForTimeout(200);
    const el = await page.$("#capbox");
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    await el.screenshot({ path: OUT, type: "jpeg", quality: 82 });   // 사진 많은 보드 → JPG가 PNG보다 훨씬 작음
    const kb = Math.round(fs.statSync(OUT).size / 1024);
    console.log(`[${id}] finale-preview.jpg 생성 완료 (${kb} KB)` + (errs.length ? `  [pageErrors: ${errs.slice(0,2).join(" | ")}]` : ""));
    return true;
  } catch (e) {
    console.error(`[${id}] 생성 실패:`, e.message, errs.slice(0, 3));
    return false;
  } finally {
    page.off("pageerror", onErr);
  }
}

srv.listen(0, "127.0.0.1", async () => {
  const port = srv.address().port;
  // 시스템 크롬(PW_CHROMIUM 지정)은 CI(루트/샌드박스 제약)에서 --no-sandbox 필요
  const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM, args: ["--no-sandbox"] } : {};
  const browser = await chromium.launch(launchOpts);
  // 썸네일(갤러리용)이라 고해상도 불필요 — dpr 1로 캡처해 파일 크기를 ~1/4로 줄인다(로딩 지연 완화).
  const page = await browser.newPage({ viewport: { width: 900, height: 1400 }, deviceScaleFactor: 1 });
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "shows", "index.json"), "utf8")).shows || [];
  let fail = 0;
  for (const id of ids) {
    // Finale 보드가 없는 공연은 썸네일 대상이 아님 — 건너뜀
    let boards = [];
    try { boards = (JSON.parse(fs.readFileSync(path.join(ROOT, "shows", id, "finale-boards.json"), "utf8")).boards || []).filter(b => !b.hidden); } catch {}
    if (!boards.length) { console.log(`[${id}] 보드 없음 — 건너뜀`); continue; }
    if (!(await capture(page, port, id))) fail++;
  }
  await browser.close(); srv.close();
  console.log(`공연 ${ids.length}개 중 ${ids.length - fail}개 썸네일 생성`);
  process.exit(fail ? 1 : 0);
});
