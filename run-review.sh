#!/usr/bin/env bash
#
# run-review.sh <JIRA-ISSUE-KEY>
# --------------------------------------------------------------------------
# 자동화가 만든 build PR(claude-pr 카드의 열린 PR)을 Claude(리뷰어)로 자동 리뷰한다.
#   1) 카드 KEY 로 대상 repo 들의 '열린 PR' 을 찾는다(gh pr list --search KEY).
#   2) 각 PR 에 이미 승인 마커(CLAUDE-REVIEW-APPROVED)가 있으면 스킵(승인 완료 → 영구 스킵).
#   3) 없으면 Claude 에게 PR diff·본문(정리 사항)·기존 코멘트/리뷰·연동 Jira 티켓을 읽혀
#      코드 리뷰를 수행시킨다.
#        - 문제가 있으면: 구체적 지적을 PR 리뷰 코멘트로 남긴다(승인 마커 없음 → 다음 주기 재리뷰).
#        - 문제가 없으면: 고유 승인 마커 코멘트를 남긴다(자기 PR 은 formal approve 불가하므로 마커로 대체).
#
# 매 주기 미승인 PR 은 최신 코멘트를 다시 읽어 재리뷰하고, 한 번 승인 마커가 남으면 이후 스킵한다.
#
# env: PROJECT_ID, CARD_REPOS(name\x1furl\x1f...), GH_TOKEN, JIRA_SITE, ASSIGNEE_NAME,
#      CLONE_BASE, HISTORY_FILE, PROJECT_KEY (+ Atlassian MCP 인증은 claude 쪽)
# --------------------------------------------------------------------------
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="${WORK_DIR:-${SELF_DIR}}"
CLONE_BASE="${CLONE_BASE:-${WORK_DIR}/repos}"
ASSIGNEE_NAME="${ASSIGNEE_NAME:-담당자}"
HISTORY_FILE="${HISTORY_FILE:-${WORK_DIR}/history.jsonl}"
CARD_REPOS="${CARD_REPOS:-}"
APPROVED_MARKER="CLAUDE-REVIEW-APPROVED"   # lib.js REVIEW_APPROVED_MARKER 와 동일해야 함

ISSUE_KEY="${1:-}"
if [[ -z "${ISSUE_KEY}" ]]; then echo "Usage: $0 <JIRA-ISSUE-KEY>" >&2; exit 1; fi

if ! command -v gh >/dev/null 2>&1; then echo "ERROR: 'gh' (GitHub CLI) 가 필요합니다." >&2; exit 1; fi
if ! command -v claude >/dev/null 2>&1; then echo "ERROR: 'claude' 명령을 찾을 수 없습니다." >&2; exit 1; fi

record_history() {  # result pr
  local result="$1" pr="${2:-}" ts
  ts="$(date -u +%FT%TZ)"
  mkdir -p "$(dirname "${HISTORY_FILE}")"
  printf '{"ts":"%s","project":"%s","key":"%s","phase":"review","result":"%s","pr":"%s","branch":""}\n' \
    "${ts}" "${PROJECT_ID:-}" "${ISSUE_KEY}" "${result}" "${pr}" >> "${HISTORY_FILE}"
}
# Slack 알림 (SLACK_WEBHOOK_URL 미설정 시 스킵)
notify_slack() {
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  curl -fsS -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"$1\"}" "${SLACK_WEBHOOK_URL}" >/dev/null 2>&1 || true
}

# 동시 실행 방지 락(빌드 락과 별개 — review 전용)
STATE_DIR="${CLONE_BASE}/.state"; mkdir -p "${STATE_DIR}"
LOCK_DIR="${STATE_DIR}/${ISSUE_KEY}.review.lock"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "SKIP: [${ISSUE_KEY}] 리뷰 이미 처리 중(lock)"; exit 0
fi
printf 'review' > "${LOCK_DIR}.phase" 2>/dev/null || true
printf '%s' "$$" > "${LOCK_DIR}.pid" 2>/dev/null || true
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true; rm -f "${LOCK_DIR}.phase" "${LOCK_DIR}.pid" 2>/dev/null || true' EXIT

# 대상 repo(owner/name) 목록 파싱
declare -a R_OWNER
if [[ -n "${CARD_REPOS}" ]]; then
  while IFS=$'\x1f' read -r _n _u _rest; do
    [[ -z "${_u:-}" ]] && continue
    _or="$(printf '%s' "${_u}" | sed -E 's#\.git$##; s#^.*[:/]([^/:]+/[^/]+)$#\1#')"
    [[ -n "${_or}" ]] && R_OWNER+=("${_or}")
  done <<< "${CARD_REPOS}"
fi
if [[ ${#R_OWNER[@]} -eq 0 ]]; then echo "SKIP: [${ISSUE_KEY}] 대상 repo 없음"; exit 0; fi

CLAUDE_LOG_DIR="${WORK_DIR}/claude-logs"; mkdir -p "${CLAUDE_LOG_DIR}"

# 자동화(봇) 계정 로그인 — 기본은 봇이 만든 PR 만 리뷰(사람 PR 은 자동 리뷰하지 않음).
BOT_LOGIN="$(gh api user --jq .login 2>/dev/null || true)"
# 개별 PR 리뷰 모드(대시보드 'PR 목록'의 '이 PR 리뷰'): 지정 repo/번호의 PR 만 리뷰(사람 PR 포함).
REVIEW_ONLY_OWNER="${REVIEW_ONLY_OWNER:-}"
REVIEW_ONLY_NUM="${REVIEW_ONLY_NUM:-}"
# 개별 PR 지정 시엔 CARD_REPOS 와 무관하게 그 repo 를 직접 대상으로(설정에 없는 repo 의 연동 PR 도 리뷰 가능)
if [[ -n "${REVIEW_ONLY_OWNER}" ]]; then R_OWNER=("${REVIEW_ONLY_OWNER}"); fi

reviewed_any=0
for OR in "${R_OWNER[@]}"; do
  # 개별 PR 모드면 그 repo 만 처리
  [[ -n "${REVIEW_ONLY_OWNER}" && "${OR}" != "${REVIEW_ONLY_OWNER}" ]] && continue
  # 이 이슈의 '열린' PR 목록(draft 제외). 개별 모드가 아니면 봇 author 만.
  PRS_JSON="$(gh pr list --repo "${OR}" --search "${ISSUE_KEY}" --state open --json number,url,isDraft,headRefName,author 2>/dev/null || echo '[]')"
  NUMS="$(printf '%s' "${PRS_JSON}" | BOT_LOGIN="${BOT_LOGIN}" ONLY_NUM="${REVIEW_ONLY_NUM}" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const bot=process.env.BOT_LOGIN||"",only=process.env.ONLY_NUM||"";JSON.parse(d).filter(p=>!p.isDraft).filter(p=>only?String(p.number)===only:(!bot||(p.author&&p.author.login)===bot)).forEach(p=>console.log(p.number))}catch{}})')"
  [[ -z "${NUMS}" ]] && continue

  while IFS= read -r N; do
    [[ -z "${N}" ]] && continue
    PR_URL="https://github.com/${OR}/pull/${N}"
    # 승인 마커가 이미 있으면 스킵(승인 완료 → 영구 스킵). 단, 수동 실행(FORCE_REVIEW=1)은 강제 재리뷰.
    BODIES="$(gh api "repos/${OR}/issues/${N}/comments?per_page=100" --jq '.[].body' 2>/dev/null || true)"
    if [[ "${FORCE_REVIEW:-}" != "1" ]] && printf '%s' "${BODIES}" | grep -q "${APPROVED_MARKER}"; then
      echo ">> [${ISSUE_KEY}] ${OR}#${N} 이미 승인됨(마커 존재) → 스킵"
      continue
    fi

    echo ">> [${ISSUE_KEY}] ${OR}#${N} 리뷰 시작"
    reviewed_any=1
    HEAD_SHA="$(gh pr view "${N}" --repo "${OR}" --json headRefOid --jq '.headRefOid' 2>/dev/null || echo "")"

    PROMPT="당신은 이 GitHub Pull Request 의 '코드 리뷰어'입니다(리뷰 대상 PR 은 자동화가 올린 것이라 직접 approve 는 불가하니 아래 규칙을 따르세요).

대상: repo=${OR}, PR 번호=${N}, PR URL=${PR_URL}, 연동 Jira 이슈=${ISSUE_KEY}

[매우 중요] 헤드리스 1회 실행입니다. 백그라운드로 미루지 말고 이 턴 안에서 리뷰와 코멘트 작성까지 동기적으로 끝내세요.

1. 다음을 모두 읽어 맥락을 파악하세요:
   - PR 코드 변경(diff): 'gh pr diff ${N} --repo ${OR}'
   - PR 제목·본문(정리 사항): 'gh pr view ${N} --repo ${OR} --json title,body,headRefName'
   - 기존 리뷰·코멘트(지금까지 오간 피드백, 사람이 새로 남긴 코멘트 포함):
     'gh pr view ${N} --repo ${OR} --comments' 및
     'gh api repos/${OR}/pulls/${N}/comments' · 'gh api repos/${OR}/pulls/${N}/reviews'
   - 연동 Jira 티켓 ${ISSUE_KEY} 의 설명·수용조건·코멘트(Atlassian MCP 의 getJiraIssue 등으로 조회). 요구사항 대비 구현이 맞는지 대조하세요.
2. 코드 리뷰를 수행하세요: 요구사항 충족 여부, 버그·엣지케이스, 보안, 에러 처리, 테스트 유무/타당성, 가독성, 회귀 위험 등. 이미 지적된 항목이 반영됐는지도 확인하세요.
3. 판단에 따라 '정확히 한 가지'만 수행하세요:
   (A) 문제가 있으면 → 구체적 지적(파일/라인/이유/제안)을 PR 코멘트로 남기세요:
       'gh pr comment ${N} --repo ${OR} --body-file <파일>' (여러 지적은 하나의 코멘트에 정리). 승인 마커는 절대 남기지 마세요.
   (B) 문제가 없고 요구사항을 올바르게 충족했다고 확신하면 → 아래 '승인 마커 코멘트'를 남기세요(자기 PR 이라 'gh pr review --approve' 는 실패하므로 사용 금지):
       'gh pr comment ${N} --repo ${OR} --body \"✅ ${APPROVED_MARKER}

이 PR 은 자동 리뷰 결과 요구사항을 충족하고 문제가 없어 승인합니다.
- 리뷰어: Claude(자동)
- 근거 요약: <핵심 근거 2~4줄>
<!-- ${APPROVED_MARKER}:${HEAD_SHA} -->\"'
   승인 마커 코멘트에는 반드시 '${APPROVED_MARKER}' 문자열이 포함돼야 합니다(이후 재리뷰 스킵 판정에 사용).
4. 절대 코드를 수정하거나 커밋/푸시/머지하지 마세요. 리뷰(코멘트)만 남깁니다. Jira 상태·라벨도 바꾸지 마세요.
마지막에 결과를 'REVIEW_RESULT: approved' 또는 'REVIEW_RESULT: commented' 한 줄로 출력하세요."

    CLAUDE_LOG="${CLAUDE_LOG_DIR}/${ISSUE_KEY}-review.log"
    { echo ""; echo "===== $(date -u +%FT%TZ) ${ISSUE_KEY} ${OR}#${N} review ====="; } >> "${CLAUDE_LOG}"
    CLAUDE_OUT="${STATE_DIR}/${ISSUE_KEY}.review.out"
    set +e
    if command -v node >/dev/null 2>&1 && [[ -f "${SELF_DIR}/render-claude-stream.js" ]]; then
      claude -p "${PROMPT}" --output-format stream-json --verbose 2>>"${CLAUDE_LOG}" \
        | node "${SELF_DIR}/render-claude-stream.js" "${CLAUDE_LOG}" | tee "${CLAUDE_OUT}"
    else
      claude -p "${PROMPT}" 2>&1 | tee "${CLAUDE_OUT}" >> "${CLAUDE_LOG}"
    fi
    set -e

    # 승인 여부 재확인(마커가 실제로 남았는지 GitHub 에서 확인 — 신뢰 가능한 판정)
    BODIES2="$(gh api "repos/${OR}/issues/${N}/comments?per_page=100" --jq '.[].body' 2>/dev/null || true)"
    if printf '%s' "${BODIES2}" | grep -q "${APPROVED_MARKER}"; then
      echo ">> [${ISSUE_KEY}] ${OR}#${N} 리뷰 승인(마커 작성)"
      record_history "approved" "${PR_URL}"
      notify_slack "✅ [${ISSUE_KEY}] PR 리뷰 승인 · ${OR}#${N} · ${PR_URL}"
    else
      echo ">> [${ISSUE_KEY}] ${OR}#${N} 리뷰 코멘트(미승인 — 다음 주기 재리뷰)"
      record_history "reviewed" "${PR_URL}"
      notify_slack "📝 [${ISSUE_KEY}] PR 리뷰 코멘트(수정 필요) · ${OR}#${N} · ${PR_URL}"
    fi
  done <<< "${NUMS}"
done

[[ "${reviewed_any}" -eq 0 ]] && echo ">> [${ISSUE_KEY}] 리뷰할 미승인 PR 없음"
exit 0
