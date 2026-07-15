# TODO — 자동화 루프 보강 작업

자동화 루프를 더 안정적이고 운영 가능하게 만들기 위한 개선 항목입니다.
우선순위 순으로 정리되어 있으며, 각 항목은 완료 기준(AC)과 영향 파일을 포함합니다.

> ⚠️ **완료 정의 (Definition of Done) — 모든 항목 공통**
> 어떤 항목이든 구현이 끝나면 반드시:
> 1. `DOCUMENTATION.md`(및 필요 시 `README.md`, `LOOP-GUIDE.md`)를 **변경 내용에 맞게 동기화**한다.
> 2. 이 `TODO.md`의 해당 체크박스를 `[x]`로 갱신하고, 변경 요약/PR 링크를 항목 아래 한 줄로 남긴다.
> 3. 문서 동기화가 안 된 변경은 "완료"로 간주하지 않는다.
> (이 규칙은 `CLAUDE.md`에도 명시되어, 개발을 수행하는 Claude가 자동으로 따릅니다.)

---

## 높은 우선순위 — 안정성·정확성

- [x] **1. 멱등성 가드 (중복 PR/브랜치 방지)**
  - 내용: build 중간 실패(예: 상태 전환 실패) 후 재시도 시 동일 이슈에 중복 브랜치/PR이 생기지 않도록 가드.
  - AC: build 시작 시 해당 이슈 키로 열린 PR/원격 브랜치가 있으면 새로 만들지 않고 기존 것을 재사용하거나 스킵.
  - 영향: `run-jira-agent.sh` (build 프롬프트/사전 점검)
  → (완료 2026-06-23) build 단계 claude 실행 전 `git ls-remote feature/<KEY>-*` + `gh pr list --search <KEY>` 점검, 존재 시 `SKIP: 이미 처리됨` 출력 후 종료.

- [x] **2. 실패 처리·재시도 정책**
  - 내용: 실패한 카드가 매 주기 무한 재시도되지 않도록 처리.
  - AC: 실패 시 `claude-failed` 라벨 부여 + 실패 사유를 카드 코멘트로 기록 + N회 초과 시 탐지에서 제외(백오프).
  - 영향: `run-jira-agent.sh`, `detect-cards.sh`(JQL에 `claude-failed` 제외)
  → (완료 2026-06-23) 카드별 실패 카운터(`repos/.state/<KEY>.fail`) + `MAX_RETRIES`(기본 3) 초과 시 claude 로 `claude-failed` 라벨 + 담당자 멘션 실패 코멘트(오류 로그 요약). detect JQL 양쪽에 `claude-failed` 제외 추가. server.js 에 `failedLabel`/`maxRetries` 주입.

- [x] **3. clone 디렉토리 클린업**
  - 내용: 카드별 dir 재사용 시 이전 잔여 변경/브랜치로 checkout이 꼬이는 문제 방지.
  - AC: build 시작 시 `git reset --hard` + `git clean -fd` 후 base 브랜치로 정렬.
  - 영향: `run-jira-agent.sh`
  → (완료 2026-06-23) `fetch --prune` → `reset --hard` + `clean -fd` → base checkout → `reset --hard origin/<base>` 로 결정적 정렬(`git pull` 대체). plan/build 공통 적용.

- [x] **4. env 유출 방지 강화**
  - 내용: `work.env`가 대상 repo로 커밋되는 사고를 구조적으로 차단.
  - AC: env 복사 직후 clone의 `.git/info/exclude`에 env 파일명을 자동 추가(프롬프트 의존 제거).
  - 영향: `run-jira-agent.sh`
  → (완료 2026-06-23) env 복사 직후 `.git/info/exclude` 에 env 파일명·`.env` 를 멱등 등록(grep -qxF 중복 방지). repo `.gitignore` 와 무관한 로컬 전용 차단.

- [x] **5. 탐지 로직 REST 전환**
  - 내용: detect를 `claude` 호출 대신 백엔드 Jira REST로 전환(빠르고 결정적, 비용 절감).
  - AC: 대시보드/루프가 Jira REST로 plan/build 후보를 조회. claude 기반 detect는 폴백으로만.
  - 영향: `dashboard/server.js`(`/api/detect`), 루프가 백엔드/REST 사용
  → (완료 2026-06-23) server.js 에 `/api/detect/:mode`(detect-cards.sh 와 동일 JQL) 추가, scriptEnv 가 `DASHBOARD_URL` 주입. detect-cards.sh 가 `DASHBOARD_URL` 있으면 `curl /api/detect/<mode>` 우선, 실패 시 claude(+MCP) 폴백.

---

## 중간 우선순위 — 운영 편의

- [x] **6. 알림(Notification)**
  - 내용: PR 생성/완료/실패 시 Slack(또는 이메일) 알림.
  - AC: 설정한 웹훅으로 이벤트별 메시지 발송. 미설정 시 무시.
  - 영향: `run-jira-agent.sh` 또는 백엔드, 설정 추가
  → (완료 2026-06-23) Slack Incoming Webhook 지원. `run-jira-agent.sh` 가 `SLACK_WEBHOOK_URL` 있으면 처리 완료(success)/최대재시도 실패 시 Slack 메시지 발송, 미설정 시 스킵. credentials.json 에 `slackWebhookUrl`(마스킹) 저장 + server.js 주입 + 대시보드 자격증명에 입력 필드. 연결 테스트 200 OK 확인. (이메일은 추후)

- [x] **7. 답변 감지 명시적 신호**
  - 내용: "담당자 답변 여부"를 claude 판단에만 의존하지 않도록 명시적 신호 도입.
  - AC: 담당자가 다는 `claude-answered` 라벨 또는 "bot 질문 이후 담당자 코멘트 존재"를 build 진입 조건으로 사용.
  - 영향: `detect-cards.sh`(build JQL), `run-jira-agent.sh`
  → (완료 2026-06-23) 이중 게이트로 구현: 둘 다 있어야 build 진입. ① 탐지 게이트 — build JQL/`/api/detect` 에 `labels = "claude-answered"` 추가, ② 실행 게이트 — build 프롬프트가 `claude-answered` 라벨 + 담당자 실제 답변 코멘트를 모두 확인(하나라도 없으면 SKIP). plan 프롬프트가 담당자에게 라벨 추가를 안내. server.js `answeredLabel` 주입, 대시보드 카드 단계에 `awaiting-answer`(+`failed`) 배지 추가. `ANSWERED_LABEL` 환경변수 추가.

- [x] **8. 루프 영속성·상태 일관성**
  - 내용: 재부팅/크래시 후 자동 재시작, 대시보드 상태와 실제 프로세스 일치.
  - AC: launchd/pm2 등록 가이드 + pid를 디스크(pidfile)에 기록해 백엔드 재시작 후에도 상태 정확.
  - 영향: `dashboard/server.js`, 운영 문서
  → (완료 2026-06-23) 루프 시작 시 `loop-<type>.pid` 에 pid 기록. status/stop 이 pidfile 을 단일 진실로 사용 → 백엔드 재시작 후 복구(시작 로그 보고), stale pidfile 자동 정리, stop 은 프로세스 그룹째 종료. DOCUMENTATION 7.4 에 launchd/pm2 자동 재시작 가이드 추가. `loop-*.pid` gitignore 등록.

- [x] **9. 병렬 처리 상한**
  - 내용: 매칭 카드가 많을 때 claude 프로세스 과다 생성 방지.
  - AC: 동시에 처리하는 카드 수 상한(예: 3) 적용.
  - 영향: `loop-plan.sh`, `loop-build.sh`
  → (완료 2026-06-23) `MAX_PARALLEL`(기본 3) 도입. 두 루프가 카드 실행 전 `jobs -rp` 로 실행 중 작업 수를 확인해 상한 미만이 될 때까지 대기. server.js `maxParallel` 주입 + 대시보드 "동시 처리 상한" 입력 필드.

---

## 낮은 우선순위 — 품질 향상

- [x] **10. PR 품질** (테스트/빌드 검증 — 사용자 요청 범위로 한정 구현)
  - 내용: 테스트/린트 통과 후 PR, 리뷰어·라벨 지정, Jira↔PR 양방향 링크(remote link).
  - AC: 프로젝트별 test/lint 명령 설정 시 PR 전에 실행, 실패하면 PR 보류. PR에 Jira 링크 부착.
  - 영향: `run-jira-agent.sh`, 설정 추가
  → (완료 2026-06-23) build 프롬프트에 PR 전 검증 단계 추가: 테스트 수단(`TEST_CMD` 또는 자동 감지)이 있으면 통과할 때까지 수정 반복(불가 시 PR 없이 종료), 없으면 빌드/컴파일(`BUILD_CMD` 또는 자동 감지)만 시도(수단 없으면 건너뜀). server.js `testCmd`/`buildCmd` 주입 + 대시보드 입력 필드. 리뷰어·라벨·Jira↔PR 양방향 링크는 범위에서 제외(추후).

- [x] **11. 처리 이력(History)**
  - 내용: 처리한 카드/시각/결과/PR URL 기록.
  - AC: JSON 이력 파일 + 대시보드에 이력 표.
  - 영향: `dashboard/server.js`, `dashboard/public/index.html`
  → (완료 2026-06-23) `run-jira-agent.sh` 가 매 실행 결과(성공/스킵/스킵-중복방지/실패 + PR·브랜치)를 `history.jsonl`(JSONL)에 기록. server.js `/api/history`(최신순) + `HISTORY_FILE` 주입, 대시보드에 처리 이력 표(4초 갱신) 추가. `history.jsonl` gitignore 등록.

- [x] **12. 트리거 정밀도**
  - 내용: `text ~ "claude-work"`의 토큰화 오탐 가능성 제거.
  - AC: 텍스트 대신 전용 라벨(예: `claude-work`)을 트리거로 사용하는 옵션 제공.
  - 영향: `detect-cards.sh`, 문서
  → (완료 2026-06-23) `TRIGGER_MODE`(label|text, 기본 **label**) + `TRIGGER_LABEL`(기본 `claude-work`) 도입. detect-cards.sh/server.js JQL·/api/cards 가 모드별 트리거 절 사용, run-jira-agent.sh plan 조건/완료 요약(label 모드는 코멘트)도 모드 대응. 대시보드에 트리거 방식 선택 + 라벨 입력 추가. text 모드는 레거시로 유지.

---

*완료된 항목은 위 "완료 정의"에 따라 체크 표시 + 문서 동기화 후 마감합니다.*
