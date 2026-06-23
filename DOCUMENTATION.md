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
      │         - 완료 요약을 카드에 기입(label 모드: 코멘트 / text 모드: 트리거 텍스트 바로 위)
      │         - 카드 상태를 DEV COMPLETED 로 전환
      ▼
[완료]  DEV COMPLETED → JQL `status != "DEV COMPLETED"` 로 두 루프에서 자동 제외
```

상태 구분에 쓰이는 신호:

| 신호 | 의미 | 누가 설정 |
|------|------|-----------|
| `claude-work` 라벨(기본) 또는 트리거 텍스트(레거시) | 자동화 대상 카드 | 사람(또는 Claude가 카드 작성 시) |
| `claude-planned` 라벨 | plan 완료(질문 작성됨) | plan 단계의 Claude |
| `claude-answered` 라벨 | 담당자 답변 완료 명시 신호(build 진입 게이트 ①) | 사람(담당자) |
| 담당자 답변 코멘트 | 실제 답변 존재(build 진입 게이트 ②) | 사람(담당자) |
| `DEV COMPLETED` 상태 | 처리 완료, 탐지 제외 | build 단계의 Claude |
| `claude-failed` 라벨 | 연속 실패 N회 초과 → 탐지 제외(수동 확인 필요) | 실패 처리 로직(Claude) |

이 설계의 핵심 효과:
- **plan 중복 방지**: 라벨이 붙으면 plan 탐지 JQL에서 제외됨.
- **답변 대기(이중 게이트)**: `claude-answered` 라벨이 없으면 detect JQL에서 build 후보로 잡히지 않고(탐지 게이트), 라벨이 있어도 실제 답변 코멘트가 없으면 build가 스스로 SKIP(실행 게이트) → 다음 주기 재시도.
- **완료 제외**: 상태가 완료로 바뀌면 두 루프 모두에서 빠짐.

---

## 4. 구성 요소 상세

### 4.1 run-jira-claude.sh (카드 1개 처리)

카드 하나를 plan 또는 build로 처리하는 핵심 스크립트.

사용: `REPO_URL=... ./run-jira-claude.sh <ISSUE-KEY> <plan|build>`

처리 순서:
1. 설정을 환경변수에서 읽음(없으면 기본값). `REPO_URL`은 필수 — 없으면 에러 종료.
2. `REPO_NAME`을 `REPO_URL`에서 자동 도출. 작업 디렉토리는 `CLONE_BASE/<REPO_NAME>-<ISSUE_KEY>`.
3. 디렉토리가 없으면 `git clone`, 있으면 재사용.
4. `fetch --prune` 후 **클린업**(`git reset --hard` + `git clean -fd`) → `BASE_BRANCH` checkout → `git reset --hard origin/<BASE_BRANCH>` 로 정렬. dir 재사용 시 이전 잔여 변경/브랜치로 checkout 이 막히는 문제를 방지(`git pull` 대신 결정적 정렬).
5. `ENV_SRC`(기본 `work.env`)를 clone 디렉토리로 복사하고, **clone 의 `.git/info/exclude` 에 env 파일명과 `.env` 를 자동 등록**해 추적/커밋을 구조적으로 차단(프롬프트 의존 제거, repo 에 커밋되지 않는 로컬 전용 ignore).
6. clone 디렉토리로 `cd` 후 `claude -p "<프롬프트>"` 실행.
   - **plan 프롬프트**: 담당자·트리거(`claude-work` 라벨 또는 텍스트)·상태 조건을 먼저 확인하고, 충족 시 질문 코멘트 작성 + `claude-planned` 라벨 추가.
   - **build 프롬프트**: 진입 게이트(둘 다 필요) — (a) `claude-answered` 라벨, (b) 담당자 실제 답변 코멘트 — 하나라도 없으면 `SKIP: awaiting answers`. 통과 시 구현 → **PR 전 검증** → 브랜치/커밋/푸시 → PR → 완료 요약 기입 → 상태 전환. env 파일은 절대 커밋 금지 지시 포함.
   - **PR 전 검증(#10)**: 테스트 수단(`TEST_CMD` 또는 자동 감지)이 있으면 실행하고 **통과할 때까지 수정 반복**(불가 시 PR 없이 비정상 종료). 테스트가 없으면 빌드/컴파일(`BUILD_CMD` 또는 자동 감지)만 시도(빌드 수단도 없으면 건너뜀). 검증 통과 시에만 PR 단계로 진행.
   - **멱등성 가드(build 전용)**: claude 실행 전에 `git ls-remote` 로 `feature/<KEY>-*` 원격 브랜치를, `gh pr list` 로 해당 이슈 키의 열린 PR 을 점검한다. 하나라도 있으면 `SKIP: 이미 처리됨` 을 출력하고 종료해 중복 브랜치/PR 생성을 막는다(중간 실패 후 재시도 안전).
7. **실패 재시도/백오프(plan·build 공통)**: claude 가 0이 아닌 코드로 종료하면 실패로 보고 카드별 실패 카운터(`<CLONE_BASE>/.state/<KEY>.fail`)를 증가시킨다. `MAX_RETRIES`(기본 3) 초과 시 claude 로 `claude-failed` 라벨 추가 + 담당자 멘션 실패 코멘트(마지막 오류 로그 요약 포함)를 남긴다. 성공하면 카운터를 리셋한다. build 의 `SKIP: awaiting answers` 는 정상 종료(0)라 실패로 집계되지 않는다.

매 실행 종료 시 결과(성공/스킵/실패 + PR URL·브랜치)를 `HISTORY_FILE`(기본 `history.jsonl`)에 JSONL 한 줄로 기록한다.

**Slack 알림(#6)**: `SLACK_WEBHOOK_URL` 이 설정돼 있으면 카드가 처리 완료(success)될 때 `✅ [KEY] phase 처리 완료 · PR · branch` 메시지를, 최대 재시도 초과 실패 시 `❌ … 수동 확인 필요` 메시지를 Slack 으로 보낸다. 미설정이면 알림은 스킵된다(스킵/답변대기 케이스는 알리지 않음).

도구 의존성: `git`, `claude` (build 단계는 추가로 `gh`).

### 4.2 detect-cards.sh (대상 카드 탐지)

처리 대상 카드 키만 한 줄에 하나씩 출력. **`DASHBOARD_URL` 이 주입되어 있으면 백엔드 `/api/detect/<mode>`(Jira REST)를 우선 호출**해 결정적·저비용으로 탐지하고, 실패 시 `claude`(+Atlassian MCP) JQL 실행으로 폴백한다.

- 트리거 절은 모드에 따라: label 모드(기본) `labels = "claude-work"`, text 모드(레거시) `text ~ "claude-work"`.
- **plan 대상 JQL**(label 모드): `assignee = currentUser() AND status != "DEV COMPLETED" AND labels = "claude-work" AND (labels != "claude-planned" OR labels IS EMPTY) AND (labels != "claude-failed" OR labels IS EMPTY)`
- **build 대상 JQL**(label 모드): `assignee = currentUser() AND status != "DEV COMPLETED" AND labels = "claude-work" AND labels = "claude-planned" AND labels = "claude-answered" AND (labels != "claude-failed" OR labels IS EMPTY)`
- build 후보는 `claude-planned` **그리고** `claude-answered` 라벨이 둘 다 있어야 한다(담당자 답변 완료 신호).
- 두 JQL 모두 `claude-failed` 라벨이 붙은(반복 실패) 카드를 제외해 무한 재시도를 막는다.
- `PROJECT_KEY`가 설정되면 `AND project = "<KEY>"` 필터 추가.
- claude 출력에서 `이슈키(PROJ-숫자)` 패턴만 추출해 잡텍스트를 제거.

### 4.3 loop-plan.sh / loop-build.sh (주기 루프)

- 시작 즉시 1회 탐지·처리 후, 이후 **인터벌 경계(정시)에 정렬**해 반복.
- 한 주기에 여러 카드가 잡히면 카드별 `run-jira-claude.sh`를 백그라운드로 실행하되, **동시 실행 수를 `MAX_PARALLEL`(기본 3)로 제한**(실행 중 작업이 상한 미만이 될 때까지 대기)하고 주기 끝에 `wait`로 모두 완료 대기.
- 진행 상황을 각각 `loop-plan.log` / `loop-build.log`에 기록.
- 주기는 `LOOP_INTERVAL`(초, 기본 3600)로 조정.
- **즉시 1회 실행(`RUN_ONCE=1`)**: 스케줄을 기다리지 않고 detect→처리를 한 번만 수행하고 종료(대기 없음). 대시보드 "지금 실행" 버튼이 이 모드로 루프 스크립트를 띄우며, 출력은 동일한 `loop-<type>.log`에 쌓여 로그 화면에 바로 보입니다. 스케줄 루프와 동시에 같은 카드를 처리하지 않도록 `run-jira-claude.sh`가 카드별 락(`repos/.state/<KEY>.lock`)을 사용합니다.

### 4.4 대시보드 백엔드 (dashboard/server.js, Express)

기본 포트 `4317`. 주요 API:

| 메서드 | 경로 | 역할 |
|--------|------|------|
| GET | `/api/health` | 헬스체크 |
| GET / POST | `/api/config` | 설정 조회/저장 (`config.json`) |
| GET / POST | `/api/credentials` | 토큰 저장/조회 (GET은 마스킹) |
| GET | `/api/loops/status` | plan/build 루프 실행 상태(pid) |
| POST | `/api/loops/:type/start` · `/stop` | 루프 시작/중지 (프로세스 spawn/kill) |
| POST | `/api/loops/:type/run-once` | 준비된 전체 카드 즉시 1회 실행(스케줄 무시, 같은 로그에 기록) |
| POST | `/api/cards/:key/run` | 특정 카드 1건만 즉시 실행(`phase`=plan\|build, `loop-<phase>.log` 에 기록) |
| GET | `/api/logs/:type` | 로그 tail (마지막 N줄) |
| POST | `/api/logs/:type/clear` | 로그 파일 비우기(truncate) |
| GET | `/api/cards` | Jira REST로 트리거 카드 목록+단계 |
| GET | `/api/detect/:mode` | Jira REST로 plan/build 후보 키 조회(루프의 REST 탐지 대상) |
| GET | `/api/history` | 처리 이력(`history.jsonl`) 최신순 조회 |
| GET | `/api/livereload` | 라이브 리로드용 SSE 스트림(프론트 파일 변경 시 reload 이벤트 푸시) |
| GET | `/api/jira/meta` | 카드 등록용 메타(프로젝트 이슈 타입 + 에픽 목록) |
| POST | `/api/jira/issue` | Jira 카드 생성(요약·설명·이슈타입·상위키·라벨·할당·이미지 첨부) |
| POST | `/api/ai/refine-description` | 러프 설명을 Claude 로 체계적 설명(배경/요구사항/AC)으로 변환 |
| GET | `/api/jira/issue/:key` | 카드 상세(원문 설명 + 코멘트, ADF→텍스트 변환) |
| POST | `/api/jira/issue/:key/comment` | 카드에 답변 코멘트 작성(옵션: `replyTo` 인용 답글, `claude-answered` 라벨 추가) |
| GET / POST | `/api/env` | work.env 읽기/쓰기 (저장 시 `.bak` 백업) |

루프를 띄울 때 백엔드가 설정·토큰을 **환경변수로 주입**합니다(아래 [설정 레퍼런스](#5-설정-레퍼런스)).

### 4.5 대시보드 프론트 (dashboard/public/index.html, React)

빌드 도구 없이 CDN(React + Tailwind)으로 동작하는 단일 페이지. 섹션 구성:

- **루프 제어**: plan/build 시작·중지, **전체 실행**(준비된 모든 카드 즉시 1회), 실행 상태(pid). "전체 실행"은 스케줄과 무관하게 detect→처리 한 사이클을 돌려 같은 로그에 출력합니다.
- **프로젝트 설정**: repo·Jira·담당자·트리거·완료상태·라벨·주기·env경로·clone베이스 등 → 저장 시 `config.json`.
- **자격증명**: Anthropic / GitHub / Atlassian 토큰 + Slack Incoming Webhook 저장(마스킹, 빈 입력은 기존값 유지). 각 입력란의 `ⓘ` 아이콘에 마우스를 올리면 해당 토큰의 용도 설명 말풍선이 표시됩니다.
- **work.env 파일**: env 내용을 불러와 편집·저장(저장 시 `.bak` 백업).
- **Jira 카드 등록**: 이슈 타입(프로젝트 메타에서 조회)·요약·설명을 입력해 카드를 생성. 상위는 **에픽 드롭다운**(프로젝트 에픽 목록) 또는 **상위 키 직접 입력**(우선 적용)으로 지정(`fields.parent`). 생성 전 **계층을 검증**해 상위가 자식보다 한 단계 위(에픽>작업>하위작업)가 아니면 실행 가능한 안내를 줍니다(예: 작업 하위에 두려면 '하위 작업' 타입 선택). 체크박스로 트리거 라벨(`claude-work`) 추가와 본인 할당을 선택 — 둘 다 켜면 생성 즉시 자동화(plan) 대상이 됩니다. 설명은 ADF 로 변환되어 전송됩니다.
  - **✨ Claude로 정리**: 러프하게 적은 설명을 `claude` 가 "배경/목적 · 요구사항 · 완료조건(AC)" 구조의 마크다운으로 변환해 설명 필드에 채웁니다(`/api/ai/refine-description`). 입력에 없는 내용은 "(확인 필요)" 로 표시합니다.
  - **이미지 첨부**: 파일 선택(이미지, 복수 가능) 후 카드 생성 시 Jira 첨부(`/rest/api/3/issue/{key}/attachments`, `X-Atlassian-Token: no-check`)로 업로드됩니다. 프론트가 base64 로 전송하고 백엔드가 multipart 로 변환(요청 본문 한도 25MB).
- **카드 상태**: 트리거 카드의 단계(plan대기/답변대기/build대기/실패/완료) 표. **행을 클릭하면 아래로 펼쳐져** 원문 설명과 코멘트(특히 plan 단계의 질문)를 보고, 그 자리에서 **답변을 코멘트로 등록**할 수 있습니다. "답변 완료로 표시" 체크 시 `claude-answered` 라벨도 함께 추가되어 다음 주기에 build 가 진행됩니다.
  - **이 카드만 즉시 실행**: 펼친 패널 상단의 `plan`/`build` 버튼으로 detect 를 거치지 않고 **그 카드 1건만** 즉시 실행합니다(`/api/cards/:key/run`). 출력은 `loop-<phase>.log` 에 기록되어 실시간 로그에서 진행을 확인할 수 있습니다. (루프 제어의 "전체 실행"은 준비된 모든 카드를 도는 반면, 이건 단건만 실행)
  - **코멘트 답글(인용)**: 각 코멘트의 "↳ 답글" 을 누르면 그 코멘트를 대상으로 답변을 작성합니다. Jira 이슈 코멘트는 구조적으로 평면(스레드 미지원)이라, 답글은 **원문 인용(blockquote) + 작성자 @멘션**을 포함한 새 코멘트로 등록됩니다(Jira UI 의 "인용 답글"과 동일 방식). 표시할 때 인용 줄은 `> ` 로 보여 스레드처럼 구분됩니다.
- **처리 이력**: `history.jsonl` 기반 최근 처리 내역(시각·키·단계·결과·PR·브랜치) 표. 4초마다 갱신.
- **실시간 로그**: 4초마다 로그 자동 갱신.
- **실시간 로그 비우기**: 각 로그(`loop-plan.log`/`loop-build.log`) 우측의 "비우기" 버튼으로 파일을 truncate 합니다(확인창 후 실행). 루프가 돌고 있어도 다음 출력부터 다시 쌓입니다.
- **라이브 리로드**: 서버가 `public/` 변경을 감시해 SSE(`/api/livereload`)로 reload 신호를 보내면 브라우저가 자동 새로고침합니다. 백엔드가 재시작되면 SSE 재연결 시 한 번 더 새로고침합니다. `DASHBOARD_NO_LIVERELOAD=1` 로 끌 수 있습니다.

---

## 5. 설정 레퍼런스

모든 설정은 환경변수(셸) 또는 `config.json`(대시보드)으로 지정합니다. 대시보드는 이 값들을 루프에 환경변수로 주입합니다.

| 키 | 환경변수 | 기본값 | 설명 |
|----|----------|--------|------|
| 작업 폴더 | `WORK_DIR` | 스크립트 폴더 | 기준 작업 폴더 |
| 대상 repo | `REPO_URL` | (없음, 필수) | clone 할 GitHub repo URL |
| base 브랜치 | `BASE_BRANCH` | `main` | PR 대상/체크아웃 브랜치 |
| env 파일 | `ENV_SRC` | `<WORK_DIR>/work.env` | clone 디렉토리로 복사할 env |
| clone 베이스 | `CLONE_BASE` | `<WORK_DIR>/repos` | clone 들이 모이는 폴더 |
| Jira 사이트 | (대시보드 `jiraSite`) | (없음) | 예: `team.atlassian.net` (카드 조회용) |
| 프로젝트 키 | `PROJECT_KEY` | (없음) | 예: `PROJ` (JQL 프로젝트 필터) |
| 담당자 이메일 | `ASSIGNEE_EMAIL` | (없음) | 카드 할당자 확인용 |
| 담당자 이름 | `ASSIGNEE_NAME` | `담당자` | 코멘트 멘션용 |
| 트리거 방식 | `TRIGGER_MODE` | `label` | `label`(권장) 또는 `text`(레거시) |
| 트리거 라벨 | `TRIGGER_LABEL` | `claude-work` | label 모드에서 자동화 대상 표시 라벨 |
| 트리거 텍스트 | `TRIGGER_TEXT` | `claude-work` | text 모드(레거시)에서 대상 표시 키워드 |
| 완료 상태 | `DONE_STATUS` | `DEV COMPLETED` | 완료 후 전환할 Jira 상태명 |
| plan 라벨 | `PLANNED_LABEL` | `claude-planned` | plan 완료 표시 라벨 |
| 답변 라벨 | `ANSWERED_LABEL` | `claude-answered` | 담당자 답변 완료 신호(build 진입 게이트) |
| 실패 라벨 | `FAILED_LABEL` | `claude-failed` | 반복 실패 표시 라벨(탐지 제외) |
| 최대 재시도 | `MAX_RETRIES` | `3` | 연속 실패 N회 초과 시 실패 처리 |
| 테스트 명령 | `TEST_CMD` | (없음=자동 감지) | PR 전 실행할 테스트 명령 |
| 빌드 명령 | `BUILD_CMD` | (없음=자동 감지) | 테스트 없을 때 시도할 빌드 명령 |
| 이력 파일 | `HISTORY_FILE` | `<WORK_DIR>/history.jsonl` | 처리 이력 기록 파일(대시보드 `/api/history` 가 읽음) |
| Slack 웹훅 | `SLACK_WEBHOOK_URL` | (없음) | 설정 시 처리 완료/실패 알림 발송, 비면 스킵 |
| 주기(초) | `LOOP_INTERVAL` | `3600` | 루프 주기 |
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
③ work.env 편집 → ④ 루프 시작 → ⑤ 카드 상태·로그 모니터링.

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
├─ detect-cards.sh             # 대상 카드 탐지
├─ loop-plan.sh                # plan 루프
├─ loop-build.sh               # build 루프
├─ work.env                    # 대상 repo로 복사할 시크릿 (gitignore)
├─ repos/                      # 카드별 clone (gitignore)
├─ loop-*.log                  # 루프 로그 (gitignore)
├─ history.jsonl               # 처리 이력 JSONL (gitignore, 런타임 생성)
├─ loop-*.pid                  # 루프 pidfile (gitignore, 런타임 생성)
└─ dashboard/
   ├─ server.js                # Express 백엔드
   ├─ package.json
   ├─ public/index.html        # React 대시보드 (CDN)
   ├─ config.json              # 설정 저장 (gitignore)
   ├─ credentials.json         # 토큰 저장, 권한 600 (gitignore)
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
