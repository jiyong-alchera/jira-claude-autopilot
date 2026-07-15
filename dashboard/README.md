# Jira → Claude 자동화 대시보드

React(프론트) + Express(로컬 백엔드)로, workspace·repo·주기를 설정하고
plan/build 루프를 **시작/중지/모니터링**하는 로컬 웹 대시보드입니다.

## 구조

```
loop-work/
├─ run-jira-agent.sh   # 카드 1개 처리 (env 설정 주입 가능)
├─ detect-cards.sh      # 후보 카드 탐지 (env 설정 주입 가능)
├─ loop-plan.sh         # plan 루프
├─ loop-build.sh        # build 루프
└─ dashboard/
   ├─ server.js         # Express 백엔드
   ├─ public/index.html # React 대시보드 (빌드리스, CDN)
   ├─ config.json       # 설정 저장 (자동 생성)
   └─ credentials.json  # 토큰 저장 (자동 생성, 권한 600)
```

대시보드는 셸 스크립트를 **환경변수로 설정 주입**해 구동합니다.
(WORK_DIR, REPO_URL, BASE_BRANCH, ASSIGNEE_EMAIL/NAME, TRIGGER_TEXT, DONE_STATUS,
PLANNED_LABEL, PROJECT_KEY, ENV_SRC, CLONE_BASE, LOOP_INTERVAL, ANTHROPIC_API_KEY, GH_TOKEN)

특정 repo(kyb-api 등)에 묶이지 않고, 어떤 GitHub repo / Jira 프로젝트에도 설정만 바꿔 재사용할 수 있습니다.

## 실행

```bash
cd dashboard
npm install
npm start
# 브라우저에서 http://localhost:4317
```

## 화면

- **루프 제어**: plan/build 루프 시작·중지, 실행 상태(pid) 표시
- **프로젝트 설정**: GitHub repo, Jira 사이트, 프로젝트 키(workspace), 담당자, 트리거 텍스트, 완료 상태, 주기, env 경로, clone 베이스 등
- **자격증명**: Anthropic / GitHub / Atlassian 토큰을 로컬 저장 (입력란 비우면 기존 값 유지)
- **work.env 파일**: 대상 repo로 복사되는 env 파일을 대시보드에서 직접 불러와 편집·저장 (저장 시 `.bak` 백업)
- **카드 상태**: Atlassian REST 로 트리거 카드 목록과 단계(plan대기/build대기/완료) 표시
- **실시간 로그**: loop-plan.log / loop-build.log 자동 갱신(4초)

## 토큰이 실제로 쓰이는 곳

| 토큰 | 사용처 | 적용 방식 |
|------|--------|-----------|
| Anthropic API Key | 루프 안의 `claude` 실행 | `ANTHROPIC_API_KEY` 환경변수로 주입 |
| GitHub Token | clone / push / PR | `GH_TOKEN` 환경변수로 주입 (gh·git 자격증명) |
| Atlassian 이메일+토큰 | 대시보드 카드 상태 조회 | 백엔드가 Jira REST(Basic auth) 호출 |

> 참고: 루프 안에서 `claude` 가 Jira에 코멘트/상태 전환을 하는 부분은 여전히
> Claude Code 의 **Atlassian MCP(OAuth)** 인증을 사용합니다(`claude mcp add atlassian`).
> 대시보드에 넣은 Atlassian 토큰은 대시보드 자체의 카드 조회용입니다.

## 보안 주의

- `credentials.json` 은 로컬 평문 저장(권한 600)입니다. 공유 PC에서는 사용을 피하세요.
- `.gitignore` 에 config/credentials/로그가 포함되어 있어 커밋되지 않습니다.
- 이 서버는 로컬 전용입니다. 외부에 포트를 노출하지 마세요.
