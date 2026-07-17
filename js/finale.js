/* =========================================================
   finale.js — 트위터 공유용 '인증 이미지'(Finale) 탭
   - 보드 배경 SVG(예: shows/<id>/images/finale-board.svg)를 불러와 슬롯 id에
     현재 casts.json 캐스트를 채운다(슬롯>캐스트→NAME, 슬롯<캐스트→위에서부터).
   - 관극수는 통계 4모드(first/start/all/weighted)에 따라 재계산.
   - 좌석 영역은 실제 좌석 다이어그램(테두리+STAGE+히트맵)으로 교체.
   - 미리보기 핀치/터치 줌. PNG/JPG 저장(사진 임베드), PDF는 한글 벡터 텍스트.
   주의: app.js 전역(performanceData, seatmapData, isEnded, hasSeat,
        countHeatColor, kstStamp, getCastContributions) 참조(app.js 이후 로드).
   ========================================================= */
(function(){
  "use strict";

  // 관극 기록판 정의는 스크립트 밖(JSON)으로 분리:
  //   shows/<id>/finale-boards.json          = 레지스트리(보드 목록 + 기본 보드)
  //   shows/<id>/finale-boards/<board>.json  = 보드 1종 정의(배경·폰트·스타일·슬롯·바인딩)
  // 코드는 '값 계산(provider)'만 갖고, "무슨 값을 배경 어디에" 매핑은 전부 JSON이 규정한다.
  // 공연 파일 안의 경로는 공연 폴더 기준 상대경로 → window.showUrl(app.js)로 해석("/" 시작은 사이트 루트).
  //   주의: showUrl은 loadData()가 SHOW_BASE를 채운 뒤에만 유효 — 아래 fetch들은 전부 데이터 로드 후 실행됨.
  const BOARDS_URL = "finale-boards.json";
  // finale 자원 콘텐츠 버전 — SVG 보드·정의(JSON)·배우 사진을 실제로 바꿀 때만 올린다.
  //   (커밋 SHA로 매 배포 버스트하지 않고, 내용이 그대로면 브라우저 캐시를 재사용한다.)
  const FIN_VER = 1;
  //   경로에 이미 ?v= 등 자체 버전 쿼리가 있으면(예: background.src="finale-board.svg?v=28") 그걸 존중하고, 없을 때만 FIN_VER를 붙인다.
  function verUrl(p){ const u = window.showUrl(p); return u.indexOf("?")>=0 ? u : (u + "?v=" + FIN_VER); }
  const JSPDF_URL   = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
  const SVG2PDF_URL = "https://cdn.jsdelivr.net/npm/svg2pdf.js@2.2.3/dist/svg2pdf.umd.min.js";

  // viewBox: 보드 정의(background.viewBox)에서 채움. 매니페스트 로드 전 기본값(빌리 보드)로 시작.
  let VB_X = 11.3386, VB_Y = 11.3386, VB_W = 737.717, VB_H = 1364.46;

  const ROLE_ALIAS = {};  // casts.json·casting_by_date 배역 키가 통일되어 별칭 불필요(있으면 여기에)
  function normRole(r){ return ROLE_ALIAS[r] || r; }
  function firstName(v){ return Array.isArray(v) ? String(v[0]||"").trim() : String(v||"").trim(); }
  function fmt(v){ return Number.isInteger(v) ? String(v) : v.toFixed(1); }

  // ---- 보드 매니페스트(레지스트리 → 활성 보드 정의) ----
  //  - 레지스트리(finale-boards.json) = 카탈로그: id·name·hidden·default·def(경로). 갤러리 목록의 권위.
  //  - def(finale-boards/<id>.json) = 순수 렌더 스펙(id·name 없음). 실행 시 레지스트리의 id·name을 얹는다.
  const _boardParam = new URLSearchParams(location.search).get("board") || "";
  let _registry = null, _registryPromise = null;
  function loadRegistry(){
    if(_registry) return Promise.resolve(_registry);
    if(!_registryPromise) _registryPromise = fetch(verUrl(BOARDS_URL)).then(r=>r.json()).then(reg=>{ _registry=reg; return reg; });
    return _registryPromise;
  }
  // 갤러리에 노출할 보드(숨김 제외). ?board= 없을 땐 default(숨김이면 보이는 첫 보드로 폴백)를 활성으로.
  function visibleBoards(reg){ return (reg.boards||[]).filter(b=>!b.hidden); }
  function resolveEntry(reg){
    const boards = reg.boards || [];
    let entry = boards.find(b => b.id === (_boardParam || reg.default));
    if(entry && !_boardParam && entry.hidden) entry = null;   // 기본 보드가 숨김이면 폴백
    if(!entry) entry = boards.find(b => !b.hidden) || boards[0];   // ?board=만 숨김 보드 직접 오픈 허용
    return entry;
  }
  let _manifest = null, _manifestPromise = null;
  function loadManifest(){
    if(_manifest) return Promise.resolve(_manifest);
    if(!_manifestPromise){
      _manifestPromise = (async ()=>{
        const reg = await loadRegistry();
        const entry = resolveEntry(reg);
        const def = await (await fetch(verUrl(entry.def))).json();
        _manifest = Object.assign({ id: entry.id, name: entry.name, hidden: !!entry.hidden }, def);
        return _manifest;
      })();
    }
    return _manifestPromise;
  }
  // 매니페스트 background.viewBox → VB_*(fitBoard·내보내기 크기 등에서 사용).
  // 있으면 그 창으로 크롭, 없으면 false 반환(→ SVG 자체 좌표 사용 = 크롭 안 함).
  function applyViewBox(mani){
    const vb = mani && mani.background && mani.background.viewBox;
    if(Array.isArray(vb) && vb.length===4){ VB_X=vb[0]; VB_Y=vb[1]; VB_W=vb[2]; VB_H=vb[3]; return true; }
    return false;
  }
  // 매니페스트에 viewBox가 없을 때: SVG 자체 viewBox(없으면 width/height)를 VB_*로 채택(크롭 없음).
  function adoptSvgViewBox(svg){
    const own = svg.getAttribute("viewBox");
    if(own){ const p = own.split(/[\s,]+/).map(Number); if(p.length===4 && p.every(n=>!isNaN(n))){ VB_X=p[0]; VB_Y=p[1]; VB_W=p[2]; VB_H=p[3]; return; } }
    const w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
    if(w && h){ VB_X=0; VB_Y=0; VB_W=w; VB_H=h; svg.setAttribute("viewBox", `0 0 ${w} ${h}`); }
  }

  // 스크립트 실행 시점엔 app.js의 loadStateFromStorage()가 아직 안 끝났을 수 있어
  // castStatsMode가 저장된 값이 아니라 선언 시 기본값("all")일 수 있다.
  // → 여기선 우선 기본값으로 두고, Finale 탭이 실제로 열릴 때(renderFinale) 1회 동기화한다.
  let finaleMode = "all";
  let finaleModeSynced = false;
  let booted = false;

  // 랜덤 데이터 모드: ?randomData 또는 ?randomData=<시드> → 관극수·좌석수를 (시드 기반) 랜덤으로 채움.
  //  - 시드 없으면 랜덤, 텍스트 시드 허용(썸네일 생성 시엔 '마지막 공연 id'를 시드로 사용).
  //  - 실제 관극(좌석) 데이터가 있으면 적용하지 않고 경고(랜덤이 실제 데이터를 덮지 않도록).
  const _rp = new URLSearchParams(location.search);
  const RANDOM_MODE = _rp.has("randomData");
  const RANDOM_SEED = (_rp.get("randomData") || "").trim() || ("rnd-" + Math.floor(Math.random()*1e9));
  const previewImg = () => window.showUrl("images/finale-preview.jpg");   // CI가 생성하는 썸네일(없으면 라이브 보드로 폴백)
  // 문자열 시드 → 32bit 해시(FNV-1a) → mulberry32 PRNG (같은 시드 = 같은 결과)
  function makeRng(seedStr){
    let h = 2166136261 >>> 0; const s = String(seedStr);
    for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    let a = h >>> 0;
    return function(){ a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ a>>>15, 1 | a); t = (t + Math.imul(t ^ t>>>7, 61 | t)) ^ t; return ((t ^ t>>>14) >>> 0) / 4294967296; };
  }
  let _rng = Math.random;                 // 랜덤 데이터 모드가 실제 적용될 때만 시드 RNG로 교체
  function hasRealViewData(){             // 실제 관극(좌석) 기록이 있는지
    const ps = (typeof performanceData!=="undefined" && performanceData && performanceData.performances) || [];
    return ps.some(p => (typeof hasSeat==="function") ? hasSeat(p) : !!(p && p.seat));
  }
  let _randomApplied = null;              // 랜덤 데이터 모드 적용 여부(경고 포함, 1회 판정)
  function randomModeActive(){
    if(_randomApplied !== null) return _randomApplied;
    if(!RANDOM_MODE){ _randomApplied = false; return false; }
    if(hasRealViewData()){
      const msg = "랜덤 데이터 모드는 관극 데이터가 없을 때만 사용할 수 있습니다. 실제 관극 데이터가 있어 무시합니다.";
      console.warn("[finale] " + msg); try{ alert(msg); }catch(e){}
      _randomApplied = false; return false;
    }
    _rng = makeRng(RANDOM_SEED);
    _randomApplied = true; return true;
  }
  // 랜덤 데이터 모드: 끝난 공연 일부에 무작위 좌석을 배정해 '관극 기록'을 생성한다.
  // 이렇게 하면 배역 관극수·총합·좌석 히트맵이 모두 이 기록에서 일관되게 계산됨(숫자 개별 조작 X).
  function applyRandomViewings(){
    const perfs = (typeof performanceData!=="undefined" && performanceData && performanceData.performances) || [];
    const seatIds = ((typeof seatmapData!=="undefined" && seatmapData && seatmapData.seats) || []).map(s=>s.id).filter(Boolean);
    if(!perfs.length || !seatIds.length) return;
    perfs.forEach(p=>{
      p.seat = "";
      if((typeof isEnded!=="function" || isEnded(p)) && _rng() < 0.4){   // 끝난 공연의 약 40%를 '관극'으로
        p.seat = seatIds[Math.floor(_rng()*seatIds.length)];
      }
    });
  }

  // 공연 기간 문자열. opts.padMonth===false 면 월을 0패딩 없이("%f": 04→4, 07→7) 표기(기본은 유지).
  function periodStr(opts){
    const padMonth = !opts || opts.padMonth !== false;
    const s = performanceData.startDate, e = performanceData.endDate;
    const f = d => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((d||"").trim());
      if(!m) return (d||"").replace(/-/g, ".");
      const mon = padMonth ? m[2] : String(parseInt(m[2], 10));
      return `${m[1]}.${mon}.${m[3]}`;
    };
    return (s && e) ? `${f(s)} ~ ${f(e)}` : "";
  }
  function seatWatchCount(id){
    return performanceData.performances.filter(p => p.seat===id && isEnded(p)).length;
  }
  function rosterOf(roleKey){
    const c = (performanceData.casts||[]).find(c=>normRole(c.role)===roleKey);
    return c ? c.actors.map(a=>a.name) : [];
  }

  // ---- 보드 채우기 ----
  function setText(svg, id, txt){ const el = svg.getElementById ? svg.getElementById(id) : document.getElementById(id); if(el) el.textContent = txt; return el; }

  const SVGNS = "http://www.w3.org/2000/svg";
  // 스타일 leaf 키(camelCase) → SVG presentation 속성명(kebab). fill/stroke 등 동일한 건 그대로 통과.
  const STYLE_ATTR = { fontFamily:"font-family", strokeWidth:"stroke-width", textAnchor:"text-anchor",
    fontSize:"font-size", fontWeight:"font-weight", letterSpacing:"letter-spacing",
    fillOpacity:"fill-opacity", strokeOpacity:"stroke-opacity" };
  function styleAttr(k){ return STYLE_ATTR[k] || k; }
  // 스타일 파트의 속성을 요소에 뿌린다. 인라인 style로 넣어 SVG class(.st24 등)보다 우선하게 함.
  // prefix/postfix/label/dy는 속성이 아니므로 제외(각각 문자열·오프셋 용도).
  const NON_ATTR = { prefix:1, postfix:1, label:1, dy:1 };
  function applyStyleAttrs(el, part){
    if(!part) return;
    for(const k in part){ if(NON_ATTR[k]) continue; el.style.setProperty(styleAttr(k), String(part[k])); }
    if(part.stroke && part.strokeWidth != null) el.style.setProperty("paint-order", "stroke");   // 획을 채움 아래로(faux-bold)
  }
  // 값을 스타일 파트로 감싼 tspan(prefix + 값 + postfix)
  function styledTspan(text, part){
    const t = document.createElementNS(SVGNS, "tspan");
    applyStyleAttrs(t, part);
    t.textContent = ((part && part.prefix) || "") + text + ((part && part.postfix) || "");
    return t;
  }
  function resolveStyle(mani, name){ return (mani.styles && name && mani.styles[name]) || {}; }

  // 관극수 분수를 그린다. 스타일(numerator/denominator/textAnchor)은 opts.style로 주입(코드 하드코딩 X).
  // opts: { style, label, labelFont, dy }  — label/dy는 TOTAL 등 단발 카운트용.
  function setCount(cntEl, w, t, opts){
    if(!cntEl) return; opts = opts || {};
    const style = opts.style || {}, num = style.numerator, den = style.denominator;
    // 우측 정렬: 카운트 박스(rect.st4)의 우변에 맞춤 + 스타일의 textAnchor 적용.
    const box = cntEl.parentNode && cntEl.parentNode.querySelector ? cntEl.parentNode.querySelector("rect.st4") : null;
    if(box){ if(style.textAnchor) cntEl.setAttribute("text-anchor", style.textAnchor);
      cntEl.setAttribute("x", (box.x.baseVal.value + box.width.baseVal.value).toFixed(2)); }
    if(opts.dy){ const y0 = parseFloat(cntEl.getAttribute("y")) || 0; cntEl.setAttribute("y", (y0 + opts.dy).toFixed(2)); }
    while(cntEl.firstChild) cntEl.removeChild(cntEl.firstChild);
    if(opts.label){                                   // 선행 라벨(예: 'TOTAL ')
      const lab = document.createElementNS(SVGNS, "tspan");
      if(opts.labelFont) lab.setAttribute("font-family", opts.labelFont);
      lab.textContent = opts.label; cntEl.appendChild(lab);
    }
    cntEl.appendChild(styledTspan((opts.label ? " " : "") + fmt(w), num));   // 분자
    cntEl.appendChild(styledTspan(fmt(t), den));                            // 분모(prefix " / ")
  }

  // 사진 경로는 매니페스트 photos({pattern, placeholder})가 규정. 없으면 기본값 사용.
  //   pattern: 배우 이름을 {name}에 넣어 URL 생성(예: "images/{name}.jpeg")
  //   placeholder: 사진 없을 때 대체 이미지
  const XLINK = "http://www.w3.org/1999/xlink";
  const DEF_PHOTOS = { pattern: "images/{name}.jpeg", placeholder: "images/" + encodeURIComponent("플레이스홀더") + ".jpeg" };
  function photoUrlFrom(photos, name){ return verUrl(((photos && photos.pattern) || DEF_PHOTOS.pattern).replace("{name}", encodeURIComponent(name))); }
  function placeholderUrl(photos){ return verUrl((photos && photos.placeholder) || DEF_PHOTOS.placeholder); }
  // 실제 사진은 위쪽 정렬(YMin: 얼굴 상단), 플레이스홀더는 세로 중앙(YMid)
  function setPhoto(el, name, photos){
    if(!el) return;
    const ph = placeholderUrl(photos), url = name ? photoUrlFrom(photos, name) : ph;
    if(!name) el.setAttribute("preserveAspectRatio", "xMidYMid slice");   // 이름 없는 슬롯 → 중앙
    el.addEventListener("error", function onerr(){    // 사진 없으면 플레이스홀더로(세로 중앙)
      el.removeEventListener("error", onerr);
      el.setAttribute("preserveAspectRatio", "xMidYMid slice");
      el.setAttributeNS(XLINK, "href", ph); el.setAttribute("href", ph);
    }, { once: true });
    el.setAttributeNS(XLINK, "href", url); el.setAttribute("href", url);
  }

  // ---- 매니페스트 렌더 엔진 ----
  // 값 계산(암묵) — 싱글톤·구조적 요소가 쓰는 값. 모두 데이터/공용 스탯에서 직접 계산.
  function actorStatVal(role, actor){   // 배역의 특정 actor 통계(예: 발레걸즈 타운) → {w,t}
    const s = (typeof computeRoleActorStats === "function") ? computeRoleActorStats(role, finaleMode)[actor] : null;
    return s ? { w:s.watched, t:s.total } : { w:0, t:0 };
  }
  function grandTotalVal(){              // 전체 합계(전 공연/관극)
    const ps = performanceData.performances || [];
    return { w: ps.filter(p=>isEnded(p) && hasSeat(p)).length, t: ps.length };
  }
  function periodVenueVal(sub){          // 공연 기간 + 장소 (sub = mani.subtitle: sep·padMonth 등)
    sub = sub || {};
    return [periodStr(sub), (seatmapData && seatmapData.theater) || ""].filter(Boolean).join(sub.sep || "  ");
  }
  // count 스타일 + (선택)라벨 스타일 → setCount opts
  function countOpts(mani, styleName, labelStyleName){
    const opts = { style: resolveStyle(mani, styleName) };
    const ls = labelStyleName ? resolveStyle(mani, labelStyleName) : null;   // TOTAL 등: 라벨 문자열·글꼴·dy
    if(ls){ if(ls.label != null) opts.label = ls.label; if(ls.fontFamily) opts.labelFont = ls.fontFamily; if(ls.dy) opts.dy = ls.dy; }
    return opts;
  }
  // 주연 배우 통계는 app.js의 공용 함수(computeRoleActorStats) 재사용 → {w:관극, t:전체}.
  //  그룹(발레·앙상블) 멤버는 개별 통계 없음(슬롯에 관극수 요소 자체가 없음; 그룹 값=전 공연 == total).
  // casts.json → 슬롯 그룹 파생(선언 없이 자동).
  //  주연(!group): slot=id, 멤버=actors(+통계).
  //  그룹+actors(발레): actor마다 slot={id}_{actor.id}(byTeam) + 베이스 slot=id(byTeam 없는 members=어른). 통계 없음.
  //  그룹 no actors(앙상블): slot=id, 멤버=members. 통계 없음.
  function castSlotGroups(casts){
    const out = [];
    casts.forEach(c => {
      if(!c.id) return;
      if(!c.group){
        const rs = (typeof computeRoleActorStats === "function") ? computeRoleActorStats(c.role, finaleMode) : {};
        out.push({ slot: c.id, roleId: c.id, members: (c.actors||[]).map(a => ({
          name:a.name, role:a.role, stat: rs[a.name] ? { w:rs[a.name].watched, t:rs[a.name].total } : { w:0, t:0 } })) });
      } else if(c.actors && c.actors.length){
        const members = c.members || [];
        c.actors.forEach(a => {
          const ms = members.filter(m => m.byTeam && m.byTeam[a.name]).map(m => ({ name:m.byTeam[a.name] }));
          out.push({ slot: `${c.id}_${a.id}`, roleId: c.id, members: ms });
        });
        out.push({ slot: c.id, roleId: c.id, members: members.filter(m => !m.byTeam && m.name).map(m => ({ name:m.name })) });
      } else {
        out.push({ slot: c.id, roleId: c.id, members: (c.members||[]).map(m => m.name).filter(Boolean).map(name => ({ name })) });
      }
    });
    return out;
  }
  // exclude: [{type:"role", id|name}, {type:"cover", name}, {type:"actor", slot|id, name}]
  function parseExclude(list){
    const roleIds=new Set(), roleNames=new Set(), covers=new Set(), actors=new Set();
    (list||[]).forEach(e=>{
      if(!e || !e.type) return;
      if(e.type==="role"){ if(e.id) roleIds.add(e.id); if(e.name) roleNames.add(e.name); }
      else if(e.type==="cover"){ if(e.name) covers.add(e.name); }
      else if(e.type==="actor"){ if(e.name) actors.add((e.slot||e.id||"*")+" "+e.name); }
    });
    return { roleIds, roleNames, covers, actors };
  }
  // "$item" / "$item.name" / "$item.stat" 등 슬롯 바인딩 참조 해석
  function itemRef(ref, item){
    if(typeof ref !== "string" || ref[0] !== "$") return ref;
    if(ref === "$item") return item;
    const path = ref.replace(/^\$item\.?/, "");
    return path ? path.split(".").reduce((o,k)=> (o==null?o:o[k]), item) : item;
  }
  // 한 필드(text/count/photo)를 슬롯 요소에 렌더. item(배우) 없으면 그 필드를 숨김(흰색).
  function renderField(svg, mani, field, el, item, photos){
    if(!el) return;
    const has = item && item.name != null;
    if(!has){ el.style.display = "none"; return; }   // 빈 슬롯 → 숨김(흰색)
    el.style.display = "";
    const style = resolveStyle(mani, field.style);
    if(field.type === "photo"){ setPhoto(el, itemRef(field.bind, item), photos); return; }
    if(field.type === "count"){ const st = itemRef(field.bind, item) || { w:0, t:0 }; setCount(el, st.w || 0, st.t || 0, { style }); return; }
    // text(기본)
    applyStyleAttrs(el, style);
    el.textContent = itemRef(field.bind, item);
  }
  // 슬롯 그룹 채우기 — slotTemplate.fields(list) × 슬롯 index(배경에 존재하는 만큼). 첫 필드를 슬롯 존재 판정에 사용.
  //  slot = 슬롯 토큰(id 규칙 {slot} 치환). 주연은 casts.json id, 그룹은 매니페스트 slot.
  function renderSlotGroup(svg, mani, tmpl, slot, items, photos){
    const fields = tmpl.fields || [];
    if(!fields.length) return 0;
    const idOf = (tpl, i) => tpl.replace(/\{slot\}/g, slot).replace(/\{i\}/g, i);
    let i = 0;
    while(svg.querySelector("#" + idOf(fields[0].id, i))){   // 첫 필드 요소가 있으면 그 슬롯 존재
      const item = items[i];
      fields.forEach(f => renderField(svg, mani, f, svg.querySelector("#" + idOf(f.id, i)), item, photos));
      i++;
    }
    return i;   // 배경에 존재하는 슬롯 개수(칠할 자리 수)
  }
  // 슬롯 전체 숨김(역할/그룹 통째 exclude 시)
  function hideSlot(svg, tmpl, slot){
    const fields = tmpl.fields || [];
    if(!fields.length) return;
    const idOf = (tpl, i) => tpl.replace(/\{slot\}/g, slot).replace(/\{i\}/g, i);
    let i = 0;
    while(svg.querySelector("#" + idOf(fields[0].id, i))){
      fields.forEach(f => { const el = svg.querySelector("#" + idOf(f.id, i)); if(el) el.style.display = "none"; });
      i++;
    }
  }
  // 매니페스트를 svg에 적용: casts 파생 슬롯 + 구조적 그룹총계 + 명시적 싱글톤(bindings 없음).
  function renderManifest(svg, mani){
    const tmpl = mani.slotTemplate || {};
    const casts = (typeof performanceData !== "undefined" && performanceData && performanceData.casts) || [];
    const ex = parseExclude(mani.exclude);
    const roleExcluded = c => ex.roleIds.has(c.id) || ex.roleNames.has(c.role);

    // ── 슬롯: casts 자동 파생 + exclude. 배치 못한 항목은 onUnplaced 정책 ──
    const roleNameOf = id => { const c = casts.find(x => x.id === id); return c ? c.role : null; };
    const unplaced = [];
    castSlotGroups(casts).forEach(g => {
      const rName = roleNameOf(g.roleId);
      if(ex.roleIds.has(g.roleId) || (rName && ex.roleNames.has(rName))){   // 역할/그룹 통째 제외 → 슬롯 숨김
        hideSlot(svg, tmpl, g.slot); return;
      }
      const items = g.members.filter(m => {
        if(ex.actors.has(g.slot + " " + m.name) || ex.actors.has("* " + m.name)) return false;   // 특정 슬롯의 특정 배우
        if(ex.covers.has(m.name) && (m.role === "cover" || m.role === "standby")) return false;   // 커버/스탠바이만
        return true;
      });
      const slots = renderSlotGroup(svg, mani, tmpl, g.slot, items, mani.photos);
      if(items.length > slots){
        // 슬롯을 넘긴 배우: 커버류(cover/standby/alternative)라도 실제 공연 이력(stat.t>0)이 있으면
        // 정산판에 나와야 하므로 경고 대상. 공연 이력이 없는 커버류만 정상 오버플로(전용 슬롯 없음)로 무시.
        const isCover = r => r === "cover" || r === "standby" || r === "alternative";
        const over = items.slice(slots).filter(x => !isCover(x.role) || (x.stat && x.stat.t > 0));
        if(over.length) unplaced.push(g.slot + "(" + over.map(x => x.name).join(",") + ")");
      }
    });
    if(mani.onUnplaced === "warn" && unplaced.length){   // 공개 보드라 콘솔 경고만(alert 없음)
      console.warn("[finale] 정산판에 배치하지 못한 배우가 있습니다 — " + unplaced.join(" / "));
    }

    // ── 구조적: 그룹 actor 총계(fn-group-{actor} = 그 팀의 actorStat). 값 암묵 ──
    const gc = tmpl.groupCount;
    if(gc && gc.id){
      const gcOpts = countOpts(mani, gc.style, gc.labelStyle);
      casts.forEach(c => {
        if(!c.group || !c.actors) return;
        const excl = roleExcluded(c);
        c.actors.forEach(a => {
          if(!a.id) return;
          const el = svg.querySelector("#" + gc.id.replace(/\{actor\}/g, a.id)); if(!el) return;
          if(excl){ el.style.display = "none"; return; }           // 그룹 제외 시 총계도 숨김
          const v = actorStatVal(c.role, a.name);
          setCount(el, v.w, v.t, gcOpts);
        });
      });
    }

    // ── 명시적 싱글톤(값 암묵) ──
    if(mani.headings && mani.headings.selector){                    // 배역 헤딩 스타일(st21/st23 → Anton)
      const st = resolveStyle(mani, mani.headings.style);
      svg.querySelectorAll(mani.headings.selector).forEach(el => applyStyleAttrs(el, st));
    }
    if(mani.totalCount && mani.totalCount.svgId){                   // 전체 총계
      const el = svg.querySelector("#" + mani.totalCount.svgId);
      if(el){ const v = grandTotalVal(); setCount(el, v.w, v.t, countOpts(mani, mani.totalCount.style, mani.totalCount.labelStyle)); }
    }
    if(mani.subtitle && mani.subtitle.svgId){                       // 공연 기간·장소
      const el = svg.querySelector("#" + mani.subtitle.svgId);
      if(el){ applyStyleAttrs(el, resolveStyle(mani, mani.subtitle.style));
        const v = periodVenueVal(mani.subtitle); if(v) el.textContent = v; }
    }
    if(mani.seatmap) injectSeatmap(svg, mani.seatmap);              // 좌석 히트맵
    if(mani.preview) injectPreviewWatermark(svg);                   // preview:true → 대각선 "PREVIEW" 워터마크
  }
  // 보드 전체를 대각선으로 가르는 검은 볼드 "PREVIEW" 워터마크(미확정 보드 표시용).
  function injectPreviewWatermark(svg){
    const vbAttr=(svg.getAttribute("viewBox")||"").split(/[\s,]+/).map(Number);
    const [x,y,w,h] = (vbAttr.length===4 && vbAttr.every(n=>!isNaN(n)))
      ? vbAttr : [0,0,parseFloat(svg.getAttribute("width"))||1000, parseFloat(svg.getAttribute("height"))||1000];
    const cx=x+w/2, cy=y+h/2;
    const g=document.createElementNS(SVGNS,"g");
    g.setAttribute("id","fn-preview-wm");
    g.setAttribute("transform",`rotate(-30 ${cx.toFixed(1)} ${cy.toFixed(1)})`);
    g.setAttribute("pointer-events","none");
    const t=document.createElementNS(SVGNS,"text");
    t.setAttribute("x",cx.toFixed(1)); t.setAttribute("y",cy.toFixed(1));
    t.setAttribute("text-anchor","middle"); t.setAttribute("dominant-baseline","central");
    t.setAttribute("font-family","Anton, Arial, sans-serif"); t.setAttribute("font-weight","700");
    t.setAttribute("font-size",(w*0.2).toFixed(1));
    t.setAttribute("letter-spacing",(w*0.012).toFixed(1));
    t.setAttribute("fill","#000000"); t.setAttribute("fill-opacity","0.28");
    t.textContent="PREVIEW";
    g.appendChild(t); svg.appendChild(g);
  }

  // ---- 좌석 다이어그램 교체 (모든 렌더 파라미터는 seatmap 바인딩 cfg에서) ----
  function hx(c){ return [parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)]; }
  function mix(a,b,t){ const A=hx(a),B=hx(b); return '#'+[0,1,2].map(i=>Math.round(A[i]+(B[i]-A[i])*t).toString(16).padStart(2,'0')).join(''); }

  function injectSeatmap(svg, cfg){
    cfg = cfg || {};
    const sm = seatmapData; if(!sm || !sm.seats) return;
    const HEAT = cfg.heat || ['#4aa3ff','#2fd0c8','#46c84e','#c2d92a','#ffd21f','#ff9a1f','#ff6322','#ef3b2f','#d81e4a','#b3126e'];
    const heatColor = c => HEAT[Math.max(1, Math.min(HEAT.length, c)) - 1];
    // 미관극 좌석 등급색: 백→흑 그라데이션 위치(낮을수록 흰색). cfg.gradeRamp로 등급별 위치 지정.
    const ramp = cfg.gradeRamp || { VIP:0, R:0.1, S:0.2, A:0.3, default:0.35 };
    const gradeBase = grade => mix("#ffffff", "#000000", (ramp[grade] != null ? ramp[grade] : (ramp.default != null ? ramp.default : 0.35)));
    const grades = performanceData.grades || [];
    const gradeOf = id => { for(const g of grades){ if(g.seatIds && g.seatIds.includes(id)) return g.name; } return null; };

    // 기존 좌석 그리드 + 원본 좌석 패널(반투명 흰 오버레이 st6) + STAGE/층/범례 텍스트 제거
    const grid = svg.querySelector("#fn-seatgrid"); if(grid) grid.remove();
    // 원본 템플릿 좌석 배경 패널(rect.st6)이 새로 그리는 패널보다 살짝 커서 테두리가 겹쳐 보임 → 제거
    const oldPanel = svg.querySelector("rect.st6"); if(oldPanel){ (oldPanel.closest("g") || oldPanel).remove(); }
    const stageLabel = (cfg.stage && cfg.stage.label) || "STAGE";
    svg.querySelectorAll("text").forEach(t=>{ const s=(t.textContent||"").trim();
      if([stageLabel,"1F","2F","3F","1회","2회","3회","4회 이상"].includes(s)) t.remove(); });

    // 타깃 영역: cfg.target.svgId 가 있으면 SVG 안의 안보이는 placeholder(<rect id=…>)의
    // 위치·크기를 타깃으로 사용(읽은 뒤 제거). 없으면 cfg.target.rect 폴백.
    // 보드는 숨긴 컨테이너에서 렌더되므로 getBBox()가 0이 됨 → 속성(x/y/width/height)을 직접 읽는다.
    // (placeholder는 transform 없는 페이지 레벨에 두어야 좌표=board 좌표)
    let r = (cfg.target && cfg.target.rect) || null;
    if(!r && cfg.target && cfg.target.svgId){
      const box = svg.querySelector("#" + cfg.target.svgId);
      if(box){
        const num = (a) => { const v = parseFloat(box.getAttribute(a)); return isNaN(v) ? null : v; };
        const bx=num("x"), by=num("y"), bw=num("width"), bh=num("height");
        if(bw>0 && bh>0){ r = { x:bx||0, y:by||0, w:bw, h:bh }; }
        else { try{ const g=box.getBBox(); if(g.width>0) r={ x:g.x, y:g.y, w:g.width, h:g.height }; }catch(e){} }
        box.remove();
      }
    }
    r = r || { x:396, y:664, w:278, h:284 };
    const cover = { x:r.x, y:r.y, w:r.w, h:r.h };           // 좌석 패널 영역
    const floors = [...new Set(sm.seats.map(s=>s.floor))].sort((a,b)=>a-b);
    // 층 사이 간격(음수=겹침): cfg.floorGap { default, "<층>": n }
    const fg = cfg.floorGap || { default:-2, "3":-2.5 };
    const gapBefore = f => (fg[String(f)] != null ? fg[String(f)] : (fg.default != null ? fg.default : -2));
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
    const pad = cfg.padding || { x:10, top:10, legendZone:26 };
    const PADX=pad.x!=null?pad.x:10, PADT=pad.top!=null?pad.top:10, LEGEND_ZONE=pad.legendZone!=null?pad.legendZone:26;
    const areaW=cover.w-2*PADX, areaTop=cover.y+PADT, areaH=cover.h-PADT-LEGEND_ZONE;
    const scale=Math.min(areaW/worldW, areaH/worldH);
    const offX=cover.x+(cover.w-worldW*scale)/2, offY=areaTop+(areaH-worldH*scale)/2;
    const X=x=>offX+(x-minX)*scale;

    const panelFill = (cfg.panel && cfg.panel.fill) || "#de6363";
    const panelRx = (cfg.panel && cfg.panel.rx != null) ? cfg.panel.rx : 10;
    // 패널(외곽) 테두리: cfg.panel.stroke 있으면 그림. 층 외곽선도 같은 색을 쓴다(없으면 기존 흰색).
    const panelStroke = (cfg.panel && cfg.panel.stroke) || null;
    const panelStrokeW = (cfg.panel && cfg.panel.strokeWidth != null) ? cfg.panel.strokeWidth : 1;
    const outlineStroke = panelStroke || "rgba(255,255,255,0.6)";
    const stageFill = (cfg.stage && cfg.stage.fill) || "#f2e8d5";
    const stageText = (cfg.stage && cfg.stage.textFill) || "#9c1a1a";
    let mk = `<rect x="${cover.x}" y="${cover.y}" width="${cover.w}" height="${cover.h}" rx="${panelRx}" fill="${panelFill}"${panelStroke ? ` stroke="${panelStroke}" stroke-width="${panelStrokeW}"` : ""}/>`;
    placed.forEach(b=>{
      const Y=y=>offY+(b.top+(y-b.fMinY))*scale;
      (b.fm.outline||[]).forEach(poly=>{
        mk += `<polyline points="${poly.map(p=>X(p[0]).toFixed(1)+','+Y(p[1]).toFixed(1)).join(' ')}" fill="none" stroke="${outlineStroke}" stroke-width="0.8"/>`;
      });
      const sz=Math.max(1.4, 0.82*scale);
      b.fs.forEach(s=>{
        const cnt = seatWatchCount(s.id);   // 랜덤 모드에선 위에서 배정한 무작위 좌석이 반영됨
        const color = cnt>0 ? heatColor(cnt) : gradeBase(gradeOf(s.id));
        mk += `<rect x="${(X(s.svgX)-sz/2).toFixed(1)}" y="${(Y(s.svgY)-sz/2).toFixed(1)}" width="${sz.toFixed(1)}" height="${sz.toFixed(1)}" rx="${(sz*0.22).toFixed(1)}" fill="${color}"/>`;
      });
      if(b.fm.stage){ const st=b.fm.stage;
        const sx=X(st.cx-st.w/2), sy=Y(st.cy-st.h/2), sw=st.w*scale, sh=Math.max(5, st.h*scale);
        mk += `<rect x="${sx.toFixed(1)}" y="${sy.toFixed(1)}" width="${sw.toFixed(1)}" height="${sh.toFixed(1)}" rx="1.5" fill="${stageFill}"/>`;
        mk += `<text x="${X(st.cx).toFixed(1)}" y="${(sy+sh*0.72).toFixed(1)}" text-anchor="middle" font-family="sans-serif" font-size="${(sh*0.62).toFixed(1)}" fill="${stageText}" font-weight="700" letter-spacing="1.5">${stageLabel}</text>`;
      }
    });
    // 하단 범례: 관극 횟수 1~N — 정사각형 배지 안에 숫자
    const legendN = Math.min((cfg.legend && cfg.legend.count) || 10, HEAT.length);
    const sw=7.15, gap=3, total=legendN*sw+(legendN-1)*gap, lx=(cover.x+cover.w/2)-total/2, ly=cover.y+cover.h-20;
    for(let i=0;i<legendN;i++){
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
      if(scale < 0.999){
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

  let boardText = null, boardTextSrc = null;
  async function loadBoard(mani){
    const src = verUrl(mani.background.src);
    if(boardText==null || boardTextSrc!==src){ const r=await fetch(src); boardText = await r.text(); boardTextSrc = src; }
    return boardText;
  }
  let fontCss = null;   // @font-face(base64) 모음 — SVG에 임베드(매니페스트 fonts 기준)
  async function loadFontCss(mani){
    if(fontCss==null){
      const fonts = (mani && mani.fonts) || [];
      const parts = await Promise.all(fonts.map(async f=>{
        try{ const r=await fetch(f.woff2); const b=new Uint8Array(await r.arrayBuffer()); let s=""; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
          return `@font-face{font-family:'${f.family}';src:url(data:font/woff2;base64,${btoa(s)}) format('woff2');}`; }
        catch(e){ return ""; }
      }));
      fontCss = parts.join("");
    }
    return fontCss;
  }
  // 매니페스트 fonts에서 family로 PDF용 TTF 경로 조회(없으면 null)
  function ttfUrlFor(mani, family){
    const f = ((mani && mani.fonts) || []).find(x=>x.family===family);
    return (f && f.ttf) || null;
  }

  // 라이브 보드는 '무겁게' 렌더하므로 지연 생성: 오버레이를 열 때(또는 썸네일 이미지가 없어 폴백할 때)만.
  let _boardRendered = false, _boardRendering = null;
  function invalidateBoard(){ _boardRendered = false; _boardRendering = null; }
  function ensureBoardRendered(){
    if(_boardRendered) return Promise.resolve(boardSvg());
    if(_boardRendering) return _boardRendering;
    _boardRendering = (async ()=>{
      const vp = getViewport();
      if(!vp || !dataReady()){ _boardRendering = null; return null; }
      const mani = await loadManifest();
      const hasVB = applyViewBox(mani);
      const [txt, css] = await Promise.all([loadBoard(mani), loadFontCss(mani)]);
      vp.innerHTML = txt;
      const svg = vp.querySelector("svg");
      if(!svg){ _boardRendering = null; return null; }
      svg.id = "finaleBoardSvg";
      // 웹폰트 임베드(@font-face). 배역 헤딩(st21/st23) Anton 지정은 매니페스트 style 바인딩이 담당.
      if(css){
        const fst = document.createElementNS("http://www.w3.org/2000/svg","style");
        fst.textContent = css;
        svg.insertBefore(fst, svg.firstChild);
      }
      svg.removeAttribute("width"); svg.removeAttribute("height");
      if(hasVB) svg.setAttribute("viewBox", `${VB_X} ${VB_Y} ${VB_W} ${VB_H}`);   // 크롭
      else adoptSvgViewBox(svg);                                                  // 크롭 없음(SVG 자체 좌표)
      svg.dataset.w = VB_W; svg.dataset.h = VB_H;
      // 다크모드에서 투명 영역(원본 흰 배경이 viewBox 전체를 덮지 않음)이 어두운 배경으로 비치거나
      // 어둡게 저장되지 않도록, viewBox 전체를 덮는 불투명 흰 배경을 맨 뒤에 깐다.
      {
        const vb = (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
        if(vb.length === 4 && vb.every(n => !isNaN(n))){
          const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
          bg.setAttribute("x", vb[0]); bg.setAttribute("y", vb[1]);
          bg.setAttribute("width", vb[2]); bg.setAttribute("height", vb[3]);
          bg.setAttribute("fill", "#ffffff");
          svg.insertBefore(bg, svg.firstChild);
        }
      }
      if(randomModeActive()) applyRandomViewings();   // 랜덤 데이터 모드: 관극 기록(좌석) 무작위 생성
      renderManifest(svg, mani);                       // casts 파생 슬롯 + bindings(좌석 포함) — 스탯은 app 공용 함수
      if(css){ try{ if(document.fonts && document.fonts.load) await document.fonts.load('20px "Anton"'); }catch(e){} fitRoleLabels(svg); }
      _boardRendered = true;
      return svg;
    })();
    return _boardRendering;
  }

  // 탭 진입/모드 변경 시: 썸네일만 구성(동적 보드 렌더 X). 오버레이가 열려 있으면 보드 갱신.
  async function renderFinale(){
    if(!dataReady()) return;
    // Finale 탭이 처음 열리는 시점엔 app.js의 저장된 설정이 이미 복원돼 있으므로,
    // 이때 1회만 Statistics 탭의 통계 기준 값을 가져와 초기값으로 맞춘다(이후엔 독립적으로 동작).
    if(!finaleModeSynced){
      finaleModeSynced = true;
      if(typeof castStatsMode === "string"){
        finaleMode = castStatsMode;
        const sel = document.getElementById("finaleModeSelect");
        if(sel) sel.value = finaleMode;
      }
    }
    await buildThumbs();
    const ov = document.getElementById("finaleOverlay");
    if(ov && ov.style.display !== "none" && _activeEntry){ await openFinaleOverlay(_activeEntry); }
  }

  // ---- 보드 갤러리: 등록된 모든 보드를 각각 라이브 렌더 + placeholder 2개 ----
  let lastLayoutW = -1;
  let _activeEntry = null, _activeManifest = null;   // 현재 오버레이에 열린 보드
  let _boardScopeN = 0;                              // 렌더 인스턴스마다 고유 스코프 id
  const _defCache = new Map(), _svgTextCache = new Map(), _fontCssCache = new Map();
  let _randomViewingsApplied = false;
  function applyRandomViewingsOnce(){ if(_randomViewingsApplied) return; _randomViewingsApplied = true; applyRandomViewings(); }

  async function maniFor(entry){
    if(!_defCache.has(entry.id)){
      const def = await (await fetch(verUrl(entry.def))).json();
      _defCache.set(entry.id, Object.assign({ id:entry.id, name:entry.name, hidden:!!entry.hidden }, def));
    }
    return _defCache.get(entry.id);
  }
  async function svgTextFor(mani){
    const src = verUrl(mani.background.src);
    if(!_svgTextCache.has(src)) _svgTextCache.set(src, await (await fetch(src)).text());
    return _svgTextCache.get(src);
  }
  async function fontCssFor(mani){
    if(!_fontCssCache.has(mani.id)){
      const parts = await Promise.all(((mani && mani.fonts) || []).map(async f=>{
        try{ const r=await fetch(f.woff2); const b=new Uint8Array(await r.arrayBuffer()); let s=""; for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
          return `@font-face{font-family:'${f.family}';src:url(data:font/woff2;base64,${btoa(s)}) format('woff2');}`; }
        catch(e){ return ""; }
      }));
      _fontCssCache.set(mani.id, parts.join(""));
    }
    return _fontCssCache.get(mani.id);
  }
  // 여러 보드를 동시에 DOM에 두면 각 보드 <style>의 .stN 규칙이 전역 충돌한다(보드마다 뜻이 다름).
  // → 그 보드 <style>의 셀렉터를 루트 id로 스코프해 자기 보드에만 적용시킨다.
  //   (클래스 속성은 그대로 두므로 renderManifest의 querySelector(.stN)는 계속 동작.)
  function scopeBoardStyles(svg){
    const sid = svg.id; if(!sid) return;
    svg.querySelectorAll("style").forEach(st=>{
      let css = st.textContent || "";
      if(/@font-face/.test(css)) return;                 // 폰트(@font-face)는 전역 유지
      css = css.replace(/<!\[CDATA\[|\]\]>/g, "");        // HTML 파서가 남긴 CDATA 마커 제거
      css = css.replace(/([^{}]+)\{([^{}]*)\}/g, (m, sel, body)=>{
        const scoped = sel.split(",").map(s=>{ s=s.trim(); if(!s) return null;
          return s[0]==="." ? `#${sid} ${s}, #${sid}${s}` : `#${sid} ${s}`; }).filter(Boolean).join(", ");
        return `${scoped}{${body}}`;
      });
      st.textContent = css;
    });
  }
  // 한 보드를 container 안에 라이브 렌더(사진·좌석·통계 채움). asId 주면 svg에 그 id 부여(오버레이용).
  async function renderBoardInto(container, entry, asId){
    if(!dataReady()) return null;
    const mani = await maniFor(entry);
    const [txt, css] = await Promise.all([svgTextFor(mani), fontCssFor(mani)]);
    container.innerHTML = txt;
    const svg = container.querySelector("svg"); if(!svg) return null;
    svg.id = asId || ("fnbd-" + (_boardScopeN++));
    svg.style.fontSize = "12px";                          // Visio 루트 클래스의 em 기준(스코프 후 유실 방지)
    if(css){ const fst=document.createElementNS(SVGNS,"style"); fst.textContent=css; svg.insertBefore(fst, svg.firstChild); }
    scopeBoardStyles(svg);                                // 보드 <style>를 이 svg에만 한정(전역 충돌 방지)
    svg.removeAttribute("width"); svg.removeAttribute("height");
    let vbX=0, vbY=0, vbW, vbH;
    const vb = mani.background && mani.background.viewBox;
    if(Array.isArray(vb) && vb.length===4){ [vbX,vbY,vbW,vbH]=vb; svg.setAttribute("viewBox", vb.join(" ")); }
    else {
      const own=(svg.getAttribute("viewBox")||"").split(/[\s,]+/).map(Number);
      if(own.length===4 && own.every(n=>!isNaN(n))){ [vbX,vbY,vbW,vbH]=own; }
      else { vbW=parseFloat(svg.getAttribute("width"))||1000; vbH=parseFloat(svg.getAttribute("height"))||1000; svg.setAttribute("viewBox",`0 0 ${vbW} ${vbH}`); }
    }
    { const bg=document.createElementNS(SVGNS,"rect"); bg.setAttribute("x",vbX); bg.setAttribute("y",vbY);
      bg.setAttribute("width",vbW); bg.setAttribute("height",vbH); bg.setAttribute("fill","#ffffff"); svg.insertBefore(bg, svg.firstChild); }
    if(randomModeActive()) applyRandomViewingsOnce();
    renderManifest(svg, mani);
    if(css){ try{ if(document.fonts && document.fonts.load) await document.fonts.load('20px "Anton"'); }catch(e){} fitRoleLabels(svg); }
    return { svg, mani, vbX, vbY, vbW, vbH };
  }

  // 보드별 정적 미리보기 이미지(CI가 생성): images/finale-preview-<boardId>.jpg
  function previewUrlFor(id){ return window.showUrl("images/finale-preview-" + encodeURIComponent(id) + ".jpg"); }
  // 존재 여부를 오프-DOM Image로 판별(있으면 이미지 반환) — DOM에 넣어 404 대기하면 깨진 아이콘이 잠깐 보임.
  function probePreview(url){
    if(RANDOM_MODE) return Promise.resolve(null);         // 랜덤 데이터 모드는 항상 라이브 보드
    return new Promise(res=>{ const im=new Image();
      im.onload=()=>res(im.naturalWidth>0?im:null); im.onerror=()=>res(null); im.src=url; });
  }
  async function liveThumbInto(card, entry){              // 정적 미리보기 없을 때: 라이브 보드 렌더 폴백
    const res = await renderBoardInto(card, entry);
    if(res && card.isConnected){ card.dataset.ar=(res.vbW/res.vbH)||0.5;
      if(res.svg){ res.svg.style.width="100%"; res.svg.style.height="100%"; } layoutThumbs(); }
  }
  async function buildThumbs(){
    const wrap = document.getElementById("finaleThumbs"); if(!wrap) return;
    const reg = await loadRegistry();
    const boards = visibleBoards(reg);
    wrap.innerHTML = "";
    boards.forEach(entry=>{
      const card = document.createElement("div");
      card.className = "finale-thumb real";
      card.dataset.ar = 0.5;                               // 렌더 후 실제 비율로 교체
      card.addEventListener("click", ()=>openFinaleOverlay(entry));
      wrap.appendChild(card);
      (async ()=>{
        // 1) CI가 만든 정적 미리보기(1장) 우선 — 개별 사진 다운로드·라이브 렌더 없이 빠르게 표시.
        const im = await probePreview(previewUrlFor(entry.id));
        if(!card.isConnected) return;
        if(im){
          card.dataset.ar = (im.naturalWidth/im.naturalHeight) || 0.5;
          const img = document.createElement("img");
          img.className = "finale-thumb-img"; img.alt = "Finale 보드 미리보기";
          img.addEventListener("error", ()=>{ if(card.isConnected){ img.remove(); liveThumbInto(card, entry); } }, {once:true});
          img.src = previewUrlFor(entry.id);
          card.insertBefore(img, card.firstChild);
        } else {
          await liveThumbInto(card, entry);                // 2) 미리보기 없으면 라이브 폴백
        }
        if(!card.isConnected) return;
        const badge = document.createElement("div");
        badge.className = "finale-thumb-badge"; badge.textContent = "크게 보기";
        card.appendChild(badge);                           // 이미지/보드 위에 오도록 마지막에 추가
        layoutThumbs();
      })();
    });
    for(let i=0;i<2;i++){                                  // "디자인 모집 중" placeholder 2개
      const card = document.createElement("div");
      card.className = "finale-thumb placeholder";
      card.dataset.ar = 0.75 + Math.random()*(1.35-0.75);
      card.style.backgroundColor = `hsl(${Math.floor(Math.random()*360)} ${24+Math.floor(Math.random()*20)}% ${22+Math.floor(Math.random()*12)}%)`;
      card.innerHTML = '<div class="ph-inner"><span class="ph-icon">🎭</span><span class="ph-label">디자인 모집 중</span></div>';
      wrap.appendChild(card);
    }
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
  // 오버레이 = 실제 이미지 렌더 시점: 여기서 라이브 보드를 (지연) 렌더한다.
  let _overlayHistoryPushed = false;
  async function openFinaleOverlay(entry){
    const ov=document.getElementById("finaleOverlay"); if(!ov) return;
    entry = entry || _activeEntry; if(!entry) return;
    ov.style.display="flex";
    // 스마트폰 뒤로가기로 닫을 수 있도록 히스토리 항목 추가
    if(!_overlayHistoryPushed){ try{ history.pushState({ finaleOverlay:true }, ""); _overlayHistoryPushed=true; }catch(e){} }
    const vp = getViewport();
    if(vp){
      const res = await renderBoardInto(vp, entry, "finaleBoardSvg");
      if(res){ _activeEntry=entry; _activeManifest=res.mani;
        VB_X=res.vbX; VB_Y=res.vbY; VB_W=res.vbW; VB_H=res.vbH;
        if(res.svg){ res.svg.style.width=""; res.svg.style.height=""; res.svg.dataset.w=VB_W; res.svg.dataset.h=VB_H; } }
    }
    requestAnimationFrame(fitBoard);   // 표시 후 뷰포트 크기 확정된 뒤 맞춤
  }
  function hideOverlay(){ const ov=document.getElementById("finaleOverlay"); if(ov) ov.style.display="none"; }
  // 닫기 버튼·배경 클릭 → 우리가 push한 히스토리 항목을 되돌려(뒤로가기) popstate에서 실제로 닫음
  function closeFinaleOverlay(){
    const ov=document.getElementById("finaleOverlay");
    if(!ov || ov.style.display==="none") return;
    if(_overlayHistoryPushed){ _overlayHistoryPushed=false; history.back(); }
    else hideOverlay();
  }
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
      ctx.fillStyle="#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);   // PNG·JPG 모두 흰 배경(다크 저장 방지)
      ctx.setTransform(scale,0,0,scale,0,0); ctx.drawImage(img,0,0);
      return await new Promise(res=>canvas.toBlob(res,type,quality));
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportRaster(type, ext, quality){
    const blob=await rasterize(type,quality);
    if(blob) triggerDownload(blob, `makullim-finale-${stamp()}.${ext}`); else alert("이미지를 만들지 못했습니다.");
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
  const HANGUL = /[가-힣ᄀ-ᇿ㄰-㆏]/;
  const BAKE_PROPS=["fill","fill-opacity","fill-rule","stroke","stroke-width","stroke-opacity",
    "stroke-linecap","stroke-linejoin","stroke-miterlimit","stroke-dasharray","opacity",
    "font-size","font-weight","font-style","text-anchor"];
  // PDF에 쓸 폰트 결정: 한글이 있으면 반드시 한글 폰트(글리프 보장), 아니면 계산된 글꼴이
  // PDF에 등록된(ttf 임베드) 폰트면 그대로, 아니면 한글 폰트로 폴백.
  function bakedFamily(cs, text, registered){
    if(HANGUL.test(text||"")) return PDF_KR_FAM;
    const first = ((cs.fontFamily||"").split(",")[0]||"").replace(/['"]/g,"").trim();
    if(registered.has(first)) return first;
    for(const r of registered){ if(r!==PDF_KR_FAM &&
        new RegExp(r.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i").test(cs.fontFamily||"")) return r; }
    return PDF_KR_FAM;
  }
  function bakeStyles(root, registered){
    registered = registered || new Set([PDF_KR_FAM]);
    root.querySelectorAll("*").forEach(el=>{
      const tag=el.tagName.toLowerCase();
      if(tag==="style"||tag==="clippath"||tag==="defs") return;
      const cs=getComputedStyle(el);
      BAKE_PROPS.forEach(p=>{ const v=cs.getPropertyValue(p); if(v) el.setAttribute(p, v); });
      if(tag==="text"||tag==="tspan"){
        el.setAttribute("font-family", bakedFamily(cs, el.textContent, registered));
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
      const mani=_activeManifest || await loadManifest();
      const krTtf=ttfUrlFor(mani, PDF_KR_FAM);
      const doc=new jsPDF({ orientation: VB_W>VB_H?"l":"p", unit:"pt", format:[VB_W,VB_H] });
      const registered=new Set();
      let fontName=null;
      try{ if(!krTtf) throw new Error("no ttf"); const b64=await fontB64(krTtf); doc.addFileToVFS("IBMPlexKR.ttf",b64);
        doc.addFont("IBMPlexKR.ttf",PDF_KR_FAM,"normal"); doc.addFont("IBMPlexKR.ttf",PDF_KR_FAM,"bold");
        doc.setFont(PDF_KR_FAM); fontName=PDF_KR_FAM; registered.add(PDF_KR_FAM); }catch(fe){}
      if(!fontName) throw new Error("한글 폰트 로드 실패");   // 깨진 벡터 대신 래스터 폴백
      // 매니페스트의 나머지 폰트(ttf 있는 것) 모두 등록 → 헤딩 Anton·TOTAL Handlee 등 라틴 글자를 그 글꼴로.
      for(const f of (mani.fonts||[])){
        if(!f.ttf || f.family===PDF_KR_FAM || registered.has(f.family)) continue;
        try{ const ab=await fontB64(ttfUrlFor(mani, f.family)); const vfs=f.family.replace(/[^A-Za-z0-9]/g,"")+".ttf";
          doc.addFileToVFS(vfs,ab); doc.addFont(vfs,f.family,"normal"); doc.addFont(vfs,f.family,"bold");
          registered.add(f.family); }catch(fe){}
      }
      const svgForPdf=el.cloneNode(true);
      svgForPdf.removeAttribute("style");
      svgForPdf.style.position="absolute"; svgForPdf.style.left="-99999px"; svgForPdf.style.top="0";
      svgForPdf.style.width=VB_W+"px"; svgForPdf.style.height=VB_H+"px";
      document.body.appendChild(svgForPdf);
      try{ if(document.fonts&&document.fonts.ready) await document.fonts.ready; }catch(e){}
      bakeStyles(svgForPdf, registered);   // CSS 클래스 색·획을 속성으로 굽기 + 폰트 지정(등록 폰트 기준)
      document.body.removeChild(svgForPdf);
      svgForPdf.querySelectorAll("style").forEach(s=>s.remove());   // @font-face 제거
      await inlinePhotos(svgForPdf, true);                           // 사진 임베드+슬롯 비율 크롭
      if(typeof doc.svg==="function") await doc.svg(svgForPdf,{x:0,y:0,width:VB_W,height:VB_H});
      else await window.svg2pdf(svgForPdf,doc,{x:0,y:0,width:VB_W,height:VB_H});
      doc.save(`makullim-finale-${stamp()}.pdf`);
    }catch(err){
      try{ // 벡터 변환 실패 시에만 고해상도 이미지 PDF로 폴백
        const { jsPDF }=window.jspdf;
        const blob=await rasterize("image/png");
        const dataUrl=await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(blob); });
        const doc=new jsPDF({ orientation: VB_W>VB_H?"l":"p", unit:"pt", format:[VB_W,VB_H] });
        doc.addImage(dataUrl,"PNG",0,0,VB_W,VB_H); doc.save(`makullim-finale-${stamp()}.pdf`);
        alert("한글 벡터 변환에 실패하여 고해상도 이미지 PDF로 저장했습니다.");
      }catch(e2){ alert("PDF를 만들지 못했습니다: "+err.message); }
    }finally{ if(btn){ btn.disabled=false; btn.textContent=label; } }
  }

  // ---- 초기화 ----
  function init(){
    if(booted) return; booted=true;
    wireZoom();
    const sel=document.getElementById("finaleModeSelect");
    if(sel){ sel.value=finaleMode; sel.addEventListener("change", ()=>{ finaleMode=sel.value; invalidateBoard(); renderFinale(); }); }
    // 스마트폰 뒤로가기: 오버레이가 열려 있으면 페이지 이동 대신 오버레이만 닫기
    window.addEventListener("popstate", ()=>{
      const ov=document.getElementById("finaleOverlay");
      if(ov && ov.style.display!=="none"){ _overlayHistoryPushed=false; hideOverlay(); }
    });
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
  window.renderFinaleBoard = async function(){   // CI 썸네일 생성용(기본/지정 보드를 뷰포트에 렌더)
    const reg = await loadRegistry(); const entry = resolveEntry(reg);
    const vp = getViewport(); if(!vp || !entry) return null;
    const res = await renderBoardInto(vp, entry, "finaleBoardSvg");
    if(res){ _activeEntry=entry; _activeManifest=res.mani; VB_X=res.vbX; VB_Y=res.vbY; VB_W=res.vbW; VB_H=res.vbH; }
    return res ? res.svg : null;
  };
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
