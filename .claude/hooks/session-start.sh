#!/bin/bash
set -euo pipefail

# Claude Code on the web(원격 세션)에서 git author를 Spinouetter로 기본 지정한다.
# --author 지정을 깜빡해도 커밋 author가 Spinouetter가 되게 한다.
#
# committer는 절대 건드리지 않는다(로컬 config의 Claude <noreply@anthropic.com> 유지).
#   이 환경의 서명키가 Claude 신원에 묶여 있어, committer=Claude일 때만
#   커밋이 GitHub에서 Verified로 뜬다. GIT_AUTHOR_*만 설정하면 author만 바뀌고
#   committer는 config 기본값(Claude)이 그대로 쓰인다.
#
# 규칙 전체는 CLAUDE.md의 "작업 방식" 참고.

# 원격(웹) 세션에서만 적용 — 로컬에서 사용자가 직접 돌릴 땐 건드리지 않는다.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# 세션 환경파일에 author를 주입(중복 방지). CLAUDE_ENV_FILE은 세션 내내 유지된다.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && ! grep -q 'GIT_AUTHOR_EMAIL=.*spinouetter' "$CLAUDE_ENV_FILE" 2>/dev/null; then
  echo 'export GIT_AUTHOR_NAME="Spinouetter"' >> "$CLAUDE_ENV_FILE"
  echo 'export GIT_AUTHOR_EMAIL="297621346+spinouetter@users.noreply.github.com"' >> "$CLAUDE_ENV_FILE"
fi
