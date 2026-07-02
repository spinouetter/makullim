/* =========================================================
   finale.js — 트위터 공유용 '인증 이미지'(Finale) 탭
   - images/finale-board.svg(빌리 캐스트보드 템플릿)을 불러와 슬롯 id에
     현재 casts.json 캐스트를 채운다(슬롯>캐스트→NAME, 슬롯<캐스트→위에서부터).
   - 관극수는 통계 4모드(first/start/all/weighted)에 따라 재계산.
   - 좌석 영역은 실제 좌석 다이어그램(테두리+STAGE+히트맵)으로 교체.
   - 미리보기 핀치/터치 줌. PNG/JPG 저장(사진 임베드), PDF는 한글 벡터 텍스트.
   주의: app.js 전역(performanceData, seatmapData, isEnded, hasSeat,
        countHeatColor, kstStamp, getCastContributions) 참조(app.js 이후 로드).
   ========================================================= */
(function(){
  "use strict";

  const BOARD_URL = "images/finale-board.svg?v=22";
  const META_URL  = "images/finale-board.meta.json?v=3";
  const CBD_PATH  = "json/casting_by_date.json";
  // SVG에 임베드할 웹폰트(무료 OFL). 미리보기·PNG/JPG/PDF 내보내기 모두 자급자족.
  // IBM Plex Sans KR = 배우 이름·날짜/공연장(보드 원본 st20·st24 지정). 임베드 안 하면
  // 사용자 OS 기본 한글 글꼴로 대체돼 기기마다 달라지므로 반드시 포함.
  const FONTS = [
    { fam:"Anton",       url:"fonts/Anton-400.woff2" },       // 배역 라벨(Compacta 대체)
    { fam:"Handlee",     url:"fonts/Handlee-400.woff2" },     // 관극 수 분자(손글씨)
    { fam:"Paytone One", url:"fonts/PaytoneOne-400.woff2" },  // 관극 수 분모(둥근 산스)
    { fam:"IBM Plex Sans KR Medm", url:"fonts/IBMPlexSansKR-Medm.woff2" },    // 배우 이름·날짜/공연장
    { fam:"IBM Plex Sans KR",      url:"fonts/IBMPlexSansKR-Regular.woff2" }, // 보조(st9·st22)
  ];
  const JSPDF_URL   = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
  const SVG2PDF_URL = "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js";
  const ANTON_TTF_URL  = "fonts/Anton-400.ttf";           // PDF 배역 헤딩(로컬 TTF)
  const KRFONT_TTF_URL = "fonts/IBMPlexSansKR-Medm.ttf";  // PDF 한글 벡터(로컬 TTF, CDN 불필요)

  // viewBox를 흰 패널(st1)에 딱 맞게 크롭 → 바깥 투명 여백 제거(원본 760.394×1387.13에서 11.3386씩 잘라냄)
  const VB_X = 11.3386, VB_Y = 11.3386, VB_W = 737.717, VB_H = 1364.46;

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
    const balletTown = new Map();   // 발레걸즈 배우 → {애싱턴,베들링턴} 출연수(소속 섹션 판정용)
    const charPos = new Map();      // 발레걸즈 캐릭터(배역) → 캐스팅 보드 등장 순서
    const balletChar = new Map();   // 배우 → 맡은 캐릭터(정렬 기준)
    function gbump(map, name, won){
      let m = map.get(name); if(!m){ m={w:0,t:0}; map.set(name,m); }
      m.t++; if(won) m.w++;
    }
    // 발레걸즈 타운(애싱턴/베들링턴)별 공연 수·관극 수
    const town = { "애싱턴":{w:0,t:0}, "베들링턴":{w:0,t:0} };

    perfs.forEach(p=>{
      const ended = isEnded(p), seated = hasSeat(p), won = ended && seated;
      const tn = firstName((p.cast && p.cast["발레걸즈"]) || "");
      if(town[tn]){ town[tn].t++; if(won) town[tn].w++; }
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
            // 캐스팅 보드 등장 순서 = JSON 삽입 순서(최초 등장 시점 기록)
            if(!charPos.has(role)) charPos.set(role, charPos.size);
            const nm = firstName(val);
            if(nm){ gbump(ballet, nm, won);
              if(!balletChar.has(nm)) balletChar.set(nm, role);
              // 이 공연의 town(애싱턴/베들링턴)에 배우 출연수 누적 → 실제 소속 판정
              if(tn==="애싱턴"||tn==="베들링턴"){ let bt=balletTown.get(nm); if(!bt){ bt={"애싱턴":0,"베들링턴":0}; balletTown.set(nm,bt); } bt[tn]++; }
            }
          }
        }
      } else if(p.cast && p.cast["발레걸즈"]){
        const nm = firstName(p.cast["발레걸즈"]); if(nm) gbump(ballet, nm, won);
      }
    });

    const balletPool = [...ballet.entries()].map(([name,v])=>{
      const bt = balletTown.get(name) || {"애싱턴":0,"베들링턴":0};
      const a = bt["애싱턴"], b = bt["베들링턴"];
      // 양쪽 town 모두 상당수 출연 → 어른(ADULTS), 아니면 우세 town 섹션
      const group = Math.min(a,b) >= 10 ? "ADULTS" : (a >= b ? "ASHINGTON" : "BEDLINGTON");
      const ch = balletChar.get(name);
      const cp = charPos.has(ch) ? charPos.get(ch) : 999;
      return {name, ...v, group, cp};
    }).sort((a,b)=>a.cp - b.cp);
    const ensemblePool = [...ensemble.entries()].map(([name,v])=>({name,...v})).sort((a,b)=>b.t-a.t);
    const totalRun = perfs.length;
    const totalWatched = perfs.filter(p=>isEnded(p) && hasSeat(p)).length;
    return { pStat, balletPool, ensemblePool, totalRun, totalWatched,
             ballet: { ashington: town["애싱턴"], bedlington: town["베들링턴"] } };
  }

  // ---- 보드 채우기 ----
  function setText(svg, id, txt){ const el = svg.getElementById ? svg.getElementById(id) : document.getElementById(id); if(el) el.textContent = txt; return el; }

  const SVGNS = "http://www.w3.org/2000/svg";
  // 관극 수: 분자(관극)=Handlee(손글씨·금색, 획 stroke로 두껍게), 분모(/전체)=Paytone One(흰색). 같은 text/baseline·우측정렬.
  function numTspan(txt){
    const a = document.createElementNS(SVGNS, "tspan");
    a.setAttribute("font-family", "Handlee"); a.setAttribute("fill", "#ffd24a");
    a.setAttribute("stroke", "#ffd24a"); a.setAttribute("stroke-width", "0.42"); a.setAttribute("paint-order", "stroke");
    a.textContent = txt; return a;
  }
  function setCount(cntEl, w, t){
    if(!cntEl) return;
    // 오른쪽 정렬: 카운트 영역 박스(rect.st4)의 우변에 맞춤(사진 박스 우측과 정렬).
    const box = cntEl.parentNode && cntEl.parentNode.querySelector ? cntEl.parentNode.querySelector("rect.st4") : null;
    if(box){ cntEl.setAttribute("text-anchor", "end"); cntEl.setAttribute("x", (box.x.baseVal.value + box.width.baseVal.value).toFixed(2)); }
    while(cntEl.firstChild) cntEl.removeChild(cntEl.firstChild);
    const b = document.createElementNS(SVGNS, "tspan");
    b.setAttribute("font-family", "Paytone One"); b.textContent = " / " + fmt(t);
    cntEl.appendChild(numTspan(fmt(w))); cntEl.appendChild(b);
  }

  // 사진: images/<배우이름>.jpeg (없으면 플레이스홀더.jpeg). 슬롯을 가득 채우고(cover) 넘치는 부분은 크롭 — SVG preserveAspectRatio="xMidYMid slice".
  const XLINK = "http://www.w3.org/1999/xlink";
  const PHOTO_PLACEHOLDER = "images/" + encodeURIComponent("플레이스홀더") + ".jpeg";
  function photoUrl(name){ return "images/" + encodeURIComponent(name) + ".jpeg"; }
  function setPhoto(svg, id, name){
    const el = svg.querySelector("#" + id); if(!el) return;
    const url = name ? photoUrl(name) : PHOTO_PLACEHOLDER;
    el.addEventListener("error", function onerr(){    // 사진 없으면 플레이스홀더로
      el.removeEventListener("error", onerr);
      el.setAttributeNS(XLINK, "href", PHOTO_PLACEHOLDER); el.setAttribute("href", PHOTO_PLACEHOLDER);
    }, { once: true });
    el.setAttributeNS(XLINK, "href", url); el.setAttribute("href", url);
  }

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
        setCount(cntEl, m ? m.w : 0, m ? m.t : 0);
      } else {
        nameEl.textContent = "NAME";
        if(cntEl) cntEl.textContent = "";
      }
      setPhoto(svg, `fn-photo-${slug}-${i}`, nm);   // 슬롯 사진
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
    // 발레걸즈 — 배우별 실제 소속(town)으로 배정: 애싱턴/베들링턴/어른(양쪽 출연)
    const BALLET_GROUP = { BALLET_GIRLS_ASHINGTON:"ASHINGTON", BALLET_GIRLS_BEDLINGTON:"BEDLINGTON", BALLET_GIRLS_ADULTS:"ADULTS" };
    const balletMap = new Map(data.balletPool.map(p=>[p.name,p]));
    BALLET_SLUGS.forEach(slug=>{
      const g = BALLET_GROUP[slug];
      const members = data.balletPool.filter(p=>p.group===g);   // 이미 캐스팅 보드 순서(cp)
      const slots = [];
      let i=0; while(svg.querySelector(`#fn-name-${slug}-${i}`)){ slots.push(i); i++; }
      const names = slots.map((_,k)=> members[k] ? members[k].name : null);
      fillRole(svg, slug, names.map(n=>n||undefined), balletMap);
    });
    // 앙상블
    ENSEMBLE_SLUGS.forEach(slug=>{
      const slots=[]; let i=0; while(svg.querySelector(`#fn-name-${slug}-${i}`)){ slots.push(i); i++; }
      const names = slots.map((_,k)=> data.ensemblePool[k] ? data.ensemblePool[k].name : null);
      const map = new Map(data.ensemblePool.map(p=>[p.name,p]));
      fillRole(svg, slug, names.map(n=>n||undefined), map);
    });
    // 발레걸즈 그룹 합계(애싱턴/베들링턴): id 없는 st5 '/NN' 텍스트 2개(문서 순서=애싱턴,베들링턴)
    const grpTotals = [...svg.querySelectorAll("text.st5:not([id])")].filter(t => /^\/\d+$/.test((t.textContent||"").trim()));
    const townStats = [data.ballet && data.ballet.ashington, data.ballet && data.ballet.bedlington];
    grpTotals.slice(0,2).forEach((el, i) => { const g = townStats[i]; if(g) setCount(el, g.w, g.t); });

    // Total / 기간·장소
    svg.querySelectorAll("text").forEach(t=>{
      const s = (t.textContent||"").trim();
      if(/^Total/.test(s)){
        while(t.firstChild) t.removeChild(t.firstChild);
        // 우측 정렬(윗 블록과 동일) + 조금 아래로(TOTAL_DY, viewBox 단위)
        const TOTAL_DY = 10;
        const box = t.parentNode && t.parentNode.querySelector ? t.parentNode.querySelector("rect.st4") : null;
        if(box){ t.setAttribute("text-anchor", "end"); t.setAttribute("x", (box.x.baseVal.value + box.width.baseVal.value).toFixed(2)); }
        const y0 = parseFloat(t.getAttribute("y")) || 0; t.setAttribute("y", (y0 + TOTAL_DY).toFixed(2));
        const lab = document.createElementNS(SVGNS, "tspan");   // 'TOTAL'만 Anton
        lab.setAttribute("font-family", "Anton"); lab.textContent = "TOTAL ";
        const b = document.createElementNS(SVGNS, "tspan");     // 숫자는 위 카드와 동일(Handlee/Paytone)
        b.setAttribute("font-family", "Paytone One"); b.textContent = " / " + data.totalRun;
        t.appendChild(lab); t.appendChild(numTspan(" " + data.totalWatched)); t.appendChild(b);
      } else if(/\d{4}\.\s*\d/.test(s)){ // 로고 날짜·장소
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
  // 미관극 좌석 등급색: 백→흑 그라데이션 위치(낮을수록 흰색). VIP 0% · R 10% · S 20% · A 30%
  const GRADE_RAMP = { VIP:0, R:0.1, S:0.2, A:0.3 };
  function gradeBase(grade){ const f = GRADE_RAMP[grade]!=null ? GRADE_RAMP[grade] : 0.35; return mix("#ffffff", "#000000", f); }

  function injectSeatmap(svg){
    const sm = seatmapData; if(!sm || !sm.seats) return;
    const grades = performanceData.grades || [];
    const gradeOf = id => { for(const g of grades){ if(g.seatIds && g.seatIds.includes(id)) return g.name; } return null; };

    // 기존 좌석 그리드 + 원본 좌석 패널(반투명 흰 오버레이 st6) + STAGE/층/범례 텍스트 제거
    const grid = svg.querySelector("#fn-seatgrid"); if(grid) grid.remove();
    // 원본 템플릿 좌석 배경 패널(rect.st6)이 새로 그리는 패널보다 살짝 커서 테두리가 겹쳐 보임 → 제거
    const oldPanel = svg.querySelector("rect.st6"); if(oldPanel){ (oldPanel.closest("g") || oldPanel).remove(); }
    svg.querySelectorAll("text").forEach(t=>{ const s=(t.textContent||"").trim();
      if(["STAGE","1F","2F","3F","1회","2회","3회","4회 이상"].includes(s)) t.remove(); });

    const cover = { x:396, y:664, w:278, h:284 };           // 좌석 패널 영역
    const floors = [...new Set(sm.seats.map(s=>s.floor))].sort((a,b)=>a-b);
    // 층 사이 간격: 2층↔3층만 -3, 나머지 -2 (음수=겹침)
    const gapBefore = f => (f===3 ? -2.5 : -2);
    let cursor=0, minX=1e9, maxX=-1e9; const placed=[];
    floors.forEach((f,idx)=>{
      const fs = sm.seats.filter(s=>s.floor===f); if(!fs.length) return;
      const fm = (sm.floorMeta||{})[f] || {};
      let xs=fs.map(s=>s.svgX), ys=fs.map(s=>s.svgY);
      (fm.outline||[]).forEach(poly=>poly.forEach(p=>{ xs.push(p[0]); ys.push(p[1]); }));
      if(fm.stage){ const st=fm.stage; xs.push(st.cx-st.w/2, st.cx+st.w/2); ys.push(st.cy-st.h/2, st.cy+st.h/2); }
      const fMinX=Math.min(...xs), fMaxX=Math.max(...xs), fMinY=Math.min(...ys), fMaxY=Math.max(...ys);
      if(idx>0) cursor += gapBefore(f);
      placed.push({fs,fm,fMinX,fMinY,top:cursor});
      cursor += (fMaxY-fMinY); minX=Math.min(minX,fMinX); maxX=Math.max(maxX,fMaxX);
    });
    const worldW=(maxX-minX)||1, worldH=cursor||1;
    // 좌석도: 크롭(cover) 영역에 세로 가운데 배치 + 확대(여백 축소, 하단만 범례 영역 확보)
    const PADX=10, PADT=10, LEGEND_ZONE=26;
    const areaW=cover.w-2*PADX, areaTop=cover.y+PADT, areaH=cover.h-PADT-LEGEND_ZONE;
    const scale=Math.min(areaW/worldW, areaH/worldH);
    const offX=cover.x+(cover.w-worldW*scale)/2, offY=areaTop+(areaH-worldH*scale)/2;
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
        mk += `<rect x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${sw.toFixed(1)}" height="${sh.toFixed(1)}" rx="1.5" fill="#f2e8d5"/>`;
        mk += `<text x="${X(st.cx).toFixed(1)}" y="${(sy+sh*0.72).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="${(sh*0.62).toFixed(1)}" fill="#9c1a1a" font-weight="700" letter-spacing="1.5">STAGE</text>`;
      }
    });
    // 하단 범례: 관극 횟수 1~10 — 정사각형 배지 안에 숫자('관극 횟수' 라벨 없음)
    const sw=7.15, gap=3, total=10*sw+9*gap, lx=(cover.x+cover.w/2)-total/2, ly=cover.y+cover.h-20;
    for(let i=0;i<10;i++){
      const x=lx+i*(sw+gap);
      mk += `<rect x="${x.toFixed(1)}" y="${ly}" width="${sw}" height="${sw}" rx="1.3" fill="${HEAT[i]}"/>`;
      mk += `<text x="${(x+sw/2).toFixed(1)}" y="${(ly+sw/2+1.8).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="5" font-weight="700" fill="#fff">${i+1}</text>`;
    }
    const g=document.createElementNS("http://www.w3.org/2000/svg","g");
    g.setAttribute("id","fn-seatmap-live"); g.innerHTML=mk;
    svg.appendChild(g);
  }

  // 두 줄(tspan 줄바꿈)로 감긴 배역 라벨을 한 줄로 합치고, 언더라인 폭에 맞을 때까지 폰트를 1%씩 축소.
  // 한 줄에 들어가면 그 배역은 그 크기에서 정지(배역마다 개별 크기).
  function fitRoleLabels(svg){
    const labels = [...svg.querySelectorAll("text.st21, text.st23")].filter(t => t.querySelector("tspan[dy]"));
    const ctx = document.createElement("canvas").getContext("2d");
    const BASE_PX = 24;   // st21/st23 = 1.99999em × 12px(기준 em) ≈ 24 user unit
    const report = [];
    labels.forEach(t=>{
      let full = (t.textContent || "").replace(/\s+/g, " ").trim();
      full = full.replace(/^MR\.\s+/, "");  // 'MR. BRAITHWAITE' → 'BRAITHWAITE' (MRS.는 유지)
      if(!full) return;
      t.textContent = full;                 // 여러 tspan 줄 → 한 줄
      t.setAttribute("x", "0");              // 다른 배역과 동일하게 좌측 정렬
      t.setAttribute("y", "1376.62");        // 한 줄 배역 라벨 기준 baseline
      t.removeAttribute("text-anchor"); t.style.textAnchor = "start";
      // 사용 가능한 폭 = 언더라인(st18) 폭(없으면 텍스트 박스 st4)
      const shape = t.closest("g"), grp = shape && shape.parentElement;
      let availW = 0;
      // 언더라인 = 얇은(height<6) st18 rect
      const uls = grp ? [...grp.querySelectorAll("rect.st18")].filter(r => r.height.baseVal.value < 6) : [];
      if(uls.length) availW = Math.max(...uls.map(r => r.width.baseVal.value));
      if(!availW){ const box = shape && shape.querySelector("rect.st4"); if(box) availW = box.width.baseVal.value; }
      if(!availW) return;
      // canvas measureText로 폭 측정(숨김 탭에서도 동작). 1%씩 축소해 언더라인 폭에 맞으면 정지.
      const measure = s => { ctx.font = (BASE_PX*s) + "px 'Anton', sans-serif"; return ctx.measureText(full).width; };
      let scale = 1.0, guard = 0;
      while(measure(scale) > availW && scale > 0.4 && guard++ < 100){ scale -= 0.01; }  // 라벨 너비 = 언더라인 너비
      if(full === "BRAITHWAITE"){
        // 100% 유지: 언더라인 우변에 오른쪽 정렬하고 왼쪽 글자는 셀 밖(비어 있는 SMALL BOY 위 공간)으로 넘김.
        // 밑줄·사진 위치는 그대로.
        scale = 1.0;
        t.setAttribute("x", availW.toFixed(2));
        t.removeAttribute("text-anchor"); t.style.textAnchor = "end";
      } else if(scale < 0.999){
        t.style.fontSize = (2*scale).toFixed(3) + "em";
      }
      report.push(full + " → " + Math.round(scale*100) + "%");
    });
    if(report.length) console.log("[finale] 배역 라벨 한 줄 맞춤:", report.join(" | "));
  }

  // ---- 렌더 ----
  function getViewport(){ return document.getElementById("finaleZoomViewport"); }
  function boardSvg(){ return document.getElementById("finaleBoardSvg"); }
  function currentSvg(){ return boardSvg(); }
  function dataReady(){ return typeof performanceData!=="undefined" && performanceData && performanceData.performances && typeof seatmapData!=="undefined" && seatmapData; }

  let boardText = null;
  async function loadBoard(){ if(boardText==null){ const r=await fetch(BOARD_URL); boardText = await r.text(); } return boardText; }
  let fontCss = null;   // @font-face(base64) 모음 — SVG에 임베드
  async function loadFontCss(){
    if(fontCss==null){
      const parts = await Promise.all(FONTS.map(async f=>{
        try{ const r=await fetch(f.url); const b=new Uint8Array(await r.arrayBuffer()); let s=""; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
          return `@font-face{font-family:'${f.fam}';src:url(data:font/woff2;base64,${btoa(s)}) format('woff2');}`; }
        catch(e){ return ""; }
      }));
      fontCss = parts.join("");
    }
    return fontCss;
  }

  async function renderFinale(){
    const vp = getViewport();
    if(!vp || !dataReady()) return;
    const [txt, cbd, , css] = await Promise.all([loadBoard(), loadCbd(), loadMeta(), loadFontCss()]);
    vp.innerHTML = txt;
    const svg = vp.querySelector("svg");
    if(!svg) return;
    svg.id = "finaleBoardSvg";
    // 웹폰트 임베드 + 배역 라벨(st21·st23)을 Anton으로 교체(미리보기·내보내기 자급자족)
    if(css){
      const fst = document.createElementNS("http://www.w3.org/2000/svg","style");
      fst.textContent = css + `text.st21,text.st23{font-family:'Anton';}`;
      svg.insertBefore(fst, svg.firstChild);
    }
    svg.removeAttribute("width"); svg.removeAttribute("height");
    svg.setAttribute("viewBox", `${VB_X} ${VB_Y} ${VB_W} ${VB_H}`);
    svg.dataset.w = VB_W; svg.dataset.h = VB_H;
    fillBoard(svg, computeData(finaleMode, cbd));
    injectSeatmap(svg);
    if(css){ try{ if(document.fonts && document.fonts.load) await document.fonts.load('20px "Anton"'); }catch(e){} fitRoleLabels(svg); }
    buildThumbs(svg);
    if(document.getElementById("finaleOverlay").style.display !== "none") fitBoard();
  }

  // ---- 디자인 썸네일(현재 캐스트보드 1종 + placeholder 여러 개) ----
  let DESIGNS = null, designOrder = null, lastLayoutW = -1;
  function ensureDesigns(){
    if(DESIGNS) return;
    DESIGNS = [{ real:true, ar: VB_W/VB_H }];   // 실제 보드는 원래 비율(세로형)
    for(let i=0;i<5;i++){
      // placeholder 가로세로 비율 랜덤 — 0.75~1.35(줄 높이 통일 시 면적 차 최소화)
      const ar = 0.75 + Math.random() * (1.35 - 0.75);
      // 색은 다양하게(색상 전체 범위, 다크 UI에 맞게 채도·명도는 낮게)
      const color = `hsl(${Math.floor(Math.random()*360)} ${24+Math.floor(Math.random()*20)}% ${22+Math.floor(Math.random()*12)}%)`;
      DESIGNS.push({ real:false, ar, color });
    }
    designOrder = DESIGNS.map((_,i)=>i);
    for(let i=designOrder.length-1;i>0;i--){         // Fisher–Yates: refresh마다 랜덤 순서
      const j = Math.floor(Math.random()*(i+1));
      [designOrder[i],designOrder[j]] = [designOrder[j],designOrder[i]];
    }
  }
  function buildThumbs(svg){
    ensureDesigns();
    const wrap = document.getElementById("finaleThumbs");
    if(!wrap) return;
    wrap.innerHTML = "";
    designOrder.forEach(idx=>{
      const d = DESIGNS[idx];
      const card = document.createElement("div");
      card.className = "finale-thumb " + (d.real ? "real" : "placeholder");
      card.dataset.ar = d.ar;                        // 저스티파이드 레이아웃용 비율
      if(d.real){
        const clone = svg.cloneNode(true);
        clone.removeAttribute("id"); clone.removeAttribute("style");
        card.appendChild(clone);
        const badge = document.createElement("div");
        badge.className = "finale-thumb-badge"; badge.textContent = "크게 보기";
        card.appendChild(badge);
        card.addEventListener("click", openFinaleOverlay);
      } else {
        card.style.backgroundColor = d.color;
        card.innerHTML = '<div class="ph-inner"><span class="ph-icon">🎭</span><span class="ph-label">디자인 준비 중</span></div>';
        // placeholder는 클릭 반응 없음(핸들러 미등록)
      }
      wrap.appendChild(card);
    });
    lastLayoutW = -1;
    layoutThumbs();
  }
  // 같은 높이 저스티파이드 갤러리(Flickr식): 각 줄의 사진들은 높이를 통일하고
  // 폭을 컨테이너에 꽉 차게 맞춘다(비율 유지, 줄 안·사이 여백 없음). 모바일은 한 줄 2장까지.
  function layoutThumbs(){
    const wrap = document.getElementById("finaleThumbs");
    if(!wrap) return;
    const W = wrap.clientWidth;
    if(W <= 0) return;                 // 탭이 숨겨져 폭 0이면 보일 때 ResizeObserver가 재호출
    lastLayoutW = W;
    const GAP = 8;
    const isMobile = W < 560;
    const targetH = isMobile ? 200 : 240;      // 기준 줄 높이
    const maxPerRow = isMobile ? 2 : Infinity;  // 모바일은 한 줄 최대 2장
    const cards = [...wrap.children];
    let y = 0, row = [], rowAr = 0;
    const flush = (last)=>{
      if(!row.length) return;
      let h = (W - GAP*(row.length-1)) / rowAr;      // 폭을 꽉 채우는 줄 높이
      if(last) h = Math.min(h, targetH);             // 마지막 줄은 과도하게 확대하지 않음
      let x = 0;
      row.forEach(c=>{
        const w = (+c.dataset.ar) * h;
        c.style.position = "absolute";
        c.style.left = x + "px"; c.style.top = y + "px";
        c.style.width = w + "px"; c.style.height = h + "px";
        x += w + GAP;
      });
      y += h + GAP; row = []; rowAr = 0;
    };
    cards.forEach(c=>{
      row.push(c); rowAr += (+c.dataset.ar);
      const h = (W - GAP*(row.length-1)) / rowAr;
      if(h <= targetH || row.length >= maxPerRow) flush(false);   // 폭이 다 차거나 최대 장수 도달 → 줄 확정
    });
    flush(true);
    wrap.style.height = Math.max(0, y - GAP) + "px";
  }

  // ---- 크게 보기 오버레이 + 핀치/휠 줌(상하좌우 10% 마진까지만 이동) ----
  let zScale=1, zx=0, zy=0, baseW=0, baseH=0;
  const pointers = new Map(); let pinchDist=0, panStart=null;
  const MARGIN = 0;   // 여백 오버스크롤 없음: 최소(맞춤) 배율에선 고정, 확대 시 가장자리까지만
  function applyZoom(){ const svg=boardSvg(); if(svg) svg.style.transform = `translate(${zx}px,${zy}px) scale(${zScale})`; }
  function clampScale(){ zScale=Math.max(1, Math.min(6, zScale)); }
  function clampPan(){
    const vp=getViewport(); if(!vp) return;
    const W=vp.clientWidth, H=vp.clientHeight, iw=baseW*zScale, ih=baseH*zScale;
    const mx=MARGIN*W, my=MARGIN*H;
    let maxX=mx, minX=W-mx-iw; if(minX>maxX){ const c=(W-iw)/2; minX=maxX=c; }
    let maxY=my, minY=H-my-ih; if(minY>maxY){ const c=(H-ih)/2; minY=maxY=c; }
    zx=Math.min(maxX, Math.max(minX, zx));
    zy=Math.min(maxY, Math.max(minY, zy));
  }
  // 보드를 뷰포트에 꽉 맞게(contain) 놓고 가운데 정렬 + 줌 초기화
  function fitBoard(){
    const vp=getViewport(), svg=boardSvg(); if(!vp||!svg) return;
    const W=vp.clientWidth, H=vp.clientHeight, ratio=VB_H/VB_W;   // 세로형
    if(W*ratio <= H){ baseW=W; baseH=W*ratio; } else { baseH=H; baseW=H/ratio; }
    svg.style.width=baseW+"px"; svg.style.height=baseH+"px"; svg.style.transformOrigin="0 0";
    zScale=1; zx=(W-baseW)/2; zy=(H-baseH)/2; clampPan(); applyZoom();
  }
  function openFinaleOverlay(){
    const ov=document.getElementById("finaleOverlay"); if(!ov) return;
    ov.style.display="flex";
    requestAnimationFrame(fitBoard);   // 표시 후 뷰포트 크기 확정된 뒤 맞춤
  }
  function closeFinaleOverlay(){ const ov=document.getElementById("finaleOverlay"); if(ov) ov.style.display="none"; }
  function wireZoom(){
    const c=getViewport(); if(!c) return;
    c.style.touchAction="none"; c.style.overflow="hidden";
    c.addEventListener("wheel", e=>{
      e.preventDefault();
      const r=c.getBoundingClientRect(), ox=e.clientX-r.left, oy=e.clientY-r.top;
      const f=e.deltaY<0?1.12:0.89, ns=Math.max(1,Math.min(6,zScale*f));
      const k=ns/zScale; zx=ox-(ox-zx)*k; zy=oy-(oy-zy)*k; zScale=ns; clampScale(); clampPan(); applyZoom();
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
        pinchDist=d; clampScale(); clampPan(); applyZoom();
      } else if(pts.length===1 && panStart){
        zx=e.clientX-panStart.x; zy=e.clientY-panStart.y; clampPan(); applyZoom();
      }
    });
    const up=e=>{ pointers.delete(e.pointerId); if(pointers.size<2) pinchDist=0; if(pointers.size===0) panStart=null;
      else if(pointers.size===1){ const p=[...pointers.values()][0]; panStart={x:p.x-zx,y:p.y-zy}; } };
    c.addEventListener("pointerup", up); c.addEventListener("pointercancel", up);
  }

  // ---- 내보내기 ----
  function stamp(){ return (typeof kstStamp==="function") ? kstStamp() : "export"; }
  // 외부 <image href="images/..."> 사진을 base64 data URI로 임베드.
  // 미리보기 SVG를 그대로 직렬화하면 상대경로 이미지가 캔버스/PDF에서 로드되지 않아
  // 배경(보드)만 남으므로, 내보내기 전에 사진을 인라인해 자급자족 SVG로 만든다.
  const photoDataCache = new Map();
  async function toDataUrl(url){
    if(photoDataCache.has(url)) return photoDataCache.get(url);
    let durl = null;
    try{
      const r = await fetch(url);
      if(r.ok){
        const buf = await r.arrayBuffer(), b = new Uint8Array(buf);
        let bin = ""; for(let i=0;i<b.length;i++) bin += String.fromCharCode(b[i]);
        const mime = r.headers.get("content-type") || "image/jpeg";
        durl = `data:${mime};base64,` + btoa(bin);
      }
    }catch(e){}
    photoDataCache.set(url, durl); return durl;
  }
  // 사진을 슬롯 비율로 미리 잘라 data URI로 반환(cover, preserveAspectRatio 정렬 반영).
  // svg2pdf가 preserveAspectRatio="slice"를 무시하고 늘려 그리므로, PDF에서는 이렇게
  // 이미 잘린 이미지를 넣어 찌그러짐을 없앤다(브라우저 미리보기는 slice로 자동 크롭).
  function croppedPhotoDataUrl(el, href){
    return new Promise(res=>{
      const boxW=parseFloat(el.getAttribute("width"))||1, boxH=parseFloat(el.getAttribute("height"))||1;
      const boxAspect=boxW/boxH;
      const par=el.getAttribute("preserveAspectRatio")||"xMidYMin";
      const xMid=/xMid/i.test(par), yMid=/YMid/i.test(par);   // 정렬: 기본 xMid/ YMin(상단)
      const img=new Image();
      img.onload=()=>{
        try{
          const iw=img.naturalWidth, ih=img.naturalHeight, srcAspect=iw/ih;
          let sx,sy,sw,sh;
          if(srcAspect>boxAspect){ sh=ih; sw=ih*boxAspect; sy=0; sx=xMid?(iw-sw)/2:0; }   // 좌우 크롭
          else { sw=iw; sh=iw/boxAspect; sx=0; sy=yMid?(ih-sh)/2:0; }                        // 상/하 크롭(YMin=상단)
          const H=Math.max(1, Math.min(600, Math.round(sh))), W=Math.max(1, Math.round(H*boxAspect));
          const cv=document.createElement("canvas"); cv.width=W; cv.height=H;
          cv.getContext("2d").drawImage(img, sx,sy,sw,sh, 0,0,W,H);
          res(cv.toDataURL("image/jpeg",0.92));
        }catch(e){ res(null); }
      };
      img.onerror=()=>res(null);
      img.src=href;
    });
  }
  async function inlinePhotos(root, crop){
    const imgs = [...root.querySelectorAll("image")];
    await Promise.all(imgs.map(async el=>{
      const href = el.getAttribute("href") || el.getAttributeNS(XLINK, "href");
      if(!href || href.indexOf("data:") === 0) return;   // placeholder(svg) 등 이미 인라인
      if(crop){
        const cropped = await croppedPhotoDataUrl(el, href);
        if(cropped){
          el.setAttribute("href", cropped); el.setAttributeNS(XLINK, "href", cropped);
          el.setAttribute("preserveAspectRatio", "none");   // 이미 슬롯 비율 → 채워도 안 찌그러짐
          return;
        }
      }
      const durl = await toDataUrl(href);
      if(durl){ el.setAttribute("href", durl); el.setAttributeNS(XLINK, "href", durl); }
    }));
  }
  function triggerDownload(blob, name){
    const url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download=name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function rasterize(type, quality){
    const el=currentSvg(); if(!el) return null;
    const scale=2;
    const clone=el.cloneNode(true);
    clone.removeAttribute("style"); clone.setAttribute("xmlns","http://www.w3.org/2000/svg");
    clone.setAttribute("width", VB_W); clone.setAttribute("height", VB_H);
    await inlinePhotos(clone);   // 사진을 data URI로 임베드해야 캔버스에 그려짐
    const svgStr=new XMLSerializer().serializeToString(clone);
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
  const fontB64Cache=new Map();
  async function fontB64(url){
    if(fontB64Cache.has(url)) return fontB64Cache.get(url);
    const r=await fetch(url); if(!r.ok) throw new Error("폰트 로드 실패: "+url);
    const buf=await r.arrayBuffer(), b=new Uint8Array(buf);
    let bin=""; for(let i=0;i<b.length;i++) bin+=String.fromCharCode(b[i]);
    const s=btoa(bin); fontB64Cache.set(url,s); return s; }
  async function ensurePdfLibs(){
    if(!window.jspdf) await loadScript(JSPDF_URL);
    if(!window.svg2pdf && !(window.jspdf&&window.jspdf.jsPDF&&window.jspdf.jsPDF.API&&window.jspdf.jsPDF.API.svg)) await loadScript(SVG2PDF_URL);
  }
  // 클론을 화면 밖에 잠깐 붙여, CSS 클래스(st0…)로 지정된 색·획을 계산된 값으로
  // 각 요소의 presentation 속성에 '굽는다'. svg2pdf는 외부 <style> 규칙을 적용하지
  // 못하므로, 이렇게 해야 보드 색·글자색이 PDF에 그대로 남는다.
  // 폰트: 배역 헤딩(계산 폰트가 Anton)은 좁은 Anton 그대로(레이아웃 유지), 나머지
  // (한글 배우명·숫자)는 미리보기와 동일한 IBM Plex Sans KR. @font-face는 굽기 후 제거.
  const PDF_KR_FAM = "IBM Plex Sans KR Medm";
  const BAKE_PROPS=["fill","fill-opacity","fill-rule","stroke","stroke-width","stroke-opacity",
    "stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-dasharray","opacity",
    "font-size","font-weight","font-style","text-anchor"];
  function bakeStyles(root){
    root.querySelectorAll("*").forEach(el=>{
      const tag=el.tagName.toLowerCase();
      if(tag==="style"||tag==="clippath"||tag==="defs") return;
      const cs=getComputedStyle(el);
      BAKE_PROPS.forEach(p=>{ const v=cs.getPropertyValue(p); if(v) el.setAttribute(p, v); });
      if(tag==="text"||tag==="tspan"){
        const anton=/Anton/i.test(cs.fontFamily||"");
        el.setAttribute("font-family", anton ? "Anton" : PDF_KR_FAM);
        el.removeAttribute("style");
      }
    });
  }
  // 한글을 '벡터 텍스트'로 넣는 PDF.
  async function exportPDF(btn){
    const el=currentSvg(); if(!el) return;
    const label=btn?btn.textContent:""; if(btn){ btn.disabled=true; btn.textContent="PDF 생성 중…"; }
    try{
      await ensurePdfLibs(); const { jsPDF }=window.jspdf;
      const doc=new jsPDF({ orientation: VB_W>VB_H?"l":"p", unit:"pt", format:[VB_W,VB_H] });
      let fontName=null;
      try{ const b64=await fontB64(KRFONT_TTF_URL); doc.addFileToVFS("IBMPlexKR.ttf",b64);
        doc.addFont("IBMPlexKR.ttf",PDF_KR_FAM,"normal"); doc.addFont("IBMPlexKR.ttf",PDF_KR_FAM,"bold");
        doc.setFont(PDF_KR_FAM); fontName=PDF_KR_FAM; }catch(fe){}
      if(!fontName) throw new Error("한글 폰트 로드 실패");   // 깨진 벡터 대신 래스터 폴백
      try{ const ab=await fontB64(ANTON_TTF_URL); doc.addFileToVFS("Anton.ttf",ab);
        doc.addFont("Anton.ttf","Anton","normal"); doc.addFont("Anton.ttf","Anton","bold"); }catch(fe){}
      const svgForPdf=el.cloneNode(true);
      svgForPdf.removeAttribute("style");
      svgForPdf.style.position="absolute"; svgForPdf.style.left="-99999px"; svgForPdf.style.top="0";
      svgForPdf.style.width=VB_W+"px"; svgForPdf.style.height=VB_H+"px";
      document.body.appendChild(svgForPdf);
      try{ if(document.fonts&&document.fonts.ready) await document.fonts.ready; }catch(e){}
      bakeStyles(svgForPdf);            // CSS 클래스 색·획을 속성으로 굽기 + 폰트 지정
      document.body.removeChild(svgForPdf);
      svgForPdf.querySelectorAll("style").forEach(s=>s.remove());   // @font-face 제거
      await inlinePhotos(svgForPdf, true);                           // 사진 임베드+슬롯 비율 크롭
      if(typeof doc.svg==="function") await doc.svg(svgForPdf,{x:0,y:0,width:VB_W,height:VB_H});
      else await window.svg2pdf(svgForPdf,doc,{x:0,y:0,width:VB_W,height:VB_H});
      doc.save(`makollim-finale-${stamp()}.pdf`);
    }catch(err){
      try{ // 벡터 변환 실패 시에만 고해상도 이미지 PDF로 폴백
        const { jsPDF }=window.jspdf;
        const blob=await rasterize("image/png");
        const dataUrl=await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(blob); });
        const doc=new jsPDF({ orientation: VB_W>VB_H?"l":"p", unit:"pt", format:[VB_W,VB_H] });
        doc.addImage(dataUrl,"PNG",0,0,VB_W,VB_H); doc.save(`makollim-finale-${stamp()}.pdf`);
        alert("한글 벡터 변환에 실패하여 고해상도 이미지 PDF로 저장했습니다.");
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
    wire("finaleOverlayClose", ()=>closeFinaleOverlay());
    wire("finalePngBtn", ()=>exportRaster("image/png","png"));
    wire("finaleJpgBtn", ()=>exportRaster("image/jpeg","jpg",0.95));
    wire("finalePdfBtn", (b)=>exportPDF(b));
    // 오버레이 열려 있을 때 창 크기 바뀌면 다시 맞춤
    window.addEventListener("resize", ()=>{ const ov=document.getElementById("finaleOverlay"); if(ov && ov.style.display!=="none") fitBoard(); });
    // 썸네일 저스티파이드 레이아웃: 폭이 바뀔 때(탭 표시·리사이즈)만 다시 계산
    const wrap=document.getElementById("finaleThumbs");
    if(wrap && window.ResizeObserver){
      new ResizeObserver(entries=>{ const w=entries[0].contentRect.width; if(Math.abs(w-lastLayoutW)>=1) layoutThumbs(); }).observe(wrap);
    }
    // 배경(뷰포트 밖) 클릭 시 닫기
    const ov=document.getElementById("finaleOverlay");
    if(ov) ov.addEventListener("click", e=>{ if(e.target===ov) closeFinaleOverlay(); });
  }

  window.renderFinale = function(){ renderFinale(); };
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
