/* =========================================================
   stamp.js — 막울림 "도장판(Stamp)" 기능 (요청 0087)

   빌리 엘리어트 관극 스탬프 다이어리. 공연을 볼 때마다 도장을 찍고,
   10칸(도장판) 단위로 채워 선물 체크(3·7·10번째)를 관리한다.

   - app.js 이후 로드되는 독립 모듈(IIFE). 전역(performanceData·isEnded·
     hasSeat·escHtml·showUrl·currentShowId 등)을 참조한다.
   - 설정은 공연 데이터(shows/<id>/stamp.json)에서 읽는다(데이터 주도).
   - 사용자 상태(찍힌 도장·이름·펼침 등)는 자체 localStorage 키에 저장한다.
   - 개발 중 기능: 상시 탭 없이 앵커(#stamp) 또는 쿼리(?stamp)로만 접근.
   ========================================================= */
(function(){
  "use strict";

  var CFG = null;            // shows/<id>/stamp.json (로드 후 캐시)
  var cfgPromise = null;
  var st = null;             // 사용자 상태 { boards:[...], seq:n }
  var booted = false;
  var pendingActivate = false; // 데이터 준비 전 활성화 요청이 들어온 경우
  var drag = null;             // 드래그 중 상태 { el, id, lastClientY, raf } — 커버 길게 눌러 바로 드래그

  /* ---------- 유틸 ---------- */
  function esc(s){ return (typeof escHtml==="function") ? escHtml(s) : String(s==null?"":s); }
  function dataReady(){ return typeof performanceData!=="undefined" && performanceData && Array.isArray(performanceData.performances); }
  function showId(){ return (typeof currentShowId==="string" && currentShowId) ? currentShowId : (typeof APP_ID==="string" ? APP_ID : "default"); }
  function storageKey(){ return "makollim:stamp:v1:" + showId(); }

  var DEFAULT_CFG = {
    title:"Billy's Diary", slots:10,
    coverImage:"", boardImage:"",
    boardAspect:[904,1739], coverAspect:[1569,1002],
    grid:{ rowTop:0.0805, rowH:0.09126, checkX:0.598, dayX:0.847, giftX:0.775, giftYRel:0.80 },
    giftRows:[3,7,10],
    stampTypes:[{id:"excellent",label:"EXCELLENT"},{id:"homecoming",label:"HOME COMING"}],
    defaultStamp:"excellent", rules:[], doubleDates:[]
  };

  // SHOW_BASE가 준비돼 showUrl이 절대경로(/shows/<id>/…)를 주는지. 준비 전엔 슬러그 상대경로(/billy/…)로 나가 404가 난다.
  function baseReady(){ return typeof showUrl==="function" && showUrl("_").charAt(0)==="/"; }
  // stamp.json 콘텐츠 버전 — 커밋 SHA(BUILD)로 매 배포 버스트하지 않고, 이 설정 파일을 실제로 바꿀 때만 올린다.
  // 버전이 소스(여기)에 박혀 있어 로컬·배포 모두 ?v가 붙으므로 no-store가 필요 없다.
  var CFG_VER = 10;
  function loadConfig(){
    if(CFG) return Promise.resolve(CFG);
    if(cfgPromise) return cfgPromise;
    cfgPromise = new Promise(function(resolve){
      var tries = 0;
      (function attempt(){
        // SHOW_BASE 준비 전 fetch 금지(슬러그 경로 404 → 설정 실패가 캐시되는 버그 방지)
        if(!baseReady() && tries++ < 120){ setTimeout(attempt, 80); return; }
        var path = "stamp.json?v=" + CFG_VER;   // 콘텐츠 버전(내용 바뀔 때만 증가)
        var url = baseReady() ? showUrl(path) : path;
        fetch(url).then(function(r){ if(!r.ok) throw new Error("no stamp.json"); return r.json(); })
          .then(function(j){ CFG = normalizeCfg(j); resolve(CFG); })
          .catch(function(){ CFG = normalizeCfg(null); resolve(CFG); });
      })();
    });
    return cfgPromise;
  }
  function normalizeCfg(j){
    j = j || {};
    var c = Object.assign({}, DEFAULT_CFG, j);
    c.grid = Object.assign({}, DEFAULT_CFG.grid, j.grid||{});
    c.slots = (typeof c.slots==="number" && c.slots>0) ? c.slots : 10;
    if(!Array.isArray(c.stampTypes) || !c.stampTypes.length) c.stampTypes = DEFAULT_CFG.stampTypes.slice();
    if(!Array.isArray(c.rules)) c.rules = [];
    if(!Array.isArray(c.doubleDates)) c.doubleDates = [];
    if(!Array.isArray(c.giftRows)) c.giftRows = [];
    if(!Array.isArray(c.boardAspect)||c.boardAspect.length<2) c.boardAspect = DEFAULT_CFG.boardAspect.slice();
    if(!Array.isArray(c.coverAspect)||c.coverAspect.length<2) c.coverAspect = DEFAULT_CFG.coverAspect.slice();
    return c;
  }
  function isGiftRow(n){ return CFG.giftRows.indexOf(n) >= 0; }
  // 이미지 캐시 버스터는 커밋 SHA(BUILD)가 아니라 콘텐츠 버전(CFG.imgVer)을 쓴다.
  // 이유: 이미지는 거의 안 바뀌므로 매 배포(커밋)마다 재다운로드하지 않고, 그림을 실제 교체하고
  //       imgVer를 올렸을 때만 새로 받게 하기 위함. (JSON/JS/CSS는 자주 바뀌어 BUILD로 버스트)
  function imgUrl(p){
    if(!p) return "";
    var u = (typeof showUrl==="function") ? showUrl(p) : p;
    var v = (CFG && CFG.imgVer!=null) ? CFG.imgVer : 1;
    return u + (u.indexOf("?")>=0 ? "&" : "?") + "v=" + encodeURIComponent(v);
  }
  function stampLabel(id){
    var t = (CFG.stampTypes||[]).find(function(s){ return s.id===id; });
    return t ? t.label : id;
  }

  /* ---------- 상태 저장/로드 ---------- */
  function loadState(){
    try{
      var raw = localStorage.getItem(storageKey());
      if(raw){ st = JSON.parse(raw); }
    }catch(e){ st = null; }
    if(!st || typeof st!=="object"){ st = { boards:[], seq:0, autoTargetId:null }; }
    if(!Array.isArray(st.boards)) st.boards = [];
    if(typeof st.seq!=="number") st.seq = st.boards.length;
    if(typeof st.autoTargetId!=="string") st.autoTargetId = null; // 자동이 채울 기본 도장판 id
    st.boards.forEach(normalizeBoard);
    return st;
  }
  function saveState(){
    try{ localStorage.setItem(storageKey(), JSON.stringify(st)); }
    catch(e){ console.error("도장판 저장 실패:", e); }
  }
  function normalizeBoard(b){
    if(!b.id) b.id = "b" + (++st.seq);
    if(typeof b.name!=="string") b.name = "";
    if(typeof b.open!=="boolean") b.open = true;
    if(typeof b.autoFill!=="boolean") b.autoFill = true; // 자동 채움 대상 여부(끄면 자동 제외)
    if(!Array.isArray(b.slots)) b.slots = [];
    // 슬롯 길이를 config.slots로 맞춘다(모자라면 null 채움)
    var n = CFG ? CFG.slots : 10;
    while(b.slots.length < n) b.slots.push(null);
    b.slots.length = Math.max(b.slots.length, n);
    if(!b.gifts || typeof b.gifts!=="object") b.gifts = {}; // {"3":true,...}
    return b;
  }
  function baseTitle(){ return ((CFG && CFG.title) || "Diary").trim(); }
  // 이름이 '기본제목 #숫자' 형태면 그 숫자, 아니면 null
  function boardNumberOf(b){
    var m = (b && b.name ? b.name.trim() : "").match(new RegExp("^"+escapeRe(baseTitle())+"\\s*#\\s*(\\d+)$"));
    return m ? parseInt(m[1],10) : null;
  }
  // 새 도장판 번호 = 현재 '기본제목 #n'들의 최대 숫자 + 1
  function nextBoardNumber(){
    var mx = 0;
    st.boards.forEach(function(b){ var n = boardNumberOf(b); if(n && n>mx) mx=n; });
    return mx + 1;
  }
  // 이름은 항상 명시적으로 저장한다(기본 이름 유지 없음). 폴백만 안전용.
  function boardTitle(b, idx){
    var nm = (b.name||"").trim();
    return nm || (baseTitle() + " #" + (idx+1));
  }
  function slotCount(){ return CFG ? CFG.slots : 10; }
  function isFull(b){ return b.slots.filter(Boolean).length >= slotCount(); }

  /* ---------- 도장 배치 로직 ---------- */
  function newBoard(){
    var b = normalizeBoard({ id:"b"+(++st.seq), name: baseTitle()+" #"+nextBoardNumber(), open:true, slots:[], gifts:{}, autoFill:true });
    st.boards.push(b);
    return b;
  }
  // 이름이 비어 있던(옛) 재관카드에 '기본제목 #n'을 명시적으로 부여
  function migrateNames(){
    var changed = false;
    st.boards.forEach(function(b){
      if(!(b.name && b.name.trim())){ b.name = baseTitle()+" #"+nextBoardNumber(); changed = true; }
    });
    if(changed) saveState();
  }
  // 유효한 자동 대상(지정됐고 빈칸이 남은 재관카드)
  function validTarget(){
    var t = st.autoTargetId ? st.boards.filter(function(b){return b.id===st.autoTargetId;})[0] : null;
    return (t && !isFull(t)) ? t : null;
  }

  /* ---------- 날짜/규칙 ---------- */
  function inRange(dateStr, r){ return r && r.from && r.to && dateStr>=r.from && dateStr<=r.to; }
  function stampTypeForDate(dateStr){
    var hit = (CFG.rules||[]).find(function(r){ return inRange(dateStr, r); });
    return hit ? hit.stamp : (CFG.defaultStamp || "excellent");
  }
  function stampCountForDate(dateStr){
    return (CFG.doubleDates||[]).some(function(r){ return inRange(dateStr, r); }) ? 2 : 1;
  }
  // "2026-07-14" -> "7/14"
  function mdOf(dateStr){
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr||"");
    if(!m) return dateStr||"";
    return (parseInt(m[2],10)) + "/" + (parseInt(m[3],10));
  }

  var PICK_LEAD_MS = 2*60*60*1000; // 공연 시작 2시간 전부터 도장 가능
  function perfStart(p){ var d = new Date(p.date+"T"+(p.time||"00:00")+":00"); return isNaN(d.getTime()) ? null : d; }
  // 회차 접미사(-1/-2)용: 그 날 스케줄에 있는 회차 전부(취소 제외)를 시간순 그룹핑.
  // 관극 여부와 무관하게 '공연이 두 번 있는 날'이면 접미사를 붙인다(예: 7/17 마티네/이브닝 → 7/17-1/7/17-2).
  function seatedDayMap(){
    var m = {};
    performanceData.performances.forEach(function(p){
      if(typeof isCancelled==="function" && isCancelled(p)) return;
      (m[p.date] = m[p.date]||[]).push(p);
    });
    return m;
  }
  // "7/14" (같은 날 회차가 둘 이상이면 시간순 -1/-2)
  function labelOf(p, dm){
    dm = dm || seatedDayMap();
    var list = dm[p.date] || [];
    var label = mdOf(p.date);
    if(list.length > 1){ var i = list.indexOf(p); label += "-" + (i>=0?i+1:1); }
    return label;
  }
  function mapEntry(p, dm){ return { sid:p.sid, date:p.date, time:p.time, dateLabel:labelOf(p, dm) }; }

  // 관극(좌석 + 공연 시작 2시간 전부터) 회차 — 자동·집계용.
  // 종료(isEnded)가 아니라 isPickable(수동 픽과 동일 기준)을 써서, 공연 시작 2시간 전부터
  // 자동 도장 대상이 되게 한다.
  function watchedList(){
    if(!dataReady()) return [];
    var dm = seatedDayMap();
    return performanceData.performances.filter(isPickable).map(function(p){ return mapEntry(p, dm); });
  }
  // 공연 선택 팝오버용 — 좌석이 있고 공연 시작 2시간 전부터.
  function isPickable(p){
    if(typeof hasSeat==="function" && !hasSeat(p)) return false;
    var s = perfStart(p);
    return !!s && (Date.now() >= s.getTime() - PICK_LEAD_MS);
  }
  function pickableList(){
    if(!dataReady()) return [];
    var dm = seatedDayMap();
    return performanceData.performances.filter(isPickable).map(function(p){ return mapEntry(p, dm); });
  }

  function stampedSids(){
    var set = new Set();
    st.boards.forEach(function(b){ b.slots.forEach(function(s){ if(s && s.sid) set.add(s.sid); }); });
    return set;
  }

  /* ---------- 자동 도장 ---------- */
  var _autoAdded = 0;
  function autoStamp(){
    var target = validTarget();
    if(!target){ toast("자동으로 채울 재관카드를 오토(A) 아이콘으로 먼저 선택하세요."); return; }
    var done = stampedSids();
    var list = watchedList().filter(function(w){ return !done.has(w.sid); }); // 오래된 순
    if(!list.length){ toast("새로 찍을 관극 기록이 없습니다. (이미 모두 도장 완료)"); return; }
    // 도장 하나 단위로 펼침(더블데이는 2개)
    var pending = [];
    list.forEach(function(w){
      var type = stampTypeForDate(w.date), cnt = stampCountForDate(w.date);
      for(var k=0;k<cnt;k++) pending.push({ stamp:type, date:w.dateLabel, sid:w.sid });
    });
    _autoAdded = 0;
    continueAutoFill(target, pending);
  }
  // fillBoard를 채우고, 남으면 팝오버로 이어갈 재관카드(새로 만들기/남은 카드)를 고르게 한다.
  function continueAutoFill(fillBoard, pending){
    while(pending.length && !isFull(fillBoard)){
      var e = pending.shift();
      var i = fillBoard.slots.findIndex(function(s){ return !s; });
      fillBoard.slots[i] = e;
      _autoAdded++;
    }
    if(isFull(fillBoard)) fillBoard.open = false;
    saveState(); render();
    if(!pending.length){ toast(_autoAdded + "개의 도장을 찍었습니다."); return; }
    // 아직 남음 → 이어갈 곳 선택
    var others = st.boards.filter(function(x){ return !isFull(x); });
    if(!others.length){
      var nb = newBoard(); st.autoTargetId = nb.id;
      continueAutoFill(nb, pending);
      return;
    }
    showContinuePopover(pending, others);
  }
  // 자동 채우기 이어가기 팝오버: 새로 만들기 + 공간 남은 재관카드 목록
  function showContinuePopover(pending, others){
    closePop();
    var anchor = document.getElementById("stampAutoBtn") || document.getElementById("stampBoards");
    others.sort(function(a,c){ return st.boards.indexOf(a) - st.boards.indexOf(c); });
    var rows = '<button class="stamp-cont-btn new" data-cont="__new__">새 재관카드</button>';
    others.forEach(function(b){
      var filled = b.slots.filter(Boolean).length;
      rows += '<button class="stamp-cont-btn" data-cont="'+esc(b.id)+'">'+ esc(boardTitle(b, st.boards.indexOf(b))) +' <span class="cont-left">('+filled+'/'+slotCount()+')</span></button>';
    });
    var pop = document.createElement("div"); pop.className = "stamp-pop stamp-pop-cont";
    pop.innerHTML =
      '<div class="stamp-pop-h">도장을 다 찍었어요 · 이어 찍을 재관카드 <span class="cont-rem">남은 도장 '+pending.length+'개</span></div>' +
      '<div class="stamp-cont-list">'+ rows +'</div>' +
      '<div class="stamp-pop-actions"><button class="stamp-btn" data-cont="__stop__">그만두기</button></div>';
    document.body.appendChild(pop); positionPop(pop, anchor);
    pop.querySelectorAll("[data-cont]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var v = btn.dataset.cont;
        closePop();
        if(v==="__stop__"){ toast(_autoAdded + "개의 도장을 찍었습니다."); return; }
        var board;
        if(v==="__new__"){ board = newBoard(); }
        else { board = st.boards.filter(function(x){ return x.id===v; })[0]; }
        if(!board) return;
        st.autoTargetId = board.id;
        continueAutoFill(board, pending);
      });
    });
  }

  /* ---------- 렌더 ---------- */
  var root, boardsEl;
  function ensureDom(){
    root = document.getElementById("page-stamp");
    if(!root) return false;
    boardsEl = document.getElementById("stampBoards");
    return true;
  }

  function render(){
    if(!ensureDom()) return;
    if(!CFG){ loadConfig().then(render); return; }
    if(!st) loadState();
    // 도장판이 하나도 없으면 빈 도장판 하나로 시작
    if(!st.boards.length) newBoard();
    migrateNames();  // 이름 없던 옛 도장판에 명시적 이름 부여(기본 이름 유지 폐지)

    boardsEl.innerHTML = "";
    // 새로 만든 도장판이 위로 오도록 역순 표시(번호/이름은 생성 순서 idx 유지)
    for(var idx=st.boards.length-1; idx>=0; idx--){
      boardsEl.appendChild(renderCard(st.boards[idx], idx));
    }
    updateAutoInfo();
  }

  function updateAutoInfo(){
    var el = document.getElementById("stampAutoInfo");
    if(!el) return;
    var list = watchedList();
    var done = stampedSids();
    var remain = 0, extra = 0;
    list.forEach(function(w){ if(!done.has(w.sid)){ remain++; extra += (stampCountForDate(w.date)-1); } });
    var tgt = validTarget();
    var tgtName = tgt ? boardTitle(tgt, st.boards.indexOf(tgt)) : "없음";
    el.textContent = "관극 " + list.length + "회 · 안 찍은 회차 " + remain + (extra? " (+더블 "+extra+")" : "") + " · 자동 대상: " + tgtName;
    // 유효한 대상이 없으면 '자동 채우기' 버튼 비활성
    var ab = document.getElementById("stampAutoBtn");
    if(ab) ab.disabled = !tgt;
  }

  // 커버(스프링)에 오버레이하는 동그란 아이콘들
  var IC = {
    auto:  '<svg viewBox="0 0 24 24"><path d="M12 6v3l4-4-4-4v3c-4.42 0-8 3.58-8 8 0 1.57.46 3.03 1.24 4.26L6.7 14.8c-.45-.83-.7-1.79-.7-2.8 0-3.31 2.69-6 6-6zm6.76 1.74L17.3 9.2c.44.84.7 1.79.7 2.8 0 3.31-2.69 6-6 6v-3l-4 4 4 4v-3c4.42 0 8-3.58 8-8 0-1.57-.46-3.03-1.24-4.26z"/><text x="12" y="15" text-anchor="middle" font-size="9" font-weight="900" stroke="none">A</text></svg>',
    pencil:'<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    eraser:'<svg viewBox="0 0 24 24"><path d="M15.14 3.5a2 2 0 0 1 2.83 0l2.53 2.53a2 2 0 0 1 0 2.83L12.7 17.7H21v2H8.5l-4.98-4.98a2 2 0 0 1 0-2.83L15.14 3.5zm-.7 2.83L6.36 14.4l3.24 3.24 8.08-8.08-3.24-3.24z"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
  };
  // 오토(A) 아이콘: 자동 채우기 대상. 빈칸 있을 때만 선택 가능, 꽉 차면 비활성.
  function coverIcons(b, idx){
    var full = isFull(b);
    var isTgt = st.autoTargetId===b.id;
    return '<div class="stamp-icons">' +
      '<button class="stamp-ic auto'+(isTgt?' active':'')+(full?' disabled':'')+'" data-act="autotarget"'+(full?' disabled':'')+' title="자동 채우기 대상">'+IC.auto+'</button>' +
      '<button class="stamp-ic" data-act="rename" title="이름 변경">'+IC.pencil+'</button>' +
      '<button class="stamp-ic" data-act="clear" title="비우기">'+IC.eraser+'</button>' +
      '<button class="stamp-ic ghost" data-act="delete" title="삭제">'+IC.trash+'</button>' +
    '</div>';
  }

  function escapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function numOr(v, d){ return (typeof v==="number") ? v : d; }
  // 표지 위 이름 표시(위치·색·기울기 등 표현값은 stamp.json의 cover 설정에서 온다):
  //  - 기본 제목 그대로('Billy's Diary')면 이미지에 이미 있으므로 아무것도 안 붙임
  //  - '기본제목 #숫자' 형태(자동 #n이든 직접 그렇게 지었든)면 'Billy's Diary' 옆에 #숫자만 (스크립트에 맞춰 기울임)
  //  - 그 외 직접 지은 이름이면 스케치북 흰 도화지 오른쪽 아래에 전체 이름
  function coverNameOverlay(b, idx){
    var cv = CFG.cover || {};
    var base = ((cv.baseTitle!=null ? cv.baseTitle : CFG.title) || "").trim();
    var name = boardTitle(b, idx).trim();     // 표시용 실제 제목(이름 없으면 기본/기본+#n)
    if(base && name === base) return "";
    var m = base ? new RegExp("^"+escapeRe(base)+"\\s*#\\s*(\\d+)$").exec(name) : null;
    if(m){
      var n = cv.num || {};
      var s = "left:"+numOr(n.x,70)+"%;top:"+numOr(n.y,62)+"%;"+
              "font-size:"+numOr(n.size,8.5)+"cqi;"+
              "color:"+(n.color||"#a43233")+";"+
              (n.font ? "font-family:'"+String(n.font).replace(/['"\\;]/g,"")+"';" : "")+
              "font-style:"+(n.italic===false?"normal":"italic")+";"+
              // dx/dy(글꼴 em)로 미세 이동. translateY(-50%)로 세로 가운데 정렬 후 dy만큼 추가 이동.
              "transform:translate("+numOr(n.dx,0)+"em,0) translateY(-50%) translateY("+numOr(n.dy,0)+"em) rotate("+numOr(n.rotate,-6)+"deg);";
      return '<div class="stamp-cover-num" style="'+s+'">#'+ esc(m[1]) +'</div>';
    }
    var nm = cv.name || {};
    var s2 = "right:"+numOr(nm.right,9)+"%;bottom:"+numOr(nm.bottom,15)+"%;"+
             "max-width:"+numOr(nm.maxWidth,58)+"%;"+
             "font-size:"+numOr(nm.size,4.8)+"cqi;"+
             "color:"+(nm.color||"#1b1b19")+";"+
             "font-style:"+(nm.italic===false?"normal":"italic")+";"+
             // dx/dy는 글꼴 크기(em) 기준 이동
             "transform:translate("+numOr(nm.dx,0)+"em,"+numOr(nm.dy,0)+"em) rotate("+numOr(nm.rotate,0)+"deg);";
    return '<div class="stamp-cover-name" style="'+s2+'">'+ esc(name) +'</div>';
  }

  // 카드: 표지(항상) + 하단 버튼 + (펼침 시) 도장판 표. 표지를 누르면 아래 도장판을 펼치고/접는다.
  function renderCard(b, idx){
    var card = document.createElement("div");
    card.setAttribute("data-id", b.id);
    var pad = (CFG.coverAspect[1]/CFG.coverAspect[0]*100).toFixed(3);
    var img = imgUrl(CFG.coverImage);
    var filled = b.slots.filter(Boolean).length;
    card.className = "stamp-card" + (b.open ? " open" : "");
    card.innerHTML =
      '<div class="stamp-imgbox stamp-cover-box" style="padding-top:'+pad+'%" title="'+(b.open?'접기':'펼치기')+'">' +
        (img? '<img class="stamp-img" draggable="false" src="'+esc(img)+'" alt="'+esc(boardTitle(b,idx))+'">':'') +
        coverIcons(b, idx) +
        '<div class="stamp-cover-count">'+ filled +'/'+ slotCount() +'</div>' +
        coverNameOverlay(b, idx) +
      '</div>' +
      (b.open ? boardBodyHtml(b, idx) : '');
    wireCard(card, b, idx);
    return card;
  }

  // 도장판 표(이미지 위에 도장/날짜 오버레이). 선물 칸 없음.
  function boardBodyHtml(b, idx){
    var pad = (CFG.boardAspect[1]/CFG.boardAspect[0]*100).toFixed(3);
    var img = imgUrl(CFG.boardImage);
    var g = CFG.grid;
    var ov = "";
    for(var i=0;i<slotCount();i++){
      var cy = (g.rowTop + (i+0.5)*g.rowH)*100;
      var slot = b.slots[i];
      var checkInner = slot ? '<span class="stamp-mark '+esc(slot.stamp)+'">'+esc(stampLabel(slot.stamp))+'</span>' : '';
      ov += '<div class="stamp-cell check'+(slot?' filled':'')+'" data-row="'+i+'" data-cell="check" '+
            'style="left:'+(g.checkX*100).toFixed(2)+'%;top:'+cy.toFixed(2)+'%">'+checkInner+'</div>';
      var dayInner = slot ? ('<span class="stamp-date">'+esc(slot.date||"")+'</span>'+(slot.memo?'<span class="stamp-memo">'+esc(slot.memo)+'</span>':'')) : '';
      ov += '<div class="stamp-cell day'+(slot?' filled':'')+'" data-row="'+i+'" data-cell="day" '+
            'style="left:'+(g.dayX*100).toFixed(2)+'%;top:'+cy.toFixed(2)+'%">'+dayInner+'</div>';
    }
    return '<div class="stamp-board-wrap">' +
        '<div class="stamp-imgbox" style="padding-top:'+pad+'%">' +
          (img? '<img class="stamp-img" src="'+esc(img)+'" alt="">':'') +
          '<div class="stamp-overlay">'+ ov +'</div>' +
        '</div>' +
      '</div>';
  }

  /* ---------- 카드 이벤트 ---------- */
  function wireCard(card, b, idx){
    card.querySelectorAll("[data-act]").forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        var act = btn.dataset.act;
        if(act==="rename"){ renameBoard(b, idx); }
        else if(act==="clear"){ clearBoard(b); }
        else if(act==="delete"){ deleteBoard(b, idx); }
        else if(act==="autotarget"){ setAutoTarget(b); }
      });
    });
    // 표지 클릭 = 아래 도장판 펼치기/접기. 길게 누르면 순서 바꾸기 모드 진입. 순서 모드에선 누르면 바로 드래그.
    var cover = card.querySelector(".stamp-cover-box");
    if(cover) wireCover(cover, card, b);
    // 도장/날짜 칸 클릭 → 편집(추가/바꾸기/지우기)
    card.querySelectorAll(".stamp-cell[data-cell]").forEach(function(cell){
      cell.addEventListener("click", function(e){
        e.stopPropagation();
        var row = parseInt(cell.dataset.row,10);
        onSlotClick(b, row, cell);
      });
    });
  }

  /* ---------- 순서 바꾸기(길게 눌러 바로 드래그) ---------- */
  // 별도 '정렬 모드' 없음. 표지를 길게 누르면 그 카드를 집어 바로 드래그 → 나머지는 회색으로
  // de-highlight + 50% 축소(커버만), 위/아래로 옮겨 놓으면 그 순간 정렬 완료(놓으면 원상 복귀).
  var LONGPRESS_MS = 400, MOVE_TOL = 10;   // iOS 네이티브 롱프레스(~500ms)보다 낮춰 드래그가 먼저 이기게
  var suppressClick = false, suppressTmr = null;   // 드래그 직후의 click(열기/닫기 토글) 억제
  function wireCover(cover, card, b){
    // 드래그 후 발생하는 click은 무시(안 하면 놓을 때 open이 토글돼 닫힘/열림이 뒤집힘)
    cover.addEventListener("click", function(){
      if(suppressClick){ suppressClick = false; return; }
      if(drag) return;
      b.open = !b.open; saveState(); render();
    });
    // 모바일: 커버(이미지) 길게 누를 때 뜨는 브라우저 컨텍스트/콜아웃 메뉴 차단(이동 방해 제거)
    cover.addEventListener("contextmenu", function(e){ e.preventDefault(); });
    cover.addEventListener("pointerdown", function(ev){
      if(ev.button && ev.button!==0) return; // 마우스는 좌클릭만(터치·펜은 button 0)
      var sx = ev.clientX, sy = ev.clientY, last = { x:sx, y:sy };
      // 누르는 동안(롱프레스 대기)만 브라우저 텍스트 선택 시작을 막는다 → 선택 제스처가 드래그를
      // 가로채(pointercancel) 이동이 무산되는 것을 방지. 스크롤·포인터 이벤트엔 영향 없음.
      function noSel(e){ e.preventDefault(); }
      var tmr = setTimeout(function(){
        tmr = null; cleanup();
        startDrag(card, b.id, last.x, last.y);   // 같은 요소 → 포인터 스트림 유지(끊김 없음)
      }, LONGPRESS_MS);
      function mv(e){
        last.x = e.clientX; last.y = e.clientY;
        if(Math.abs(e.clientX-sx)>MOVE_TOL || Math.abs(e.clientY-sy)>MOVE_TOL){ cancel(); } // 스크롤/이동으로 판단 → 길게 누르기 취소
      }
      function up(){ cancel(); }
      function cancel(){ if(tmr){ clearTimeout(tmr); tmr=null; } cleanup(); }
      function cleanup(){
        document.removeEventListener("pointermove", mv, true);
        document.removeEventListener("pointerup", up, true);
        document.removeEventListener("pointercancel", up, true);
        document.removeEventListener("selectstart", noSel, true);
      }
      document.addEventListener("pointermove", mv, true);
      document.addEventListener("pointerup", up, true);
      document.addEventListener("pointercancel", up, true);
      document.addEventListener("selectstart", noSel, true);
    });
  }

  // ---- 드래그 ----
  // 핵심: 집은 카드(.dragging)를 position:fixed로 문서 흐름에서 빼 포인터를 따라 떠다니게 한다.
  //  → 흐름에 남은 나머지 카드(그리드)는 흔들리지 않아 삽입 위치 판정이 안정적(진동 없음).
  //  나머지는 .stamp-dragging에서 실제 폭 50%로 줄여(높이·여백까지 축소) 위·아래가 한눈에 보이게 한다.
  function startDrag(cardEl, id, clientX, clientY){
    if(!cardEl) return;
    endDrag();
    closePop();
    var r = cardEl.getBoundingClientRect();   // 클래스 적용 전 원래 크기
    // 컬럼이 1개(단일 열)일 때만 축소한다 — 다열(타일)은 이미 위·아래가 보이므로 원래 크기 유지.
    var shrink = isSingleColumn();
    var sc = shrink ? 0.5 : 1;
    drag = {
      el:cardEl, id:id, w:r.width, h:r.height, scale:sc,
      grabDX:(typeof clientX==="number"? clientX - r.left : r.width/2),
      grabDY:(typeof clientY==="number"? clientY - r.top  : r.height/2),
      lastClientX:(typeof clientX==="number"?clientX:r.left+r.width/2),
      lastClientY:(typeof clientY==="number"?clientY:r.top+r.height/2),
      raf:0
    };
    if(boardsEl){ boardsEl.classList.add("stamp-dragging"); if(shrink) boardsEl.classList.add("stamp-shrink"); }
    // 원래 자리(그리고 앞으로 놓일 자리)를 나타내는 테두리 placeholder 상자를 흐름에 남긴다.
    // 나머지 카드와 같은 크기(커버 비율)로, 드래그 중 새 삽입 위치로 이동하며 미리보기 역할.
    var pad = (CFG.coverAspect[1]/CFG.coverAspect[0]*100).toFixed(3);
    var ph = document.createElement("div");
    ph.className = "stamp-card stamp-ph";
    ph.innerHTML = '<div class="stamp-imgbox" style="padding-top:'+pad+'%"></div>';
    if(boardsEl) boardsEl.insertBefore(ph, cardEl);
    drag.ph = ph;
    cardEl.classList.add("dragging");
    // 흐름에서 빼서 포인터를 따라 떠다니게. 축소 모드(단일 열)면 커버도 나머지처럼 절반 크기로.
    var s = cardEl.style;
    s.position="fixed"; s.margin="0"; s.left="0"; s.top="0";
    s.width=(r.width*sc)+"px"; s.height=(r.height*sc)+"px";
    s.zIndex="1000"; s.pointerEvents="none";
    positionDragEl(drag.lastClientX, drag.lastClientY);
    document.addEventListener("pointermove", onDragMove, true);
    document.addEventListener("pointerup", onDragEnd, true);
    document.addEventListener("pointercancel", onDragEnd, true);
    drag.raf = requestAnimationFrame(autoScrollTick);
  }
  // 컨테이너가 실제로 몇 열인지(단일 열이면 축소 모드). grid-template-columns의 트랙 수로 판정.
  function isSingleColumn(){
    if(!boardsEl) return true;
    var g = getComputedStyle(boardsEl).gridTemplateColumns;
    if(!g || g==="none") return true;
    return g.split(" ").filter(Boolean).length <= 1;
  }
  function positionDragEl(x, y){
    if(!drag || !drag.el) return;
    var sc = drag.scale || 1;   // 커버가 절반 크기면 잡은 지점(offset)도 절반이라야 포인터 밑에 붙는다
    drag.el.style.transform = "translate(" + (x - drag.grabDX*sc) + "px," + (y - drag.grabDY*sc) + "px)";
  }
  function onDragMove(ev){
    if(!drag) return;
    ev.preventDefault();
    drag.lastClientX = ev.clientX; drag.lastClientY = ev.clientY;
    positionDragEl(ev.clientX, ev.clientY);
    reorderByPointer(ev.clientX, ev.clientY);
  }
  function onDragEnd(){ endDrag(); }
  function endDrag(){
    if(!drag) return;
    document.removeEventListener("pointermove", onDragMove, true);
    document.removeEventListener("pointerup", onDragEnd, true);
    document.removeEventListener("pointercancel", onDragEnd, true);
    if(drag.raf) cancelAnimationFrame(drag.raf);
    var el = drag.el, ph = drag.ph;
    // 커버를 placeholder 자리(=놓을 위치)에 넣고 placeholder 제거
    if(ph){
      if(el && ph.parentNode) ph.parentNode.insertBefore(el, ph);
      if(ph.parentNode) ph.parentNode.removeChild(ph);
    }
    if(el){
      el.classList.remove("dragging");
      var s = el.style;
      s.position=s.margin=s.left=s.top=s.width=s.height=s.zIndex=s.pointerEvents=s.transform="";
    }
    if(boardsEl){ boardsEl.classList.remove("stamp-dragging"); boardsEl.classList.remove("stamp-shrink"); }
    commitOrderFromDom();    // 놓은 위치대로 순서 저장(즉시 정렬 완료)
    drag = null;
    // 곧이어 오는 click(토글) 억제. click이 안 오는 경우 대비해 잠시 후 자동 해제.
    suppressClick = true;
    if(suppressTmr) clearTimeout(suppressTmr);
    suppressTmr = setTimeout(function(){ suppressClick = false; }, 500);
  }
  // 포인터 위치에 가장 가까운 '실제 카드'를 찾아 그 앞/뒤로 placeholder를 옮긴다(그리드 다열·단일 열 모두 대응).
  // 떠다니는 커버(drag.el)와 placeholder(drag.ph)는 판정에서 제외 → 나머지 카드 기준이라 안정적(진동 없음).
  function reorderByPointer(px, py){
    if(!drag || !drag.ph || !boardsEl) return;
    var sibs = Array.prototype.slice.call(boardsEl.children).filter(function(c){ return c!==drag.el && c!==drag.ph; });
    if(!sibs.length) return;
    var near = null, best = Infinity, i, r, cx, cy, dx, dy, d;
    for(i=0;i<sibs.length;i++){
      r = sibs[i].getBoundingClientRect();
      cx = r.left + r.width/2; cy = r.top + r.height/2;
      dx = px-cx; dy = py-cy; d = dx*dx + dy*dy;
      if(d < best){ best = d; near = { el:sibs[i], r:r, cx:cx, cy:cy }; }
    }
    if(!near) return;
    // near와 세로 범위가 겹치는 다른 카드가 있으면 다열(그리드) → 같은 행에선 좌우로, 위·아래 행이면 상하로 판정.
    // 없으면 단일 열 → 순수 상하로 판정.
    var multiCol = sibs.some(function(c){
      if(c===near.el) return false;
      var rr = c.getBoundingClientRect();
      return rr.bottom > near.r.top && rr.top < near.r.bottom;
    });
    var before;
    if(multiCol){
      if(py < near.r.top) before = true;
      else if(py > near.r.bottom) before = false;
      else before = px < near.cx;
    } else {
      before = py < near.cy;
    }
    var ref = before ? near.el : near.el.nextSibling;
    if(ref === drag.ph) return;            // 이미 그 자리 → 그대로
    if(drag.ph.nextSibling !== ref) boardsEl.insertBefore(drag.ph, ref);
  }
  // 화면(스크롤 컨테이너=.page) 가장자리 근처면 페이지도 함께 스크롤(드래그 유지한 채)
  function autoScrollTick(){
    if(!drag){ return; }
    // 스탬프 페이지는 #page-stamp(.page)가 스크롤러(window 아님)
    var sc = (root && root.scrollHeight > root.clientHeight) ? root : document.scrollingElement;
    var rect = (sc===root) ? root.getBoundingClientRect() : { top:0, bottom:window.innerHeight };
    var y = drag.lastClientY, edge = 80, step = 0;
    if(y > 0 && y < rect.top + edge) step = -Math.ceil((rect.top + edge - y)/4);
    else if(y > rect.bottom - edge) step = Math.ceil((y - (rect.bottom - edge))/4);
    if(step){
      if(sc===root) root.scrollTop += step; else window.scrollBy(0, step);
      reorderByPointer(drag.lastClientX, y);
    }
    drag.raf = requestAnimationFrame(autoScrollTick);
  }
  // 현재 DOM 순서(위→아래=최신순)를 st.boards(index 0=오래된 순, render가 역순 표시)로 반영
  function commitOrderFromDom(){
    if(!boardsEl) return;
    var ids = Array.prototype.slice.call(boardsEl.children).map(function(c){ return c.getAttribute("data-id"); });
    var byId = {}; st.boards.forEach(function(b){ byId[b.id] = b; });
    var next = ids.map(function(id){ return byId[id]; }).filter(Boolean).reverse();
    if(next.length === st.boards.length){ st.boards = next; saveState(); }
  }

  function renameBoard(b, idx){
    var name = prompt("재관카드 이름", b.name || boardTitle(b, idx));
    if(name==null) return;
    name = name.trim();
    if(!name) return;   // 빈 이름 불가 — 이름은 항상 명시적으로 유지
    b.name = name;
    saveState(); render();
  }
  function deleteBoard(b, idx){
    if(!confirm("이 재관카드를 삭제할까요? 찍힌 도장도 함께 지워집니다.")) return;
    if(st.autoTargetId===b.id) st.autoTargetId = null;
    st.boards.splice(idx,1);
    if(!st.boards.length) newBoard();
    saveState(); render();
  }
  // 자동 채우기 대상 지정(토글): 빈칸 있을 때만, 다시 누르면 해제(대상 없음=자동 비활성).
  function setAutoTarget(b){
    if(isFull(b)) return;
    st.autoTargetId = (st.autoTargetId===b.id) ? null : b.id;
    saveState(); render();
  }
  // 재관카드 비우기: 찍힌 도장만 지우고 재관카드(이름)는 유지
  function clearBoard(b){
    if(!confirm("이 재관카드의 도장을 모두 지울까요? (재관카드는 남습니다)")) return;
    b.slots = b.slots.map(function(){ return null; });
    b.open = true;
    saveState(); render();
  }
  // 모두 삭제: 모든 재관카드 삭제 후 빈 재관카드 하나로 초기화
  function clearAll(){
    if(!confirm("모든 재관카드를 지울까요? 되돌릴 수 없습니다.")) return;
    st.boards = []; st.seq = 0; st.autoTargetId = null;
    newBoard();
    saveState(); render();
  }

  /* ---------- 슬롯 클릭 ---------- */
  // 빈칸 → 공연 선택 팝오버, SID 연결 칸 → 지우기/바꾸기, 임의 칸 → 임의 입력창
  function onSlotClick(b, row, anchorEl){
    var slot = b.slots[row];
    if(!slot){ openPicker(b, row, anchorEl); return; }
    if(slot.sid){ openSidMenu(b, row, anchorEl); return; }
    openFreeEditor(b, row, anchorEl); // 임의(SID 없음) 칸 편집
  }

  // SID 연결 칸: 지우기 / 바꾸기(=다시 선택)
  function openSidMenu(b, row, anchorEl){
    closePop();
    var slot = b.slots[row];
    var pop = document.createElement("div"); pop.className = "stamp-pop";
    pop.innerHTML =
      '<div class="stamp-pop-h">'+ esc(slot.date||"") +' · '+ esc(stampLabel(slot.stamp)) +'</div>' +
      '<div class="stamp-pop-actions">' +
        '<button class="stamp-btn primary" data-m="change">바꾸기</button>' +
        '<button class="stamp-btn ghost" data-m="del">지우기</button>' +
        '<button class="stamp-btn" data-m="cancel">취소</button>' +
      '</div>';
    document.body.appendChild(pop); positionPop(pop, anchorEl);
    pop.querySelectorAll("[data-m]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var m = btn.dataset.m;
        if(m==="cancel"){ closePop(); return; }
        if(m==="del"){ b.slots[row]=null; saveState(); render(); closePop(); return; }
        if(m==="change"){ openPicker(b, row, anchorEl); return; } // 입력창(선택) 다시
      });
    });
  }

  // 공연 선택: 맨 왼쪽 '임의로 넣기'(SID 없음) + 안 찍은 회차 단추(오래된 순, 가로 스크롤)
  function openPicker(b, row, anchorEl){
    closePop();
    var done = stampedSids();
    // 공연 시작 2시간 전부터 표시. 이미 시간순(오래된 순).
    var list = pickableList().filter(function(w){ return !done.has(w.sid); });
    var pop = document.createElement("div"); pop.className = "stamp-pop stamp-pop-pick";
    var btns = '<button class="stamp-pick-btn arb" data-pick="arb">임의로 넣기</button>';
    list.forEach(function(w){
      var hc = (stampTypeForDate(w.date)==="homecoming");
      btns += '<button class="stamp-pick-btn'+(hc?' hc':'')+'" data-sid="'+esc(w.sid)+'" data-date="'+esc(w.dateLabel)+'">'+esc(w.dateLabel)+'</button>';
    });
    pop.innerHTML =
      '<div class="stamp-pop-h">공연 선택'+ (list.length? '' : ' (안 찍은 회차 없음)') +'</div>' +
      '<div class="stamp-pick-row">'+ btns +'</div>';
    document.body.appendChild(pop); positionPop(pop, anchorEl);
    pop.querySelector('[data-pick="arb"]').addEventListener("click", function(){ openFreeEditor(b, row, anchorEl); });
    pop.querySelectorAll("[data-sid]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var sid = btn.dataset.sid, date = btn.dataset.date;
        var w = pickableList().filter(function(x){ return x.sid===sid; })[0];
        var type = w ? stampTypeForDate(w.date) : (CFG.defaultStamp||"excellent");
        b.slots[row] = { stamp:type, date:date, sid:sid };
        saveState(); render(); closePop();
      });
    });
  }

  // 임의로 넣기(SID 관리 안 함): 도장 종류 + 날짜 + 메모
  function openFreeEditor(b, row, anchorEl){
    closePop();
    var slot = b.slots[row];
    var arb = slot && !slot.sid;   // 기존 임의 칸 편집이면 값 채움
    var pop = document.createElement("div"); pop.className = "stamp-pop";
    pop.innerHTML =
      '<div class="stamp-pop-h">임의로 넣기</div>' +
      stampTypeButtons(arb ? slot.stamp : CFG.defaultStamp) +
      '<label class="stamp-pop-field">날짜 <input type="text" class="sp-date" value="'+esc(arb?(slot.date||""):"")+'" placeholder="7/14"></label>' +
      '<label class="stamp-pop-field">메모 <input type="text" class="sp-memo" value="'+esc(arb?(slot.memo||""):"")+'" placeholder="(선택)"></label>' +
      '<div class="stamp-pop-actions">' +
        '<button class="stamp-btn primary" data-sp="save">'+(arb?"바꾸기":"넣기")+'</button>' +
        (slot?'<button class="stamp-btn ghost" data-sp="del">지우기</button>':'') +
        '<button class="stamp-btn" data-sp="cancel">취소</button>' +
      '</div>';
    document.body.appendChild(pop); positionPop(pop, anchorEl);
    var chosen = { stamp: arb ? slot.stamp : (CFG.defaultStamp||"excellent") };
    pop.querySelectorAll("[data-st]").forEach(function(btn){
      btn.addEventListener("click", function(){
        chosen.stamp = btn.dataset.st;
        pop.querySelectorAll("[data-st]").forEach(function(x){ x.classList.toggle("active", x===btn); });
      });
    });
    pop.querySelectorAll("[data-sp]").forEach(function(btn){
      btn.addEventListener("click", function(){
        var act = btn.dataset.sp;
        if(act==="cancel"){ closePop(); return; }
        if(act==="del"){ b.slots[row]=null; saveState(); render(); closePop(); return; }
        if(act==="save"){
          var date = pop.querySelector(".sp-date").value.trim();
          var memo = pop.querySelector(".sp-memo").value.trim();
          b.slots[row] = { stamp:chosen.stamp, date:date, memo:memo }; // SID 없음
          saveState(); render(); closePop();
        }
      });
    });
  }
  function stampTypeButtons(active){
    var s = '<div class="stamp-type-row">';
    (CFG.stampTypes||[]).forEach(function(t){
      s += '<button class="stamp-type-btn '+esc(t.id)+(t.id===active?' active':'')+'" data-st="'+esc(t.id)+'">'+esc(t.label)+'</button>';
    });
    return s + '</div>';
  }

  var curPop = null, curDocDown = null;
  function closePop(){
    if(curDocDown){ document.removeEventListener("mousedown", curDocDown, true); curDocDown=null; }
    if(curPop && curPop.parentNode) curPop.parentNode.removeChild(curPop);
    curPop=null;
  }
  function positionPop(pop, anchorEl){
    curPop = pop;
    var r = anchorEl.getBoundingClientRect();
    var w = pop.offsetWidth || 260;
    pop.style.position = "fixed";
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth-w-8)) + "px";
    pop.style.top = Math.min(r.bottom+6, window.innerHeight-10) + "px";
    curDocDown = function(e){ if(!pop.contains(e.target)) closePop(); };
    setTimeout(function(){ document.addEventListener("mousedown", curDocDown, true); },0);
  }

  /* ---------- 간단 토스트 ---------- */
  var toastEl = null, toastTmr = null;
  function toast(msg){
    if(!toastEl){
      toastEl = document.createElement("div");
      toastEl.className = "stamp-toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTmr);
    toastTmr = setTimeout(function(){ toastEl.classList.remove("show"); }, 2200);
  }

  /* ---------- 페이지 활성화 (개발용 앵커/쿼리 게이트) ---------- */
  function wantStamp(){
    if(location.hash === "#stamp") return true;
    return /(?:^|[?&])stamp(?:=|&|$)/.test(location.search);
  }
  function showPage(){
    var pg = document.getElementById("page-stamp");
    if(!pg) return;
    // 상시 탭이 있으므로 app.js activateTab으로 전환(탭 하이라이트 포함). 없으면 직접 토글.
    if(typeof window.activateTab === "function" && document.querySelector('.tab-btn[data-page="stamp"]')){
      window.activateTab("stamp", false);
    } else {
      document.querySelectorAll(".tab-btn").forEach(function(b){ b.classList.remove("active"); });
      document.querySelectorAll(".page").forEach(function(p){ p.classList.remove("active"); });
      pg.classList.add("active");
    }
    if(dataReady()){ render(); }
    else { pendingActivate = true; waitForData(); }
  }
  var waitTmr = null;
  function waitForData(){
    if(waitTmr) return;
    waitTmr = setInterval(function(){
      if(dataReady()){
        clearInterval(waitTmr); waitTmr=null;
        if(pendingActivate){ pendingActivate=false; render(); }
      }
    }, 120);
  }

  /* ---------- 초기화 ---------- */
  function init(){
    if(booted) return; booted = true;
    // 툴바 버튼
    var autoBtn = document.getElementById("stampAutoBtn");
    if(autoBtn) autoBtn.addEventListener("click", function(){
      if(!dataReady()){ toast("공연 데이터를 불러오는 중입니다. 잠시 후 다시 눌러주세요."); waitForData(); return; }
      ensureCfgState().then(autoStamp);
    });
    var addBtn = document.getElementById("stampNewBtn");
    if(addBtn) addBtn.addEventListener("click", function(){ ensureCfgState().then(function(){ newBoard(); saveState(); render(); }); });
    var clearAllBtn = document.getElementById("stampClearAllBtn");
    if(clearAllBtn) clearAllBtn.addEventListener("click", function(){ ensureCfgState().then(clearAll); });

    window.addEventListener("hashchange", function(){ if(wantStamp()) showPage(); });
    if(wantStamp()) showPage();
  }
  function ensureCfgState(){
    return loadConfig().then(function(){ if(!st) loadState(); });
  }

  // app.js가 (혹시) 탭으로 승격할 경우를 대비해 렌더 훅도 노출
  window.renderStamp = function(){ ensureCfgState().then(render); };
  window.showStampPage = showPage;

  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded", init);
  else init();

})();
