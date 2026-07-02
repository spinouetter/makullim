/* =========================================================
   DATA LAYER
   ========================================================= */

let seatmapData = null;
let performanceData = null;
let SEAT_BBOX = null;

function computeSeatBBox(){
  const xs = seatmapData.seats.map(s=>s.svgX);
  const ys = seatmapData.seats.map(s=>s.svgY);
  if(!xs.length) return { x:0, y:0, w:10, h:10 }; // 좌석 데이터 없음 방어(Math.min(...[])=Infinity 회피)
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
  setupStorageNamespace(meta.id); // 막올림별 localStorage 네임스페이스 설정
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
    if(p.ticketTransferred == null) p.ticketTransferred = false; // 양도받은 티켓 여부(없으면 내가 구매)
    if(!Array.isArray(p.extraTickets)) p.extraTickets = []; // 다중 티켓: 2번째 이후 티켓들(맨 위=평면 필드)
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
    // Finale(인증 이미지): 탭을 열 때마다 최신 데이터로 포스터 SVG 생성
    if(btn.dataset.page === "finale" && typeof window.renderFinale === "function"){
      window.renderFinale();
    }
    // 좌석맵이 처음 보일 때: 숨겨진 채 계산된 임시 초기 뷰를 실제 뷰포트 크기로 재맞춤
    if(btn.dataset.page === "seatmap" && seatNeedsInitialFit){
      const vp = document.getElementById("svgViewport");
      if(vp && vp.clientWidth > 0){
        mainViewBox = computeInitialViewBox();
        applyMainViewBox();
        seatNeedsInitialFit = false;
      }
    }
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
let tmIdx = -1;              // 티켓 관리 모달의 공연 인덱스
let tmTickets = [];          // 티켓 관리 모달의 작업 목록(복사본)
let tmEditTi = -1;           // 모달에서 팝오버가 열린 티켓 인덱스(-1=없음)

// === 스케줄 가로 스크롤 시 날짜 식별 옵션 (Settings에서 토글, 기본 OFF) ===
let floatDateOn = false;        // 방법1: 날짜·시간·좌석을 왼쪽 고정 컬럼으로 플로팅 표시
let rowHighlightOn = false;     // 방법2: 날짜 클릭으로 그 줄 하이라이트
let rowHighlightSave = false;   // 방법2: 하이라이트를 새로고침 후에도 유지(저장)
let lockVScrollOn = false;      // 방법3: 가로 드래그 스크롤 중 세로 스크롤 잠금
let highlightedRows = new Set(); // 하이라이트된 공연 idx 집합
let multiTicketMode = false;    // 다중 티켓 관리 모드(기본 OFF)
let finaleViewOn = false;       // Finale(인증 이미지) 탭 표시 (기본 OFF)

// 숨길 수 있는 특수 컬럼 키 (배역 이름과 충돌하지 않는 토큰)
const COL_TICKET = "__ticket__";
const COL_PRICE = "__price__";
const TICKET_FEE = 2000; // 선택 시 더해지는 수수료(원)
function colLabel(id){ return id===COL_TICKET ? "티켓" : (id===COL_PRICE ? "가격" : (id.indexOf("match:")===0 ? id.slice(6) : id)); }
// 캐스팅 대상(actors 보유) 역할만 — 스케줄/통계/좌석맵 컬럼용. group 참조전용(앙상블 등)은 제외.
function castRoleObjs(){ return performanceData.casts.filter(c=>Array.isArray(c.actors) && c.actors.length>0); }
// 스케줄 표 헤더용 라벨: shortName 있으면 그걸, 없으면 role.
function scheduleRoleLabel(role){ const c=performanceData.casts.find(x=>x.role===role); return (c&&c.shortName)?c.shortName:role; }

// 티켓 타입 머지(별칭): grades.json의 각 price에 alias:[옛이름…]을 두면, 그 옛이름으로
// 저장된 데이터도 이 타입으로 인식한다(표시·통계·가격조회). 저장은 새 이름으로 기록 → 수동 마이그레이션.
//  - 이름이 정확히 일치하는 항목을 우선, 없으면 alias에 포함하는 항목을 찾는다.
function resolveTicketEntry(grade, type){
  if(!grade || !type) return null;
  const ps = grade.prices || [];
  return ps.find(p=>p.name===type) || ps.find(p=>Array.isArray(p.alias) && p.alias.includes(type)) || null;
}

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
    const pr = resolveTicketEntry(grade, type);
    if(!pr) return null;
    base = pr.price;
  }
  const extraCost = (typeof extra === "number" && isFinite(extra)) ? extra : 0;
  return base + (fee ? TICKET_FEE : 0) + extraCost; // 최종가 = 티켓가 + 수수료 + 기타비용
}

/* === 다중 티켓 헬퍼 (맨 위=평면 필드, 2번째 이후=p.extraTickets) === */
function topTicketObj(p){
  return { seat:p.seat||"", ticketType:p.ticketType||"", ticketFee:!!p.ticketFee,
    ticketDiscount:(p.ticketDiscount!=null?p.ticketDiscount:null), ticketExtra:p.ticketExtra||0,
    ticketTransferred:!!p.ticketTransferred };
}
function hasTopTicket(p){ return !!(p.seat && p.seat.trim()); }
// 모든 티켓을 순서대로: [맨위, ...extra]. 맨 위가 없으면 빈 배열(invariant).
function allTickets(p){
  const ex = Array.isArray(p.extraTickets) ? p.extraTickets : [];
  return hasTopTicket(p) ? [topTicketObj(p), ...ex] : ex.slice();
}
function ticketCount(p){ return allTickets(p).filter(t=>t.seat && t.seat.trim()).length; }
// 좌석 있는 티켓만 골라 맨 위→평면필드, 나머지→extraTickets로 반영.
function setTickets(p, list){
  const clean = (list||[]).filter(t=>t && t.seat && String(t.seat).trim())
    .map(t=>({ seat:String(t.seat).trim(), ticketType:t.ticketType||"", ticketFee:!!t.ticketFee,
      ticketDiscount:(t.ticketDiscount!=null?t.ticketDiscount:null), ticketExtra:t.ticketExtra||0,
      ticketTransferred:!!t.ticketTransferred }));
  if(clean.length===0){
    p.seat=""; p.ticketType=""; p.ticketFee=false; p.ticketDiscount=null; p.ticketExtra=0; p.ticketTransferred=false;
    p.extraTickets=[]; return;
  }
  const t0=clean[0];
  p.seat=t0.seat; p.ticketType=t0.ticketType; p.ticketFee=t0.ticketFee;
  p.ticketDiscount=t0.ticketDiscount; p.ticketExtra=t0.ticketExtra; p.ticketTransferred=t0.ticketTransferred;
  p.extraTickets=clean.slice(1);
}

function formatKRW(n){
  return n.toLocaleString("ko-KR") + "원";
}

// HTML 특수문자 이스케이프. 템플릿 문자열로 innerHTML/속성에 끼워 넣는 동적 문자열
// (사용자 입력: 좌석·메모·직접입력 티켓명 / 데이터 이름: 배우·배역·등급·대결명)에 사용해
// 따옴표·꺾쇠·앰퍼샌드로 인한 렌더 깨짐·주입을 막는다.
function escHtml(s){
  return String(s==null ? "" : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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

// 팝오버 입력값을 읽어 티켓 필드 객체로 반환(스케줄·모달 공용). scope = 검색 범위 엘리먼트.
function parseTicketPopover(scope, idx){
  const checked = scope.querySelector(`input[name="tkopt-${idx}"]:checked`);
  const feeCb = scope.querySelector(`.tk-fee[data-idx="${idx}"]`);
  const transferCb = scope.querySelector(`.tk-transfer[data-idx="${idx}"]`);
  const extraInp = scope.querySelector(`.tk-extra[data-idx="${idx}"]`);
  const out = { ticketFee: feeCb ? feeCb.checked : false, ticketTransferred: transferCb ? transferCb.checked : false };
  const extra = Number((extraInp && extraInp.value || "").replace(/[^0-9.]/g,""));
  out.ticketExtra = (isFinite(extra) && extra > 0) ? Math.round(extra) : 0;
  if(checked && checked.value === "__custom__"){
    const nameInp = scope.querySelector(`.tk-custom-name[data-idx="${idx}"]`);
    const rateInp = scope.querySelector(`.tk-custom-rate[data-idx="${idx}"]`);
    const cname = (nameInp && nameInp.value || "").trim();
    let crate = Number(rateInp && rateInp.value); if(!isFinite(crate)) crate = 0;
    crate = Math.max(0, Math.min(100, crate));
    if(cname){ out.ticketType = cname; out.ticketDiscount = crate; }
    else { out.ticketType = ""; out.ticketDiscount = null; }
  } else {
    out.ticketType = checked ? checked.value : "";
    out.ticketDiscount = null;
  }
  return out;
}

// 티켓 선택 팝오버: 해당 등급의 티켓 목록(이름·할인율·가격) + 직접 입력 + 수수료 + 저장/해제
// tk = 편집 대상 티켓 객체 {ticketType, ticketFee, ticketDiscount, ticketExtra, ticketTransferred}
function buildTicketPopover(idx, grade, tk){
  const perf = performanceData.performances[idx] || {};
  tk = tk || {};
  const ticketType = tk.ticketType || "";
  const ticketFee = !!tk.ticketFee;
  const isCustom = tk.ticketDiscount != null; // 임의 할인권 선택 상태
  const customName = isCustom ? escHtml(ticketType) : "";
  const customRate = isCustom ? tk.ticketDiscount : "";
  // 이 공연에 적용 가능한 티켓만 + 정렬: 위 고정(sort>=0 오름차순) → 가운데(sort 없음: 할인율↓·가나다) → 아래 고정(sort<0)
  const applicable = grade.prices.filter(pr=>priceAppliesTo(pr, perf));
  const topG = applicable.filter(p=>typeof p.sort==='number' && p.sort>=0).sort((a,b)=>a.sort-b.sort);
  const botG = applicable.filter(p=>typeof p.sort==='number' && p.sort<0).sort((a,b)=>a.sort-b.sort);
  const midG = applicable.filter(p=>typeof p.sort!=='number')
    .sort((a,b)=> (b.discount||0)-(a.discount||0) || a.name.localeCompare(b.name,'ko'));
  const prices = [...topG, ...midG, ...botG];
  const selEntry = isCustom ? null : resolveTicketEntry(grade, ticketType); // 옛 이름(alias)도 해당 타입으로 선택 표시
  return `
    <div class="ticket-popover" data-idx="${idx}">
      <div class="popover-date">${perfDateLabel(perf)}</div>
      <div class="ticket-popover-title">${grade.name}석 티켓 선택</div>
      <div class="ticket-options">
        ${prices.map(pr=>`
          <label class="ticket-option">
            <input type="radio" name="tkopt-${idx}" value="${escHtml(pr.name)}" ${(selEntry===pr)?'checked':''}>
            <span class="to-name">${escHtml(pr.name)}</span>
            <span class="to-disc">${pr.discount ? pr.discount+'% 할인' : '정가'}</span>
            <span class="to-price">${formatKRW(pr.price)}</span>
          </label>
        `).join("")}
        <label class="ticket-option ticket-custom">
          <input type="radio" name="tkopt-${idx}" value="__custom__" ${isCustom?'checked':''}>
          <input type="text" class="tk-custom-name" data-idx="${idx}" placeholder="할인권 이름" value="${customName}">
          <input type="number" class="tk-custom-rate" data-idx="${idx}" placeholder="0" min="0" max="100" value="${customRate}"><span class="tk-pct">%</span>
        </label>
      </div>
      <div class="ticket-fee-row">
        <label class="tk-fee-label"><input type="checkbox" class="tk-fee" data-idx="${idx}" ${ticketFee?'checked':''}> 수수료</label>
        <label class="tk-fee-label"><input type="checkbox" class="tk-transfer" data-idx="${idx}" ${tk.ticketTransferred?'checked':''}> 양도받음</label>
        <span class="tk-extra-group">기타 <input type="text" inputmode="numeric" class="tk-extra" data-idx="${idx}" value="${tk.ticketExtra ? tk.ticketExtra : ''}" placeholder="0">원</span>
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
  const allRoles = castRoleObjs().map(c=>c.role);
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
            <button class="match-head-btn" data-match="${escHtml(m.name)}" style="background:none;border:none;color:${hasFilter?'var(--gold)':'inherit'};font:inherit;font-weight:inherit;cursor:pointer;padding:0;display:flex;align-items:center;gap:4px;">
              <span class="role-name">${escHtml(m.name)}</span><span class="col-arrow">&#9662;${hasFilter ? `<span class="col-filter-badge">${sel.size}</span>` : ""}</span>
            </button>
            ${isOpen ? `
              <div class="role-dropdown align-right">
                <div class="role-dropdown-title">결과 필터</div>
                ${opts.map(o=>`<label class="role-dropdown-item"><input type="checkbox" data-match="${escHtml(m.name)}" data-val="${escHtml(o.v)}" ${sel.has(o.v)?'checked':''}> ${escHtml(o.label)}</label>`).join("")}
                <div class="role-dropdown-actions"><button class="match-clear-btn" data-match="${escHtml(m.name)}">모두 해제</button></div>
                <div class="role-dropdown-actions" style="border-top:none; margin-top:0; padding-top:0;"><button class="match-hide-btn" data-match="${escHtml(m.name)}">숨기기</button></div>
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
            <button class="role-head-btn" data-role="${escHtml(role)}" style="background:none; border:none; color:${hasFilter?'var(--gold)':'inherit'}; font:inherit; font-weight:inherit; cursor:pointer; padding:0; display:flex; align-items:center; gap:4px;">
              <span class="role-name">${escHtml(scheduleRoleLabel(role))}</span><span class="col-arrow">&#9662;${hasFilter ? `<span class="col-filter-badge">${selected.size}</span>` : ""}</span>
            </button>
            ${isOpen ? `
              <div class="role-dropdown ${isLast?'align-right':''}">              <div class="role-dropdown-title">배우 선택</div>
                ${roleInfo.actors.filter(a=>{
                  if(a.role==="cast") return true;
                  // cast 아닌 배우는 실제 공연 출연 기록이 있을 때만 표시
                  return performanceData.performances.some(p=>castVisibleNamesOf(p.cast[role]).includes(a.name));
                }).map(a=>`
                  <label class="role-dropdown-item">
                    <input type="checkbox" data-role="${escHtml(role)}" data-actor="${escHtml(a.name)}" ${selected.has(a.name)?'checked':''}>
                    ${escHtml(a.name)}
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
    const ticketTransferred = !!p.ticketTransferred; // 양도받은 티켓
    const ticketDiscount = (p.ticketDiscount != null) ? p.ticketDiscount : null; // 임의 할인권이면 할인율
    const gradeName = gradeOf((p.seat||"").trim());          // 좌석 → 등급
    const grade = gradeName ? performanceData.grades.find(g=>g.name===gradeName) : null;

    const seatVal = (p.seat||"").trim();
    const seatInvalid = !isValidSeat(p.seat);                // 빈 값은 invalid 아님
    const eyeColor = seatInvalid ? '#e0594a' : (seatVal ? 'var(--gold)' : 'var(--ink-dim)');
    const eyeOpacity = (seatVal || seatInvalid) ? 1 : 0.3;
    const tCount = ticketCount(p);                            // 다중 티켓 수

    let ticketCell = "";
    if(showTicket){
      let inner;
      if(!grade){
        // 좌석 미입력/무효 → 등급을 알 수 없어 티켓 선택 불가
        inner = `<span class="tk-none">—</span>`;
      } else {
        const gradeChip = `<span class="tk-grade" style="background:${gradeFillVar(gradeName)};">${gradeName[0]}</span>`;
        const sel = resolveTicketEntry(grade, ticketType);
        const discVal = (ticketDiscount != null) ? ticketDiscount : (sel ? (sel.discount||0) : null);
        const transferCls = ticketTransferred ? ' transferred' : '';
        const transferDot = ticketTransferred ? `<span class="tk-transfer-dot" title="양도받음"></span>` : '';
        if(ticketType && discVal != null){
          // 선택 완료(등록 티켓 또는 임의 할인권): 등급 첫글자 · 티켓 이름 첫글자 · 할인율
          inner = `<button class="ticket-trigger selected${transferCls}" data-idx="${idx}" title="티켓 변경">`
            + gradeChip
            + `<span class="tk-name">${escHtml(ticketType[0])}</span>`
            + `<span class="tk-disc">${discVal}%${transferDot}</span>`
            + `</button>`;
        } else {
          // 미선택: 등급 첫글자 + 티켓 아이콘
          inner = `<button class="ticket-trigger${transferCls}" data-idx="${idx}" title="티켓 선택">`
            + gradeChip
            + `<span class="tk-icon" aria-hidden="true">&#127903;</span>${transferDot}`
            + `</button>`;
        }
      }
      const popover = (ticketPopoverIdx===idx && grade) ? buildTicketPopover(idx, grade, topTicketObj(p)) : "";
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
          return `<span class="name ${baseCls} ${zeroCls}">${escHtml(n)}</span>`;
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
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="seat-input-wrap" style="position:relative; display:inline-flex;">
              <input class="seat-input${seatInvalid ? ' invalid-seat' : ''}" type="text" value="${escHtml(p.seat)}" placeholder="층-열-번" data-idx="${idx}" data-field="seat">
              ${multiTicketMode
                ? `<button class="ticket-add-corner" data-idx="${idx}" ${tCount<1?'disabled':''} title="티켓 관리">+${tCount>=2?`<span class="ticket-count-badge">${tCount}</span>`:""}</button>`
                : (tCount>=2 ? `<button class="ticket-count-corner" data-idx="${idx}" title="티켓 ${tCount}장 관리">${tCount}</button>` : "")}
            </span>
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
              <textarea class="memo-popover-input" rows="3" placeholder="메모 입력" data-idx="${idx}">${escHtml(p.note||"")}</textarea>
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
          const noteAttr = (res && res.note) ? ` title="${escHtml(res.note)}"` : "";
          return `<td class="match-cell ${cls}"${style}${noteAttr}>${escHtml(disp)}</td>`;
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
      const perf = performanceData.performances[idx];
      const f = parseTicketPopover(body, idx);
      perf.ticketType = f.ticketType; perf.ticketDiscount = f.ticketDiscount;
      perf.ticketFee = f.ticketFee; perf.ticketExtra = f.ticketExtra; perf.ticketTransferred = f.ticketTransferred;
      ticketPopoverIdx = null;
      renderSchedule();
      renderStats();   // 티켓 변경 → 통계(티켓 금액) 갱신
      renderSeatMap(true); // 시트맵 갱신(사용자 줌/위치 유지)
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
      performanceData.performances[idx].ticketTransferred = false;
      ticketPopoverIdx = null;
      renderSchedule();
      renderStats();   // 티켓 해제 → 통계(티켓 금액) 갱신
      renderSeatMap(true); // 시트맵 갱신(사용자 줌/위치 유지)
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
      const p = performanceData.performances[idx];
      const seats = allTickets(p).map(t=>(t.seat||"").trim()).filter(Boolean);
      if(!seats.length) return;
      showSeatOverlay(seats, seats[0], "맨 위 좌석", "나의 좌석"); // 다중=맨 위 이중 테두리, 단일=나의 좌석(단일 테두리)
    });
  });

  body.querySelectorAll(".ticket-add-corner, .ticket-count-corner").forEach(btn=>{
    btn.addEventListener("click", e=>{
      e.preventDefault(); e.stopPropagation();
      if(btn.disabled) return;
      openTicketManager(+btn.dataset.idx);
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
      const p = performanceData.performances[i];
      const val = e.target.value;
      if(field === "seat" && val.trim() === "" && Array.isArray(p.extraTickets) && p.extraTickets.length){
        // 맨 위 좌석을 비우면: 맨 위 티켓 삭제하고 두 번째 티켓을 맨 위로 승격
        setTickets(p, p.extraTickets);
      } else if(field === "seat" && val.trim() !== "" && Array.isArray(p.extraTickets)
                && p.extraTickets.some(t=>(t.seat||"").trim()===val.trim())){
        // 추가 티켓과 같은 좌석이면 거부(모달과 동일하게 중복 차단)
        alert("이미 같은 좌석의 티켓이 있습니다.");
        e.target.value = (e.target.dataset.origValue !== undefined) ? e.target.dataset.origValue : (p.seat||"");
        e.target.classList.toggle("invalid-seat", !isValidSeat(e.target.value));
        applyEyeState(body.querySelector(`.seat-eye-btn[data-idx="${i}"]`), e.target.value);
        return; // 갱신·저장 없이 종료
      } else {
        p[field] = val;
      }
      // 좌석이 바뀌었으니 스케줄(티켓 등급·눈 표시)·통계·좌석맵을 갱신
      renderSchedule();
      renderStats();
      renderSeatMap(true); // 좌석맵 줌/위치 유지
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
// 마티네(평일 낮공연): 시작 시각이 17시 이전이면서 주말·공휴일이 아닌 날
function isMatinee(p){
  const h = parseInt((p.time||"").slice(0,2), 10);
  if(!(Number.isFinite(h) && h < 17)) return false;
  const dow = dowOf(p.date);
  if(dow===0 || dow===6) return false;            // 토·일 제외
  if(holidaySet.has((p.date||"").trim())) return false; // 공휴일 제외
  return true;
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
  // 'all'(기본): 공연 중 실제 출연한 배우만(비중 0 = 그날 미출연이므로 제외) 각 1회 집계
  return items.filter(it=>it.weight>0).map(it=>({name:it.name, amount:1}));
}

function fmtStatValue(v){
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

let castStatsMode = "all"; // 'first' | 'start' | 'all' | 'weighted'
let matchAssumeDefaultWin = false; // 대결: 결과 미기록 완료공연을 defaultWinner 승리로 간주
let matchStatsOrder = [];          // 대결 통계 블록 표시 순서(키 배열)
let collapsedMatchStats = new Set(); // 닫힌 대결 통계 블록 키
let etcStatsOrder = [];            // 기타 통계 세부 블록 표시 순서
let collapsedEtcStats = new Set(); // 닫힌 기타 통계 세부 블록 키

/* 포인터 기반 블록 순서 변경(데스크탑·모바일 공용, HTML5 DnD 대체).
   - container 안의 blockSel 블록들을 handleSel(드래그 손잡이)로 끌어 재정렬
   - keyOf(block)=식별자 문자열, applyOrder(새 키 배열)=순서 반영(저장·재렌더 포함)
   - 5px 이상 움직여야 시작(손잡이 단순 탭은 무시) */
function setupBlockReorder(container, blockSel, handleSel, keyOf, applyOrder){
  if(!container) return;
  let fromKey=null, pid=null, active=false, moved=false, startY=0;
  const blocks=()=>[...container.querySelectorAll(blockSel)];
  const clearMarks=()=>blocks().forEach(b=>{ b.style.borderTop=""; b.style.borderBottom=""; b.style.opacity=""; });
  function targetAt(y){
    for(const b of blocks()){ if(keyOf(b)===fromKey) continue; const r=b.getBoundingClientRect(); if(y < r.top+r.height/2) return b; }
    return null; // 모든 블록 아래 → 맨 끝
  }
  container.querySelectorAll(handleSel).forEach(h=>{
    const block=h.closest(blockSel); if(!block) return;
    h.style.touchAction="none";
    h.addEventListener("pointerdown", e=>{
      if(e.button!=null && e.button!==0) return;
      fromKey=keyOf(block); pid=e.pointerId; active=true; moved=false; startY=e.clientY;
      try{ h.setPointerCapture(pid); }catch(_){}
      e.preventDefault();
    });
    h.addEventListener("pointermove", e=>{
      if(!active || e.pointerId!==pid) return;
      if(!moved){ if(Math.abs(e.clientY-startY)<=5) return; moved=true; block.style.opacity="0.4"; }
      e.preventDefault();
      blocks().forEach(b=>{ b.style.borderTop=""; b.style.borderBottom=""; });
      const tgt=targetAt(e.clientY);
      if(tgt) tgt.style.borderTop="2px solid var(--gold)";
      else { const bs=blocks(); if(bs.length) bs[bs.length-1].style.borderBottom="2px solid var(--gold)"; }
    });
    const end=e=>{
      if(!active || (e && e.pointerId!=null && e.pointerId!==pid)) return;
      active=false;
      if(!moved){ fromKey=null; pid=null; clearMarks(); return; } // 단순 탭 → 무시
      const tgt=targetAt(e?e.clientY:startY); const beforeKey=tgt?keyOf(tgt):null;
      clearMarks();
      let keys=blocks().map(keyOf).filter(k=>k!==fromKey);
      if(beforeKey==null) keys.push(fromKey); else keys.splice(keys.indexOf(beforeKey),0,fromKey);
      fromKey=null; pid=null;
      applyOrder(keys);
    };
    h.addEventListener("pointerup", end);
    h.addEventListener("pointercancel", ()=>{ active=false; moved=false; fromKey=null; pid=null; clearMarks(); });
  });
}

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
    <div class="tt-card total"><div class="label">총액</div><div class="value">${formatKRW(spentAmount + upcomingAmount)}</div></div>
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
              ${escHtml(name)}<br><small style="color:var(--ink-dim); font-size:10px;">${roleTag}</small>
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
      <div class="role-stat-block" data-key="${escHtml(c.role)}" data-idx="${orderIdx}" style="margin-bottom:14px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span class="role-drag-handle" style="color:var(--ink-dim); font-size:22px; line-height:1; cursor:grab; padding:4px 8px;">&#8942;&#8942;</span>
          <button class="role-toggle" data-role="${escHtml(c.role)}" style="display:flex; align-items:center; gap:6px; background:none; border:none; cursor:pointer; padding:0; font-size:13px; font-weight:700; color:var(--gold); flex:1; text-align:left;">
            <span class="role-toggle-arrow">${isCollapsed ? "&#9656;" : "&#9662;"}</span> ${escHtml(c.role)}
          </button>
          ${(c.role==="빌리"||c.role==="마이클") ? "" : `<button class="role-stat-del-btn stat-del-btn" data-role="${escHtml(c.role)}" title="${escHtml(c.role)} 삭제">삭제</button>`}
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

  setupBlockReorder(roleStatsEl, ".role-stat-block", ".role-drag-handle", b=>b.dataset.key, keys=>{
    roleStatsOrder = keys; saveState(); renderStats();
  });

  renderMatchStats();
  renderEtcStats();
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
        return `<tr><td>${escHtml(n)}</td><td>${s.total}</td><td>${s.win}</td><td>${s.loss}</td><td>${s.draw}</td><td>${rateStr(s)}</td></tr>`; }).join("")
        || `<tr><td colspan="6" style="color:var(--ink-dim);">기록 없음</td></tr>`;
      tableHtml = `<table class="role-stat-table"><thead><tr><th>배우</th><th>전체</th><th>승</th><th>패</th><th>무</th><th>승률</th></tr></thead><tbody>${rows}</tbody></table>`;
    } else {
      const m=b.m, main=m.roles[0], sub=m.roles[1];
      title = `${escHtml(m.name)} 대결 · ${escHtml(main)}×${escHtml(sub)} 승리`;
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
          const firstTd = si===0 ? `<td rowspan="${subs.length}">${escHtml(a0)}</td>` : "";
          rows += `<tr>${firstTd}<td>${escHtml(a1)}</td><td>${s.total}</td><td>${s.win}</td><td>${s.loss}</td><td>${s.draw}</td><td>${rateStr(s)}</td></tr>`;
        });
      });
      if(!rows) rows = `<tr><td colspan="7" style="color:var(--ink-dim);">기록 없음</td></tr>`;
      tableHtml = `<table class="role-stat-table"><thead><tr><th>${escHtml(main)}</th><th>${escHtml(sub)}</th><th>전체</th><th>승</th><th>패</th><th>무</th><th>승률</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    return `
      <div class="match-stat-block" data-key="${b.key}" style="margin-bottom:14px;">
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
  setupBlockReorder(el, ".match-stat-block", ".role-drag-handle", b=>b.dataset.key, keys=>{
    matchStatsOrder = keys; saveState(); renderMatchStats();
  });
}

/* 기타 통계: 월별 / 요일별(+마티네·휴일) / 티켓별. 각 세부 블록은 닫기(접기)·드래그 이동 가능. */
function renderEtcStats(){
  const el = document.getElementById("etcStats");
  if(!el) return;
  const perfs = performanceData.performances;
  const add = (b,p)=>{ b.total++; const e=isEnded(p), s=hasSeat(p); if(e){ b.ended++; if(s)b.watched++; } else if(s){ b.upcoming++; } };
  const nb = ()=>({total:0,ended:0,watched:0,upcoming:0});
  const cells = b=>`<td>${b.total}</td><td>${b.ended}</td><td>${b.watched}</td><td>${b.upcoming}</td>`;

  // ----- 월별 -----
  function monthHtml(){
    const m={};
    perfs.forEach(p=>{ const k=(p.date||"").slice(0,7); if(!k) return; (m[k]||(m[k]=nb())); add(m[k],p); });
    const rows = Object.keys(m).sort().map(k=>{
      const lbl = `${+k.slice(0,4)}년 ${+k.slice(5,7)}월`; // 2026년 7월
      return `<tr><td>${lbl}</td>${cells(m[k])}</tr>`;
    }).join("") || `<tr><td colspan="5" style="color:var(--ink-dim);">기록 없음</td></tr>`;
    return `<table class="role-stat-table"><thead><tr><th>월</th><th>전체</th><th>종료</th><th>관극</th><th>예매</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ----- 요일별 (+ 마티네 / 휴일(주말 제외)) -----
  function dowHtml(){
    const d = Array.from({length:7}, nb);
    const mat = nb(), hol = nb();
    perfs.forEach(p=>{
      const i = dowOf(p.date);
      if(i>=0) add(d[i], p);
      if(isMatinee(p)) add(mat, p);
      const weekend = (i===0 || i===6);
      if(holidaySet.has((p.date||"").trim()) && !weekend) add(hol, p);
    });
    let rows = DOW.map((name,i)=>`<tr><td>${name}</td>${cells(d[i])}</tr>`).join("");
    rows += `<tr class="etc-subrow"><td>마티네(평일 낮)</td>${cells(mat)}</tr>`;
    rows += `<tr class="etc-subrow"><td>휴일(주말 제외)</td>${cells(hol)}</tr>`;
    return `<table class="role-stat-table"><thead><tr><th>요일</th><th>전체</th><th>종료</th><th>관극</th><th>예매</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // ----- 티켓별 (등급 → 횟수 많은 순) -----
  function ticketHtml(){
    const gIdx={}; performanceData.grades.forEach((g,i)=>{ gIdx[g.name]=i; });
    const map={};
    perfs.forEach(p=>{
      if(!hasSeat(p)) return;
      const grade = gradeOf((p.seat||"").trim()) || "기타";
      const gradeObj = performanceData.grades.find(g=>g.name===grade);
      const ent = (p.ticketDiscount==null && gradeObj) ? resolveTicketEntry(gradeObj, p.ticketType) : null;
      // 옛 이름(alias)이면 통합 타입 이름으로 묶는다(임의 할인권/미지정은 그대로)
      const type = (p.ticketDiscount!=null) ? (p.ticketType||"임의 할인권") : (ent ? ent.name : (p.ticketType||"(미지정)"));
      const key = grade+"||"+type;
      const b = map[key] || (map[key]={grade, type, watched:0, upcoming:0, amount:0});
      if(isEnded(p)) b.watched++; else b.upcoming++;
      b.amount += ticketPriceOf(p.seat, p.ticketType, p.ticketFee, (p.ticketDiscount!=null?p.ticketDiscount:null), p.ticketExtra) || 0;
    });
    const arr = Object.values(map).sort((a,b)=>
      ((gIdx[a.grade]??99)-(gIdx[b.grade]??99)) || ((b.watched+b.upcoming)-(a.watched+a.upcoming)) || a.type.localeCompare(b.type,"ko"));
    if(!arr.length) return `<table class="role-stat-table"><thead><tr><th>등급</th><th>티켓 종류</th><th>관극</th><th>예매</th><th>총액</th></tr></thead><tbody><tr><td colspan="5" style="color:var(--ink-dim);">기록 없음</td></tr></tbody></table>`;
    // 등급 같은 값은 rowspan으로 병합
    let rows="", i=0;
    while(i<arr.length){
      let j=i; while(j<arr.length && arr[j].grade===arr[i].grade) j++;
      const span=j-i;
      for(let k=i;k<j;k++){
        const b=arr[k];
        const gradeTd = (k===i) ? `<td rowspan="${span}">${escHtml(b.grade)}</td>` : "";
        rows += `<tr>${gradeTd}<td>${escHtml(b.type)}</td><td>${b.watched}</td><td>${b.upcoming}</td><td>${formatKRW(b.amount)}</td></tr>`;
      }
      i=j;
    }
    return `<table class="role-stat-table"><thead><tr><th>등급</th><th>티켓 종류</th><th>관극</th><th>예매</th><th>총액</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  const blocks = {
    month:  { title:"월별 공연 통계",   html: monthHtml() },
    dow:    { title:"요일별 공연 통계", html: dowHtml() },
    ticket: { title:"티켓별 통계",       html: ticketHtml() },
  };
  const defaultOrder = ["month","dow","ticket"];
  const order=[];
  etcStatsOrder.forEach(k=>{ if(blocks[k] && order.indexOf(k)<0) order.push(k); });
  defaultOrder.forEach(k=>{ if(order.indexOf(k)<0) order.push(k); });

  el.innerHTML = order.map(k=>{
    const collapsed = collapsedEtcStats.has(k);
    return `
      <div class="etc-stat-block" data-key="${k}" style="margin-bottom:14px;">
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
          <span class="role-drag-handle" style="color:var(--ink-dim); font-size:22px; line-height:1; cursor:grab; padding:4px 8px;">&#8942;&#8942;</span>
          <button class="etc-toggle" data-key="${k}" style="display:flex; align-items:center; gap:6px; background:none; border:none; cursor:pointer; padding:0; font-size:13px; font-weight:700; color:var(--gold); flex:1; text-align:left;">
            <span>${collapsed ? "&#9656;" : "&#9662;"}</span> ${blocks[k].title}
          </button>
        </div>
        <div style="${collapsed ? 'display:none;' : ''}">${blocks[k].html}</div>
      </div>`;
  }).join("");

  el.querySelectorAll(".etc-toggle").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const k=btn.dataset.key;
      if(collapsedEtcStats.has(k)) collapsedEtcStats.delete(k); else collapsedEtcStats.add(k);
      saveState(); renderEtcStats();
    });
  });
  setupBlockReorder(el, ".etc-stat-block", ".role-drag-handle", b=>b.dataset.key, keys=>{
    etcStatsOrder = keys; saveState(); renderEtcStats();
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

function buildSeatSvgInner(highlight){
  const SEAT_SIZE = 0.78;
  const HALF = SEAT_SIZE/2;
  // highlight: 문자열(단일) 또는 {top, all:[...]}
  let topId = null; const hiSet = new Set();
  if(typeof highlight === "string"){ topId = highlight; if(highlight) hiSet.add(highlight); }
  else if(highlight){ topId = highlight.top || null; (highlight.all || []).forEach(id=>hiSet.add(id)); if(topId) hiSet.add(topId); }

  function seatMarkup(s){
    const g = gradeOf(s.id);
    const count = seatMapCount(s.id);
    const isHighlighted = hiSet.has(s.id);
    // 이중 테두리(맨 위 강조)는 하이라이트 좌석이 둘 이상(다중 티켓)일 때만. 단일이면 단일 테두리.
    const isTop = s.id===topId && hiSet.size > 1;
    const fill = gradeFillVar(g); // 좌석 채움은 등급 색(테두리 없음)
    const opacity = isHighlighted ? 1 : seatVisualStyle(count).opacity; // 강조 좌석=선명, 미관극=흐림
    // 선택 좌석(top)=이중·굵은 흰 테두리(강조), 그 외 강조=기존 단일 흰 테두리
    const extra = isTop
      ? `<rect x="${-HALF-0.24}" y="${-HALF-0.24}" width="${SEAT_SIZE+0.48}" height="${SEAT_SIZE+0.48}" rx="0.16" fill="none" stroke="#fff" stroke-width="0.14"></rect>`
        + `<rect x="${-HALF-0.08}" y="${-HALF-0.08}" width="${SEAT_SIZE+0.16}" height="${SEAT_SIZE+0.16}" rx="0.1" fill="none" stroke="#fff" stroke-width="0.14"></rect>`
      : (isHighlighted ? `<rect x="${-HALF-0.12}" y="${-HALF-0.12}" width="${SEAT_SIZE+0.24}" height="${SEAT_SIZE+0.24}" rx="0.12" fill="none" stroke="#fff" stroke-width="0.12"></rect>` : "");
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

  // 층 목록은 데이터에서 도출(공연장 파일마다 층 구성이 달라도 안전: 빈 층에 대한 Math.min(...[]) 회피)
  const floors = [...new Set(seatmapData.seats.map(s=>s.floor))].sort((a,b)=>a-b);
  if(!floors.length) return { markup:"", bbox:{ x:0, y:0, w:10, h:10 } };
  const LABEL_ONLY_H = 1.4; // 좌석을 숨긴 층의 축소된 박스 높이 (라벨만 보임)
  // 층 사이 간격(해당 층 '위'에 적용). 음수면 위층과 더 붙음.
  const FLOOR_GAP_DEFAULT = -4;
  const FLOOR_GAPS = { 3: -4.5 }; // 키는 층 번호, 값은 그 층 위쪽 간격(2-3층 = -4.5)
  const gapAbove = (floor)=>{
    const g = FLOOR_GAPS[floor] ?? FLOOR_GAPS[String(floor)];
    return g === undefined ? FLOOR_GAP_DEFAULT : g;
  };
  const BOTTOM_EXTRA = 1; // 맨 아래층 아래 여유 공간 (미니맵이 좌석을 가리지 않도록)

  // 1차: 각 층의 원래 경계 계산 (가장 넓은 층의 너비로 모두 통일)
  const floorBoxes = {};
  let maxBw = 0;
  floors.forEach(floor=>{
    const seats = seatmapData.seats.filter(s=>s.floor===floor);
    const xs = seats.map(s=>s.svgX), ys = seats.map(s=>s.svgY);
    // 외곽선(outline)·무대(stage)가 있으면 박스 범위에 포함(좌석 밖으로 나가도 잘리지 않게)
    const fmeta = (seatmapData.floorMeta||{})[floor] || {};
    (fmeta.outline||[]).forEach(poly=>poly.forEach(pt=>{ xs.push(pt[0]); ys.push(pt[1]); }));
    if(fmeta.stage){ const s=fmeta.stage; xs.push(s.cx-s.w/2, s.cx+s.w/2); ys.push(s.cy-s.h/2, s.cy+s.h/2); }
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
  floors.forEach((floor, idx)=>{
    const isHidden = hiddenFloors.has(String(floor));
    const box = floorBoxes[floor];
    const thisH = isHidden ? LABEL_ONLY_H : box.bh;
    if(idx > 0) cum += gapAbove(floor); // 첫 층 위에는 간격 없음
    const deltaY = cum - box.by;
    layout[floor] = { isHidden, thisH, deltaY, box };
    cum += thisH;
  });
  const totalHeight = cum + BOTTOM_EXTRA;

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

    // 외곽선: 좌석 그림에 맞춰 그린 outline(있으면)으로, 없으면 기본 사각 박스
    let border;
    if(meta && Array.isArray(meta.outline) && meta.outline.length && !isHidden){
      const polys = meta.outline.map(poly=>
        `<polyline points="${poly.map(p=>p[0]+','+p[1]).join(' ')}" fill="none" stroke="var(--line)" stroke-width="0.06"></polyline>`).join("");
      const stage = meta.stage
        ? `<rect x="${meta.stage.cx-meta.stage.w/2}" y="${meta.stage.cy-meta.stage.h/2}" width="${meta.stage.w}" height="${meta.stage.h}" rx="0.2" fill="none" stroke="var(--line)" stroke-width="0.06"></rect>`
          + `<text x="${meta.stage.cx}" y="${meta.stage.cy+0.25}" text-anchor="middle" font-size="0.7" font-weight="700" letter-spacing="0.15" fill="var(--ink-dim)">STAGE</text>`
        : "";
      border = polys + stage
        + `<text x="${bx+0.35}" y="${by+0.55}" font-size="0.5" font-weight="700" fill="var(--gold)">${floor}F</text>`;
    } else if(isHidden){
      // 숨긴 층: 박스 없이 라벨만
      border = `<text x="${bx+0.35}" y="${by+0.55}" font-size="0.5" font-weight="700" fill="var(--gold)">${floor}F (숨김)</text>`;
    } else {
      border = `<rect x="${bx}" y="${by}" width="${bw}" height="${thisH}" rx="0.6" fill="none" stroke="var(--line)" stroke-width="0.06"></rect>
        <text x="${bx+0.35}" y="${by+0.55}" font-size="0.5" font-weight="700" fill="var(--gold)">${floor}F</text>`;
    }

    let rowLabels = "";
    let seatMarkupStr = "";
    if(!isHidden){
      if(meta){ // floorMeta가 있는 층만 행 번호 라벨 표시(없어도 좌석 자체는 그림)
        const labels = [];
        for(let r=1; r<=meta.centerMaxRow; r++){
          const y = (seats.find(s=>s.floor===floor && s.row===r && s.column>=16) || {}).svgY;
          if(y===undefined) continue;
          labels.push(`<text x="${meta.centerOriginX-0.5}" y="${y+0.14}" text-anchor="end" font-size="0.32" fill="var(--ink-dim)">${r}</text>`);
          labels.push(`<text x="${meta.centerOriginX+meta.centerWidth+0.5}" y="${y+0.14}" text-anchor="start" font-size="0.32" fill="var(--ink-dim)">${r}</text>`);
        }
        rowLabels = labels.join("");
      }
      seatMarkupStr = seats.map(seatMarkup).join("");
    }

    return `<g class="floor-group" data-floor="${floor}" transform="translate(0,${deltaY})">${border}${rowLabels}${seatMarkupStr}</g>`;
  }).join("");

  // 강조 좌석들의 렌더 좌표(층 deltaY 반영) — 팝업 중심/전체 맞춤용
  let topPos = null; const hiPos = [];
  hiSet.forEach(id=>{
    const s = seatmapData.seats.find(x=>x.id===id);
    if(s && layout[s.floor] && !layout[s.floor].isHidden){
      const pos = { x: s.svgX, y: s.svgY + layout[s.floor].deltaY };
      hiPos.push(pos);
      if(id===topId) topPos = pos;
    }
  });

  return { markup, bbox: dynamicBBox, topPos, hiPos };
}

let mainViewBox = null;
let pendingSeatViewBox = null; // 새로고침 복원용: 저장된 시트맵 뷰(첫 렌더에서 1회 적용)
let seatNeedsInitialFit = false; // 초기 뷰가 숨겨진 상태(뷰포트 0)에서 계산됨 → 좌석맵이 보일 때 재맞춤 필요
let showSeatNumbers = true; // 좌석번호 기본 표시
let hiddenFloors = new Set(); // 토글로 숨긴 층 (문자열 "1","2","3")
let minimapVisible = true; // 미니맵 표시 여부
let previewDefaultZoom = 2; // 좌석 보기 팝업 기본 배율(1배=전체 맵 ~ 5배)

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
  body.innerHTML = castRoleObjs().map(c=>{
    const role = c.role;
    const sel = seatFilterTemp[role] || new Set();
    const actors = c.actors.filter(a=> a.role==="cast"
      || performanceData.performances.some(p=>castVisibleNamesOf(p.cast[role]).includes(a.name)));
    return `
      <div class="filter-role">
        <div class="filter-role-title">${escHtml(role)}</div>
        <div class="filter-actor-list">
          ${actors.map(a=>`<label class="filter-actor"><input type="checkbox" data-role="${escHtml(role)}" data-actor="${escHtml(a.name)}" ${sel.has(a.name)?'checked':''}> ${escHtml(a.name)}</label>`).join("")}
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

// SVG는 preserveAspectRatio 기본값(xMidYMid meet)이라 viewBox 비율과 요소 비율이 다르면
// 가장자리에 빈 여백(레터박스)이 생긴다. 화면 좌표를 SVG 좌표로 바꿀 땐 이 배율·여백을 반영해야
// 팬·핀치·휠·미니맵이 손가락/커서와 정확히 일치한다.
function svgMeetScale(rect, vb){ return Math.min(rect.width/vb.w, rect.height/vb.h); }
function clientToSvgPt(rect, vb, clientX, clientY){
  const s = svgMeetScale(rect, vb);
  const offX = (rect.width - vb.w*s)/2, offY = (rect.height - vb.h*s)/2; // 중앙 정렬 여백
  return { x: vb.x + (clientX - rect.left - offX)/s, y: vb.y + (clientY - rect.top - offY)/s };
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
  const fm = seatmapData.floorMeta || {};
  const meta = fm[1] || fm[Object.keys(fm).sort((a,b)=>a-b)[0]];
  if(!meta) return clampViewBox({ x:SEAT_BBOX.x, y:SEAT_BBOX.y, w:SEAT_BBOX.w, h:SEAT_BBOX.h }); // floorMeta 없으면 전체 보기
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
    // 좌석맵 페이지가 아직 숨겨져(display:none) 뷰포트 크기가 0이면 임시값이므로, 보일 때 재맞춤한다.
    const vp = document.getElementById("svgViewport");
    seatNeedsInitialFit = !(vp && vp.clientWidth > 0);
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
      if(!dist) return;                          // 두 점이 겹치면 0 나눗셈(Infinity) 방지
      const midX = (pts[0].x+pts[1].x)/2, midY = (pts[0].y+pts[1].y)/2;
      const rect = mainSvg.getBoundingClientRect();
      const scaleFactor = pinchStartDist / dist; // 손가락이 멀어지면(확대) factor<1
      const c = clientToSvgPt(rect, pinchStartVb, midX, midY); // 레터박스 보정된 핀치 중심
      mainViewBox = clampViewBox({
        x: c.x - (c.x-pinchStartVb.x)*scaleFactor,
        y: c.y - (c.y-pinchStartVb.y)*scaleFactor,
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
    const s = svgMeetScale(rect, startVb);   // 레터박스 반영한 실제 화면 배율
    mainViewBox = clampViewBox({
      x: startVb.x - dxScreen/s,
      y: startVb.y - dyScreen/s,
      w: startVb.w, h: startVb.h
    });
    applyMainViewBox();
  });

  function endPointer(e){
    activePointers.delete(e.pointerId);
    if(activePointers.size<2){ pinchStartDist = null; pinchStartVb = null; }
    if(activePointers.size===1){
      // 핀치에서 한 손가락만 떼면 남은 손가락으로 단일 팬을 다시 시작(끊김 방지)
      const [pt] = [...activePointers.values()];
      isDragging = true; svgDidDrag = true;          // 제스처 직후 click(좌석 선택) 억제 유지
      startScreenX = pt.x; startScreenY = pt.y; startVb = { ...mainViewBox };
    }
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
    const c = clientToSvgPt(rect, mainViewBox, e.clientX, e.clientY); // 레터박스 보정된 커서 위치
    const factor = e.deltaY > 0 ? 1.12 : 0.89;
    zoomBy(factor, c.x, c.y);
  }, { passive:false });
  } // end panReady guard

  // ── 미니맵: 터치/클릭하면 그 지점으로 포커스 이동, 드래그하면 따라서 화면 이동 ──
  // (on* 할당이라 재렌더 시 중복 등록되지 않음)
  const miniSvg = document.getElementById("minimapSvg");
  const miniToSvg = (clientX, clientY)=>{
    const r = miniSvg.getBoundingClientRect();
    return clientToSvgPt(r, SEAT_BBOX, clientX, clientY); // 미니맵도 meet 레터박스 보정
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

  const roles = castRoleObjs().map(c=>c.role);
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
            return `<span class="name ${cls}">${escHtml(n)}</span>`;
          }).join("")}</td>`;
        }).join("");
        const dcolor = dateColorOf(p.date);
        const noteVal = (p.note || "").trim();
        const memoCell = noteVal
          ? `<button class="seat-memo-icon" data-note="${escHtml(noteVal)}" title="${escHtml(noteVal)}" style="background:none; border:none; cursor:pointer; padding:2px; color:var(--gold); display:inline-flex;">
               <svg width="13" height="16" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="1" y="1" width="14" height="18" rx="1.5"/><line x1="4" y1="6" x2="12" y2="6"/><line x1="4" y1="10" x2="12" y2="10"/><line x1="4" y1="14" x2="9" y2="14"/></svg>
             </button>`
          : "";
        return `
          <tr>
            <td class="date-cell"${dcolor?` style="color:${dcolor}"`:''}>${shortDateDow(p.date)}</td>
            <td class="time-cell"${dcolor?` style="color:${dcolor}"`:''}>${p.time}</td>
            <td style="text-align:center;">${memoCell}</td>
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
  detail.querySelectorAll(".seat-memo-icon").forEach(btn=>{
    btn.addEventListener("click", ()=> showToast(btn.dataset.note));
  });
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

/* 통계 상위 섹션(배역별/조합/대결) 접기 — "배역 통계 추가"와 동일 방식 */
let collapsedStatSecs = new Set(); // 닫혀있는 섹션 키 ("role","combo","match")
function applyStatSecsCollapse(){
  document.querySelectorAll(".collapse-h2[data-sec]").forEach(h=>{
    const key = h.dataset.sec;
    const collapsed = collapsedStatSecs.has(key);
    const body = document.querySelector(`.stat-sec-body[data-sec-body="${key}"]`);
    const arrow = h.querySelector(".collapse-arrow");
    if(body) body.style.display = collapsed ? "none" : "";
    if(arrow) arrow.innerHTML = collapsed ? "&#9656;" : "&#9662;";
  });
}
document.querySelectorAll(".collapse-h2[data-sec]").forEach(h=>{
  h.addEventListener("click", ()=>{
    const key = h.dataset.sec;
    if(collapsedStatSecs.has(key)) collapsedStatSecs.delete(key);
    else collapsedStatSecs.add(key);
    applyStatSecsCollapse();
    saveState();
  });
});

function renderComboPicker(){
  const picker = document.getElementById("comboPicker");
  const roles = castRoleObjs().map(c=>c.role);
  picker.innerHTML = `
    <div class="combo-actor-chips">
      ${roles.map(role=>{
        const idx = comboRoleSelection.indexOf(role);
        const selected = idx>=0;
        const badge = selected ? `<span class="chip-badge">${idx+1}</span>` : "";
        return `<div class="combo-chip ${selected?'selected':''}" data-role="${escHtml(role)}">${escHtml(role)}${badge}</div>`;
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
  return `<div class="combo-result-block" data-block-id="${id}">${titleBar}${body}</div>`;
}

function buildComboTitleBar(id, label, isPreset, isCollapsed){
  const deleteBtn = isPreset ? "" : `<button class="combo-delete-btn stat-del-btn" data-id="${id}">삭제</button>`;
  const dragHandle = `<span class="combo-drag-handle" style="color:var(--ink-dim); font-size:22px; line-height:1; cursor:grab; padding:4px 8px;">&#8942;&#8942;</span>`;
  return `
    <div class="combo-title-bar" style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
      ${dragHandle}
      <button class="combo-toggle" data-id="${id}" style="display:flex; align-items:center; gap:6px; background:none; border:none; cursor:pointer; padding:0; font-size:13px; font-weight:700; color:var(--gold); flex:1; text-align:left;">
        <span class="combo-toggle-arrow">${isCollapsed ? "&#9656;" : "&#9662;"}</span> ${escHtml(label)}
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
  const head = `<tr>${rolesSelected.map(r=>`<th>${escHtml(r)}</th>`).join("")}<th>전체</th><th>종료</th><th>관극</th><th>예매</th></tr>`;
  const body = rows.map((row,idx)=>{
    const roleCells = rolesSelected.map((_,col)=>{
      if(skip[idx][col]) return "";
      return `<td rowspan="${rowspan[idx][col]}">${escHtml(row.tuple[col])}</td>`;
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
  return `<div class="combo-result-block" data-block-id="${id}">${titleBar}${body}</div>`;
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

  setupBlockReorder(container, ".combo-result-block", ".combo-drag-handle", b=>b.dataset.blockId, keys=>{
    // DOM 키 순서에 맞춰 comboBlocks 재정렬(키에 없는 항목은 뒤로)
    comboBlocks.sort((a,b)=>{
      const ia=keys.indexOf(String(a.id)), ib=keys.indexOf(String(b.id));
      return (ia<0?1e9:ia) - (ib<0?1e9:ib);
    });
    saveState(); renderComboResults();
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
// 한 도메인에서 여러 막올림(공연)을 구분: meta.json의 id로 localStorage 네임스페이스
let APP_ID = "default";
let STORAGE_KEY = "makollim:state:v1:" + APP_ID;
// id는 영소문자·숫자·_·- 만 허용
function sanitizeAppId(v){ return (String(v||"").toLowerCase().replace(/[^a-z0-9_-]/g,"")) || "default"; }
function setupStorageNamespace(id){
  APP_ID = sanitizeAppId(id);
  STORAGE_KEY = "makollim:state:v1:" + APP_ID;
}

// 컬러 테마 (CSS data-theme로 적용). 기본 = amber
const COLOR_THEMES = ["amber","midnight","steel","sage","rose","red",
  "ocean","forest","plum","wine","lagoon","coffee","indigo","charcoal","emerald","sunset",
  "tutu","electricity","cream","solidarity","coaldust","dawn","meadow","lavender","paper","swan"];
let colorTheme = "amber";
function applyColorTheme(){
  document.documentElement.dataset.theme = colorTheme;
  document.querySelectorAll(".theme-btn").forEach(b=>b.classList.toggle("active", b.dataset.theme===colorTheme));
}

function buildStateSnapshot(){
  return {
    performances: performanceData.performances.map(p=>({seat:p.seat, note:p.note, ticketType:p.ticketType||"", ticketFee:!!p.ticketFee, ticketDiscount:(p.ticketDiscount!=null?p.ticketDiscount:null), ticketExtra:(p.ticketExtra||0), ticketTransferred:!!p.ticketTransferred, extraTickets:(Array.isArray(p.extraTickets)?p.extraTickets:[])})),
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
    collapsedStatSecs: [...collapsedStatSecs],
    collapsedComboIds: [...collapsedComboIds],
    hiddenFloors: [...hiddenFloors],
    showSeatNumbers: showSeatNumbers,
    hiddenStatActors: Object.fromEntries(Object.entries(hiddenStatActors).map(([k,v])=>[k,[...v]])),
    minimapVisible: minimapVisible,
    previewDefaultZoom: previewDefaultZoom,
    castStatsMode: castStatsMode,
    matchAssumeDefaultWin: matchAssumeDefaultWin,
    matchStatsOrder: [...matchStatsOrder],
    collapsedMatchStats: [...collapsedMatchStats],
    etcStatsOrder: [...etcStatsOrder],
    collapsedEtcStats: [...collapsedEtcStats],
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
    multiTicketMode: multiTicketMode,
    finaleViewOn: finaleViewOn,
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
        performanceData.performances[i].ticketTransferred = !!s.ticketTransferred;
        performanceData.performances[i].extraTickets = Array.isArray(s.extraTickets) ? s.extraTickets.map(t=>({seat:t.seat||"", ticketType:t.ticketType||"", ticketFee:!!t.ticketFee, ticketDiscount:(t.ticketDiscount!=null?t.ticketDiscount:null), ticketExtra:t.ticketExtra||0, ticketTransferred:!!t.ticketTransferred})) : [];
        // 불변식 보정: 맨 위 좌석이 비었는데 추가 티켓이 있으면 첫 추가 티켓을 맨 위로 승격
        const pp = performanceData.performances[i];
        if(!(pp.seat && pp.seat.trim()) && pp.extraTickets.length) setTickets(pp, pp.extraTickets);
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
    const validRoles = castRoleObjs().map(c=>c.role);
    roleStatsOrder = state.roleStatsOrder.filter(r=>validRoles.includes(r));
  }

  if(Array.isArray(state.comboBlocks)) comboBlocks = state.comboBlocks;
  if(typeof state.comboBlockSeq === "number") comboBlockSeq = state.comboBlockSeq;
  if(typeof state.comboCreateOpen === "boolean") comboCreateOpen = state.comboCreateOpen;
  collapsedComboIds = new Set(state.collapsedComboIds || []);
  collapsedStatSecs = new Set(state.collapsedStatSecs || []);

  hiddenFloors = new Set(state.hiddenFloors || []);
  if(typeof state.showSeatNumbers === "boolean") showSeatNumbers = state.showSeatNumbers;
  if(state.hiddenStatActors){
    hiddenStatActors = {};
    Object.entries(state.hiddenStatActors).forEach(([k,v])=>{ hiddenStatActors[k]=new Set(v); });
  }
  if(typeof state.minimapVisible === "boolean") minimapVisible = state.minimapVisible;
  if(typeof state.previewDefaultZoom === "number") previewDefaultZoom = Math.max(1, Math.min(5, Math.round(state.previewDefaultZoom)));
  if(typeof state.castStatsMode === "string") castStatsMode = state.castStatsMode;
  if(typeof state.matchAssumeDefaultWin === "boolean") matchAssumeDefaultWin = state.matchAssumeDefaultWin;
  if(Array.isArray(state.matchStatsOrder)) matchStatsOrder = state.matchStatsOrder.slice();
  collapsedMatchStats = new Set(state.collapsedMatchStats || []);
  if(Array.isArray(state.etcStatsOrder)) etcStatsOrder = state.etcStatsOrder.slice();
  collapsedEtcStats = new Set(state.collapsedEtcStats || []);
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
  if(typeof state.multiTicketMode === "boolean") multiTicketMode = state.multiTicketMode;
  if(typeof state.finaleViewOn === "boolean") finaleViewOn = state.finaleViewOn;
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

// 내보내기 파일명용 KST 타임스탬프 (YYMMDD_hh:mm)
function kstStamp(){
  const f = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Seoul", year:"2-digit", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false});
  const o = {}; f.formatToParts(new Date()).forEach(p=>{ o[p.type]=p.value; });
  return `${o.year}${o.month}${o.day}_${o.hour}${o.minute}`;
}

function downloadJSON(obj, filename){
  const data = JSON.stringify(obj, null, 2);
  const blob = new Blob([data], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// 다중 티켓(2번째 이후) 내보내기: sid 기준. 맨 위 티켓은 seats(buildSeatExportJSON)에 이미 들어감.
function buildExtraTicketsExport(){
  const result = {};
  performanceData.performances.forEach(p=>{
    const ex = Array.isArray(p.extraTickets) ? p.extraTickets.filter(t=>t && t.seat && String(t.seat).trim()) : [];
    if(ex.length) result[p.sid] = ex.map(t=>({
      seat:String(t.seat).trim(), ticketType:t.ticketType||"", ticketFee:!!t.ticketFee,
      ticketDiscount:(t.ticketDiscount!=null?t.ticketDiscount:null), ticketExtra:t.ticketExtra||0, ticketTransferred:!!t.ticketTransferred
    }));
  });
  return result;
}
// 가져오기: sid별 추가 티켓 복원(applySeatJSONData가 맨 위 티켓을 채운 뒤 호출)
function applyExtraTicketsData(map){
  if(!map || typeof map !== "object" || Array.isArray(map)) return;
  const sidMap = {};
  performanceData.performances.forEach(p=>{ sidMap[p.sid] = p; });
  Object.entries(map).forEach(([sid, arr])=>{
    const perf = sidMap[sid];
    if(!perf || !Array.isArray(arr)) return;
    perf.extraTickets = arr.filter(t=>t && t.seat && String(t.seat).trim()).map(t=>({
      seat:String(t.seat).trim(), ticketType:t.ticketType||"", ticketFee:!!t.ticketFee,
      ticketDiscount:(t.ticketDiscount!=null?t.ticketDiscount:null), ticketExtra:t.ticketExtra||0, ticketTransferred:!!t.ticketTransferred
    }));
  });
}

// 데이터 내보내기 payload(파일·Dropbox 백업 공용). 전체 공연 목록은 서버에서 받으므로 제외.
function buildExportPayload(){
  const snap = buildStateSnapshot();
  delete snap.performances;
  return { id: APP_ID, ...snap, seats: buildSeatExportJSON(), extraTickets: buildExtraTicketsExport() };
}

// 가져온 state 객체 적용(파일·Dropbox 공용).
//  includeSettings=true → 화면 설정까지 덮어씀. false → 좌석/티켓/메모(스케줄 입력)만 덮어씀.
function applyImportedState(state, includeSettings){
  if(!state || typeof state !== "object") throw new Error("올바른 형식이 아닙니다.");
  if(includeSettings) applyState(state); // 화면 설정 + (구버전 파일이면 performances 배열도 인덱스 기준 적용)
  if(state.seats && typeof state.seats === "object" && !Array.isArray(state.seats)){
    applySeatJSONData(state.seats);            // 맨 위 티켓(평면 필드) 복원 — extraTickets 비움
    applyExtraTicketsData(state.extraTickets); // 다중 티켓(2번째 이후) 복원
  }
  saveState();
  renderSchedule(); renderStats(); renderSeatMap(); renderComboPicker(); renderComboResults();
}

function exportStateToFile(){
  downloadJSON(buildExportPayload(), `makollim-settings-seats-${kstStamp()}.json`);
}

function importStateFromFile(file){
  const reader = new FileReader();
  reader.onload = ()=>{
    try{
      const state = JSON.parse(reader.result);
      // 다른 막올림(id)의 설정이면 확인 후 진행
      if(state && state.id && state.id !== APP_ID){
        if(!confirm(`다른 막올림의 설정 파일입니다.\n파일 id: ${state.id}\n현재 막올림: ${APP_ID}\n그래도 현재 막올림에 불러올까요?`)) return;
      }
      applyImportedState(state, true); // 파일 가져오기는 설정까지 전체 적용
      alert("설정과 좌석을 불러왔습니다.");
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
    const transferred = !!p.ticketTransferred;
    const extraCost = (typeof p.ticketExtra === "number" && p.ticketExtra > 0) ? p.ticketExtra : 0;
    const hasExtra = ticketType || ticketFee || note.trim() || p.ticketDiscount != null || transferred || extraCost;
    if(!seat && !hasExtra) return; // 아무 정보도 없으면 내보내지 않음
    if(!hasExtra){ result[p.sid] = [seat]; return; }
    const arr = [seat, ticketType, ticketFee, note];
    // 뒤쪽 선택 필드는 위치로 해석되므로, 뒤 필드가 있으면 앞 필드도 채워 자리를 맞춘다.
    if(p.ticketDiscount != null || transferred || extraCost) arr.push(p.ticketDiscount != null ? p.ticketDiscount : null); // 5번째: 임의 할인율(없으면 null)
    if(transferred || extraCost) arr.push(!!transferred); // 6번째: 양도받음(없어도 기타비용이 있으면 false로 자리 채움)
    if(extraCost) arr.push(extraCost); // 7번째: 기타 비용(원)
    result[p.sid] = arr;
  });
  return result;
}

// 구 버전(레거시) 내보내기: 좌석만. 형식 { sid: "좌석" }. 티켓·메모는 내보내지 않는다.
// (티켓·메모를 포함한 전체 저장은 '데이터 내보내기/가져오기'를 사용 → buildSeatExportJSON)
function buildSeatOnlyJSON(){
  const result = {};
  performanceData.performances.forEach(p=>{
    const seat = (p.seat || "").trim();
    if(seat) result[p.sid] = seat;
  });
  return result;
}

function exportSeatJSON(){
  downloadJSON(buildSeatOnlyJSON(), `makollim-seats-${kstStamp()}.json`);
}

// 가져올 때는 항상 기존 좌석/티켓/메모를 모두 지운 뒤 새로 채운다.
//  - 리스트 길이가 1이면 티켓/메모 없음(좌석만).
//  - 길이가 2 이상이면 [좌석, 티켓종류, 수수료여부, 메모, (선택)임의할인율, (선택)양도, (선택)기타비용] 순으로 해석.
function applySeatJSONData(data){
  if(!data || typeof data !== "object") throw new Error("올바른 형식이 아닙니다.");

  performanceData.performances.forEach(p=>{ p.seat = ""; p.ticketType = ""; p.ticketFee = false; p.note = ""; p.ticketDiscount = null; p.ticketExtra = 0; p.ticketTransferred = false; p.extraTickets = []; });

  const sidMap = {};
  performanceData.performances.forEach(p=>{ sidMap[p.sid] = p; });

  let appliedCount = 0;
  Object.entries(data).forEach(([sid, val])=>{
    const perf = sidMap[sid];
    if(!perf) return;
    const list = Array.isArray(val) ? val : (typeof val === "string" ? [val] : null);
    if(!list) return;

    // 좌석 값에 엑셀 복사로 생긴 불필요한 따옴표(앞뒤 ' 또는 ")가 남아 있으면 제거
    perf.seat = (list[0] == null ? "" : String(list[0])).trim().replace(/^["']+|["']+$/g, "").trim();
    if(list.length > 1){
      perf.ticketType = list[1] != null ? String(list[1]) : "";
      perf.ticketFee  = !!list[2];
      perf.note       = list[3] != null ? String(list[3]) : "";
      perf.ticketDiscount = (list.length > 4 && list[4] != null && list[4] !== "" && isFinite(Number(list[4]))) ? Number(list[4]) : null;
      perf.ticketTransferred = !!(list.length > 5 && list[5]);
      perf.ticketExtra = (list.length > 6 && list[6] != null && isFinite(Number(list[6])) && Number(list[6]) > 0) ? Number(list[6]) : 0;
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
function showSeatOverlay(seats, topSeat, doubleLabel, singleLabel){
  doubleLabel = doubleLabel || "맨 위 좌석";
  singleLabel = singleLabel || doubleLabel;
  const overlay = document.getElementById("seatOverlay");
  const grid = document.getElementById("seatOverlayGrid");
  const title = document.getElementById("seatOverlayTitle");

  if(typeof seats === "string") seats = [seats];          // 레거시(단일 좌석) 호환
  seats = (seats || []).map(s=>(s||"").trim()).filter(Boolean);
  if(!topSeat && seats.length) topSeat = seats[0];

  if(!seats.length){
    title.textContent = "좌석 미입력";
    grid.innerHTML = `<p style="color:var(--ink-dim); font-size:13px; padding:20px 0;">이 공연은 좌석이 입력되지 않았습니다.</p>`;
    overlay.style.display = "flex";
    return;
  }

  const seat = seatmapData.seats.find(s=>s.id===topSeat);
  title.textContent = (seat ? `${seat.floor}층 ${seat.row}열 ${seat.column}번` : `${topSeat} (좌석 정보 없음)`)
    + (seats.length>1 ? ` 외 ${seats.length-1}좌석` : "");

  const seatSvg = buildSeatSvgInner({ top:topSeat, all:seats });
  // 서로 다른 좌석이 둘 이상일 때만 '다중'(이중 테두리). 같은 좌석 중복은 단일 취급.
  const multi = new Set(seats).size > 1;
  const legend = multi
    ? `<span><i style="background:#fff; box-shadow:0 0 8px rgba(255,255,255,0.8);"></i>${doubleLabel}(이중)</span><span><i style="background:none; box-shadow:inset 0 0 0 2px rgba(255,255,255,0.5);"></i>그 외 좌석</span>`
    : `<span><i style="background:#fff; box-shadow:0 0 8px rgba(255,255,255,0.8);"></i>${singleLabel}</span>`;
  grid.innerHTML = `
    <div class="seat-overlay-controls">
      <button id="soZoomIn" title="확대">+</button>
      <button id="soZoomOut" title="축소">&minus;</button>
      <button id="soZoomReset" title="전체 보기">전체</button>
    </div>
    <svg id="seatOverlaySvg" viewBox="${vbString(seatSvg.bbox)}" style="width:100%; height:360px; display:block; background:var(--panel2); border-radius:8px; touch-action:none;">
      ${seatSvg.markup}
    </svg>
    <div class="legend" style="margin-top:10px;">${legend}</div>
  `;

  overlay.style.display = "flex";
  // 표시 후(컨테이너 크기 측정 가능) 줌/팬 설정. 좌석이 여러 개면 모두 보이게 맞춤.
  setupSeatOverlayZoom(seatSvg.bbox, seatSvg.topPos, previewDefaultZoom, seatSvg.hiPos);
}

/* 좌석 보기 팝업 줌/팬: 메인 좌석맵과 별개의 자체 viewBox 상태.
   1배=맵 전체, 설정 배율로 시작(선택 좌석 중심·맵 경계 클램프), 핀치·드래그·휠·버튼 지원. */
function setupSeatOverlayZoom(bbox, topPos, mult, hiPos){
  const svg = document.getElementById("seatOverlaySvg");
  if(!svg) return;
  const MAX_MULT = 8; // 수동 줌 상한(설정은 1~5배, 수동은 약간 여유)
  const rect = svg.getBoundingClientRect();
  const contAspect = (rect.width>0 && rect.height>0) ? rect.width/rect.height : (bbox.w/bbox.h);
  // 1배(전체): 맵을 컨테이너 비율로 감싸는 base 박스
  let baseW, baseH;
  if(contAspect > bbox.w/bbox.h){ baseH = bbox.h; baseW = bbox.h*contAspect; }
  else { baseW = bbox.w; baseH = bbox.w/contAspect; }
  let vb = null;
  function clamp(v){
    const minW = baseW/MAX_MULT, maxW = baseW;
    let w = Math.max(minW, Math.min(maxW, v.w));
    let h = w * (baseH/baseW);
    let x = v.x, y = v.y;
    if(w >= bbox.w) x = bbox.x + (bbox.w-w)/2; else x = Math.max(bbox.x, Math.min(bbox.x+bbox.w-w, x));
    if(h >= bbox.h) y = bbox.y + (bbox.h-h)/2; else y = Math.max(bbox.y, Math.min(bbox.y+bbox.h-h, y));
    return {x,y,w,h};
  }
  function apply(){ svg.setAttribute("viewBox", vbString(vb)); }
  function zoomTo(w, cx, cy){
    // (cx,cy)를 중심으로 폭 w가 되도록
    const h = w*(baseH/baseW);
    vb = clamp({ x: cx - w/2, y: cy - h/2, w, h }); apply();
  }
  const aspect = baseW/baseH;
  if(hiPos && hiPos.length>1){
    // 좌석이 여러 개면 모두 보이도록 그 묶음(바운딩박스)에 여유를 두고 맞춤
    let minX=Math.min(...hiPos.map(p=>p.x)), maxX=Math.max(...hiPos.map(p=>p.x));
    let minY=Math.min(...hiPos.map(p=>p.y)), maxY=Math.max(...hiPos.map(p=>p.y));
    const pad=3; minX-=pad; maxX+=pad; minY-=pad; maxY+=pad;
    let w=maxX-minX, h=maxY-minY;
    if(w/h < aspect) w = h*aspect; else h = w/aspect; // 컨테이너 비율로 확장
    const cx=(minX+maxX)/2, cy=(minY+maxY)/2;
    vb = clamp({ x: cx-w/2, y: cy-h/2, w, h }); apply();
  } else {
    // 단일 좌석: 설정 배율로 선택 좌석 중심
    const m = Math.max(1, Math.min(5, mult||1));
    const w0 = baseW/m;
    const cx0 = topPos ? topPos.x : bbox.x+bbox.w/2;
    const cy0 = topPos ? topPos.y : bbox.y+bbox.h/2;
    vb = clamp({ x: cx0-w0/2, y: cy0-(w0/aspect)/2, w:w0, h:w0/aspect }); apply();
  }

  // 버튼
  const ctrCx = ()=>vb.x+vb.w/2, ctrCy = ()=>vb.y+vb.h/2;
  const zi = document.getElementById("soZoomIn");
  const zo = document.getElementById("soZoomOut");
  const zr = document.getElementById("soZoomReset");
  if(zi) zi.onclick = ()=> zoomTo(vb.w*0.8, ctrCx(), ctrCy());
  if(zo) zo.onclick = ()=> zoomTo(vb.w*1.25, ctrCx(), ctrCy());
  if(zr) zr.onclick = ()=> { vb = clamp({ x:bbox.x+(bbox.w-baseW)/2, y:bbox.y+(bbox.h-baseH)/2, w:baseW, h:baseH }); apply(); };

  // 드래그(팬) · 핀치 · 휠
  let dragging=false, sx=0, sy=0, startVb=null;
  const pts = new Map();
  let pinchDist=null, pinchVb=null;
  svg.addEventListener("pointerdown", e=>{
    pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
    if(pts.size===2){
      dragging=false;
      pts.forEach((_,id)=>{ try{ svg.setPointerCapture(id); }catch(_){}});
      const a=[...pts.values()]; pinchDist=Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y); pinchVb={...vb};
    } else if(pts.size===1){
      dragging=true; sx=e.clientX; sy=e.clientY; startVb={...vb};
      try{ svg.setPointerCapture(e.pointerId); }catch(_){}
    }
  });
  svg.addEventListener("pointermove", e=>{
    if(!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, {x:e.clientX, y:e.clientY});
    const r = svg.getBoundingClientRect();
    if(pts.size===2 && pinchDist){
      const a=[...pts.values()]; const dist=Math.hypot(a[0].x-a[1].x, a[0].y-a[1].y);
      if(!dist) return;                          // 두 점이 겹치면 0 나눗셈 방지
      const midX=(a[0].x+a[1].x)/2, midY=(a[0].y+a[1].y)/2;
      const f = pinchDist/dist; // 벌리면 확대(f<1)
      const cx = pinchVb.x + ((midX-r.left)/r.width)*pinchVb.w;
      const cy = pinchVb.y + ((midY-r.top)/r.height)*pinchVb.h;
      vb = clamp({ x: cx-(cx-pinchVb.x)*f, y: cy-(cy-pinchVb.y)*f, w: pinchVb.w*f, h: pinchVb.h*f }); apply();
      return;
    }
    if(!dragging) return;
    const dx=(e.clientX-sx)*(startVb.w/r.width), dy=(e.clientY-sy)*(startVb.h/r.height);
    vb = clamp({ x: startVb.x-dx, y: startVb.y-dy, w: startVb.w, h: startVb.h }); apply();
  });
  function end(e){ pts.delete(e.pointerId); if(pts.size<2){ pinchDist=null; } if(pts.size===1){ const [p]=[...pts.values()]; dragging=true; sx=p.x; sy=p.y; startVb={...vb}; } if(pts.size===0) dragging=false; try{ svg.releasePointerCapture(e.pointerId); }catch(_){} }
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("wheel", e=>{
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const cx = vb.x + ((e.clientX-r.left)/r.width)*vb.w;
    const cy = vb.y + ((e.clientY-r.top)/r.height)*vb.h;
    zoomTo(vb.w*(e.deltaY>0?1.12:0.89), cx, cy);
  }, { passive:false });
}

/* === 다중 티켓 관리 모달 === */
let tmWired = false;
let lpTimer=null, lpActive=false, lpFromTi=-1, lpToTi=-1, lpStartY=0, lpStartX=0, lpSuppressClick=false, lpDocWired=false, lpPending=false, lpRow=null, lpDownInput=null, lpPid=null;
function tmCommit(){
  if(tmIdx<0) return;
  setTickets(performanceData.performances[tmIdx], tmTickets);
  saveState();
  renderSchedule();
  renderStats();    // 맨 위 티켓이 통계/좌석맵에 반영되므로 함께 갱신(좌석 변경·순서변경·삭제 시)
  renderSeatMap(true); // 좌석맵 줌/위치 유지
}
function openTicketManager(idx){
  tmIdx = idx; tmEditTi = -1;
  const p = performanceData.performances[idx];
  tmTickets = allTickets(p).map(t=>({...t}));
  if(tmTickets.length===0) tmTickets = [blankTicket()];
  const ov = document.getElementById("ticketManagerOverlay");
  ov.style.display = "flex";
  if(!tmWired){
    tmWired = true;
    document.getElementById("tmClose").addEventListener("click", closeTicketManager);
    ov.addEventListener("click", e=>{ if(e.target===ov) closeTicketManager(); });
  }
  renderTicketManager();
}
function blankTicket(){ return {seat:"",ticketType:"",ticketFee:false,ticketDiscount:null,ticketExtra:0,ticketTransferred:false}; }
function closeTicketManager(){
  tmCommit(); // 빈 좌석 티켓은 setTickets에서 정리됨
  document.getElementById("ticketManagerOverlay").style.display = "none";
  tmIdx = -1; tmTickets = []; tmEditTi = -1;
}
function renderTicketManager(){
  if(tmIdx<0) return;
  const p = performanceData.performances[tmIdx];
  document.getElementById("tmTitle").textContent = perfDateLabel(p) + " · 티켓 관리";
  const bodyEl = document.getElementById("tmBody");
  const rowsHTML = tmTickets.map((t,ti)=>{
    const seat = (t.seat||"").trim();
    const invalid = seat!=="" && !isValidSeat(seat);
    const gname = gradeOf(seat);
    const grade = gname ? performanceData.grades.find(g=>g.name===gname) : null;
    let trig;
    if(!grade){ trig = `<span class="tk-none">—</span>`; }
    else {
      const chip = `<span class="tk-grade" style="background:${gradeFillVar(gname)};">${gname[0]}</span>`;
      const sel = resolveTicketEntry(grade, t.ticketType);
      const discVal = (t.ticketDiscount!=null) ? t.ticketDiscount : (sel ? (sel.discount||0) : null);
      const dot = t.ticketTransferred ? `<span class="tk-transfer-dot"></span>` : "";
      if(t.ticketType && discVal!=null){
        trig = `<button class="tm-ticket-trigger ticket-trigger selected" data-ti="${ti}">${chip}<span class="tk-name">${escHtml(t.ticketType[0])}</span><span class="tk-disc">${discVal}%${dot}</span></button>`;
      } else {
        trig = `<button class="tm-ticket-trigger ticket-trigger" data-ti="${ti}">${chip}<span class="tk-icon" aria-hidden="true">&#127903;</span>${dot}</button>`;
      }
    }
    const price = ticketPriceOf(seat, t.ticketType, t.ticketFee, t.ticketDiscount, t.ticketExtra);
    return `
      <div class="tm-row${ti===0?' tm-top':''}" data-ti="${ti}">
        <span class="tm-drag" title="길게 눌러 순서 변경">&#8942;&#8942;</span>
        <span class="seat-input-wrap" style="position:relative; display:inline-flex;">
          <input class="seat-input tm-seat-input${invalid?' invalid-seat':''}" type="text" value="${escHtml(seat)}" placeholder="층-열-번" data-ti="${ti}" readonly>
        </span>
        <button class="tm-eye-btn seat-eye-btn" data-ti="${ti}" ${(seat&&!invalid)?'':'disabled'} title="좌석표에서 보기" style="background:none;border:none;padding:2px 3px;display:flex;align-items:center;line-height:0;color:${(seat&&!invalid)?'var(--gold)':'var(--ink-dim)'};">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <span class="tm-trig">${trig}</span>
        <span class="tm-price">${price!=null ? formatKRW(price) : '—'}</span>
      </div>`;
  }).join("");
  // 편집 중인 티켓 팝오버는 관리 창 위에 오버레이로 표시
  let popOverlay = "";
  if(tmEditTi>=0 && tmTickets[tmEditTi]){
    const t = tmTickets[tmEditTi]; const gname = gradeOf((t.seat||"").trim());
    const grade = gname ? performanceData.grades.find(g=>g.name===gname) : null;
    if(grade) popOverlay = `<div class="tm-pop-overlay">${buildTicketPopover(tmIdx, grade, t)}</div>`;
  }
  bodyEl.innerHTML = rowsHTML + `<div class="tm-addrow"><button id="tmAddBtn" class="tm-add-btn">+ 티켓 추가</button></div>` + popOverlay;
  wireTicketManager(bodyEl);
}
function wireTicketManager(bodyEl){
  // 좌석 입력
  bodyEl.querySelectorAll(".tm-seat-input").forEach(inp=>{
    inp.addEventListener("input", ()=>{ inp.classList.toggle("invalid-seat", inp.value.trim()!=="" && !isValidSeat(inp.value)); });
    inp.addEventListener("change", ()=>{
      const ti = +inp.dataset.ti; const val = inp.value.trim();
      if(val === ""){
        // 좌석을 비우면 그 티켓 삭제(맨 위면 다음 티켓이 맨 위로 승격)
        tmTickets.splice(ti,1);
        if(tmTickets.length===0){ closeTicketManager(); return; }
        tmEditTi=-1; tmCommit(); renderTicketManager(); return;
      }
      if(tmTickets.some((x,j)=> j!==ti && (x.seat||"").trim()===val)){
        alert("이미 같은 좌석의 티켓이 있습니다."); inp.value = tmTickets[ti].seat||""; return;
      }
      tmTickets[ti].seat = val; tmCommit(); renderTicketManager();
    });
    inp.addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); inp.blur(); } });
    // 떠나면 다시 readonly로(다음에 누를 때 커서/키보드가 안 뜨도록)
    inp.addEventListener("blur", ()=>{ inp.setAttribute("readonly",""); });
  });
  // 눈: 모든 좌석 표시, 내가 누른 행의 좌석=이중 테두리(나머지 단일)
  bodyEl.querySelectorAll(".tm-eye-btn").forEach(btn=>{
    btn.addEventListener("click", e=>{ e.preventDefault(); if(lpSuppressClick){return;} if(btn.disabled) return;
      const ti=+btn.dataset.ti;
      const seats=tmTickets.map(t=>(t.seat||"").trim()).filter(Boolean);
      const sel=(tmTickets[ti].seat||"").trim();
      if(seats.length) showSeatOverlay(seats, sel||seats[0], "선택 좌석"); });
  });
  // 티켓 트리거 → 팝오버 열기
  bodyEl.querySelectorAll(".tm-ticket-trigger").forEach(btn=>{
    btn.addEventListener("click", e=>{ e.stopPropagation();
      const ti=+btn.dataset.ti; tmEditTi = (tmEditTi===ti? -1 : ti); renderTicketManager(); });
  });
  // 팝오버(오버레이로 관리 창 위에 표시)
  const popOv = bodyEl.querySelector(".tm-pop-overlay");
  if(popOv) popOv.addEventListener("click", e=>{ if(e.target===popOv){ tmEditTi=-1; renderTicketManager(); } });
  const pop = bodyEl.querySelector(".ticket-popover");
  if(pop){
    pop.addEventListener("click", e=>e.stopPropagation());
    pop.querySelectorAll(".tk-custom-name, .tk-custom-rate").forEach(inp=>{
      inp.addEventListener("focus", ()=>{ const r=pop.querySelector(`input[name="tkopt-${tmIdx}"][value="__custom__"]`); if(r) r.checked=true; });
    });
    const sv=pop.querySelector(".tk-save"); if(sv) sv.addEventListener("click", e=>{ e.stopPropagation();
      const f = parseTicketPopover(pop, tmIdx);
      Object.assign(tmTickets[tmEditTi], f);
      tmEditTi=-1; tmCommit(); renderTicketManager(); });
    const cc=pop.querySelector(".tk-cancel"); if(cc) cc.addEventListener("click", e=>{ e.stopPropagation(); tmEditTi=-1; renderTicketManager(); });
    const cl=pop.querySelector(".tk-clear"); if(cl) cl.addEventListener("click", e=>{ e.stopPropagation();
      tmTickets.splice(tmEditTi,1); tmEditTi=-1;
      if(tmTickets.length===0){ closeTicketManager(); return; }
      tmCommit(); renderTicketManager(); });
  }
  // 추가
  const add = bodyEl.querySelector("#tmAddBtn");
  if(add) add.addEventListener("click", ()=>{ tmTickets.push(blankTicket()); tmEditTi=-1; renderTicketManager();
    const inputs = bodyEl.querySelectorAll(".tm-seat-input"); const last=inputs[inputs.length-1]; if(last){ last.removeAttribute("readonly"); last.focus(); } });
  // 순서 변경: 조금이라도 끌거나(>8px) 길게 누르면(0.3s) 이동 모드. 짧게 누르면 그대로 클릭/입력.
  //  주의: 포인터 캡처는 '드래그 시작 시(lpActivateDrag)'에만 건다. pointerdown에서 캡처하면
  //        그 클릭의 click 이벤트가 자식(티켓·눈·입력) 대신 캡처한 행으로 재타게팅되어
  //        데스크탑에서 티켓 팝오버가 안 열리고 입력 포커스가 어긋남. 선택 차단은 readonly+user-select가 담당.
  bodyEl.querySelectorAll(".tm-row").forEach(row=>{
    row.addEventListener("pointerdown", e=>{
      if(e.button!=null && e.button!==0) return;
      if(tmEditTi>=0) return; // 팝오버 열려있으면 무시
      if(lpPending || lpActive) return; // 이미 다른 포인터로 진행 중 → 두 번째 손가락 무시(멀티터치 상태 꼬임 방지)
      lpFromTi = +row.dataset.ti; lpStartY = e.clientY; lpStartX = e.clientX; lpToTi=-1;
      lpActive = false; lpPending = true; lpRow = row; lpPid = e.pointerId;
      clearTimeout(lpTimer);
      // 입력칸은 기본 포커스를 막아둔다(롱프레스=이동 전용). 짧은 탭으로 끝나면 lpEnd에서 포커스 부여.
      lpDownInput = e.target.closest(".tm-seat-input") || null;
      if(lpDownInput) e.preventDefault();
      // 가만히 길게 눌러도 이동 모드 진입(움직임 없이)
      lpTimer = setTimeout(()=>{ lpActivateDrag(); }, 300);
    });
  });
  if(!lpDocWired){
    lpDocWired = true;
    document.addEventListener("pointermove", lpMove, {passive:false});
    document.addEventListener("pointerup", lpEnd);
    document.addEventListener("pointercancel", lpEnd);
    // 누르는 동안(롱프레스 대기·드래그 중) 행에서 텍스트 선택이 시작되지 않도록 차단
    document.addEventListener("selectstart", e=>{ if((lpPending || lpActive) && e.target && e.target.closest && e.target.closest("#tmBody")) e.preventDefault(); });
    // 드래그 직후의 클릭(좌석 보기·티켓 선택 등) 1회 무시 (#tmBody는 영속 → 1회만 등록)
    bodyEl.addEventListener("click", e=>{ if(lpSuppressClick){ e.stopPropagation(); e.preventDefault(); lpSuppressClick=false; } }, true);
  }
}
// 포인터 위치 → 삽입 인덱스(0..n). 각 행 중간선을 기준으로, 마지막 행 아래는 끝(n).
function tmDropIndex(clientY){
  const rows=[...document.querySelectorAll("#tmBody .tm-row")];
  for(let i=0;i<rows.length;i++){
    const b=rows[i].getBoundingClientRect();
    if(clientY < b.top + b.height/2) return i; // 이 행 위쪽에 삽입
  }
  return rows.length; // 모든 행 아래 → 맨 끝
}
// 삽입 인덱스(0..n)에 노란 인디케이터 줄 표시(현재 위치라도 항상 표시)
function lpDrawIndicator(ins){
  const rows=[...document.querySelectorAll("#tmBody .tm-row")];
  rows.forEach(r=>r.classList.remove("tm-drop","tm-drop-end"));
  if(!rows.length) return;
  if(ins>=rows.length) rows[rows.length-1].classList.add("tm-drop-end");
  else if(ins>=0 && rows[ins]) rows[ins].classList.add("tm-drop");
}
// 이동 모드 진입(롱프레스 타이머 또는 8px 이동 시): 시각 표시 + 입력 포커스/선택 해제
function lpActivateDrag(){
  if(lpFromTi<0 || lpActive) return;
  lpActive = true;
  clearTimeout(lpTimer);
  const row = lpRow || document.querySelector(`#tmBody .tm-row[data-ti="${lpFromTi}"]`);
  if(row) row.classList.add("tm-dragging");
  // 드래그가 시작된 지금에서야 포인터 캡처(이동 이벤트 보장 + 드래그 중 네이티브 선택 차단)
  try{ if(row && lpPid!=null) row.setPointerCapture(lpPid); }catch(_){}
  try{ if(document.activeElement && row && row.contains(document.activeElement)) document.activeElement.blur(); }catch(_){}
  try{ const sel=window.getSelection&&window.getSelection(); if(sel) sel.removeAllRanges(); }catch(_){}
  // 진입 즉시 현재 위치에 인디케이터 표시(이동 모드임을 바로 알 수 있게)
  lpToTi = lpFromTi;
  lpDrawIndicator(lpFromTi);
}
function lpMove(e){
  if(lpFromTi<0) return;
  if(lpPid!=null && e.pointerId!==lpPid) return; // 진행 중인 포인터의 이동만 처리(멀티터치)
  if(!lpActive){
    // 8px 이상 움직이면 즉시 이동 모드 진입(요소 종류와 무관)
    if(Math.abs(e.clientY-lpStartY)>8 || Math.abs(e.clientX-lpStartX)>8) lpActivateDrag();
    if(!lpActive) return;
  }
  e.preventDefault();
  const fromRow=document.querySelector(`#tmBody .tm-row[data-ti="${lpFromTi}"]`);
  if(fromRow && !fromRow.classList.contains("tm-dragging")) fromRow.classList.add("tm-dragging");
  const ins = tmDropIndex(e.clientY);          // 삽입 인덱스(0..n)
  lpToTi = ins;                                // 현재 위치라도 항상 인디케이터 표시
  lpDrawIndicator(ins);
}
function lpEnd(e){
  if(lpPid!=null && e && e.pointerId!==lpPid) return; // 진행 중인 포인터의 떼기/취소만 처리(멀티터치)
  lpPending = false;
  const row = lpRow; lpRow = null;
  try{ if(row && lpPid!=null && row.hasPointerCapture && row.hasPointerCapture(lpPid)) row.releasePointerCapture(lpPid); }catch(_){}
  lpPid = null;
  const downInput = lpDownInput; lpDownInput = null;
  if(lpFromTi<0){ clearTimeout(lpTimer); return; }
  clearTimeout(lpTimer);
  const wasActive = lpActive;
  const from=lpFromTi, ins=lpToTi;
  lpActive=false; lpFromTi=-1; lpToTi=-1;
  if(wasActive){
    lpSuppressClick = true;                          // 이동 모드였으면(제자리라도) 직후 클릭 무시
    let target = ins; if(ins>=0 && from < ins) target--; // 삽입 인덱스 → 제거 후 위치
    if(ins>=0 && target!==from){
      const moved = tmTickets.splice(from,1)[0]; tmTickets.splice(target,0,moved);
      tmEditTi=-1; tmCommit();
      renderTicketManager();
    } else {
      // 이동 없이 끝남: 시각 표시만 정리, 재렌더 없음
      document.querySelectorAll("#tmBody .tm-row").forEach(r=>r.classList.remove("tm-dragging","tm-drop","tm-drop-end"));
    }
    setTimeout(()=>{ lpSuppressClick=false; }, 0);
  } else if(downInput){
    // 짧은 탭이면 입력 모드로: readonly 해제 후 포커스(이때만 커서/키보드). 캐럿은 끝으로.
    try{ downInput.removeAttribute("readonly"); downInput.focus(); const n=downInput.value.length; downInput.setSelectionRange&&downInput.setSelectionRange(n,n); }catch(_){}
  }
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
    p.ticketTransferred = false; p.extraTickets = []; // 다중 티켓·양도 정보도 함께 삭제(안 지우면 재로드 시 추가 티켓이 맨 위로 승격됨)
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
  const mt = document.getElementById("optMultiTicket");
  if(!fd) return;

  // 저장된 상태를 체크박스에 반영
  fd.checked = floatDateOn;
  rh.checked = rowHighlightOn;
  hs.checked = rowHighlightSave;
  lv.checked = lockVScrollOn;
  if(mt) mt.checked = multiTicketMode;
  const pz = document.getElementById("optPreviewZoom");
  if(pz){
    pz.value = String(previewDefaultZoom);
    pz.addEventListener("change", ()=>{ previewDefaultZoom = Math.max(1, Math.min(5, parseInt(pz.value,10)||1)); saveState(); });
  }

  fd.addEventListener("change", ()=>{ floatDateOn = fd.checked; saveState(); renderSchedule(); });
  rh.addEventListener("change", ()=>{ rowHighlightOn = rh.checked; saveState(); renderSchedule(); });
  hs.addEventListener("change", ()=>{
    rowHighlightSave = hs.checked;
    saveState(); // 켜면 현재 하이라이트가 저장되고, 끄면 저장 목록이 비워짐
  });
  lv.addEventListener("change", ()=>{ lockVScrollOn = lv.checked; saveState(); });
  if(mt) mt.addEventListener("change", ()=>{
    if(!mt.checked){
      // 끄기: 여러 장 티켓이 있는 공연이 있으면 경고(데이터는 유지, UI만 바뀜)
      const multi = performanceData.performances.some(p=>ticketCount(p)>=2);
      if(multi && !confirm("여러 장의 티켓이 입력된 공연이 있습니다.\n끄면 스케줄에는 맨 위 티켓만 표시되고(데이터는 유지), 좌석칸 모서리에 티켓 수가 숫자로 표시됩니다.\n끄시겠어요?")){
        mt.checked = true; return;
      }
    }
    multiTicketMode = mt.checked; saveState(); renderSchedule();
  });
  const fv = document.getElementById("optFinaleView");
  if(fv){
    fv.checked = finaleViewOn;
    fv.addEventListener("change", ()=>{ finaleViewOn = fv.checked; saveState(); applyFinaleVisibility(); });
  }
  // '하이라이트 해제' 버튼은 스케줄 툴바에 있으며 renderSchedule()에서 연결됨
}

// Finale 탭 표시/숨김. 숨길 때 그 탭이 활성이면 스케줄로 되돌린다.
function applyFinaleVisibility(){
  const tab = document.querySelector('.tab-btn[data-page="finale"]');
  if(!tab) return;
  tab.style.display = finaleViewOn ? "" : "none";
  if(!finaleViewOn && tab.classList.contains("active")){
    const home = document.querySelector('.tab-btn[data-page="schedule"]');
    if(home) home.click();
  }
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

  // 데스크탑: 마우스로 표를 잡아끌어 스크롤(가로·세로). 입력/버튼/링크 위에서는 드래그 안 함.
  const INTERACTIVE = "input, textarea, select, button, a, [contenteditable], .role-dropdown, .ticket-popover";
  let mDown=false, mMoved=false, mx=0, my=0, ml=0, mt=0, mAxis=null, suppressClick=false;
  wrap.addEventListener("pointerdown", e=>{
    if(e.pointerType!=="mouse" || e.button!==0) return;
    if(e.target.closest(INTERACTIVE)) return;       // 클릭 가능한 요소는 그대로 동작
    mDown=true; mMoved=false; mAxis=null; mx=e.clientX; my=e.clientY; ml=wrap.scrollLeft; mt=wrap.scrollTop;
  });
  wrap.addEventListener("pointermove", e=>{
    if(!mDown) return;
    const dx=e.clientX-mx, dy=e.clientY-my;
    if(!mMoved){
      if(Math.abs(dx)<4 && Math.abs(dy)<4) return;   // 작은 움직임은 클릭으로 둠
      mMoved=true; wrap.classList.add("drag-scrolling");
      // '세로 스크롤 잠금' 옵션이 켜져 있으면 시작 방향으로 한 축만 이동
      mAxis = lockVScrollOn ? (Math.abs(dx) >= Math.abs(dy) ? "h" : "v") : null;
      try{ wrap.setPointerCapture(e.pointerId); }catch(_){}
    }
    e.preventDefault();
    if(mAxis !== "v") wrap.scrollLeft = ml - dx;   // 세로 잠금(h)일 때 가로만
    if(mAxis !== "h") wrap.scrollTop  = mt - dy;   // 가로 잠금(v)일 때 세로만
  });
  const endDrag = e=>{
    if(!mDown) return;
    mDown=false;
    if(mMoved){
      suppressClick=true;                            // 드래그 직후의 클릭(하이라이트 등) 무시
      wrap.classList.remove("drag-scrolling");
      try{ wrap.releasePointerCapture(e.pointerId); }catch(_){}
    }
  };
  wrap.addEventListener("pointerup", endDrag);
  wrap.addEventListener("pointercancel", endDrag);
  wrap.addEventListener("click", e=>{
    if(suppressClick){ e.stopPropagation(); e.preventDefault(); suppressClick=false; }
  }, true);
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

  roleStatsOrder = castRoleObjs().map(c=>c.role);

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
  applyFinaleVisibility();  // Finale 탭 표시/숨김(기본 OFF)
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
  applyStatSecsCollapse(); // 통계 상위 섹션 접힘 적용

  // 공연 시작+3시간(종료 시점)이 페이지를 띄워둔 채로 지나가면 통계/좌석맵을 자동 갱신한다.
  lastEndedCount = performanceData.performances.filter(isEnded).length;
  setInterval(()=>{
    const nowEndedCount = performanceData.performances.filter(isEnded).length;
    if(nowEndedCount !== lastEndedCount){
      lastEndedCount = nowEndedCount;
      renderStats();
      renderSeatMap(true); // 종료 카운트 변화 시 갱신하되 줌/위치 유지
    }
  }, 30000); // 30초마다 확인
}

init();