# Jira → Claude 루프 자동화 가이드

`claude-work` 라벨(기본 label 모드)이 붙고 본인에게 할당된 Jira 카드를 **한 시간마다** 자동 탐지해,
plan(질문) → build(개발·PR·완료처리) 두 루프로 처리합니다. 대상 repo·Jira 프로젝트는
설정(환경변수 또는 대시보드)으로 지정하며, 특정 repo에 묶이지 않는 범용 도구입니다.

## 구성 파일

| 파일 | 역할 |
|------|------|
| `run-jira-claude.sh` | 카드 1개를 plan 또는 build 로 처리 (카드별 `repos/<repo이름>-<키>` 디렉토리, 병렬 가능) |
| `detect-cards.sh` | JQL 로 plan/build 대상 카드 키 목록을 탐지 (claude + Atlassian MCP) |
| `loop-plan.sh` | 1시간마다 plan 대상 탐지 → 카드별 병렬 plan 실행 |
| `loop-build.sh` | 1시간마다 build 대상 탐지 → 카드별 병렬 build 실행 |

## 상태 머신 (카드가 흐르는 단계)

```
[신규 카드: claude-work 라벨 + 담당자=나 + 상태≠DEV COMPLETED, claude-planned 라벨 없음]
        │  loop-plan  →  질문 코멘트 작성(+답변 후 claude-answered 라벨 요청) + 'claude-planned' 라벨 추가
        ▼
[claude-planned + claude-answered 라벨 있음]
        │  loop-build →  (라벨/답변 없으면 SKIP, 다음 주기 재시도)
        │             →  답변 있으면 개발 → 브랜치/커밋/푸시 → base 브랜치로 PR
        │             →  완료 요약 기입(label 모드: 카드 설명 하단) → 상태를 DEV COMPLETED 로 전환
        ▼
[DEV COMPLETED] → 두 루프 모두 탐지에서 자동 제외
```

- **plan 중복 방지**: `claude-planned` 라벨이 붙으면 plan 루프가 다시 잡지 않음.
- **build 답변 대기**: 답변 전이면 build 가 `SKIP` 하고 종료 → 다음 주기 재시도.
- **완료 제외**: `DEV COMPLETED` 상태는 JQL `status != "DEV COMPLETED"` 로 두 루프에서 제외.

## 실행

두 루프를 각각 백그라운드로 띄웁니다(서로 독립 프로세스).
대시보드로 띄우는 게 편하지만, 수동으로 띄울 땐 대상 repo 등을 환경변수로 지정합니다:

```bash
cd <작업폴더>   # 스크립트가 있는 폴더
chmod +x run-jira-claude.sh detect-cards.sh loop-plan.sh loop-build.sh

export REPO_URL="https://github.com/Org/repo.git"
export BASE_BRANCH="main"
export PROJECT_KEY="PROJ"
# (선택) 엔진/모델 — 비우면 claude, 엔진 기본 모델 사용
export ENGINE="claude"   # claude | codex | gemini
export MODEL=""          # 예: opus / gpt-5-codex / gemini-2.5-pro
# (필요시) ASSIGNEE_EMAIL, ASSIGNEE_NAME, ENV_SRC, CLONE_BASE 등도 export

nohup ./loop-plan.sh  > /dev/null 2>&1 &
nohup ./loop-build.sh > /dev/null 2>&1 &
```

진행 상황 확인:

```bash
tail -f loop-plan.log      # plan 루프 로그
tail -f loop-build.log     # build 루프 로그
jobs -l                    # 실행 중인 루프 확인
```

주기 변경(예: 30분):

```bash
LOOP_INTERVAL=1800 nohup ./loop-plan.sh > /dev/null 2>&1 &
```

종료:

```bash
pkill -f loop-plan.sh
pkill -f loop-build.sh
```

## 병렬 동작

- 한 주기에 여러 카드가 탐지되면, 카드마다 `repos/<repo이름>-<카드키>` 디렉토리에서 **동시에** 실행됩니다.
  (예: `repos/myrepo-PROJ-765`, `repos/myrepo-PROJ-770` …)
- 각 카드가 독립 디렉토리라 git 작업이 서로 충돌하지 않습니다.

## 사전 준비 (필수)

- `claude` (Claude Code CLI) 설치 + 로그인
- `claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp` + `/mcp` 인증
- `gh auth login` (PR 생성용)

## 주의사항

- **DEV COMPLETED**: Jira 워크플로우에 이 상태로 가는 transition 이 실제로 있어야 전환됩니다.
  없으면 build 단계에서 사유를 출력하니 로그를 확인하세요.
- **탐지 비용**: 매 주기 detect-cards 가 `claude` 를 1회 호출합니다(plan/build 각각). 1시간 주기라 부담은 작습니다.
- **env 파일(`work.env`)**: 대상 repo로 복사되는 시크릿 파일입니다. 절대 커밋되지 않도록 `.gitignore` 가 `*.env` 를 제외합니다.
- **트리거 방식**: 기본은 `claude-work` **라벨**(`TRIGGER_MODE=label`)입니다. 텍스트 검색(`text ~`)은 토큰화 오탐이 있어 레거시(`TRIGGER_MODE=text`)로만 남겨두었습니다. 어느 모드든 각 카드 처리 시 claude 가 트리거 충족 여부를 다시 확인합니다.
