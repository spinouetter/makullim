/* =========================================================
   DATA LAYER
   ========================================================= */

let seatmapData = null;
let performanceData = null;
let SEAT_BBOX = null;

function computeSeatBBox(){
  const xs = seatmapData.seats.map(s=>s.svgX);
  const ys = seatmapData.seats.map(s=>s.svgY);
  const pad = 3;
  const minX = Math.min(...xs) - pad;
  const maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad;
  const maxY = Math.max(...ys) + pad;
  return { x:minX, y:minY, w:maxX-minX, h:maxY-minY };
}

/* 분리된 데이터 파일(json/)을 불러와 seatmapData / performanceData 를 구성한다.
   극장 좌석 배치는 meta.theatre가 가리키는 파일에서 불러오므로, 한 레포에서
   여러 공연장을 두고 공연마다 다른 극장을 연결할 수 있다.
   분리 이전의 단일 객체 구조를 그대로 재구성하므로 이후의 렌더링 로직은 수정 불필요. */
async function loadData(){
  const j = async (path)=>{
    // cache:"no-store" → 데이터 파일(schedule 등)을 항상 최신으로 받아온다(브라우저 캐시 무시).
    const res = await fetch(path, { cache: "no-store" });
    if(!res.ok) throw new Error(path + " 로드 실패 (" + res.status + ")");
    return res.json();
  };
  // meta를 먼저 읽어 어떤 극장 파일을 쓸지 결정한다.
  const meta = await j("json/meta.json");
  const theatrePath = meta.theatre || "theatres/default.json";
  const [seatmap, grades, casts, schedule] = await Promise.all([
    j(theatrePath),
    j("json/grades.json"),
    j("json/casts.json"),
    j("json/schedule.json")
  ]);
  seatmapData = seatmap;
  performanceData = {
    title: meta.title,
    startDate: meta.startDate || "",
    endDate: meta.endDate || "",
    runningtime: (typeof meta.runningtime === "number" && meta.runningtime > 0) ? meta.runningtime : 180, // 분
    grades: grades, casts: casts, performances: schedule
  };
  // 공휴일(있으면): 날짜 -> 이름. 없어도 동작하도록 비-치명적으로 로드.
  try{ holidays = await j("json/holidays.json"); } catch(e){ console.warn("holidays.json 로드 실패:", e.message); holidays = {}; }
  holidaySet = new Set(Object.keys(holidays || {}));
  // 대결(match) 정의(있으면). 없어도 동작하도록 비-치명적으로 로드. 승패 결과는 공연 데이터(schedule)에 들어옴.
  try{ performanceData.matches = await j("json/matches.json"); } catch(e){ console.warn("matches.json 로드 실패:", e.message); performanceData.matches = []; }
  if(!Array.isArray(performanceData.matches)) performanceData.matches = [];
  SEAT_BBOX = computeSeatBBox();
  performanceData.performances.forEach((p,i)=>{
    p.sid = "s"+(i+1);        // 공연 숨겨진 ID (시간순)
    if(p.ticketType == null) p.ticketType = ""; // 티켓 종류(정가/할인). 빈 문자열 = 미선택
    if(p.ticketFee == null) p.ticketFee = false; // 수수료 포함 여부
    if(p.ticketDiscount == null) p.ticketDiscount = null; // 임의 할인권 할인율(없으면 null)
    if(p.ticketExtra == null) p.ticketExtra = 0; // 기타 비용(취소 수수료 등, 원)
    if(p.match == null || typeof p.match !== "object") p.match = {}; // 매치명 -> {winner, note} (서버 제공)
  });
}



/* =========================================================
   TAB NAVIGATION
   ========================================================= */
document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    document.querySelectorAll(".page").forEach(p=>p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("page-"+btn.dataset.page).classList.add("active");
  });
});

/* =========================================================
   SCHEDULE PAGE
   ========================================================= */
let scheduleRoleFilter = {}; // role -> Set(선택된 배우 이름). 비어있으면 필터 없음(전체 표시)
let scheduleMatchFilter = {}; // 대결명 -> Set(선택된 결과값: 배역명 | "무승부" | "__unknown__"(모름))
let scheduleHiddenCols = new Set(); // 숨긴 컬럼(배역 이름 또는 COL_TICKET/COL_PRICE)
let scheduleOpenDropdownRole = null; // 현재 열려있는 드롭다운의 컬럼 키(배역 이름 또는 COL_TICKET/COL_PRICE)
let showCastHistory = false; // 켜면 비중 0인 배우도 취소선과 함께 표시
let memoPopoverIdx = null; // 현재 열려있는 메모 팝오버의 공연 인덱스
let scheduleAutoScrolled = false; // 현재 공연으로의 자동 스크롤을 한 번만 수행
let ticketPopoverIdx = null; // 현재 열려있는 티켓 선택 팝오버의 공연 인덱스

// === 스케줄 가로 스크롤 시 날짜 식별 옵션 (Settings에서 토글, 기본 OFF) ===
let floatDateOn = false;        // 방법1: 날짜·시간·좌석을 왼쪽 고정 컬럼으로 플로팅 표시
let rowHighlightOn = false;     // 방법2: 날짜 클릭으로 그 줄 하이라이트
let rowHighlightSave = false;   // 방법2: 하이라이트를 새로고침 후에도 유지(저장)
let lockVScrollOn = false;      // 방법3: 가로 드래그 스크롤 중 세로 스크롤 잠금
let highlightedRows = new Set(); // 하이라이트된 공연 idx 집합

// 숨길 수 있는 특수 컬럼 키 (배역 이름과 충돌하지 않는 토큰)
const COL_TICKET = "__ticket__";
const COL_PRICE = "__price__";
const TICKET_FEE = 2000; // 선택 시 더해지는 수수료(원)
function colLabel(id){ return id===COL_TICKET ? "티켓" : (id===COL_PRICE ? "가격" : (id.indexOf("match:")===0 ? id.slice(6) : id)); }

// 등급의 정가(할인율 0) 항목을 찾는다.
function gradeFacePrice(grade){
  const f = (grade.prices||[]).find(x=>x.discount===0) || (grade.prices||[])[0];
  return f ? f.price : null;
}

// 좌석(→등급) + 티켓 종류 + 수수료 + (선택)임의 할인율로 최종 가격 계산. 계산 불가하면 null.
// customDiscount(숫자)가 주어지면 정가×(1-할인율)로 계산(임의 할인권), 아니면 등급 prices에서 이름으로 조회.
function ticketPriceOf(seatId, type, fee, customDiscount, extra){
  if(!type) return null;
  const gname = gradeOf((seatId||"").trim());
  if(!gname) return null;
  const grade = performanceData.grades.find(g=>g.name===gname);
  if(!grade) return null;
  let base;
  if(customDiscount != null){
    const face = gradeFacePrice(grade);
    if(face == null) return null;
    base = Math.round(face * (1 - customDiscount/100));
  } else {
    const pr = (grade.prices||[]).find(x=>x.name===type);
    if(!pr) return null;
    base = pr.price;
  }
  const extraCost = (typeof extra === "number" && isFinite(extra)) ? extra : 0;
  return base + (fee ? TICKET_FEE : 0) + extraCost; // 최종가 = 티켓가 + 수수료 + 기타비용
}

function formatKRW(n){
  return n.toLocaleString("ko-KR") + "원";
}

// 가격 항목이 이 공연에 적용 가능한지.
//  - sids: 없으면 전 공연, 있으면 그 공연 ID일 때만.
//  - times: 없으면 전 시간, 있으면 그 공연 시간일 때만(예: 마티네 14:30).
//  - excludeSids: 이 공연 ID는 제외(할인 미적용).
//  - weekdayOnly: true면 주말(토·일)·공휴일 공연에는 적용 안 됨.
//  - dateFrom / dateTo: 적용 기간(YYYY-MM-DD, 포함). 이 기간 밖이면 적용 안 됨.
function priceAppliesTo(pr, perf){
  if(Array.isArray(pr.sids) && !(perf && pr.sids.includes(perf.sid))) return false;
  if(Array.isArray(pr.times) && !(perf && pr.times.includes(perf.time))) return false;
  if(Array.isArray(pr.excludeSids) && perf && pr.excludeSids.includes(perf.sid)) return false;
  if(pr.weekdayOnly && perf && perf.date){
    const dow = dowOf(perf.date);              // 0=일 … 6=토
    if(dow===0 || dow===6 || holidaySet.has(perf.date)) return false;
  }
  if(pr.dateFrom && perf && perf.date && perf.date < pr.dateFrom) return false;
  if(pr.dateTo   && perf && perf.date && perf.date > pr.dateTo)   return false;
  return true;
}

// 티켓 선택 팝오버: 해당 등급의 티켓 목록(이름·할인율·가격) + 직접 입력 + 수수료 + 저장/해제
function buildTicketPopover(idx, grade, ticketType, ticketFee){
  const perf = performanceData.performances[idx] || {};
  const isCustom = perf.ticketDiscount != null; // 임의 할인권 선택 상태
  const customName = isCustom ? String(ticketType).replace(/"/g,'&quot;') : "";
  const customRate = isCustom ? perf.ticketDiscount : "";
  // 이 공연에 적용 가능한 티켓만 + 정렬: 위 고정(sort>=0 오름차순) → 가운데(sort 없음: 할인율↓·가나다) → 아래 고정(sort<0)
  const applicable = grade.prices.filter(pr=>priceAppliesTo(pr, perf));
  const topG = applicable.filter(p=>typeof p.sort==='number' && p.sort>=0).sort((a,b)=>a.sort-b.sort);
  const botG = applicable.filter(p=>typeof p.sort==='number' && p.sort<0).sort((a,b)=>a.sort-b.sort);
  const midG = applicable.filter(p=>typeof p.sort!=='number')
    .sort((a,b)=> (b.discount||0)-(a.discount||0) || a.name.localeCompare(b.name,'ko'));
  const prices = [...topG, ...midG, ...botG];
  return `
    <div class="ticket-popover" data-idx="${idx}">
      <div class="popover-date">${perfDateLabel(perf)}</div>
      <div class="ticket-popover-title">${grade.name}석 티켓 선택</div>
      <div class="ticket-options">
        ${prices.map(pr=>`
          <label class="ticket-option">
            <input type="radio" name="tkopt-${idx}" value="${pr.name}" ${(!isCustom && ticketType===pr.name)?'checked':''}>
            <span class="to-name">${pr.name}</span>
            <span class="to-disc">${pr.discount ? pr.discount+'% 할인' : '정가'}</span>
            <span class="to-price">${formatKRW(pr.price)}</span>
          </label>
        `).join("")}
        <label class="ticket-option ticket-custom">
          <input type="radio" name="tkopt-${idx}" value="__custom__" ${isCustom?'checked':''}>
          <span class="to-name">직접 입력</span>
          <input type="text" class="tk-custom-name" data-idx="${idx}" placeholder="할인권 이름" value="${customName}">
          <input type="number" class="tk-custom-rate" data-idx="${idx}" placeholder="0" min="0" max="100" value="${customRate}"><span class="tk-pct">%</span>
        </label>
      </div>
      <div class="ticket-fee-row">
        <label class="tk-fee-label"><input type="checkbox" class="tk-fee" data-idx="${idx}" ${ticketFee?'checked':''}> 수수료 +${formatKRW(TICKET_FEE)}</label>
        <span class="tk-extra-group">기타 <input type="number" class="tk-extra" data-idx="${idx}" min="0" step="100" value="${perf.ticketExtra ? perf.ticketExtra : ''}" placeholder="0">원</span>
      </div>
      <div class="ticket-popover-actions">
        <button class="tk-clear" data-idx="${idx}" style="border-color:#a85a44; color:#e08a73;">삭제</button>
        <button class="tk-cancel" data-idx="${idx}">취소</button>
        <button class="tk-save" data-idx="${idx}">저장</button>
      </div>
    </div>`;
}

function renderSchedule(){
  const head = document.getElementById("scheduleHead");
  const body = document.getElementById("scheduleBody");
  const table = document.getElementById("scheduleTable");
  table.classList.toggle("hl-mode", rowHighlightOn);  // 방법2(날짜 셀 클릭 가능)
  const allRoles = performanceData.casts.map(c=>c.role);
  const visibleRoles = allRoles.filter(r=>!scheduleHiddenCols.has(r));
  const showTicket = !scheduleHiddenCols.has(COL_TICKET);
  const showPrice = !scheduleHiddenCols.has(COL_PRICE);
  const visibleMatches = (performanceData.matches||[]).filter(m=>!scheduleHiddenCols.has("match:"+m.name));

  const castHistoryBtn = document.getElementById("castHistoryToggleBtn");
  castHistoryBtn.classList.toggle("active", showCastHistory);
  castHistoryBtn.onclick = ()=>{
    showCastHistory = !showCastHistory;
    saveState();
    renderSchedule();
  };

  const hiddenBar = document.getElementById("scheduleHiddenBar");
  if(scheduleHiddenCols.size===0){
    hiddenBar.innerHTML = "";
  } else {
    hiddenBar.innerHTML = `
      <div class="hidden-roles-bar">
        <span>숨긴 컬럼:</span>
        <select id="hiddenColSelect">
          ${[...scheduleHiddenCols].map(c=>`<option value="${c}">${colLabel(c)}</option>`).join("")}
        </select>
        <button id="hiddenColAddBtn">표시</button>
      </div>
    `;
    document.getElementById("hiddenColAddBtn").addEventListener("click", ()=>{
      const sel = document.getElementById("hiddenColSelect").value;
      scheduleHiddenCols.delete(sel);
      renderSchedule();
      saveState();
    });
  }

  const colHeadHtml = (colKey, label)=>{
    const isOpen = scheduleOpenDropdownRole===colKey;
    return `
      <th class="role-head">
        <div style="position:relative;">
          <button class="col-head-btn" data-col="${colKey}" style="background:none; border:none; color:inherit; font:inherit; font-weight:inherit; cursor:pointer; padding:0; display:flex; align-items:center; gap:4px;">
            <span class="role-name">${label}</span><span style="font-size:9px;">&#9662;</span>
          </button>
          ${isOpen ? `
            <div class="role-dropdown">
              <div class="role-dropdown-actions" style="border-top:none; margin-top:0; padding-top:0;">
                <button class="col-hide-btn" data-col="${colKey}">숨기기</button>
              </div>
            </div>
          ` : ""}
        </div>
      </th>
    `;
  };

  head.innerHTML = `
    ${floatDateOn ? '<th class="float-cell"></th>' : ''}
    <th>날짜</th><th>시간</th><th>좌석</th>
    ${showTicket ? colHeadHtml(COL_TICKET, "티켓") : ""}
    ${showPrice ? colHeadHtml(COL_PRICE, "가격") : ""}
    <th>메모</th>
    ${visibleMatches.map(m=>{
      const sel = scheduleMatchFilter[m.name] || new Set();
      const isOpen = scheduleOpenDropdownRole === ("match:"+m.name);
      const hasFilter = sel.size>0;
      const opts = [...m.roles.map(r=>({v:r,label:r})), {v:"무승부",label:"무승부"}, {v:"__unknown__",label:"모름"}];
      return `
        <th class="role-head match-head">
          <div style="position:relative;">
            <button class="match-head-btn" data-match="${m.name}" style="background:none;border:none;color:${hasFilter?'var(--gold)':'inherit'};font:inherit;font-weight:inherit;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;">
              <span class="role-name">${m.name}</span><span class="col-arrow">&#9662;${hasFilter ? `<span class="col-filter-badge">${sel.size}</span>` : ""}</span>
            </button>
            ${isOpen ? `
              <div class="role-dropdown align-right">
                <div class="role-dropdown-title">결과 필터</div>
                ${opts.map(o=>`<label class="role-dropdown-item"><input type="checkbox" data-match="${m.name}" data-val="${o.v}" ${sel.has(o.v)?'checked':''}> ${o.label}</label>`).join("")}
                <div class="role-dropdown-actions"><button class="match-clear-btn" data-match="${m.name}">모두 해제</button></div>
                <div class="role-dropdown-actions" style="border-top:none; margin-top:0; padding-top:0;"><button class="match-hide-btn" data-match="${m.name}">숨기기</button></div>
              </div>
            ` : ""}
          </div>
        </th>`;
    }).join("")}
    ${visibleRoles.map((role, roleIdx)=>{
      const roleInfo = performanceData.casts.find(c=>c.role===role);
      const selected = scheduleRoleFilter[role] || new Set();
      const isOpen = scheduleOpenDropdownRole===role;
      const hasFilter = selected.size>0;
      const isLast = roleIdx===visibleRoles.length-1;
      return `
        <th class="role-head">
          <div style="position:relative;">
            <button class="role-head-btn" data-role="${role}" style="background:none; border:none; color:${hasFilter?'var(--gold)':'inherit'}; font:inherit; font-weight:inherit; cursor:pointer; padding:0; display:flex; align-items:center; gap:4px;">
              <span class="role-name">${role}</span><span class="col-arrow">&#9662;${hasFilter ? `<span class="col-filter-badge">${selected.size}</span>` : ""}</span>
            </button>
            ${isOpen ? `
              <div class="role-dropdown ${isLast?'align-right':''}">              <div class="role-dropdown-title">배우 선택</div>
                ${roleInfo.actors.filter(a=>{
                  if(a.role==="cast") return true;
                  // cast 아닌 배우는 실제 공연 출연 기록이 있을 때만 표시
                  return performanceData.performances.some(p=>castVisibleNamesOf(p.cast[role]).includes(a.name));
                }).map(a=>`
                  <label class="role-dropdown-item">
                    <input type="checkbox" data-role="${role}" data-actor="${a.name}" ${selected.has(a.name)?'checked':''}>
                    ${a.name}
                  </label>
                `).join("")}
                <div class="role-dropdown-actions">
                  <button class="role-clear-btn" data-role="${role}">모두 해제</button>
                </div>
                <div class="role-dropdown-actions" style="border-top:none; margin-top:0; padding-top:0;">
                  <button class="role-hide-btn" data-role="${role}">숨기기</button>
                </div>
              </div>
            ` : ""}
          </div>
        </th>
      `;
    }).join("")}
  `;

  head.querySelectorAll(".role-head-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const role = btn.dataset.role;
      scheduleOpenDropdownRole = scheduleOpenDropdownRole===role ? null : role;
      renderSchedule();
    });
  });

  head.querySelectorAll(".role-dropdown input[data-actor]").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const role = cb.dataset.role;
      const actor = cb.dataset.actor;
      if(!scheduleRoleFilter[role]) scheduleRoleFilter[role] = new Set();
      if(cb.checked) scheduleRoleFilter[role].add(actor);
      else scheduleRoleFilter[role].delete(actor);
      renderSchedule();
      saveState();
    });
  });

  head.querySelectorAll(".role-clear-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      delete scheduleRoleFilter[btn.dataset.role];
      renderSchedule();
      saveState();
    });
  });

  head.querySelectorAll(".role-hide-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      scheduleHiddenCols.add(btn.dataset.role);
      scheduleOpenDropdownRole = null;
      renderSchedule();
      saveState();
    });
  });

  // 대결 결과 필터 드롭다운
  head.querySelectorAll(".match-head-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const key = "match:"+btn.dataset.match;
      scheduleOpenDropdownRole = scheduleOpenDropdownRole===key ? null : key;
      renderSchedule();
    });
  });
  head.querySelectorAll(".role-dropdown input[data-match]").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const m = cb.dataset.match, v = cb.dataset.val;
      if(!scheduleMatchFilter[m]) scheduleMatchFilter[m] = new Set();
      if(cb.checked) scheduleMatchFilter[m].add(v); else scheduleMatchFilter[m].delete(v);
      renderSchedule();
      saveState();
    });
  });
  head.querySelectorAll(".match-clear-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      delete scheduleMatchFilter[btn.dataset.match];
      renderSchedule();
      saveState();
    });
  });
  head.querySelectorAll(".match-hide-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      scheduleHiddenCols.add("match:"+btn.dataset.match);
      scheduleOpenDropdownRole = null;
      renderSchedule();
      saveState();
    });
  });

  head.querySelectorAll(".col-head-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const col = btn.dataset.col;
      scheduleOpenDropdownRole = scheduleOpenDropdownRole===col ? null : col;
      renderSchedule();
    });
  });

  head.querySelectorAll(".col-hide-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      scheduleHiddenCols.add(btn.dataset.col);
      scheduleOpenDropdownRole = null;
      renderSchedule();
      saveState();
    });
  });


  const filteredPerfs = performanceData.performances.filter(p=>{
    for(const role in scheduleRoleFilter){
      const sel = scheduleRoleFilter[role];
      if(sel && sel.size>0){
        const names = castVisibleNamesOf(p.cast[role]);
        if(!names.some(n=>sel.has(n))) return false;
      }
    }
    // 대결 결과 필터: 배역명 | "무승부" | "__unknown__"(끝났는데 미기록=모름). 미래(미정)는 어떤 값도 아니라 제외됨.
    for(const mname in scheduleMatchFilter){
      const sel = scheduleMatchFilter[mname];
      if(sel && sel.size>0){
        const res = p.match && p.match[mname];
        const val = (res && res.winner) ? res.winner : (isEnded(p) ? "__unknown__" : "__tbd__");
        if(!sel.has(val)) return false;
      }
    }
    return true;
  });

  // 종료되지 않은 첫 공연 = 현재 관극 중 또는 바로 다음 공연 (시간순)
  const currentIdx = performanceData.performances.findIndex(pp=>!isEnded(pp));

  body.innerHTML = filteredPerfs.map(p=>{
    const idx = performanceData.performances.indexOf(p);
    const isPast = isEnded(p); // 종료(시작+러닝타임 경과)된 공연을 과거로 표시
    const dcolor = dateColorOf(p.date); // 일/공휴일=빨강, 토=파랑
    const ticketType = p.ticketType || "";
    const ticketFee = !!p.ticketFee;
    const ticketDiscount = (p.ticketDiscount != null) ? p.ticketDiscount : null; // 임의 할인권이면 할인율
    const gradeName = gradeOf((p.seat||"").trim());          // 좌석 → 등급
    const grade = gradeName ? performanceData.grades.find(g=>g.name===gradeName) : null;

    const seatVal = (p.seat||"").trim();
    const seatInvalid = !isValidSeat(p.seat);                // 빈 값은 invalid 아님
    const eyeColor = seatInvalid ? '#e0594a' : (seatVal ? 'var(--gold)' : 'var(--ink-dim)');
    const eyeOpacity = (seatVal || seatInvalid) ? 1 : 0.3;

    let ticketCell = "";
    if(showTicket){
      let inner;
      if(!grade){
        // 좌석 미입력/무효 → 등급을 알 수 없어 티켓 선택 불가
        inner = `<span class="tk-none">—</span>`;
      } else {
        const gradeChip = `<span class="tk-grade" style="background:${gradeFillVar(gradeName)};">${gradeName[0]}</span>`;
        const sel = grade.prices.find(x=>x.name===ticketType);
        const discVal = (ticketDiscount != null) ? ticketDiscount : (sel ? (sel.discount||0) : null);
        if(ticketType && discVal != null){
          // 선택 완료(등록 티켓 또는 임의 할인권): 등급 첫글자 · 티켓 이름 첫글자 · 할인율
          inner = `<button class="ticket-trigger selected" data-idx="${idx}" title="티켓 변경">`
            + gradeChip
            + `<span class="tk-name">${ticketType[0]}</span>`
            + `<span class="tk-disc">${discVal}%</span>`
            + `</button>`;
        } else {
          // 미선택: 등급 첫글자 + 티켓 아이콘
          inner = `<button class="ticket-trigger" data-idx="${idx}" title="티켓 선택">`
            + gradeChip
            + `<span class="tk-icon" aria-hidden="true">&#127903;</span>`
            + `</button>`;
        }
      }
      const popover = (ticketPopoverIdx===idx && grade) ? buildTicketPopover(idx, grade, ticketType, ticketFee) : "";
      ticketCell = `<td class="ticket-cell" style="position:relative;">${inner}${popover}</td>`;
    }

    let priceCell = "";
    if(showPrice){
      const price = ticketPriceOf(p.seat, ticketType, ticketFee, ticketDiscount, p.ticketExtra);
      priceCell = `<td class="price-cell">${price!=null ? formatKRW(price) : '<span class="empty">—</span>'}</td>`;
    }

    const castCells = visibleRoles.map(role=>{
      const items = showCastHistory
        ? parseCastWeighted(p.cast[role])
        : parseCastWeighted(p.cast[role]).filter(it=>it.weight>0);
      if(items.length===0){
        return `<td class="cast-cell"><span class="empty">미정</span></td>`;
      }
      const lookup = {};
      const roleInfo = performanceData.casts.find(c=>c.role===role);
      roleInfo.actors.forEach(a=>lookup[a.name]=a.role);
      return `<td class="cast-cell">${
        items.map(it=>{
          const n = it.name;
          const baseCls = lookup[n]==="alternative" ? "alt" : (lookup[n]==="swing" ? "swing":"");
          const zeroCls = it.weight===0 ? "zero-weight" : "";
          return `<span class="name ${baseCls} ${zeroCls}">${n}</span>`;
        }).join("")
      }</td>`;
    }).join("");

    // 방법1: 컬럼이 아니라 0폭 sticky 셀 + 절대배치 오버레이 라벨. 가로 스크롤 시에만 보임.
    // 좌석번호 대신 티켓 아이콘 표시: 티켓(좌석이 등급에 매칭)이 있으면 진하게(on), 없으면 옅게.
    const floatCell = floatDateOn
      ? `<td class="float-cell"><div class="float-label"${dcolor?` style="color:${dcolor}"`:''}>${floatLabelText(p)}<span class="float-tk${grade?' on':''}" aria-hidden="true">&#127903;</span></div></td>`
      : "";

    return `
      <tr class="${isPast?'past':''} ${idx===currentIdx?'current-perf':''} ${highlightedRows.has(idx)?'row-highlight':''}" data-idx="${idx}">
        ${floatCell}
        <td class="date-cell"${dcolor?` style="color:${dcolor}"`:''}>${shortDateDow(p.date)}</td>
        <td class="time-cell"${dcolor?` style="color:${dcolor}"`:''}>${p.time}</td>
        <td class="seat-cell">
          <div style="display:flex; align-items:center; gap:4px;">
            <input class="seat-input${seatInvalid ? ' invalid-seat' : ''}" type="text" value="${p.seat}" placeholder="1-8-5" data-idx="${idx}" data-field="seat">
            <button class="seat-eye-btn${seatInvalid ? ' invalid' : ''}" data-idx="${idx}" title="${seatInvalid ? '등록되지 않은 좌석입니다' : '좌석표에서 보기'}" style="flex-shrink:0; background:none; border:none; padding:2px 3px; display:flex; align-items:center; justify-content:center; line-height:0; position:relative; color:${eyeColor}; opacity:${eyeOpacity};">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
              ${seatInvalid ? `<span class="seat-eye-warn">!</span>` : ""}
            </button>
          </div>
        </td>
        ${ticketCell}
        ${priceCell}
        <td class="memo-cell" style="position:relative;">
          <button class="memo-icon-btn" data-idx="${idx}" title="메모" style="background:none; border:none; cursor:pointer; padding:4px; display:flex; align-items:center; justify-content:center; color:${p.note && p.note.trim() ? 'var(--gold)' : 'var(--ink-dim)'}; opacity:${p.note && p.note.trim() ? 1 : 0.4};">
            <svg width="13" height="16" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="14" height="18" rx="1.5"/><line x1="4" y1="6" x2="12" y2="6"/><line x1="4" y1="10" x2="12" y2="10"/><line x1="4" y1="14" x2="9" y2="14"/></svg>
          </button>
          ${memoPopoverIdx===idx ? `
            <div class="memo-popover">
              <div class="popover-date">${perfDateLabel(p)}</div>
              <textarea class="memo-popover-input" rows="3" placeholder="메모 입력" data-idx="${idx}">${(p.note||"").replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
              <div class="memo-popover-actions">
                <button class="memo-cancel-btn" data-idx="${idx}">취소</button>
                <button class="memo-confirm-btn" data-idx="${idx}">확인</button>
              </div>
            </div>
          ` : ""}
        </td>
        ${visibleMatches.map(m=>{
          const res = p.match && p.match[m.name];
          const w = (res && res.winner) ? res.winner : "";
          let disp, cls, style="";
          if(w==="무승부"){ disp="무승부"; cls="draw"; }
          else if(w){ disp=w; cls="win"; style=` style="color:${matchRoleColor(m,w)}"`; }
          else { disp = isPast ? "모름" : "미정"; cls="none"; }
          const noteAttr = (res && res.note) ? ` title="${String(res.note).replace(/"/g,'&quot;')}"` : "";
          return `<td class="match-cell ${cls}"${style}${noteAttr}>${disp}</td>`;
        }).join("")}
        ${castCells}
      </tr>
    `;
  }).join("");

  body.querySelectorAll(".ticket-trigger").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      ticketPopoverIdx = ticketPopoverIdx===idx ? null : idx;
      memoPopoverIdx = null;
      renderSchedule();
    });
  });

  body.querySelectorAll(".ticket-popover").forEach(pop=>{
    pop.addEventListener("click", e=>e.stopPropagation());
  });

  // 직접 입력 칸을 만지면 '직접 입력' 라디오가 자동 선택되도록
  body.querySelectorAll(".tk-custom-name, .tk-custom-rate").forEach(inp=>{
    inp.addEventListener("focus", ()=>{
      const idx = inp.dataset.idx;
      const radio = body.querySelector(`input[name="tkopt-${idx}"][value="__custom__"]`);
      if(radio) radio.checked = true;
    });
  });

  body.querySelectorAll(".tk-save").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      const checked = body.querySelector(`input[name="tkopt-${idx}"]:checked`);
      const feeCb = body.querySelector(`.tk-fee[data-idx="${idx}"]`);
      const extraInp = body.querySelector(`.tk-extra[data-idx="${idx}"]`);
      const perf = performanceData.performances[idx];
      perf.ticketFee = feeCb ? feeCb.checked : false;
      let extra = Number(extraInp && extraInp.value);
      perf.ticketExtra = (isFinite(extra) && extra > 0) ? Math.round(extra) : 0; // 기타 비용
      if(checked && checked.value === "__custom__"){
        const nameInp = body.querySelector(`.tk-custom-name[data-idx="${idx}"]`);
        const rateInp = body.querySelector(`.tk-custom-rate[data-idx="${idx}"]`);
        const cname = (nameInp && nameInp.value || "").trim();
        let crate = Number(rateInp && rateInp.value);
        if(!isFinite(crate)) crate = 0;
        crate = Math.max(0, Math.min(100, crate));
        if(cname){
          perf.ticketType = cname;
          perf.ticketDiscount = crate; // 임의 할인권
        } else {
          perf.ticketType = ""; perf.ticketDiscount = null; // 이름 없으면 미선택 처리
        }
      } else {
        perf.ticketType = checked ? checked.value : "";
        perf.ticketDiscount = null; // 등록 티켓이면 임의 할인 해제
      }
      ticketPopoverIdx = null;
      renderSchedule();
      renderStats();   // 티켓 변경 → 통계(티켓 금액) 갱신
      renderSeatMap(); // 시트맵도 함께 갱신
      saveState();
    });
  });

  // 취소: 변경 없이 팝오버만 닫음
  body.querySelectorAll(".tk-cancel").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      ticketPopoverIdx = null;
      renderSchedule();
    });
  });

  // 삭제: 티켓·수수료·임의할인·기타비용 모두 초기화
  body.querySelectorAll(".tk-clear").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      performanceData.performances[idx].ticketType = "";
      performanceData.performances[idx].ticketFee = false;
      performanceData.performances[idx].ticketDiscount = null;
      performanceData.performances[idx].ticketExtra = 0;
      ticketPopoverIdx = null;
      renderSchedule();
      renderStats();   // 티켓 해제 → 통계(티켓 금액) 갱신
      renderSeatMap(); // 시트맵도 함께 갱신
      saveState();
    });
  });

  body.querySelectorAll(".memo-icon-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      memoPopoverIdx = memoPopoverIdx===idx ? null : idx;
      ticketPopoverIdx = null;
      renderSchedule();
    });
  });

  body.querySelectorAll(".memo-popover-input").forEach(inp=>{
    inp.addEventListener("click", e=>e.stopPropagation());
    inp.focus({ preventScroll: true }); // 포커스로 인한 자동 스크롤 방지(팝업 위치 보정과 충돌)
  });

  body.querySelectorAll(".memo-cancel-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      memoPopoverIdx = null;
      renderSchedule();
    });
  });

  body.querySelectorAll(".memo-confirm-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const idx = +btn.dataset.idx;
      const inp = body.querySelector(`.memo-popover-input[data-idx="${idx}"]`);
      performanceData.performances[idx].note = inp.value;
      memoPopoverIdx = null;
      renderSchedule();
      saveState();
    });
  });

  body.querySelectorAll(".seat-eye-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.preventDefault();
      if(btn.classList.contains("invalid")) return; // 무효 좌석은 클릭 불가
      const idx = +btn.dataset.idx;
      const input = body.querySelector(`.seat-input[data-idx="${idx}"]`);
      const seatId = (input.value || "").trim();
      if(!seatId) return;
      showSeatOverlay(seatId);
    });
  });

  body.querySelectorAll(".seat-input").forEach(inp=>{
    inp.addEventListener("input", ()=>{
      const idx = inp.dataset.idx;
      const btn = body.querySelector(`.seat-eye-btn[data-idx="${idx}"]`);
      inp.classList.toggle("invalid-seat", !isValidSeat(inp.value));
      applyEyeState(btn, inp.value);
    });
  });

  body.querySelectorAll(".seat-input").forEach(inp=>{
    inp.addEventListener("focus", ()=>{
      inp.dataset.origValue = inp.value;
    });
    inp.addEventListener("keydown", e=>{
      if(e.key==="Enter"){
        e.preventDefault();
        inp.blur(); // blur 시 change 이벤트가 발생해 저장됨
      } else if(e.key==="Escape"){
        e.preventDefault();
        inp.value = inp.dataset.origValue !== undefined ? inp.dataset.origValue : inp.value;
        const idx = inp.dataset.idx;
        const btn = body.querySelector(`.seat-eye-btn[data-idx="${idx}"]`);
        inp.classList.toggle("invalid-seat", !isValidSeat(inp.value));
        applyEyeState(btn, inp.value);
        inp.blur(); // 값이 origValue와 같으므로 change 이벤트가 발생하지 않아 저장되지 않음
      }
    });
    inp.addEventListener("change", e=>{
      const i = +e.target.dataset.idx;
      const field = e.target.dataset.field;
      performanceData.performances[i][field] = e.target.value;
      // 좌석이 바뀌었으니 스케줄(티켓 등급·눈 표시)·통계·좌석맵을 갱신
      renderSchedule();
      renderStats();
      renderSeatMap();
      saveState();
    });
  });

  // 방법2: 날짜/플로팅 셀 클릭으로 그 줄 하이라이트 토글(여러 행 동시 가능)
  if(rowHighlightOn){
    body.querySelectorAll(".date-cell, .float-cell").forEach(cell=>{
      cell.addEventListener("click", ()=>{
        const tr = cell.closest("tr");
        const i = +tr.dataset.idx;
        if(highlightedRows.has(i)) highlightedRows.delete(i);
        else highlightedRows.add(i);
        tr.classList.toggle("row-highlight");
        updateClearHighlightBtn(); // 선택 수에 따라 해제 버튼 활성/비활성 갱신
        if(rowHighlightSave) saveState();
      });
    });
  }

  // 방법2: '하이라이트 해제' 버튼은 스케줄 툴바(캐스트 변경 기록 옆). 선택이 있을 때만 활성.
  const clearBtn = document.getElementById("clearHighlightBtn");
  if(clearBtn){
    clearBtn.onclick = ()=>{
      if(highlightedRows.size === 0) return; // 비활성 상태 보호
      highlightedRows.clear();
      saveState();
      renderSchedule();
    };
  }
  updateClearHighlightBtn();

  // 필터 끄기 버튼(필터 유무로 활성/비활성)
  const filterClearBtn = document.getElementById("filterClearBtn");
  if(filterClearBtn){
    filterClearBtn.onclick = ()=>{
      if(!anyScheduleFilterActive()) return;
      scheduleRoleFilter = {};
      scheduleMatchFilter = {};
      renderSchedule();
      saveState();
    };
  }
  updateFilterClearBtn();

  // 방법1: 오버레이 임계값(년도 폭) 측정 + 현재 가로 스크롤에 맞춰 표시 갱신
  if(floatDateOn) computeFloatThreshold();
  updateFloatOverlay();

  // 페이지 최초 로드/새로고침 시, 현재·다음 공연이 위에서 4번째 줄에 오도록 한 번만 스크롤
  if(!scheduleAutoScrolled){
    scheduleAutoScrolled = true;
    requestAnimationFrame(()=>{
      scrollToCurrentPerf();
      const w = document.querySelector("#page-schedule .table-scroll-wrap");
      scheduleHomeScrollTop = w ? w.scrollTop : 0; // '지금' 버튼 비교용 홈 위치
      updateNowBtn();
    });
  }
  updateNowBtn();

  // 티켓/메모 팝업이 테이블 하단을 넘으면 위로 올려 하단을 맞춘다.
  requestAnimationFrame(adjustPopoverToTable);
}

// 열려 있는 티켓/메모 팝업의 bottom이 테이블 하단보다 아래면, 그만큼 위로 올려 하단을 맞춘다.
function adjustPopoverToTable(){
  const wrap = document.querySelector("#page-schedule .table-scroll-wrap");
  if(!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const vw = document.documentElement.clientWidth; // 화면(뷰포트) 너비
  const M = 8; // 화면 가장자리 최소 여백
  // 세로 보정 기준: 테이블 하단과 '실제로 보이는 뷰포트 바닥' 중 더 위.
  // 모바일 브라우저 하단 툴바가 동적으로 나타날 때 visualViewport가 실제 가시 영역을 알려주므로,
  // 이를 기준으로 해야 저장 버튼이 안드로이드/브라우저 컨트롤 뒤로 숨지 않는다.
  const vv = window.visualViewport;
  const visibleBottom = vv ? (vv.height + vv.offsetTop) : window.innerHeight;
  const bottomBound = Math.min(wrapRect.bottom, visibleBottom);
  document.querySelectorAll("#scheduleBody .ticket-popover, #scheduleBody .memo-popover").forEach(pop=>{
    pop.style.transform = ""; // 측정 전 초기화
    const r = pop.getBoundingClientRect();

    // 세로: 보이는 영역 하단을 넘으면 위로 올림(테이블 상단은 넘지 않게)
    let shiftY = 0;
    const over = (r.bottom - bottomBound) + 4; // 가시 하단을 넘은 양(여백 4px)
    if(over > 0){
      const maxShift = Math.max(0, r.top - wrapRect.top - 4);
      shiftY = -Math.min(over, maxShift);
    }

    // 가로: 화면 오른쪽을 넘으면 왼쪽으로 끌어오고, 그 결과 왼쪽을 넘으면 안쪽으로 클램프
    // (팝오버가 화면보다 넓으면 왼쪽 가장자리에 맞춰 최대한 보이게)
    let shiftX = 0;
    if(r.right > vw - M) shiftX = (vw - M) - r.right;
    if(r.left + shiftX < M) shiftX = M - r.left;

    if(shiftX || shiftY) pop.style.transform = `translate(${shiftX}px, ${shiftY}px)`;
  });
}

// 현재·다음 공연(.current-perf)을 스케줄 스크롤 영역에서 위에서 4번째 줄 위치로 스크롤
function scrollToCurrentPerf(){
  const body = document.getElementById("scheduleBody");
  const wrap = document.querySelector("#page-schedule .table-scroll-wrap");
  const thead = document.querySelector("#scheduleTable thead");
  if(!body || !wrap) return;
  const rows = [...body.querySelectorAll("tr")];
  const hiIdx = rows.findIndex(r=>r.classList.contains("current-perf"));
  if(hiIdx < 0) return;
  const targetRow = rows[Math.max(0, hiIdx - 3)]; // 3줄 위 → 하이라이트가 4번째
  const theadH = thead ? thead.getBoundingClientRect().height : 0;
  const delta = targetRow.getBoundingClientRect().top - wrap.getBoundingClientRect().top - theadH;
  wrap.scrollTop += delta;
}

// '지금' 버튼: 새로고침 직후와 동일한 홈 위치로 스크롤 초기화
let scheduleHomeScrollTop = 0;
function goToNow(){
  const wrap = document.querySelector("#page-schedule .table-scroll-wrap");
  if(!wrap) return;
  wrap.scrollLeft = 0;
  wrap.scrollTop = 0;        // 기본(현재 공연 없을 때) = 최상단
  scrollToCurrentPerf();     // 현재/다음 공연이 있으면 4번째 줄로
  scheduleHomeScrollTop = wrap.scrollTop;
  updateFloatOverlay();
  updateNowBtn();
}
// 현재 스크롤이 홈 위치에서 벗어났는지에 따라 '지금' 버튼 활성/비활성
function updateNowBtn(){
  const btn = document.getElementById("nowBtn");
  const wrap = document.querySelector("#page-schedule .table-scroll-wrap");
  if(!btn || !wrap) return;
  const scrolled = Math.abs(wrap.scrollTop - scheduleHomeScrollTop) > 2 || wrap.scrollLeft > 2;
  btn.disabled = !scrolled;
  btn.classList.toggle("active", scrolled);
}


/* =========================================================
   STATISTICS PAGE
   ========================================================= */
let roleStatsOrder = []; // loadData() 이후 init()에서 채움
let collapsedRoles = new Set(); // 닫혀있는 배역 이름
let hiddenStatActors = {}; // {배역명: Set<배우명>} — 배역별 출연 통계에서 숨긴 배우

function shortDate(dateStr){
  return dateStr.replace(/^20(\d{2})-(\d{2})-(\d{2})$/, "$1/$2/$3");
}

// 공휴일 (loadData에서 채움): 날짜 -> 이름
let holidays = {};
let holidaySet = new Set();
const DOW = ["일","월","화","수","목","금","토"];

// "2026-04-12" -> 요일 인덱스(0=일 ~ 6=토). 로컬 기준으로 계산해 시간대 오차 방지.
function dowOf(dateStr){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((dateStr||"").trim());
  if(!m) return -1;
  return new Date(+m[1], +m[2]-1, +m[3]).getDay();
}
// 날짜 색: 일요일/공휴일 = 빨강, 토요일 = 파랑, 그 외 = null
function dateColorOf(dateStr){
  const dow = dowOf(dateStr);
  if(dow===0 || holidaySet.has((dateStr||"").trim())) return "#e0594a";
  if(dow===6) return "#5b8fd6";
  return null;
}
// "26/04/12 (일)" 형태 (요일 포함)
function shortDateDow(dateStr){
  const i = dowOf(dateStr);
  return shortDate(dateStr) + (i>=0 ? ` (${DOW[i]})` : "");
}
// 팝오버 상단에 표시할 공연 날짜/시간 라벨: "26/06/28 (일) 14:00"
function perfDateLabel(p){
  if(!p || !p.date) return "";
  return shortDateDow(p.date) + (p.time ? " " + p.time : "");
}

// 방법1 플로팅 오버레이 라벨: 년도 빼고(MM/DD), 시간은 분 빼고(시만). 예 "06/28 19"
function floatLabelText(p){
  if(!p) return "";
  const md = (p.date || "").replace(/^\d{4}-(\d{2})-(\d{2})$/, "$1/$2");
  const hh = (p.time || "").split(":")[0] || "";
  return md + (hh ? ` ${hh}` : "");
}

// 방법1: 가로 스크롤이 '날짜의 년도 폭'을 넘으면 오버레이 표시 → 그 임계값(px)을 날짜셀 첫 3글자("26/") 폭으로 측정
let floatThreshold = 22;
function computeFloatThreshold(){
  const cell = document.querySelector("#scheduleBody .date-cell");
  if(!cell || !cell.firstChild || cell.firstChild.nodeType !== 3) return;
  try{
    const range = document.createRange();
    range.setStart(cell.firstChild, 0);
    range.setEnd(cell.firstChild, 3); // "YY/"
    const w = Math.round(range.getBoundingClientRect().width);
    if(w > 6) floatThreshold = w;
  } catch(e){ /* 측정 실패 시 기본값 유지 */ }
}
// 가로 스크롤 정도에 따라 오버레이 표시/숨김 토글
function updateFloatOverlay(){
  const wrap = document.querySelector("#page-schedule .table-scroll-wrap");
  if(!wrap) return;
  wrap.classList.toggle("h-scrolled", floatDateOn && wrap.scrollLeft > floatThreshold);
}

// 스케줄에 필터(배역/대결 결과)가 하나라도 적용돼 있는지
function anyScheduleFilterActive(){
  return Object.values(scheduleRoleFilter).some(s=>s&&s.size>0)
      || Object.values(scheduleMatchFilter).some(s=>s&&s.size>0);
}
// '필터 끄기' 버튼: 필터가 있으면 활성, 없으면 비활성. 누르면 전체 필터 초기화.
function updateFilterClearBtn(){
  const btn = document.getElementById("filterClearBtn");
  if(!btn) return;
  const on = anyScheduleFilterActive();
  btn.disabled = !on;
  btn.classList.toggle("active", on);
}

// 방법2: '하이라이트 해제' 버튼 — 하이라이트 모드일 때만 보이고, 하나라도 선택돼 있어야 활성.
function updateClearHighlightBtn(){
  const btn = document.getElementById("clearHighlightBtn");
  if(!btn) return;
  btn.style.display = rowHighlightOn ? "" : "none";
  const has = highlightedRows.size > 0;
  btn.disabled = !has;                 // 비활성: 눌러도 반응 없음
  btn.classList.toggle("active", has); // 활성: 강조 표시
}

// 헤더용 날짜 표기: "2025-04-12" → "2025.04.12"
function fmtHeaderDate(iso){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso||"").trim());
  return m ? `${m[1]}.${m[2]}.${m[3]}` : (iso||"");
}

function isEnded(p){
  // 공연 시작 + 러닝타임(meta.runningtime 분, 기본 180)이 지나면 종료로 본다.
  const start = new Date(`${p.date}T${p.time}:00`); // 로컬 시각으로 파싱
  if(isNaN(start.getTime())) return false;
  const mins = (performanceData && performanceData.runningtime) || 180;
  const end = new Date(start.getTime() + mins*60*1000);
  return end < new Date();
}
function hasSeat(p){
  return !!(p.seat && p.seat.trim()!=="");
}

/* =========================================================
   캐스트 데이터 해석 (문자열 / 배열 / (이름,비중) 배열 지원)
   ========================================================= */
function parseCastWeighted(entry){
  if(entry==null) return [];
  if(typeof entry === "string"){
    return entry.trim() ? [{name:entry.trim(), weight:null}] : [];
  }
  if(!Array.isArray(entry)) return [];
  if(entry.length===0) return [];

  const items = entry.map(item=>{
    if(typeof item === "string") return {name:item, weight:null};
    if(Array.isArray(item)) return {name:item[0], weight:(item.length>1 && item[1]!=null) ? Number(item[1]) : null};
    if(item && typeof item==="object") return {name:item.name, weight:item.weight!=null ? Number(item.weight) : null};
    return null;
  }).filter(Boolean);

  const specified = items.filter(it=>it.weight!=null);
  const unspecified = items.filter(it=>it.weight==null);
  const specifiedSum = specified.reduce((s,it)=>s+it.weight, 0);
  if(unspecified.length>0){
    const remain = Math.max(0, 10-specifiedSum);
    const share = remain/unspecified.length;
    unspecified.forEach(it=>{ it.weight = share; });
  }
  return items;
}

/* === 대결(match) 유틸 === */
// 지점(point)에 해당하는 그 배역의 참여 배우: 캐스팅 순서대로 비중을 누적해 point가 속한 구간의 배우.
function matchParticipant(perf, role, point){
  const items = parseCastWeighted(perf && perf.cast ? perf.cast[role] : null).filter(it=>it.weight>0);
  if(items.length===0) return null;
  let cum = 0;
  for(const it of items){ cum += it.weight; if(point <= cum + 1e-9) return it.name; }
  return items[items.length-1].name;
}
// 공연의 매치 승자(배역명 | "무승부" | null). 옵션 켜진 완료공연 미기록은 defaultWinner로 간주.
function matchWinnerOf(perf, match){
  const res = perf.match && perf.match[match.name];
  let winner = (res && res.winner) ? res.winner : null;
  if(!winner && matchAssumeDefaultWin && isEnded(perf)) winner = match.defaultWinner;
  return winner;
}
// 특정 배역(role) 관점의 결과: 'win' | 'loss' | 'draw' | 'none'(미반영)
function matchRoleResult(perf, match, role){
  const w = matchWinnerOf(perf, match);
  if(!w) return 'none';
  if(w === '무승부') return 'draw';
  return w === role ? 'win' : 'loss';
}
// 배역별 결과 색(너무 튀지 않게 채도 낮춘 팔레트). 매치 내 roles 순서로 배정.
const MATCH_ROLE_COLORS = ['#caa15a','#7f9fc4','#8ab38f','#c58aa6','#a99ad0','#cf9a6a'];
function matchRoleColor(match, role){
  const i = match.roles.indexOf(role);
  return MATCH_ROLE_COLORS[(i<0?0:i) % MATCH_ROLE_COLORS.length];
}

function castNamesOf(entry){
  return parseCastWeighted(entry).map(it=>it.name);
}

// 비중이 0인(실제로 출연하지 않은) 배우는 제외한 이름 목록 - 스케줄 표시/필터용
function castVisibleNamesOf(entry){
  return parseCastWeighted(entry).filter(it=>it.weight>0).map(it=>it.name);
}

// 캐스트 통계 모드에 따른 이름 목록 (배역 조합 매칭에 사용)
function castNamesForMode(entry, mode){
  const items = parseCastWeighted(entry);
  if(!items.length) return [];
  if(mode==="first") return [items[0].name];
  if(mode==="start"){
    const s = items.find(it=>it.weight>0);
    return s ? [s.name] : [];
  }
  // 'all' | 'weighted': 비중 0 제외한 전체
  return items.filter(it=>it.weight>0).map(it=>it.name);
}

// mode: 'first' | 'start' | 'all' | 'weighted'
function getCastContributions(entry, mode){
  const items = parseCastWeighted(entry);
  if(items.length===0) return [];
  if(mode==="first"){
    return [{name:items[0].name, amount:1}];
  }
  if(mode==="start"){
    let chosen = items.find(it=>it.weight>0);
    if(!chosen) chosen = items[items.length-1];
    return [{name:chosen.name, amount:1}];
  }
  if(mode==="weighted"){
    return items.map(it=>({name:it.name, amount:it.weight/10}));
  }
  return items.map(it=>({name:it.name, amount:1})); // 'all' (기본값)
}

function fmtStatValue(v){
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

let castStatsMode = "all"; // 'first' | 'start' | 'all' | 'weighted'
let matchAssumeDefaultWin = false; // 대결: 결과 미기록 완료공연을 defaultWinner 승리로 간주
let matchStatsOrder = [];          // 대결 통계 블록 표시 순서(키 배열)
let collapsedMatchStats = new Set(); // 닫힌 대결 통계 블록 키

function renderStats(){
  const perfs = performanceData.performances;
  const totalShows = perfs.length;
  const endedShows = perfs.filter(isEnded).length;
  const watchedShows = perfs.filter(p=>isEnded(p) && hasSeat(p)).length;
  const upcomingShows = perfs.filter(p=>!isEnded(p) && hasSeat(p)).length;

  document.getElementById("statTopCards").innerHTML = `
    <div class="stat-card"><div class="label">전체</div><div class="value">${totalShows}</div></div>
    <div class="stat-card"><div class="label">종료</div><div class="value">${endedShows}</div></div>
    <div class="stat-card"><div class="label">관극</div><div class="value">${watchedShows}</div></div>
    <div class="stat-card"><div class="label">예매</div><div class="value">${upcomingShows}</div></div>
  `;

  // 총 티켓 금액: 종료된 공연(지금까지 쓴 것) / 미래 공연(앞으로 쓸 것) / 전체
  let spentAmount = 0, upcomingAmount = 0;
  perfs.forEach(p=>{
    const price = ticketPriceOf(p.seat, p.ticketType, p.ticketFee, (p.ticketDiscount!=null?p.ticketDiscount:null), p.ticketExtra) || 0;
    if(isEnded(p)) spentAmount += price; else upcomingAmount += price;
  });
  document.getElementById("ticketTotals").innerHTML = `
    <div class="tt-card"><div class="label">지금까지 쓴 금액</div><div class="value">${formatKRW(spentAmount)}</div></div>
    <div class="tt-card"><div class="label">앞으로 쓸 금액</div><div class="value">${formatKRW(upcomingAmount)}</div></div>
    <div class="tt-card total"><div class="label">전체</div><div class="value">${formatKRW(spentAmount + upcomingAmount)}</div></div>
  `;

  const now = new Date();

  const modeSelect = document.getElementById("castStatsModeSelect");
  if(modeSelect){
    modeSelect.value = castStatsMode;
    modeSelect.onchange = ()=>{
      castStatsMode = modeSelect.value;
      saveState();
      renderStats();
      renderComboResults();
    };
  }

  const roleStatsEl = document.getElementById("roleStats");
  roleStatsEl.innerHTML = roleStatsOrder.map((roleName, orderIdx)=>{
    const c = performanceData.casts.find(cast=>cast.role===roleName);
    const stats = {};
    c.actors.forEach(a=>{ stats[a.name] = {total:0, ended:0, watched:0, upcoming:0}; });

    perfs.forEach(p=>{
      const contributions = getCastContributions(p.cast[c.role], castStatsMode);
      const ended = isEnded(p);
      const seated = hasSeat(p);
      contributions.forEach(({name:n, amount})=>{
        if(!stats[n]) stats[n] = {total:0, ended:0, watched:0, upcoming:0};
        stats[n].total += amount;
        if(ended){
          stats[n].ended += amount;
          if(seated) stats[n].watched += amount;
        } else {
          if(seated) stats[n].upcoming += amount;
        }
      });
    });

    const hiddenActors = hiddenStatActors[c.role] || new Set();
    const rows = Object.entries(stats)
      .filter(([name])=>!hiddenActors.has(name))
      .sort((a,b)=>b[1].total-a[1].total)
      .map(([name,s])=>{
        const actorInfo = c.actors.find(a=>a.name===name);
        const roleTag = actorInfo ? actorInfo.role : "";
        return `
          <tr>
            <td>
              ${name}<br><small style="color:var(--ink-dim); font-size:10px;">${roleTag}</small>
            </td>
            <td>${fmtStatValue(s.total)}</td>
            <td>${fmtStatValue(s.ended)}</td>
            <td>${fmtStatValue(s.watched)}</td>
            <td>${fmtStatValue(s.upcoming)}</td>
          </tr>
        `;
      }).join("");

    const isCollapsed = collapsedRoles.has(c.role);
    return `
      <div class="role-stat-block" draggable="true" data-idx="${orderIdx}" style="margin-bottom:14px; cursor:grab;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span class="role-drag-handle" style="color:var(--ink-dim); font-size:22px; line-height:1; cursor:grab; padding:4px 8px;">&#8942;&#8942;</span>
          <button class="role-toggle" data-role="${c.role}" style="display:flex; align-items:center; gap:6px; background:none; border:none; cursor:pointer; padding:0; font-size:13px; font-weight:700; color:var(--gold); flex:1; text-align:left;">
            <span class="role-toggle-arrow">${isCollapsed ? "&#9656;" : "&#9662;"}</span> ${c.role}
          </button>
          ${(c.role==="빌리"||c.role==="마이클") ? "" : `<button class="role-stat-del-btn stat-del-btn" data-role="${c.role}" title="${c.role} 삭제">삭제</button>`}
        </div>
        <table class="role-stat-table" style="${isCollapsed ? 'display:none;' : ''}">
          <thead><tr><th>배우 이름</th><th>전체</th><th>종료</th><th>관극</th><th>예매</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }).join("") + `<div class="role-drop-end" style="height:24px;"></div>`;

  roleStatsEl.querySelectorAll(".role-stat-del-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.stopPropagation();
      const role = btn.dataset.role;
      roleStatsOrder = roleStatsOrder.filter(r=>r!==role);
      saveState();
      renderStats();
    });
  });

  roleStatsEl.querySelectorAll(".role-toggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const role = btn.dataset.role;
      if(collapsedRoles.has(role)) collapsedRoles.delete(role);
      else collapsedRoles.add(role);
      renderStats();
      saveState();
    });
  });

  let dragFromIdx = null;
  roleStatsEl.querySelectorAll(".role-stat-block").forEach(block=>{
    block.addEventListener("dragstart", e=>{
      dragFromIdx = +block.dataset.idx;
      block.style.opacity = "0.4";
      e.dataTransfer.effectAllowed = "move";
    });
    block.addEventListener("dragend", ()=>{
      block.style.opacity = "";
    });
    block.addEventListener("dragover", e=>{
      e.preventDefault();
      e.stopPropagation();
      block.style.borderTop = "2px solid var(--gold)";
    });
    block.addEventListener("dragleave", ()=>{
      block.style.borderTop = "";
    });
    block.addEventListener("drop", e=>{
      e.preventDefault();
      e.stopPropagation();
      block.style.borderTop = "";
      const dropIdx = +block.dataset.idx;
      if(dragFromIdx===null || dragFromIdx===dropIdx) return;
      const moved = roleStatsOrder.splice(dragFromIdx,1)[0];
      roleStatsOrder.splice(dropIdx,0,moved);
      dragFromIdx = null;
      renderStats();
      saveState();
    });
  });

  const dropEnd = roleStatsEl.querySelector(".role-drop-end");
  dropEnd.addEventListener("dragover", e=>{
    e.preventDefault();
    dropEnd.style.borderTop = "2px solid var(--gold)";
  });
  dropEnd.addEventListener("dragleave", ()=>{
    dropEnd.style.borderTop = "";
  });
  dropEnd.addEventListener("drop", e=>{
    e.preventDefault();
    dropEnd.style.borderTop = "";
    if(dragFromIdx===null) return;
    const moved = roleStatsOrder.splice(dragFromIdx,1)[0];
    roleStatsOrder.push(moved);
    dragFromIdx = null;
    renderStats();
    saveState();
  });

  roleStatsEl.addEventListener("dragover", e=>{
    e.preventDefault();
  });
  roleStatsEl.addEventListener("drop", e=>{
    e.preventDefault();
    if(dragFromIdx===null) return;
    const moved = roleStatsOrder.splice(dragFromIdx,1)[0];
    roleStatsOrder.push(moved);
    dragFromIdx = null;
    renderStats();
    saveState();
  });

  renderMatchStats();
}

/* 대결(match) 통계: 배역별 표(승률 정렬) + 주배역×서브배역 조합 표(주배역=단독순서, rowspan).
   각 표 블록은 드래그로 순서 변경·닫기(접기) 가능. 완료(종료) 공연만 집계. */
function renderMatchStats(){
  const el = document.getElementById("matchStats");
  if(!el) return;
  const matches = performanceData.matches || [];

  const optEl = document.getElementById("matchAssumeWin");
  if(optEl){
    optEl.checked = matchAssumeDefaultWin;
    optEl.onchange = ()=>{ matchAssumeDefaultWin = optEl.checked; saveState(); renderMatchStats(); };
  }

  if(matches.length===0){ el.innerHTML = `<p style="color:var(--ink-dim); font-size:13px;">정의된 대결이 없습니다.</p>`; return; }

  const ended = performanceData.performances.filter(isEnded);
  const rateNum = s => { const d=s.win+s.loss+s.draw; return d>0 ? s.win/d : -1; };
  const rateStr = s => { const d=s.win+s.loss+s.draw; return d>0 ? Math.round(s.win/d*100)+"%" : "-"; };
  const tallyResult = (s, r)=>{ s.total++; if(r==='win')s.win++; else if(r==='loss')s.loss++; else if(r==='draw')s.draw++; };

  function roleStatsOf(m, role){
    const acc={};
    ended.forEach(p=>{
      const actor=matchParticipant(p,role,m.point); if(!actor) return;
      const s=acc[actor]||(acc[actor]={total:0,win:0,loss:0,draw:0});
      tallyResult(s, matchRoleResult(p,m,role));
    });
    return acc;
  }
  const sortByRate = acc => Object.keys(acc).sort((a,b)=> rateNum(acc[b])-rateNum(acc[a]) || acc[b].total-acc[a].total);

  // 블록(표) 목록 + 저장된 순서 적용
  const allBlocks=[];
  matches.forEach(m=>{
    m.roles.forEach(role=>allBlocks.push({key:m.name+"::"+role, type:'role', m, role}));
    if(m.roles.length>=2) allBlocks.push({key:m.name+"::__combo__", type:'combo', m});
  });
  const order=[];
  matchStatsOrder.forEach(k=>{ const b=allBlocks.find(x=>x.key===k); if(b&&order.indexOf(b)<0) order.push(b); });
  allBlocks.forEach(b=>{ if(order.indexOf(b)<0) order.push(b); });

  el.innerHTML = order.map(b=>{
    const collapsed = collapsedMatchStats.has(b.key);
    let title, tableHtml;
    if(b.type==='role'){
      const acc = roleStatsOf(b.m, b.role);
      title = `${b.m.name} 대결 · ${b.role} 승리`;
      const rows = sortByRate(acc).map(n=>{ const s=acc[n];
        return `<tr><td>${n}</td><td>${s.total}</td><td>${s.win}</td><td>${s.loss}</td><td>${s.draw}</td><td>${rateStr(s)}</td></tr>`; }).join("")
        || `<tr><td colspan="6" style="color:var(--ink-dim);">기록 없음</td></tr>`;
      tableHtml = `<table class="role-stat-table"><thead><tr><th>배우</th><th>전체</th><th>승</th><th>패</th><th>무</th><th>승률</th></tr></thead><tbody>${rows}</tbody></table>`;
    } else {
      const m=b.m, main=m.roles[0], sub=m.roles[1];
      title = `${m.name} 대결 · ${main}×${sub} 승리`;
      const pair={};
      ended.forEach(p=>{
        const a0=matchParticipant(p,main,m.point), a1=matchParticipant(p,sub,m.point);
        if(!a0||!a1) return;
        const byMain=pair[a0]||(pair[a0]={});
        const s=byMain[a1]||(byMain[a1]={total:0,win:0,loss:0,draw:0});
        tallyResult(s, matchRoleResult(p,m,main));
      });
      const mainOrder = sortByRate(roleStatsOf(m, main));
      let rows="";
      mainOrder.forEach(a0=>{
        const byMain=pair[a0]; if(!byMain) return;
        const subs=Object.keys(byMain).sort((x,y)=> rateNum(byMain[y])-rateNum(byMain[x]) || byMain[y].total-byMain[x].total);
        subs.forEach((a1,si)=>{ const s=byMain[a1];
          const firstTd = si===0 ? `<td rowspan="${subs.length}">${a0}</td>` : "";
          rows += `<tr>${firstTd}<td>${a1}</td><td>${s.total}</td><td>${s.win}</td><td>${s.loss}</td><td>${s.draw}</td><td>${rateStr(s)}</td></tr>`;
        });
      });
      if(!rows) rows = `<tr><td colspan="7" style="color:var(--ink-dim);">기록 없음</td></tr>`;
      tableHtml = `<table class="role-stat-table"><thead><tr><th>${main}</th><th>${sub}</th><th>전체</th><th>승</th><th>패</th><th>무</th><th>승률</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `
      <div class="match-stat-block" draggable="true" data-key="${b.key}" style="margin-bottom:14px; cursor:grab;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span class="role-drag-handle" style="color:var(--ink-dim); font-size:22px; line-height:1; cursor:grab; padding:4px 8px;">&#8942;&#8942;</span>
          <button class="match-toggle" data-key="${b.key}" style="display:flex; align-items:center; gap:6px; background:none; border:none; cursor:pointer; padding:0; font-size:13px; font-weight:700; color:var(--gold); flex:1; text-align:left;">
            <span>${collapsed ? "&#9656;" : "&#9662;"}</span> ${title}
          </button>
        </div>
        <div style="${collapsed ? 'display:none;' : ''}">${tableHtml}</div>
      </div>`;
  }).join("");

  el.querySelectorAll(".match-toggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const k=btn.dataset.key;
      if(collapsedMatchStats.has(k)) collapsedMatchStats.delete(k); else collapsedMatchStats.add(k);
      saveState(); renderMatchStats();
    });
  });
  let dragKey=null;
  el.querySelectorAll(".match-stat-block").forEach(block=>{
    block.addEventListener("dragstart", ()=>{ dragKey=block.dataset.key; block.style.opacity="0.4"; });
    block.addEventListener("dragend", ()=>{ block.style.opacity=""; });
    block.addEventListener("dragover", e=>{ e.preventDefault(); block.style.borderTop="2px solid var(--gold)"; });
    block.addEventListener("dragleave", ()=>{ block.style.borderTop=""; });
    block.addEventListener("drop", e=>{
      e.preventDefault(); block.style.borderTop="";
      const dropKey=block.dataset.key;
      if(!dragKey || dragKey===dropKey) return;
      const keys=order.map(x=>x.key);
      keys.splice(keys.indexOf(dropKey), 0, keys.splice(keys.indexOf(dragKey), 1)[0]);
      matchStatsOrder=keys; dragKey=null; saveState(); renderMatchStats();
    });
  });
}

/* =========================================================
   SEAT MAP PAGE
   ========================================================= */
// 좌석 입력값이 "층-행-번호" 양식이고 실제 등록된 좌석인지 검사. 빈 값은 오류 아님.
let _seatIdSet = null;
function isValidSeat(seatId){
  const id = (seatId||"").trim();
  if(!id) return true;                       // 미입력은 오류로 보지 않음
  if(!/^\d+-\d+-\d+$/.test(id)) return false; // 양식 불일치
  if(!_seatIdSet) _seatIdSet = new Set(seatmapData.seats.map(s=>s.id));
  return _seatIdSet.has(id);                  // 등록된 좌석인지
}

// 좌석 입력값에 따라 눈 버튼의 색/투명도/경고(!) 표시를 갱신한다(입력 중 실시간 반영).
function applyEyeState(btn, value){
  if(!btn) return;
  const valid = isValidSeat(value);
  const hasValue = !!(value||"").trim();
  btn.classList.toggle("invalid", !valid);
  btn.title = valid ? "좌석표에서 보기" : "등록되지 않은 좌석입니다";
  let warn = btn.querySelector(".seat-eye-warn");
  if(!valid){
    if(!warn){ warn = document.createElement("span"); warn.className = "seat-eye-warn"; warn.textContent = "!"; btn.appendChild(warn); }
    btn.style.color = "#e0594a";
    btn.style.opacity = "1";
  } else {
    if(warn) warn.remove();
    btn.style.color = hasValue ? "var(--gold)" : "var(--ink-dim)";
    btn.style.opacity = hasValue ? "1" : "0.3";
  }
}

function gradeOf(seatId){
  for(const g of performanceData.grades){
    if(g.seatIds.includes(seatId)) return g.name;
  }
  return null;
}
function gradeClass(gname){
  return {VIP:"vip", R:"r", S:"s", A:"a"}[gname] || "";
}

function gradeFillVar(gname){
  // 등급 색은 CSS 테마 변수로 위임(--g-vip 등). data-theme 교체 시 자동 반영.
  const k = gradeClass(gname) || "none";
  return `var(--g-${k})`;
}

function watchCountOf(seatId){
  return performanceData.performances.filter(p=>p.seat===seatId && isEnded(p)).length;
}

function seatVisualStyle(count){
  // 미관극(0회) 좌석의 흐림 정도. 관극한 좌석은 히트맵 색(아래 countHeatColor)으로 표시.
  if(count<=0) return { opacity:0.30 };
  return { opacity: 1 };
}

// 관극 횟수(1~10) → 이산 히트맵 색. 저관극에서 색차가 크도록(파랑→청록→초록…) 설계해
// 1↔2 구분이 9↔10 구분보다 더 뚜렷하다(고관극 빨강→자홍은 단계 차가 작음).
const COUNT_HEAT = ['#4aa3ff','#2fd0c8','#46c84e','#c2d92a','#ffd21f','#ff9a1f','#ff6322','#ef3b2f','#d81e4a','#b3126e'];
function countHeatColor(count){
  return COUNT_HEAT[Math.max(1, Math.min(10, count)) - 1];
}

function buildSeatSvgInner(highlightSeatId){
  const SEAT_SIZE = 0.78;
  const HALF = SEAT_SIZE/2;

  function seatMarkup(s){
    const g = gradeOf(s.id);
    const count = seatMapCount(s.id);
    const isHighlighted = s.id===highlightSeatId;
    const fill = gradeFillVar(g); // 좌석 채움은 등급 색(테두리 없음)
    const opacity = isHighlighted ? 1 : seatVisualStyle(count).opacity; // 관극=불투명, 미관극=흐림
    const extra = isHighlighted ? `<rect x="${-HALF-0.12}" y="${-HALF-0.12}" width="${SEAT_SIZE+0.24}" height="${SEAT_SIZE+0.24}" rx="0.12" fill="none" stroke="#fff" stroke-width="0.12"></rect>` : "";
    // 관극 횟수: 숫자를 적은 동그라미 '안'을 횟수 색(히트맵)으로 칠한다. 숫자는 흰 글자(외곽선으로 가독).
    const badge = (!isHighlighted && count>0)
      ? `<circle cx="${HALF*0.8}" cy="${-HALF*0.8}" r="0.3" fill="${countHeatColor(count)}" stroke="rgba(0,0,0,0.45)" stroke-width="0.03"></circle>`
        + `<text x="${HALF*0.8}" y="${-HALF*0.8+0.12}" text-anchor="middle" font-size="0.34" font-weight="800" fill="#fff" stroke="rgba(0,0,0,0.5)" stroke-width="0.025" paint-order="stroke">${count}</text>`
      : "";
    // 번호: 관극한 좌석만 흰 외곽선(halo)으로 가독 강조. 본 적 없는(흐린) 좌석은 외곽선 없이 깔끔하게.
    const numHalo = count>0 ? ` stroke="rgba(255,255,255,0.75)" stroke-width="0.07" paint-order="stroke"` : "";
    const numberLabel = `<text class="seat-num-text" x="0" y="0.17" text-anchor="middle" font-size="0.48" font-weight="700" fill="rgba(20,20,20,0.85)"${numHalo} style="pointer-events:none; display:${showSeatNumbers?'':'none'};">${s.column}</text>`;
    return `
      <g class="svg-seat" data-seat-id="${s.id}" transform="translate(${s.svgX},${s.svgY}) rotate(${s.svgRot})" style="cursor:pointer;">
        <title>${s.id} &middot; ${count}회 관극</title>
        <rect x="${-HALF}" y="${-HALF}" width="${SEAT_SIZE}" height="${SEAT_SIZE}" rx="0.1" opacity="${opacity}" style="fill:${fill}"></rect>
        ${extra}
        ${numberLabel}
        ${badge}
      </g>
    `;
  }

  const floors = [1,2,3];
  const LABEL_ONLY_H = 1.4; // 좌석을 숨긴 층의 축소된 박스 높이 (라벨만 보임)
  const FLOOR_VISUAL_GAP = 1.0;
  const BOTTOM_EXTRA = 7; // 3층 아래 여유 공간 (미니맵이 좌석을 가리지 않도록)

  // 1차: 각 층의 원래 경계 계산 (가장 넓은 층의 너비로 모두 통일)
  const floorBoxes = {};
  let maxBw = 0;
  floors.forEach(floor=>{
    const seats = seatmapData.seats.filter(s=>s.floor===floor);
    const xs = seats.map(s=>s.svgX), ys = seats.map(s=>s.svgY);
    const pad = 0.9;
    const bx = Math.min(...xs)-pad, by = Math.min(...ys)-pad;
    const bw = Math.max(...xs)-bx+pad, bh = Math.max(...ys)-by+pad;
    const cx = bx + bw/2;
    floorBoxes[floor] = { bx, by, bw, bh, cx };
    if(bw > maxBw) maxBw = bw;
  });

  // 2차: 숨긴 층은 라벨만 남기고 박스를 줄여서, 아래 층들이 위로 채워지도록 다시 쌓기
  let cum = 0;
  const layout = {};
  floors.forEach(floor=>{
    const isHidden = hiddenFloors.has(String(floor));
    const box = floorBoxes[floor];
    const thisH = isHidden ? LABEL_ONLY_H : box.bh;
    const deltaY = cum - box.by;
    layout[floor] = { isHidden, thisH, deltaY, box };
    cum += thisH + FLOOR_VISUAL_GAP;
  });
  const totalHeight = cum - FLOOR_VISUAL_GAP + BOTTOM_EXTRA;

  // 모든 층 박스가 항상 같은 위치/너비를 갖도록 공유 중심선을 사용한다 (켜고 끌 때도 동일)
  const sharedCx = floors.reduce((sum,f)=>sum+floorBoxes[f].cx, 0) / floors.length;
  const sharedBx = sharedCx - maxBw/2;
  const bxMin = sharedBx, bxMax = sharedBx + maxBw;

  const bboxPad = 1;
  const dynamicBBox = {
    x: bxMin - bboxPad,
    y: -bboxPad,
    w: (bxMax-bxMin) + bboxPad*2,
    h: totalHeight + bboxPad
  };

  const markup = floors.map(floor=>{
    const seats = seatmapData.seats.filter(s=>s.floor===floor);
    const meta = seatmapData.floorMeta[floor];
    const { isHidden, thisH, deltaY, box } = layout[floor];
    const bw = maxBw;
    const bx = sharedBx;
    const by = box.by;

    const border = `<rect x="${bx}" y="${by}" width="${bw}" height="${thisH}" rx="0.6" fill="none" stroke="var(--line)" stroke-width="0.06"></rect>
      <text x="${bx+0.35}" y="${by+0.55}" font-size="0.5" font-weight="700" fill="var(--gold)">${floor}F${isHidden ? ' (숨김)' : ''}</text>`;

    let rowLabels = "";
    let seatMarkupStr = "";
    if(!isHidden){
      const labels = [];
      for(let r=1; r<=meta.centerMaxRow; r++){
        const y = (seats.find(s=>s.floor===floor && s.row===r && s.column>=16) || {}).svgY;
        if(y===undefined) continue;
        labels.push(`<text x="${meta.centerOriginX-0.5}" y="${y+0.14}" text-anchor="end" font-size="0.32" fill="var(--ink-dim)">${r}</text>`);
        labels.push(`<text x="${meta.centerOriginX+meta.centerWidth+0.5}" y="${y+0.14}" text-anchor="start" font-size="0.32" fill="var(--ink-dim)">${r}</text>`);
      }
      rowLabels = labels.join("");
      seatMarkupStr = seats.map(seatMarkup).join("");
    }

    return `<g class="floor-group" data-floor="${floor}" transform="translate(0,${deltaY})">${border}${rowLabels}${seatMarkupStr}</g>`;
  }).join("");

  return { markup, bbox: dynamicBBox };
}

let mainViewBox = null;
let pendingSeatViewBox = null; // 새로고침 복원용: 저장된 시트맵 뷰(첫 렌더에서 1회 적용)
let showSeatNumbers = true; // 좌석번호 기본 표시
let hiddenFloors = new Set(); // 토글로 숨긴 층 (문자열 "1","2","3")
let minimapVisible = true; // 미니맵 표시 여부

// 좌석맵 표시 토글/필터
let seatShowWatched = true;  // 관극: 종료된 공연 좌석 표시
let seatShowBooked = true;   // 예매: 아직 종료되지 않은(미래) 공연 좌석 표시
let seatMapFilter = {};      // 배역 -> Set(배우 이름) (필터)
let seatMapFilterActive = false; // 필터 적용 여부

// 공연 p가 좌석맵 배역 필터에 맞는지 (같은 배역 OR, 서로 다른 배역 AND)
function seatPerfMatchesFilter(p){
  if(!seatMapFilterActive) return true;
  for(const role in seatMapFilter){
    const sel = seatMapFilter[role];
    if(sel && sel.size>0){
      const names = castVisibleNamesOf(p.cast[role]);
      if(!names.some(n=>sel.has(n))) return false;
    }
  }
  return true;
}

// 좌석맵에서 한 좌석에 표시될 공연 수 (관극/예매 토글 + 필터 반영)
function seatMapCount(seatId){
  return performanceData.performances.filter(p=>{
    if(p.seat!==seatId) return false;
    const ended = isEnded(p);
    if(ended && !seatShowWatched) return false;
    if(!ended && !seatShowBooked) return false;
    return seatPerfMatchesFilter(p);
  }).length;
}

// 필터에 선택된 배우 총 수 (버튼 배지용)
function seatMapFilterSelectedCount(){
  let n = 0;
  for(const role in seatMapFilter){ if(seatMapFilter[role]) n += seatMapFilter[role].size; }
  return n;
}

let seatFilterTemp = {}; // 필터 모달에서 편집 중인 임시 선택

function updateSeatFilterButton(){
  const btn = document.getElementById("seatFilterBtn");
  const badge = document.getElementById("seatFilterCount");
  if(!btn || !badge) return;
  const n = seatMapFilterSelectedCount();
  const on = seatMapFilterActive && n > 0;
  btn.classList.toggle("active", on);
  if(on){ badge.textContent = n; badge.style.display = ""; }
  else { badge.style.display = "none"; }
}

function renderSeatFilterBody(){
  const body = document.getElementById("seatFilterBody");
  body.innerHTML = performanceData.casts.map(c=>{
    const role = c.role;
    const sel = seatFilterTemp[role] || new Set();
    const actors = c.actors.filter(a=> a.role==="cast"
      || performanceData.performances.some(p=>castVisibleNamesOf(p.cast[role]).includes(a.name)));
    return `
      <div class="filter-role">
        <div class="filter-role-title">${role}</div>
        <div class="filter-actor-list">
          ${actors.map(a=>`<label class="filter-actor"><input type="checkbox" data-role="${role}" data-actor="${a.name}" ${sel.has(a.name)?'checked':''}> ${a.name}</label>`).join("")}
        </div>
      </div>`;
  }).join("");
  body.querySelectorAll("input[type=checkbox]").forEach(cb=>{
    cb.addEventListener("change", ()=>{
      const role = cb.dataset.role, actor = cb.dataset.actor;
      if(!seatFilterTemp[role]) seatFilterTemp[role] = new Set();
      if(cb.checked) seatFilterTemp[role].add(actor); else seatFilterTemp[role].delete(actor);
    });
  });
}

function openSeatFilter(){
  seatFilterTemp = {};
  Object.entries(seatMapFilter).forEach(([k,v])=>{ seatFilterTemp[k] = new Set(v); });
  renderSeatFilterBody();
  document.getElementById("seatFilterModal").style.display = "flex";
}
function closeSeatFilter(){
  document.getElementById("seatFilterModal").style.display = "none";
}
function applySeatFilter(){
  seatMapFilter = {};
  Object.entries(seatFilterTemp).forEach(([k,v])=>{ if(v && v.size>0) seatMapFilter[k] = new Set(v); });
  seatMapFilterActive = seatMapFilterSelectedCount() > 0;
  updateSeatFilterButton();
  closeSeatFilter();
  renderSeatMap(true);
  saveState();
}

function updateMinimapVisibility(){
  const wrap = document.getElementById("minimapWrap");
  const btn = document.getElementById("minimapToggleBtn");
  if(wrap) wrap.classList.toggle("hidden", !minimapVisible);
  if(btn) btn.classList.toggle("active", minimapVisible);
}

function vbString(vb){ return `${vb.x} ${vb.y} ${vb.w} ${vb.h}`; }

// 시트맵 뷰 변경이 잦으므로(드래그·핀치·휠) 디바운스로 저장 — 모든 변경의 단일 지점 applyMainViewBox에서 호출.
let _seatViewSaveTimer = null;
function saveSeatViewDebounced(){
  if(_seatViewSaveTimer) clearTimeout(_seatViewSaveTimer);
  _seatViewSaveTimer = setTimeout(saveState, 250);
}

function applyMainViewBox(){
  document.getElementById("mainSeatSvg").setAttribute("viewBox", vbString(mainViewBox));
  const indicator = document.getElementById("minimapIndicator");
  if(indicator){
    indicator.setAttribute("x", mainViewBox.x);
    indicator.setAttribute("y", mainViewBox.y);
    indicator.setAttribute("width", mainViewBox.w);
    indicator.setAttribute("height", mainViewBox.h);
  }
  saveSeatViewDebounced(); // 위치·배율 저장(새로고침 시 유지)
}

function clampViewBox(vb){
  const minW = SEAT_BBOX.w*0.12, maxW = SEAT_BBOX.w;
  vb.w = Math.max(minW, Math.min(maxW, vb.w));
  vb.h = vb.w * (SEAT_BBOX.h/SEAT_BBOX.w);
  vb.x = Math.max(SEAT_BBOX.x, Math.min(SEAT_BBOX.x+SEAT_BBOX.w-vb.w, vb.x));
  vb.y = Math.max(SEAT_BBOX.y, Math.min(SEAT_BBOX.y+SEAT_BBOX.h-vb.h, vb.y));
  return vb;
}

function zoomBy(factor, centerX, centerY){
  const newW = mainViewBox.w*factor;
  const newH = mainViewBox.h*factor;
  mainViewBox = clampViewBox({
    x: centerX - (centerX-mainViewBox.x)*factor,
    y: centerY - (centerY-mainViewBox.y)*factor,
    w: newW, h: newH
  });
  applyMainViewBox();
}

function computeInitialViewBox(){
  const viewport = document.getElementById("svgViewport");
  const rectW = viewport.clientWidth || 360;
  const rectH = viewport.clientHeight || 440;
  const meta = seatmapData.floorMeta[1];
  const desiredUnits = meta.centerWidth + 6; // 중앙 구역 전체 + 좌우 3칸씩
  const MOBILE_REF_PX = 390; // 모바일 화면 기준 너비
  const ZOOM_OUT_STEPS = 3; // 기본 배율을 3단계 더 낮춰서 더 넓게 보이게 함
  const pxPerUnit = (MOBILE_REF_PX / desiredUnits) / Math.pow(1.25, ZOOM_OUT_STEPS);
  const vbWidth = rectW / pxPerUnit;
  const vbHeight = rectH / pxPerUnit;
  return clampViewBox({
    x: meta.centerOriginX + meta.centerWidth/2 - vbWidth/2,
    y: SEAT_BBOX.y, // 위쪽 정렬: 1층 맨 앞줄부터 보이도록
    w: vbWidth,
    h: vbHeight
  });
}

function renderSeatMap(preserveZoom){
  const mainSvg = document.getElementById("mainSeatSvg");
  const minimapSvg = document.getElementById("minimapSvg");
  const prevViewBox = preserveZoom && mainViewBox ? { ...mainViewBox } : null;

  const { markup: seatInner, bbox } = buildSeatSvgInner(null);
  SEAT_BBOX = bbox;

  mainSvg.setAttribute("viewBox", vbString(SEAT_BBOX));
  mainSvg.innerHTML = seatInner;

  minimapSvg.setAttribute("viewBox", vbString(SEAT_BBOX));
  minimapSvg.innerHTML = seatInner + `<rect id="minimapIndicator" stroke-width="${SEAT_BBOX.w*0.01}"></rect>`;
  minimapSvg.querySelectorAll(".svg-seat").forEach(el=>el.style.pointerEvents = "none");

  if(prevViewBox){
    // 배율(너비/높이)은 유지하고, 위치만 새 좌석맵 범위 안으로 맞춘다.
    mainViewBox = clampViewBox({ x: prevViewBox.x, y: prevViewBox.y, w: prevViewBox.w, h: prevViewBox.h });
  } else if(pendingSeatViewBox){
    // 새로고침 복원: 저장된 뷰를 첫 렌더에서 1회 적용
    mainViewBox = clampViewBox({ ...pendingSeatViewBox });
    pendingSeatViewBox = null;
  } else {
    mainViewBox = computeInitialViewBox();
  }
  applyMainViewBox();
  updateMinimapVisibility();

  selectedSeatId = null; // 재렌더 시 선택 상태 초기화(박스가 사라지므로)
  mainSvg.querySelectorAll(".svg-seat").forEach(el=>{
    el.addEventListener("click", ()=>{
      if(svgDidDrag) return;
      const id = el.dataset.seatId;
      if(selectedSeatId === id){
        deselectSeat(mainSvg); // 같은 좌석 재클릭 → 선택 해제
      } else {
        selectSeatEl(mainSvg, el);
        showSeatDetail(id);
        selectedSeatId = id;
      }
    });
  });

  document.getElementById("seatLegend").innerHTML =
    performanceData.grades.map(g=>`<span><i style="background:${gradeFillVar(g.name)};"></i>${g.name}</span>`).join("")
    + `<span><i style="background:var(--g-none); opacity:0.30;"></i>본 적 없음</span>`
    + `<span class="legend-break"></span>`
    + `<span style="color:var(--ink-dim);">관극 횟수</span>`
    + `<span class="cnt-scale">` + [1,2,3,4,5,6,7,8,9,10].map(n=>`<span class="cnt-dot" style="background:${countHeatColor(n)};">${n}</span>`).join("") + `</span>`;

  setupSeatMapInteractions();
  setupFloorToggle();
}

let svgDidDrag = false;
let selectedSeatId = null; // 현재 선택된 좌석 id (재클릭 토글용)

// 좌석 선택 해제: 박스 제거 + 좌석 정보 패널 초기화.
function deselectSeat(mainSvg){
  mainSvg.querySelectorAll(".svg-seat.selected-seat").forEach(s=>{
    s.classList.remove("selected-seat");
    const b = s.querySelector(".seat-selbox");
    if(b) b.remove();
  });
  selectedSeatId = null;
  const detail = document.getElementById("seatDetail");
  if(detail) detail.innerHTML = `<h3>좌석 정보</h3><p class="empty-msg">좌석을 선택해 주세요.</p>`;
}

// 선택한 좌석을 흰색 네모 박스로 감싼다 (이전 선택 박스는 제거).
function selectSeatEl(mainSvg, el){
  mainSvg.querySelectorAll(".svg-seat.selected-seat").forEach(s=>{
    s.classList.remove("selected-seat");
    const old = s.querySelector(".seat-selbox");
    if(old) old.remove();
  });
  el.classList.add("selected-seat");
  const HALF = 0.39, PAD = 0.2; // SEAT_SIZE(0.78)/2 + 여백
  const box = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  box.setAttribute("class", "seat-selbox");
  box.setAttribute("x", (-HALF - PAD).toString());
  box.setAttribute("y", (-HALF - PAD).toString());
  box.setAttribute("width", (0.78 + PAD * 2).toString());
  box.setAttribute("height", (0.78 + PAD * 2).toString());
  box.setAttribute("rx", "0.08");
  box.setAttribute("fill", "none");
  box.setAttribute("stroke", "#fff");
  box.setAttribute("stroke-width", "0.16");
  box.setAttribute("pointer-events", "none");
  el.appendChild(box);
}

function setupFloorToggle(){
  document.querySelectorAll(".floor-toggle-btn[data-floor]").forEach(btn=>{
    const floor = btn.dataset.floor;
    btn.classList.toggle("active", !hiddenFloors.has(floor));

    btn.onclick = ()=>{
      if(hiddenFloors.has(floor)) hiddenFloors.delete(floor);
      else hiddenFloors.add(floor);
      saveState();
      renderSeatMap(true); // 좌석 reflow를 위해 재렌더링하되 배율은 유지
    };
  });

  const numBtn = document.getElementById("seatNumToggleBtn");
  numBtn.classList.toggle("active", showSeatNumbers);
  numBtn.onclick = ()=>{
    showSeatNumbers = !showSeatNumbers;
    numBtn.classList.toggle("active", showSeatNumbers);
    document.querySelectorAll(".seat-num-text").forEach(t=>{
      t.style.display = showSeatNumbers ? "" : "none";
    });
    saveState();
  };

  // 관극(종료된 공연) / 예매(미래 공연) 토글
  const watchedBtn = document.getElementById("seatWatchedBtn");
  watchedBtn.classList.toggle("active", seatShowWatched);
  watchedBtn.onclick = ()=>{ seatShowWatched = !seatShowWatched; saveState(); renderSeatMap(true); };
  const bookedBtn = document.getElementById("seatBookedBtn");
  bookedBtn.classList.toggle("active", seatShowBooked);
  bookedBtn.onclick = ()=>{ seatShowBooked = !seatShowBooked; saveState(); renderSeatMap(true); };

  // 배역 필터
  updateSeatFilterButton();
  document.getElementById("seatFilterBtn").onclick = openSeatFilter;
  document.getElementById("seatFilterCloseBtn").onclick = closeSeatFilter;
  document.getElementById("seatFilterResetBtn").onclick = ()=>{ seatFilterTemp = {}; renderSeatFilterBody(); };
  document.getElementById("seatFilterApplyBtn").onclick = applySeatFilter;
}

function setupSeatMapInteractions(){
  const mainSvg = document.getElementById("mainSeatSvg");
  const viewport = document.getElementById("svgViewport");

  document.getElementById("zoomInBtn").onclick = ()=>{
    zoomBy(0.8, mainViewBox.x+mainViewBox.w/2, mainViewBox.y+mainViewBox.h/2);
  };
  document.getElementById("zoomOutBtn").onclick = ()=>{
    zoomBy(1.25, mainViewBox.x+mainViewBox.w/2, mainViewBox.y+mainViewBox.h/2);
  };
  document.getElementById("zoomResetBtn").onclick = ()=>{
    mainViewBox = { ...SEAT_BBOX };
    applyMainViewBox();
    minimapVisible = false;
    updateMinimapVisibility();
    saveState();
  };

  document.getElementById("minimapToggleBtn").onclick = ()=>{
    minimapVisible = !minimapVisible;
    updateMinimapVisibility();
    saveState();
  };

  // 팬/핀치/휠 핸들러는 mainSvg 요소에 한 번만 등록(재렌더 시 중복 누적 방지).
  if(!mainSvg.dataset.panReady){
  mainSvg.dataset.panReady = "1";
  let isDragging = false, startScreenX=0, startScreenY=0, startVb=null;
  const activePointers = new Map();
  let pinchStartDist = null, pinchStartVb = null;

  mainSvg.addEventListener("pointerdown", e=>{
    activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

    if(activePointers.size===2){
      isDragging = false;
      // 핀치는 두 포인터를 캡처
      activePointers.forEach((_, id)=>{ try{ mainSvg.setPointerCapture(id); }catch(err){} });
      const pts = [...activePointers.values()];
      pinchStartDist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
      pinchStartVb = { ...mainViewBox };
      svgDidDrag = true;
    } else if(activePointers.size===1){
      // 단일 포인터: 아직 캡처하지 않는다(움직임이 없으면 좌석 click이 정상 발생하도록).
      isDragging = true;
      svgDidDrag = false;
      startScreenX = e.clientX;
      startScreenY = e.clientY;
      startVb = { ...mainViewBox };
    }
  });

  mainSvg.addEventListener("pointermove", e=>{
    if(!activePointers.has(e.pointerId)) return;
    activePointers.set(e.pointerId, { x:e.clientX, y:e.clientY });

    if(activePointers.size===2 && pinchStartDist){
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x-pts[1].x, pts[0].y-pts[1].y);
      const midX = (pts[0].x+pts[1].x)/2, midY = (pts[0].y+pts[1].y)/2;
      const rect = mainSvg.getBoundingClientRect();
      const scaleFactor = pinchStartDist / dist; // 손가락이 멀어지면(확대) factor<1
      const cx = pinchStartVb.x + ((midX-rect.left)/rect.width)*pinchStartVb.w;
      const cy = pinchStartVb.y + ((midY-rect.top)/rect.height)*pinchStartVb.h;
      mainViewBox = clampViewBox({
        x: cx - (cx-pinchStartVb.x)*scaleFactor,
        y: cy - (cy-pinchStartVb.y)*scaleFactor,
        w: pinchStartVb.w*scaleFactor,
        h: pinchStartVb.h*scaleFactor
      });
      applyMainViewBox();
      return;
    }

    if(!isDragging) return;
    const dxScreen = e.clientX - startScreenX;
    const dyScreen = e.clientY - startScreenY;
    if(!svgDidDrag && (Math.abs(dxScreen)>3 || Math.abs(dyScreen)>3)){
      // 드래그가 시작된 순간에만 포인터를 캡처(밖으로 나가도 추적). 클릭은 캡처 안 함.
      svgDidDrag = true;
      try{ mainSvg.setPointerCapture(e.pointerId); }catch(err){}
      mainSvg.classList.add("dragging");
    }
    const rect = mainSvg.getBoundingClientRect();
    const scaleX = startVb.w / rect.width;
    const scaleY = startVb.h / rect.height;
    mainViewBox = clampViewBox({
      x: startVb.x - dxScreen*scaleX,
      y: startVb.y - dyScreen*scaleY,
      w: startVb.w, h: startVb.h
    });
    applyMainViewBox();
  });

  function endPointer(e){
    activePointers.delete(e.pointerId);
    if(activePointers.size<2){ pinchStartDist = null; pinchStartVb = null; }
    if(activePointers.size===0){
      isDragging = false;
      mainSvg.classList.remove("dragging");
    }
    try{ mainSvg.releasePointerCapture(e.pointerId); }catch(err){}
  }
  mainSvg.addEventListener("pointerup", endPointer);
  mainSvg.addEventListener("pointercancel", endPointer);
  mainSvg.addEventListener("pointerleave", endPointer);

  mainSvg.addEventListener("wheel", e=>{
    e.preventDefault();
    const rect = mainSvg.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const sx = mainViewBox.x + (px/rect.width)*mainViewBox.w;
    const sy = mainViewBox.y + (py/rect.height)*mainViewBox.h;
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    zoomBy(factor, sx, sy);
  }, { passive:false });
  } // end panReady guard

  // ── 미니맵: 터치/클릭하면 그 지점으로 포커스 이동, 드래그하면 따라서 화면 이동 ──
  // (on* 할당이라 재렌더 시 중복 등록되지 않음)
  const miniSvg = document.getElementById("minimapSvg");
  const miniToSvg = (clientX, clientY)=>{
    const r = miniSvg.getBoundingClientRect();
    return {
      x: SEAT_BBOX.x + ((clientX - r.left) / r.width)  * SEAT_BBOX.w,
      y: SEAT_BBOX.y + ((clientY - r.top)  / r.height) * SEAT_BBOX.h
    };
  };
  const centerMainOn = (x, y)=>{
    mainViewBox = clampViewBox({ x: x - mainViewBox.w/2, y: y - mainViewBox.h/2, w: mainViewBox.w, h: mainViewBox.h });
    applyMainViewBox();
  };
  let miniDragging = false;
  miniSvg.onpointerdown = e=>{
    e.preventDefault(); e.stopPropagation();
    miniDragging = true;
    try{ miniSvg.setPointerCapture(e.pointerId); }catch(err){}
    const p = miniToSvg(e.clientX, e.clientY);
    centerMainOn(p.x, p.y);
  };
  miniSvg.onpointermove = e=>{
    if(!miniDragging) return;
    const p = miniToSvg(e.clientX, e.clientY);
    centerMainOn(p.x, p.y);
  };
  const miniEnd = e=>{
    if(!miniDragging) return;
    miniDragging = false;
    try{ miniSvg.releasePointerCapture(e.pointerId); }catch(err){}
    saveState();
  };
  miniSvg.onpointerup = miniEnd;
  miniSvg.onpointercancel = miniEnd;
}



function showSeatDetail(seatId){
  const seat = seatmapData.seats.find(s=>s.id===seatId);
  const grade = performanceData.grades.find(g=>g.seatIds.includes(seatId));
  const detail = document.getElementById("seatDetail");
  const price = grade ? grade.prices[0] : null;

  const roles = performanceData.casts.map(c=>c.role);
  const perfsHere = performanceData.performances.filter(p=>p.seat===seatId);

  const perfRows = perfsHere.length===0
    ? `<tr><td colspan="${3+roles.length}" style="color:var(--ink-dim); font-style:italic;">이 좌석에서 본 공연이 없습니다.</td></tr>`
    : perfsHere.map(p=>{
        const castCells = roles.map(role=>{
          const names = castVisibleNamesOf(p.cast[role]);
          if(names.length===0) return `<td class="cast-cell"><span class="empty">미정</span></td>`;
          const roleInfo = performanceData.casts.find(c=>c.role===role);
          const lookup = {};
          roleInfo.actors.forEach(a=>lookup[a.name]=a.role);
          return `<td class="cast-cell">${names.map(n=>{
            const cls = lookup[n]==="alternative" ? "alt" : (lookup[n]==="swing" ? "swing" : (lookup[n]==="cover" ? "cover" : (lookup[n]==="standby" ? "standby" : "")));
            return `<span class="name ${cls}">${n}</span>`;
          }).join("")}</td>`;
        }).join("");
        const dcolor = dateColorOf(p.date);
        return `
          <tr>
            <td class="date-cell"${dcolor?` style="color:${dcolor}"`:''}>${shortDateDow(p.date)}</td>
            <td class="time-cell"${dcolor?` style="color:${dcolor}"`:''}>${p.time}</td>
            <td>${p.note || ""}</td>
            ${castCells}
          </tr>
        `;
      }).join("");

  detail.innerHTML = `
    <h3>${seat.floor}층 ${seat.row}열 ${seat.column}번${grade ? ` &middot; ${grade.name}` : ""}${price ? ` &middot; ${price.price.toLocaleString()}원` : ""}</h3>
    <div style="margin-top:14px; font-size:12px; color:var(--ink-dim); text-transform:uppercase; letter-spacing:0.5px;">이 좌석에서 본 공연</div>
    <div style="overflow-x:auto; margin-top:8px;">
      <table class="seat-perf-table">
        <thead><tr><th>날짜</th><th>시간</th><th>메모</th>${roles.map(r=>`<th>${r}</th>`).join("")}</tr></thead>
        <tbody>${perfRows}</tbody>
      </table>
    </div>
  `;
}

/* =========================================================
   ROLE COMBINATION STATS (배역 조합 출연횟수)
   ========================================================= */
let comboRoleSelection = []; // 선택된 "배역" 이름 배열, 클릭 순서대로 ["엘리자벳","죽음", ...]
let comboBlocks = []; // 만들기를 누를 때마다 쌓이는 {id, roles} 목록 (최신이 위)
let collapsedComboIds = new Set(); // 닫혀있는 조합 블록 id
let comboBlockSeq = 0;
let comboCreateOpen = true; // "배역 통계 추가" 섹션 펼침 여부
function applyComboCreateOpen(){
  const body = document.getElementById("comboCreateBody");
  const arrow = document.getElementById("comboCreateArrow");
  if(body) body.style.display = comboCreateOpen ? "" : "none";
  if(arrow) arrow.innerHTML = comboCreateOpen ? "&#9662;" : "&#9656;";
}

function renderComboPicker(){
  const picker = document.getElementById("comboPicker");
  const roles = performanceData.casts.map(c=>c.role);
  picker.innerHTML = `
    <div class="combo-actor-chips">
      ${roles.map(role=>{
        const idx = comboRoleSelection.indexOf(role);
        const selected = idx>=0;
        const badge = selected ? `<span class="chip-badge">${idx+1}</span>` : "";
        return `<div class="combo-chip ${selected?'selected':''}" data-role="${role}">${role}${badge}</div>`;
      }).join("")}
    </div>
  `;

  picker.querySelectorAll(".combo-chip").forEach(chip=>{
    chip.addEventListener("click", ()=>{
      const role = chip.dataset.role;
      const idx = comboRoleSelection.indexOf(role);
      if(idx>=0) comboRoleSelection.splice(idx,1);
      else comboRoleSelection.push(role);
      renderComboPicker();
    });
  });
}

function cartesian(arrs){
  return arrs.reduce((acc,curr)=>acc.flatMap(a=>curr.map(c=>[...a,c])), [[]]);
}

// 프리셋 ID 목록 (순서 변경 가능, 삭제 불가)
const PRESET_IDS = ["preset-billyxmichael", "preset-dreamballet"];

// 씬 7을 담당한 빌리 배우 반환 (누적 weight 기준. 동점/미달이면 마지막 배우)
function getBillyAtScene7(entry, mode){
  const items = parseCastWeighted(entry);
  if(!items.length) return null;
  if(mode==="first") return items[0].name;
  if(mode==="start"){
    const started = items.find(it=>it.weight>0);
    return started ? started.name : items[0].name;
  }
  // 'all' | 'weighted': 누적 weight로 씬7 담당 배우 찾기
  let cum = 0;
  for(const it of items){
    cum += it.weight;
    if(cum >= 7) return it.name;
  }
  return items[items.length-1].name;
}

function buildDreamBalletHtml(isPreset){
  const perfs = performanceData.performances;
  const id = "preset-dreamballet";
  const isCollapsed = collapsedComboIds.has(id);

  const seniorActors = (performanceData.casts.find(c=>c.role==="성인빌리") || {actors:[]}).actors.map(a=>a.name);
  const billyActors  = (performanceData.casts.find(c=>c.role==="빌리")     || {actors:[]}).actors.map(a=>a.name);

  const pairMap = {};
  billyActors.forEach(b=> seniorActors.forEach(s=>{ pairMap[`${b}|${s}`]={total:0,ended:0,watched:0,upcoming:0}; }));

  perfs.forEach(p=>{
    const dom = getBillyAtScene7(p.cast["빌리"], castStatsMode);
    if(!dom) return;
    const seniors = castNamesForMode(p.cast["성인빌리"], castStatsMode);
    seniors.forEach(s=>{
      const key = `${dom}|${s}`;
      if(!pairMap[key]) pairMap[key] = {total:0,ended:0,watched:0,upcoming:0};
      pairMap[key].total++;
      if(isEnded(p)){
        pairMap[key].ended++;
        if(hasSeat(p)) pairMap[key].watched++;
      } else {
        if(hasSeat(p)) pairMap[key].upcoming++;
      }
    });
  });

  const rows = Object.entries(pairMap).map(([key,s])=>{
    const [billy,senior] = key.split("|");
    return {tuple:[billy,senior], stats:s};
  }).sort((a,b)=>{
    const c = a.tuple[0].localeCompare(b.tuple[0],"ko"); return c!==0?c:a.tuple[1].localeCompare(b.tuple[1],"ko");
  });

  const titleBar = buildComboTitleBar(id, "드림 발레 페어 (빌리 × 성인빌리)", true, isCollapsed);
  const body = buildComboBody(rows, ["빌리","성인빌리"], isCollapsed);
  return `<div class="combo-result-block" draggable="true" data-block-id="${id}">${titleBar}${body}</div>`;
}

function buildComboTitleBar(id, label, isPreset, isCollapsed){
  const deleteBtn = isPreset ? "" : `<button class="combo-delete-btn stat-del-btn" data-id="${id}">삭제</button>`;
  const dragHandle = `<span class="combo-drag-handle" style="color:var(--ink-dim); font-size:22px; line-height:1; cursor:grab; padding:4px 8px;">&#8942;&#8942;</span>`;
  return `
    <div class="combo-title-bar" style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
      ${dragHandle}
      <button class="combo-toggle" data-id="${id}" style="display:flex; align-items:center; gap:6px; background:none; border:none; cursor:pointer; padding:0; font-size:13px; font-weight:700; color:var(--gold); flex:1; text-align:left;">
        <span class="combo-toggle-arrow">${isCollapsed ? "&#9656;" : "&#9662;"}</span> ${label}
      </button>
      ${deleteBtn}
    </div>
  `;
}

function buildComboBody(rows, rolesSelected, isCollapsed){
  if(rows.length===0){
    return `<p style="color:var(--ink-dim); font-size:13px; ${isCollapsed ? 'display:none;' : ''}">함께 출연한 공연이 없습니다.</p>`;
  }
  const numCols = rolesSelected.length;
  // 모든 컬럼에 대해 cascading rowspan 계산
  const skip    = rows.map(()=>new Array(numCols).fill(false));
  const rowspan = rows.map(()=>new Array(numCols).fill(1));
  for(let col=0; col<numCols; col++){
    let i=0;
    while(i<rows.length){
      let j=i;
      while(j+1<rows.length){
        let same = true;
        for(let k=0; k<=col; k++){
          if(rows[j+1].tuple[k] !== rows[i].tuple[k]){ same=false; break; }
        }
        if(!same) break;
        j++;
        skip[j][col]=true;
      }
      rowspan[i][col]=j-i+1;
      i=j+1;
    }
  }
  const head = `<tr>${rolesSelected.map(r=>`<th>${r}</th>`).join("")}<th>전체</th><th>종료</th><th>관극</th><th>예매</th></tr>`;
  const body = rows.map((row,idx)=>{
    const roleCells = rolesSelected.map((_,col)=>{
      if(skip[idx][col]) return "";
      return `<td rowspan="${rowspan[idx][col]}">${row.tuple[col]}</td>`;
    }).join("");
    const s = row.stats;
    return `<tr>${roleCells}<td>${fmtStatValue(s.total)}</td><td>${fmtStatValue(s.ended)}</td><td>${fmtStatValue(s.watched)}</td><td>${fmtStatValue(s.upcoming)}</td></tr>`;
  }).join("");
  return `<table class="role-stat-table" style="${isCollapsed ? 'display:none;' : ''}"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function buildComboBlockHtml(id, rolesSelected, isPreset=false){
  const perfs = performanceData.performances;

  const actorLists = rolesSelected.map(role=>{
    const roleInfo = performanceData.casts.find(c=>c.role===role);
    return roleInfo ? roleInfo.actors.map(a=>a.name) : [];
  });
  const allTuples = cartesian(actorLists);

  const rows = allTuples.map(tuple=>{
    let total=0, ended=0, watched=0, upcoming=0;
    perfs.forEach(p=>{
      if(!rolesSelected.every((role,i)=>castNamesForMode(p.cast[role], castStatsMode).includes(tuple[i]))) return;
      let amount = 1;
      if(castStatsMode==="weighted"){
        // 각 배역에서 해당 배우의 비중(weight/10)을 곱해 기여도 계산
        amount = rolesSelected.reduce((prod, role, i)=>{
          const items = parseCastWeighted(p.cast[role]);
          const it = items.find(x=>x.name===tuple[i]);
          return prod * ((it && it.weight!=null) ? it.weight/10 : 1);
        }, 1);
      }
      total   += amount;
      if(isEnded(p)){
        ended   += amount;
        if(hasSeat(p)) watched  += amount;
      } else {
        if(hasSeat(p)) upcoming += amount;
      }
    });
    return { tuple, stats:{total,ended,watched,upcoming} };
  });

  // 각 배역에서 배우의 role type 조회 함수
  const getRoleType = (roleName, actorName) => {
    const roleInfo = performanceData.casts.find(c=>c.role===roleName);
    if(!roleInfo) return "cast";
    const actor = roleInfo.actors.find(a=>a.name===actorName);
    return actor ? actor.role : "cast";
  };
  const isCast = (roleName, actorName) => getRoleType(roleName, actorName) === "cast";
  const tupleIsCastOnly = tuple => rolesSelected.every((role, i) => isCast(role, tuple[i]));

  // cast 아닌 배우가 포함된 row 중 총 횟수가 0이면 제거
  const filteredRows = rows.filter(r => tupleIsCastOnly(r.tuple) || r.stats.total > 0);

  filteredRows.sort((a, b)=>{
    // 컬럼을 왼쪽부터 순서대로 비교:
    // 각 컬럼에서 cast가 non-cast보다 먼저, 같은 타입 내에서는 가나다 순
    for(let k=0;k<a.tuple.length;k++){
      const aIsCastHere = isCast(rolesSelected[k], a.tuple[k]);
      const bIsCastHere = isCast(rolesSelected[k], b.tuple[k]);
      if(aIsCastHere !== bIsCastHere) return aIsCastHere ? -1 : 1;
      const cmp = a.tuple[k].localeCompare(b.tuple[k], "ko");
      if(cmp!==0) return cmp;
    }
    return 0;
  });

  const isCollapsed = collapsedComboIds.has(String(id));
  const titleBar = buildComboTitleBar(id, rolesSelected.join(" × "), isPreset, isCollapsed);
  const body = buildComboBody(filteredRows, rolesSelected, isCollapsed);
  return `<div class="combo-result-block" draggable="true" data-block-id="${id}">${titleBar}${body}</div>`;
}

function getAllComboBlocks(){
  // 프리셋 항목이 comboBlocks 안에 없으면 앞에 삽입
  const missingPresets = PRESET_IDS.filter(pid=>!comboBlocks.find(b=>b.id===pid));
  if(missingPresets.length){
    const presetEntries = [
      {id:"preset-billyxmichael", roles:["빌리","마이클"], isPreset:true},
      {id:"preset-dreamballet", isDreamBallet:true, isPreset:true}
    ].filter(p=>missingPresets.includes(p.id));
    comboBlocks = [...presetEntries, ...comboBlocks];
  }
  return comboBlocks;
}

function buildAnyComboHtml(b){
  if(b.isDreamBallet) return buildDreamBalletHtml(true);
  return buildComboBlockHtml(b.id, b.roles, b.isPreset);
}

function renderComboResults(){
  const container = document.getElementById("comboResults");
  const emptyMsg = document.getElementById("comboEmptyMsg");
  const allBlocks = getAllComboBlocks();

  container.innerHTML = allBlocks.map(buildAnyComboHtml).join("") + `<div class="combo-drop-end" style="height:24px;"></div>`;
  emptyMsg.style.display = "none";

  container.querySelectorAll(".combo-delete-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.id;
      comboBlocks = comboBlocks.filter(b=>String(b.id)!==id);
      renderComboResults();
      saveState();
    });
  });

  container.querySelectorAll(".combo-toggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const id = btn.dataset.id;
      if(collapsedComboIds.has(id)) collapsedComboIds.delete(id);
      else collapsedComboIds.add(id);
      renderComboResults();
      saveState();
    });
  });

  let dragFromId = null;
  container.querySelectorAll(".combo-result-block").forEach(block=>{
    block.addEventListener("dragstart", ()=>{
      dragFromId = block.dataset.blockId;
      block.style.opacity = "0.4";
    });
    block.addEventListener("dragend", ()=>{ block.style.opacity = ""; });
    block.addEventListener("dragover", e=>{ e.preventDefault(); block.style.borderTop = "2px solid var(--gold)"; });
    block.addEventListener("dragleave", ()=>{ block.style.borderTop = ""; });
    block.addEventListener("drop", e=>{
      e.preventDefault();
      block.style.borderTop = "";
      const dropId = block.dataset.blockId;
      if(dragFromId===null || dragFromId===dropId) return;
      const fromIdx = comboBlocks.findIndex(b=>String(b.id)===dragFromId);
      const dropIdx = comboBlocks.findIndex(b=>String(b.id)===dropId);
      if(fromIdx===-1 || dropIdx===-1) return;
      const moved = comboBlocks.splice(fromIdx,1)[0];
      comboBlocks.splice(dropIdx,0,moved);
      dragFromId = null;
      renderComboResults();
      saveState();
    });
  });

  const comboDropEnd = container.querySelector(".combo-drop-end");
  comboDropEnd.addEventListener("dragover", e=>{ e.preventDefault(); comboDropEnd.style.borderTop = "2px solid var(--gold)"; });
  comboDropEnd.addEventListener("dragleave", ()=>{ comboDropEnd.style.borderTop = ""; });
  comboDropEnd.addEventListener("drop", e=>{
    e.preventDefault();
    comboDropEnd.style.borderTop = "";
    if(dragFromId===null) return;
    const fromIdx = comboBlocks.findIndex(b=>String(b.id)===dragFromId);
    if(fromIdx===-1) return;
    const moved = comboBlocks.splice(fromIdx,1)[0];
    comboBlocks.push(moved);
    dragFromId = null;
    renderComboResults();
    saveState();
  });
}

function showToast(msg){
  const existing = document.getElementById("appToast");
  if(existing) existing.remove();
  const toast = document.createElement("div");
  toast.id = "appToast";
  toast.textContent = msg;
  toast.style.cssText = "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--panel);border:1px solid var(--line);color:var(--ink);padding:10px 20px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.4);pointer-events:none;";
  document.body.appendChild(toast);
  setTimeout(()=>toast.remove(), 2500);
}

document.getElementById("comboCreateToggle").addEventListener("click", ()=>{
  comboCreateOpen = !comboCreateOpen;
  applyComboCreateOpen();
  saveState();
});

document.getElementById("comboCreateBtn").addEventListener("click", ()=>{
  if(comboRoleSelection.length===0) return;

  // 1개 배역 선택 → 배역별 출연 횟수에 추가
  if(comboRoleSelection.length===1){
    const role = comboRoleSelection[0];
    if(roleStatsOrder.includes(role)){
      showToast(`"${role}" 배역은 이미 배역별 출연 횟수에 표시 중입니다.`);
    } else {
      roleStatsOrder.push(role);
      comboRoleSelection = [];
      renderComboPicker();
      renderStats();
      saveState();
    }
    return;
  }

  // 2개 이상 배역 선택 → 배역 조합
  // 동일한 조합이 이미 있으면 토스트
  const sortedNew = [...comboRoleSelection].sort();
  const allBlocks = getAllComboBlocks();
  const duplicate = allBlocks.find(b=>{
    if(!b.roles) return false;
    const sortedExisting = [...b.roles].sort();
    return sortedExisting.length===sortedNew.length && sortedExisting.every((r,i)=>r===sortedNew[i]);
  });
  if(duplicate){
    showToast(`"${comboRoleSelection.join(" × ")}" 조합이 이미 존재합니다.`);
    return;
  }

  comboBlocks.push({ id: ++comboBlockSeq, roles: [...comboRoleSelection] });
  comboRoleSelection = [];
  renderComboPicker();
  renderComboResults();
  applyComboCreateOpen(); // "배역 통계 추가" 섹션 펼침/접힘 적용
  saveState();
});

/* =========================================================
   PERSISTENCE (localStorage)
   ========================================================= */
const STORAGE_KEY = "musicalTracker:state:v1";

// 컬러 테마 (CSS data-theme로 적용). 기본 = amber
const COLOR_THEMES = ["amber","midnight","steel","sage","rose","red"];
let colorTheme = "amber";
function applyColorTheme(){
  document.documentElement.dataset.theme = colorTheme;
  document.querySelectorAll(".theme-btn").forEach(b=>b.classList.toggle("active", b.dataset.theme===colorTheme));
}

function buildStateSnapshot(){
  return {
    performances: performanceData.performances.map(p=>({seat:p.seat, note:p.note, ticketType:p.ticketType||"", ticketFee:!!p.ticketFee, ticketDiscount:(p.ticketDiscount!=null?p.ticketDiscount:null), ticketExtra:(p.ticketExtra||0)})),
    scheduleHiddenCols: [...scheduleHiddenCols],
    scheduleRoleFilter: Object.fromEntries(
      Object.entries(scheduleRoleFilter).map(([k,v])=>[k, [...v]])
    ),
    scheduleMatchFilter: Object.fromEntries(
      Object.entries(scheduleMatchFilter).map(([k,v])=>[k, [...v]])
    ),
    collapsedRoles: [...collapsedRoles],
    roleStatsOrder: [...roleStatsOrder],
    comboBlocks: comboBlocks,
    comboBlockSeq: comboBlockSeq,
    comboCreateOpen: comboCreateOpen,
    collapsedComboIds: [...collapsedComboIds],
    hiddenFloors: [...hiddenFloors],
    showSeatNumbers: showSeatNumbers,
    hiddenStatActors: Object.fromEntries(Object.entries(hiddenStatActors).map(([k,v])=>[k,[...v]])),
    minimapVisible: minimapVisible,
    castStatsMode: castStatsMode,
    matchAssumeDefaultWin: matchAssumeDefaultWin,
    matchStatsOrder: [...matchStatsOrder],
    collapsedMatchStats: [...collapsedMatchStats],
    showCastHistory: showCastHistory,
    seatShowWatched: seatShowWatched,
    seatShowBooked: seatShowBooked,
    seatMapFilterActive: seatMapFilterActive,
    seatMapFilter: Object.fromEntries(Object.entries(seatMapFilter).map(([k,v])=>[k,[...v]])),
    colorTheme: colorTheme,
    // 스케줄 가로 스크롤 날짜 식별 옵션
    floatDateOn: floatDateOn,
    rowHighlightOn: rowHighlightOn,
    rowHighlightSave: rowHighlightSave,
    lockVScrollOn: lockVScrollOn,
    // 하이라이트는 '저장' 옵션이 켜졌을 때만 보존(꺼져 있으면 세션 한정)
    highlightedRows: rowHighlightSave ? [...highlightedRows] : [],
    // 시트맵 위치·배율(줌/팬)
    seatViewBox: mainViewBox ? { x:mainViewBox.x, y:mainViewBox.y, w:mainViewBox.w, h:mainViewBox.h } : null
  };
}

function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(buildStateSnapshot()));
  } catch(err){
    console.error("저장 실패:", err);
  }
}

function applyState(state){
  if(!state) return;

  if(Array.isArray(state.performances)){
    state.performances.forEach((s, i)=>{
      if(performanceData.performances[i]){
        if(typeof s.seat === "string") performanceData.performances[i].seat = s.seat;
        if(typeof s.note === "string") performanceData.performances[i].note = s.note;
        if(typeof s.ticketType === "string") performanceData.performances[i].ticketType = s.ticketType;
        if(typeof s.ticketFee === "boolean") performanceData.performances[i].ticketFee = s.ticketFee;
        performanceData.performances[i].ticketDiscount = (typeof s.ticketDiscount === "number") ? s.ticketDiscount : null;
        performanceData.performances[i].ticketExtra = (typeof s.ticketExtra === "number" && s.ticketExtra > 0) ? s.ticketExtra : 0;
      }
    });
  }

  // 구버전 호환: scheduleHiddenRoles로 저장됐던 데이터도 그대로 복원
  scheduleHiddenCols = new Set(state.scheduleHiddenCols || state.scheduleHiddenRoles || []);

  scheduleRoleFilter = {};
  if(state.scheduleRoleFilter){
    Object.entries(state.scheduleRoleFilter).forEach(([k,v])=>{
      scheduleRoleFilter[k] = new Set(v);
    });
  }
  scheduleMatchFilter = {};
  if(state.scheduleMatchFilter){
    Object.entries(state.scheduleMatchFilter).forEach(([k,v])=>{
      scheduleMatchFilter[k] = new Set(v);
    });
  }

  collapsedRoles = new Set(state.collapsedRoles || []);

  if(Array.isArray(state.roleStatsOrder)){
    // 저장된 목록을 그대로(순서·삭제 반영) 권위 있는 소스로 사용한다.
    // 데이터(casts)에서 사라진 배역만 걸러내고, 누락된 배역은 다시 채우지 않는다(= 삭제 유지).
    const validRoles = performanceData.casts.map(c=>c.role);
    roleStatsOrder = state.roleStatsOrder.filter(r=>validRoles.includes(r));
  }

  if(Array.isArray(state.comboBlocks)) comboBlocks = state.comboBlocks;
  if(typeof state.comboBlockSeq === "number") comboBlockSeq = state.comboBlockSeq;
  if(typeof state.comboCreateOpen === "boolean") comboCreateOpen = state.comboCreateOpen;
  collapsedComboIds = new Set(state.collapsedComboIds || []);

  hiddenFloors = new Set(state.hiddenFloors || []);
  if(typeof state.showSeatNumbers === "boolean") showSeatNumbers = state.showSeatNumbers;
  if(state.hiddenStatActors){
    hiddenStatActors = {};
    Object.entries(state.hiddenStatActors).forEach(([k,v])=>{ hiddenStatActors[k]=new Set(v); });
  }
  if(typeof state.minimapVisible === "boolean") minimapVisible = state.minimapVisible;
  if(typeof state.castStatsMode === "string") castStatsMode = state.castStatsMode;
  if(typeof state.matchAssumeDefaultWin === "boolean") matchAssumeDefaultWin = state.matchAssumeDefaultWin;
  if(Array.isArray(state.matchStatsOrder)) matchStatsOrder = state.matchStatsOrder.slice();
  collapsedMatchStats = new Set(state.collapsedMatchStats || []);
  if(typeof state.showCastHistory === "boolean") showCastHistory = state.showCastHistory;

  if(typeof state.seatShowWatched === "boolean") seatShowWatched = state.seatShowWatched;
  if(typeof state.seatShowBooked === "boolean") seatShowBooked = state.seatShowBooked;
  if(typeof state.seatMapFilterActive === "boolean") seatMapFilterActive = state.seatMapFilterActive;
  seatMapFilter = {};
  if(state.seatMapFilter){
    Object.entries(state.seatMapFilter).forEach(([k,v])=>{ seatMapFilter[k] = new Set(v); });
  }
  if(typeof state.colorTheme === "string" && COLOR_THEMES.includes(state.colorTheme)) colorTheme = state.colorTheme;

  if(typeof state.floatDateOn === "boolean") floatDateOn = state.floatDateOn;
  if(typeof state.rowHighlightOn === "boolean") rowHighlightOn = state.rowHighlightOn;
  if(typeof state.rowHighlightSave === "boolean") rowHighlightSave = state.rowHighlightSave;
  if(typeof state.lockVScrollOn === "boolean") lockVScrollOn = state.lockVScrollOn;
  highlightedRows = new Set(Array.isArray(state.highlightedRows) ? state.highlightedRows : []);

  // 시트맵 위치·배율 복원(첫 renderSeatMap에서 적용)
  const vb = state.seatViewBox;
  if(vb && ["x","y","w","h"].every(k=>typeof vb[k]==="number") && vb.w>0 && vb.h>0){
    pendingSeatViewBox = { x:vb.x, y:vb.y, w:vb.w, h:vb.h };
  }
}

function loadStateFromStorage(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw) applyState(JSON.parse(raw));
  } catch(err){
    console.error("불러오기 실패:", err);
  }
}

function exportStateToFile(){
  const data = JSON.stringify(buildStateSnapshot(), null, 2);
  const blob = new Blob([data], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "musical-tracker-settings.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importStateFromFile(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const state = JSON.parse(reader.result);
      applyState(state);
      saveState();
      renderSchedule();
      renderStats();
      renderSeatMap();
      renderComboPicker();
      renderComboResults();
      alert("설정을 불러왔습니다.");
    } catch(err){
      alert("파일을 읽지 못했습니다. 올바른 JSON 파일인지 확인해주세요.");
      console.error(err);
    }
  };
  reader.readAsText(file);
}

/* =========================================================
   공연 좌석 JSON export / import
   ({ "s2": ["1-7-23"], "s30": ["1-6-24"] } 형식)
   ========================================================= */

// 모바일 엑셀 등에서 복사할 때 따옴표가 이중으로 깨지는 경우까지 최대한 복구해서 파싱한다.
function parseLooseJSON(text){
  text = (text || "").trim();
  if(!text) throw new Error("입력된 내용이 없습니다.");

  const attempts = [];
  attempts.push(text);

  // 전체가 한번 더 따옴표로 감싸여 있고 내부 "가 ""로 이중화된 경우
  let stripped = text;
  if(stripped.startsWith('"') && stripped.endsWith('"')){
    stripped = stripped.slice(1, -1);
  }
  attempts.push(stripped.replace(/""/g, '"'));

  // 감싸여 있지 않아도 내부에 ""가 있는 경우
  attempts.push(text.replace(/""/g, '"'));

  let lastErr = null;
  for(const candidate of attempts){
    try{
      return JSON.parse(candidate);
    } catch(err){
      lastErr = err;
    }
  }
  throw lastErr || new Error("JSON 파싱에 실패했습니다.");
}

// 형식: { sid: [좌석, 티켓종류, 수수료여부, 메모] }
//  - 첫 번째 항목 = 좌석. 티켓/메모가 모두 없으면 [좌석] (길이 1).
function buildSeatExportJSON(){
  const result = {};
  performanceData.performances.forEach(p=>{
    const seat = (p.seat || "").trim();
    const ticketType = p.ticketType || "";
    const ticketFee = !!p.ticketFee;
    const note = p.note || "";
    const hasExtra = ticketType || ticketFee || note.trim();
    if(!seat && !hasExtra) return; // 아무 정보도 없으면 내보내지 않음
    if(!hasExtra){ result[p.sid] = [seat]; return; }
    const arr = [seat, ticketType, ticketFee, note];
    if(p.ticketDiscount != null) arr.push(p.ticketDiscount); // 임의 할인권 할인율(5번째, 선택)
    result[p.sid] = arr;
  });
  return result;
}

function exportSeatJSON(){
  const data = JSON.stringify(buildSeatExportJSON(), null, 2);
  const blob = new Blob([data], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "musical-tracker-seats.json";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 가져올 때는 항상 기존 좌석/티켓/메모를 모두 지운 뒤 새로 채운다.
//  - 리스트 길이가 1이면 티켓/메모 없음(좌석만).
//  - 길이가 2 이상이면 [좌석, 티켓종류, 수수료여부, 메모, (선택)임의할인율] 순으로 해석.
function applySeatJSONData(data){
  if(!data || typeof data !== "object") throw new Error("올바른 형식이 아닙니다.");

  performanceData.performances.forEach(p=>{ p.seat = ""; p.ticketType = ""; p.ticketFee = false; p.note = ""; p.ticketDiscount = null; p.ticketExtra = 0; });

  const sidMap = {};
  performanceData.performances.forEach(p=>{ sidMap[p.sid] = p; });

  let appliedCount = 0;
  Object.entries(data).forEach(([sid, val])=>{
    const perf = sidMap[sid];
    if(!perf) return;
    const list = Array.isArray(val) ? val : (typeof val === "string" ? [val] : null);
    if(!list) return;

    perf.seat = (list[0] == null ? "" : String(list[0])).trim();
    if(list.length > 1){
      perf.ticketType = list[1] != null ? String(list[1]) : "";
      perf.ticketFee  = !!list[2];
      perf.note       = list[3] != null ? String(list[3]) : "";
      perf.ticketDiscount = (list.length > 4 && list[4] != null && list[4] !== "" && isFinite(Number(list[4]))) ? Number(list[4]) : null;
    }
    if(perf.seat || perf.ticketType || (perf.note && perf.note.trim())) appliedCount++;
  });

  renderSchedule();
  renderStats();
  renderSeatMap();
  saveState();
  return appliedCount;
}

function importSeatJSONFile(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const data = parseLooseJSON(reader.result);
      const n = applySeatJSONData(data);
      alert(`좌석·티켓·메모를 가져왔습니다. (${n}개 공연 반영)`);
    } catch(err){
      alert("좌석 JSON을 읽지 못했습니다: " + err.message);
      console.error(err);
    }
  };
  reader.readAsText(file);
}

/* =========================================================
   INIT
   ========================================================= */
function showSeatOverlay(seatId){
  const overlay = document.getElementById("seatOverlay");
  const grid = document.getElementById("seatOverlayGrid");
  const title = document.getElementById("seatOverlayTitle");

  if(!seatId){
    title.textContent = "좌석 미입력";
    grid.innerHTML = `<p style="color:var(--ink-dim); font-size:13px; padding:20px 0;">이 공연은 좌석이 입력되지 않았습니다.</p>`;
    overlay.style.display = "flex";
    return;
  }

  const seat = seatmapData.seats.find(s=>s.id===seatId);
  title.textContent = seat
    ? `${seat.floor}층 ${seat.row}열 ${seat.column}번`
    : `${seatId} (좌석 정보 없음)`;

  const seatSvg = buildSeatSvgInner(seatId);
  grid.innerHTML = `
    <svg viewBox="${vbString(seatSvg.bbox)}" style="width:100%; height:360px; display:block; background:var(--panel2); border-radius:8px;">
      ${seatSvg.markup}
    </svg>
    <div class="legend" style="margin-top:10px;"><span><i style="background:#fff; box-shadow:0 0 8px rgba(255,255,255,0.8);"></i>선택한 좌석</span></div>
  `;

  overlay.style.display = "flex";
}

document.getElementById("seatOverlayClose").addEventListener("click", ()=>{
  document.getElementById("seatOverlay").style.display = "none";
});
document.getElementById("seatOverlay").addEventListener("click", e=>{
  if(e.target.id==="seatOverlay") e.currentTarget.style.display = "none";
});

document.addEventListener("click", e=>{
  if(scheduleOpenDropdownRole && !e.target.closest(".role-head")){
    scheduleOpenDropdownRole = null;
    renderSchedule();
  }
  if(memoPopoverIdx!==null && !e.target.closest(".memo-cell")){
    memoPopoverIdx = null;
    renderSchedule();
  }
  if(ticketPopoverIdx!==null && !e.target.closest(".ticket-cell")){
    ticketPopoverIdx = null;
    renderSchedule();
  }
});

function updateHeaderHeightVar(){
  const el = document.getElementById("appHeaderSticky");
  if(el) document.documentElement.style.setProperty("--header-h", el.offsetHeight + "px");
}

/* 모바일 100vh 문제 해결: 브라우저 하단 툴바를 제외한 '실제로 보이는 높이'를 측정해
   --app-height에 넣는다. CSS의 100vh/100dvh는 기기/브라우저에 따라 툴바를 포함하거나
   미지원이라, 마지막 행이 툴바 뒤로 숨는 문제가 생긴다. JS 측정값은 모든 브라우저에서 동작. */
function updateAppHeight(){
  // visualViewport가 있으면 그게 가장 정확(툴바·키보드 반영). 없으면 innerHeight.
  const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
  document.documentElement.style.setProperty("--app-height", h + "px");
}
function updateLayoutVars(){ updateHeaderHeightVar(); updateAppHeight(); }

window.addEventListener("resize", updateLayoutVars);
window.addEventListener("orientationchange", updateLayoutVars);
if(window.visualViewport){
  window.visualViewport.addEventListener("resize", updateAppHeight);
}
updateLayoutVars();

// 컬러 테마 선택 버튼
document.querySelectorAll(".theme-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    colorTheme = btn.dataset.theme;
    applyColorTheme();
    saveState();
  });
});

document.getElementById("exportSettingsBtn").addEventListener("click", exportStateToFile);

document.getElementById("importSettingsBtn").addEventListener("click", ()=>{
  document.getElementById("importSettingsFile").click();
});
document.getElementById("importSettingsFile").addEventListener("change", e=>{
  const file = e.target.files[0];
  if(file) importStateFromFile(file);
  e.target.value = "";
});

// 설정 초기화: 화면 설정·필터·테마 등만 비우고, 입력한 좌석·티켓·메모(performances)는 유지
document.getElementById("resetSettingsBtn").addEventListener("click", ()=>{
  if(!confirm("화면 설정·필터·테마·통계 구성 등을 초기화할까요?\n입력한 좌석·티켓·메모는 그대로 유지됩니다.")) return;
  const snap = buildStateSnapshot();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ performances: snap.performances }));
  location.reload();
});

// 좌석 데이터 삭제: 입력한 좌석·티켓·메모만 비우고, 설정은 유지
document.getElementById("deleteSeatDataBtn").addEventListener("click", ()=>{
  if(!confirm("입력한 좌석·티켓·메모를 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.\n(화면 설정은 유지됩니다)")) return;
  performanceData.performances.forEach(p=>{
    p.seat = ""; p.ticketType = ""; p.ticketFee = false; p.ticketDiscount = null; p.ticketExtra = 0; p.note = "";
  });
  saveState();
  location.reload();
});

document.getElementById("exportSeatJsonBtn").addEventListener("click", exportSeatJSON);

document.getElementById("importSeatJsonBtn").addEventListener("click", ()=>{
  document.getElementById("importSeatJsonFile").click();
});
document.getElementById("importSeatJsonFile").addEventListener("change", e=>{
  const file = e.target.files[0];
  if(file) importSeatJSONFile(file);
  e.target.value = "";
});

document.getElementById("applySeatJsonTextBtn").addEventListener("click", ()=>{
  const text = document.getElementById("seatJsonTextarea").value;
  try{
    const data = parseLooseJSON(text);
    const n = applySeatJSONData(data);
    alert(`좌석·티켓·메모를 적용했습니다. (${n}개 공연 반영)`);
  } catch(err){
    alert("입력한 텍스트를 JSON으로 해석할 수 없습니다: " + err.message);
    console.error(err);
  }
});

/* =========================================================
   스케줄 보기 옵션 (방법1 플로팅 / 방법2 하이라이트 / 방법3 세로 잠금)
   ========================================================= */
function setupScheduleOptions(){
  const fd = document.getElementById("optFloatDate");
  const rh = document.getElementById("optRowHighlight");
  const hs = document.getElementById("optHighlightSave");
  const lv = document.getElementById("optLockVScroll");
  if(!fd) return;

  // 저장된 상태를 체크박스에 반영
  fd.checked = floatDateOn;
  rh.checked = rowHighlightOn;
  hs.checked = rowHighlightSave;
  lv.checked = lockVScrollOn;

  fd.addEventListener("change", ()=>{ floatDateOn = fd.checked; saveState(); renderSchedule(); });
  rh.addEventListener("change", ()=>{ rowHighlightOn = rh.checked; saveState(); renderSchedule(); });
  hs.addEventListener("change", ()=>{
    rowHighlightSave = hs.checked;
    saveState(); // 켜면 현재 하이라이트가 저장되고, 끄면 저장 목록이 비워짐
  });
  lv.addEventListener("change", ()=>{ lockVScrollOn = lv.checked; saveState(); });
  // '하이라이트 해제' 버튼은 스케줄 툴바에 있으며 renderSchedule()에서 연결됨
}

/* 방법3: 가로 드래그 스크롤이 우세하면 세로 스크롤을 막고 가로만 이동시킨다(터치). */
function setupScheduleScrollLock(){
  const wrap = document.querySelector("#page-schedule .table-scroll-wrap");
  if(!wrap) return;
  // 방법1: 가로 스크롤 시 플로팅 오버레이 표시/숨김 + '지금' 버튼 활성 상태 갱신
  wrap.addEventListener("scroll", ()=>{ updateFloatOverlay(); updateNowBtn(); }, { passive:true });
  const nowBtn = document.getElementById("nowBtn");
  if(nowBtn) nowBtn.onclick = goToNow;
  let startX = 0, startY = 0, startLeft = 0, axis = null;
  wrap.addEventListener("touchstart", e=>{
    if(!lockVScrollOn || e.touches.length !== 1){ axis = null; return; }
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; startLeft = wrap.scrollLeft; axis = null;
  }, { passive:true });
  wrap.addEventListener("touchmove", e=>{
    if(!lockVScrollOn || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - startX, dy = t.clientY - startY;
    if(axis === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6)){
      axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
    }
    if(axis === "h"){
      e.preventDefault();              // 세로 네이티브 스크롤 차단
      wrap.scrollLeft = startLeft - dx; // 가로는 직접 이동
    }
  }, { passive:false });
}

/* =========================================================
   초기화: 데이터(json/) 로드 후 화면을 렌더링한다.
   ========================================================= */
let lastEndedCount = 0;

async function init(){
  try{
    await loadData();
  } catch(err){
    console.error(err);
    alert("데이터를 불러오지 못했습니다. 로컬 웹서버로 열었는지 확인해주세요.\n(예: 폴더에서 `python -m http.server` 실행 후 접속)\n\n" + err.message);
    return;
  }

  roleStatsOrder = performanceData.casts.map(c=>c.role);

  // 타이틀: "막올림 · {공연 제목}" (헤더 H1 + 브라우저 탭)
  const fullTitle = ("막올림 · " + (performanceData.title || "").trim()).trim();
  const titleEl = document.getElementById("appTitle");
  if(titleEl) titleEl.textContent = fullTitle;
  document.title = fullTitle;

  // 헤더 우측: 공연장 + 공연 기간(시작일 ~ 종료일)
  const period = (performanceData.startDate && performanceData.endDate)
    ? `${fmtHeaderDate(performanceData.startDate)} ~ ${fmtHeaderDate(performanceData.endDate)}`
    : "";
  document.getElementById("theaterName").textContent =
    seatmapData.theater + (period ? ` · ${period}` : "");

  loadStateFromStorage();
  applyColorTheme(); // 저장된 컬러 테마 적용
  setupScheduleOptions();   // 스케줄 보기 옵션 체크박스 연결(저장값 반영)
  setupScheduleScrollLock(); // 방법3: 가로 드래그 중 세로 스크롤 잠금

  // 최초 실행(저장된 상태 없음): 현재 전체 배역 목록을 스토리지에 초기 저장한다.
  // 이후 삭제/순서 변경이 이 목록을 갱신·저장하므로 삭제 정보가 그대로 유지된다.
  if(!localStorage.getItem(STORAGE_KEY)) saveState();

  renderSchedule();
  renderStats();
  renderSeatMap();
  renderComboPicker();
  renderComboResults();
  applyComboCreateOpen(); // "배역 통계 추가" 섹션 펼침/접힘 적용

  // 공연 시작+3시간(종료 시점)이 페이지를 띄워둔 채로 지나가면 통계/좌석맵을 자동 갱신한다.
  lastEndedCount = performanceData.performances.filter(isEnded).length;
  setInterval(()=>{
    const nowEndedCount = performanceData.performances.filter(isEnded).length;
    if(nowEndedCount !== lastEndedCount){
      lastEndedCount = nowEndedCount;
      renderStats();
      renderSeatMap();
    }
  }, 30000); // 30초마다 확인
}

init();