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
    var url = (typeof showUrl==="function") ? showUrl("stamp.json?v=1") : "stamp.json";
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
    if(!st || typeof st!=="object"){ st = { boards:[], seq:0 }; }
    if(!Array.isArray(st.boards)) st.boards = [];
    if(typeof st.seq!=="number") st.seq = st.boards.length;
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
    var b = normalizeBoard({ id:"b"+(++st.seq), name:"", open:true, slots:[], gifts:{} });
    st.boards.push(b);
    return b;
  }
  // 도장을 하나 찍는다: 마지막(비어있는) 도장판의 다음 빈칸 → 없으면 새 도장판 생성.
  function placeStamp(entry){
    var b = st.boards.length ? st.boards[st.boards.length-1] : null;
    if(!b || isFull(b)) b = newBoard();
    var i = b.slots.findIndex(function(s){ return !s; });
    if(i < 0){ b = newBoard(); i = 0; }
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

  // 관극(종료+좌석) 회차를 시간순으로. 같은 날 2회 이상이면 -1,-2 회차 접미사.
  function watchedList(){
    if(!dataReady()) return [];
    var perfs = performanceData.performances;
    var ok = perfs.filter(function(p){
      return (typeof isEnded!=="function"||isEnded(p)) && (typeof hasSeat!=="function"||hasSeat(p));
    });
    // 같은 날 회차 수 계산
    var byDay = {};
    ok.forEach(function(p){ (byDay[p.date] = byDay[p.date]||[]).push(p); });
    var seq = {};
    return ok.map(function(p){
      var list = byDay[p.date];
      var label = mdOf(p.date);
      if(list.length > 1){
        seq[p.date] = (seq[p.date]||0) + 1;
        label += "-" + seq[p.date];
      }
      return { sid:p.sid, date:p.date, time:p.time, dateLabel:label };
    });
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
    st.boards.forEach(function(b, idx){
      boardsEl.appendChild(b.open ? renderOpenBoard(b, idx) : renderCover(b, idx));
    });
    updateAutoInfo();
  }

  function updateAutoInfo(){
    var el = document.getElementById("stampAutoInfo");
    if(!el) return;
    var list = watchedList();
    var done = stampedSids();
    var remain = 0, extra = 0;
    list.forEach(function(w){ if(!done.has(w.sid)){ remain++; extra += (stampCountForDate(w.date)-1); } });
    el.textContent = "관극 " + list.length + "회 · 안 찍은 회차 " + remain + (extra? " (+더블 "+extra+")" : "");
  }

  // 닫힌 도장판(표지) — 제공된 표지 이미지를 그대로 사용
  function renderCover(b, idx){
    var card = document.createElement("div");
    card.className = "stamp-card stamp-cover";
    var pad = (CFG.coverAspect[1]/CFG.coverAspect[0]*100).toFixed(3);
    var img = CFG.coverImage ? (typeof showUrl==="function"?showUrl(CFG.coverImage):CFG.coverImage) : "";
    card.innerHTML =
      '<div class="stamp-imgbox" style="padding-top:'+pad+'%">' +
        (img? '<img class="stamp-img" src="'+esc(img)+'" alt="'+esc(boardTitle(b,idx))+'">':'') +
      '</div>' +
      '<div class="stamp-card-foot">' +
        '<div class="stamp-card-name">'+ esc(boardTitle(b, idx)) +'</div>' +
        '<button class="stamp-btn" data-act="open">열기</button>' +
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
        '<div class="stamp-open-title">'+ esc(boardTitle(b, idx)) +'</div>' +
        '<div class="stamp-open-actions">' +
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
        openSlotEditor(b, row, cell);
      });
    });
  }

  function renameBoard(b, idx){
    var cur = boardTitle(b, idx);
    var name = prompt("도장판 이름", cur);
    if(name==null) return;
    b.name = name.trim();
    saveState(); render();
  }
  function deleteBoard(b, idx){
    if(!confirm("이 도장판을 삭제할까요? 찍힌 도장도 함께 지워집니다.")) return;
    st.boards.splice(idx,1);
    if(!st.boards.length) newBoard();
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
    st.boards = []; st.seq = 0;
    newBoard();
    saveState(); render();
  }

  /* ---------- 슬롯 편집 (도장 지우기/바꾸기) ---------- */
  function openSlotEditor(b, row, anchorEl){
    closePop();
    var slot = b.slots[row];
    var pop = document.createElement("div");
    pop.className = "stamp-pop";
    if(slot){
      // 이미 찍힘 → 바꾸기 / 지우기
      pop.innerHTML =
        '<div class="stamp-pop-h">도장 편집</div>' +
        stampTypeButtons(slot.stamp) +
        '<label class="stamp-pop-field">날짜 <input type="text" class="sp-date" value="'+esc(slot.date||"")+'" placeholder="7/14"></label>' +
        '<label class="stamp-pop-field">메모 <input type="text" class="sp-memo" value="'+esc(slot.memo||"")+'" placeholder="(선택)"></label>' +
        '<div class="stamp-pop-actions">' +
          '<button class="stamp-btn primary" data-sp="save">바꾸기</button>' +
          '<button class="stamp-btn ghost" data-sp="del">지우기</button>' +
          '<button class="stamp-btn" data-sp="cancel">취소</button>' +
        '</div>';
    } else {
      // 빈칸 → 도장 찍기
      pop.innerHTML =
        '<div class="stamp-pop-h">도장 찍기</div>' +
        stampTypeButtons(CFG.defaultStamp) +
        '<label class="stamp-pop-field">날짜 <input type="text" class="sp-date" value="" placeholder="7/14"></label>' +
        '<label class="stamp-pop-field">메모 <input type="text" class="sp-memo" value="" placeholder="(선택)"></label>' +
        '<div class="stamp-pop-actions">' +
          '<button class="stamp-btn primary" data-sp="save">찍기</button>' +
          '<button class="stamp-btn" data-sp="cancel">취소</button>' +
        '</div>';
    }
    document.body.appendChild(pop);
    positionPop(pop, anchorEl);
    var chosen = { stamp: slot ? slot.stamp : (CFG.defaultStamp||"excellent") };
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
          if(slot){ slot.stamp=chosen.stamp; slot.date=date; slot.memo=memo; }
          else { b.slots[row] = { stamp:chosen.stamp, date:date, memo:memo }; if(isFull(b)) b.open=false; }
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

  var curPop = null;
  function closePop(){ if(curPop && curPop.parentNode) curPop.parentNode.removeChild(curPop); curPop=null; }
  function positionPop(pop, anchorEl){
    curPop = pop;
    var r = anchorEl.getBoundingClientRect();
    pop.style.position = "fixed";
    pop.style.left = Math.min(r.left, window.innerWidth-260) + "px";
    pop.style.top = Math.min(r.bottom+6, window.innerHeight-10) + "px";
    setTimeout(function(){
      document.addEventListener("mousedown", onDocDown, true);
    },0);
    function onDocDown(e){
      if(!pop.contains(e.target)){ document.removeEventListener("mousedown", onDocDown, true); closePop(); }
    }
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
