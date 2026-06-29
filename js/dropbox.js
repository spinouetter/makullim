/* 막올림 Dropbox 백업/복원 (단계 1: 핵심 백업·복원)
   - 정적 사이트용 브라우저 OAuth2 PKCE(앱 시크릿 불필요, App key만 사용).
   - 백업 내용 = 데이터 내보내기와 동일(buildExportPayload). 파일명 <id>-YYMMDD-HHMM.json.
   - App key가 없으면 기능 비활성화.
   ※ 이 파일의 Dropbox 호출은 실제 토큰·배포 환경에서만 동작(로컬 헤드리스로는 UI/게이팅만 검증). */
(function(){
  "use strict";
  const LS = {
    access: "makollim:dbx:access",
    refresh: "makollim:dbx:refresh",
    expires: "makollim:dbx:expires",
    verifier: "makollim:dbx:verifier",
    oauthState: "makollim:dbx:state",
  };
  const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
  const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";

  function appKey(){
    const c = (window.MAKOLLIM_CONFIG && window.MAKOLLIM_CONFIG.dropboxAppKey) || "";
    const fromConfig = (c && c !== "__DROPBOX_APP_KEY__") ? c : "";
    return (fromConfig || localStorage.getItem("makollim:dropboxAppKey") || "").trim();
  }
  function redirectUri(){ return location.origin + location.pathname; }
  function enabled(){ return !!appKey(); }
  function connected(){ return !!localStorage.getItem(LS.access); }

  /* ── PKCE ── */
  function b64url(bytes){
    let s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
    return s.replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
  }
  function randomString(n){
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return b64url(a).slice(0, n);
  }
  async function sha256b64url(str){
    const data = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return b64url(hash);
  }

  async function connect(){
    const key = appKey(); if(!key) return;
    const verifier = randomString(64);
    const challenge = await sha256b64url(verifier);
    const state = randomString(24);
    localStorage.setItem(LS.verifier, verifier);
    localStorage.setItem(LS.oauthState, state);
    const p = new URLSearchParams({
      client_id: key,
      response_type: "code",
      redirect_uri: redirectUri(),
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",   // refresh token 발급
      state: state,
    });
    location.assign(`${AUTH_URL}?${p.toString()}`);
  }

  function disconnect(){
    [LS.access, LS.refresh, LS.expires].forEach(k=>localStorage.removeItem(k));
    render();
  }

  async function exchangeCode(code){
    const verifier = localStorage.getItem(LS.verifier) || "";
    const body = new URLSearchParams({
      code, grant_type: "authorization_code",
      redirect_uri: redirectUri(), code_verifier: verifier, client_id: appKey(),
    });
    const res = await fetch(TOKEN_URL, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
    if(!res.ok) throw new Error("토큰 교환 실패 ("+res.status+")");
    const j = await res.json();
    saveToken(j);
    localStorage.removeItem(LS.verifier);
  }
  function saveToken(j){
    if(j.access_token) localStorage.setItem(LS.access, j.access_token);
    if(j.refresh_token) localStorage.setItem(LS.refresh, j.refresh_token);
    if(j.expires_in) localStorage.setItem(LS.expires, String(Date.now() + (j.expires_in-60)*1000));
  }
  async function refreshIfNeeded(){
    const exp = +(localStorage.getItem(LS.expires) || 0);
    const refresh = localStorage.getItem(LS.refresh);
    if(!refresh) return;                      // refresh 없으면 만료 시 재로그인
    if(exp && Date.now() < exp) return;       // 아직 유효
    const body = new URLSearchParams({ grant_type:"refresh_token", refresh_token:refresh, client_id:appKey() });
    const res = await fetch(TOKEN_URL, { method:"POST", headers:{"Content-Type":"application/x-www-form-urlencoded"}, body });
    if(!res.ok){ disconnect(); throw new Error("토큰 갱신 실패 — 다시 연결해주세요."); }
    saveToken(await res.json());
  }
  async function authHeader(){
    await refreshIfNeeded();
    return "Bearer " + (localStorage.getItem(LS.access) || "");
  }

  /* ── 리다이렉트 복귀 처리(페이지 로드 시) ── */
  async function handleRedirect(){
    const q = new URLSearchParams(location.search);
    const code = q.get("code"), state = q.get("state");
    if(!code) return false;
    try{
      if(state && state !== localStorage.getItem(LS.oauthState)) throw new Error("state 불일치");
      await exchangeCode(code);
    }catch(err){ console.error(err); alert("Dropbox 연결에 실패했습니다: " + err.message); }
    localStorage.removeItem(LS.oauthState);
    // URL에서 code/state 제거
    const clean = location.origin + location.pathname + location.hash;
    history.replaceState(null, "", clean);
    return true;
  }

  /* ── Dropbox API ── */
  async function dbxUpload(name, text){
    const arg = JSON.stringify({ path: "/" + name, mode: "overwrite", autorename: false, mute: true });
    const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
      method:"POST",
      headers:{ "Authorization": await authHeader(), "Content-Type":"application/octet-stream", "Dropbox-API-Arg": arg },
      body: text,
    });
    if(!res.ok) throw new Error("업로드 실패 ("+res.status+") " + (await res.text()).slice(0,200));
    return res.json();
  }
  async function dbxList(){
    const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method:"POST",
      headers:{ "Authorization": await authHeader(), "Content-Type":"application/json" },
      body: JSON.stringify({ path: "" }),   // App folder 루트
    });
    if(!res.ok) throw new Error("목록 실패 ("+res.status+") " + (await res.text()).slice(0,200));
    const j = await res.json();
    const id = (typeof APP_ID !== "undefined") ? APP_ID : "";
    return (j.entries||[])
      .filter(e=>e[".tag"]==="file" && e.name.endsWith(".json") && (!id || e.name.startsWith(id+"-")))
      .sort((a,b)=> (b.server_modified||"").localeCompare(a.server_modified||""));
  }
  async function dbxDownload(path){
    const res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method:"POST",
      headers:{ "Authorization": await authHeader(), "Dropbox-API-Arg": JSON.stringify({ path }) },
    });
    if(!res.ok) throw new Error("다운로드 실패 ("+res.status+")");
    return res.text();
  }

  /* ── 유틸 ── */
  function stampDash(){
    const f = new Intl.DateTimeFormat("en-CA", {timeZone:"Asia/Seoul", year:"2-digit", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false});
    const o = {}; f.formatToParts(new Date()).forEach(p=>{ o[p.type]=p.value; });
    return `${o.year}${o.month}${o.day}-${o.hour}${o.minute}${o.second}`;
  }
  function relativeTime(iso){
    const t = new Date(iso).getTime(); if(isNaN(t)) return "";
    const diff = Math.max(0, Date.now() - t);
    const min = Math.floor(diff/60000);
    if(min < 60) return min<=0 ? "방금" : `${min}분 전`;
    const hr = Math.floor(min/60);
    if(hr < 24) return `${hr}시간 전`;
    const day = Math.floor(hr/24);
    if(day < 30) return `${day}일 전`;
    const mon = Math.floor(day/30);
    if(mon < 12) return `${mon}개월 전`;
    return `${Math.floor(day/365)}년 전`;
  }
  function fmtLocal(iso){
    const d = new Date(iso); if(isNaN(d.getTime())) return iso;
    const f = new Intl.DateTimeFormat("ko-KR", {timeZone:"Asia/Seoul", year:"2-digit", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", hour12:false});
    return f.format(d);
  }

  /* ── 동작 ── */
  async function doBackup(){
    if(typeof buildExportPayload !== "function"){ alert("앱이 아직 준비되지 않았습니다."); return; }
    const name = ((typeof APP_ID!=="undefined"&&APP_ID)?APP_ID:"makollim") + "-" + stampDash() + ".json";
    const text = JSON.stringify(buildExportPayload());
    setStatus("백업 중…");
    try{ await dbxUpload(name, text); setStatus("백업 완료"); await loadList(); }
    catch(err){ console.error(err); setStatus(""); alert("백업 실패: " + err.message); }
  }
  async function loadList(){
    setStatus("목록 불러오는 중…");
    try{
      const files = await dbxList();
      const sel = document.getElementById("dbxFileSelect");
      if(sel){
        sel.innerHTML = files.length
          ? files.map(e=>`<option value="${e.path_lower}">${fmtLocal(e.server_modified)} (${relativeTime(e.server_modified)})</option>`).join("")
          : `<option value="">백업 파일이 없습니다</option>`;
      }
      setStatus(`${files.length}개`);
    }catch(err){ console.error(err); setStatus(""); alert("목록 실패: " + err.message); }
  }
  async function doRestore(){
    const sel = document.getElementById("dbxFileSelect");
    const path = sel && sel.value;
    if(!path){ alert("먼저 '파일 목록 가져오기'로 백업을 선택해주세요."); return; }
    const overwriteSettings = !!(document.getElementById("dbxOverwriteSettings")||{}).checked;
    const what = overwriteSettings ? "화면 설정과 좌석/티켓/메모" : "좌석/티켓/메모(스케줄)";
    if(!confirm(`선택한 백업으로 ${what}를 덮어씁니다. 진행할까요?`)) return;
    setStatus("복원 중…");
    try{
      const text = await dbxDownload(path);
      const state = JSON.parse(text);
      if(typeof applyImportedState !== "function") throw new Error("앱이 준비되지 않았습니다.");
      applyImportedState(state, overwriteSettings);
      setStatus("복원 완료");
      alert("백업을 불러왔습니다.");
    }catch(err){ console.error(err); setStatus(""); alert("복원 실패: " + err.message); }
  }

  function setStatus(msg){ const el = document.getElementById("dbxStatus"); if(el) el.textContent = msg || ""; }

  /* ── UI ── */
  function render(){
    const box = document.getElementById("dropboxSection");
    if(!box) return;
    if(!enabled()){
      box.innerHTML = `<h2>Dropbox 백업 (개발중)</h2>
        <p style="color:var(--ink-dim); font-size:13px;">백업 기능이 꺼져 있습니다. (Dropbox App key 미설정)</p>`;
      return;
    }
    if(!connected()){
      box.innerHTML = `<h2>Dropbox 백업 (개발중)</h2>
        <p style="color:var(--ink-dim); font-size:13px; margin-bottom:10px;">Dropbox에 데이터를 백업/복원합니다. 먼저 한 번 연결해주세요.</p>
        <button id="dbxConnect">Dropbox 연결</button>`;
      const c = document.getElementById("dbxConnect"); if(c) c.onclick = ()=>connect();
      return;
    }
    box.innerHTML = `<h2>Dropbox 백업 (개발중)</h2>
      <p style="color:var(--ink-dim); font-size:13px; margin-bottom:10px;">데이터 내보내기와 동일한 내용을 Dropbox에 저장/복원합니다.</p>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">
        <button id="dbxBackup">Dropbox에 백업하기</button>
        <button id="dbxLoadList">목록 가져오기</button>
        <span id="dbxStatus" style="color:var(--ink-dim); font-size:12px;"></span>
        <button id="dbxDisconnect" style="margin-left:auto; font-size:12px;">연결 해제</button>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <select id="dbxFileSelect" style="font:inherit; max-width:100%; flex:1; min-width:220px;"><option value="">'목록 가져오기'를 눌러주세요</option></select>
        <button id="dbxRestore">가져오기</button>
      </div>
      <label class="opt-row" style="margin-top:8px;"><input type="checkbox" id="dbxOverwriteSettings"><span>설정 덮어쓰기 (체크 안하면 스케줄만 가져옴)</span></label>`;
    const on = (id,fn)=>{ const el=document.getElementById(id); if(el) el.onclick=fn; };
    on("dbxBackup", doBackup);
    on("dbxLoadList", loadList);
    on("dbxRestore", doRestore);
    on("dbxDisconnect", ()=>{ if(confirm("Dropbox 연결을 해제할까요?")) disconnect(); });
  }

  async function boot(){
    await handleRedirect();   // OAuth 복귀면 토큰 교환
    render();
  }
  if(document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  // 디버그/테스트용 노출
  window.makollimDropbox = { enabled, connected, relativeTime, stampDash, render };
})();
