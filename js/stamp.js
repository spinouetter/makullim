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

  function loadConfig(){
    if(CFG) return Promise.resolve(CFG);
    if(cfgPromise) return cfgPromise;
    var url = (typeof showUrl==="function") ? showUrl("stamp.json?v=2") : "stamp.json";
    cfgPromise = fetch(url).then(function(r){ if(!r.ok) throw new Error("no stamp.json"); return r.json(); })
      .then(function(j){ CFG = normalizeCfg(j); return CFG; })
      .catch(function(){ CFG = normalizeCfg(null); return CFG; });
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
  function boardTitle(b, idx){
    if(b.name && b.name.trim()) return b.name.trim();
    var base = CFG.title || "Diary";
    return idx===0 ? base : (base + " #" + (idx+1));
  }
  function slotCount(){ return CFG ? CFG.slots : 10; }
  function isFull(b){ return b.slots.filter(Boolean).length >= slotCount(); }

  /* ---------- 도장 배치 로직 ---------- */
  function newBoard(){
    var b = normalizeBoard({ id:"b"+(++st.seq), name:"", open:true, slots:[], gifts:{}, autoFill:true });
    st.boards.push(b);
    return b;
  }
  function newBoardAsTarget(){ var nb = newBoard(); st.autoTargetId = nb.id; return nb; }
  // 자동이 채울 대상 도장판을 고른다.
  //  - 지정된 기본 도장판(autoTargetId)이 있고 자동채움 on이면 그걸 쓴다(꽉 차 있으면 새로 만든다).
  //  - 지정이 없으면 자동채움 on이면서 안 찬 최신 도장판을 쓴다.
  //  - 그래도 없으면(모두 꽉 참/자동 제외) 새 도장판을 만든다. 자동 제외 도장판에는 절대 채우지 않는다.
  function autoTargetBoard(){
    var t = st.autoTargetId ? st.boards.filter(function(b){return b.id===st.autoTargetId;})[0] : null;
    if(t && t.autoFill!==false){
      if(!isFull(t)) return t;
      return newBoardAsTarget();          // 대상이 꽉 참 → 새 도장판(다른 판으로 넘기지 않음)
    }
    for(var i=st.boards.length-1;i>=0;i--){
      var b = st.boards[i];
      if(b.autoFill!==false && !isFull(b)) return b;
    }
    return newBoardAsTarget();
  }
  // 도장을 하나 찍는다: 자동 대상 도장판의 다음 빈칸 → 꽉 차면 새 도장판.
  function placeStamp(entry){
    var b = autoTargetBoard();
    var i = b.slots.findIndex(function(s){ return !s; });
    if(i < 0){ b = newBoardAsTarget(); i = 0; }
    b.slots[i] = entry;
    // 방금 채워서 10칸이 다 찼으면 자동으로 닫는다(표지 상태)
    if(isFull(b)) b.open = false;
    return b;
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
  // 좌석이 있는 회차를 날짜별로 시간순 그룹핑(회차 접미사 -1/-2 계산용, 종료 여부와 무관해 라벨이 안정적).
  function seatedDayMap(){
    var m = {};
    performanceData.performances.forEach(function(p){
      if(typeof hasSeat==="function" && !hasSeat(p)) return;
      (m[p.date] = m[p.date]||[]).push(p);
    });
    return m;
  }
  // "7/14" (같은 날 좌석 회차가 둘 이상이면 -1/-2)
  function labelOf(p, dm){
    dm = dm || seatedDayMap();
    var list = dm[p.date] || [];
    var label = mdOf(p.date);
    if(list.length > 1){ var i = list.indexOf(p); label += "-" + (i>=0?i+1:1); }
    return label;
  }
  function mapEntry(p, dm){ return { sid:p.sid, date:p.date, time:p.time, dateLabel:labelOf(p, dm) }; }

  // 관극(종료+좌석) 회차 — 자동·집계용.
  function watchedList(){
    if(!dataReady()) return [];
    var dm = seatedDayMap();
    return performanceData.performances.filter(function(p){
      return (typeof isEnded!=="function"||isEnded(p)) && (typeof hasSeat!=="function"||hasSeat(p));
    }).map(function(p){ return mapEntry(p, dm); });
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
  function autoStamp(){
    var list = watchedList();
    if(!list.length){ toast("관극(종료·좌석 입력)한 공연이 없습니다."); return; }
    var done = stampedSids();
    var added = 0;
    list.forEach(function(w){
      if(done.has(w.sid)) return;
      var type = stampTypeForDate(w.date);
      var cnt = stampCountForDate(w.date);
      for(var k=0;k<cnt;k++){
        placeStamp({ stamp:type, date:w.dateLabel, sid:w.sid });
        added++;
      }
      done.add(w.sid);
    });
    if(!added){ toast("새로 찍을 관극 기록이 없습니다. (이미 모두 도장 완료)"); return; }
    saveState(); render();
    toast(added + "개의 도장을 찍었습니다.");
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

    boardsEl.innerHTML = "";
    // 새로 만든 도장판이 위로 오도록 역순 표시(번호/이름은 생성 순서 idx 유지)
    for(var idx=st.boards.length-1; idx>=0; idx--){
      var b = st.boards[idx];
      boardsEl.appendChild(b.open ? renderOpenBoard(b, idx) : renderCover(b, idx));
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
    var tgt = st.autoTargetId ? st.boards.filter(function(b){return b.id===st.autoTargetId;})[0] : null;
    var tgtName = tgt ? boardTitle(tgt, st.boards.indexOf(tgt)) : "최신 도장판";
    el.textContent = "관극 " + list.length + "회 · 안 찍은 회차 " + remain + (extra? " (+더블 "+extra+")" : "") + " · 자동 대상: " + tgtName;
  }

  // 자동 대상/자동 제외 배지 — 꽉 찬 도장판은 자동 대상이 될 수 없어 숨김
  function boardBadge(b){
    if(isFull(b)) return '';
    if(st.autoTargetId===b.id) return '<span class="stamp-badge tgt">자동 대상</span>';
    if(b.autoFill===false) return '<span class="stamp-badge off">자동 제외</span>';
    return '';
  }
  // 자동 대상 지정 · 자동 채움 on/off 버튼 — 꽉 찬 도장판에는 자동 메뉴를 숨긴다
  function boardCtlHtml(b){
    if(isFull(b)) return '';
    var isTarget = st.autoTargetId===b.id;
    var autoOff = b.autoFill===false;
    return '<button class="stamp-btn tgt'+(isTarget?' active':'')+'" data-act="autotarget" title="자동이 이 도장판부터 채웁니다">자동 대상</button>' +
           '<button class="stamp-btn'+(autoOff?' off':'')+'" data-act="autofill" title="끄면 이 도장판은 자동에서 제외됩니다">'+(autoOff?'자동 채움: 끔':'자동 채움: 켬')+'</button>';
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
              "font-style:"+(n.italic===false?"normal":"italic")+";"+
              "transform:translateY(-50%) rotate("+numOr(n.rotate,-6)+"deg);";
      return '<div class="stamp-cover-num" style="'+s+'">#'+ esc(m[1]) +'</div>';
    }
    var nm = cv.name || {};
    var s2 = "right:"+numOr(nm.right,9)+"%;bottom:"+numOr(nm.bottom,15)+"%;"+
             "max-width:"+numOr(nm.maxWidth,58)+"%;"+
             "font-size:"+numOr(nm.size,6)+"cqi;"+
             "color:"+(nm.color||"#1b1b19")+";"+
             "font-style:"+(nm.italic===false?"normal":"italic")+";"+
             "transform:rotate("+numOr(nm.rotate,-6)+"deg);";
    return '<div class="stamp-cover-name" style="'+s2+'">'+ esc(name) +'</div>';
  }

  // 닫힌 도장판(표지) — 제공된 표지 이미지를 그대로 사용
  function renderCover(b, idx){
    var card = document.createElement("div");
    card.className = "stamp-card stamp-cover";
    var pad = (CFG.coverAspect[1]/CFG.coverAspect[0]*100).toFixed(3);
    var img = CFG.coverImage ? (typeof showUrl==="function"?showUrl(CFG.coverImage):CFG.coverImage) : "";
    var filled = b.slots.filter(Boolean).length;
    card.innerHTML =
      '<div class="stamp-imgbox" style="padding-top:'+pad+'%">' +
        (img? '<img class="stamp-img" src="'+esc(img)+'" alt="'+esc(boardTitle(b,idx))+'">':'') +
        '<div class="stamp-cover-count">'+ filled +'/'+ slotCount() +'</div>' +
        coverNameOverlay(b, idx) +
      '</div>' +
      '<div class="stamp-card-foot">' +
        '<div class="stamp-card-name">'+ boardBadge(b) +'</div>' +
        '<button class="stamp-btn" data-act="open">열기</button>' +
        boardCtlHtml(b) +
        '<button class="stamp-btn" data-act="rename">이름 변경</button>' +
        '<button class="stamp-btn" data-act="clear">비우기</button>' +
        '<button class="stamp-btn ghost" data-act="delete">삭제</button>' +
      '</div>';
    wireCard(card, b, idx);
    return card;
  }

  // 펼친 도장판 — 도장판 이미지 위에 도장/날짜/선물체크를 오버레이
  function renderOpenBoard(b, idx){
    var card = document.createElement("div");
    card.className = "stamp-card stamp-open";
    var pad = (CFG.boardAspect[1]/CFG.boardAspect[0]*100).toFixed(3);
    var img = CFG.boardImage ? (typeof showUrl==="function"?showUrl(CFG.boardImage):CFG.boardImage) : "";
    var g = CFG.grid;
    var gp = CFG.giftPos || {};
    var ov = "";
    for(var i=0;i<slotCount();i++){
      var n = i+1;
      var top = (g.rowTop + i*g.rowH)*100;
      var h = g.rowH*100;
      var cy = top + h/2;
      var slot = b.slots[i];
      var gift = isGiftRow(n) ? gp[String(n)] : null;   // [x,y] 이미지 비율
      // CHECK 칸(도장)
      var checkInner = slot ? '<span class="stamp-mark '+esc(slot.stamp)+'">'+esc(stampLabel(slot.stamp))+'</span>' : '';
      ov += '<div class="stamp-cell check'+(slot?' filled':'')+'" data-row="'+i+'" data-cell="check" '+
            'style="left:'+(g.checkX*100).toFixed(2)+'%;top:'+cy.toFixed(2)+'%">'+checkInner+'</div>';
      // DAY 칸(날짜) — 선물 있는 행은 선물 반대쪽(위/아래)에 날짜를 둔다
      var dayY = cy;
      if(gift){ dayY = (gift[1]*100 > cy) ? (cy - h*0.22) : (cy + h*0.18); }
      var dayInner = slot ? ('<span class="stamp-date">'+esc(slot.date||"")+'</span>'+(slot.memo?'<span class="stamp-memo">'+esc(slot.memo)+'</span>':'')) : '';
      ov += '<div class="stamp-cell day'+(slot?' filled':'')+'" data-row="'+i+'" data-cell="day" '+
            'style="left:'+(g.dayX*100).toFixed(2)+'%;top:'+dayY.toFixed(2)+'%">'+dayInner+'</div>';
      // 선물 체크(3·7·10) — 이미지에 그려진 □ 위에 ✓ 토글
      if(gift){
        ov += '<div class="stamp-gift'+(b.gifts[String(n)]?' on':'')+'" data-gift="'+n+'" '+
              'style="left:'+(gift[0]*100).toFixed(2)+'%;top:'+(gift[1]*100).toFixed(2)+'%">✓</div>';
      }
    }
    card.innerHTML =
      '<div class="stamp-open-head">' +
        '<div class="stamp-open-title">'+ esc(boardTitle(b, idx)) + boardBadge(b) +'</div>' +
        '<div class="stamp-open-actions">' +
          boardCtlHtml(b) +
          '<button class="stamp-btn" data-act="rename">이름 변경</button>' +
          '<button class="stamp-btn" data-act="close">닫기</button>' +
          '<button class="stamp-btn" data-act="clear">비우기</button>' +
          '<button class="stamp-btn ghost" data-act="delete">삭제</button>' +
        '</div>' +
      '</div>' +
      '<div class="stamp-imgbox" style="padding-top:'+pad+'%">' +
        (img? '<img class="stamp-img" src="'+esc(img)+'" alt="">':'') +
        '<div class="stamp-overlay">'+ ov +'</div>' +
      '</div>';
    wireCard(card, b, idx);
    return card;
  }

  /* ---------- 카드 이벤트 ---------- */
  function wireCard(card, b, idx){
    card.querySelectorAll("[data-act]").forEach(function(btn){
      btn.addEventListener("click", function(e){
        e.stopPropagation();
        var act = btn.dataset.act;
        if(act==="open"){ b.open = true; saveState(); render(); }
        else if(act==="close"){ b.open = false; saveState(); render(); }
        else if(act==="rename"){ renameBoard(b, idx); }
        else if(act==="clear"){ clearBoard(b); }
        else if(act==="delete"){ deleteBoard(b, idx); }
        else if(act==="autotarget"){ setAutoTarget(b); }
        else if(act==="autofill"){ toggleAutoFill(b); }
      });
    });
    // 표지 클릭(이미지 영역) = 열기
    var imgbox = card.classList.contains("stamp-cover") ? card.querySelector(".stamp-imgbox") : null;
    if(imgbox){ imgbox.addEventListener("click", function(){ b.open = true; saveState(); render(); }); }
    // 선물 체크(오버레이 ✓ 토글)
    card.querySelectorAll(".stamp-gift[data-gift]").forEach(function(el){
      el.addEventListener("click", function(e){
        e.stopPropagation();
        var n = el.dataset.gift;
        b.gifts[n] = !b.gifts[n];
        el.classList.toggle("on", b.gifts[n]);
        saveState();
      });
    });
    // 도장/날짜 칸 클릭 → 편집(추가/바꾸기/지우기)
    card.querySelectorAll(".stamp-cell[data-cell]").forEach(function(cell){
      cell.addEventListener("click", function(e){
        e.stopPropagation();
        var row = parseInt(cell.dataset.row,10);
        onSlotClick(b, row, cell);
      });
    });
  }

  function renameBoard(b, idx){
    // 기본 이름(#n) 도장판은 빈 칸으로 열어, 그냥 확인만 눌러도 타이틀로 굳지 않게 한다.
    var name = prompt("도장판 이름 (비우면 기본 이름 유지)", b.name || "");
    if(name==null) return;
    b.name = name.trim();
    saveState(); render();
  }
  function deleteBoard(b, idx){
    if(!confirm("이 도장판을 삭제할까요? 찍힌 도장도 함께 지워집니다.")) return;
    if(st.autoTargetId===b.id) st.autoTargetId = null;
    st.boards.splice(idx,1);
    if(!st.boards.length) newBoard();
    saveState(); render();
  }
  // 자동 대상 지정(토글): 다시 누르면 지정 해제(기본=최신 도장판)
  function setAutoTarget(b){
    if(st.autoTargetId===b.id){ st.autoTargetId = null; }
    else { st.autoTargetId = b.id; b.autoFill = true; } // 대상은 자동 채움 on이어야 함
    saveState(); render();
  }
  // 자동 채움 on/off. 끄면 자동에서 제외되고, 대상이었다면 지정 해제.
  function toggleAutoFill(b){
    b.autoFill = (b.autoFill===false);
    if(b.autoFill===false && st.autoTargetId===b.id) st.autoTargetId = null;
    saveState(); render();
  }
  // 도장판 비우기: 찍힌 도장·선물 체크만 지우고 도장판(이름)은 유지
  function clearBoard(b){
    if(!confirm("이 도장판의 도장·선물 체크를 모두 지울까요? (도장판은 남습니다)")) return;
    b.slots = b.slots.map(function(){ return null; });
    b.gifts = {};
    b.open = true;
    saveState(); render();
  }
  // 전체 지우기: 모든 도장판 삭제 후 빈 도장판 하나로 초기화
  function clearAll(){
    if(!confirm("모든 도장판을 지울까요? 되돌릴 수 없습니다.")) return;
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

  /* ---------- "다른 도장 찍기" (임의 날짜 + 메모) ---------- */
  function openArbitraryStamp(anchorEl){
    closePop();
    var pop = document.createElement("div");
    pop.className = "stamp-pop";
    pop.innerHTML =
      '<div class="stamp-pop-h">다른 도장 찍기</div>' +
      stampTypeButtons(CFG.defaultStamp) +
      '<label class="stamp-pop-field">날짜 <input type="text" class="sp-date" value="" placeholder="7/14"></label>' +
      '<label class="stamp-pop-field">메모 <input type="text" class="sp-memo" value="" placeholder="(선택)"></label>' +
      '<div class="stamp-pop-actions">' +
        '<button class="stamp-btn primary" data-sp="save">찍기</button>' +
        '<button class="stamp-btn" data-sp="cancel">취소</button>' +
      '</div>';
    document.body.appendChild(pop);
    positionPop(pop, anchorEl);
    var chosen = { stamp: CFG.defaultStamp||"excellent" };
    pop.querySelectorAll("[data-st]").forEach(function(btn){
      btn.addEventListener("click", function(){
        chosen.stamp = btn.dataset.st;
        pop.querySelectorAll("[data-st]").forEach(function(x){ x.classList.toggle("active", x===btn); });
      });
    });
    pop.querySelectorAll("[data-sp]").forEach(function(btn){
      btn.addEventListener("click", function(){
        if(btn.dataset.sp==="cancel"){ closePop(); return; }
        var date = pop.querySelector(".sp-date").value.trim();
        var memo = pop.querySelector(".sp-memo").value.trim();
        placeStamp({ stamp:chosen.stamp, date:date, memo:memo });
        saveState(); render(); closePop();
      });
    });
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
    document.querySelectorAll(".tab-btn").forEach(function(b){ b.classList.remove("active"); });
    document.querySelectorAll(".page").forEach(function(p){ p.classList.remove("active"); });
    pg.classList.add("active");
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
    var otherBtn = document.getElementById("stampOtherBtn");
    if(otherBtn) otherBtn.addEventListener("click", function(){ ensureCfgState().then(function(){ openArbitraryStamp(otherBtn); }); });
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
