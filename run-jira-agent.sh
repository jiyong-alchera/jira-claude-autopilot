#!/usr/bin/env bash
#
# run-jira-agent.sh
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
#   REPO_URL=https://github.com/Org/repo.git ./run-jira-agent.sh <ISSUE-KEY> plan
#   REPO_URL=https://github.com/Org/repo.git ./run-jira-agent.sh <ISSUE-KEY> build
# --------------------------------------------------------------------------

set -euo pipefail

# 스크립트가 위치한 폴더 (기본 작업 폴더로 사용)
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# LLM 엔진 추상화(ENGINE/MODEL). run-cycle.js·server.js 가 env 로 주입한다.
source "${SELF_DIR}/lib-engine.sh"

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
TARGET_BRANCH_LABEL="${TARGET_BRANCH_LABEL:-claude-branched}"   # plan 이 타겟(작업) 브랜치를 만들었음을 표시하는 라벨
TARGET_BRANCH_MARK="🌿 타겟 브랜치:"           # Jira 코멘트에 타겟 브랜치명을 남기는 마커(build 가 이걸로 브랜치 인식)
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

# claude 가 완료 요약(md)을 쓰는 파일 → 스크립트가 설명 ADF 에 안전 append(이미지 보존)
SUMMARY_FILE="${SUMMARY_FILE:-${CLONE_BASE}/.state/${ISSUE_KEY}.summary.md}"

# ===== 트리거 방식별 프롬프트 조각 =====
if [[ "${TRIGGER_MODE}" == "text" ]]; then
  TRIGGER_DESC="설명/내부 컨텐츠에 '${TRIGGER_TEXT}' 라는 텍스트가 포함되어 있는지"
  SUMMARY_INSTR="이슈 ${ISSUE_KEY} 설명에서 '${TRIGGER_TEXT}' 텍스트 '바로 위'에 완료 요약을 추가하세요.
      요약에는 변경 내용 요약, PR URL, 브랜치명, 완료 일시를 포함하세요. ('${TRIGGER_TEXT}' 텍스트 자체는 유지)"
else
  TRIGGER_DESC="'${TRIGGER_LABEL}' 라벨이 붙어 있는지"
  SUMMARY_INSTR="완료 요약을 markdown 으로 작성해 파일 '${SUMMARY_FILE}' 에 저장만 하세요(Write 도구 사용).
      ⚠️ Jira 설명(description)은 절대 직접 수정하지 마세요 — 시스템이 요약을 설명 맨 아래에 안전하게 추가하며, 설명을 직접 편집하면 본문의 붙여넣은 이미지가 깨집니다.
      코멘트로도 남기지 마세요(중복 방지). '## 완료 내역' 제목은 시스템이 붙이므로 본문만 작성하세요.
      요약에는 변경 내용 요약, PR URL, 브랜치명, 완료 일시를 포함하세요."
fi

# ===== PR 전 검증(테스트/빌드) 지시 — TEST_CMD/BUILD_CMD 미설정 시 claude 가 자동 감지 =====
TEST_DESC="${TEST_CMD:-자동 감지(package.json scripts.test, pytest/pytest.ini, go test, Makefile 의 test 타깃 등)}"
BUILD_DESC="${BUILD_CMD:-자동 감지(npm run build, tsc, go build, make 등 빌드/컴파일 수단)}"

# ===== PR 본문 작성 지시(생성·갱신 공통) =====
if [[ -n "${JIRA_SITE:-}" ]]; then
  JIRA_REF_LINE="- Jira: https://${JIRA_SITE}/browse/${ISSUE_KEY} (이슈 키 ${ISSUE_KEY})"
else
  JIRA_REF_LINE="- 이슈 키: ${ISSUE_KEY}"
fi
PR_BODY_INSTR="PR 본문에는 아래 구조의 한국어 개발 설명을 작성하세요(실제 변경에 맞게 채우고, 해당 없는 섹션만 생략):
   ## 개요
   - 이 PR 이 무엇을 하는지 1~3줄 요약
   ${JIRA_REF_LINE}
   ## 변경 사항
   - 무엇을·왜 바꿨는지 핵심 변경을 불릿으로 (필요하면 파일/모듈 단위로)
   ## 구현 상세
   - 설계 결정·접근 방식·주요 구현 포인트
   ## 테스트 / 검증
   - 실행한 테스트·빌드 명령과 결과(예: \`go test ./...\` 통과, 빌드 통과)
   ## 리뷰 포인트 / 주의사항
   - 리뷰어가 집중해서 볼 부분, 마이그레이션·롤백·후속 작업·알려진 한계 등
   본문은 길고 특수문자를 포함하므로 임시 파일에 작성한 뒤 '--body-file <파일>' 로 전달하세요(셸 이스케이프 문제 방지)."

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
# 멀티 repo: 생성된 PR 을 '각각' 개별 이력으로 기록(PR 마다 head 브랜치 조회). PR 이 없으면 1건만.
record_history_prs() {
  local result="$1" _pr _br
  if [[ -z "${ALL_PRS:-}" ]]; then record_history "${result}" "" ""; return; fi
  while IFS= read -r _pr; do
    [[ -z "${_pr}" ]] && continue
    _br="$(gh pr view "${_pr}" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
    record_history "${result}" "${_pr}" "${_br}"
  done <<< "${ALL_PRS}"
}

# ===== 필수 도구 확인 =====
if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: 'git' 명령을 찾을 수 없습니다. 설치/PATH 를 확인하세요." >&2
  exit 1
fi
if ! engine_available; then
  echo "ERROR: 엔진 '$(engine_name)' 의 CLI 를 찾을 수 없습니다. 설치/PATH/로그인을 확인하세요." >&2
  exit 1
fi
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
# 처리 중 단계 표시용: 현재 phase 와 이 스크립트 PID 를 락 옆 파일에 기록
# (대시보드가 '처리 중' 표시 + 카드 단위 '중지'(프로세스 트리 종료)에 사용)
printf '%s' "${PHASE}" > "${LOCK_DIR}.phase" 2>/dev/null || true
printf '%s' "$$" > "${LOCK_DIR}.pid" 2>/dev/null || true
trap 'rmdir "${LOCK_DIR}" 2>/dev/null || true; rm -f "${LOCK_DIR}.phase" "${LOCK_DIR}.pid" 2>/dev/null || true' EXIT

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
# 카드 첨부(run-cycle 가 내려받아 CARD_IMAGES/CARD_DOCS 로 전달)를 프롬프트에 주입 → Read 도구로 인식.
IMAGE_INSTR=""
if [[ -n "${CARD_IMAGES:-}" ]]; then
  _imgs=""
  while IFS= read -r _p; do [[ -n "${_p}" ]] && _imgs+="  - ${_p}"$'\n'; done <<< "${CARD_IMAGES}"
  IMAGE_INSTR="

[이슈 첨부 이미지] 아래 파일들은 이 Jira 이슈(${ISSUE_KEY})의 설명/코멘트에 포함된 이미지입니다. 작업을 시작하기 전에 반드시 'Read' 도구로 각 파일을 열어 시각적으로 내용을 파악하고(스크린샷·다이어그램·UI 시안·오류 화면 등), 요구사항 이해와 구현에 반영하세요:
${_imgs}"
fi
DOC_INSTR=""
if [[ -n "${CARD_DOCS:-}" ]]; then
  _docs=""
  while IFS= read -r _p; do [[ -n "${_p}" ]] && _docs+="  - ${_p}"$'\n'; done <<< "${CARD_DOCS}"
  DOC_INSTR="

[이슈 첨부 문서] 아래 파일들은 이 Jira 이슈(${ISSUE_KEY})에 첨부된 문서(PDF·텍스트·스펙·코드 등)입니다. 작업을 시작하기 전에 반드시 'Read' 도구로 각 파일을 열어 내용을 파악하고, 요구사항 이해와 구현에 반영하세요:
${_docs}"
fi

if [[ "${PHASE}" == "plan" ]]; then
  echo ">> [${ISSUE_KEY}] [PLAN] 카드 검토 + 질문 코멘트 작성"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 작업을 준비 중입니다.

먼저 확인:
1. 이 이슈가 ${ASSIGNEE_NAME} (${ASSIGNEE_EMAIL}) 에게 할당되어 있는지 확인하세요.
2. 이슈가 트리거 조건(${TRIGGER_DESC})을 충족하는지 확인하세요.
3. 이슈의 현재 상태가 완료 상태(${DONE_STATUS} — 쉼표로 구분된 값 중 어느 것도) 가 아닌지 확인하세요.
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
  (이 라벨은 build 루프가 이 카드를 인식하고, plan 루프가 중복 처리하지 않도록 하는 표시입니다.)
- 마지막으로, 이 카드와 위 plan 내용에 맞는 '작업(타겟) 브랜치 이름'을 정하세요. 형식: 'feat/${ISSUE_KEY}-<영문 소문자·하이픈 슬러그>' (예: feat/${ISSUE_KEY}-add-webhook). 그리고:
  (a) Jira 이슈에 '${TARGET_BRANCH_MARK} <브랜치이름>' 형식의 코멘트를 남기세요(build 가 이 브랜치로 작업합니다).
  (b) 이슈에 '${TARGET_BRANCH_LABEL}' 라벨을 추가하세요.
  (c) 출력의 '맨 마지막 줄'에 정확히 'TARGET_BRANCH: <브랜치이름>' 한 줄을 출력하세요(시스템이 이 이름으로 원격 브랜치를 생성합니다). 코드는 작성하지 마세요."
elif [[ -n "${REWORK:-}" ]]; then
  echo ">> [${ISSUE_KEY}] [REWORK] 기존 PR 리뷰 반영 (대상 repo ${#R_URL[@]}개)${REWORK_ONLY_OWNER:+ · 대상 PR ${REWORK_ONLY_OWNER}#${REWORK_ONLY_NUM:-}}"
  REWORK_FOCUS=""
  if [[ -n "${REWORK_ONLY_OWNER:-}" && -n "${REWORK_ONLY_NUM:-}" ]]; then
    REWORK_FOCUS="[대상 PR 한정] 이번 리뷰 반영은 오직 '${REWORK_ONLY_OWNER}' 저장소의 PR #${REWORK_ONLY_NUM} 하나에만 수행하세요. 그 외 repo/PR 은 절대 건드리지 마세요.
"
  fi
  PROMPT="${REWORK_FOCUS}당신은 Jira 이슈 ${ISSUE_KEY} 의 '기존 PR'에 리뷰 피드백을 반영합니다. 새 PR/새 브랜치는 만들지 마세요.
대상 repo 들은 아래 경로에 clone 되어 있습니다(여러 repo 일 수 있음):
${REPO_LIST_TEXT}

[매우 중요] 헤드리스 1회 실행입니다. 백그라운드로 미루지 말고 이 턴 안에서 끝까지 동기 수행하세요. 오래 걸리는 테스트/빌드는 Bash 'timeout' 파라미터를 넉넉히(최대 600000ms=10분) 줘서 '포그라운드'로 실행하세요(기본 120초를 넘기면 자동 백그라운드로 넘어가 헤드리스에서 유실됨). 'Monitor'·대기 루프·waiter 로 기다리며 턴을 끝내지 마세요.

각 repo 에 대해:
1. 'gh pr list --state open --search \"${ISSUE_KEY}\"' 로 이 이슈의 열린 PR 을 찾으세요. 없으면 그 repo 는 건너뜁니다(반영 대상 아님).
2. 그 PR 의 head 브랜치를 checkout 하세요 (git fetch origin 후 해당 브랜치로).
3. 반영할 피드백을 모으세요:
   - GitHub 리뷰: 'gh pr view <번호> --comments' 및 'gh api repos/{owner}/{repo}/pulls/{번호}/comments' · '.../reviews' 의 리뷰 코멘트/스레드.
   - Jira: 이슈 ${ISSUE_KEY} 의 '최신 코멘트'(특히 담당자 ${ASSIGNEE_NAME} 가 남긴 리뷰 반영 요청).
4. 요청된 변경을 구현하세요.
5. PR 전 검증: 테스트 수단(${TEST_DESC})이 있으면 통과할 때까지 수정, 없으면 빌드(${BUILD_DESC})만 시도(수단 없으면 생략).
6. '같은 브랜치'에 커밋(메시지 하단에 '${ISSUE_KEY}' 명시) 후 'origin' 으로 push 하면 기존 PR 이 자동 갱신됩니다. (새 PR 생성 금지)
   - [브랜치 위생] base(${BASE_BRANCH}) 반영/충돌 해소가 필요하면 '절대 base 를 브랜치로 merge 하지 말고'(merge 커밋은 'Rebase and merge' 를 막습니다) 'git rebase origin/${BASE_BRANCH}' 로 rebase 한 뒤 'git push --force-with-lease' 로 갱신하세요. 브랜치에 merge 커밋을 만들지 마세요.
   - env 파일(.env 또는 복사된 env)은 절대 커밋/푸시하지 마세요.
   - push 후 'gh pr edit <번호> --body-file <파일>' 로 그 PR 의 본문을 이번 리뷰 반영까지 포함한 최신 내용으로 갱신하세요.
     ${PR_BODY_INSTR}
7. 반영 후 Jira 이슈 ${ISSUE_KEY} 에 '리뷰 반영 완료' 코멘트(반영 항목 요약 + 갱신된 PR URL)를 남기세요. 이슈 '상태는 변경하지 마세요'.
PR 을 하나도 갱신하지 못했으면(반영할 PR 없음 등) 사유를 출력하고 비정상 종료하세요.
완료 후 갱신한 PR URL 들을 출력하세요."
elif [[ -n "${RESOLVE_CONFLICT:-}" ]]; then
  echo ">> [${ISSUE_KEY}] [RESOLVE-CONFLICT] base 충돌 rebase 해소 + 재푸시${REWORK_ONLY_OWNER:+ · 대상 PR ${REWORK_ONLY_OWNER}#${REWORK_ONLY_NUM:-}}"
  CONFLICT_FOCUS=""
  if [[ -n "${REWORK_ONLY_OWNER:-}" && -n "${REWORK_ONLY_NUM:-}" ]]; then
    CONFLICT_FOCUS="[대상 PR 한정] 이번 작업은 오직 '${REWORK_ONLY_OWNER}' 저장소의 PR #${REWORK_ONLY_NUM} 하나에만 수행하세요. 그 외 repo/PR 은 절대 건드리지 마세요.
"
  fi
  PROMPT="${CONFLICT_FOCUS}당신은 Jira 이슈 ${ISSUE_KEY} 의 '기존 PR'의 base 브랜치 충돌을 'rebase'로 해소하고 같은 PR 을 갱신합니다. 새 PR/새 브랜치는 만들지 마세요.
대상 repo 들은 아래 경로에 clone 되어 있습니다(여러 repo 일 수 있음):
${REPO_LIST_TEXT}

[매우 중요] 헤드리스 1회 실행입니다. 백그라운드로 미루지 말고 이 턴 안에서 끝까지 동기 수행하세요. 오래 걸리는 테스트/빌드는 Bash 'timeout' 파라미터를 넉넉히(최대 600000ms=10분) 줘서 '포그라운드'로 실행하세요(기본 120초를 넘기면 자동 백그라운드로 넘어가 헤드리스에서 유실됨). 'Monitor'·대기 루프·waiter 로 기다리며 턴을 끝내지 마세요.

각 repo 에 대해(위 '대상 PR 한정' 이 있으면 그 PR 만):
1. 'gh pr list --state open --search \"${ISSUE_KEY}\"' 로 이 이슈의 열린 PR 을 찾으세요. 없으면 그 repo 는 건너뜁니다.
2. 그 PR 의 base·head 브랜치를 확인하세요: 'gh pr view <번호> --json baseRefName,headRefName,mergeable'.
3. 'git fetch origin' 후 그 PR 의 head 브랜치를 checkout 하세요.
4. base 최신을 반영해 충돌을 해소합니다: 'git rebase origin/<base>' 를 실행하세요.
   - 이미 base 최신이라 rebase 가 불필요하면(충돌·뒤처짐 없음) 그 사유를 출력하고 이 repo 는 '건너뜁니다'. 절대 강제 푸시하지 마세요.
   - 충돌이 나면, 각 충돌 파일을 열어 '양쪽 변경의 의도를 모두 보존'하도록 신중히 해소하세요(이 PR 의 작업 의도 + base 의 최신 변경 둘 다). 한쪽을 무성의하게 통째로 버리지 마세요. 해소한 파일마다 'git add <파일>' → 모두 처리되면 'git rebase --continue'. 남은 충돌이 없어질 때까지 반복하세요. 도저히 안전하게 해소할 수 없으면 'git rebase --abort' 후 사유를 출력하고 비정상 종료하세요(강제 푸시 금지).
5. PR 전 검증(중요): rebase 로 깨진 게 없는지 확인하세요. 테스트 수단(${TEST_DESC})이 있으면 '포그라운드'로 통과할 때까지 수정, 없으면 빌드(${BUILD_DESC})만 시도(수단 없으면 생략). 검증 실패면 사유를 출력하고 비정상 종료하세요(푸시 금지).
   - env 파일(.env 또는 복사된 env)은 절대 커밋/푸시하지 마세요.
6. 검증 통과 후에만 'git push --force-with-lease origin <head 브랜치>' 로 그 PR 의 head 브랜치를 갱신하세요(rebase 라 force 필요). '--force-with-lease' 를 쓰고, 절대 base 브랜치(예: ${BASE_BRANCH})에는 push 하지 마세요. 새 PR 은 만들지 마세요.
7. 갱신 후 Jira 이슈 ${ISSUE_KEY} 에 'base 충돌 rebase 해소 완료' 코멘트(해소한 repo/PR·검증 결과 요약 + PR URL)를 남기세요. 이슈 '상태·라벨은 바꾸지 마세요'.
충돌을 하나도 해소하지 못했으면(해소 대상 없음 등) 사유를 출력하고 비정상 종료하세요. 완료 후 갱신한 PR URL 을 출력하세요."
else
  echo ">> [${ISSUE_KEY}] [BUILD] 답변 반영 + 개발 + PR (대상 repo ${#R_URL[@]}개)"
  PROMPT="당신은 Jira 이슈 ${ISSUE_KEY} 를 아래 대상 repo 들에서 구현합니다(여러 repo 일 수 있음). 각 repo 는 표시된 경로에 clone 되어 있습니다:
${REPO_LIST_TEXT}

[매우 중요 — 실행 방식 제약] 이 작업은 대화형이 아닌 '헤드리스 1회 실행'입니다. 이 턴이 끝나면 프로세스는 즉시 종료되며, 어떤 예약된 재개도 일어나지 않습니다. 따라서:
  - 'run_in_background', 'ScheduleWakeup', 'Monitor', 'send_later', 백그라운드 프로세스('&', nohup 등), wakeup/알림 예약을 '절대' 사용하지 마세요. 이런 걸 걸고 턴을 끝내면 예약은 실행되지 않고 작업은 미완으로 유실됩니다.
  - 테스트·빌드는 반드시 '포그라운드'로 실행하고, 그 명령이 완전히 끝나 종료 코드를 받을 때까지 '그 자리에서' 기다리세요(수 분 이상 걸려도 그대로 대기). '테스트가 도는 동안 다른 일을 준비'하려 하지 말고, 결과를 받은 '뒤에야' 커밋/푸시/PR 로 진행하세요.
  - [매우 중요 — 긴 테스트/빌드 처리] Bash 도구는 기본 120초를 넘긴 명령을 '자동으로 백그라운드로' 넘깁니다. 헤드리스에서는 그 순간 작업이 유실됩니다. 그러니 오래 걸리는 테스트/빌드는 반드시 Bash 'timeout' 파라미터를 넉넉히(최대 600000ms=10분) 지정해 '포그라운드'로 한 번에 끝내세요. 명령이 이미 백그라운드로 넘어갔다면 'Monitor'·대기 루프·waiter 로 기다리지 말고, 그 백그라운드 작업을 취소한 뒤 더 큰 timeout 으로 '포그라운드에서 다시' 실행하세요.
  - 전체 스위트가 10분으로도 부족하면, 백그라운드 대기로 턴을 끝내지 말고 '변경 영향 범위의 모듈/클래스 단위'로 테스트를 좁혀 포그라운드에서 통과를 확인하세요(전체를 못 돌린 경우 그 사유를 출력).
  - 아직 끝나지 않은 백그라운드 작업이나 '나중에 확인하겠다'를 근거로 턴을 종료하지 마세요.
테스트/빌드/커밋/푸시/PR/상태전환을 모두 '이 턴 안에서 동기적으로' 끝까지 수행한 뒤 종료하세요(오래 걸려도 끝까지 대기).

[브랜치 위생 — 매우 중요] 작업 브랜치에 '절대 merge 커밋을 만들지 마세요'. base(${BASE_BRANCH})의 최신 변경을 반영하거나 base 와의 충돌을 해소할 때 'git merge origin/${BASE_BRANCH}'(= base 를 브랜치로 merge) 를 '절대 쓰지 마세요' — merge 커밋이 생기면 GitHub 의 'Rebase and merge' 가 막혀('This branch cannot be rebased due to conflicts') PR 병합이 어려워집니다. 대신 반드시 'git fetch origin && git rebase origin/${BASE_BRANCH}' 로 rebase 해서 브랜치를 base 위에 선형으로 유지하세요. rebase 중 충돌은 양쪽 의도를 보존해 해소('git add' → 'git rebase --continue')하고, '이미 원격에 push 된 브랜치를 rebase 했다면' 'git push --force-with-lease' 로 갱신하세요(아직 push 전이면 일반 push). base 브랜치 자체에는 절대 push 하지 마세요.
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
5. 구현·검증 후 — 위 '각 repo' 에 대해(변경이 필요 없는 repo 는 건너뜀). **여러 repo 를 수정했다면 repo 마다 각각 별도의 브랜치·PR 을 생성하세요(여러 repo 변경을 하나의 PR 로 합치지 말 것). PR 은 각 repo 의 origin 에 그 repo 변경만 담아 올립니다.**:
   - 해당 repo 디렉토리로 이동(cd)해서 작업하세요.
   - PR 생성 전 'gh pr list' 로 이 이슈의 PR/브랜치가 이미 있는지 확인하고, 있으면 그 repo 는 중복 생성하지 말고 건너뛰세요.
   - 작업 브랜치: plan 이 정한 '타겟 브랜치'를 사용하세요. Jira 이슈 코멘트에서 '${TARGET_BRANCH_MARK} <이름>' 을 찾아(또는 '${TARGET_BRANCH_LABEL}' 라벨 존재 여부로 판단) 그 브랜치명을 확인하고, 원격에 이미 있으니 'git fetch origin && git checkout <타겟브랜치>' 로 그 브랜치에서 작업하세요. (타겟 브랜치를 못 찾은 경우에만 feature/${ISSUE_KEY}-<짧은-설명> 를 새로 생성)
   - 명확한 메시지로 커밋(메시지 하단에 '${ISSUE_KEY}' 명시) → 'origin' 의 그 브랜치로 push.
   - gh CLI('gh pr create')로 그 repo 의 base 브랜치를 target 으로 PR 을 생성하고 PR URL 을 출력하세요. **PR 본문 맨 위에 '${TARGET_BRANCH_MARK} <타겟브랜치>' 한 줄을 반드시 포함**해 이 PR 이 그 타겟 브랜치의 PR 임을 표시하고, 생성 후 'gh pr edit <번호> --add-label ${TARGET_BRANCH_LABEL}' 로 PR 라벨을 답니다(라벨이 repo 에 없으면 'gh label create ${TARGET_BRANCH_LABEL} -c \"#22c55e\" -d \"claude 타겟 브랜치 PR\"' 로 만든 뒤 재시도, 실패해도 무방).
     ${PR_BODY_INSTR}
   - (보안) env 파일(.env 또는 복사된 env 파일)은 절대 커밋/푸시하지 마세요. 커밋 전 git status 로 확인하세요.
6. 최소 한 개 repo 에서 PR 을 생성한 뒤 마무리로:
   a) ${SUMMARY_INSTR}
      (변경한 모든 repo 의 PR URL·브랜치를 repo 별로 나열하세요.)
   b) 이슈에 '${PR_OPEN_LABEL}' 라벨을 추가하세요(= PR 올림/병합 대기 표시). 이슈 '상태는 변경하지 마세요'.
      (병합은 사람이 리뷰 후 대시보드에서 수행하며, 그때 완료 상태로 전환됩니다.)
완료 후 결과(repo별 테스트/빌드 결과 · 브랜치 · PR URL) 요약을 출력하세요."
fi

# 첨부(이미지·문서) 인식 지시를 모든 단계(plan/build/rework) 프롬프트에 공통 추가
PROMPT="${PROMPT}${IMAGE_INSTR}${DOC_INSTR}"

# ===== 실행 + 실패 재시도/백오프 처리 =====
# claude 가 0이 아닌 코드로 종료하면 실패로 보고 카드별 실패 카운터를 증가시킨다.
# (build 의 'SKIP: awaiting answers' 는 정상 종료(0)이므로 실패로 집계되지 않는다.)
STATE_DIR="${CLONE_BASE}/.state"
FAIL_FILE="${STATE_DIR}/${ISSUE_KEY}.fail"
CLAUDE_OUT="${STATE_DIR}/${ISSUE_KEY}.${PHASE}.out"
mkdir -p "${STATE_DIR}"
# 직전 실행의 완료 요약이 남아 잘못 append 되지 않도록 build 시작 전 정리
[[ "${PHASE}" == "build" ]] && rm -f "${SUMMARY_FILE}"

# claude 상세 실행 로그(도구 호출/메시지/결과)를 카드별로 영속 기록 → 대시보드에서 조회
CLAUDE_LOG_DIR="${WORK_DIR}/agent-logs"
mkdir -p "${CLAUDE_LOG_DIR}"
CLAUDE_LOG="${CLAUDE_LOG_DIR}/${ISSUE_KEY}-${PHASE}.log"
{ echo ""; echo "===== $(date -u +%FT%TZ) ${ISSUE_KEY} ${PHASE} 실행 ====="; } >> "${CLAUDE_LOG}"

# 엔진 실행: claude 는 stream-json 렌더 로그, codex/gemini 는 평문 로그로 폴백.
# 최종 결과 텍스트는 CLAUDE_OUT 으로 추출, 종료코드는 ENGINE_STATUS.
set +e
engine_exec "${PROMPT}" "${CLAUDE_LOG}" "${CLAUDE_OUT}"
[[ "${ENGINE_STATUS}" -eq 0 ]]; CLAUDE_OK=$?
set -e

# 결과 분류: PR/브랜치 추출 + 미완료 감지
PR_URL=""; BRANCH_OUT=""; ALL_PRS=""; RESULT="failed"
if [[ "${CLAUDE_OK}" -eq 0 ]]; then
  # 멀티 repo: 생성된 '모든' PR URL 수집(중복 제거, 순서 보존). 첫 번째를 대표로 사용(결과 판정·Slack).
  ALL_PRS="$(grep -oE 'https://github\.com/[^ )]+/pull/[0-9]+' "${CLAUDE_OUT}" | awk '!seen[$0]++' || true)"
  PR_URL="${ALL_PRS%%$'\n'*}"   # 첫 줄(대표 PR) — 순수 bash(파이프 SIGPIPE 회피)
  # 브랜치명: PR 의 실제 head 브랜치를 우선 사용(feat/·fix/ 등 접두사 무관). 실패 시 출력에서 접두사 포괄 추출.
  if [[ -n "${PR_URL}" ]]; then
    BRANCH_OUT="$(gh pr view "${PR_URL}" --json headRefName --jq '.headRefName' 2>/dev/null || true)"
  fi
  if [[ -z "${BRANCH_OUT}" ]]; then
    BRANCH_OUT="$(grep -oE "(feat|feature|fix|hotfix|bugfix|refactor|chore)/[A-Za-z0-9._/-]*${ISSUE_KEY}[A-Za-z0-9._/-]*" "${CLAUDE_OUT}" | head -n1 || true)"
  fi
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
  record_history_prs "${RESULT}"   # 생성된 PR 을 repo 별로 각각 이력에 기록(멀티 repo)
  # plan 성공: claude 가 정한 타겟(작업) 브랜치를 각 repo 원격에 생성(base 에서 분기). build 가 이 브랜치로 작업.
  if [[ "${PHASE}" == "plan" && "${RESULT}" == "success" ]]; then
    TARGET_BRANCH="$(grep -oE 'TARGET_BRANCH:[[:space:]]*[A-Za-z0-9._/-]+' "${CLAUDE_OUT}" | tail -n1 | sed -E 's/^TARGET_BRANCH:[[:space:]]*//' || true)"
    [[ -z "${TARGET_BRANCH}" ]] && TARGET_BRANCH="feat/${ISSUE_KEY}-work"
    for idx in "${!R_URL[@]}"; do
      rd="${CLONE_BASE}/${R_NAME[$idx]}-${ISSUE_KEY}"; rb="${R_BRANCH[$idx]}"
      [[ -d "${rd}/.git" ]] || continue
      git -C "${rd}" fetch origin --quiet 2>/dev/null || true
      if git -C "${rd}" ls-remote --exit-code --heads origin "${TARGET_BRANCH}" >/dev/null 2>&1; then
        echo ">> [${ISSUE_KEY}] (${R_NAME[$idx]}) 타겟 브랜치 이미 존재: ${TARGET_BRANCH}"
      elif git -C "${rd}" checkout -B "${TARGET_BRANCH}" "origin/${rb}" >/dev/null 2>&1 && git -C "${rd}" push -u origin "${TARGET_BRANCH}" >/dev/null 2>&1; then
        echo ">> [${ISSUE_KEY}] (${R_NAME[$idx]}) 타겟 브랜치 생성·푸시: ${TARGET_BRANCH} (base ${rb})"
      else
        echo ">> [${ISSUE_KEY}] (${R_NAME[$idx]}) 타겟 브랜치 생성 실패: ${TARGET_BRANCH}" >&2
      fi
    done
  fi
  # 완료 요약을 설명 ADF '맨 아래'에 안전 append(기존 이미지/노드 보존). label 모드 + 요약 파일 존재 시.
  if [[ "${PHASE}" == "build" && "${TRIGGER_MODE}" == "label" && -s "${SUMMARY_FILE}" ]]; then
    if command -v node >/dev/null 2>&1 && [[ -n "${JIRA_SITE:-}" && -n "${ATLASSIAN_EMAIL:-}" && -n "${ATLASSIAN_TOKEN:-}" ]]; then
      ISSUE_KEY="${ISSUE_KEY}" JIRA_SITE="${JIRA_SITE:-}" ATLASSIAN_EMAIL="${ATLASSIAN_EMAIL:-}" ATLASSIAN_TOKEN="${ATLASSIAN_TOKEN:-}" \
        node "${SELF_DIR}/append-summary.js" "${SUMMARY_FILE}" || echo ">> [${ISSUE_KEY}] 완료 내역 설명 append 실패(요약 파일 보존)" >&2
    else
      echo ">> [${ISSUE_KEY}] Jira REST 자격증명 미설정 → 완료 내역 설명 append 생략(요약: ${SUMMARY_FILE})" >&2
    fi
  fi
  if [[ "${RESULT}" == "success" || "${RESULT}" == "rework" ]]; then
    [[ "${RESULT}" == "rework" ]] && MSG="🔧 [${ISSUE_KEY}] 리뷰 반영 완료(PR 갱신)" || MSG="✅ [${ISSUE_KEY}] ${PHASE} 처리 완료"
    PR_COUNT="$(printf '%s\n' "${ALL_PRS}" | grep -c . || true)"
    if [[ "${PR_COUNT}" -gt 1 ]]; then MSG="${MSG} · PR ${PR_COUNT}건:"$'\n'"$(printf '%s\n' "${ALL_PRS}")"; else
      [[ -n "${PR_URL}" ]] && MSG="${MSG} · PR: ${PR_URL}"
      [[ -n "${BRANCH_OUT}" ]] && MSG="${MSG} · branch: ${BRANCH_OUT}"
    fi
    notify_slack "${MSG}"
    # 리뷰 반영 후 재리뷰: REVIEW_AFTER=1 이면 이어서 리뷰어(run-review.sh)를 실행해 갱신된 PR 을 다시 리뷰.
    if [[ "${REVIEW_AFTER:-}" == "1" && -f "${SELF_DIR}/run-review.sh" ]]; then
      echo ">> [${ISSUE_KEY}] 리뷰 반영 완료 → 재리뷰 시작"
      FORCE_REVIEW=1 bash "${SELF_DIR}/run-review.sh" "${ISSUE_KEY}" || echo ">> [${ISSUE_KEY}] 재리뷰 실행 실패" >&2
    fi
  fi
else
  count=$(( $(cat "${FAIL_FILE}" 2>/dev/null || echo 0) + 1 ))
  echo "${count}" > "${FAIL_FILE}"
  echo ">> [${ISSUE_KEY}] ${RESULT} (phase=${PHASE}, ${count}/${MAX_RETRIES})" >&2
  record_history "${RESULT}" "${PR_URL}" "${BRANCH_OUT}"
  if (( count >= MAX_RETRIES )); then
    echo ">> [${ISSUE_KEY}] 최대 재시도(${MAX_RETRIES}) 초과 → '${FAILED_LABEL}' 라벨 + 실패 코멘트" >&2
    ERR_TAIL="$(tail -n 25 "${CLAUDE_OUT}" 2>/dev/null || true)"
    engine_run_text "Jira 이슈 ${ISSUE_KEY} 의 자동화 처리가 ${MAX_RETRIES}회 연속 실패했습니다.
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
