#!/usr/bin/env bash
#
# detect-cards.sh <plan|build>
# --------------------------------------------------------------------------
# 연결된 Atlassian MCP 를 통해 claude 로 Jira 를 JQL 검색하여,
# 처리 대상 카드의 key 만 한 줄에 하나씩 출력합니다. (별도 Jira 토큰 불필요)
#
#   plan  대상: 담당자=나, 내용에 claude-work 포함, 상태!=DEV COMPLETED,
#              아직 'claude-planned' 라벨이 없는 카드 (= 질문 전)
#   build 대상: 담당자=나, 내용에 claude-work 포함, 상태!=DEV COMPLETED,
#              'claude-planned' 라벨이 있는 카드 (= 질문 완료, 답변 대기/완료)
#
# 출력 예:
#   EKYB-765
#   EKYB-770
# --------------------------------------------------------------------------

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# LLM 엔진 추상화(ENGINE/MODEL) — 탐지 폴백에도 선택 엔진 사용
source "${SELF_DIR}/lib-engine.sh"

MODE="${1:-plan}"
DONE_STATUS="${DONE_STATUS:-DEV COMPLETED}"
TRIGGER_MODE="${TRIGGER_MODE:-label}"          # label | text — 트리거 판정 방식
TRIGGER_LABEL="${TRIGGER_LABEL:-claude-work}"  # label 모드 트리거 라벨
TRIGGER_TEXT="${TRIGGER_TEXT:-claude-work}"    # text 모드(레거시) 트리거 텍스트
PLANNED_LABEL="${PLANNED_LABEL:-claude-planned}"
ANSWERED_LABEL="${ANSWERED_LABEL:-claude-answered}"   # build 진입 게이트(담당자 답변 완료 신호)
FAILED_LABEL="${FAILED_LABEL:-claude-failed}"   # 반복 실패 카드는 탐지에서 제외
PR_OPEN_LABEL="${PR_OPEN_LABEL:-claude-pr}"     # review 모드: PR 올린(병합 대기) 카드 표시
PROJECT_KEY="${PROJECT_KEY:-}"   # 설정 시 'AND project = X' 필터 추가

if ! engine_available; then
  echo "ERROR: 엔진 '$(engine_name)' 의 CLI 를 찾을 수 없습니다." >&2
  exit 1
fi

PROJECT_FILTER=""
if [[ -n "${PROJECT_KEY}" ]]; then
  PROJECT_FILTER=" AND project = \"${PROJECT_KEY}\""
fi

FAILED_FILTER=" AND (labels != \"${FAILED_LABEL}\" OR labels IS EMPTY)"
if [[ "${TRIGGER_MODE}" == "text" ]]; then
  TRIGGER_FILTER="text ~ \"${TRIGGER_TEXT}\""
else
  TRIGGER_FILTER="labels = \"${TRIGGER_LABEL}\""
fi
# 완료 상태 제외(복수 허용: 쉼표 구분) → status NOT IN ("A","B"). 공백은 트림.
DONE_FILTER=""
IFS=',' read -ra _DONES <<< "${DONE_STATUS}"
_DONE_IN=""
for _s in "${_DONES[@]}"; do
  _t="${_s#"${_s%%[![:space:]]*}"}"; _t="${_t%"${_t##*[![:space:]]}"}"   # ltrim/rtrim
  [[ -z "${_t}" ]] && continue
  [[ -n "${_DONE_IN}" ]] && _DONE_IN="${_DONE_IN}, "
  _DONE_IN="${_DONE_IN}\"${_t}\""
done
[[ -n "${_DONE_IN}" ]] && DONE_FILTER=" AND status NOT IN (${_DONE_IN})"
if [[ "${MODE}" == "plan" ]]; then
  JQL="assignee = currentUser()${DONE_FILTER} AND ${TRIGGER_FILTER} AND (labels != \"${PLANNED_LABEL}\" OR labels IS EMPTY)${FAILED_FILTER}${PROJECT_FILTER}"
elif [[ "${MODE}" == "build" ]]; then
  JQL="assignee = currentUser()${DONE_FILTER} AND ${TRIGGER_FILTER} AND labels = \"${PLANNED_LABEL}\" AND labels = \"${ANSWERED_LABEL}\"${FAILED_FILTER}${PROJECT_FILTER}"
elif [[ "${MODE}" == "review" ]]; then
  # review: PR 을 올린(claude-pr) 카드 = 병합 대기 PR → 자동 리뷰 대상
  JQL="assignee = currentUser()${DONE_FILTER} AND ${TRIGGER_FILTER} AND labels = \"${PR_OPEN_LABEL}\"${FAILED_FILTER}${PROJECT_FILTER}"
else
  echo "Usage: $0 <plan|build|review>" >&2
  exit 1
fi

# ===== REST 우선 탐지 (대시보드 백엔드가 떠 있으면 결정적·저비용) =====
# DASHBOARD_URL 이 주입되어 있고 curl 이 있으면 /api/detect/<mode> 로 조회.
# 응답이 없거나 실패하면 아래 claude(+MCP) 탐지로 폴백한다.
if [[ -n "${DASHBOARD_URL:-}" ]] && command -v curl >/dev/null 2>&1; then
  REST_RESP="$(curl -fsS --max-time 20 "${DASHBOARD_URL}/api/detect/${MODE}" 2>/dev/null || true)"
  if [[ -n "${REST_RESP}" ]]; then
    echo "${REST_RESP}" | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | sort -u
    exit 0
  fi
  echo "WARN: REST 탐지 실패 → claude 폴백" >&2
fi

PROMPT="Jira 에서 다음 JQL 로 이슈를 검색하세요:
${JQL}

검색된 이슈들의 key 만 한 줄에 하나씩 출력하세요.
설명, 마크다운, 코드블록, 그 외 어떤 텍스트도 출력하지 마세요. 오직 key 들만 출력하세요.
검색 결과가 없으면 'NONE' 한 줄만 출력하세요."

# 엔진 출력에서 이슈키(PROJ-숫자) 패턴만 추출 (그 외 잡텍스트 제거)
engine_run_text "${PROMPT}" 2>/dev/null | grep -oE '[A-Z][A-Z0-9]+-[0-9]+' | sort -u
