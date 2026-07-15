// dashboard/test/lib.test.js — node:test 기반 단위 테스트 (무설치)
//   실행: npm test  (= node --test)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("../lib");

test("slugify", () => {
  assert.equal(lib.slugify("My Project"), "my-project");
  assert.equal(lib.slugify("EKYB"), "ekyb");
  assert.equal(lib.slugify("a__b  c"), "a-b-c");
  assert.equal(lib.slugify("--트림--"), "proj");  // 영숫자 없음 → 폴백
  assert.equal(lib.slugify(""), "proj");
});

test("triggerClause: label vs text", () => {
  assert.equal(lib.triggerClause({ triggerMode: "label", triggerLabel: "claude-work" }), 'labels = "claude-work"');
  assert.equal(lib.triggerClause({ triggerMode: "text", triggerText: "claude-work" }), 'text ~ "claude-work"');
});

test("detectJql: plan/build 게이트 + 제외 필터 + 프로젝트", () => {
  const cfg = { triggerMode: "label", triggerLabel: "cw", doneStatus: "DONE", plannedLabel: "P", answeredLabel: "A", failedLabel: "F", projectKey: "EKYB" };
  const plan = lib.detectJql("plan", cfg);
  assert.match(plan, /statusCategory != Done/);
  assert.match(plan, /status != "DONE"/);   // 설정 완료 상태명도 제외
  assert.match(plan, /labels = "cw"/);
  assert.match(plan, /\(labels != "P" OR labels IS EMPTY\)/);     // plan: planned 없음
  assert.match(plan, /\(labels != "F" OR labels IS EMPTY\)/);     // failed 제외
  assert.match(plan, /AND project = "EKYB"/);
  const build = lib.detectJql("build", cfg);
  assert.match(build, /labels = "P" AND labels = "A"/);           // build: planned+answered 둘 다
  assert.match(build, /\(labels != "claude-pr" OR labels IS EMPTY\)/);  // PR 올린 카드 제외
  assert.match(build, /\(labels != "F" OR labels IS EMPTY\)/);
});

test("detectJql: review = claude-pr(PR 올린) 카드 대상", () => {
  const cfg = { triggerMode: "label", triggerLabel: "cw", doneStatus: "DONE", plannedLabel: "P", answeredLabel: "A", failedLabel: "F", prOpenLabel: "claude-pr", projectKey: "EKYB" };
  const review = lib.detectJql("review", cfg);
  assert.match(review, /labels = "claude-pr"/);              // PR 올린 카드만
  assert.match(review, /statusCategory != Done/);
  assert.match(review, /labels = "cw"/);                     // 트리거 라벨 유지
  assert.doesNotMatch(review, /labels = "A"/);               // answered 게이트는 review 에 불필요
  assert.match(review, /AND project = "EKYB"/);
});

test("detectJql: 프로젝트 키 없으면 project 필터 없음", () => {
  const jql = lib.detectJql("plan", { triggerMode: "label", triggerLabel: "cw", doneStatus: "D", plannedLabel: "P", failedLabel: "F" });
  assert.doesNotMatch(jql, /project =/);
});

test("effectiveDoneStatuses: doneStatus ∪ 상태매핑 완료(done)", () => {
  const cfg = { doneStatus: "DEV COMPLETED", statusStageMap: { "QA READY": "done", "IN QA REVIEW": "done", "진행 중": "build-ready" } };
  const eff = lib.effectiveDoneStatuses(cfg);
  assert.deepEqual(eff.sort(), ["DEV COMPLETED", "IN QA REVIEW", "QA READY"].sort());
  // 매핑 완료 상태가 탐지 제외(status NOT IN)에 포함
  const jql = lib.detectJql("plan", { ...cfg, triggerMode: "label", triggerLabel: "cw", plannedLabel: "P", failedLabel: "F" });
  assert.match(jql, /status NOT IN \(/);
  assert.match(jql, /"QA READY"/);
  assert.match(jql, /"DEV COMPLETED"/);
});

test("doneStatusList: 쉼표 구분 복수 + 트림 + 빈값 제거, 배열도 수용", () => {
  assert.deepEqual(lib.doneStatusList({ doneStatus: "DEV COMPLETED" }), ["DEV COMPLETED"]);
  assert.deepEqual(lib.doneStatusList({ doneStatus: " DEV COMPLETED , Done ,, Closed " }), ["DEV COMPLETED", "Done", "Closed"]);
  assert.deepEqual(lib.doneStatusList({ doneStatus: ["A", " B "] }), ["A", "B"]);
  assert.deepEqual(lib.doneStatusList({ doneStatus: "" }), []);
  assert.deepEqual(lib.doneStatusList({}), []);
});

test("detectJql: 완료 상태 복수 → status NOT IN, 단일 → status !=", () => {
  const multi = lib.detectJql("plan", { triggerMode: "label", triggerLabel: "cw", doneStatus: "DEV COMPLETED, Done", plannedLabel: "P", failedLabel: "F" });
  assert.match(multi, /status NOT IN \("DEV COMPLETED", "Done"\)/);
  const single = lib.detectJql("plan", { triggerMode: "label", triggerLabel: "cw", doneStatus: "DEV COMPLETED", plannedLabel: "P", failedLabel: "F" });
  assert.match(single, /status != "DEV COMPLETED"/);
  assert.doesNotMatch(single, /NOT IN/);
  const none = lib.detectJql("plan", { triggerMode: "label", triggerLabel: "cw", doneStatus: "", plannedLabel: "P", failedLabel: "F" });
  assert.doesNotMatch(none, /status (!=|NOT IN)/);
});

test("adfToText: 문단/제목/불릿/인용/멘션/줄바꿈", () => {
  const doc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "줄1" }] },
    { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "항목" }] }] },
    { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: "인용" }] }] },
    { type: "paragraph", content: [{ type: "mention", attrs: { text: "@홍길동" } }, { type: "text", text: " 님" }] },
  ] };
  const t = lib.adfToText(doc);
  assert.match(t, /줄1/);
  assert.match(t, /• 항목/);
  assert.match(t, /> 인용/);
  assert.match(t, /@홍길동 님/);
});

test("adfToText: onMedia 콜백으로 media 노드 치환(이미지 인라인)", () => {
  const doc = { type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "앞" }] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "uuid-1", alt: "shot.png" } }] },
    { type: "paragraph", content: [{ type: "text", text: "뒤" }] },
  ] };
  assert.match(lib.adfToText(doc), /앞\n뒤/);                   // 콜백 없으면 media 무시(기존 동작)
  const t = lib.adfToText(doc, (a) => `<<${a.alt}>>`);
  assert.match(t, /<<shot\.png>>/);                              // 콜백으로 alt(=첨부 파일명) 치환
});

test("adfSegments: alt=첨부파일명 매칭 → 프록시 이미지", () => {
  const doc = { type: "doc", content: [
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "uuid-1", alt: "shot.png" } }] },
  ] };
  const segs = lib.adfSegments(doc, { "shot.png": { id: "777" } }, [{ id: "777", filename: "shot.png" }]);
  const img = segs.find((s) => s.type === "image");
  assert.equal(img.id, "777");
  assert.equal(img.filename, "shot.png");
});

test("adfSegments: alt 없는 미디어 → 순서 기반 첨부 폴백", () => {
  const doc = { type: "doc", content: [
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m1" } }] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "file", id: "m2" } }] },
  ] };
  const images = [{ id: "100", filename: "a.png" }, { id: "200", filename: "b.png" }];
  const segs = lib.adfSegments(doc, { "a.png": images[0], "b.png": images[1] }, images).filter((s) => s.type === "image");
  assert.deepEqual(segs.map((s) => s.id), ["100", "200"]); // 노드 순서대로 첨부 연결
});

test("adfSegments: external blob 미디어(첨부 없음) → unavailable", () => {
  const doc = { type: "doc", content: [
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "external", url: "blob:https://media.staging.atl-paas.net/?id=x" } }] },
  ] };
  const segs = lib.adfSegments(doc, {}, []);
  assert.ok(segs.some((s) => s.type === "unavailable" && s.reason === "inline"));
  assert.ok(!segs.some((s) => s.type === "text" && /이미지: \?/.test(s.text))); // [이미지: ?] 노출 안 함
});

test("adfSegments: external http(s) 미디어 → 원본 URL 이미지", () => {
  const doc = { type: "doc", content: [
    { type: "mediaSingle", content: [{ type: "media", attrs: { type: "external", url: "https://example.com/x.png", alt: "x" } }] },
  ] };
  const img = lib.adfSegments(doc, {}, []).find((s) => s.type === "image");
  assert.equal(img.url, "https://example.com/x.png");
});

test("toADF: 평문 → 문단 배열", () => {
  const adf = lib.toADF("a\n\nb");
  assert.equal(adf.type, "doc");
  assert.equal(adf.content.length, 3);
  assert.equal(adf.content[0].content[0].text, "a");
  assert.deepEqual(adf.content[1].content, []); // 빈 줄
});

test("mdInline: 굵게/코드/링크/맨URL", () => {
  const b = lib.mdInline("a **bold** b");
  assert.deepEqual(b[1], { type: "text", text: "bold", marks: [{ type: "strong" }] });
  const c = lib.mdInline("`go test`");
  assert.deepEqual(c[0].marks, [{ type: "code" }]);
  const l = lib.mdInline("see [PR](https://x/pull/1) end");
  assert.equal(l[1].text, "PR");
  assert.equal(l[1].marks[0].attrs.href, "https://x/pull/1");
  const u = lib.mdInline("https://github.com/o/r/pull/9");
  assert.equal(u[0].marks[0].type, "link");
});

test("mdToADF: 제목/불릿/표/구분선 → ADF, 이미지 왕복 없음", () => {
  const md = "### 변경 요약\n\n* 첫째 **항목**\n* 둘째\n\n---\n\n| repo | PR |\n| --- | --- |\n| kyb-api | https://x/pull/1 |";
  const adf = lib.mdToADF(md);
  const types = adf.content.map((n) => n.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("bulletList"));
  assert.ok(types.includes("rule"));
  const bl = adf.content.find((n) => n.type === "bulletList");
  assert.equal(bl.content.length, 2);                       // 불릿 2개
  assert.equal(bl.content[0].content[0].type, "paragraph");
  const tableRow = adf.content.find((n) => n.type === "paragraph" && /kyb-api/.test(JSON.stringify(n)));
  assert.ok(/·/.test(JSON.stringify(tableRow)));            // 표 행 → '·' 연결 문단(강등)
  assert.equal(adf.content.find((n) => n.type === "heading").attrs.level, 3);
});

test("buildReplyADF: 인용 + 멘션 + 본문", () => {
  const adf = lib.buildReplyADF("답변1\n답변2", { author: "홍길동", accountId: "acc1", snippet: "원문" });
  assert.equal(adf.content[0].type, "blockquote");
  const firstPara = adf.content[1];
  assert.equal(firstPara.content[0].type, "mention");
  assert.equal(firstPara.content[0].attrs.id, "acc1");
  assert.equal(adf.content[2].content[0].text, "답변2");
});

test("buildReplyADF: replyTo 없으면 인용/멘션 없음", () => {
  const adf = lib.buildReplyADF("그냥 답변", null);
  assert.equal(adf.content[0].type, "paragraph");
  assert.equal(adf.content[0].content[0].text, "그냥 답변");
});

test("maskCreds: 토큰은 boolean, 이메일은 평문", () => {
  const m = lib.maskCreds({ anthropicApiKey: "sk", openaiApiKey: "", geminiApiKey: "g", githubToken: "", atlassianEmail: "a@b.c", atlassianToken: "t", slackWebhookUrl: "u" });
  assert.deepEqual(m, { anthropicApiKey: true, openaiApiKey: false, geminiApiKey: true, githubToken: false, atlassianEmail: "a@b.c", atlassianToken: true, slackWebhookUrl: true });
});

test("applyCreds: 빈값 유지 / __CLEAR__ 삭제 / 값 갱신", () => {
  const cur = { anthropicApiKey: "old", openaiApiKey: "oa", geminiApiKey: "ge", githubToken: "gh", atlassianEmail: "a@b", atlassianToken: "tok", slackWebhookUrl: "u" };
  const next = lib.applyCreds(cur, { anthropicApiKey: "", openaiApiKey: "new-oa", geminiApiKey: "__CLEAR__", githubToken: "new", atlassianToken: "__CLEAR__" });
  assert.equal(next.anthropicApiKey, "old");   // 빈값 → 유지
  assert.equal(next.openaiApiKey, "new-oa");    // 값 → 갱신
  assert.equal(next.geminiApiKey, "");          // __CLEAR__ → 삭제
  assert.equal(next.githubToken, "new");        // 값 → 갱신
  assert.equal(next.atlassianToken, "");        // __CLEAR__ → 삭제
  assert.equal(next.slackWebhookUrl, "u");      // 미지정 → 유지
});

test("createStore: 마이그레이션 + CRUD + 자격증명", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const opts = {
    projectsPath: path.join(dir, "projects.json"),
    credsPath: path.join(dir, "project-credentials.json"),
    configPath: path.join(dir, "config.json"),
    credPath: path.join(dir, "credentials.json"),
    defaultConfig: { triggerMode: "label", maxParallel: 3, baseBranch: "main" },
  };
  try {
    // 레거시 → 첫 프로젝트로 마이그레이션
    fs.writeFileSync(opts.configPath, JSON.stringify({ projectKey: "ABC", repoUrl: "https://x" }));
    fs.writeFileSync(opts.credPath, JSON.stringify({ atlassianEmail: "a@b.c", atlassianToken: "tk" }));
    const s = lib.createStore(opts);
    assert.equal(s.migrateIfNeeded(), "abc");
    assert.equal(s.migrateIfNeeded(), false);   // 멱등
    assert.equal(s.listProjects().length, 1);
    assert.equal(s.getProject("abc").projectKey, "ABC");
    assert.equal(s.getProject("abc").baseBranch, "main"); // defaultConfig 병합
    assert.equal(s.getProjectCreds("abc").atlassianToken, "tk");
    assert.equal(s.defaultProjectId(), "abc");

    // 신규 추가(자동 id) + 중복 회피
    const p1 = s.saveProject({ name: "My Proj" });
    assert.equal(p1.id, "my-proj");
    const p2 = s.saveProject({ name: "My Proj" });
    assert.equal(p2.id, "my-proj-2");

    // 갱신
    s.saveProject({ id: "abc", repoUrl: "https://y" });
    assert.equal(s.getProject("abc").repoUrl, "https://y");

    // 자격증명 부분 갱신
    s.setProjectCreds("abc", { githubToken: "gh" });
    assert.equal(s.getProjectCreds("abc").githubToken, "gh");
    assert.equal(s.getProjectCreds("abc").atlassianToken, "tk"); // 기존 유지

    // 삭제(+자격증명 제거)
    s.removeProject("abc");
    assert.equal(s.getProject("abc"), null);
    assert.deepEqual(s.getProjectCreds("abc"), lib.DEFAULT_CREDS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("normalizeRepos: repos 배열 우선, 레거시 repoUrl 변환, envDest 보존", () => {
  assert.deepEqual(lib.normalizeRepos({ repos: [{ name: "be", url: "https://x/be.git", baseBranch: "dev", envDest: ".env" }] }),
    [{ name: "be", url: "https://x/be.git", baseBranch: "dev", envDest: ".env" }]);
  // name 미지정 → url 에서 도출, baseBranch 기본값, envDest 기본 ""
  assert.deepEqual(lib.normalizeRepos({ repos: [{ url: "https://github.com/o/firescout-backend.git" }], baseBranch: "main" }),
    [{ name: "firescout-backend", url: "https://github.com/o/firescout-backend.git", baseBranch: "main", envDest: "" }]);
  // 레거시 repoUrl → 프로젝트 envDest 승계
  assert.deepEqual(lib.normalizeRepos({ repoUrl: "https://github.com/o/kyb-api.git", baseBranch: "main", envDest: "work.env" }),
    [{ name: "kyb-api", url: "https://github.com/o/kyb-api.git", baseBranch: "main", envDest: "work.env" }]);
  assert.deepEqual(lib.normalizeRepos({}), []);
});

test("cardRepos: repo_<name> 라벨 매칭, 없으면 첫 repo", () => {
  const p = { repos: [{ name: "be", url: "u1" }, { name: "fe", url: "u2" }, { name: "infra", url: "u3" }] };
  assert.deepEqual(lib.cardRepos(p, ["repo_be", "repo_infra", "claude-work"]).map((r) => r.name), ["be", "infra"]);
  assert.deepEqual(lib.cardRepos(p, ["claude-work"]).map((r) => r.name), ["be"]); // 라벨 없음 → 첫 repo
  assert.deepEqual(lib.cardRepos({}, ["repo_x"]), []); // repo 없음
});

test("encryptEnv/decryptEnv: 왕복 + 평문 호환 + 변조 감지", () => {
  const crypto = require("crypto");
  const key = crypto.randomBytes(32);
  const plain = "AWS_KEY=abc\nDB_PW=p@ss w0rd\n한글=값";
  const enc = lib.encryptEnv(plain, key);
  assert.ok(enc.startsWith("ENCv1:"));            // 암호문 마커
  assert.ok(!enc.includes("AWS_KEY"));            // 원문 노출 없음
  assert.equal(lib.decryptEnv(enc, key), plain);  // 왕복 복원
  assert.equal(lib.decryptEnv("KEY=1\nX=2", key), "KEY=1\nX=2"); // 평문 첨부 호환
  assert.throws(() => lib.decryptEnv(enc, crypto.randomBytes(32))); // 다른 키 → 실패(GCM 인증)
});

test("loadOrCreateEnvKey: 생성 후 동일 키 재사용", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "key-"));
  try {
    const p = path.join(dir, ".env-key");
    const k1 = lib.loadOrCreateEnvKey(p);
    assert.equal(k1.length, 32);
    const k2 = lib.loadOrCreateEnvKey(p);            // 재호출 시 기존 키 로드
    assert.deepEqual(k1, k2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("createStore: 레거시 없으면 빈 목록", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const s = lib.createStore({ projectsPath: path.join(dir, "p.json"), credsPath: path.join(dir, "c.json"), configPath: path.join(dir, "none.json"), credPath: path.join(dir, "none2.json"), defaultConfig: {} });
  try {
    assert.equal(s.migrateIfNeeded(), false);
    assert.deepEqual(s.listProjects(), []);
    assert.equal(s.defaultProjectId(), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("resolveEngine: 기본값·override·잘못된 값 폴백", () => {
  // 미설정 → 전역 기본값(claude), 모델 빈값
  assert.deepEqual(lib.resolveEngine({}), { engine: "claude", model: "" });
  assert.deepEqual(lib.resolveEngine({ engine: "" }), { engine: "claude", model: "" });
  // 정상 override + 대소문자·공백 정규화
  assert.deepEqual(lib.resolveEngine({ engine: "codex", model: "gpt-5-codex" }), { engine: "codex", model: "gpt-5-codex" });
  assert.deepEqual(lib.resolveEngine({ engine: " Gemini ", model: " gemini-2.5-pro " }), { engine: "gemini", model: "gemini-2.5-pro" });
  // 지원하지 않는 엔진 → 전역 기본값으로 폴백
  assert.deepEqual(lib.resolveEngine({ engine: "gpt4", model: "x" }), { engine: "claude", model: "x" });
  // 타입 방어(문자열 아님) → 기본값
  assert.deepEqual(lib.resolveEngine({ engine: 123, model: null }), { engine: "claude", model: "" });
  // 지원 엔진 목록
  assert.deepEqual(lib.ENGINES, ["claude", "codex", "gemini"]);
});
