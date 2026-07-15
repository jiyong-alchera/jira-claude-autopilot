# CLAUDE.md — 이 저장소에서 작업하는 Claude를 위한 규칙

이 파일은 jira-agent-autopilot 저장소에서 개발 작업을 수행하는 Claude(및 사람 기여자)가
반드시 따라야 하는 규칙을 정의합니다. Claude Code는 작업 시 이 파일을 자동으로 읽습니다.

## 프로젝트 개요

Jira 카드를 자동 탐지해 Claude로 개발 → PR → 카드 완료처리까지 수행하는 루프 자동화 도구 +
로컬 대시보드입니다. 상세는 `DOCUMENTATION.md` 참고.

## 🔒 필수 규칙 — 문서 동기화 (Documentation Sync)

**어떤 코드/동작 변경이든, 또는 `TODO.md` 항목을 구현 완료하면, 같은 변경 안에서 반드시 문서를 동기화한다.**

구체적으로:
1. 동작·설정·API·흐름이 바뀌면 `DOCUMENTATION.md`를 해당 부분에 맞게 갱신한다.
   - 설정 항목 변경 → "5. 설정 레퍼런스" 갱신
   - API 변경 → "4.4 대시보드 백엔드" 표 갱신
   - 흐름/상태 머신 변경 → "3. 동작 흐름과 상태 머신" 갱신
   - 새 한계/해결 → "11. 트러블슈팅" / "12. 알려진 한계" 갱신
2. 사용자 사용법이 바뀌면 `README.md` / `LOOP-GUIDE.md`도 함께 갱신한다.
3. `TODO.md` 항목을 완료했으면 해당 체크박스를 `[x]`로 바꾸고, 그 아래에
   `→ (완료 YYYY-MM-DD) 변경 요약 · PR 링크` 한 줄을 추가한다.
4. **문서 동기화가 포함되지 않은 변경은 "완료"로 간주하지 않는다.** 커밋/PR에 문서 변경을 포함한다.

## 작업 시 참고

- 변경 전 `TODO.md`에서 관련 항목과 완료 기준(AC)을 확인한다.
- 보안: `work.env`, `dashboard/credentials.json`, `dashboard/config.json`, `*.log`, `repos/`,
  `node_modules/` 는 절대 커밋하지 않는다(`.gitignore` 확인).
- 커밋 메시지에는 관련 Jira 이슈 키를 포함한다.

## 완료 체크리스트 (PR 전 자가 점검)

- [ ] 코드 변경 완료
- [ ] `DOCUMENTATION.md` 동기화
- [ ] (해당 시) `README.md` / `LOOP-GUIDE.md` 동기화
- [ ] (해당 시) `TODO.md` 체크박스 + 완료 메모 갱신
- [ ] 시크릿/제외 파일 미포함 확인
