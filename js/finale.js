/* =========================================================
   finale.js — 트위터 공유용 '인증 이미지'(Finale) 탭
   - images/finale-board.svg(빌리 캐스트보드 템플릿)을 불러와 슬롯 id에
     현재 casts.json 캐스트를 채운다(슬롯>캐스트→NAME, 슬롯<캐스트→위에서부터).
   - 관극수는 통계 4모드(first/start/all/weighted)에 따라 재계산.
   - 좌석 영역은 실제 좌석 다이어그램(테두리+STAGE+히트맵)으로 교체.
   - 미리보기 핀치/터치 줌. SVG/PNG/JPG/PDF 저장.
   주의: app.js 전역(performanceData, seatmapData, isEnded, hasSeat,
        countHeatColor, kstStamp, getCastContributions) 참조(app.js 이후 로드).
   ========================================================= */
(function(){
  "use strict";

  const BOARD_URL = "images/finale-board.svg?v=3";
  const META_URL  = "images/finale-board.meta.json?v=3";
  const CBD_PATH  = "json/casting_by_date.json";
  const JSPDF_URL   = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
  const SVG2PDF_URL = "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js";
  const KRFONT_URL  = "https://cdn.jsdelivr.net/gh/google/fonts/ofl/nanumgothic/NanumGothic-Regular.ttf";

  const VB_W = 760.394, VB_H = 1387.13;   // finale-board.svg viewBox

  // 보드 영문 SLUG → casts.json 한글 배역 키
  const ROLE_KEY = {
    BILLY:"빌리", MICHAEL:"마이클", DEBBIE:"데비", TALL_BOY:"톨보이", SMALL_BOY:"스몰보이",
    DAD:"아빠", MRS_WILKINSON:"Mrs. 윌킨슨", TONY:"토니", GRANDMA:"할머니", GEORGE:"조지",
    MR_BRAITHWAITE:"브웨", DEAD_MUM:"데드맘", OLD_BILLY:"성인빌리"
  };
  // 발레걸즈/앙상블 보드 슬롯(개별 로스터는 casting_by_date 집계로 채움)
  const BALLET_SLUGS = ["BALLET_GIRLS_ASHINGTON","BALLET_GIRLS_BEDLINGTON","BALLET_GIRLS_ADULTS"];
  const ENSEMBLE_SLUGS = ["ENSEMBLE"];

  const ROLE_ALIAS = { "브레이스웨이트":"브웨" };
  function normRole(r){ return ROLE_ALIAS[r] || r; }
  function firstName(v){ return Array.isArray(v) ? String(v[0]||"").trim() : String(v||"").trim(); }
  function fmt(v){ return Number.isInteger(v) ? String(v) : v.toFixed(1); }

  let cbdCache = null, seatBox = [400.7,692.1,670,913.6];
  let finaleMode = (typeof castStatsMode === "string") ? castStatsMode : "all";
  let booted = false;

  async function loadCbd(){
    if(cbdCache) return cbdCache;
    try{ const r = await fetch(CBD_PATH); cbdCache = r.ok ? await r.json() : {}; }
    catch(e){ cbdCache = {}; }
    return cbdCache;
  }
  async function loadMeta(){
    try{ const r = await fetch(META_URL); if(r.ok){ const m = await r.json(); if(Array.isArray(m.seatBox)) seatBox = m.seatBox; } }catch(e){}
  }

  function periodStr(){
    const s = performanceData.startDate, e = performanceData.endDate;
    const f = d => (d||"").replace(/-/g, ".");
    return (s && e) ? `${f(s)} ~ ${f(e)}` : "";
  }
  function seatWatchCount(id){
    return performanceData.performances.filter(p => p.seat===id && isEnded(p)).length;
  }
  function rosterOf(roleKey){
    const c = (performanceData.casts||[]).find(c=>normRole(c.role)===roleKey);
    return c ? c.actors.map(a=>a.name) : [];
  }

  // ---- 통계 집계(모드 반영) ----
  function computeData(mode, cbd){
    const perfs = performanceData.performances || [];
    const casts = performanceData.casts || [];
    const principalSet = new Set(casts.map(c=>normRole(c.role)).filter(r=>r!=="발레걸즈"));

    const pStat = {};   // 주연: role -> Map(name->{w,t})
    function pbump(role, name, amount, won){
      if(!pStat[role]) pStat[role] = new Map();
      let m = pStat[role].get(name); if(!m){ m={w:0,t:0}; pStat[role].set(name,m); }
      m.t += amount; if(won) m.w += amount;
    }
    // 발레/앙상블: cbd 상세 기준 단순 집계
    const ballet = new Map(), ensemble = new Map();
    function gbump(map, name, won){
      let m = map.get(name); if(!m){ m={w:0,t:0}; map.set(name,m); }
      m.t++; if(won) m.w++;
    }

    perfs.forEach(p=>{
      const ended = isEnded(p), seated = hasSeat(p), won = ended && seated;
      // 주연 — 모드별 기여
      if(p.cast) for(const role in p.cast){
        const rk = normRole(role);
        if(!principalSet.has(rk)) continue;
        const contribs = (typeof getCastContributions === "function")
          ? getCastContributions(p.cast[role], mode)
          : [{name:firstName(p.cast[role]), amount:1}];
        contribs.forEach(c=>{ if(c.name) pbump(rk, c.name, c.amount, won); });
      }
      // 발레/앙상블 — casting_by_date 상세
      const entry = cbd[`${p.date} ${p.time}`];
      if(entry){
        for(const role in entry){
          const rk = normRole(role);
          if(principalSet.has(rk)) continue;
          const val = entry[role];
          if(role === "앙상블" && Array.isArray(val)){
            val.forEach(x=>{ const nm = Array.isArray(x)?x[0]:x; if(nm) gbump(ensemble, nm, won); });
          } else {
            const nm = firstName(val); if(nm) gbump(ballet, nm, won);
          }
        }
      } else if(p.cast && p.cast["발레걸즈"]){
        const nm = firstName(p.cast["발레걸즈"]); if(nm) gbump(ballet, nm, won);
      }
    });

    const balletPool = [...ballet.entries()].map(([name,v])=>({name,...v})).sort((a,b)=>b.t-a.t);
    const ensemblePool = [...ensemble.entries()].map(([name,v])=>({name,...v})).sort((a,b)=>b.t-a.t);
    const totalRun = perfs.length;
    const totalWatched = perfs.filter(p=>isEnded(p) && hasSeat(p)).length;
    return { pStat, balletPool, ensemblePool, totalRun, totalWatched };
  }

  // ---- 보드 채우기 ----
  function setText(svg, id, txt){ const el = svg.getElementById ? svg.getElementById(id) : document.getElementById(id); if(el) el.textContent = txt; return el; }

  function fillRole(svg, slug, names, statMap){
    let i = 0;
    while(true){
      const nameEl = svg.querySelector(`#fn-name-${slug}-${i}`);
      if(!nameEl) break;
      const cntEl = svg.querySelector(`#fn-cnt-${slug}-${i}`);
      const nm = names[i];
      if(nm){
        nameEl.textContent = nm;
        const m = statMap && statMap.get ? statMap.get(nm) : (statMap ? statMap[nm] : null);
        if(cntEl) cntEl.textContent = m ? `${fmt(m.w)} / ${fmt(m.t)}` : "0 / 0";
      } else {
        nameEl.textContent = "NAME";
        if(cntEl) cntEl.textContent = "";
      }
      i++;
    }
    return i; // 슬롯 수
  }

  function fillBoard(svg, data){
    // 주연
    for(const slug in ROLE_KEY){
      const rk = ROLE_KEY[slug];
      fillRole(svg, slug, rosterOf(rk), data.pStat[rk] || new Map());
    }
    // 발레걸즈(애싱턴·베들링턴·어른) — 풀에서 순차 배분
    let bi = 0;
    BALLET_SLUGS.forEach(slug=>{
      // 슬롯 수 만큼 풀에서 가져오기
      const slots = [];
      let i=0; while(svg.querySelector(`#fn-name-${slug}-${i}`)){ slots.push(i); i++; }
      const names = slots.map(()=> (data.balletPool[bi] ? data.balletPool[bi++].name : null));
      const map = new Map(data.balletPool.map(p=>[p.name,p]));
      fillRole(svg, slug, names.map(n=>n||undefined), map);
    });
    // 앙상블
    ENSEMBLE_SLUGS.forEach(slug=>{
      const slots=[]; let i=0; while(svg.querySelector(`#fn-name-${slug}-${i}`)){ slots.push(i); i++; }
      const names = slots.map((_,k)=> data.ensemblePool[k] ? data.ensemblePool[k].name : null);
      const map = new Map(data.ensemblePool.map(p=>[p.name,p]));
      fillRole(svg, slug, names.map(n=>n||undefined), map);
    });
    // Total / 기간·장소
    svg.querySelectorAll("text").forEach(t=>{
      const s = (t.textContent||"").trim();
      if(/^Total/.test(s)) t.textContent = `Total  ${data.totalWatched} / ${data.totalRun}`;
      else if(/\d{4}\.\s*\d/.test(s)){ // 로고 날짜·장소
        const sub = [periodStr(), (seatmapData && seatmapData.theater) || ""].filter(Boolean).join("  ");
        if(sub) t.textContent = sub;
      }
    });
  }

  // ---- 좌석 다이어그램 교체 ----
  const HEAT = ['#4aa3ff','#2fd0c8','#46c84e','#c2d92a','#ffd21f','#ff9a1f','#ff6322','#ef3b2f','#d81e4a','#b3126e'];
  function heatColor(c){ return HEAT[Math.max(1,Math.min(10,c))-1]; }
  function hx(c){ return [parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)]; }
  function mix(a,b,t){ const A=hx(a),B=hx(b); return '#'+[0,1,2].map(i=>Math.round(A[i]+(B[i]-A[i])*t).toString(16).padStart(2,'0')).join(''); }
  // 등급 기본색: VIP=기존 좌석색, R·S·A로 갈수록 회색
  const GRADE_RAMP = { VIP:0, R:0.5, S:0.68, A:0.82 };
  function gradeBase(grade){ const f = GRADE_RAMP[grade]!=null ? GRADE_RAMP[grade] : 0.9; return mix("#e0a13a", "#6f6c64", f); }

  function injectSeatmap(svg){
    const sm = seatmapData; if(!sm || !sm.seats) return;
    const grades = performanceData.grades || [];
    const gradeOf = id => { for(const g of grades){ if(g.seatIds && g.seatIds.includes(id)) return g.name; } return null; };

    // 기존 좌석 그리드 + STAGE/층/범례 텍스트 제거(+ 빨강 패널로 덮어 잔상 제거)
    const grid = svg.querySelector("#fn-seatgrid"); if(grid) grid.remove();
    svg.querySelectorAll("text").forEach(t=>{ const s=(t.textContent||"").trim();
      if(["STAGE","1F","2F","3F","1회","2회","3회","4회 이상"].includes(s)) t.remove(); });

    const cover = { x:396, y:664, w:278, h:284 };           // 좌석 패널 영역
    const chart = { x:408, y:678, w:254, h:218 };           // 좌석도 영역
    const legendY = 906;

    const floors = [...new Set(sm.seats.map(s=>s.floor))].sort((a,b)=>a-b);
    const GAP = 2; let cursor=0, minX=1e9, maxX=-1e9; const placed=[];
    floors.forEach(f=>{
      const fs = sm.seats.filter(s=>s.floor===f); if(!fs.length) return;
      const fm = (sm.floorMeta||{})[f] || {};
      let xs=fs.map(s=>s.svgX), ys=fs.map(s=>s.svgY);
      (fm.outline||[]).forEach(poly=>poly.forEach(p=>{ xs.push(p[0]); ys.push(p[1]); }));
      if(fm.stage){ const st=fm.stage; xs.push(st.cx-st.w/2, st.cx+st.w/2); ys.push(st.cy-st.h/2, st.cy+st.h/2); }
      const fMinX=Math.min(...xs), fMaxX=Math.max(...xs), fMinY=Math.min(...ys), fMaxY=Math.max(...ys);
      placed.push({fs,fm,fMinX,fMinY,top:cursor});
      cursor += (fMaxY-fMinY)+GAP; minX=Math.min(minX,fMinX); maxX=Math.max(maxX,fMaxX);
    });
    const worldW=(maxX-minX)||1, worldH=(cursor-GAP)||1;
    const scale=Math.min(chart.w/worldW, chart.h/worldH);
    const offX=chart.x+(chart.w-worldW*scale)/2, offY=chart.y+(chart.h-worldH*scale)/2;
    const X=x=>offX+(x-minX)*scale;

    let mk = `<rect x="${cover.x}" y="${cover.y}" width="${cover.w}" height="${cover.h}" rx="10" fill="#de6363"/>`;
    placed.forEach(b=>{
      const Y=y=>offY+(b.top+(y-b.fMinY))*scale;
      (b.fm.outline||[]).forEach(poly=>{
        mk += `<polyline points="${poly.map(p=>X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="rgba(255,255,255,0.6)" stroke-width="0.8"/>`;
      });
      const sz=Math.max(1.4, 0.82*scale);
      b.fs.forEach(s=>{
        const cnt=seatWatchCount(s.id);
        const color = cnt>0 ? heatColor(cnt) : gradeBase(gradeOf(s.id));
        mk += `<rect x="${(X(s.svgX)-sz/2).toFixed(1)}" y="${(Y(s.svgY)-sz/2).toFixed(1)}" width="${sz.toFixed(1)}" height="${sz.toFixed(1)}" rx="${(sz*0.22).toFixed(1)}" fill="${color}"/>`;
      });
      if(b.fm.stage){ const st=b.fm.stage;
        const sx=X(st.cx-st.w/2), sy=Y(st.cy-st.h/2), sw=st.w*scale, sh=Math.max(5, st.h*scale);
        mk += `<rect x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${sw.toFixed(1)}" height="${sh.toFixed(1)}" rx="1.5" fill="#2b2b2b"/>`;
        mk += `<text x="${X(st.cx).toFixed(1)}" y="${(sy+sh*0.72).toFixed(1)}" text-anchor="middle" font-size="${(sh*0.62).toFixed(1)}" fill="#fff" font-weight="700" letter-spacing="1.5">STAGE</text>`;
      }
    });
    // 하단 범례: 관극 횟수 1~10 (색은 시트맵과 동일, 숫자는 아래)
    const sw=14, gap=2, total=10*sw+9*gap, lx=(cover.x+cover.w/2)-total/2;
    mk += `<text x="${cover.x+cover.w/2}" y="${(legendY-7).toFixed(1)}" text-anchor="middle" font-size="9" font-weight="700" fill="#fff">관극 횟수</text>`;
    for(let i=0;i<10;i++){
      const x=lx+i*(sw+gap);
      mk += `<rect x="${x.toFixed(1)}" y="${legendY}" width="${sw}" height="9" rx="2" fill="${HEAT[i]}"/>`;
      mk += `<text x="${(x+sw/2).toFixed(1)}" y="${legendY+19}" text-anchor="middle" font-size="8" fill="#fff">${i+1}</text>`;
    }
    const g=document.createElementNS("http://www.w3.org/2000/svg","g");
    g.setAttribute("id","fn-seatmap-live"); g.innerHTML=mk;
    svg.appendChild(g);
  }

  // ---- 렌더 ----
  function getPreview(){ return document.getElementById("finalePreview"); }
  function currentSvg(){ const c=getPreview(); return c ? c.querySelector("svg") : null; }
  function dataReady(){ return typeof performanceData!=="undefined" && performanceData && performanceData.performances && typeof seatmapData!=="undefined" && seatmapData; }

  let boardText = null;
  async function loadBoard(){ if(boardText==null){ const r=await fetch(BOARD_URL); boardText = await r.text(); } return boardText; }

  async function renderFinale(){
    const container = getPreview();
    if(!container || !dataReady()) return;
    const [txt, cbd] = await Promise.all([loadBoard(), loadCbd(), loadMeta()]);
    container.innerHTML = txt;
    const svg = container.querySelector("svg");
    if(!svg) return;
    svg.removeAttribute("width"); svg.removeAttribute("height");
    svg.setAttribute("viewBox", `0 0 ${VB_W} ${VB_H}`);
    svg.dataset.w = VB_W; svg.dataset.h = VB_H;
    svg.style.width = "100%"; svg.style.height = "auto"; svg.style.transformOrigin = "0 0";
    fillBoard(svg, computeData(finaleMode, cbd));
    injectSeatmap(svg);
    resetZoom();
  }

  // ---- 핀치/터치 줌 ----
  let zScale=1, zx=0, zy=0;
  const pointers = new Map(); let pinchDist=0, panStart=null;
  function applyZoom(){ const svg=currentSvg(); if(svg) svg.style.transform = `translate(${zx}px,${zy}px) scale(${zScale})`; }
  function resetZoom(){ zScale=1; zx=0; zy=0; applyZoom(); }
  function clampZoom(){ zScale=Math.max(1, Math.min(6, zScale)); if(zScale===1){ zx=0; zy=0; } }
  function wireZoom(){
    const c=getPreview(); if(!c) return;
    c.style.touchAction="none"; c.style.overflow="hidden";
    c.addEventListener("wheel", e=>{
      e.preventDefault();
      const r=c.getBoundingClientRect(), ox=e.clientX-r.left, oy=e.clientY-r.top;
      const f=e.deltaY<0?1.12:0.89, ns=Math.max(1,Math.min(6,zScale*f));
      const k=ns/zScale; zx=ox-(ox-zx)*k; zy=oy-(oy-zy)*k; zScale=ns; clampZoom(); applyZoom();
    }, {passive:false});
    c.addEventListener("pointerdown", e=>{ c.setPointerCapture(e.pointerId); pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(pointers.size===1) panStart={x:e.clientX-zx,y:e.clientY-zy};
      else if(pointers.size===2){ const p=[...pointers.values()]; pinchDist=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y); }
    });
    c.addEventListener("pointermove", e=>{
      if(!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
      const pts=[...pointers.values()];
      if(pts.length===2){
        const d=Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y);
        if(pinchDist>0){ const r=c.getBoundingClientRect();
          const mx=(pts[0].x+pts[1].x)/2-r.left, my=(pts[0].y+pts[1].y)/2-r.top;
          const ns=Math.max(1,Math.min(6,zScale*(d/pinchDist))), k=ns/zScale;
          zx=mx-(mx-zx)*k; zy=my-(my-zy)*k; zScale=ns; }
        pinchDist=d; clampZoom(); applyZoom();
      } else if(pts.length===1 && panStart && zScale>1){
        zx=e.clientX-panStart.x; zy=e.clientY-panStart.y; applyZoom();
      }
    });
    const up=e=>{ pointers.delete(e.pointerId); if(pointers.size<2) pinchDist=0; if(pointers.size===0) panStart=null;
      else if(pointers.size===1){ const p=[...pointers.values()][0]; panStart={x:p.x-zx,y:p.y-zy}; } };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  }

  // ---- 내보내기 ----
  function stamp(){ return (typeof kstStamp==="function") ? kstStamp() : "export"; }
  function triggerDownload(blob, name){
    const url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download=name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function serializeSvg(el){
    const clone=el.cloneNode(true);
    clone.removeAttribute("style"); clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
    clone.setAttribute("width", VB_W); clone.setAttribute("height", VB_H);
    return new XMLSerializer().serializeToString(clone);
  }
  function exportSVG(){ const el=currentSvg(); if(!el) return;
    triggerDownload(new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n'+serializeSvg(el)],{type:"image/svg+xml;charset=utf-8"}), `makollim-finale-${stamp()}.svg`); }
  async function rasterize(type, quality){
    const el=currentSvg(); if(!el) return null;
    const scale=2, svgStr=serializeSvg(el);
    const url=URL.createObjectURL(new Blob([svgStr],{type:"image/svg+xml;charset=utf-8"}));
    try{
      const img=new Image();
      await new Promise((res,rej)=>{ img.onload=res; img.onerror=()=>rej(new Error("SVG 로드 실패")); img.src=url; });
      const canvas=document.createElement("canvas"); canvas.width=VB_W*scale; canvas.height=VB_H*scale;
      const ctx=canvas.getContext("2d");
      if(type==="image/jpeg"){ ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height); }
      ctx.setTransform(scale,0,0,scale,0,0); ctx.drawImage(img,0,0);
      return await new Promise(res=>canvas.toBlob(res,type,quality));
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportRaster(type, ext, quality){
    const blob=await rasterize(type,quality);
    if(blob) triggerDownload(blob, `makollim-finale-${stamp()}.${ext}`); else alert("이미지를 만들지 못했습니다.");
  }
  function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script"); s.src=src; s.onload=res; s.onerror=()=>rej(new Error("스크립트 로드 실패")); document.head.appendChild(s); }); }
  let krFontB64=null;
  async function loadKoreanFontB64(){ if(krFontB64) return krFontB64;
    const r=await fetch(KRFONT_URL); if(!r.ok) throw new Error("폰트 로드 실패");
    const buf=await r.arrayBuffer(); let bin=""; const b=new Uint8Array(buf);
    for(let i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]); krFontB64=btoa(bin); return krFontB64; }
  async function ensurePdfLibs(){
    if(!window.jspdf) await loadScript(JSPDF_URL);
    if(!window.svg2pdf && !(window.jspdf&&window.jspdf.jsPDF&&window.jspdf.jsPDF.API&&window.jspdf.jsPDF.API.svg)) await loadScript(SVG2PDF_URL);
  }
  async function exportPDF(btn){
    const el=currentSvg(); if(!el) return;
    const label=btn?btn.textContent:""; if(btn){ btn.disabled=true; btn.textContent="PDF 생성 중…"; }
    try{
      await ensurePdfLibs(); const { jsPDF }=window.jspdf;
      const doc=new jsPDF({ orientation: VB_W>VB_H?"l":"p", unit:"pt", format:[VB_W,VB_H] });
      let fontName=null;
      try{ const b64=await loadKoreanFontB64(); doc.addFileToVFS("NanumGothic.ttf",b64);
        doc.addFont("NanumGothic.ttf","NanumGothic","normal"); doc.addFont("NanumGothic.ttf","NanumGothic","bold");
        doc.setFont("NanumGothic"); fontName="NanumGothic"; }catch(fe){}
      const svgForPdf=el.cloneNode(true); svgForPdf.removeAttribute("style");
      if(fontName) svgForPdf.querySelectorAll("text,tspan").forEach(t=>t.setAttribute("font-family",fontName));
      if(typeof doc.svg==="function") await doc.svg(svgForPdf,{x:0,y:0,width:VB_W,height:VB_H});
      else await window.svg2pdf(svgForPdf,doc,{x:0,y:0,width:VB_W,height:VB_H});
      doc.save(`makollim-finale-${stamp()}.pdf`);
    }catch(err){
      try{ await ensurePdfLibs(); const { jsPDF }=window.jspdf;
        const blob=await rasterize("image/png");
        const dataUrl=await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(blob); });
        const doc=new jsPDF({ orientation: VB_W>VB_H?"l":"p", unit:"pt", format:[VB_W,VB_H] });
        doc.addImage(dataUrl,"PNG",0,0,VB_W,VB_H); doc.save(`makollim-finale-${stamp()}.pdf`);
        alert("벡터 변환에 실패하여 고해상도 이미지 PDF로 저장했습니다.");
      }catch(e2){ alert("PDF를 만들지 못했습니다: "+err.message); }
    }finally{ if(btn){ btn.disabled=false; btn.textContent=label; } }
  }

  // ---- 초기화 ----
  function init(){
    if(booted) return; booted=true;
    wireZoom();
    const sel=document.getElementById("finaleModeSelect");
    if(sel){ sel.value=finaleMode; sel.addEventListener("change", ()=>{ finaleMode=sel.value; renderFinale(); }); }
    const wire=(id,fn)=>{ const b=document.getElementById(id); if(b) b.addEventListener("click",()=>fn(b)); };
    wire("finaleSvgBtn", ()=>exportSVG());
    wire("finalePngBtn", ()=>exportRaster("image/png","png"));
    wire("finaleJpgBtn", ()=>exportRaster("image/jpeg","jpg",0.95));
    wire("finalePdfBtn", (b)=>exportPDF(b));
  }

  window.renderFinale = function(){ renderFinale(); };
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
