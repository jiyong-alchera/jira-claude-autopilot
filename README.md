# jira-claude-autopilot

Jira 카드를 자동 탐지해 **Claude로 개발 → PR 생성 → 카드 완료처리**까지 반자동으로 수행하는
루프 자동화 도구와, 이를 설정·제어·모니터링하는 로컬 웹 대시보드입니다.

특정 repo나 Jira 프로젝트에 묶이지 않고, **설정만 바꾸면 어떤 GitHub repo / Jira 프로젝트에도** 재사용할 수 있습니다.

## 동작 개요

```
[Jira 카드: claude-work 라벨 + 담당자=나 + 상태≠완료]
   │  plan 루프  →  Claude가 카드 검토 → 질문 코멘트 + planned 라벨
   ▼
[질문 답변 후]
   │  build 루프 →  답변 반영 개발 → 브랜치/커밋/푸시 → base 브랜치로 PR
   │             →  카드에 완료 요약 기입 → 완료 상태로 전환(탐지 제외)
```

## 구성

| 경로 | 역할 |
|------|------|
| `run-jira-claude.sh` | 카드 1개를 plan/build 로 처리 (카드별 `repos/<repo>-<키>` 디렉토리, 병렬) |
| `detect-cards.sh` | JQL 로 plan/build 대상 카드 탐지 (claude + Atlassian MCP) |
| `loop-plan.sh` / `loop-build.sh` | 주기적으로 탐지 후 카드별 병렬 실행 |
| `dashboard/` | React + Express 로컬 대시보드 (설정·토큰·제어·모니터링·work.env 편집) |
| `LOOP-GUIDE.md` | 루프 사용 가이드 |

## 빠른 시작

대시보드로 운용하는 것을 권장합니다:

```bash
cd dashboard
npm install
npm start          # http://localhost:4317  (프론트 수정 시 브라우저 자동 새로고침)
npm run dev        # 개발 모드: 백엔드 자동 재시작(nodemon) + 라이브 리로드
```

대시보드에서 1) 자격증명 입력 → 2) 프로젝트 설정(대상 repo·Jira 프로젝트 등) → 3) work.env 편집 →
4) 루프 시작 → 5) 카드 상태·로그 모니터링.

수동(CLI) 실행은 `LOOP-GUIDE.md` 참고.

## 사전 준비

- `claude` (Claude Code CLI) 설치 + 로그인, `claude mcp add atlassian` 인증
- `gh auth login` (PR 생성용)
- Node.js ≥ 18 (대시보드)

## 설정 항목 (환경변수 / 대시보드 공통)

`REPO_URL`, `BASE_BRANCH`, `PROJECT_KEY`, `ASSIGNEE_EMAIL`, `ASSIGNEE_NAME`,
`TRIGGER_MODE`(기본 label), `TRIGGER_LABEL`(기본 claude-work), `TRIGGER_TEXT`(text 모드 레거시),
`DONE_STATUS`(기본 DEV COMPLETED), `PLANNED_LABEL`(기본 claude-planned),
`ANSWERED_LABEL`(기본 claude-answered), `FAILED_LABEL`(기본 claude-failed), `MAX_RETRIES`(기본 3),
`ENV_SRC`(기본 work.env), `CLONE_BASE`(기본 repos/), `LOOP_INTERVAL`(기본 3600),
`MAX_PARALLEL`(기본 3), `TEST_CMD`/`BUILD_CMD`(미설정 시 자동 감지),
`ANTHROPIC_API_KEY`, `GH_TOKEN`, `SLACK_WEBHOOK_URL`(설정 시 처리 완료/실패 알림)

## 보안

- `work.env`, `dashboard/config.json`, `dashboard/credentials.json`, 로그, `repos/`, `node_modules/` 는
  `.gitignore` 로 커밋에서 제외됩니다.
- 대시보드는 로컬 전용입니다. 포트를 외부에 노출하지 마세요.
