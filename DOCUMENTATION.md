# jira-claude-autopilot — 프로젝트 문서

Jira 카드를 자동으로 탐지해 **Claude가 개발 → PR 생성 → 카드 완료처리**까지 반자동으로 수행하는
루프 자동화 도구와, 이를 설정·제어·모니터링하는 로컬 웹 대시보드에 대한 상세 문서입니다.

> 이 문서는 "어떻게 동작하는가(구현)"와 "어떻게 쓰는가(사용)"를 함께 다룹니다.
> 빠르게 쓰기만 할 거면 [빠른 시작](#6-빠른-시작)부터, 원리를 알고 싶으면 [동작 흐름](#3-동작-흐름과-상태-머신)부터 보세요.

---

## 목차

1. [개요](#1-개요)
2. [전체 아키텍처](#2-전체-아키텍처)
3. [동작 흐름과 상태 머신](#3-동작-흐름과-상태-머신)
4. [구성 요소 상세](#4-구성-요소-상세)
5. [설정 레퍼런스](#5-설정-레퍼런스)
6. [빠른 시작](#6-빠른-시작)
7. [사용법](#7-사용법)
8. [인증 구조](#8-인증-구조)
9. [파일 구조](#9-파일-구조)
10. [보안](#10-보안)
11. [트러블슈팅](#11-트러블슈팅)
12. [알려진 한계와 향후 개선](#12-알려진-한계와-향후-개선)

---

## 1. 개요

### 무엇을 하는가

전용 트리거 라벨(`claude-work`, 기본 label 모드)이 붙고 본인에게 할당된 Jira 카드를 주기적으로 찾아서,
두 단계로 자동 처리합니다.

- **plan 단계**: Claude가 카드와 코드베이스를 검토하고, 구현 전에 필요한 질문을 카드에 코멘트로 남깁니다.
- **build 단계**: 담당자의 답변을 반영해 실제로 코드를 작성하고, 브랜치 생성 → 커밋 → 푸시 → PR 생성 →
  카드에 완료 요약을 남기고 카드 상태를 완료로 바꿉니다.

사람은 "카드를 만들고(`claude-work` 라벨을 붙이고)", "질문에 답하는" 두 가지만 하면 됩니다.

### 특징

- **멀티 프로젝트**: 여러 프로젝트(각자 repo·Jira·자격증명)를 동시에 등록·운용하며, 한 루프가 매 주기 모든 프로젝트를 순회합니다.
- **범용**: 특정 repo·Jira 프로젝트에 묶이지 않습니다. 설정만 바꾸면 어떤 GitHub repo / Jira 프로젝트에도 재사용됩니다.
- **병렬**: 카드마다 독립된 clone 디렉토리에서 동시에 처리됩니다.
- **사람 개입 지점이 명확**: plan(질문) ↔ build(개발) 사이에 사람의 답변이 들어갑니다.
- **로컬 전용 대시보드**: 설정·토큰·실행·로그·카드 상태·env 편집을 웹 UI에서 관리합니다.

---

## 2. 전체 아키텍처

```
┌──────────────────────────────────────────────────────────────┐
│  대시보드 (로컬 웹, http://localhost:4317)                     │
│  ┌───────────────┐        ┌──────────────────────────────┐    │
│  │ React 프론트   │ <───>  │ Express 백엔드 (server.js)    │    │
│  │ (index.html)  │  REST  │  - config/credentials 저장    │    │
│  └───────────────┘        │  - 루프 start/stop/status     │    │
│                           │  - 로그 tail                  │    │
│                           │  - Jira REST 카드 조회        │    │
│                           │  - work.env 읽기/쓰기         │    │
│                           └───────────────┬──────────────┘    │
└───────────────────────────────────────────│──────────────────┘
                                  환경변수 주입 + 프로세스 spawn
                                             ▼
        ┌──────────────────────────────────────────────────┐
        │  셸 루프 (백그라운드 프로세스)                      │
        │  loop-plan.sh ──┐                                  │
        │  loop-build.sh ─┤── 주기마다 detect-cards.sh 호출  │
        │                 └── 카드별 run-jira-claude.sh 실행 │
        └───────────────────────────┬──────────────────────┘
                                     ▼
        ┌──────────────────────────────────────────────────┐
        │  run-jira-claude.sh (카드 1개 처리)                │
        │   git clone/checkout → env 복사 → claude -p 실행   │
        └───────────┬───────────────────────┬──────────────┘
                    ▼                        ▼
            ┌──────────────┐         ┌───────────────┐
            │ Claude Code   │         │ git / gh      │
            │ (+Atlassian   │         │ (clone/push/  │
            │  MCP, Jira)   │         │  PR)          │
            └──────────────┘         └───────────────┘
```

핵심 분업:
- **셸 스크립트**는 git 준비(clone/checkout/env 복사)와 오케스트레이션만 담당.
- **실제 개발과 Jira 상호작용**은 `claude -p`(Claude Code 헤드리스)가 수행.
- **대시보드**는 셸을 직접 구동하지 않고, 환경변수로 설정을 주입해 루프 프로세스를 띄우고 모니터링.

---

## 3. 동작 흐름과 상태 머신

카드는 라벨과 상태를 통해 단계가 구분됩니다.

```
[신규 카드]  담당자=나 + claude-work 라벨 + 상태≠DEV COMPLETED + claude-planned 라벨 없음
      │
      │  loop-plan 이 탐지 → run-jira-claude.sh <KEY> plan
      │     · Claude가 카드/코드 검토
      │     · 구현 전 질문을 카드 코멘트로 작성 (담당자 멘션)
      │     · 카드에 'claude-planned' 라벨 추가
      ▼
[plan 완료]  claude-planned 라벨 있음
      │
      │  (사람) 담당자가 카드에서 질문에 답변 + 'claude-answered' 라벨 추가
      │
      │  loop-build 가 탐지(claude-planned AND claude-answered) → run-jira-claude.sh <KEY> build
      │     · build 진입 게이트(둘 다 필요): (a) 'claude-answered' 라벨, (b) 담당자 실제 답변 코멘트
      │       → 하나라도 없으면 'SKIP: awaiting answers' 출력 후 종료 (다음 주기 재시도)
      │     · 둘 다 있으면:
      │         - 코드 구현
      │         - feature/<KEY>-... 브랜치 생성 → 커밋(메시지에 KEY) → push
      │         - base 브랜치 대상 PR 생성
      │         - 완료 요약 기입(label 모드: 설명 맨 아래 '## 완료 내역' / text 모드: 트리거 텍스트 바로 위)
      │         - 카드 상태를 DEV COMPLETED 로 전환
      ▼
[완료]  상태 카테고리 Done 또는 DONE_STATUS → JQL `statusCategory != Done AND status != "<DONE_STATUS>"` 로 두 루프에서 자동 제외
```

상태 구분에 쓰이는 신호:

| 신호 | 의미 | 누가 설정 |
|------|------|-----------|
| `claude-work` 라벨(기본) 또는 트리거 텍스트(레거시) | 자동화 대상 카드 | 사람(또는 Claude가 카드 작성 시) |
| `claude-planned` 라벨 | plan 완료(질문 작성됨) | plan 단계의 Claude |
| `claude-answered` 라벨 | 담당자 답변 완료 명시 신호(build 진입 게이트 ①) | 사람(담당자) |
| 담당자 답변 코멘트 | 실제 답변 존재(build 진입 게이트 ②) | 사람(담당자) |
| 완료(상태 카테고리 Done 또는 `DONE_STATUS` 이름) | 처리 완료, 탐지 제외 | build 단계의 Claude/사람 |
| `claude-failed` 라벨 | 연속 실패 N회 초과 → 탐지 제외(수동 확인 필요) | 실패 처리 로직(Claude) |
| 처리 락(`repos/.state/<KEY>.lock`(plan/build) · `<KEY>.review.lock`(review) + `.phase`/`.pid`) | 해당 카드 **처리 중**(phase·스크립트 PID 기록 → 대시보드 '중지'에 사용). 대시보드는 두 락을 모두 인식해 build/plan·review 작업 모두 '처리 중' 표시·중지 가능 | run-jira-claude.sh / run-review.sh(시작 시 생성, 종료 시 trap 으로 제거) |
| `repo_<name>` 라벨 | 카드의 대상 repo(여러 개 가능) | 사람/대시보드(카드 등록 시) |

이 설계의 핵심 효과:
- **plan 중복 방지**: 라벨이 붙으면 plan 탐지 JQL에서 제외됨.
- **답변 대기(이중 게이트)**: `claude-answered` 라벨이 없으면 detect JQL에서 build 후보로 잡히지 않고(탐지 게이트), 라벨이 있어도 실제 답변 코멘트가 없으면 build가 스스로 SKIP(실행 게이트) → 다음 주기 재시도.
- **완료 제외**: 상태가 완료로 바뀌면 두 루프 모두에서 빠짐.

---

## 4. 구성 요소 상세

### 4.1 run-jira-claude.sh (카드 1개 처리)

카드 하나를 plan 또는 build로 처리하는 핵심 스크립트. **카드는 여러 repo 를 대상으로 할 수 있다**(`CARD_REPOS`): 스크립트가 각 repo 를 `<name>-<KEY>` 디렉토리에 clone 하고, plan 은 모든 repo 를 검토해 질문, build 는 **변경이 필요한 repo 마다 각각 별도의 브랜치·PR 을 만든다**(여러 repo 변경을 하나의 PR 로 합치지 않음, 완료 요약에 repo별 PR 나열). 생성된 **모든 PR 은 처리 이력에 repo별로 개별 기록**된다(각 행에 그 PR URL·head 브랜치).

사용: `REPO_URL=... ./run-jira-claude.sh <ISSUE-KEY> <plan|build>`

처리 순서:
1. 설정을 환경변수에서 읽음(없으면 기본값). `REPO_URL`은 필수 — 없으면 에러 종료.
2. `REPO_NAME`을 `REPO_URL`에서 자동 도출. 작업 디렉토리는 `CLONE_BASE/<REPO_NAME>-<ISSUE_KEY>`.
3. 디렉토리가 없으면 `git clone`, 있으면 재사용.
4. `fetch --prune` 후 **클린업**(`git reset --hard` + `git clean -fd`) → `BASE_BRANCH` checkout → `git reset --hard origin/<BASE_BRANCH>` 로 정렬. dir 재사용 시 이전 잔여 변경/브랜치로 checkout 이 막히는 문제를 방지(`git pull` 대신 결정적 정렬).
5. `ENV_SRC`(기본 `work.env`)를 clone 디렉토리로 복사하고, **clone 의 `.git/info/exclude` 에 env 파일명과 `.env` 를 자동 등록**해 추적/커밋을 구조적으로 차단(프롬프트 의존 제거, repo 에 커밋되지 않는 로컬 전용 ignore).
6. clone 디렉토리로 `cd` 후 `claude -p "<프롬프트>"` 실행.
   - **카드 첨부 이미지 인식**: `run-cycle` 가 카드 실행 전 이슈의 이미지 첨부를 Basic auth 로 내려받아(`<CLONE_BASE>/.state/<KEY>.images/`, 최대 `MAX_CARD_IMAGES`=10장) 경로를 `CARD_IMAGES` 로 넘긴다. 스크립트가 plan/build/rework **모든 프롬프트에 "이미지를 `Read` 도구로 열어 시각 인식하고 반영하라"** 블록을 공통 주입 → Claude 가 스크린샷·다이어그램·UI 시안 등을 추론에 활용한다(텍스트만이 아니라).
   - **plan 프롬프트**: 담당자·트리거(`claude-work` 라벨 또는 텍스트)·상태 조건을 먼저 확인하고, 충족 시 질문 코멘트 작성 + `claude-planned` 라벨 추가. 이어 **카드+plan 내용에 맞는 '타겟(작업) 브랜치' 이름**(`feat/<KEY>-<슬러그>`)을 정해 Jira 코멘트(`🌿 타겟 브랜치: <이름>`)+`claude-branched` 라벨로 남기고 `TARGET_BRANCH: <이름>` 을 출력한다. **plan 성공 후 스크립트가 그 브랜치를 각 repo 원격에 base 에서 분기·push** 한다(build 가 이 브랜치로 작업). 못 파싱하면 `feat/<KEY>-work` 폴백.
   - **build 프롬프트**: 진입 게이트(둘 다 필요) — (a) `claude-answered` 라벨, (b) 담당자 실제 답변 코멘트 — 하나라도 없으면 `SKIP: awaiting answers`. 통과 시 구현 → **PR 전 검증** → 브랜치/커밋/푸시 → PR → 완료 요약 작성 → 상태 전환. env 파일은 절대 커밋 금지 지시 포함. **작업 브랜치는 plan 이 만든 타겟 브랜치**(코멘트 `🌿 타겟 브랜치:` 또는 `claude-branched` 라벨로 인식)를 checkout 해 사용하고(없으면 `feature/<KEY>-…` 폴백), PR 은 base 로 올리되 **본문 맨 위에 `🌿 타겟 브랜치: <이름>` 표시 + PR 에 `claude-branched` 라벨**을 달아 타겟 브랜치 PR 임을 인식 가능하게 한다.
     - **PR 본문(개발 설명)**: PR 생성 시 구조화된 한국어 개발 설명을 `--body-file` 로 작성한다 — `## 개요`(+ Jira 카드 링크/이슈 키) · `## 변경 사항`(무엇을·왜) · `## 구현 상세` · `## 테스트/검증`(실행 명령·결과) · `## 리뷰 포인트/주의사항`. 본문 템플릿(`PR_BODY_INSTR`)은 build·rework 가 공유한다.
     - **완료 요약(label 모드)**: claude 는 **Jira 설명을 직접 수정하지 않고** 요약(변경 내용·PR·브랜치·완료 일시)을 markdown 으로 `SUMMARY_FILE`(`<CLONE_BASE>/.state/<KEY>.summary.md`)에 저장만 한다. build 성공 후 **`append-summary.js` 가 설명 ADF 를 직접 GET → 기존 노드(특히 붙여넣은 이미지 media)를 그대로 둔 채 맨 아래에 `---`+`## 완료 내역`+요약을 append → PUT** 한다(`mdToADF` 로 제목/불릿/표/링크 서식 보존). 재실행 시 기존 '완료 내역' 섹션은 제거 후 재추가(idempotent). **markdown↔ADF 왕복으로 설명을 통째로 다시 쓰면 본문 이미지가 깨지던 문제를 근본 차단.** (text 모드(레거시)는 종전대로 claude 가 트리거 텍스트 위에 작성)
     - **머지 시점 최종 갱신**: build 완료 내역은 리뷰/rework 로 PR 이 바뀌면 실제 병합 내용과 어긋날 수 있으므로, **PR 병합(수동·개별·외부 병합 자동 감지) 으로 카드가 완료될 때** 백엔드가 **병합된 PR 들의 최종 본문(rework 시 갱신됨)으로 '완료 내역'을 다시 작성**한다(`finalizeCardDone` → `appendCompletionSummary`, 기존 섹션 교체·이미지 보존·병합 일시 포함). 즉 카드의 완료 내역은 항상 최종 머지 기준으로 유지된다.
   - **PR 전 검증(#10)**: 테스트 수단(`TEST_CMD` 또는 자동 감지)이 있으면 실행하고 **통과할 때까지 수정 반복**(불가 시 PR 없이 비정상 종료). 테스트가 없으면 빌드/컴파일(`BUILD_CMD` 또는 자동 감지)만 시도(빌드 수단도 없으면 건너뜀). 검증 통과 시에만 PR 단계로 진행.
   - **멱등성 가드(build 전용)**: claude 실행 전에 `git ls-remote` 로 `feature/<KEY>-*` 원격 브랜치를, `gh pr list` 로 해당 이슈 키의 열린 PR 을 점검한다. 하나라도 있으면 `SKIP: 이미 처리됨` 을 출력하고 종료해 중복 브랜치/PR 생성을 막는다(중간 실패 후 재시도 안전).
7. **실패 재시도/백오프(plan·build 공통)**: claude 가 0이 아닌 코드로 종료하면 실패로 보고 카드별 실패 카운터(`<CLONE_BASE>/.state/<KEY>.fail`)를 증가시킨다. `MAX_RETRIES`(기본 3) 초과 시 claude 로 `claude-failed` 라벨 추가 + 담당자 멘션 실패 코멘트(마지막 오류 로그 요약 포함)를 남긴다. 성공하면 카운터를 리셋한다. build 의 `SKIP: awaiting answers` 는 정상 종료(0)라 실패로 집계되지 않는다.

매 실행 종료 시 결과(성공/스킵/실패 + PR URL·브랜치)를 `HISTORY_FILE`(기본 `history.jsonl`)에 JSONL 로 기록한다. **성공/rework 시 생성된 PR 이 여러 개면(멀티 repo) PR 마다 한 줄씩** 기록해 처리 이력에 개별 행으로 보이게 한다(PR 없는 skip 은 1줄). **브랜치명은 각 PR URL 로 `gh pr view --json headRefName` 을 조회해 PR 의 실제 head 브랜치를 사용**하므로 `feat/`·`fix/` 등 접두사에 무관하게 정확히 기록된다(조회 실패 시 claude 출력에서 접두사 포괄 추출로 폴백). 대시보드 병합(`/api/cards/:key/merge`)도 동일하게 병합된 PR 의 head 브랜치를 이력에 남긴다.

**claude 상세 실행 로그(#관찰성)**: claude 를 `--output-format stream-json --verbose` 로 실행하고 `render-claude-stream.js` 로 사람이 읽는 전사(🔧 도구 호출·💬 메시지·↳ 도구 결과·✅ 결과)를 카드별 `claude-logs/<KEY>-<phase>.log` 에 라이브 기록한다. 최종 결과 텍스트는 별도로 추출해 기존 SKIP/PR 파싱·성공/실패 판정에 사용한다(자동화 동작에는 영향 없음). node/렌더러가 없으면 기존 텍스트 모드로 폴백. 대시보드 카드 상세에서 "Claude 실행 로그"로 조회(3초 갱신).

**Slack 알림(#6)**: `SLACK_WEBHOOK_URL` 이 설정돼 있으면 카드가 처리 완료(success)될 때 `✅ [KEY] phase 처리 완료 · PR · branch` 메시지를, 최대 재시도 초과 실패 시 `❌ … 수동 확인 필요` 메시지를 Slack 으로 보낸다. 미설정이면 알림은 스킵된다(스킵/답변대기 케이스는 알리지 않음).

도구 의존성: `git`, `claude` (build 단계는 추가로 `gh`).

### 4.2 detect-cards.sh (대상 카드 탐지)

처리 대상 카드 키만 한 줄에 하나씩 출력. **`DASHBOARD_URL` 이 주입되어 있으면 백엔드 `/api/detect/<mode>`(Jira REST)를 우선 호출**해 결정적·저비용으로 탐지하고, 실패 시 `claude`(+Atlassian MCP) JQL 실행으로 폴백한다.

- 트리거 절은 모드에 따라: label 모드(기본) `labels = "claude-work"`, text 모드(레거시) `text ~ "claude-work"`.
- 완료 제외는 `statusCategory != Done AND status != "<DONE_STATUS>"`(단일) 또는 `status NOT IN ("A","B")`(복수) — 상태 카테고리(Done)와 설정 완료 상태명 둘 다로 제외(워크플로마다 완료 상태의 카테고리가 다른 경우 대비). **완료 상태명은 쉼표로 여러 개 지정 가능**하며, **첫 번째가 병합 시 전환 대상(주 완료 상태)**, 전체가 탐지 제외·'완료' 단계 판정에 쓰인다.
- **plan 대상 JQL**(label 모드): `assignee = currentUser() AND statusCategory != Done AND status != "DEV COMPLETED" AND labels = "claude-work" AND (labels != "claude-planned" OR labels IS EMPTY) AND (labels != "claude-failed" OR labels IS EMPTY)`
- **build 대상 JQL**(label 모드): `assignee = currentUser() AND statusCategory != Done AND status != "DEV COMPLETED" AND labels = "claude-work" AND labels = "claude-planned" AND labels = "claude-answered" AND (labels != "claude-failed" OR labels IS EMPTY)`
- build 후보는 `claude-planned` **그리고** `claude-answered` 라벨이 둘 다 있어야 한다(담당자 답변 완료 신호).
- 두 JQL 모두 `claude-failed` 라벨이 붙은(반복 실패) 카드를 제외해 무한 재시도를 막는다.
- `PROJECT_KEY`가 설정되면 `AND project = "<KEY>"` 필터 추가.
- claude 출력에서 `이슈키(PROJ-숫자)` 패턴만 추출해 잡텍스트를 제거.

### 4.3 loop-plan.sh / loop-build.sh / loop-review.sh (주기 루프)

- 시작 즉시 1회 사이클 후, 이후 **인터벌 경계(정시)에 정렬**해 반복.
- 한 사이클은 `run-cycle.js <plan|build|review>`가 **등록된 모든 프로젝트를 순회**하며 프로젝트별로 detect→처리(`run-jira-claude.sh` / review 는 `run-review.sh`)를 실행한다. 동시 실행은 **프로젝트별 `MAX_PARALLEL`(기본 3)**로 제한.
- 탐지는 `DASHBOARD_URL` 있으면 `/api/detect/<mode>?project=<id>`(REST) 우선, 실패 시 `detect-cards.sh` 폴백. 각 프로젝트 env(트리거·라벨·repo·자격증명)는 `projects.json`/`project-credentials.json`에서 구성된다.
- 진행 상황을 각각 `loop-plan.log` / `loop-build.log` / `loop-review.log`에 기록.
- 주기는 `LOOP_INTERVAL`(초, 기본 3600)로 조정. **review 루프는 `REVIEW_LOOP_INTERVAL`(설정의 `reviewIntervalSeconds`)로 별도 주기**.
- **즉시 1회 실행(`RUN_ONCE=1`)**: 스케줄을 기다리지 않고 detect→처리를 한 번만 수행하고 종료(대기 없음). 대시보드 "전체 실행" 버튼이 이 모드로 루프 스크립트를 띄우며, 출력은 동일한 `loop-<type>.log`에 쌓여 로그 화면에 바로 보입니다. 스케줄 루프와 동시에 같은 카드를 처리하지 않도록 `run-jira-claude.sh`가 카드별 락(`repos/.state/<KEY>.lock`), `run-review.sh`가 review 전용 락(`.state/<KEY>.review.lock`)을 사용합니다.

#### 4.3b run-review.sh (PR 자동 리뷰)

**review 루프**는 자동화가 올린 build PR(= `claude-pr` 라벨 카드의 열린 PR)을 Claude 리뷰어로 점검한다.

- **탐지**: `detectJql("review")` = `... AND labels = "claude-pr"` (병합 대기 PR 을 가진 카드). build 게이트와 상보적(build 는 claude-pr 제외, review 는 claude-pr 만).
- **PR 해석**: 카드 KEY 로 **프로젝트의 모든 repo**(카드의 build 대상 라벨에 국한하지 않음 — 연동 PR 이 어느 repo 에 있든 인식)에서 열린 PR(draft 제외)을 `gh pr list --search <KEY>` 로 찾는다. **기본은 자동화(봇 계정 author)가 만든 PR 만** 리뷰한다(사람이 같은 카드로 만든 PR 은 자동 리뷰 대상에서 제외). 대시보드 'PR 목록'의 '이 PR 리뷰'는 `REVIEW_ONLY_OWNER`/`REVIEW_ONLY_NUM` 으로 **지정한 PR 하나만**(사람 PR 포함, 설정에 없는 repo 도) 리뷰한다.
- **PR 탐색 범위**: 대시보드의 PR 목록(`/api/cards/:key/prs`)·리뷰 조회·병합·완료 판정은 모두 **프로젝트 전 repo**(`normalizeRepos`)를 검색한다. `cardRepos`(라벨/첫 repo 기반)는 **build 개발 대상 선정**에만 쓰고, PR 인식에는 쓰지 않는다.
- **승인 스킵**: PR 코멘트에 **승인 마커(`CLAUDE-REVIEW-APPROVED`)** 가 이미 있으면 스킵(승인 완료 → 영구 스킵). 없으면 매 주기 최신 코멘트를 반영해 재리뷰. (대시보드 **수동 review 버튼**은 `FORCE_REVIEW=1` 로 마커가 있어도 강제 재리뷰)
- **리뷰 수행**: Claude 에게 **PR diff(코드) · PR 본문(정리 사항) · 기존 리뷰/코멘트(사람이 새로 남긴 것 포함) · 연동 Jira 티켓**(요구사항/수용조건)을 읽혀 코드 리뷰. 결과에 따라 **한 가지만**:
  - 문제 있음 → 구체적 지적을 PR 코멘트로 남김(승인 마커 없음 → 다음 주기 재리뷰).
  - 문제 없음 → **고유 승인 마커 코멘트**를 남김. 자기 자신의 PR 은 GitHub formal approve 가 불가하므로 `gh pr review --approve` 대신 마커 코멘트로 "리뷰 완료(승인)"를 표시한다.
- 코드/커밋/머지/상태·라벨은 **건드리지 않음**(리뷰 코멘트만). 결과는 이력에 `review/approved` 또는 `review/reviewed` 로 기록하고, **Slack 알림**(`SLACK_WEBHOOK_URL` 설정 시)도 보낸다 — 승인 `✅ PR 리뷰 승인`, 미승인 `📝 PR 리뷰 코멘트(수정 필요)`(각 repo#번호·PR URL 포함).

### 4.4 대시보드 백엔드 (dashboard/server.js, Express)

기본 포트 `4317`. 주요 API:

| 메서드 | 경로 | 역할 |
|--------|------|------|
| GET | `/api/health` | 헬스체크 |
| GET / POST | `/api/projects` | 프로젝트 목록 조회 / 추가·수정 (멀티 프로젝트) |
| DELETE | `/api/projects/:id` | 프로젝트 삭제 |
| GET / POST | `/api/projects/:id/credentials` | 프로젝트별 자격증명 (GET 마스킹) |
| GET / POST | `/api/config` | (레거시 호환) 첫 프로젝트 설정 조회/저장 — 단일 프로젝트 UI 용 |
| GET / POST | `/api/credentials` | 토큰 저장/조회 (GET은 마스킹) |
| GET | `/api/loops/status` | plan/build 루프 실행 상태(pid) |
| POST | `/api/loops/:type/start` · `/stop` | 루프 시작/중지 (프로세스 spawn/kill). `type` = `plan` \| `build` \| `review` |
| POST | `/api/loops/:type/run-once` | 준비된 전체 카드 즉시 1회 실행(스케줄 무시, 같은 로그에 기록) |
| POST | `/api/cards/:key/run` | 특정 카드 1건만 즉시 실행(`phase`=plan\|build; `rework:true`+선택 `memo` 시 기존 PR 리뷰 반영) |
| POST | `/api/cards/:key/repos` | 기존 카드의 대상 repo 라벨(`repo_<name>`) 설정(프로젝트 repo 목록과 교집합만 반영) |
| GET | `/api/cards/:key/prs` | **카드의 모든 PR(1:N) 조회** — 대상 repo 들에서 카드 키로 검색. PR별 `{repo,owner,number,url,title,state,branch,isDraft,author,isBot}` 반환. `isBot`=봇 계정(GH_TOKEN 사용자)이 만든 자동화 PR 여부, `botLogin` 도 함께 반환 |
| POST | `/api/cards/:key/merge` | PR 병합(`gh pr merge --rebase --delete-branch`). body `{owner,number}` 지정 시 **그 PR 하나만**(사람 PR 포함), 없으면 **자동화(봇) PR 전체**를 병합. **자동화 PR 이 모두 병합되면**(열린 봇 PR 0) 카드 완료 전환 + `claude-pr` 라벨 제거 + **'완료 내역'을 최종 병합 PR 본문으로 갱신** + 처리 이력 `merge/merged` + **clone 디렉토리 삭제**. 응답 `merged`·`doneStatus`·`removed[]`·`prs[]` |
| POST | `/api/cards/sync-merged` | **외부(대시보드 밖) 병합 자동 반영**: await-merge(`claude-pr`) 카드 중 **자동화(봇) PR 이 모두 MERGED(열린 봇 PR 0)** 면 재병합 없이 완료 처리(사람 PR 은 무시). `project` 지정/전체. 응답 `completed[]`. 백엔드가 **3분 주기 자동 실행** + "병합 동기화" 버튼으로 즉시 트리거 |
| GET | `/api/cards/:key/reviews` | 카드의 대상 repo PR(들)의 **리뷰 내용** 조회 — `gh pr view --json reviews,comments` + `gh api .../pulls/N/comments`(인라인). PR별 `{number,url,title,state,branch,reviews[],comments[],inline[]}` 반환. 카드 상세 'PR 리뷰' 영역에서 사용 |
| GET | `/api/claude-log/:key/:phase` | 카드별 claude 상세 실행 로그(도구 호출/메시지/결과) 조회 |
| GET | `/api/logs/:type` | 로그 tail (마지막 N줄) |
| POST | `/api/logs/:type/clear` | 로그 파일 비우기(truncate) |
| GET | `/api/cards` | Jira REST로 트리거(claude-work) 카드 목록+단계 (`?project=<id>`). **할당자 무관** 조회하고 카드별 `assignedToMe`(내 accountId=`/myself` 와 비교)·`assignee` 를 함께 반환 → 비할당 카드는 UI 에서 리뷰만 허용 |
| GET | `/api/detect/:mode` | Jira REST로 후보 키 조회(루프의 REST 탐지 대상). `mode` = `plan` \| `build` \| `review`(claude-pr 카드) |
| GET | `/api/history` | 처리 이력(`history.jsonl`) 최신순 조회. 각 항목에 **`summary`(티켓 제목)를 키→제목 캐시로 보강**(프로젝트별 `key IN (...)` 배치 조회, 캐시 히트 시 재조회 없음) |
| GET | `/api/livereload` | 라이브 리로드용 SSE 스트림(프론트 파일 변경 시 reload 이벤트 푸시) |
| GET | `/api/jira/meta` | 카드 등록용 메타(프로젝트 이슈 타입 + 에픽 목록) |
| POST | `/api/cards/:key/stop` | 처리 중인 카드의 claude 작업 중지 — **build/plan(`<KEY>.lock`)·review(`<KEY>.review.lock`) 중 살아있는 락을 모두** 대상으로 PID 프로세스 트리를 SIGTERM→4초후 SIGKILL. 루프/다른 카드는 무영향. 이력에 `stopped` 기록 |
| POST | `/api/jira/issue` | Jira 카드 생성(요약·설명·이슈타입·상위키·라벨·할당·이미지 첨부) |
| POST | `/api/ai/refine-description` | 러프 설명을 Claude 로 체계적 설명(배경/요구사항/AC)으로 변환 |
| GET | `/api/jira/issue/:key` | 카드 상세(설명·코멘트). ADF→텍스트 + **이미지 인라인 세그먼트**(`descriptionSegments`·코멘트 `bodySegments`) 반환. 세그먼트 타입: `text` / `image`(첨부 프록시 `id` 또는 외부 `url`) / `unavailable`(blob 등 서버가 못 가져오는 인라인 이미지). 첨부 매칭은 ① `alt`=파일명 → ② **노드 순서 기반 첨부 폴백**(alt 없는 붙여넣기 이미지) → ③ 외부 http(s) URL 직접 표시 순 |
| GET | `/api/jira/issue/:key/attachment/:id` | 카드 첨부 이미지 **프록시**(백엔드가 Basic auth 로 Jira 에서 받아 스트리밍). 브라우저가 직접 Jira 인증을 못 하므로 `<img>` 가 이 경로를 사용 |
| POST | `/api/jira/issue/:key/comment` | 카드에 답변 코멘트 작성(옵션: `replyTo` 인용 답글, `claude-answered` 라벨 추가) |
| GET / POST | `/api/env` | env 읽기/쓰기 (`?repo=<name>` 시 repo 전용 env, 없으면 프로젝트 공통; 저장 시 `.bak` 백업) |

루프를 띄울 때 백엔드가 설정·토큰을 **환경변수로 주입**합니다(아래 [설정 레퍼런스](#5-설정-레퍼런스)).

### 4.5 대시보드 프론트 (dashboard/public/index.html, React)

빌드 도구 없이 CDN(React + Tailwind)으로 동작하는 단일 페이지(본문 폭 `max-w-7xl`). 카드 상태·처리 이력 표는 `table-fixed` 로 열 폭을 고정하고 티켓 이름·브랜치·프로젝트는 **한 줄 표시 + 넘치면 `…`(truncate, 전체 텍스트는 hover title)** 로 정돈한다. **멀티 프로젝트** 구조: 전역 섹션(루프 제어·처리 이력·실시간 로그)과 **프로젝트 카드 목록**으로 구성된다. 각 프로젝트 카드는 접이식이며, 그 안의 **설정·자격증명·카드 등록·카드 상태** 각 영역도 개별 접기/펼치기(`SubSection`, **기본 접힘**) — 헤더 클릭으로 토글, 액션 버튼(저장·조회 등)은 펼쳤을 때만 노출. 설정·자격증명·카드 등록의 **각 입력 항목 라벨 옆 'i' 버튼**을 누르면 그 항목에 무엇을 입력해야 하는지 설명 모달이 뜬다(`InfoTip` 컴포넌트, 포털로 렌더).

- **루프 제어**(전역): plan/build 시작·중지, **전체 실행**(전 프로젝트 즉시 1회), 실행 상태(pid). 한 사이클이 모든 프로젝트를 순회.
- **프로젝트 목록**: "+ 프로젝트 추가"(이름 입력)로 새 프로젝트 생성, 각 카드 우측 "삭제"로 제거. 동시에 여러 프로젝트가 활성으로 운용된다.
- **프로젝트 카드**(접이식, `ProjectCard`): 제목=이름·프로젝트키. 내부에:
  - **설정**: Jira·프로젝트키·담당자·트리거·완료상태·라벨·주기·동시상한·clone베이스·test/build 명령 → "설정 저장"(`POST /api/projects`).
  - **Git Repositories(여러 개)**: 한 프로젝트에 repo 를 여러 개 등록(`repos: [{name,url,baseBranch,envDest}]`). `name` 은 카드 라벨(`repo_<name>`)에 쓰이는 슬러그. 레거시 단일 `repoUrl` 은 자동으로 repos[0] 으로 변환됨.
    - **repo별 env 분리**: repo 마다 `env 대상경로(envDest)` 와 전용 `.env` 내용(`work-<projectId>-<repoName>.env`)을 따로 지정 가능. 각 repo clone 에 자기 env 가 복사됨(`.git/info/exclude` 로 커밋 차단). repo 전용 env 가 없으면 복사 생략(프로젝트 공통 env 항목은 제거됨 — 카드 전용/ repo 전용 env 만 사용).
  - **자격증명(이 프로젝트 전용)**: Anthropic/GitHub/Atlassian/Slack 토큰을 **프로젝트별로** 저장(마스킹). `ⓘ` 툴팁으로 용도 설명.
  - **환경 변수(.env)**: env 는 **repo 전용**(`work-<projectId>-<repoName>.env`) 또는 **카드 전용**(로컬 `card-envs/<KEY>.env`) 으로만 운용한다(프로젝트 공통 env 항목은 제거됨). repo 마다 **복사 대상 경로(`envDest`)** 로 clone 내 임의 경로에 떨굴 수 있음(비우면 루트). 예: Spring Boot 는 `src/main/resources/application-private.properties`, Node 는 `.env`. 상위 폴더 자동 생성 + `.git/info/exclude` 로 커밋 차단. 우선순위: **카드 전용 > repo 전용**.
  - **Jira 카드 등록 / 카드 상태**: 아래 설명과 동일, 모두 `?project=<id>` 스코프. 카드 단계는 라벨/상태 기반(질문대기/답변대기/개발대기/**병합대기**/실패/완료)에 더해, **실행 중(살아있는 락)이면 최우선으로 "처리 중(plan|build|review)"** 으로 표시(완료 상태 카드를 재실행해도 처리 중이 우선 → 중지 가능). 죽은 프로세스의 스테일 락은 '처리 중'으로 보지 않는다. build 가 PR 을 올리면 상태를 바꾸지 않고 `claude-pr` 라벨을 달아 **"병합 대기"**, 대시보드 "PR 병합" 으로 rebase merge 하면 카드가 완료 상태로 전환되어 **"완료"** 가 되고, **그 카드의 clone 디렉토리(`<CLONE_BASE>/<repo>-<KEY>`)도 함께 삭제**되어 디스크를 회수한다(처리 중 lock 이면 생략). **PR 을 대시보드 밖(GitHub 등)에서 직접 병합해도**, 백엔드가 **3분 주기로 자동 감지**(await-merge 카드의 PR 이 모두 MERGED 이고 열린 PR 이 없으면)해 동일하게 완료 처리한다 — 루프 제어의 **"병합 동기화"** 버튼으로 즉시 반영할 수도 있다. 카드 상태는 **마운트 시 1회 + 60초마다 자동 갱신**(프로젝트 키 있을 때), 수동 "조회" 버튼도 그대로 사용. **할당자와 무관하게 트리거(claude-work) 카드를 모두 표시**하며(`/api/cards` 가 assignee 필터 없이 조회 + 카드별 `assignedToMe` 플래그 부여, 내 accountId 는 `/myself` 로 판별), **내게 할당되지 않은 카드는 UI 에서 '코드 리뷰'만 가능**하다(review 실행·PR별 '이 PR 리뷰'·PR 리뷰 조회·읽기 전용 티켓 내용만 노출, plan·build·리뷰 반영·PR 병합·답변은 담당자 전용으로 숨김 + 안내 배너). plan/build 루프는 종전대로 `assignee = currentUser()` 로 내 카드만 개발한다. 목록은 **최신 작성 카드가 먼저**(`ORDER BY created DESC`) 오도록 정렬되고, **페이지당 10건 페이지네이션**(처음/이전/다음/마지막 + 총 건수·표시 범위)이 적용된다. 상단 **검색창**으로 티켓 이름·번호(키)·상태로 필터할 수 있다(클라이언트 필터). 열은 **키(번호) · 티켓 이름 · 상태 · 단계**. 행을 펼치면 **🕘 작업 이력(이 카드의 plan·build·review·merge 처리 내역, `history.jsonl`에서 키로 필터)** + 📋 Jira 카드(설명·코멘트·답변) + 🔀 Git·PR 이 모두 표시된다.
- **Jira 카드 등록**: 이슈 타입(프로젝트 메타에서 조회)·요약·설명을 입력해 카드를 생성. 상위는 **에픽 드롭다운**(프로젝트 에픽 목록) 또는 **상위 키 직접 입력**(우선 적용)으로 지정(`fields.parent`). 생성 전 **계층을 검증**해 상위가 자식보다 한 단계 위(에픽>작업>하위작업)가 아니면 실행 가능한 안내를 줍니다(예: 작업 하위에 두려면 '하위 작업' 타입 선택). 체크박스로 트리거 라벨(`claude-work`) 추가와 본인 할당을 선택 — 둘 다 켜면 생성 즉시 자동화(plan) 대상이 됩니다. 설명은 ADF 로 변환되어 전송됩니다.
  - **대상 repo 선택(멀티)**: 프로젝트의 repo 목록 중 여러 개를 체크하면 카드에 `repo_<name>` 라벨이 붙고, build 가 선택된 **각 repo 마다** clone·구현·PR 을 만듭니다(변경 없는 repo 는 건너뜀). 미선택 시 첫 repo.
  - **카드 전용 env(선택)**: 카드 생성 시 env 텍스트를 입력하면 **호스트 로컬 디렉토리** `card-envs/<KEY>.env` 에 **평문(권한 600)** 으로 저장한다(Jira 로 업로드하지 않음). build/단건 실행 때 그 로컬 파일을 읽어 **각 repo 의 envDest 로 복사**한다(카드별 격리). 파일이 없으면 repo 전용 env 를 사용한다(**Jira 폴백 없음**).
    - **보관 위치**: 기본 `<workDir>/card-envs/`(gitignore). 설정 `cardEnvDir` 로 경로 변경 가능. 시크릿이 외부(Jira)로 나가지 않고 호스트 안에만 머문다. 카드 생성 머신과 build 실행 머신이 같아야 한다(로컬 파일 기반).
  - **✨ Claude로 정리**: 러프하게 적은 설명을 `claude` 가 "배경/목적 · 요구사항 · 완료조건(AC)" 구조의 마크다운으로 변환해 설명 필드에 채웁니다(`/api/ai/refine-description`). 입력에 없는 내용은 "(확인 필요)" 로 표시합니다.
  - **이미지 첨부**: 파일 선택(이미지, 복수 가능) 후 카드 생성 시 Jira 첨부(`/rest/api/3/issue/{key}/attachments`, `X-Atlassian-Token: no-check`)로 업로드됩니다. 프론트가 base64 로 전송하고 백엔드가 multipart 로 변환(요청 본문 한도 25MB).
- **카드 상태**: 트리거 카드의 단계(plan대기/답변대기/build대기/실패/완료) 표. **행을 클릭하면 아래로 펼쳐져** 원문 설명과 코멘트(특히 plan 단계의 질문)를 보고, 그 자리에서 **답변을 코멘트로 등록**할 수 있습니다. 펼친 패널은 **상단 설정·관찰(대상 repo 선택·Claude 실행 로그) → 📋 Jira 카드 그룹(설명·코멘트·답변) → 🔀 Git · PR 작업 그룹(PR 리뷰·리뷰 반영·PR 병합)** 순으로, 각 그룹은 색상 헤더가 있는 테두리 컨테이너로 **시각적으로 구분**된다(Jira 항목이 위, Git 항목이 아래). 설명·코멘트에 포함된 **이미지는 원래 위치에 인라인으로 표시**됩니다(첨부는 백엔드 프록시 경유, 외부 공개 URL은 원본 직접, 클릭 시 새 탭). `alt`(파일명)로 매칭되지 않는 붙여넣기 이미지는 **본문 내 노드 순서대로 첨부와 연결**해 표시합니다. 단, 첨부로 업로드되지 않은 **인라인 붙여넣기(`blob:`) 이미지**는 서버가 가져올 수 없어 **"🖼 인라인 이미지(첨부 아님) — 표시 불가, Jira에서 확인"** 안내로 표시되며 Jira 원문에서 확인해야 합니다. "답변 완료로 표시" 체크 시 `claude-answered` 라벨도 함께 추가되어 다음 주기에 build 가 진행됩니다. **처리 중("처리 중(plan|build)")인 카드**는 펼친 패널에 **"■ 중지"** 버튼이 나타나, 그 카드의 claude 실행만 즉시 종료할 수 있습니다(루프·다른 카드는 계속).
  - **대상 repo 선택(기존 카드)**: 펼친 패널에서 프로젝트 repo 들을 체크하면 카드의 `repo_<name>` 라벨을 즉시 추가/제거(`/api/cards/:key/repos`)한다. 카드 생성 때뿐 아니라 **이미 있는 카드도** 대상 repo 를 지정/변경할 수 있다. 미지정 시 build 는 첫 repo 를 대상으로 한다.
  - **이 카드만 즉시 실행**: 펼친 패널 상단의 `plan`/`build`/`review` 버튼으로 detect 를 거치지 않고 **그 카드 1건만** 즉시 실행합니다(`/api/cards/:key/run`). 출력은 `loop-<phase>.log` 에 기록되어 실시간 로그에서 진행을 확인할 수 있습니다. (루프 제어의 "전체 실행"은 준비된 모든 카드를 도는 반면, 이건 단건만 실행)
    - **review 버튼(수동 PR 리뷰)**: 그 카드의 열린 PR 을 즉시 리뷰합니다. Jira 본문·댓글 + PR 완료 내용(본문) + 코드(diff)를 분석해 PR 에 리뷰 코멘트를 남깁니다(`run-review.sh`). 수동 실행은 `FORCE_REVIEW=1` 로 **이미 승인 마커가 있어도 강제 재리뷰**하며(루프 자동 실행은 승인 시 스킵), claude-pr 라벨이 없어도 PR 만 있으면 리뷰합니다. Claude 실행 로그 `review` 버튼으로 진행을 봅니다.
  - **리뷰 반영·병합·메모 — 모두 PR 별**: PR 이 여러 개일 수 있으므로 **'PR 목록'의 각 PR 항목 안에** `[리뷰 반영]`·`[반영+재리뷰]`·`[이 PR 병합]` 버튼과 **그 PR 전용 '리뷰 반영 메모' 입력**을 둔다(외부 공용 '리뷰 반영 메모'·일괄 'PR 병합' 영역은 제거). rework 버튼은 자동화(봇) PR·열림·담당자 카드일 때만. 누르면 그 PR 하나만(`reworkOwner`/`reworkNumber` → `REWORK_ONLY_OWNER`/`REWORK_ONLY_NUM`) `REWORK` 모드로 build 를 돌린다 — 백엔드가 그 PR repo 만 clone 대상으로 좁히고, 메모(그 PR 전용)는 **그 PR 에만** `gh pr comment` 로 남긴다. claude 는 **새 PR 을 만들지 않고** 그 PR 브랜치를 checkout → GitHub 리뷰 + Jira 코멘트 반영 → 같은 브랜치 push → `gh pr edit --body-file` 로 본문 갱신. `[이 PR 병합]` 은 그 PR 하나만 `POST /api/cards/:key/merge {owner,number}` 로 병합. 상태는 안 바꿈, 스케줄 루프는 rework 안 함. 이력 `rework`.
    - **반영+재리뷰**: 각 PR 의 두 번째 버튼. 그 PR 리뷰 반영이 성공하면 이어서 리뷰어(`FORCE_REVIEW=1 run-review.sh`, `REVIEW_AFTER=1`)가 갱신된 PR 을 다시 리뷰(같은 프로세스 체인 → 반영 완료 후에만 재리뷰).
  - **Claude 실행 로그**: 같은 줄의 "Claude 실행 로그 plan/build" 버튼으로 그 카드의 claude 상세 전사(도구 호출·메시지·결과)를 펼쳐 봅니다(3초마다 갱신). build 중 claude 가 무엇을 했는지 단계별로 확인할 수 있습니다.
  - **🌿 브랜치 영역**: 펼친 패널 Git·PR 영역 상단에 **이 카드 관련 브랜치를 따로 표시** — plan 이 만든 **타겟(작업) 브랜치**(카드 코멘트 `🌿 타겟 브랜치:` 마커에서 추출)와, ('PR 불러오기' 시) **각 PR 의 head 브랜치 목록**(repo·번호·상태, 타겟과 일치하면 '타겟 일치' 표시).
  - **PR 목록 (카드 1:PR N)**: 펼친 패널 Git·PR 영역의 "PR 불러오기"로 카드의 **모든 PR을 개별 행**으로 본다(`/api/cards/:key/prs`) — repo·번호·상태(OPEN/MERGED/DRAFT)·브랜치·작성자와 **자동화/사람 배지**(봇 계정 author 기준). 각 PR에 **"이 PR 병합"(그 PR만)·"이 PR 리뷰"(그 PR만)·"열기"** 버튼. 일괄 "PR 병합"·자동 완료·review 루프는 **자동화 PR만** 대상이라, 다른 사람이 같은 카드로 올린 PR이 섞여도 자동으로 병합/리뷰되지 않는다(원하면 개별 버튼으로 처리).
  - **PR 리뷰/코멘트(PR 목록 인라인)**: 'PR 목록'의 각 PR 항목에서 **`▸ 리뷰/코멘트`** 를 누르면 그 PR 아래로 펼쳐져 **GitHub 리뷰(승인/변경요청 + 본문)·PR 코멘트·인라인 리뷰 코멘트(파일:라인)**를 본다(`/api/cards/:key/reviews` 를 최초 1회 로드해 owner+번호로 매칭). 각 항목은 **작성자 헤더 + 마크다운 렌더 본문**의 코멘트 카드(`PrReviewBody`) — `marked`(GFM)+`DOMPurify` 로 **제목·표·굵게·코드블록·목록을 GitHub PR 페이지처럼** 렌더(HTML 주석 마커 비표시). 열린 PR뿐 아니라 병합된 PR 의 리뷰도 표시. (별도 'PR 리뷰' 영역은 제거되고 PR 목록에 통합됨. '이 PR 리뷰 실행'은 claude 로 새 리뷰를 수행하는 별개 버튼)
  - **코멘트 답글(인용)**: 각 코멘트의 "↳ 답글" 을 누르면 그 코멘트를 대상으로 답변을 작성합니다. Jira 이슈 코멘트는 구조적으로 평면(스레드 미지원)이라, 답글은 **원문 인용(blockquote) + 작성자 @멘션**을 포함한 새 코멘트로 등록됩니다(Jira UI 의 "인용 답글"과 동일 방식). 표시할 때 인용 줄은 `> ` 로 보여 스레드처럼 구분됩니다.
- **처리 이력**(전역): `history.jsonl` 기반 최근 처리 내역(시각·**프로젝트**·키(번호)·**티켓 이름**·단계·결과·PR·브랜치) 표. 4초마다 갱신. **페이지당 10건 페이지네이션** + **검색창**(티켓 이름·번호(키)·프로젝트로 필터). **티켓 이름**은 백엔드가 `/api/history` 응답에 키→제목을 보강해 채운다(제목 캐시 → 폴링 시 재조회 없음). 행을 누르면 **🕘 그 카드의 전체 작업 이력 + 📋 티켓 내용(설명·코멘트)**이 펼쳐진다(설명/코멘트는 `/api/jira/issue/:key` 로 조회, 이미지 인라인). 갱신/검색으로 건수가 변해도 현재 페이지를 안전하게 클램프.
- **실시간 로그**(전역): 4초마다 로그 자동 갱신.
- **실시간 로그 비우기**: 각 로그(`loop-plan.log`/`loop-build.log`) 우측의 "비우기" 버튼으로 파일을 truncate 합니다(확인창 후 실행). 루프가 돌고 있어도 다음 출력부터 다시 쌓입니다.
- **라이브 리로드**: 서버가 `public/` 변경을 감시해 SSE(`/api/livereload`)로 reload 신호를 보내면 브라우저가 자동 새로고침합니다. 백엔드가 재시작되면 SSE 재연결 시 한 번 더 새로고침합니다. `DASHBOARD_NO_LIVERELOAD=1` 로 끌 수 있습니다.

---

## 5. 설정 레퍼런스

모든 설정은 환경변수(셸) 또는 `config.json`(대시보드)으로 지정합니다. 대시보드는 이 값들을 루프에 환경변수로 주입합니다.

| 키 | 환경변수 | 기본값 | 설명 |
|----|----------|--------|------|
| 작업 폴더 | `WORK_DIR` | 스크립트 폴더 | 기준 작업 폴더 |
| 대상 repo(다중) | `CARD_REPOS` | (프로젝트 repos) | 카드 대상 repo 목록(줄당 `name·url·baseBranch·envSrc·envDest`, 필드구분 `\x1f`). `envSrc` 는 카드 전용 env(로컬 `card-envs/<KEY>.env`) 있으면 그 경로, 없으면 repo/프로젝트 env. 비우면 `REPO_URL` 단일 |
| 대상 repo(단일·레거시) | `REPO_URL` | (없음) | `CARD_REPOS` 없을 때 clone 할 단일 repo URL |
| 카드 첨부 이미지 | `CARD_IMAGES` | (run-cycle 주입) | 카드 이미지 첨부의 로컬 경로(줄단위). 프롬프트에 주입돼 Claude 가 `Read` 로 시각 인식. `run-cycle` 가 다운로드(최대 10장) |
| 완료 요약 파일 | `SUMMARY_FILE` | `<CLONE_BASE>/.state/<KEY>.summary.md` | build 시 claude 가 완료 요약(md)을 저장하는 경로. 성공 후 `append-summary.js` 가 설명 ADF 에 안전 append(이미지 보존) |
| Jira REST 자격증명 | `JIRA_SITE`·`ATLASSIAN_EMAIL`·`ATLASSIAN_TOKEN` | (run-cycle 주입) | `append-summary.js` 가 설명 ADF 를 직접 GET/PUT 하는 데 사용(Basic auth). 미설정 시 완료 내역 append 생략(요약 파일은 보존) |
| base 브랜치 | `BASE_BRANCH` | `main` | PR 대상/체크아웃 브랜치 |
| env 파일 | `ENV_SRC` | `<WORK_DIR>/work.env` | clone 디렉토리로 복사할 env |
| env 복사 대상 | `ENV_DEST_REL` | (없음=루프 루트) | repo 내 복사 대상 상대경로(예: `src/main/resources/application-private.properties`) |
| clone 베이스 | `CLONE_BASE` | `<WORK_DIR>/repos` | clone 들이 모이는 폴더 |
| 카드 전용 env 디렉토리 | (대시보드 `cardEnvDir`) | `<WORK_DIR>/card-envs` | 카드 전용 env(`<KEY>.env`)를 로컬에 보관·로드하는 폴더(gitignore, Jira 미업로드) |
| Jira 사이트 | (대시보드 `jiraSite`) | (없음) | 예: `team.atlassian.net` (카드 조회용) |
| 프로젝트 키 | `PROJECT_KEY` | (없음) | 예: `PROJ` (JQL 프로젝트 필터) |
| 담당자 이메일 | `ASSIGNEE_EMAIL` | (없음) | 카드 할당자 확인용 |
| 담당자 이름 | `ASSIGNEE_NAME` | `담당자` | 코멘트 멘션용 |
| 트리거 방식 | `TRIGGER_MODE` | `label` | `label`(권장) 또는 `text`(레거시) |
| 트리거 라벨 | `TRIGGER_LABEL` | `claude-work` | label 모드에서 자동화 대상 표시 라벨 |
| 트리거 텍스트 | `TRIGGER_TEXT` | `claude-work` | text 모드(레거시)에서 대상 표시 키워드 |
| 완료 상태 | `DONE_STATUS` | `DEV COMPLETED` | 완료로 인식할 Jira 상태명. **쉼표로 복수 지정 가능**(예: `DEV COMPLETED, Done`) — 첫 번째가 병합 시 전환 대상, 전체가 탐지 제외·완료 판정 대상 |
| plan 라벨 | `PLANNED_LABEL` | `claude-planned` | plan 완료 표시 라벨 |
| 답변 라벨 | `ANSWERED_LABEL` | `claude-answered` | 담당자 답변 완료 신호(build 진입 게이트) |
| 실패 라벨 | `FAILED_LABEL` | `claude-failed` | 반복 실패 표시 라벨(탐지 제외) |
| 최대 재시도 | `MAX_RETRIES` | `3` | 연속 실패 N회 초과 시 실패 처리 |
| 테스트 명령 | `TEST_CMD` | (없음=자동 감지) | PR 전 실행할 테스트 명령 |
| 빌드 명령 | `BUILD_CMD` | (없음=자동 감지) | 테스트 없을 때 시도할 빌드 명령 |
| 이력 파일 | `HISTORY_FILE` | `<WORK_DIR>/history.jsonl` | 처리 이력 기록 파일(대시보드 `/api/history` 가 읽음) |
| Slack 웹훅 | `SLACK_WEBHOOK_URL` | (없음) | 설정 시 처리 완료/실패 알림 발송, 비면 스킵 |
| 주기(초) | `LOOP_INTERVAL` | `3600` | plan/build 루프 주기 |
| review 주기(초) | `REVIEW_LOOP_INTERVAL` (설정 `reviewIntervalSeconds`) | `3600` | review 루프 주기(별도) |
| PR 승인 마커 | (고정) `CLAUDE-REVIEW-APPROVED` | — | review 루프가 PR 승인 표시로 남기는 고유 코멘트 텍스트. 존재하면 이후 리뷰 스킵(lib `REVIEW_APPROVED_MARKER`) |
| 동시 처리 상한 | `MAX_PARALLEL` | `3` | 한 주기에 동시에 처리하는 카드 수 |
| 대시보드 주소 | `DASHBOARD_URL` | (대시보드가 주입) | 루프가 REST 탐지(`/api/detect`)를 호출할 백엔드 주소. 비면 claude 탐지 사용 |
| 라이브 리로드 끄기 | `DASHBOARD_NO_LIVERELOAD` | (없음) | `1` 이면 대시보드 라이브 리로드 비활성화 |
| Anthropic 키 | `ANTHROPIC_API_KEY` | (없음) | 루프 내 claude 인증 |
| GitHub 토큰 | `GH_TOKEN`/`GITHUB_TOKEN` | (없음) | clone/push/PR 인증 |

값 우선순위: **환경변수/`config.json` → 코드 기본값**. 비워두면 기본값 또는 로컬 CLI 인증으로 폴백됩니다.

---

## 6. 빠른 시작

### 사전 준비

- **Claude Code CLI** 설치 + 로그인, Atlassian MCP 연결:
  `claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp` 후 `/mcp` 인증
- **GitHub CLI**: `brew install gh && gh auth login` (clone/push/PR)
- **Node.js ≥ 18** (대시보드)

### 대시보드 실행

```bash
cd dashboard
npm install
npm start          # http://localhost:4317
# 개발 모드(핫리로드): 한 명령으로 백엔드 자동 재시작 + 프론트 라이브 리로드
npm run dev        # nodemon 이 server.js(백엔드)만 감시·재시작, 프론트는 내장 SSE 로 처리
```

> 이 대시보드는 **단일 프로세스**입니다(Express 가 `public/` 정적 서빙). 별도 프론트 서버가 없으므로
> `npm run dev` **한 명령**이면 충분합니다 — 백엔드(server.js) 변경 시 nodemon 이 서버를 재시작하고,
> 프론트(`public/`) 변경 시 내장 SSE 라이브 리로드가 브라우저를 새로고침합니다.
> `npm start` 는 프론트 라이브 리로드만 되고 백엔드 자동 재시작은 없습니다.

브라우저에서: ① 자격증명 입력 → ② 프로젝트 설정(대상 repo·Jira·담당자 등) 저장 →
③ 프로젝트 설정의 환경 변수(.env) 지정/입력 → ④ 루프 시작 → ⑤ 카드 상태·로그 모니터링.

---

## 7. 사용법

### 7.1 대시보드로 운용 (권장)

1. **자격증명** 섹션에서 Anthropic/GitHub/Atlassian 입력 후 저장.
2. **프로젝트 설정**에서 대상 repo·Jira 사이트·프로젝트 키·담당자·주기 등 확인/저장.
3. **work.env**를 불러와 필요한 시크릿 입력 후 저장.
4. **루프 제어**에서 plan·build 시작.
5. **카드 상태/로그**로 진행 모니터링.
6. 카드에 plan 질문이 달리면 Jira에서 답변 → 다음 build 주기에 자동 진행.

### 7.2 CLI로 운용

```bash
# 환경변수로 대상 지정
export REPO_URL="https://github.com/Org/repo.git"
export BASE_BRANCH="main"
export PROJECT_KEY="PROJ"
export ASSIGNEE_EMAIL="you@company.com"
export ASSIGNEE_NAME="Your Name"

# 단발 처리
./run-jira-claude.sh PROJ-123 plan
#   ...카드에서 질문에 답변...
./run-jira-claude.sh PROJ-123 build

# 루프로 상시 운용
nohup ./loop-plan.sh  > /dev/null 2>&1 &
nohup ./loop-build.sh > /dev/null 2>&1 &
tail -f loop-plan.log loop-build.log
```

### 7.3 새 카드를 자동화 대상으로 만들기

카드가 다음을 만족하면 plan 루프가 잡습니다.
- 담당자 = 설정한 담당자(본인)
- 트리거 충족: label 모드(기본)면 `claude-work` 라벨, text 모드(레거시)면 설명에 트리거 텍스트 포함
- 상태가 `DEV COMPLETED`가 아님
- `claude-planned` 라벨 없음

권장 방식: 카드 본문에 작업 spec을 명확히 적고 **`claude-work` 라벨을 붙이면** 됩니다.
(텍스트 검색은 토큰화로 오탐이 생길 수 있어 라벨 트리거가 기본입니다. 레거시 동작이 필요하면 `TRIGGER_MODE=text`.)

대시보드의 **"Jira 카드 등록"** 섹션을 쓰면 카드 생성과 동시에 트리거 라벨 추가·본인 할당을 한 번에 할 수 있습니다(상위 에픽/부모 카드도 지정 가능). 둘 다 켜면 생성 즉시 plan 루프 탐지 대상이 됩니다.

### 7.4 운영(영속성·상태 일관성·자동 재시작)

- **pidfile**: 루프를 시작하면 백엔드가 pid 를 `loop-<type>.pid` 에 기록합니다. 상태 조회(`/api/loops/status`)와 중지는 이 pidfile 을 단일 진실로 사용하므로, **백엔드를 재시작해도** 이미 떠 있는 루프를 정확히 인식하고(시작 로그에 "복구: …" 표시), 중지 버튼으로 프로세스 그룹째 종료할 수 있습니다. 크래시 등으로 죽은 경우 stale pidfile 은 자동 정리되어 "중지됨"으로 표시됩니다.
- **루프는 detached**: `npm start`(백엔드)를 종료해도 루프는 독립 프로세스 그룹이라 계속 돕니다. 깔끔히 멈추려면 대시보드 중지를 쓰거나 `pkill -f loop-plan.sh; pkill -f loop-build.sh`.
- **재부팅 후 자동 재시작**: 백엔드를 프로세스 매니저에 등록하면 됩니다.
  - **pm2**: `cd dashboard && pm2 start server.js --name jira-claude-dashboard && pm2 save && pm2 startup`
  - **launchd(macOS)**: `~/Library/LaunchAgents/com.jira-claude.dashboard.plist` 에 `ProgramArguments`로 `node <repo>/dashboard/server.js`, `RunAtLoad=true`, `KeepAlive=true` 를 지정하고 `launchctl load` 합니다.
  - 백엔드가 다시 뜨면 pidfile 로 루프 상태를 복구하므로, 대시보드 상태가 실제 프로세스와 항상 일치합니다.
- **구버전 루프 자동 교체**: 루프 시작 시 `loop-<type>.ver` 에 `LOOP_VERSION` 을 기록한다. 백엔드가 시작될 때 실행 중인 루프의 버전 마커가 현재와 다르거나 없으면(=구버전 프로세스), 그 루프를 종료하고 신버전으로 자동 재시작한다. (코드 업데이트 후 옛 루프가 계속 도는 문제 방지)

---

## 8. 인증 구조

| 인증 | 사용처 | 주입/사용 방식 | 비우면 |
|------|--------|----------------|--------|
| Anthropic API Key | 루프 내 `claude` | `ANTHROPIC_API_KEY` 환경변수 | 로컬 `claude` 로그인으로 폴백 |
| GitHub Token | clone / push / PR | `GH_TOKEN` 환경변수(gh·git) | 로컬 `gh auth`로 폴백 |
| Atlassian 이메일+토큰 | 대시보드 카드 조회(REST) | 백엔드 Basic auth | 카드 조회 화면만 동작 안 함 |
| Slack Incoming Webhook | 처리 완료/실패 알림 | `SLACK_WEBHOOK_URL` 환경변수(루프→curl) | 알림 스킵 |

> 중요: 루프 안에서 `claude`가 Jira에 코멘트/상태 전환을 하는 부분은 **Claude Code의 Atlassian MCP(OAuth)**를 사용합니다.
> 대시보드에 넣는 Atlassian 토큰은 대시보드 자체의 카드 조회용입니다.

Atlassian API 토큰 발급: <https://id.atlassian.com/manage-profile/security/api-tokens>

---

## 9. 파일 구조

```
loop-work/                     # (= 저장소 루트)
├─ README.md                   # 프로젝트 소개
├─ DOCUMENTATION.md            # (이 문서)
├─ LOOP-GUIDE.md               # 루프 사용 가이드
├─ run-jira-claude.sh          # 카드 1개 처리 (plan/build)
├─ run-review.sh               # 카드의 build PR 자동 리뷰 (review)
├─ detect-cards.sh             # 대상 카드 탐지 (plan/build/review)
├─ loop-plan.sh                # plan 루프
├─ loop-build.sh               # build 루프
├─ loop-review.sh              # review 루프 (PR 자동 리뷰)
├─ work.env                    # 대상 repo로 복사할 시크릿 (gitignore)
├─ card-envs/                  # 카드 전용 env(<KEY>.env, 평문 600) (gitignore, 런타임 생성)
├─ repos/                      # 카드별 clone (gitignore)
├─ loop-*.log                  # 루프 로그 (gitignore)
├─ run-cycle.js                # 한 사이클: 모든 프로젝트 순회 detect→실행 (루프가 호출)
├─ append-summary.js           # 완료 요약을 설명 ADF 에 안전 append(기존 이미지/노드 보존)
├─ render-claude-stream.js     # claude stream-json → 사람이 읽는 전사 + 결과 추출
├─ history.jsonl               # 처리 이력 JSONL (gitignore, 런타임 생성)
├─ loop-*.pid                  # 루프 pidfile (gitignore, 런타임 생성)
├─ claude-logs/                # 카드별 claude 상세 실행 로그 (gitignore, 런타임 생성)
└─ dashboard/
   ├─ server.js                # Express 백엔드 (라우팅·루프·Jira REST)
   ├─ lib.js                   # 순수 로직 + 프로젝트 스토어 (단위 테스트 대상)
   ├─ test/lib.test.js         # 단위 테스트 (node:test) — `npm test`
   ├─ package.json
   ├─ public/index.html        # React 대시보드 (CDN)
   ├─ projects.json            # 프로젝트 목록(설정) (gitignore)
   ├─ project-credentials.json # 프로젝트별 토큰, 권한 600 (gitignore)
   ├─ config.json/credentials.json  # (레거시) 최초 1회 projects.json 으로 마이그레이션
   └─ README.md
```

---

## 10. 보안

- `work.env`, `dashboard/config.json`, `dashboard/credentials.json`, `*.log`, `repos/`, `node_modules/`는
  `.gitignore`로 커밋에서 제외됩니다.
- `credentials.json`은 로컬 평문 저장(권한 600). 공용 PC에서는 사용을 피하세요.
- 대시보드는 로컬 전용입니다. 포트를 외부에 노출하지 마세요.
- `work.env`는 대상 repo로 복사되므로, 대상 repo의 `.gitignore`가 해당 파일명을 막는지 확인하세요(이중 안전).
- 추가로 매 실행 시 clone 의 `.git/info/exclude` 에 env 파일명과 `.env` 가 자동 등록되어, 대상 repo `.gitignore` 설정과 무관하게 로컬에서 추적/커밋이 차단됩니다(claude 프롬프트 지시에 의존하지 않는 구조적 방어).

---

## 11. 트러블슈팅

| 증상 | 원인 | 해결 |
|------|------|------|
| 대시보드에서 work.env "불러오기" 안 됨 | 서버가 옛 코드로 실행 중 | 서버 재시작(`npm start`) + 브라우저 하드 리프레시 |
| `claude: command not found` (루프 로그) | nohup 환경 PATH 문제/미설치 | `which claude` 확인, PATH 보정 또는 절대경로 |
| 카드 조회 에러 | Atlassian 이메일/토큰 미설정 | 자격증명 입력 |
| build가 매번 SKIP | 담당자 답변 코멘트 없음 | 카드에서 질문에 답변 |
| 상태가 DEV COMPLETED로 안 바뀜 | 워크플로우에 해당 transition 없음 | Jira 워크플로우 확인, 로그의 사유 확인 |
| 루프가 같은 카드 반복 처리 | plan 라벨/완료 상태 미반영 | 라벨/상태 전환이 됐는지 카드 확인 |
| 카드에 `claude-failed` 라벨이 붙음 | 연속 `MAX_RETRIES`회 실패 | 카드 코멘트의 오류 요약 확인 후 수동 처리, 재시도하려면 라벨 제거 + `repos/.state/<KEY>.fail` 삭제 |
| 카드 등록 시 "유효한 상위 업무를 선택하세요" | 상위-자식 계층 불일치(상위는 한 단계 위여야: 에픽>작업>하위작업) | 작업/스토리(레벨0) 하위로 두려면 이슈 타입을 '하위 작업'으로, 에픽(레벨1) 하위로 두려면 이슈 타입을 '작업' 등으로 두고 상위에 에픽 키 지정. 대시보드가 계층을 사전 검증해 안내합니다 |
| 대시보드 "중지됨"인데 실제 도는 중 | (해결됨) pidfile 기반 추적 | 백엔드 재시작 시 pidfile 로 자동 복구됨. 그래도 안 맞으면 `loop-*.pid` 의 pid 생존 여부 확인 |
| 작업은 됐는데 처리 이력에 안 남음 | (해결됨) stream-json 경로에서 `PIPESTATUS[1]` 을 세미콜론으로 나눠 읽어 `set -u` 로 record_history 전에 스크립트가 죽던 버그 | 수정됨(PIPESTATUS 를 배열로 1회 캡처). 과거 누락분은 `history.jsonl` 에 수동 보강 가능 |
| build 가 PR 없이 "성공"으로 기록됨 | claude 가 작업을 백그라운드로 미루고 PR 없이 턴 종료 | (해결됨) build 는 **PR URL 이 없으면 success 로 인정하지 않고 `incomplete`(재시도 대상)** 로 처리. build 프롬프트에 "동기 완료, 미루기 금지, PR 없으면 비정상 종료" 명시 |
| 처리 이력 "PR 브랜치" 열이 비어 있음(`–`) | (해결됨) 브랜치 추출이 `feature/` 접두사로 고정돼 `feat/`·`fix/` 등 다른 접두사 브랜치를 못 잡음 | 수정됨: PR URL 로 `gh pr view --json headRefName` 을 조회해 실제 head 브랜치 기록(접두사 무관), merge 경로도 동일. 과거 누락분은 PR URL 로 역산해 `history.jsonl` 백필 가능 |
| build 후 카드 본문 이미지가 깨짐(Jira·대시보드 모두 안 보임) | (해결됨) 완료 내역을 추가할 때 claude 가 설명을 markdown 으로 읽고 통째로 다시 써넣어, 붙여넣은 이미지 media 노드가 죽은 `external blob:` 참조로 재인코딩됨 | 수정됨: 완료 요약은 `SUMMARY_FILE` 에 저장하고 `append-summary.js` 가 설명 ADF 에 직접 append(기존 이미지/노드 보존). **단, 이미 깨진 blob 이미지는 복구 불가 — 작성자가 카드에 이미지를 다시 첨부해야 함** |
| build 완료인데 카드 설명에 '완료 내역' 이 안 기재됨 | (해결됨) ① `set -u` 환경에서 append 단계가 `${JIRA_SITE}` 를 기본값 없이 참조해 변수 미설정 시 그 줄에서 스크립트가 죽음 ② 대시보드 단건 실행(`scriptEnv`)이 `JIRA_SITE`·`ATLASSIAN_EMAIL`·`ATLASSIAN_TOKEN` 을 주입하지 않아 자격증명이 비어 append 가 생략됨 | 수정됨: append 블록의 모든 변수 참조를 `${VAR:-}` 로 안전화 + `scriptEnv`(단건 실행)에도 Jira REST 자격증명 주입. 누락된 과거 카드는 '리뷰 반영(rework)' 재실행으로 요약 재생성·기재 가능 |

---

## 12. 알려진 한계와 향후 개선

현재 구현은 정상 경로(happy path)에 최적화되어 있고, 다음은 보강 여지가 있습니다.
실행 가능한 형태의 작업 목록과 완료 기준은 [`TODO.md`](./TODO.md)에 있습니다.

> 📌 **문서 동기화 규칙**: TODO 항목을 구현 완료하거나 동작/설정/API가 바뀌면, 같은 변경 안에서
> 이 문서(`DOCUMENTATION.md`)와 관련 문서를 반드시 갱신해야 합니다. 상세 규칙은 [`CLAUDE.md`](./CLAUDE.md) 참고.


- ~~**멱등성**: PR/완료처리 중간 실패 시 중복 브랜치·PR 가능~~ → ✅ 구현됨: build 전 `git ls-remote`/`gh pr list` 가드로 기존 브랜치·PR 있으면 SKIP (4.1 참고).
- ~~**실패 처리**: 실패 카드가 무한 재시도~~ → ✅ 구현됨: 카드별 실패 카운터 + `MAX_RETRIES` 초과 시 `claude-failed` 라벨/실패 코멘트, detect JQL 에서 제외 (4.1/4.2 참고).
- ~~**clone 클린업**: build 시작 시 `git reset --hard`/`clean`으로 이전 잔여 상태 정리~~ → ✅ 구현됨: 매 실행 fetch 후 `reset --hard` + `clean -fd` + `reset --hard origin/<base>` 로 정렬 (4.1 step 4 참고).
- ~~**env 유출 방지**: 복사 직후 clone의 `.git/info/exclude`에 env 파일명 자동 추가~~ → ✅ 구현됨: env 복사 직후 `.git/info/exclude` 에 env 파일명·`.env` 자동 등록 (4.1 step 5 / 10 보안 참고).
- ~~**탐지 효율**: detect를 claude 대신 백엔드 Jira REST로 전환(빠르고 결정적)~~ → ✅ 구현됨: `/api/detect/:mode` REST 엔드포인트 + detect-cards.sh 가 `DASHBOARD_URL` 있으면 REST 우선, claude 폴백 (4.2/4.4 참고).
- ~~**답변 감지 명시 신호**: claude 판단 의존~~ → ✅ 구현됨: `claude-answered` 라벨(탐지 게이트) + 실제 답변 코멘트(실행 게이트) 이중 게이트, 카드 상태에 답변대기 단계 추가 (3/4.1/4.2 참고).
- ~~**알림**: PR/완료/실패 시 Slack·이메일 알림~~ → ✅ 구현됨(Slack): `SLACK_WEBHOOK_URL` 설정 시 처리 완료/실패 알림, 미설정 시 스킵 (4.1/8 참고). (이메일은 추후)
- ~~**영속성**: launchd/pm2로 재부팅 후 자동 재시작, pid를 디스크에 기록~~ → ✅ 구현됨: pidfile(`loop-*.pid`) 기반 상태 추적·복구·stale 정리, launchd/pm2 가이드 (7.4 참고).
- ~~**병렬 상한**: 동시에 처리하는 카드 수 제한~~ → ✅ 구현됨: `MAX_PARALLEL`(기본 3)로 루프 동시 실행 상한, 대시보드에서 설정 (4.3/5 참고).
- **PR 품질**: ✅ 핵심(테스트 있으면 통과까지 수정 후 PR, 없으면 빌드만) 구현됨 (4.1 PR 전 검증 참고). 남은 보강: 리뷰어·라벨 지정, Jira↔PR 양방향 링크.
- ~~**처리 이력**: 처리 카드/시각/결과/PR URL 기록~~ → ✅ 구현됨: `run-jira-claude.sh` 가 매 실행 결과를 `history.jsonl` 에 기록, `/api/history` + 대시보드 이력 표로 확인 (4.5/4.4 참고).
- ~~**트리거 정밀도**: `text ~ "claude-work"` 토큰화 오탐~~ → ✅ 구현됨: `TRIGGER_MODE=label`(기본)로 전용 `claude-work` 라벨 트리거, `text` 모드는 레거시 옵션 (1/3/4.2/5/7.3 참고).

---

*문서 기준: 현재 저장소 구현 상태.*
