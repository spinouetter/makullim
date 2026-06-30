/* =========================================================
   finale.js — 트위터 공유용 '인증 이미지'(Finale) 탭
   - casts.json(배역 순서·로스터) + casting_by_date.json(날짜별 상세 캐스트)로
     배역별 배우 카드(관극 / 전체)와 내가 본 좌석 히트맵을 한 장의 포스터 SVG로.
   - 숫자(관극 횟수)는 클릭해 직접 수정 가능. SVG / PNG / JPG / PDF(벡터) 저장.
   주의: app.js 전역(performanceData, seatmapData, isEnded, hasSeat,
        countHeatColor, kstStamp)을 함수 호출 시점에 참조한다. (app.js 이후 로드)
   ========================================================= */
(function(){
  "use strict";

  // ---- 설정값 ----
  const CBD_PATH = "json/casting_by_date.json";
  // PDF 벡터화용 외부 라이브러리 + 한글 폰트(요청 시 1회 로드, 캐시)
  const JSPDF_URL   = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
  const SVG2PDF_URL = "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js";
  const KRFONT_URL  = "https://cdn.jsdelivr.net/gh/google/fonts/ofl/nanumgothic/NanumGothic-Regular.ttf";

  // 레이아웃 상수(SVG 내부 좌표 = px)
  const CARD_W = 116, PHOTO = 96, CARD_GAP = 6;
  const CARD_H = PHOTO + 48;          // 사진 + 태그줄 + 이름 + 카운트
  const UNIT = CARD_W + CARD_GAP;     // 카드 1칸 폭
  const PER_ROW = 8;                  // 한 블록 내 카드 최대 가로 개수
  const HDR_H = 30;                   // 배역 헤더 높이
  const CARD_ROW_GAP = 8;
  const CONTENT_W = PER_ROW * UNIT;   // 패널 내부 콘텐츠 폭
  const BLOCK_GAP_X = 20, BLOCK_GAP_Y = 22;
  const PANEL_PAD = 26, OUTER = 20;
  const HEADER_H = 150;               // 상단 제목 영역(흰 배경)
  const SEAT_W = 5 * UNIT;            // 좌석 블록 폭

  const RED = "#c41e1e", RED_DK = "#a81717", GOLD = "#ffd24a";

  // ---- 상태 ----
  let cbdCache = null;
  let finaleOverrides = loadOverrides();   // {key: number}
  let booted = false;

  // ---- 유틸 ----
  function ovrKey(){ return "makollim:finale:" + (performanceData && performanceData.title ? performanceData.title : "default"); }
  function loadOverrides(){ try{ return JSON.parse(localStorage.getItem("makollim:finaleOverrides")||"{}") || {}; }catch(e){ return {}; } }
  function saveOverrides(){ try{ localStorage.setItem("makollim:finaleOverrides", JSON.stringify(finaleOverrides)); }catch(e){} }
  function setOverride(key, val){ if(val==null || isNaN(val)) delete finaleOverrides[key]; else finaleOverrides[key]=val; saveOverrides(); }
  function esc(s){ return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

  async function loadCbd(){
    if(cbdCache) return cbdCache;
    try{ const r = await fetch(CBD_PATH); cbdCache = r.ok ? await r.json() : {}; }
    catch(e){ console.warn("casting_by_date 로드 실패:", e.message); cbdCache = {}; }
    return cbdCache;
  }

  // ---- 캐스트 정규화 ----
  const ROLE_ALIAS = { "브레이스웨이트": "브웨" };       // casting_by_date 역할명 → casts.json 키
  const ROLE_LABEL = { "브웨": "브레이스웨이트" };       // 표시용 라벨 보정
  const TAG_LABEL  = { cast:"", cover:"커버", standby:"스탠바이", swing:"스윙" };
  function normRole(r){ return ROLE_ALIAS[r] || r; }
  function roleLabel(r){ return ROLE_LABEL[r] || r; }
  function tagOf(t){ return TAG_LABEL[t] !== undefined ? TAG_LABEL[t] : (t || ""); }
  function firstName(v){ return Array.isArray(v) ? String(v[0]||"").trim() : String(v||"").trim(); }

  // 한 공연의 상세 캐스트 {role: name} + 앙상블 세부배역 {name: subrole}
  function castOfPerf(p, cbd){
    const out = {}, sub = {};
    if(p.cast) for(const role in p.cast){ const nm = firstName(p.cast[role]); if(nm) out[normRole(role)] = [nm]; }
    const entry = cbd[`${p.date} ${p.time}`];
    if(entry){
      delete out["발레걸즈"];   // 그룹 → 상세 배역으로 대체
      for(const role in entry){
        const val = entry[role];
        if(role === "앙상블" && Array.isArray(val)){
          out["앙상블"] = val.map(x=>Array.isArray(x)?x[0]:x).filter(Boolean);
          val.forEach(x=>{ if(Array.isArray(x) && x[0]) sub[x[0]] = x[1] || ""; });
        } else {
          const nm = firstName(val); if(nm) out[normRole(role)] = [nm];
        }
      }
    }
    return { cast: out, sub };
  }

  function periodStr(){
    const s = performanceData.startDate, e = performanceData.endDate;
    const f = d => (d||"").replace(/-/g, ".");
    return (s && e) ? `${f(s)} ~ ${f(e)}` : "";
  }
  function seatWatchCount(id){
    return performanceData.performances.filter(p => p.seat===id && isEnded(p)).length;
  }

  // ---- 데이터 집계 ----
  function computeFinaleData(cbd){
    const perfs = performanceData.performances;
    const casts = performanceData.casts || [];
    const principalSet = new Set(casts.map(c=>normRole(c.role)));

    const agg = {};      // role -> Map(name -> {total, watched, sub})
    const ensSub = {};
    function bump(role, name, ended, seated, subrole){
      if(!agg[role]) agg[role] = new Map();
      let m = agg[role].get(name);
      if(!m){ m = {total:0, watched:0, sub:subrole||""}; agg[role].set(name, m); }
      m.total++; if(ended && seated) m.watched++;
      if(subrole && !m.sub) m.sub = subrole;
    }
    perfs.forEach(p=>{
      const ended = isEnded(p), seated = hasSeat(p);
      const { cast, sub } = castOfPerf(p, cbd);
      Object.assign(ensSub, sub);
      for(const role in cast) cast[role].forEach(nm => bump(role, nm, ended, seated, sub[nm]));
    });

    const groups = [];
    // (a) 주연 역할 — casts.json 순서, 발레걸즈는 따로
    casts.forEach(c=>{
      const role = normRole(c.role);
      if(role === "발레걸즈") return;
      const m = agg[role] || new Map();
      const roster = [], seen = new Set();
      c.actors.forEach(a=>{ roster.push({name:a.name, tag:tagOf(a.role)}); seen.add(a.name); });
      m.forEach((v,name)=>{ if(!seen.has(name)){ roster.push({name, tag:tagOf(v.sub)}); seen.add(name); } });
      const cards = roster.map(r=>{ const v = m.get(r.name) || {total:0,watched:0}; return {name:r.name, tag:r.tag, total:v.total, watched:v.watched}; });
      groups.push({ role: roleLabel(role), cards });
    });
    // (b) 발레걸즈 — 주연 밖 + 앙상블 제외 역할의 배우 합산
    const ballet = new Map();
    for(const role in agg){
      if(principalSet.has(role) || role === "앙상블") continue;
      agg[role].forEach((v,name)=>{
        let b = ballet.get(name);
        if(!b){ b = {total:0, watched:0, sub:v.sub||role}; ballet.set(name, b); }
        b.total += v.total; b.watched += v.watched;
      });
    }
    if(ballet.size){
      const cards = [];
      ballet.forEach((v,name)=>cards.push({name, tag:v.sub||"", total:v.total, watched:v.watched}));
      cards.sort((a,b)=>b.total-a.total);
      groups.push({ role:"발레걸즈", cards });
    }
    // (c) 앙상블
    if(agg["앙상블"]){
      const cards = [];
      agg["앙상블"].forEach((v,name)=>cards.push({name, tag:ensSub[name]||"", total:v.total, watched:v.watched}));
      cards.sort((a,b)=>b.total-a.total);
      groups.push({ role:"앙상블", cards });
    }

    const seats = seatmapData.seats.map(s=>({ x:s.svgX, y:s.svgY, floor:s.floor, count: seatWatchCount(s.id) }));
    const totalRun = perfs.length;
    const totalWatched = perfs.filter(p=>isEnded(p) && hasSeat(p)).length;
    return { groups, seats, totalRun, totalWatched,
             title: performanceData.title || "MAKOLLIM",
             theatre: (seatmapData && seatmapData.theater) || "",
             period: periodStr() };
  }

  // ---- 컴팩트 좌석 히트맵 ----
  function seatGridSvg(seats, maxW){
    const floors = [...new Set(seats.map(s=>s.floor))].sort((a,b)=>a-b);
    const GAPF = 1.5;
    let cursorY = 0, worldMinX = Infinity, worldMaxX = -Infinity;
    const blocks = [];
    floors.forEach(f=>{
      const fs = seats.filter(s=>s.floor===f);
      if(!fs.length) return;
      const xs = fs.map(s=>s.x), ys = fs.map(s=>s.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      blocks.push({ fs, minX, minY, top: cursorY });
      cursorY += (maxY - minY) + GAPF;
      worldMinX = Math.min(worldMinX, minX); worldMaxX = Math.max(worldMaxX, maxX);
    });
    const worldW = (worldMaxX - worldMinX) || 1;
    const worldH = cursorY - GAPF;
    const scale = maxW / (worldW + 1);
    const sz = Math.max(2.4, 0.86 * scale);
    let mk = "";
    blocks.forEach(b=>{
      b.fs.forEach(s=>{
        const x = (s.x - worldMinX) * scale;
        const y = (b.top + (s.y - b.minY)) * scale;
        const color = s.count > 0 ? countHeatColor(s.count) : "rgba(255,255,255,0.14)";
        mk += `<rect x="${(x-sz/2).toFixed(1)}" y="${(y-sz/2).toFixed(1)}" width="${sz.toFixed(1)}" height="${sz.toFixed(1)}" rx="${(sz*0.18).toFixed(1)}" fill="${color}"/>`;
      });
    });
    return { markup: mk, w: maxW, h: Math.max(40, worldH * scale) };
  }

  // ---- 카드 / 블록 ----
  function cardMarkup(card, key){
    const num = (key in finaleOverrides && finaleOverrides[key] != null) ? finaleOverrides[key] : card.watched;
    const px = (CARD_W - PHOTO) / 2;
    const tag = card.tag ? `<text x="${CARD_W/2}" y="${PHOTO+12}" text-anchor="middle" font-size="9" fill="#ffe9a8">${esc(card.tag)}</text>` : "";
    return `
      <g>
        <rect x="${px}" y="0" width="${PHOTO}" height="${PHOTO}" rx="6" fill="#eef1f4"/>
        <use href="#finaleFace" x="${px}" y="0" width="${PHOTO}" height="${PHOTO}"/>
        <rect x="${px}" y="0" width="${PHOTO}" height="${PHOTO}" rx="6" fill="none" stroke="rgba(0,0,0,0.12)" stroke-width="1"/>
        ${tag}
        <text x="${CARD_W/2}" y="${PHOTO+27}" text-anchor="middle" font-size="13" font-weight="700" fill="#fff">${esc(card.name)}</text>
        <text x="${CARD_W/2}" y="${PHOTO+43}" text-anchor="middle" font-size="12" fill="#ffffff">
          <tspan class="finale-num" data-key="${esc(key)}" fill="${GOLD}" font-weight="700">${num}</tspan> / ${card.total}
        </text>
      </g>`;
  }

  function roleBlock(group){
    const n = group.cards.length;
    const per = Math.min(n, PER_ROW) || 1;
    const rows = Math.ceil(n / PER_ROW) || 1;
    const w = per * UNIT;
    const h = HDR_H + rows * (CARD_H + CARD_ROW_GAP) - CARD_ROW_GAP;
    let cards = "";
    group.cards.forEach((c,i)=>{
      const col = i % PER_ROW, row = Math.floor(i / PER_ROW);
      const cx = col * UNIT, cy = HDR_H + row * (CARD_H + CARD_ROW_GAP);
      cards += `<g transform="translate(${cx},${cy})">${cardMarkup(c, `c|${group.role}|${c.name}`)}</g>`;
    });
    const markup = `
      <text x="0" y="18" font-size="17" font-weight="800" fill="#fff" letter-spacing="0.4">${esc(group.role)}</text>
      <rect x="0" y="24" width="${w-CARD_GAP}" height="2.4" fill="rgba(255,255,255,0.7)"/>
      ${cards}`;
    return { type:"role", w, h, markup };
  }

  function seatBlock(data){
    const grid = seatGridSvg(data.seats, SEAT_W);
    const legendY = HDR_H + grid.h + 14;
    const items = [["1",1],["2",2],["3",3],["4+",4]];
    let legend = `<text x="0" y="${legendY}" font-size="11" fill="rgba(255,255,255,0.85)">관극 횟수</text>`;
    let lx = 70;
    items.forEach(([lab,c])=>{
      legend += `<rect x="${lx}" y="${legendY-9}" width="11" height="11" rx="2" fill="${countHeatColor(c)}"/>`
              + `<text x="${lx+15}" y="${legendY}" font-size="11" fill="#fff">${lab}</text>`;
      lx += 42;
    });
    legend += `<rect x="${lx}" y="${legendY-9}" width="11" height="11" rx="2" fill="rgba(255,255,255,0.14)"/>`
            + `<text x="${lx+15}" y="${legendY}" font-size="11" fill="#fff">안 봄</text>`;
    const totalY = legendY + 30;
    const tNum = ("t|total" in finaleOverrides && finaleOverrides["t|total"] != null) ? finaleOverrides["t|total"] : data.totalWatched;
    const total = `<text x="${SEAT_W}" y="${totalY}" text-anchor="end" font-size="24" font-style="italic" font-weight="800" fill="#fff">`
                + `Total <tspan class="finale-num" data-key="t|total" fill="${GOLD}">${tNum}</tspan> / ${data.totalRun}</text>`;
    const markup = `
      <text x="0" y="18" font-size="17" font-weight="800" fill="#fff">관극 좌석</text>
      <rect x="0" y="24" width="${SEAT_W}" height="2.4" fill="rgba(255,255,255,0.7)"/>
      <g transform="translate(0,${HDR_H})">${grid.markup}</g>
      ${legend}
      ${total}`;
    return { type:"seat", w: SEAT_W, h: totalY + 8, markup };
  }

  // 블록을 콘텐츠 폭에 맞춰 좌→우로 채우는 셸프 패커
  function packBlocks(blocks){
    let x = 0, y = 0, rowH = 0;
    blocks.forEach(b=>{
      if(x > 0 && x + b.w > CONTENT_W){ x = 0; y += rowH + BLOCK_GAP_Y; rowH = 0; }
      b.x = x; b.y = y;
      x += b.w + BLOCK_GAP_X; rowH = Math.max(rowH, b.h);
    });
    return y + rowH; // 전체 콘텐츠 높이
  }

  // ---- 포스터 SVG 조립 ----
  function buildFinaleSvg(data){
    const blocks = data.groups.map(roleBlock);
    const seat = seatBlock(data);
    blocks.splice(Math.min(10, blocks.length), 0, seat);   // 주연 뒤쯤에 좌석 블록
    const contentH = Math.ceil(packBlocks(blocks));

    const W = OUTER*2 + PANEL_PAD*2 + CONTENT_W;
    const panelX = OUTER, panelY = HEADER_H;
    const panelW = W - OUTER*2;
    const panelH = PANEL_PAD*2 + contentH;
    const H = HEADER_H + panelH + OUTER;

    const body = blocks.map(b=>`<g transform="translate(${panelX+PANEL_PAD+b.x},${panelY+PANEL_PAD+b.y})">${b.markup}</g>`).join("");

    const sub = [data.period, data.theatre].filter(Boolean).join("   ·   ");
    const defs = `
      <defs>
        <style>text{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;}</style>
        <symbol id="finaleFace" viewBox="0 0 100 100">
          <rect width="100" height="100" fill="#dfe3e8"/>
          <circle cx="50" cy="39" r="19" fill="#aeb6bf"/>
          <path d="M14 96c0-21 16-32 36-32s36 11 36 32z" fill="#aeb6bf"/>
        </symbol>
      </defs>`;

    return {
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
        ${defs}
        <rect width="${W}" height="${H}" fill="#ffffff"/>
        <text x="${W/2}" y="74" text-anchor="middle" font-size="46" font-weight="900" fill="${RED}" letter-spacing="0.5">${esc(data.title)}</text>
        <text x="${W/2}" y="112" text-anchor="middle" font-size="18" font-weight="700" fill="#444">${esc(sub)}</text>
        <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="22" fill="${RED}"/>
        <rect x="${panelX}" y="${panelY}" width="${panelW}" height="${panelH}" rx="22" fill="none" stroke="${RED_DK}" stroke-width="2"/>
        ${body}
      </svg>`,
      w: W, h: H
    };
  }

  // ---- 렌더 ----
  function getPreview(){ return document.getElementById("finalePreview"); }
  function currentSvg(){ const c = getPreview(); return c ? c.querySelector("svg") : null; }

  function dataReady(){ return typeof performanceData !== "undefined" && performanceData && performanceData.performances && typeof seatmapData !== "undefined" && seatmapData; }
  async function renderFinale(){
    const container = getPreview();
    if(!container || !dataReady()) return;
    const cbd = await loadCbd();
    const { svg, w, h } = buildFinaleSvg(computeFinaleData(cbd));
    container.innerHTML = svg;
    const el = container.querySelector("svg");
    if(el){ el.dataset.w = w; el.dataset.h = h; el.style.width = "100%"; el.style.height = "auto"; }
  }

  // ---- 숫자 클릭 편집 ----
  function attachEditing(){
    const container = getPreview();
    if(!container) return;
    container.addEventListener("click", e=>{
      const t = e.target.closest(".finale-num");
      if(!t || container.querySelector(".finale-edit-input")) return;
      const key = t.getAttribute("data-key");
      const r = t.getBoundingClientRect(), cr = container.getBoundingClientRect();
      const inp = document.createElement("input");
      inp.type = "number"; inp.min = "0"; inp.className = "finale-edit-input";
      inp.value = t.textContent.trim();
      inp.style.cssText = `position:absolute; left:${r.left-cr.left}px; top:${r.top-cr.top-2}px;`
        + `width:${Math.max(40, r.width+18)}px; font:700 13px sans-serif; text-align:center;`
        + `border:2px solid ${RED}; border-radius:5px; padding:1px 2px; z-index:5; background:#fff; color:#111;`;
      container.appendChild(inp); inp.focus(); inp.select();
      let done = false;
      const commit = ()=>{ if(done) return; done = true; const v = parseInt(inp.value, 10); setOverride(key, isNaN(v)?null:v); inp.remove(); renderFinale(); };
      inp.addEventListener("keydown", ev=>{ if(ev.key==="Enter") commit(); else if(ev.key==="Escape"){ done=true; inp.remove(); } });
      inp.addEventListener("blur", commit);
    });
  }

  // ---- 내보내기 ----
  function stamp(){ return (typeof kstStamp === "function") ? kstStamp() : "export"; }
  function triggerDownload(blob, name){
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url), 1000);
  }
  function serializeSvg(el){
    const clone = el.cloneNode(true);
    clone.removeAttribute("style");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }

  function exportSVG(){
    const el = currentSvg(); if(!el) return;
    const data = '<?xml version="1.0" encoding="UTF-8"?>\n' + serializeSvg(el);
    triggerDownload(new Blob([data], {type:"image/svg+xml;charset=utf-8"}), `makollim-finale-${stamp()}.svg`);
  }

  async function rasterize(type, quality){
    const el = currentSvg(); if(!el) return null;
    const W = +el.dataset.w, H = +el.dataset.h, scale = 2;
    const svgStr = serializeSvg(el);
    const url = URL.createObjectURL(new Blob([svgStr], {type:"image/svg+xml;charset=utf-8"}));
    try{
      const img = new Image();
      await new Promise((res,rej)=>{ img.onload = res; img.onerror = ()=>rej(new Error("SVG 이미지 로드 실패")); img.src = url; });
      const canvas = document.createElement("canvas");
      canvas.width = W*scale; canvas.height = H*scale;
      const ctx = canvas.getContext("2d");
      if(type === "image/jpeg"){ ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height); }
      ctx.setTransform(scale,0,0,scale,0,0);
      ctx.drawImage(img, 0, 0);
      return await new Promise(res=>canvas.toBlob(res, type, quality));
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportRaster(type, ext, quality){
    const blob = await rasterize(type, quality);
    if(blob) triggerDownload(blob, `makollim-finale-${stamp()}.${ext}`);
    else alert("이미지를 만들지 못했습니다.");
  }

  function loadScript(src){
    return new Promise((res,rej)=>{
      const s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = ()=>rej(new Error("스크립트 로드 실패: "+src));
      document.head.appendChild(s);
    });
  }
  let krFontB64 = null;
  async function loadKoreanFontB64(){
    if(krFontB64) return krFontB64;
    const r = await fetch(KRFONT_URL);
    if(!r.ok) throw new Error("한글 폰트 로드 실패");
    const buf = await r.arrayBuffer();
    let bin = ""; const bytes = new Uint8Array(buf);
    for(let i=0;i<bytes.length;i++) bin += String.fromCharCode(bytes[i]);
    krFontB64 = btoa(bin);
    return krFontB64;
  }
  async function ensurePdfLibs(){
    if(!window.jspdf) await loadScript(JSPDF_URL);
    if(!window.svg2pdf && !(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.svg))
      await loadScript(SVG2PDF_URL);
  }

  async function exportPDF(btn){
    const el = currentSvg(); if(!el) return;
    const W = +el.dataset.w, H = +el.dataset.h;
    const label = btn ? btn.textContent : "";
    if(btn){ btn.disabled = true; btn.textContent = "PDF 생성 중…"; }
    try{
      await ensurePdfLibs();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ orientation: W>H ? "l" : "p", unit:"pt", format:[W, H] });
      // 한글 폰트 임베드(가능하면 벡터 텍스트로). 실패하면 기본 폰트로 진행.
      let fontName = null;
      try{
        const b64 = await loadKoreanFontB64();
        doc.addFileToVFS("NanumGothic.ttf", b64);
        doc.addFont("NanumGothic.ttf", "NanumGothic", "normal");
        doc.addFont("NanumGothic.ttf", "NanumGothic", "bold");
        doc.setFont("NanumGothic");
        fontName = "NanumGothic";
      }catch(fe){ console.warn("PDF 한글 폰트 임베드 실패, 기본 폰트로 진행:", fe.message); }

      const svgForPdf = el.cloneNode(true);
      if(fontName) svgForPdf.querySelectorAll("text, tspan").forEach(t=>t.setAttribute("font-family", fontName));

      if(typeof doc.svg === "function") await doc.svg(svgForPdf, { x:0, y:0, width:W, height:H });
      else await window.svg2pdf(svgForPdf, doc, { x:0, y:0, width:W, height:H });
      doc.save(`makollim-finale-${stamp()}.pdf`);
    }catch(err){
      console.error(err);
      // 벡터 실패 시 고해상도 PNG를 담은 PDF로 대체
      try{
        await ensurePdfLibs();
        const { jsPDF } = window.jspdf;
        const blob = await rasterize("image/png");
        const dataUrl = await new Promise(res=>{ const fr = new FileReader(); fr.onload = ()=>res(fr.result); fr.readAsDataURL(blob); });
        const doc = new jsPDF({ orientation: W>H ? "l":"p", unit:"pt", format:[W, H] });
        doc.addImage(dataUrl, "PNG", 0, 0, W, H);
        doc.save(`makollim-finale-${stamp()}.pdf`);
        alert("벡터 변환에 실패하여 고해상도 이미지로 된 PDF로 저장했습니다.");
      }catch(e2){ alert("PDF를 만들지 못했습니다: " + err.message); }
    }finally{
      if(btn){ btn.disabled = false; btn.textContent = label; }
    }
  }

  // ---- 초기화 ----
  function init(){
    if(booted) return; booted = true;
    attachEditing();
    const wire = (id, fn)=>{ const b = document.getElementById(id); if(b) b.addEventListener("click", ()=>fn(b)); };
    wire("finaleSvgBtn", ()=>exportSVG());
    wire("finalePngBtn", ()=>exportRaster("image/png", "png"));
    wire("finaleJpgBtn", ()=>exportRaster("image/jpeg", "jpg", 0.95));
    wire("finalePdfBtn", (b)=>exportPDF(b));
    const reset = document.getElementById("finaleResetBtn");
    if(reset) reset.addEventListener("click", ()=>{
      if(!Object.keys(finaleOverrides).length) return;
      if(confirm("직접 수정한 숫자를 모두 자동값으로 되돌릴까요?")){ finaleOverrides = {}; saveOverrides(); renderFinale(); }
    });
  }

  // app.js 탭 전환에서 호출
  window.renderFinale = function(){ renderFinale(); };
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
