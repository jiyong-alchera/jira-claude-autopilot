#!/usr/bin/env node
// run-cycle.js <plan|build>
// --------------------------------------------------------------------------
// 한 번의 사이클: 등록된 모든 프로젝트를 순회하며 detect → run-jira-claude.sh 실행.
// 루프(loop-plan.sh/loop-build.sh)가 매 주기 이 스크립트를 호출한다.
// - projects.json / project-credentials.json 을 직접 읽어 프로젝트별 env 를 구성
// - 탐지: DASHBOARD_URL 있으면 /api/detect/<mode>?project=<id> 우선, 실패 시 detect-cards.sh 폴백
// - 카드별 run-jira-claude.sh 를 프로젝트 MAX_PARALLEL 만큼 동시 실행
// 출력은 stdout(상위 루프가 loop-<phase>.log 로 리다이렉트)
// --------------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const SELF = __dirname;
const DASH = path.join(SELF, "dashboard");
const lib = require(path.join(DASH, "lib"));
const phase = process.argv[2];
if (!["plan", "build", "review"].includes(phase)) { console.error("usage: run-cycle.js <plan|build|review>"); process.exit(2); }

const ts = () => new Date().toISOString().slice(0, 19).replace("T", " ");
const log = (m) => console.log(`[${ts()}] ${m}`);
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };
// repo 별 env 파일(repo 전용만; 없으면 미복사 — run-jira 가 -f 로 확인)
function repoEnvSrc(cfg, repoName) {
  return path.join(cfg.workDir || SELF, `work-${cfg.id}-${repoName}.env`);
}
const reposToLines = (cfg, repos, envSrcOverride) => (repos || []).map((r) =>
  [r.name, r.url, r.baseBranch || "main", envSrcOverride || repoEnvSrc(cfg, r.name), r.envDest || cfg.envDest || ""].join("\x1f")
).join("\n");

// 카드 전용 env: 로컬 card-envs/<KEY>.env 만 읽는다(Jira 폴백 없음). 없으면 null → repo 전용 env 사용.
function cardEnvLocal(cfg, key) {
  const dir = cfg.cardEnvDir || path.join(cfg.workDir || SELF, "card-envs");
  return path.join(dir, `${key}.env`);
}
function resolveCardEnv(cfg, key) {
  const p = cardEnvLocal(cfg, key);
  return fs.existsSync(p) ? p : null;
}

// 카드 첨부를 로컬로 내려받아 Claude 가 Read 도구로 인식하게 함(추론에 반영).
// 이미지(image/*)와 Claude 가 읽을 수 있는 문서(PDF·텍스트·코드 등)를 분류해 각각 경로 목록으로 반환한다.
// 읽을 수 없는 바이너리(오피스 문서·압축 등)는 다운로드하지 않고 로그로만 남긴다(Read 로 의미 있게 열 수 없으므로).
const MAX_CARD_IMAGES = 10;
const MAX_CARD_DOCS = 10;
const MAX_DOC_BYTES = 25 * 1024 * 1024;   // 문서 1개 용량 상한(대용량 다운로드 방지)
const DOC_MIME = new Set([
  "application/pdf", "application/json", "application/xml", "application/xhtml+xml",
  "application/javascript", "application/x-javascript", "application/typescript",
  "application/x-yaml", "application/yaml", "application/x-sh", "application/x-python",
  "application/x-httpd-php", "application/sql", "application/x-sql", "text/markdown",
]);
const DOC_EXT = new Set([
  "pdf", "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm",
  "js", "jsx", "ts", "tsx", "py", "go", "java", "kt", "rb", "php", "c", "h", "cpp", "cc", "hpp",
  "cs", "rs", "swift", "sh", "bash", "zsh", "sql", "toml", "ini", "cfg", "conf", "env", "log",
  "gradle", "properties", "dockerfile", "makefile", "vue", "svelte", "scss", "css", "less",
]);
// Claude Read 로 의미 있게 열 수 있는 비이미지 문서인지 판정(mimeType 우선, 없으면 확장자 폴백)
function isReadableDoc(a) {
  const mt = String(a.mimeType || "").toLowerCase();
  if (mt.startsWith("image/")) return false;
  if (mt.startsWith("text/")) return true;
  if (DOC_MIME.has(mt)) return true;
  const ext = (String(a.filename || "").split(".").pop() || "").toLowerCase();
  return DOC_EXT.has(ext);
}
async function fetchAttachmentTo(cfg, auth, a, dir) {
  let up = await fetch(`https://${cfg.jiraSite}/rest/api/3/attachment/content/${a.id}`, { headers: { Authorization: `Basic ${auth}` }, redirect: "manual", signal: AbortSignal.timeout(30000) });
  const loc = up.headers.get("location");
  if (up.status >= 300 && up.status < 400 && loc) up = await fetch(loc, { signal: AbortSignal.timeout(30000) });
  if (!up.ok) return null;
  const safe = String(a.filename || `att-${a.id}`).replace(/[^\w.\-]/g, "_");
  const p = path.join(dir, `${a.id}-${safe}`);
  fs.writeFileSync(p, Buffer.from(await up.arrayBuffer()));
  return p;
}
async function downloadCardAttachments(cfg, cred, key) {
  const empty = { images: [], docs: [] };
  if (!cred || !cred.atlassianEmail || !cred.atlassianToken || !cfg.jiraSite) return empty;
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  try {
    const r = await fetch(`https://${cfg.jiraSite}/rest/api/3/issue/${encodeURIComponent(key)}?fields=attachment`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return empty;
    const d = await r.json();
    const all = (d.fields && d.fields.attachment) || [];
    let imgs = all.filter((a) => String(a.mimeType || "").startsWith("image/"));
    let docs = all.filter(isReadableDoc);
    const skipped = all.filter((a) => !String(a.mimeType || "").startsWith("image/") && !isReadableDoc(a));
    if (skipped.length) log(`[${key}] 첨부 ${skipped.length}개는 Claude 가 읽을 수 없어 제외: ${skipped.map((a) => a.filename).join(", ")}`);
    if (imgs.length > MAX_CARD_IMAGES) { log(`[${key}] 이미지 ${imgs.length}장 중 ${MAX_CARD_IMAGES}장만 인식(상한)`); imgs = imgs.slice(0, MAX_CARD_IMAGES); }
    const tooBig = docs.filter((a) => Number(a.size || 0) > MAX_DOC_BYTES);
    if (tooBig.length) log(`[${key}] 문서 ${tooBig.length}개는 용량 초과(>${Math.round(MAX_DOC_BYTES / 1048576)}MB)로 제외: ${tooBig.map((a) => a.filename).join(", ")}`);
    docs = docs.filter((a) => Number(a.size || 0) <= MAX_DOC_BYTES);
    if (docs.length > MAX_CARD_DOCS) { log(`[${key}] 문서 ${docs.length}개 중 ${MAX_CARD_DOCS}개만 인식(상한)`); docs = docs.slice(0, MAX_CARD_DOCS); }
    const base = cfg.cloneBase || path.join(cfg.workDir || SELF, "repos");
    const imgDir = path.join(base, ".state", `${key}.images`);
    const docDir = path.join(base, ".state", `${key}.docs`);
    if (imgs.length) fs.mkdirSync(imgDir, { recursive: true });
    if (docs.length) fs.mkdirSync(docDir, { recursive: true });
    const outImg = [], outDoc = [];
    for (const a of imgs) { try { const p = await fetchAttachmentTo(cfg, auth, a, imgDir); if (p) outImg.push(p); } catch { /* 개별 실패 건너뜀 */ } }
    for (const a of docs) { try { const p = await fetchAttachmentTo(cfg, auth, a, docDir); if (p) outDoc.push(p); } catch { /* 개별 실패 건너뜀 */ } }
    return { images: outImg, docs: outDoc };
  } catch { return empty; }
}

// 카드 라벨 조회(프로젝트 자격증명) → 대상 repo 결정용
async function fetchLabels(cfg, cred, key) {
  if (!cred || !cred.atlassianEmail || !cred.atlassianToken || !cfg.jiraSite) return [];
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  const r = await fetch(`https://${cfg.jiraSite}/rest/api/3/issue/${encodeURIComponent(key)}?fields=labels`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.fields && d.fields.labels) || [];
}

const DEFAULTS = {
  workDir: SELF, baseBranch: "main", triggerMode: "label", triggerLabel: "claude-work", triggerText: "claude-work",
  doneStatus: "DEV COMPLETED", plannedLabel: "claude-planned", answeredLabel: "claude-answered", failedLabel: "claude-failed", prOpenLabel: "claude-pr",
  maxRetries: 3, maxParallel: 5, intervalSeconds: 3600, reviewIntervalSeconds: 3600, envMode: "content", envPath: "", envDest: "", cardEnvDir: "", cloneBase: path.join(SELF, "repos"),
  testCmd: "", buildCmd: "", repoUrl: "", jiraSite: "", projectKey: "", assigneeEmail: "", assigneeName: "",
  engine: "", model: "",   // 비우면 전역 기본값(claude) 상속
};

function projectEnv(p, cred) {
  const cfg = { ...DEFAULTS, ...p };
  const repos = lib.normalizeRepos(cfg);
  const env = { ...process.env };
  env.PROJECT_ID = cfg.id || "";
  env.WORK_DIR = cfg.workDir;
  const eng = lib.resolveEngine(cfg);   // 프로젝트 override → 없으면 전역 기본값
  env.ENGINE = eng.engine;
  env.MODEL = eng.model;
  env.REPO_URL = (repos[0] && repos[0].url) || cfg.repoUrl || "";
  env.BASE_BRANCH = (repos[0] && repos[0].baseBranch) || cfg.baseBranch || "main";
  env.CARD_REPOS = reposToLines(cfg, repos);   // 기본=전체 repo(카드별로 좁혀짐)
  env.ASSIGNEE_EMAIL = cfg.assigneeEmail;
  env.ASSIGNEE_NAME = cfg.assigneeName;
  env.TRIGGER_MODE = cfg.triggerMode || "label";
  env.TRIGGER_LABEL = cfg.triggerLabel || "claude-work";
  env.TRIGGER_TEXT = cfg.triggerText;
  env.DONE_STATUS = lib.effectiveDoneStatuses(cfg).join(",");   // doneStatus ∪ 매핑 완료
  env.PLANNED_LABEL = cfg.plannedLabel;
  env.ANSWERED_LABEL = cfg.answeredLabel || "claude-answered";
  env.FAILED_LABEL = cfg.failedLabel || "claude-failed";
  env.PR_OPEN_LABEL = cfg.prOpenLabel || "claude-pr";
  env.MAX_RETRIES = String(cfg.maxRetries || 3);
  env.TEST_CMD = cfg.testCmd || "";
  env.BUILD_CMD = cfg.buildCmd || "";
  env.HISTORY_FILE = path.join(SELF, "history.jsonl");
  env.PROJECT_KEY = cfg.projectKey || "";
  env.ENV_SRC = cfg.envPath || path.join(cfg.workDir || SELF, `work-${cfg.id}.env`);
  env.ENV_DEST_REL = cfg.envDest || "";
  env.CLONE_BASE = cfg.cloneBase || path.join(cfg.workDir || SELF, "repos");
  if (cred && cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
  if (cred && cred.openaiApiKey) env.OPENAI_API_KEY = cred.openaiApiKey;   // codex 엔진
  if (cred && cred.geminiApiKey) env.GEMINI_API_KEY = cred.geminiApiKey;   // gemini 엔진
  if (cred && cred.githubToken) { env.GH_TOKEN = cred.githubToken; env.GITHUB_TOKEN = cred.githubToken; }
  if (cred && cred.slackWebhookUrl) env.SLACK_WEBHOOK_URL = cred.slackWebhookUrl;
  // 완료 내역을 설명 ADF 에 직접 append(이미지 보존)하기 위한 Jira REST 자격증명
  env.JIRA_SITE = cfg.jiraSite || "";
  if (cred && cred.atlassianEmail) env.ATLASSIAN_EMAIL = cred.atlassianEmail;
  if (cred && cred.atlassianToken) env.ATLASSIAN_TOKEN = cred.atlassianToken;
  return { cfg, env };
}

// 탐지: REST(대시보드) 우선, 실패 시 detect-cards.sh 폴백
async function detect(p, env) {
  const base = process.env.DASHBOARD_URL;
  if (base) {
    try {
      const r = await fetch(`${base}/api/detect/${phase}?project=${encodeURIComponent(p.id)}`, { signal: AbortSignal.timeout(20000) });
      if (r.ok) { const j = await r.json(); if (j && j.ok) return j.keys || []; }
    } catch { /* 폴백 */ }
  }
  return await new Promise((resolve) => {
    let out = "";
    const c = spawn("bash", [path.join(SELF, "detect-cards.sh"), phase], { env });
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => resolve((out.match(/[A-Z][A-Z0-9]+-[0-9]+/g) || []).filter((v, i, a) => a.indexOf(v) === i)));
    c.on("error", () => resolve([]));
  });
}

async function runCard(key, env, cfg, cred) {
  const e = { ...env };
  try {
    const cardEnv = resolveCardEnv(cfg, key);   // 카드 전용 env(로컬) 우선
    e.CARD_REPOS = reposToLines(cfg, lib.cardRepos(cfg, await fetchLabels(cfg, cred, key)), cardEnv);
  } catch { /* 기본(전체) 사용 */ }
  // 카드 첨부(이미지+문서)를 내려받아 Claude Read 인식용 env 로 전달 — plan/build/review 모두 동일하게 적용.
  try {
    const att = await downloadCardAttachments(cfg, cred, key);
    if (att.images.length) { e.CARD_IMAGES = att.images.join("\n"); log(`[${key}] 카드 이미지 ${att.images.length}장 첨부(추론 인식)`); }
    if (att.docs.length) { e.CARD_DOCS = att.docs.join("\n"); log(`[${key}] 카드 문서 ${att.docs.length}개 첨부(추론 인식)`); }
  } catch { /* 첨부 없이 진행 */ }
  // review: PR 리뷰만 수행(run-review.sh). 요약 세팅 불필요.
  if (phase === "review") {
    return new Promise((resolve) => {
      const c = spawn("bash", [path.join(SELF, "run-review.sh"), key], { env: e, stdio: "inherit" });
      c.on("close", () => resolve());
      c.on("error", () => resolve());
    });
  }
  // 완료 내역 요약 저장 경로(claude 가 여기에 markdown 작성 → 스크립트가 설명 ADF 에 안전 append)
  const stateBase = cfg.cloneBase || path.join(cfg.workDir || SELF, "repos");
  e.SUMMARY_FILE = path.join(stateBase, ".state", `${key}.summary.md`);
  return new Promise((resolve) => {
    const c = spawn("bash", [path.join(SELF, "run-jira-claude.sh"), key, phase], { env: e, stdio: "inherit" });
    c.on("close", () => resolve());
    c.on("error", () => resolve());
  });
}

// 동시 실행 상한 적용
async function runWithCap(keys, env, cap, cfg, cred) {
  let i = 0;
  const workers = Array.from({ length: Math.max(1, cap) }, async () => {
    while (i < keys.length) { const k = keys[i++]; await runCard(k, env, cfg, cred); }
  });
  await Promise.all(workers);
}

(async () => {
  const projects = (readJson(path.join(DASH, "projects.json"), { projects: [] }).projects) || [];
  const creds = readJson(path.join(DASH, "project-credentials.json"), {});
  if (!projects.length) { log(`프로젝트가 없습니다 — 건너뜀`); return; }
  for (const p of projects) {
    const cred = creds[p.id];
    const { cfg, env } = projectEnv(p, cred);
    try {
      const keys = await detect(p, env);
      if (!keys.length) { log(`[${p.id}] ${phase} 대상 없음`); continue; }
      log(`[${p.id}] ${phase} 대상 ${keys.length}건: ${keys.join(", ")} (동시 ${cfg.maxParallel})`);
      await runWithCap(keys, env, cfg.maxParallel || 5, cfg, cred);
      log(`[${p.id}] ${phase} 사이클 완료`);
    } catch (e) {
      log(`[${p.id}] ${phase} 오류: ${String((e && e.message) || e)}`);
    }
  }
})();
