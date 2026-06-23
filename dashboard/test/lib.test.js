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
  assert.match(plan, /status != "DONE"/);
  assert.match(plan, /labels = "cw"/);
  assert.match(plan, /\(labels != "P" OR labels IS EMPTY\)/);     // plan: planned 없음
  assert.match(plan, /\(labels != "F" OR labels IS EMPTY\)/);     // failed 제외
  assert.match(plan, /AND project = "EKYB"/);
  const build = lib.detectJql("build", cfg);
  assert.match(build, /labels = "P" AND labels = "A"/);           // build: planned+answered 둘 다
  assert.match(build, /\(labels != "F" OR labels IS EMPTY\)/);
});

test("detectJql: 프로젝트 키 없으면 project 필터 없음", () => {
  const jql = lib.detectJql("plan", { triggerMode: "label", triggerLabel: "cw", doneStatus: "D", plannedLabel: "P", failedLabel: "F" });
  assert.doesNotMatch(jql, /project =/);
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

test("toADF: 평문 → 문단 배열", () => {
  const adf = lib.toADF("a\n\nb");
  assert.equal(adf.type, "doc");
  assert.equal(adf.content.length, 3);
  assert.equal(adf.content[0].content[0].text, "a");
  assert.deepEqual(adf.content[1].content, []); // 빈 줄
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
  const m = lib.maskCreds({ anthropicApiKey: "sk", githubToken: "", atlassianEmail: "a@b.c", atlassianToken: "t", slackWebhookUrl: "u" });
  assert.deepEqual(m, { anthropicApiKey: true, githubToken: false, atlassianEmail: "a@b.c", atlassianToken: true, slackWebhookUrl: true });
});

test("applyCreds: 빈값 유지 / __CLEAR__ 삭제 / 값 갱신", () => {
  const cur = { anthropicApiKey: "old", githubToken: "gh", atlassianEmail: "a@b", atlassianToken: "tok", slackWebhookUrl: "u" };
  const next = lib.applyCreds(cur, { anthropicApiKey: "", githubToken: "new", atlassianToken: "__CLEAR__" });
  assert.equal(next.anthropicApiKey, "old");   // 빈값 → 유지
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

test("createStore: 레거시 없으면 빈 목록", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const s = lib.createStore({ projectsPath: path.join(dir, "p.json"), credsPath: path.join(dir, "c.json"), configPath: path.join(dir, "none.json"), credPath: path.join(dir, "none2.json"), defaultConfig: {} });
  try {
    assert.equal(s.migrateIfNeeded(), false);
    assert.deepEqual(s.listProjects(), []);
    assert.equal(s.defaultProjectId(), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
