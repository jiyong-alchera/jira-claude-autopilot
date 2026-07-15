#!/usr/bin/env bash
#
# lib-engine.sh — LLM 엔진 추상화(공통 헬퍼)
# --------------------------------------------------------------------------
# 헤드리스 개발/리뷰/탐지에 쓰는 CLI 를 엔진별로 추상화한다. run-jira-claude.sh /
# run-review.sh / detect-cards.sh 가 source 해서 사용한다.
#
# 사용 env:
#   ENGINE   claude | codex | gemini   (기본: claude)
#   MODEL    엔진에 넘길 모델명(비우면 엔진 기본값)
#   CODEX_CMD / GEMINI_CMD   설치 버전별 플래그가 다를 때 명령 자체를 덮어쓰기 위한 훅
#            (예: CODEX_CMD="codex exec". 프롬프트는 마지막 인자로 append 된다.)
#
# 제공 함수:
#   engine_name              현재 엔진명(소문자) 출력
#   engine_available [eng]   해당(또는 현재) 엔진 CLI 가 PATH 에 있으면 0
#   engine_run_text <prompt> 최종 텍스트만 stdout 으로(탐지 등 경량 용도)
#   engine_exec <prompt> <log> <out>
#            실행 과정을 <log> 에, 최종 텍스트를 <out> 에 기록. 종료코드는 ENGINE_STATUS.
#            claude 는 stream-json + render-claude-stream.js 로 사람이 읽는 로그를 남기고,
#            codex/gemini 는 평문 로그로 폴백한다.
# --------------------------------------------------------------------------

# 렌더러 위치(각 스크립트가 SELF_DIR 을 정의해 두면 그걸 쓴다)
: "${SELF_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

engine_name() { printf '%s' "${ENGINE:-claude}"; }

# 엔진별 실행 명령을 배열로 구성해 전역 _ENGINE_CMD 에 담는다(프롬프트는 호출부에서 append).
# 모델 플래그까지 포함. 알 수 없는 엔진이면 1 반환.
_engine_build_cmd() {
  local engine="${ENGINE:-claude}" model="${MODEL:-}"
  _ENGINE_CMD=()
  case "${engine}" in
    claude)
      _ENGINE_CMD=(claude -p)
      [[ -n "${model}" ]] && _ENGINE_CMD+=(--model "${model}")
      ;;
    codex)
      if [[ -n "${CODEX_CMD:-}" ]]; then read -r -a _ENGINE_CMD <<< "${CODEX_CMD}"; else _ENGINE_CMD=(codex exec); fi
      [[ -n "${model}" ]] && _ENGINE_CMD+=(-m "${model}")
      ;;
    gemini)
      if [[ -n "${GEMINI_CMD:-}" ]]; then read -r -a _ENGINE_CMD <<< "${GEMINI_CMD}"; else _ENGINE_CMD=(gemini); fi
      [[ -n "${model}" ]] && _ENGINE_CMD+=(-m "${model}")
      _ENGINE_CMD+=(-p)
      ;;
    *)
      return 1
      ;;
  esac
  return 0
}

engine_available() {
  local engine="${1:-${ENGINE:-claude}}"
  case "${engine}" in
    claude) command -v claude >/dev/null 2>&1 ;;
    codex)  command -v "${CODEX_CMD%% *}"  >/dev/null 2>&1 || command -v codex  >/dev/null 2>&1 ;;
    gemini) command -v "${GEMINI_CMD%% *}" >/dev/null 2>&1 || command -v gemini >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

# 최종 텍스트만 stdout 으로 흘린다(탐지 폴백처럼 파이프 뒷단에서 grep 하는 용도).
engine_run_text() {
  local prompt="$1"
  _engine_build_cmd || { echo "ERROR: 알 수 없는 엔진 '${ENGINE:-}'" >&2; return 3; }
  "${_ENGINE_CMD[@]}" "${prompt}"
}

# 실행 과정을 log 에, 최종 텍스트를 out 에 기록. 종료코드는 전역 ENGINE_STATUS.
engine_exec() {
  local prompt="$1" logf="$2" outf="$3"
  local engine="${ENGINE:-claude}"
  local renderer="${SELF_DIR}/render-claude-stream.js"
  ENGINE_STATUS=1
  _engine_build_cmd || { echo "ERROR: 알 수 없는 엔진 '${engine}'" >&2; ENGINE_STATUS=3; return 3; }

  if [[ "${engine}" == "claude" ]] && command -v node >/dev/null 2>&1 && [[ -f "${renderer}" ]]; then
    # Claude: stream-json → 사람이 읽는 렌더 로그 + 최종 텍스트
    "${_ENGINE_CMD[@]}" "${prompt}" --output-format stream-json --verbose 2>>"${logf}" \
      | node "${renderer}" "${logf}" \
      | tee "${outf}"
    local ps=("${PIPESTATUS[@]}")
    local cs="${ps[0]:-1}" rs="${ps[1]:-0}"
    [[ "${cs}" -eq 0 && "${rs}" -eq 0 ]]; ENGINE_STATUS=$?
  else
    # 비-Claude(또는 렌더러 부재): 평문 로그로 폴백
    "${_ENGINE_CMD[@]}" "${prompt}" 2>&1 | tee "${outf}"
    ENGINE_STATUS=${PIPESTATUS[0]}
    cat "${outf}" >> "${logf}" 2>/dev/null || true
  fi
  return "${ENGINE_STATUS}"
}
