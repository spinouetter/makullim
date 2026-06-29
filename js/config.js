/* 막올림 공개 설정.
   - dropboxAppKey: Dropbox 앱의 App key(공개값). 정적 사이트에 노출되어도 안전(시크릿 아님).
     배포(GitHub Actions)에서 Secret DROPBOX_APP_KEY 값으로 아래 빈 문자열을 치환한다.
   - 로컬 개발: 이 파일을 커밋하지 말고 키만 바꾸거나,
     브라우저 콘솔에서 localStorage.setItem('makollim:dropboxAppKey','<APP_KEY>') 로 주입 가능.
   - 키가 비어 있으면(둘 다 없으면) Dropbox 백업 기능은 비활성화된다. */
window.MAKOLLIM_CONFIG = window.MAKOLLIM_CONFIG || {};
window.MAKOLLIM_CONFIG.dropboxAppKey = "__DROPBOX_APP_KEY__";
