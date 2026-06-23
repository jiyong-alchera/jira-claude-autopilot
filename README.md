# jira-claude-autopilot

Jira 카드를 자동 탐지해 **Claude로 개발 → PR 생성 → 카드 완료처리**까지 반자동으로 수행하는
루프 자동화 도구와, 이를 설정·제어·모니터링하는 로컬 웹 대시보드입니다.

특정 repo나 Jira 프로젝트에 묶이지 않고, **설정만 바꾸면 어떤 GitHub repo / Jira 프로젝트에도** 재사용할 수 있습니다.
**여러 프로젝트를 동시에 등록·운용**할 수 있으며(각 프로젝트가 자체 repo·Jira·자격증명 보유), 한 루프가 매 주기 모든 프로젝트를 순회합니다.

> 상세 동작·설정·API·트러블슈팅은 [`DOCUMENTATION.md`](./DOCUMENTATION.md), CLI 운용은 [`LOOP-GUIDE.md`](./LOOP-GUIDE.md) 참고.

## 동작 개요

```
[Jira 카드: claude-work 라벨 + 담당자=나 + 상태≠완료]
   │  plan 루프  →  Claude가 카드 검토 → 질문 코멘트 + claude-planned 라벨
   ▼
[담당자 답변 + claude-answered 라벨]   ← 대시보드에서 카드 펼쳐 답변/라벨 한 번에
   │  build 루프 →  진입 게이트(라벨+답변) 통과 시 개발 → (테스트 있으면 통과까지 수정)
   │             →  브랜치/커밋/푸시 → base 브랜치로 PR
   │             →  완료 요약 기입(라벨모드: 코멘트) → 완료 상태로 전환(탐지 제외)
```

- 중간 실패는 카드별 재시도/백오프 후 `claude-failed` 라벨로 격리, 완료/실패는 Slack 알림(설정 시).
- 탐지는 대시보드 백엔드의 Jira REST 를 우선 사용하고(결정적·저비용), 실패 시 claude(+MCP)로 폴백합니다.

## 구성

| 경로 | 역할 |
|------|------|
| `run-jira-claude.sh` | 카드 1개를 plan/build 로 처리 (카드별 `repos/<repo>-<키>` 디렉토리, 병렬·멱등성 락) |
| `detect-cards.sh` | 대상 카드 탐지 (REST 우선, claude+MCP 폴백) |
| `loop-plan.sh` / `loop-build.sh` | 주기적으로 탐지 후 카드별 병렬 실행(동시 상한), `RUN_ONCE` 즉시 1회 지원 |
| `render-claude-stream.js` | claude stream-json → 사람이 읽는 실행 전사 + 결과 추출 |
| `dashboard/` | React + Express 로컬 대시보드 (설정·토큰·제어·모니터링·카드 등록/답변 등) |
| `LOOP-GUIDE.md` | 루프 사용 가이드 |

## 대시보드 주요 기능

- **루프 제어**: plan/build 시작·중지, **전체 즉시 실행**(준비된 모든 카드 1회), 실행 상태(pidfile 기반 — 백엔드 재시작 후에도 복구).
- **Jira 카드 등록**: 이슈 타입·상위(에픽 드롭다운/직접 키, 계층 사전검증)·이미지 첨부로 카드 생성, `claude-work` 라벨+본인 할당 옵션. **러프 설명을 Claude가 배경/요구사항/완료조건으로 정리**.
- **카드 상태**: 단계(plan대기/답변대기/build대기/실패/완료) 표. 행을 펼치면 원문·코멘트 열람, **답변(인용 답글) 작성 + claude-answered 라벨**, **이 카드만 즉시 실행**, **Claude 실행 로그**(도구 호출/메시지/결과, 3초 갱신) 확인.
- **처리 이력**: 처리한 카드/시각/결과/PR·브랜치 기록 표.
- **실시간 로그**: `loop-*.log` tail + 비우기. 모든 섹션은 접기/펼치기, 핫리로드(`npm run dev`) 지원.

## 빠른 시작

대시보드로 운용하는 것을 권장합니다:

```bash
cd dashboard
npm install
npm start          # http://localhost:4317  (프론트 수정 시 브라우저 자동 새로고침)
npm run dev        # 개발 모드: 백엔드 자동 재시작(nodemon) + 라이브 리로드
npm test           # 단위 테스트 (node:test, 무설치) — lib.js 순수 로직·프로젝트 스토어
```

대시보드에서 1) 자격증명 입력 → 2) 프로젝트 설정(대상 repo·Jira 프로젝트 등) → 3) work.env 편집 →
4) 루프 시작 → 5) 카드 상태·로그 모니터링.

수동(CLI) 실행은 `LOOP-GUIDE.md` 참고.

## 사전 준비

- `claude` (Claude Code CLI) 설치 + 로그인, `claude mcp add atlassian` 인증 (루프 내 Jira 작업용)
- `gh auth login` (PR 생성용)
- Node.js ≥ 18 (대시보드 + claude 실행 전사 렌더러)
- Atlassian 이메일 + API 토큰 (대시보드의 카드 조회·REST 탐지·카드 등록/답변용 — 자격증명 섹션에 입력)
- (선택) Slack Incoming Webhook (처리 완료/실패 알림)

## 설정 항목 (환경변수 / 대시보드 공통)

`REPO_URL`, `BASE_BRANCH`, `PROJECT_KEY`, `ASSIGNEE_EMAIL`, `ASSIGNEE_NAME`,
`TRIGGER_MODE`(기본 label), `TRIGGER_LABEL`(기본 claude-work), `TRIGGER_TEXT`(text 모드 레거시),
`DONE_STATUS`(기본 DEV COMPLETED), `PLANNED_LABEL`(기본 claude-planned),
`ANSWERED_LABEL`(기본 claude-answered), `FAILED_LABEL`(기본 claude-failed), `MAX_RETRIES`(기본 3),
`ENV_SRC`(기본 work.env), `CLONE_BASE`(기본 repos/), `LOOP_INTERVAL`(기본 3600),
`MAX_PARALLEL`(기본 3), `TEST_CMD`/`BUILD_CMD`(미설정 시 자동 감지),
`ANTHROPIC_API_KEY`, `GH_TOKEN`, `SLACK_WEBHOOK_URL`(설정 시 처리 완료/실패 알림)

## 보안

- `work.env`, `dashboard/config.json`, `dashboard/credentials.json`, `*.log`, `repos/`, `node_modules/`,
  `history.jsonl`, `loop-*.pid`, `claude-logs/` 는 `.gitignore` 로 커밋에서 제외됩니다.
- 토큰(Anthropic/GitHub/Atlassian/Slack)은 `dashboard/credentials.json`(권한 600)에 로컬 저장되며 UI 에선 마스킹됩니다.
- `work.env` 는 대상 repo 로 복사되며, clone 의 `.git/info/exclude` 에 자동 등록되어 실수로 커밋되지 않습니다.
- 대시보드는 로컬 전용입니다. 포트를 외부에 노출하지 마세요.
