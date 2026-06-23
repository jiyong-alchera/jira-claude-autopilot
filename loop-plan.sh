#!/usr/bin/env bash
#
# loop-plan.sh
# --------------------------------------------------------------------------
# 한 시간(기본)마다 plan 사이클을 실행합니다. 한 번의 사이클에서 run-cycle.js 가
# 등록된 '모든 프로젝트'를 순회하며 탐지→plan 을 수행합니다(프로젝트별 동시 상한 적용).
# - plan 대상: 트리거(claude-work) + 담당자=나 + 상태!=DEV COMPLETED + claude-planned 라벨 없음
#
# 실행:
#   ./loop-plan.sh                 # 포그라운드 (Ctrl+C 로 종료)
#   nohup ./loop-plan.sh &         # 백그라운드
#   LOOP_INTERVAL=1800 ./loop-plan.sh   # 주기를 30분으로 변경
#   RUN_ONCE=1 ./loop-plan.sh      # 즉시 1회만 실행 후 종료
# --------------------------------------------------------------------------

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERVAL="${LOOP_INTERVAL:-3600}"   # 기본 1시간
LOG="${HERE}/loop-plan.log"

echo "[$(date '+%F %T')] loop-plan 시작 (interval=${INTERVAL}s, 전 프로젝트 순회)${RUN_ONCE:+ [즉시 1회 실행]}" | tee -a "${LOG}"

while true; do
  echo "[$(date '+%F %T')] plan 사이클 시작 (모든 프로젝트)" | tee -a "${LOG}"
  node "${HERE}/run-cycle.js" plan >>"${LOG}" 2>&1 || echo "[$(date '+%F %T')] run-cycle(plan) 오류" | tee -a "${LOG}"

  # 즉시 실행 모드: 1회 처리 후 종료
  if [[ -n "${RUN_ONCE:-}" ]]; then
    echo "[$(date '+%F %T')] RUN_ONCE: plan 1회 실행 완료, 종료" | tee -a "${LOG}"
    break
  fi

  # 다음 정시(인터벌 경계)까지 정렬해서 대기
  now=$(date +%s)
  next=$(( (now / INTERVAL + 1) * INTERVAL ))
  wait_s=$(( next - now ))
  echo "[$(date '+%F %T')] 다음 실행까지 ${wait_s}s 대기 (정시 정렬)" | tee -a "${LOG}"
  sleep "${wait_s}"
done
