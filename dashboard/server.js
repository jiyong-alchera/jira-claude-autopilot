// =============================================================================
// Jira -> Claude 루프 자동화 대시보드 백엔드 (Express) — 멀티 프로젝트
// - 프로젝트(설정) / 프로젝트별 자격증명 로컬 저장
// - loop-plan / loop-build 스크립트 start/stop/status (한 루프가 전 프로젝트 순회 — Phase 2)
// - 로그 tail / 처리 이력 / Jira REST (카드 조회·등록·답변·첨부)
// =============================================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json({ limit: "25mb" })); // 이미지(base64) 첨부 페이로드 허용

const PORT = process.env.PORT || 4317;
const ROOT = __dirname;                       // dashboard 폴더
const SCRIPTS_DIR = path.resolve(ROOT, ".."); // loop-work 폴더 (스크립트/로그 위치)
const PROJECTS_PATH = path.join(ROOT, "projects.json");            // 프로젝트 목록(설정)
const PROJECT_CREDS_PATH = path.join(ROOT, "project-credentials.json"); // 프로젝트별 자격증명
const CONFIG_PATH = path.join(ROOT, "config.json");               // (레거시) 단일 설정 — 마이그레이션용
const CRED_PATH = path.join(ROOT, "credentials.json");            // (레거시) 단일 자격증명 — 마이그레이션용
const HISTORY_PATH = path.join(SCRIPTS_DIR, "history.jsonl");      // run-jira-claude.sh 가 기록하는 처리 이력

// ----- 프로젝트 설정 기본값(템플릿) -----
const DEFAULT_CONFIG = {
  workDir: SCRIPTS_DIR,
  repoUrl: "",
  baseBranch: "main",
  jiraSite: "",
  projectKey: "",
  assigneeEmail: "",
  assigneeName: "",
  triggerMode: "label",
  triggerLabel: "claude-work",
  triggerText: "claude-work",
  doneStatus: "DEV COMPLETED",
  plannedLabel: "claude-planned",
  answeredLabel: "claude-answered",
  failedLabel: "claude-failed",
  maxRetries: 3,
  maxParallel: 3,
  testCmd: "",
  buildCmd: "",
  intervalSeconds: 3600,
  envMode: "content",
  envPath: "",                                  // 비우면 <workDir>/work-<id>.env 사용
  envDest: "",                                  // repo 내 복사 대상 상대경로(비우면 루트). 예: src/main/resources/application-private.properties
  cloneBase: path.join(SCRIPTS_DIR, "repos"),
};

// ----- 순수 로직 + 프로젝트 스토어 (단위 테스트 대상은 lib.js 로 분리) -----
const lib = require("./lib");
const { slugify, triggerClause, detectJql, adfToText, toADF, buildReplyADF, maskCreds, applyCreds } = lib;
const store = lib.createStore({
  projectsPath: PROJECTS_PATH, credsPath: PROJECT_CREDS_PATH,
  configPath: CONFIG_PATH, credPath: CRED_PATH, defaultConfig: DEFAULT_CONFIG,
});
const { listProjects, getProject, defaultProjectId, saveProject, removeProject, getProjectCreds, setProjectCreds } = store;

function projectEnvPath(cfg) {
  return cfg.envPath || path.join(cfg.workDir || SCRIPTS_DIR, `work-${cfg.id}.env`);
}
// 레거시 호환: 인자 없는 호출은 "첫 프로젝트"를 사용(기존 단일 프로젝트 UI 유지)
function getConfig(id) {
  const pid = id || defaultProjectId();
  return (pid && getProject(pid)) || { ...DEFAULT_CONFIG, id: "default" };
}
function getCreds(id) {
  const pid = id || defaultProjectId();
  return pid ? getProjectCreds(pid) : { ...lib.DEFAULT_CREDS };
}
// 요청에서 프로젝트 해석(?project=id 또는 body.project, 없으면 첫 프로젝트)
function resolveProject(req) {
  const id = (req.query && req.query.project) || (req.body && req.body.project) || defaultProjectId();
  const cfg = id && getProject(id);
  if (!cfg) { const e = new Error("프로젝트가 없습니다. 먼저 프로젝트를 등록하세요."); e.code = 404; throw e; }
  return { id: cfg.id, cfg, cred: getProjectCreds(cfg.id) };
}

const migratedId = store.migrateIfNeeded();
if (migratedId) console.log(`  마이그레이션: 기존 설정을 프로젝트 '${migratedId}' 로 가져왔습니다.`);

// ----- 실행 중인 루프 프로세스 추적 (pidfile 기반) -----
const loops = { plan: null, build: null };
const pidFile = (type) => path.join(SCRIPTS_DIR, `loop-${type}.pid`);
function readPid(type) {
  try { const pid = parseInt(fs.readFileSync(pidFile(type), "utf8").trim(), 10); return Number.isInteger(pid) ? pid : null; }
  catch { return null; }
}
function isAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
function clearPid(type) { try { fs.unlinkSync(pidFile(type)); } catch {} }

// 프로젝트별 env (run-jira-claude.sh 에 주입). id 미지정 시 첫 프로젝트.
function scriptEnv(id) {
  const cfg = getConfig(id);
  const cred = getCreds(cfg.id);
  const env = { ...process.env };
  env.PROJECT_ID = cfg.id || "";
  env.WORK_DIR = cfg.workDir;
  env.REPO_URL = cfg.repoUrl;
  env.BASE_BRANCH = cfg.baseBranch;
  env.ASSIGNEE_EMAIL = cfg.assigneeEmail;
  env.ASSIGNEE_NAME = cfg.assigneeName;
  env.TRIGGER_MODE = cfg.triggerMode || "label";
  env.TRIGGER_LABEL = cfg.triggerLabel || "claude-work";
  env.TRIGGER_TEXT = cfg.triggerText;
  env.DONE_STATUS = cfg.doneStatus;
  env.PLANNED_LABEL = cfg.plannedLabel;
  env.ANSWERED_LABEL = cfg.answeredLabel || "claude-answered";
  env.FAILED_LABEL = cfg.failedLabel || "claude-failed";
  env.MAX_RETRIES = String(cfg.maxRetries || 3);
  env.TEST_CMD = cfg.testCmd || "";
  env.BUILD_CMD = cfg.buildCmd || "";
  env.HISTORY_FILE = HISTORY_PATH;
  env.PROJECT_KEY = cfg.projectKey || "";
  env.ENV_SRC = projectEnvPath(cfg);
  env.ENV_DEST_REL = cfg.envDest || "";
  env.CLONE_BASE = cfg.cloneBase || path.join(cfg.workDir, "repos");
  env.LOOP_INTERVAL = String(cfg.intervalSeconds || 3600);
  env.MAX_PARALLEL = String(cfg.maxParallel || 3);
  env.DASHBOARD_URL = `http://localhost:${PORT}`;
  if (cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
  if (cred.githubToken) { env.GH_TOKEN = cred.githubToken; env.GITHUB_TOKEN = cred.githubToken; }
  if (cred.slackWebhookUrl) env.SLACK_WEBHOOK_URL = cred.slackWebhookUrl;
  return env;
}

function startLoop(type) {
  const existing = readPid(type);
  if (isAlive(existing)) return { ok: false, message: `${type} 루프가 이미 실행 중입니다 (pid ${existing}).` };
  clearPid(type);
  const script = path.join(SCRIPTS_DIR, `loop-${type}.sh`);
  if (!fs.existsSync(script)) return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  const proc = spawn("bash", [script], { cwd: SCRIPTS_DIR, env: { ...process.env, DASHBOARD_URL: `http://localhost:${PORT}` }, detached: true, stdio: "ignore" });
  fs.writeFileSync(pidFile(type), String(proc.pid));
  loops[type] = { proc };
  proc.on("exit", () => {
    if (loops[type] && loops[type].proc === proc) loops[type] = null;
    if (readPid(type) === proc.pid) clearPid(type);
  });
  proc.unref();
  return { ok: true, pid: proc.pid };
}
function runOnce(type) {
  const script = path.join(SCRIPTS_DIR, `loop-${type}.sh`);
  if (!fs.existsSync(script)) return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  const proc = spawn("bash", [script], { cwd: SCRIPTS_DIR, env: { ...process.env, RUN_ONCE: "1", DASHBOARD_URL: `http://localhost:${PORT}` }, detached: true, stdio: "ignore" });
  proc.unref();
  return { ok: true, pid: proc.pid };
}
// 특정 카드 1건 즉시 실행(프로젝트 env 주입)
function runCard(key, phase, stamp, projectId) {
  const script = path.join(SCRIPTS_DIR, "run-jira-claude.sh");
  if (!fs.existsSync(script)) return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  const logPath = path.join(SCRIPTS_DIR, `loop-${phase}.log`);
  let fd;
  try {
    fd = fs.openSync(logPath, "a");
    fs.writeSync(fd, `[${stamp}] (단건 즉시 실행) ${phase.toUpperCase()}: ${key} [${projectId}]\n`);
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
  const proc = spawn("bash", [script, key, phase], { cwd: SCRIPTS_DIR, env: scriptEnv(projectId), detached: true, stdio: ["ignore", fd, fd] });
  try { fs.closeSync(fd); } catch {}
  proc.unref();
  return { ok: true, pid: proc.pid };
}
function stopLoop(type) {
  const pid = readPid(type);
  if (!isAlive(pid)) { clearPid(type); loops[type] = null; return { ok: false, message: `${type} 루프가 실행 중이 아닙니다.` }; }
  try { process.kill(-pid, "SIGTERM"); } catch { try { process.kill(pid, "SIGTERM"); } catch {} }
  clearPid(type); loops[type] = null;
  return { ok: true };
}
function loopStatus() {
  const out = {};
  for (const t of ["plan", "build"]) {
    const pid = readPid(t);
    if (isAlive(pid)) {
      let startedAt = null;
      try { startedAt = fs.statSync(pidFile(t)).mtime.toISOString(); } catch {}
      out[t] = { running: true, pid, startedAt };
    } else { if (pid) clearPid(t); out[t] = { running: false }; }
  }
  return out;
}

// ----- Jira REST (프로젝트의 cfg/cred 사용) -----
function jiraAuth(cred) {
  if (!cred.atlassianEmail || !cred.atlassianToken) throw new Error("Atlassian 이메일/토큰이 설정되지 않았습니다.");
  return Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
}
async function jiraSearch(jql, cfg, cred) {
  const auth = jiraAuth(cred);
  if (!cfg.jiraSite) throw new Error("Jira 사이트가 설정되지 않았습니다.");
  const res = await fetch(`https://${cfg.jiraSite}/rest/api/3/search/jql`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ jql, fields: ["summary", "status", "labels", "assignee"], maxResults: 50 }),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
async function jiraReq(method, urlPath, body, cfg, cred) {
  const auth = jiraAuth(cred);
  if (!cfg.jiraSite) throw new Error("Jira 사이트가 설정되지 않았습니다.");
  const res = await fetch(`https://${cfg.jiraSite}${urlPath}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Jira ${res.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}
async function jiraAttach(issueKey, filename, dataBase64, contentType, cfg, cred) {
  const auth = jiraAuth(cred);
  const buf = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
  const form = new FormData();
  form.append("file", new Blob([buf], { type: contentType || "application/octet-stream" }), filename || "attachment");
  const res = await fetch(`https://${cfg.jiraSite}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: "POST", headers: { Authorization: `Basic ${auth}`, "X-Atlassian-Token": "no-check" }, body: form,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status}: ${txt.slice(0, 200)}`);
}
function runClaude(prompt, cred, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (cred && cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
    let child;
    try { child = spawn("claude", ["-p", prompt], { env }); }
    catch (e) { return reject(new Error("claude 실행 실패: " + e.message)); }
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error("claude 응답 시간 초과")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error("claude 실행 실패(설치/PATH 확인): " + e.message)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`claude 종료 코드 ${code}: ${err.slice(0, 300)}`)); });
  });
}

// ADF/트리거/detectJql 등 순수 로직은 lib.js 에서 가져옴(상단 destructure).
const fail = (res, e) => res.status(e && e.code === 404 ? 404 : 500).json({ ok: false, message: String((e && e.message) || e) });

// =============================== API ROUTES ==================================
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ----- 프로젝트 관리 -----
app.get("/api/projects", (req, res) => res.json({ ok: true, projects: listProjects(), defaultId: defaultProjectId() }));
app.post("/api/projects", (req, res) => {
  const saved = saveProject(req.body || {});
  res.json({ ok: true, project: saved });
});
app.delete("/api/projects/:id", (req, res) => { removeProject(req.params.id); res.json({ ok: true }); });
app.get("/api/projects/:id/credentials", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ ok: false, message: "프로젝트 없음" });
  res.json(maskCreds(getProjectCreds(req.params.id)));
});
app.post("/api/projects/:id/credentials", (req, res) => {
  if (!getProject(req.params.id)) return res.status(404).json({ ok: false, message: "프로젝트 없음" });
  setProjectCreds(req.params.id, applyCreds(getProjectCreds(req.params.id), req.body || {}));
  res.json({ ok: true });
});

// ----- 레거시 호환: 첫 프로젝트 대상 (기존 단일 프로젝트 UI 유지) -----
app.get("/api/config", (req, res) => res.json(getConfig()));
app.post("/api/config", (req, res) => {
  const id = defaultProjectId();
  const body = req.body || {};
  const saved = id ? saveProject({ ...body, id }) : saveProject({ name: body.projectKey || "기본 프로젝트", ...body });
  res.json({ ok: true, config: saved });
});
app.get("/api/credentials", (req, res) => res.json(maskCreds(getCreds())));
app.post("/api/credentials", (req, res) => {
  const id = defaultProjectId();
  if (!id) return res.status(400).json({ ok: false, message: "프로젝트를 먼저 등록하세요." });
  setProjectCreds(id, applyCreds(getProjectCreds(id), req.body || {}));
  res.json({ ok: true });
});

// ----- 루프 제어 -----
app.get("/api/loops/status", (req, res) => res.json(loopStatus()));
app.post("/api/loops/:type/start", (req, res) => {
  if (!["plan", "build"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(startLoop(req.params.type));
});
app.post("/api/loops/:type/stop", (req, res) => {
  if (!["plan", "build"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(stopLoop(req.params.type));
});
app.post("/api/loops/:type/run-once", (req, res) => {
  if (!["plan", "build"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(runOnce(req.params.type));
});

// 특정 카드 1건 즉시 실행
app.post("/api/cards/:key/run", (req, res) => {
  const key = req.params.key;
  const phase = (req.body || {}).phase;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  if (!["plan", "build"].includes(phase)) return res.status(400).json({ ok: false, message: "phase 는 plan|build" });
  try { const { id } = resolveProject(req); res.json(runCard(key, phase, new Date().toISOString(), id)); }
  catch (e) { fail(res, e); }
});

// REST 탐지
app.get("/api/detect/:mode", async (req, res) => {
  if (!["plan", "build"].includes(req.params.mode)) return res.status(400).json({ ok: false, message: "mode 오류" });
  try {
    const { cfg, cred } = resolveProject(req);
    const data = await jiraSearch(detectJql(req.params.mode, cfg), cfg, cred);
    res.json({ ok: true, mode: req.params.mode, keys: (data.issues || []).map((i) => i.key) });
  } catch (e) { fail(res, e); }
});

// 로그
app.get("/api/logs/:type", (req, res) => {
  if (!["plan", "build"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  const lines = Math.min(parseInt(req.query.lines || "200", 10), 2000);
  const logPath = path.join(SCRIPTS_DIR, `loop-${req.params.type}.log`);
  if (!fs.existsSync(logPath)) return res.json({ log: "(로그 파일 없음 — 아직 실행 전)" });
  res.json({ log: fs.readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n") });
});
app.post("/api/logs/:type/clear", (req, res) => {
  if (!["plan", "build"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  try { fs.writeFileSync(path.join(SCRIPTS_DIR, `loop-${req.params.type}.log`), ""); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});

// 카드 상태
app.get("/api/cards", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
    const data = await jiraSearch(`assignee = currentUser() AND ${triggerClause(cfg)}${proj} ORDER BY key ASC`, cfg, cred);
    const stateDir = path.join(cfg.cloneBase || path.join(cfg.workDir || SCRIPTS_DIR, "repos"), ".state");
    // 처리 중 여부: run-jira-claude.sh 가 만든 카드별 락(<KEY>.lock) 존재 + phase 파일
    const procInfo = (key) => {
      if (!fs.existsSync(path.join(stateDir, `${key}.lock`))) return null;
      try { return fs.readFileSync(path.join(stateDir, `${key}.lock.phase`), "utf8").trim() || "run"; } catch { return "run"; }
    };
    const labelStage = (it) => {
      if (it.labels.includes(cfg.failedLabel)) return "failed";
      const planned = it.labels.includes(cfg.plannedLabel), answered = it.labels.includes(cfg.answeredLabel);
      if (planned && answered) return "build-ready";
      if (planned) return "awaiting-answer";
      return "plan-ready";
    };
    const issues = (data.issues || []).map((i) => {
      const it = { key: i.key, summary: i.fields.summary, status: i.fields.status?.name, labels: i.fields.labels || [], url: `https://${cfg.jiraSite}/browse/${i.key}` };
      const proc = procInfo(i.key);
      let stage;
      if (it.status === cfg.doneStatus) stage = "done";        // 완료 상태가 최우선
      else if (proc) stage = "processing";                     // 처리 중(락 존재)
      else stage = labelStage(it);
      return { ...it, stage, proc };
    });
    res.json({ ok: true, issues });
  } catch (e) { fail(res, e); }
});

// 카드 등록 메타
app.get("/api/jira/meta", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    if (!cfg.projectKey) throw new Error("프로젝트 키가 설정되지 않았습니다.");
    const proj = await jiraReq("GET", `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`, null, cfg, cred);
    const issueTypes = (proj.issueTypes || []).map((t) => ({ id: t.id, name: t.name, subtask: !!t.subtask, hierarchyLevel: t.hierarchyLevel }));
    let epics = [];
    try {
      const data = await jiraSearch(`project = "${cfg.projectKey}" AND issuetype = Epic ORDER BY created DESC`, cfg, cred);
      epics = (data.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary }));
    } catch {}
    res.json({ ok: true, projectKey: cfg.projectKey, issueTypes, epics });
  } catch (e) { fail(res, e); }
});

// 러프 설명 → Claude 정리
app.post("/api/ai/refine-description", async (req, res) => {
  try {
    const { cred } = resolveProject(req);
    const b = req.body || {};
    const text = String(b.text || "").trim();
    if (!text) throw new Error("변환할 설명을 입력하세요.");
    const prompt = `다음은 작성자가 러프하게 적은 Jira 작업 설명입니다. 개발 담당자가 보기 좋은 체계적인 한국어 설명으로 정리하세요.

규칙:
- 입력에 없는 사실/요구사항을 지어내지 마세요. 모호한 부분은 "(확인 필요)" 로 표시하세요.
- 다음 구조를 사용하세요: "## 배경/목적", "## 요구사항"(번호 목록), "## 완료 조건"(- [ ] 체크리스트).
- 결과 본문(마크다운)만 출력하세요. 머리말·맺음말·설명 등 본문 외 텍스트는 절대 출력하지 마세요.

[제목] ${String(b.summary || "").trim() || "(없음)"}
[러프 설명]
${text}`;
    const refined = await runClaude(prompt, cred);
    if (!refined) throw new Error("변환 결과가 비어 있습니다.");
    res.json({ ok: true, description: refined });
  } catch (e) { fail(res, e); }
});

// 카드 생성
app.post("/api/jira/issue", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    if (!cfg.projectKey) throw new Error("프로젝트 키가 설정되지 않았습니다.");
    const b = req.body || {};
    const summary = String(b.summary || "").trim();
    if (!summary) throw new Error("요약(summary)은 필수입니다.");
    const fields = { project: { key: cfg.projectKey }, issuetype: { name: b.issueType || "Task" }, summary };
    if (b.description) fields.description = toADF(b.description);
    const parentKey = String(b.parentKey || "").trim();
    let autoNote = "";
    if (parentKey) {
      try {
        const parent = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(parentKey)}?fields=issuetype`, null, cfg, cred);
        const proj2 = await jiraReq("GET", `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`, null, cfg, cred);
        const pType = parent.fields && parent.fields.issuetype;
        const sub = (proj2.issueTypes || []).find((t) => t.subtask);
        const cType = (proj2.issueTypes || []).find((t) => t.name === fields.issuetype.name);
        const pLv = pType && pType.hierarchyLevel, cLv = cType && cType.hierarchyLevel;
        if (pLv != null && cLv != null && pLv !== cLv + 1) {
          const subName = sub ? sub.name : "Subtask";
          // 상위가 하위작업보다 한 단계 위(레벨0: 버그/작업/스토리)면, 그 아래로 가능한 건 Subtask 뿐 → 자동 전환
          if (sub && sub.hierarchyLevel != null && pLv === sub.hierarchyLevel + 1) {
            fields.issuetype = { name: sub.name };
            autoNote = `상위 ${parentKey}(${pType.name}) 하위라서 이슈 타입을 '${sub.name}'(으)로 자동 전환했습니다.`;
          } else {
            const e = new Error(cLv === 0 && pLv === 1
              ? `상위 ${parentKey} 가 에픽이 아니라 '${pType.name}'(레벨 ${pLv}) 입니다. 작업/스토리(레벨0)는 에픽 하위에만 둘 수 있습니다.`
              : `이슈 타입 '${fields.issuetype.name}'(레벨 ${cLv})과 상위 ${parentKey}(${pType.name}, 레벨 ${pLv})의 계층이 맞지 않습니다. 상위는 자식보다 한 단계 위여야 합니다(에픽 > 작업/스토리/버그 > 하위작업).`);
            e.hierarchy = true; throw e;
          }
        }
      } catch (e) { if (e.hierarchy) throw e; /* 검증 호출 실패(네트워크 등)는 무시하고 그대로 시도 */ }
      fields.parent = { key: parentKey };
    }
    if (b.addTriggerLabel) fields.labels = [cfg.triggerLabel || "claude-work"];
    if (b.assignSelf) { const me = await jiraReq("GET", "/rest/api/3/myself", null, cfg, cred); if (me.accountId) fields.assignee = { accountId: me.accountId }; }
    const created = await jiraReq("POST", "/rest/api/3/issue", { fields }, cfg, cred);
    const atts = Array.isArray(b.attachments) ? b.attachments : [];
    const attached = [], attachErrors = [];
    for (const a of atts) {
      try { await jiraAttach(created.key, a.filename, a.dataBase64, a.contentType, cfg, cred); attached.push(a.filename || "file"); }
      catch (e) { attachErrors.push(`${a.filename || "file"}: ${e.message}`); }
    }
    res.json({ ok: true, key: created.key, url: `https://${cfg.jiraSite}/browse/${created.key}`, attached, attachErrors, note: autoNote });
  } catch (e) { fail(res, e); }
});

// 카드별 claude 실행 로그
app.get("/api/claude-log/:key/:phase", (req, res) => {
  const { key, phase } = req.params;
  if (!["plan", "build"].includes(phase)) return res.status(400).json({ ok: false, message: "phase 오류" });
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "키 형식 오류" });
  try {
    const { cfg } = resolveProject(req);
    const p = path.join(cfg.workDir || SCRIPTS_DIR, "claude-logs", `${key}-${phase}.log`);
    if (!fs.existsSync(p)) return res.json({ ok: true, log: "(아직 claude 실행 로그가 없습니다)" });
    const lines = Math.min(parseInt(req.query.lines || "500", 10), 5000);
    res.json({ ok: true, log: fs.readFileSync(p, "utf8").split("\n").slice(-lines).join("\n") });
  } catch (e) { fail(res, e); }
});

// 카드 상세
app.get("/api/jira/issue/:key", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const key = req.params.key;
    const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels`, null, cfg, cred);
    const cs = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=50`, null, cfg, cred);
    const comments = (cs.comments || []).map((c) => ({ id: c.id, author: (c.author && c.author.displayName) || "?", accountId: c.author && c.author.accountId, created: c.created, body: adfToText(c.body) }));
    res.json({
      ok: true, key,
      summary: issue.fields && issue.fields.summary,
      status: issue.fields && issue.fields.status && issue.fields.status.name,
      labels: (issue.fields && issue.fields.labels) || [],
      description: adfToText(issue.fields && issue.fields.description),
      comments, url: `https://${cfg.jiraSite}/browse/${key}`,
    });
  } catch (e) { fail(res, e); }
});

// 답변 코멘트
app.post("/api/jira/issue/:key/comment", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const key = req.params.key;
    const body = String((req.body || {}).body || "").trim();
    if (!body) throw new Error("답변 내용을 입력하세요.");
    const replyTo = (req.body || {}).replyTo;
    await jiraReq("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/comment`, { body: replyTo ? buildReplyADF(body, replyTo) : toADF(body) }, cfg, cred);
    if ((req.body || {}).markAnswered) {
      await jiraReq("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: [{ add: cfg.answeredLabel || "claude-answered" }] } }, cfg, cred);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

// 처리 이력 (?project 로 필터 가능)
app.get("/api/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 1000);
  const filter = req.query.project;
  if (!fs.existsSync(HISTORY_PATH)) return res.json({ ok: true, entries: [] });
  const entries = [];
  for (const ln of fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean)) {
    try { const e = JSON.parse(ln); if (!filter || e.project === filter) entries.push(e); } catch {}
  }
  res.json({ ok: true, entries: entries.reverse().slice(0, limit) });
});

// env (프로젝트별 경로)
app.get("/api/env", (req, res) => {
  try {
    const { cfg } = resolveProject(req);
    const p = projectEnvPath(cfg);
    if (!fs.existsSync(p)) return res.json({ ok: true, path: p, exists: false, content: "", mtime: null, lines: 0 });
    const content = fs.readFileSync(p, "utf8");
    res.json({ ok: true, path: p, exists: true, content, mtime: fs.statSync(p).mtime.toISOString(), lines: content.split("\n").length });
  } catch (e) { fail(res, e); }
});
app.post("/api/env", (req, res) => {
  try {
    const { cfg } = resolveProject(req);
    const p = projectEnvPath(cfg);
    const content = (req.body && req.body.content != null) ? String(req.body.content) : "";
    if (fs.existsSync(p)) { try { fs.copyFileSync(p, `${p}.bak`); } catch {} }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, { mode: 0o600 });
    res.json({ ok: true, path: p, mtime: fs.statSync(p).mtime.toISOString() });
  } catch (e) { fail(res, e); }
});

// ----- 라이브 리로드 (SSE + 파일 감시) -----
const LIVERELOAD = process.env.DASHBOARD_NO_LIVERELOAD !== "1";
const liveClients = new Set();
if (LIVERELOAD) {
  app.get("/api/livereload", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders?.();
    res.write("retry: 1000\n\n");
    liveClients.add(res);
    req.on("close", () => liveClients.delete(res));
  });
  let reloadTimer = null;
  const broadcastReload = () => { for (const c of liveClients) { try { c.write("data: reload\n\n"); } catch {} } };
  try { fs.watch(path.join(ROOT, "public"), { recursive: true }, () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(broadcastReload, 100); }); }
  catch (e) { console.warn("  (livereload) 파일 감시 실패:", e.message); }
}

// 정적 프론트
app.use(express.static(path.join(ROOT, "public")));

app.listen(PORT, () => {
  console.log(`\n  Jira→Claude 대시보드: http://localhost:${PORT}`);
  console.log(`  스크립트 위치: ${SCRIPTS_DIR}`);
  console.log(`  프로젝트: ${listProjects().length}개`);
  const st = loopStatus();
  for (const t of ["plan", "build"]) if (st[t].running) console.log(`  복구: ${t} 루프 실행 중 (pid ${st[t].pid})`);
  console.log("");
});
