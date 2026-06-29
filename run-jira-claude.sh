#!/usr/bin/env bash
#
# run-jira-claude.sh
# --------------------------------------------------------------------------
# Jira 카드 기반으로 임의의 GitHub repo 개발을 반자동으로 진행하는 범용 스크립트.
# 카드별로 독립 디렉토리(<repo이름>-<카드키>)에서 동작하므로 병렬 실행이 가능합니다.
# 모든 설정은 환경변수로 주입합니다(대시보드가 주입하거나, 수동 실행 시 export).
#
# 흐름:
#   1) CLONE_BASE 아래에 <repo이름>-<카드키> 로 clone (없으면)
#   2) BASE_BRANCH 로 이동 + 최신화
#   3) env 파일(ENV_SRC, 기본 work.env)을 clone 된 디렉토리로 복사
#   4) clone 디렉토리로 cd
#   5) claude 실행
#        - plan  단계: 카드 검토 → 질문 코멘트 작성 → PLANNED_LABEL 라벨 추가
#        - build 단계: 답변 반영 개발 → 브랜치/커밋/푸시 → BASE_BRANCH 로 PR
#                      → 카드 설명의 트리거 텍스트 위에 완료 요약 기입 → DONE_STATUS 전환
#
# 사용법:
#   REPO_URL=https://github.com/Org/repo.git ./run-jira-claude.sh <ISSUE-KEY> plan
#   REPO_URL=https://github.com/Org/repo.git ./run-jira-claude.sh <ISSUE-KEY> build
# --------------------------------------------------------------------------

set -euo pipefail

# 스크립트가 위치한 폴더 (기본 작업 폴더로 사용)
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ===== 설정 (환경변수로 주입 가능, 없으면 기본값) =====
WORK_DIR="${WORK_DIR:-${SELF_DIR}}"
REPO_URL="${REPO_URL:-}"                       # 필수: 대상 GitHub repo URL
ENV_SRC="${ENV_SRC:-${WORK_DIR}/work.env}"     # 대상 repo로 복사할 env 파일
ENV_DEST_REL="${ENV_DEST_REL:-}"               # repo 내 복사 대상 상대경로(비우면 루트에 원본 파일명)
CLONE_BASE="${CLONE_BASE:-${WORK_DIR}/repos}"  # clone 들이 모이는 베이스 폴더
BASE_BRANCH="${BASE_BRANCH:-main}"
ASSIGNEE_EMAIL="${ASSIGNEE_EMAIL:-}"
ASSIGNEE_NAME="${ASSIGNEE_NAME:-담당자}"
TRIGGER_MODE="${TRIGGER_MODE:-label}"          # label | text — 트리거 판정 방식(label 권장)
TRIGGER_LABEL="${TRIGGER_LABEL:-claude-work}"  # label 모드에서 트리거로 쓰는 라벨
TRIGGER_TEXT="${TRIGGER_TEXT:-claude-work}"    # text 모드(레거시)에서 트리거로 쓰는 텍스트
DONE_STATUS="${DONE_STATUS:-DEV COMPLETED}"
PLANNED_LABEL="${PLANNED_LABEL:-claude-planned}"
ANSWERED_LABEL="${ANSWERED_LABEL:-claude-answered}"   # 담당자가 답변 완료를 알리는 명시 라벨(build 진입 게이트)
FAILED_LABEL="${FAILED_LABEL:-claude-failed}"   # 반복 실패 카드 표시(탐지 제외)
PR_OPEN_LABEL="${PR_OPEN_LABEL:-claude-pr}"     # PR 올림(병합 대기) 표시 — build 가 추가, 병합 시 완료 전환
MAX_RETRIES="${MAX_RETRIES:-3}"                 # 연속 실패 N회 초과 시 실패 처리
TEST_CMD="${TEST_CMD:-}"                        # 테스트 명령(비우면 claude 가 자동 감지)
BUILD_CMD="${BUILD_CMD:-}"                      # 빌드 명령(비우면 claude 가 자동 감지)
HISTORY_FILE="${HISTORY_FILE:-${WORK_DIR}/history.jsonl}"  # 처리 이력(JSONL) 기록 파일

ENV_NAME="$(basename "${ENV_SRC}")"
CARD_REPOS="${CARD_REPOS:-}"   # 대상 repo 목록: 'name<TAB>url<TAB>baseBranch' 줄 단위. 비우면 REPO_URL 단일.

# ===== 인자 파싱 =====
ISSUE_KEY="${1:-}"
PHASE="${2:-plan}"   # plan | build

if [[ -z "${ISSUE_KEY}" ]]; then
  echo "Usage: $0 <JIRA-ISSUE-KEY> [plan|build]" >&2
  exit 1
fi
if [[ "${PHASE}" != "plan" && "${PHASE}" != "build" ]]; then
  echo "ERROR: phase 는 'plan' 또는 'build' 여야 합니다 (입력: ${PHASE})" >&2
  exit 1
fi

# ===== 트리거 방식별 프롬프트 조각 =====
if [[ "${TRIGGER_MODE}" == "text" ]]; then
  TRIGGER_DESC="설명/내부 컨텐츠에 '${TRIGGER_TEXT}' 라는 텍스트가 포함되어 있는지"
  SUMMARY_INSTR="이슈 ${ISSUE_KEY} 설명에서 '${TRIGGER_TEXT}' 텍스트 '바로 위'에 완료 요약을 추가하세요.
      요약에는 변경 내용 요약, PR URL, 브랜치명, 완료 일시를 포함하세요. ('${TRIGGER_TEXT}' 텍스트 자체는 유지)"
else
  TRIGGER_DESC="'${TRIGGER_LABEL}' 라벨이 붙어 있는지"
  SUMMARY_INSTR="완료 요약을 이슈 '설명(description)' 의 '맨 아래'에만 추가하세요. (코멘트로는 남기지 마세요 — 중복 방지)
      기존 설명 내용은 절대 지우지 말고 그대로 보존한 뒤, 마지막에 '---' 구분선과 '## 완료 내역' 제목을 두고 그 아래에 요약을 추가하세요.
      요약에는 변경 내용 요약, PR URL, 브랜치명, 완료 일시를 포함하세요."
fi

# ===== PR 전 검증(테스트/빌드) 지시 — TEST_CMD/BUILD_CMD 미설정 시 claude 가 자동 감지 =====
TEST_DESC="${TEST_CMD:-자동 감지(package.json scripts.test, pytest/pytest.ini, go test, Makefile 의 test 타깃 등)}"
BUILD_DESC="${BUILD_CMD:-자동 감지(npm run build, tsc, go build, make 등 빌드/컴파일 수단)}"

# ===== Slack 알림 (SLACK_WEBHOOK_URL 미설정 시 스킵) =====
# 메시지는 토큰류(키/단계/URL/브랜치)와 고정 문구만 사용하므로 JSON 직접 구성이 안전.
notify_slack() {
  [[ -z "${SLACK_WEBHOOK_URL:-}" ]] && return 0
  command -v curl >/dev/null 2>&1 || return 0
  local text="$1"
  curl -fsS -X POST -H 'Content-type: application/json' \
    --data "{\"text\":\"${text}\"}" "${SLACK_WEBHOOK_URL}" >/dev/null 2>&1 || true
}

# ===== 처리 이력 기록 (JSONL 한 줄 추가) =====
# 값은 이슈키/단계/결과/URL/브랜치 등 토큰류라 별도 JSON escape 없이 안전.
record_history() {
  local result="$1" pr="${2:-}" branch="${3:-}" ts
  ts="$(date -u +%FT%TZ)"
  mkdir -p "$(dirname "${HISTORY_FILE}")"
  printf '{"ts":"%s","project":"%s","key":"%s","phase":"%s","result":"%s","pr":"%s","branch":"%s"}\n' \
    "${ts}" "${PROJECT_ID:-}" "${ISSUE_KEY}" "${PHASE}" "${result}" "${pr}" "${branch}" >> "${HISTORY_FILE}"
}

# ===== 필수 도구 확인 =====
for cmd in git claude; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: '${cmd}' 명령을 찾을 수 없습니다. 설치/PATH 를 확인하세요." >&2
    exit 1
  fi
done
if [[ "${PHASE}" == "build" ]] && ! command -v gh >/dev/null 2>&1; then
  echo "ERROR: PR 생성을 위해 'gh' (GitHub CLI) 가 필요합니다. 'brew install gh && gh auth login'" >&2
  exit 1
fi

# ===== 동시 실행 방지 락 (스케줄 루프 + 즉시 실행이 같은 카드를 중복 처리하지 않도록) =====
mkdir -p "${CLONE_BASE}/.state"
LOCK_DIR="${CLONE_BASE}/.state/${ISSUE_KEY}.lock"
if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
  echo "SKIP: [${ISSUE_KEY}] 이미 처리 중(lock) — 동시 실행 방지로 종료"
  exit 0
fi
# 처리 중 단계 표시용: 현재 phase 를 락 옆 파일에 기록(대시보드가 '처리 중' 표시에 사용)
printf '%s' "${PHASE}" > "${LOCK_DIR}.phase" 2>/dev/null || true
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true; rm -f "${LOCK_DIR}.phase" 2>/dev/null || true' EXIT

# ===== 대상 repo 목록 파싱 (CARD_REPOS: name\turl\tbaseBranch\tenvSrc\tenvDest; 없으면 REPO_URL 단일) =====
declare -a R_NAME R_URL R_BRANCH R_ENVSRC R_ENVDEST
if [[ -n "${CARD_REPOS}" ]]; then
  while IFS=$'\x1f' read -r _n _u _b _es _ed; do
    [[ -z "${_u:-}" ]] && continue
    R_NAME+=("${_n:-$(basename "${_u%.git}")}"); R_URL+=("${_u}"); R_BRANCH+=("${_b:-main}")
    R_ENVSRC+=("${_es:-${ENV_SRC}}"); R_ENVDEST+=("${_ed:-${ENV_DEST_REL}}")
  done <<< "${CARD_REPOS}"
fi
if [[ ${#R_URL[@]} -eq 0 ]]; then
  if [[ -z "${REPO_URL}" ]]; then echo "ERROR: 대상 repo 가 없습니다(CARD_REPOS/REPO_URL 미설정)." >&2; exit 1; fi
  R_NAME+=("$(basename "${REPO_URL%.git}")"); R_URL+=("${REPO_URL}"); R_BRANCH+=("${BASE_BRANCH}")
  R_ENVSRC+=("${ENV_SRC}"); R_ENVDEST+=("${ENV_DEST_REL}")
fi
echo ">> [${ISSUE_KEY}] 대상 repo ${#R_URL[@]}개: ${R_NAME[*]}"

# ===== clone + 클린업 + env 복사 (repo 별, env 도 repo별) =====
mkdir -p "${CLONE_BASE}"
REPO_LIST_TEXT=""
for idx in "${!R_URL[@]}"; do
  rn="${R_NAME[$idx]}"; ru="${R_URL[$idx]}"; rb="${R_BRANCH[$idx]}"
  res="${R_ENVSRC[$idx]}"; redr="${R_ENVDEST[$idx]}"
  rd="${CLONE_BASE}/${rn}-${ISSUE_KEY}"
  if [[ ! -d "${rd}/.git" ]]; then
    echo ">> [${ISSUE_KEY}] clone ${ru} -> ${rd}"
    git clone "${ru}" "${rd}"
  fi
  echo ">> [${ISSUE_KEY}] (${rn}) fetch & 클린업 & checkout ${rb}"
  git -C "${rd}" fetch origin --prune
  git -C "${rd}" reset --hard
  git -C "${rd}" clean -fd
  git -C "${rd}" checkout "${rb}"
  git -C "${rd}" reset --hard "origin/${rb}"
  # env 복사(repo별 envSrc → repo별 envDest, + .git/info/exclude 로 커밋 차단)
  if [[ -n "${res}" && -f "${res}" ]]; then
    if [[ -n "${redr}" ]]; then ed="${rd}/${redr}"; ee="${redr}"; else ed="${rd}/$(basename "${res}")"; ee="$(basename "${res}")"; fi
    mkdir -p "$(dirname "${ed}")"; cp "${res}" "${ed}"
    exf="${rd}/.git/info/exclude"
    for pat in "${ee}" ".env"; do
      if [[ ! -f "${exf}" ]] || ! grep -qxF "${pat}" "${exf}"; then echo "${pat}" >> "${exf}"; fi
    done
    echo ">> [${ISSUE_KEY}] (${rn}) env 복사: ${res} -> ${ed}"
  fi
  REPO_LIST_TEXT="${REPO_LIST_TEXT}- ${rn} (base 브랜치 ${rb}): ${rd}"$'\n'
done
cd "${CLONE_BASE}"
echo ">> [${ISSUE_KEY}] 작업 베이스: $(pwd)"

# ===== 5) claude 실행 (+ 실패 재시도/백오프) =====
# 카드 첨부 이미지(run-cycle 가 내려받아 CARD_IMAGES 로 전달)를 프롬프트에 주입 → Read 도구로 시각 인식.
IMAGE_INSTR=""
if [[ -n "${CARD_IMAGES:-}" ]]; then
  _imgs=""
  while IFS= read -r _p; do [[ -n "${_p}" ]] && _imgs+="  - ${_p}"$'\n'; done <<< "${CARD_IMAGES}"
  IMAGE_INSTR="

[이슈 첨부 이미지] 아래 파일들은 이 Jira 이슈(${ISSUE_KEY})의 설명/코멘트에 포함된 이미지입니다. 작업을 시작하기 전에 반드시 'Read' 도구로 각 파일을 열어 시각적으로 내용을 파악하고(스크린샷·다이어그램·UI 시안·오류 화면 등), 요구사항 이해와 구현에 반영하세요:
${_imgs}"
fi

if [[ "${PHASE}" == "plan" ]]; then
  echo ">> [${ISSUE_KEY}] [PLAN] 카드 검토 + 질문 코멘트 작성"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 작업을 준비 중입니다.

먼저 확인:
1. 이 이슈가 ${ASSIGNEE_NAME} (${ASSIGNEE_EMAIL}) 에게 할당되어 있는지 확인하세요.
2. 이슈가 트리거 조건(${TRIGGER_DESC})을 충족하는지 확인하세요.
3. 이슈의 현재 상태가 '${DONE_STATUS}' 가 아닌지 확인하세요.
   위 조건 중 하나라도 충족하지 않으면, 아무 작업도 하지 말고 이유를 출력하고 종료하세요.

조건 충족 시:
- 다음 대상 repo 들의 코드베이스를 살펴보고, 이슈가 요구하는 구현 내용을 검토하세요(여러 repo 일 수 있음):
${REPO_LIST_TEXT}
- 아직 코드를 작성하지 마세요.
- 구현 전에 명확히 해야 할 질문들을 정리해, Jira 이슈 ${ISSUE_KEY} 에 코멘트로 작성하세요.
  코멘트는 담당자(${ASSIGNEE_NAME})를 멘션하고, 답변하기 쉽게 번호를 매겨 질문하세요.
  코멘트 끝에 '답변을 마치신 뒤 이 이슈에 \"${ANSWERED_LABEL}\" 라벨을 추가해 주세요. (라벨이 있어야 자동 build 가 진행됩니다)' 안내를 포함하세요.
- 질문이 없다면, '질문 없음 — 구현 준비 완료' 라는 코멘트를 남기고, 마찬가지로 담당자에게 '${ANSWERED_LABEL}' 라벨 추가를 요청하세요.
- 코멘트 작성에 성공한 뒤, 이 이슈에 '${PLANNED_LABEL}' 라벨을 추가하세요.
  (이 라벨은 build 루프가 이 카드를 인식하고, plan 루프가 중복 처리하지 않도록 하는 표시입니다.)"
elif [[ -n "${REWORK:-}" ]]; then
  echo ">> [${ISSUE_KEY}] [REWORK] 기존 PR 리뷰 반영 (대상 repo ${#R_URL[@]}개)"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 의 '기존 PR'에 리뷰 피드백을 반영합니다. 새 PR/새 브랜치는 만들지 마세요.
대상 repo 들은 아래 경로에 clone 되어 있습니다(여러 repo 일 수 있음):
${REPO_LIST_TEXT}

[매우 중요] 헤드리스 1회 실행입니다. 백그라운드로 미루지 말고 이 턴 안에서 끝까지 동기 수행하세요.

각 repo 에 대해:
1. 'gh pr list --state open --search \"${ISSUE_KEY}\"' 로 이 이슈의 열린 PR 을 찾으세요. 없으면 그 repo 는 건너뜁니다(반영 대상 아님).
2. 그 PR 의 head 브랜치를 checkout 하세요 (git fetch origin 후 해당 브랜치로).
3. 반영할 피드백을 모으세요:
   - GitHub 리뷰: 'gh pr view <번호> --comments' 및 'gh api repos/{owner}/{repo}/pulls/{번호}/comments' · '.../reviews' 의 리뷰 코멘트/스레드.
   - Jira: 이슈 ${ISSUE_KEY} 의 '최신 코멘트'(특히 담당자 ${ASSIGNEE_NAME} 가 남긴 리뷰 반영 요청).
4. 요청된 변경을 구현하세요.
5. PR 전 검증: 테스트 수단(${TEST_DESC})이 있으면 통과할 때까지 수정, 없으면 빌드(${BUILD_DESC})만 시도(수단 없으면 생략).
6. '같은 브랜치'에 커밋(메시지 하단에 '${ISSUE_KEY}' 명시) 후 'origin' 으로 push 하면 기존 PR 이 자동 갱신됩니다. (새 PR 생성 금지)
   - env 파일(.env 또는 복사된 env)은 절대 커밋/푸시하지 마세요.
7. 반영 후 Jira 이슈 ${ISSUE_KEY} 에 '리뷰 반영 완료' 코멘트(반영 항목 요약 + 갱신된 PR URL)를 남기세요. 이슈 '상태는 변경하지 마세요'.
PR 을 하나도 갱신하지 못했으면(반영할 PR 없음 등) 사유를 출력하고 비정상 종료하세요.
완료 후 갱신한 PR URL 들을 출력하세요."
else
  echo ">> [${ISSUE_KEY}] [BUILD] 답변 반영 + 개발 + PR (대상 repo ${#R_URL[@]}개)"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 를 아래 대상 repo 들에서 구현합니다(여러 repo 일 수 있음). 각 repo 는 표시된 경로에 clone 되어 있습니다:
${REPO_LIST_TEXT}

[매우 중요] 이 작업은 헤드리스 1회 실행입니다. 작업을 '백그라운드로 미루거나' '나중에 알림을 받겠다'는 식으로 끝내지 마세요.
테스트/빌드/커밋/푸시/PR/상태전환을 모두 '이 턴 안에서 동기적으로' 끝까지 수행한 뒤 종료하세요(오래 걸려도 끝까지 대기).
PR 을 하나도 생성하지 못했다면 절대 완료로 간주하지 말고, 사유를 출력하고 비정상 종료하세요(다음 주기에 재시도됩니다).

1. Jira 이슈 ${ISSUE_KEY} 의 설명과 '모든 코멘트'(특히 담당자 ${ASSIGNEE_NAME} 의 답변), 그리고 라벨을 읽으세요.
2. build 진입 조건은 다음 '둘 다' 충족입니다. 둘 중 하나라도 없으면 어떤 코드 변경/커밋/PR도 하지 말고
   정확히 'SKIP: awaiting answers' 한 줄만 출력하고 종료하세요. (다음 주기에 다시 시도됩니다.)
   (a) 이슈에 '${ANSWERED_LABEL}' 라벨이 붙어 있을 것 (담당자가 답변 완료를 명시한 신호).
   (b) plan 단계의 bot 질문 코멘트 이후에 담당자 ${ASSIGNEE_NAME} 의 실제 답변 코멘트가 존재할 것.
3. 답변이 있으면 그 내용을 반영해 요구된 작업을 구현하세요.
4. PR 전 검증 (중요):
   - 테스트 수단(${TEST_DESC})이 이 프로젝트에 존재하는지 확인하세요.
   - 테스트가 '존재하면' 실행하세요. 실패하면 원인을 고치고 다시 실행하기를 '통과할 때까지' 반복하세요.
     (도저히 통과시킬 수 없으면 사유를 출력하고 비정상 종료하세요. PR 을 만들지 마세요.)
   - 테스트가 '존재하지 않으면' 테스트는 건너뛰고, 빌드/컴파일(${BUILD_DESC})만 시도하세요.
     빌드 수단이 있으면 실행해 통과시키고(실패 시 고쳐서 통과), 빌드 수단 자체가 없으면 이 단계를 건너뜁니다.
   - 검증을 통과(또는 정당하게 건너뜀)한 경우에만 다음 단계로 진행하세요.
5. 구현·검증 후 — 위 '각 repo' 에 대해(변경이 필요 없는 repo 는 건너뜀):
   - 해당 repo 디렉토리로 이동(cd)해서 작업하세요.
   - PR 생성 전 'gh pr list' 로 이 이슈의 PR/브랜치가 이미 있는지 확인하고, 있으면 그 repo 는 중복 생성하지 말고 건너뛰세요.
   - feature/${ISSUE_KEY}-<짧은-설명> 브랜치 생성 → 명확한 메시지로 커밋(메시지 하단에 '${ISSUE_KEY}' 명시) → 'origin' push.
   - gh CLI 로 그 repo 의 base 브랜치를 target 으로 PR 을 생성하고 PR URL 을 출력하세요.
   - (보안) env 파일(.env 또는 복사된 env 파일)은 절대 커밋/푸시하지 마세요. 커밋 전 git status 로 확인하세요.
6. 최소 한 개 repo 에서 PR 을 생성한 뒤 마무리로:
   a) ${SUMMARY_INSTR}
      (변경한 모든 repo 의 PR URL·브랜치를 repo 별로 나열하세요.)
   b) 이슈에 '${PR_OPEN_LABEL}' 라벨을 추가하세요(= PR 올림/병합 대기 표시). 이슈 '상태는 변경하지 마세요'.
      (병합은 사람이 리뷰 후 대시보드에서 수행하며, 그때 완료 상태로 전환됩니다.)
완료 후 결과(repo별 테스트/빌드 결과 · 브랜치 · PR URL) 요약을 출력하세요."
fi

# 첨부 이미지 인식 지시를 모든 단계(plan/build/rework) 프롬프트에 공통 추가
PROMPT="${PROMPT}${IMAGE_INSTR}"

# ===== 실행 + 실패 재시도/백오프 처리 =====
# claude 가 0이 아닌 코드로 종료하면 실패로 보고 카드별 실패 카운터를 증가시킨다.
# (build 의 'SKIP: awaiting answers' 는 정상 종료(0)이므로 실패로 집계되지 않는다.)
STATE_DIR="${CLONE_BASE}/.state"
FAIL_FILE="${STATE_DIR}/${ISSUE_KEY}.fail"
CLAUDE_OUT="${STATE_DIR}/${ISSUE_KEY}.${PHASE}.out"
mkdir -p "${STATE_DIR}"

# claude 상세 실행 로그(도구 호출/메시지/결과)를 카드별로 영속 기록 → 대시보드에서 조회
CLAUDE_LOG_DIR="${WORK_DIR}/claude-logs"
mkdir -p "${CLAUDE_LOG_DIR}"
CLAUDE_LOG="${CLAUDE_LOG_DIR}/${ISSUE_KEY}-${PHASE}.log"
{ echo ""; echo "===== $(date -u +%FT%TZ) ${ISSUE_KEY} ${PHASE} 실행 ====="; } >> "${CLAUDE_LOG}"

# stream-json + 렌더러로 과정을 사람이 읽게 기록하고 최종 결과 텍스트는 CLAUDE_OUT 으로 추출.
# node/렌더러가 없으면 기존 텍스트 모드로 폴백(자동화 동작에는 영향 없음).
set +e
if command -v node >/dev/null 2>&1 && [[ -f "${SELF_DIR}/render-claude-stream.js" ]]; then
  claude -p "${PROMPT}" --output-format stream-json --verbose 2>>"${CLAUDE_LOG}" \
    | node "${SELF_DIR}/render-claude-stream.js" "${CLAUDE_LOG}" \
    | tee "${CLAUDE_OUT}"
  # PIPESTATUS 는 다음 명령에서 리셋되므로 한 번에 배열로 캡처(세미콜론 분리 금지)
  PIPE_ST=("${PIPESTATUS[@]}")
  CSTATUS=${PIPE_ST[0]:-1}; RSTATUS=${PIPE_ST[1]:-0}
  [[ "${CSTATUS}" -eq 0 && "${RSTATUS}" -eq 0 ]]; CLAUDE_OK=$?
else
  claude -p "${PROMPT}" 2>&1 | tee "${CLAUDE_OUT}"
  CLAUDE_OK=${PIPESTATUS[0]}
  cat "${CLAUDE_OUT}" >> "${CLAUDE_LOG}" 2>/dev/null || true
fi
set -e

# 결과 분류: PR/브랜치 추출 + 미완료 감지
PR_URL=""; BRANCH_OUT=""; RESULT="failed"
if [[ "${CLAUDE_OK}" -eq 0 ]]; then
  PR_URL="$(grep -oE 'https://github\.com/[^ )]+/pull/[0-9]+' "${CLAUDE_OUT}" | head -n1 || true)"
  BRANCH_OUT="$(grep -oE "feature/${ISSUE_KEY}[A-Za-z0-9._/-]*" "${CLAUDE_OUT}" | head -n1 || true)"
  if grep -q 'SKIP:' "${CLAUDE_OUT}"; then
    RESULT="skip"
  elif [[ "${PHASE}" == "build" && -z "${PR_URL}" ]]; then
    # build/rework 인데 PR URL 이 없으면 미완료(예: 작업을 백그라운드로 미루고 종료) → 재시도 대상
    RESULT="incomplete"
    echo ">> [${ISSUE_KEY}] PR 없이 종료됨 → 미완료(재시도 대상)" >&2
  elif [[ -n "${REWORK:-}" ]]; then
    RESULT="rework"
  else
    RESULT="success"
  fi
fi

if [[ "${RESULT}" == "success" || "${RESULT}" == "skip" || "${RESULT}" == "rework" ]]; then
  rm -f "${FAIL_FILE}"
  echo ">> [${ISSUE_KEY}] 완료 (phase=${PHASE}, result=${RESULT})"
  record_history "${RESULT}" "${PR_URL}" "${BRANCH_OUT}"
  if [[ "${RESULT}" == "success" || "${RESULT}" == "rework" ]]; then
    [[ "${RESULT}" == "rework" ]] && MSG="🔧 [${ISSUE_KEY}] 리뷰 반영 완료(PR 갱신)" || MSG="✅ [${ISSUE_KEY}] ${PHASE} 처리 완료"
    [[ -n "${PR_URL}" ]] && MSG="${MSG} · PR: ${PR_URL}"
    [[ -n "${BRANCH_OUT}" ]] && MSG="${MSG} · branch: ${BRANCH_OUT}"
    notify_slack "${MSG}"
  fi
else
  count=$(( $(cat "${FAIL_FILE}" 2>/dev/null || echo 0) + 1 ))
  echo "${count}" > "${FAIL_FILE}"
  echo ">> [${ISSUE_KEY}] ${RESULT} (phase=${PHASE}, ${count}/${MAX_RETRIES})" >&2
  record_history "${RESULT}" "${PR_URL}" "${BRANCH_OUT}"
  if (( count >= MAX_RETRIES )); then
    echo ">> [${ISSUE_KEY}] 최대 재시도(${MAX_RETRIES}) 초과 → '${FAILED_LABEL}' 라벨 + 실패 코멘트" >&2
    ERR_TAIL="$(tail -n 25 "${CLAUDE_OUT}" 2>/dev/null || true)"
    claude -p "Jira 이슈 ${ISSUE_KEY} 의 자동화 처리가 ${MAX_RETRIES}회 연속 실패했습니다.
다음만 수행하고, 코드 변경/커밋/PR 은 절대 하지 마세요:
1) 이슈 ${ISSUE_KEY} 에 '${FAILED_LABEL}' 라벨을 추가하세요.
2) 담당자(${ASSIGNEE_NAME})를 멘션해, 자동화가 반복 실패하여 수동 확인이 필요하다는 코멘트를 남기세요.
   아래 마지막 오류 로그 요약을 코멘트에 포함하세요:
---
${ERR_TAIL}
---" || true
    notify_slack "❌ [${ISSUE_KEY}] ${PHASE} 처리 실패 (${MAX_RETRIES}회 연속) — 수동 확인 필요"
  fi
  exit 1
fi
