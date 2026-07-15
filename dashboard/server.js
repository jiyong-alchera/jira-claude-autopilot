// =============================================================================
// Jira -> Claude 루프 자동화 대시보드 백엔드 (Express) — 멀티 프로젝트
// - 프로젝트(설정) / 프로젝트별 자격증명 로컬 저장
// - loop-plan / loop-build 스크립트 start/stop/status (한 루프가 전 프로젝트 순회 — Phase 2)
// - 로그 tail / 처리 이력 / Jira REST (카드 조회·등록·답변·첨부)
// =============================================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, execFile, execFileSync } = require("child_process");

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
// run-jira-claude.sh 의 record_history 와 동일 포맷으로 한 줄 추가(merge 등 대시보드 동작 기록)
function appendHistory(projectId, key, phase, result, pr, branch) {
  const e = { ts: new Date().toISOString(), project: projectId || "", key, phase, result, pr: pr || "", branch: branch || "" };
  try { fs.appendFileSync(HISTORY_PATH, JSON.stringify(e) + "\n"); } catch {}
}

// ----- 프로젝트 설정 기본값(템플릿) -----
const DEFAULT_CONFIG = {
  workDir: SCRIPTS_DIR,
  repoUrl: "",                                  // (레거시) 단일 repo — repos[] 로 대체됨
  repos: [],                                    // [{name,url,baseBranch}] 여러 repo
  baseBranch: "main",
  jiraSite: "",
  projectKey: "",
  assigneeEmail: "",
  assigneeName: "",
  triggerMode: "label",
  triggerLabel: "claude-work",
  triggerText: "claude-work",
  doneStatus: "DEV COMPLETED",
  statusStageMap: {},   // { "<Jira 상태명>": "<단계>" } — 특정 상태를 특정 단계로 강제 매핑(설정 UI)
  plannedLabel: "claude-planned",
  answeredLabel: "claude-answered",
  failedLabel: "claude-failed",
  prOpenLabel: "claude-pr",
  maxRetries: 3,
  maxParallel: 5,
  testCmd: "",
  buildCmd: "",
  intervalSeconds: 3600,
  reviewIntervalSeconds: 3600,   // review 루프 자체 주기(초)
  envMode: "content",
  envPath: "",                                  // 비우면 <workDir>/work-<id>.env 사용
  envDest: "",                                  // repo 내 복사 대상 상대경로(비우면 루트). 예: src/main/resources/application-private.properties
  cloneBase: path.join(SCRIPTS_DIR, "repos"),
  cardEnvDir: "",                               // 카드 전용 env 보관 디렉토리(비우면 <workDir>/card-envs)
  engine: "",                                   // LLM 엔진(claude|codex|gemini). 비우면 전역 기본값(claude)
  model: "",                                    // 엔진에 넘길 모델명. 비우면 엔진 기본 모델
};

// ----- 순수 로직 + 프로젝트 스토어 (단위 테스트 대상은 lib.js 로 분리) -----
const lib = require("./lib");
const { slugify, triggerClause, detectJql, adfToText, adfSegments, toADF, mdToADF, buildReplyADF, maskCreds, applyCreds, normalizeRepos, cardRepos, REPO_LABEL_PREFIX, doneStatusList, effectiveDoneStatuses } = lib;
// repo 별 env 파일 경로(repo 전용 env 만 사용; 없으면 미복사 — run-jira 가 -f 로 확인)
function repoEnvFile(cfg, repoName) { return path.join(cfg.workDir || SCRIPTS_DIR, `work-${cfg.id}-${repoName}.env`); }
function repoEnvSrc(cfg, repoName) { return repoEnvFile(cfg, repoName); }
// 카드 전용 env 보관 위치(로컬 전용, gitignore). Jira 첨부 없이 이 디렉토리에서만 읽고 쓴다.
function cardEnvDir(cfg) { return cfg.cardEnvDir || path.join(cfg.workDir || SCRIPTS_DIR, "card-envs"); }
function cardEnvLocal(cfg, key) { return path.join(cardEnvDir(cfg), `${key}.env`); }
// run-jira-claude.sh 에 넘길 줄 형식: name<US>url<US>baseBranch<US>envSrc<US>envDest (US=\x1f, 빈 필드 보존)
// envSrcOverride 가 있으면(=카드 전용 env) 모든 repo 의 envSrc 로 사용
const reposToLines = (cfg, repos, envSrcOverride) => (repos || []).map((r) =>
  [r.name, r.url, r.baseBranch || "main", envSrcOverride || repoEnvSrc(cfg, r.name), r.envDest || cfg.envDest || ""].join("\x1f")
).join("\n");
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
// 루프 동작이 바뀌면 이 버전을 올린다. 시작 시 버전이 다른(=구버전) 루프는 자동 재시작.
const LOOP_VERSION = "2";  // 2: 멀티 프로젝트(run-cycle.js) 순회
const loops = { plan: null, build: null, review: null };
const pidFile = (type) => path.join(SCRIPTS_DIR, `loop-${type}.pid`);
const verFile = (type) => path.join(SCRIPTS_DIR, `loop-${type}.ver`);
function readPid(type) {
  try { const pid = parseInt(fs.readFileSync(pidFile(type), "utf8").trim(), 10); return Number.isInteger(pid) ? pid : null; }
  catch { return null; }
}
function readVer(type) { try { return fs.readFileSync(verFile(type), "utf8").trim(); } catch { return null; } }
function isAlive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
// 카드 단위 중지용: pgrep -P 로 자식 PID 를 재귀 수집(macOS 에 /proc 없음). pid 자신은 미포함.
function descendantPids(pid) {
  const acc = [];
  const visit = (p) => {
    let kids = [];
    try { kids = execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8" }).split(/\s+/).filter(Boolean).map(Number); } catch { kids = []; }
    for (const k of kids) { if (!acc.includes(k)) { acc.push(k); visit(k); } }
  };
  visit(pid);
  return acc;
}
function clearPid(type) { try { fs.unlinkSync(pidFile(type)); } catch {} try { fs.unlinkSync(verFile(type)); } catch {} }

// 프로젝트별 env (run-jira-claude.sh 에 주입). id 미지정 시 첫 프로젝트.
function scriptEnv(id) {
  const cfg = getConfig(id);
  const cred = getCreds(cfg.id);
  const env = { ...process.env };
  const repos = normalizeRepos(cfg);
  env.PROJECT_ID = cfg.id || "";
  env.WORK_DIR = cfg.workDir;
  const eng = lib.resolveEngine(cfg);   // 프로젝트 override → 없으면 전역 기본값
  env.ENGINE = eng.engine;
  env.MODEL = eng.model;
  env.REPO_URL = (repos[0] && repos[0].url) || cfg.repoUrl || "";   // 폴백용 첫 repo
  env.BASE_BRANCH = (repos[0] && repos[0].baseBranch) || cfg.baseBranch || "main";
  env.CARD_REPOS = reposToLines(cfg, repos);                         // 기본=전체 repo(카드 라벨로 좁혀짐)
  env.ASSIGNEE_EMAIL = cfg.assigneeEmail;
  env.ASSIGNEE_NAME = cfg.assigneeName;
  env.TRIGGER_MODE = cfg.triggerMode || "label";
  env.TRIGGER_LABEL = cfg.triggerLabel || "claude-work";
  env.TRIGGER_TEXT = cfg.triggerText;
  env.DONE_STATUS = effectiveDoneStatuses(cfg).join(",");   // doneStatus ∪ 매핑 완료(탐지 제외·게이트에 사용)
  env.PLANNED_LABEL = cfg.plannedLabel;
  env.ANSWERED_LABEL = cfg.answeredLabel || "claude-answered";
  env.FAILED_LABEL = cfg.failedLabel || "claude-failed";
  env.PR_OPEN_LABEL = cfg.prOpenLabel || "claude-pr";
  env.MAX_RETRIES = String(cfg.maxRetries || 3);
  env.TEST_CMD = cfg.testCmd || "";
  env.BUILD_CMD = cfg.buildCmd || "";
  env.HISTORY_FILE = HISTORY_PATH;
  env.PROJECT_KEY = cfg.projectKey || "";
  env.ENV_SRC = projectEnvPath(cfg);
  env.ENV_DEST_REL = cfg.envDest || "";
  env.CLONE_BASE = cfg.cloneBase || path.join(cfg.workDir, "repos");
  env.LOOP_INTERVAL = String(cfg.intervalSeconds || 3600);
  env.MAX_PARALLEL = String(cfg.maxParallel || 5);
  env.DASHBOARD_URL = `http://localhost:${PORT}`;
  if (cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
  if (cred.openaiApiKey) env.OPENAI_API_KEY = cred.openaiApiKey;   // codex 엔진
  if (cred.geminiApiKey) env.GEMINI_API_KEY = cred.geminiApiKey;   // gemini 엔진
  if (cred.githubToken) { env.GH_TOKEN = cred.githubToken; env.GITHUB_TOKEN = cred.githubToken; }
  if (cred.slackWebhookUrl) env.SLACK_WEBHOOK_URL = cred.slackWebhookUrl;
  // 완료 내역을 설명 ADF 에 직접 append(이미지 보존)하기 위한 Jira REST 자격증명 — 단건 즉시 실행 경로에도 주입
  env.JIRA_SITE = cfg.jiraSite || "";
  if (cred.atlassianEmail) env.ATLASSIAN_EMAIL = cred.atlassianEmail;
  if (cred.atlassianToken) env.ATLASSIAN_TOKEN = cred.atlassianToken;
  return env;
}

function startLoop(type) {
  const existing = readPid(type);
  if (isAlive(existing)) return { ok: false, message: `${type} 루프가 이미 실행 중입니다 (pid ${existing}).` };
  clearPid(type);
  const script = path.join(SCRIPTS_DIR, `loop-${type}.sh`);
  if (!fs.existsSync(script)) return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  const loopEnv = { ...process.env, DASHBOARD_URL: `http://localhost:${PORT}` };
  if (type === "review") loopEnv.REVIEW_LOOP_INTERVAL = String(getConfig().reviewIntervalSeconds || getConfig().intervalSeconds || 3600);
  const proc = spawn("bash", [script], { cwd: SCRIPTS_DIR, env: loopEnv, detached: true, stdio: "ignore" });
  fs.writeFileSync(pidFile(type), String(proc.pid));
  fs.writeFileSync(verFile(type), LOOP_VERSION);   // 버전 마커(구버전 자동 교체 판단용)
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
function runCard(key, phase, stamp, projectId, reposLines, rework, reviewAfter, reviewOnly, reworkOnly) {
  const isReview = phase === "review";   // review 는 run-review.sh(PR 자동 리뷰), 그 외는 run-jira-claude.sh
  const script = path.join(SCRIPTS_DIR, isReview ? "run-review.sh" : "run-jira-claude.sh");
  if (!fs.existsSync(script)) return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  const logPath = path.join(SCRIPTS_DIR, `loop-${phase}.log`);
  let fd;
  try {
    fd = fs.openSync(logPath, "a");
    fs.writeSync(fd, `[${stamp}] (단건 즉시 실행) ${rework ? "REWORK" : phase.toUpperCase()}: ${key} [${projectId}]\n`);
  } catch (e) { return { ok: false, message: String(e.message || e) }; }
  const env = scriptEnv(projectId);
  if (reposLines != null) env.CARD_REPOS = reposLines;   // 카드 라벨로 좁힌 대상 repo
  if (rework) env.REWORK = "1";                          // 기존 PR 리뷰 반영 모드
  if (reworkOnly && reworkOnly.owner && reworkOnly.number != null) { env.REWORK_ONLY_OWNER = String(reworkOnly.owner); env.REWORK_ONLY_NUM = String(reworkOnly.number); }  // 개별 PR 반영
  if (reviewAfter) env.REVIEW_AFTER = "1";               // 리뷰 반영 후 이어서 재리뷰(run-review.sh)
  if (isReview) env.FORCE_REVIEW = "1";                  // 수동 review: 승인 마커 있어도 강제 재리뷰
  if (isReview && reviewOnly && reviewOnly.owner && reviewOnly.number != null) {  // 개별 PR 리뷰(사람 PR 포함)
    env.REVIEW_ONLY_OWNER = String(reviewOnly.owner); env.REVIEW_ONLY_NUM = String(reviewOnly.number);
  }
  const args = isReview ? [script, key] : [script, key, phase];
  const proc = spawn("bash", args, { cwd: SCRIPTS_DIR, env, detached: true, stdio: ["ignore", fd, fd] });
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
  for (const t of ["plan", "build", "review"]) {
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
// ----- PR 병합(rebase) — gh CLI 결정적 실행 + Jira 완료 전환 -----
function ghEnv(cred) { const e = { ...process.env }; if (cred && cred.githubToken) { e.GH_TOKEN = cred.githubToken; e.GITHUB_TOKEN = cred.githubToken; } return e; }
function ownerRepo(url) { const m = String(url || "").replace(/\.git$/, "").match(/[:/]([^/:]+\/[^/]+?)$/); return m ? m[1] : null; }
function gh(args, cred) {
  return new Promise((resolve) => {
    execFile("gh", args, { env: ghEnv(cred), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || "", stderr: stderr || (err && err.message) || "" }));
  });
}
// 카드의 열린 PR 들에 코멘트 작성(gh pr comment) — 리뷰 반영 요청 전달용
async function commentCardPRs(key, repos, body, cred) {
  const posted = [], errors = [];
  for (const repo of repos) {
    const or = ownerRepo(repo.url);
    if (!or) { errors.push(`${repo.name}: url 파싱 실패`); continue; }
    const list = await gh(["pr", "list", "--repo", or, "--search", key, "--state", "open", "--json", "number,url"], cred);
    let prs = []; try { prs = JSON.parse(list.stdout || "[]"); } catch {}
    if (!list.ok) { errors.push(`${repo.name}: ${(list.stderr || "").slice(0, 120)}`); continue; }
    for (const pr of prs) {
      const r = await gh(["pr", "comment", String(pr.number), "--repo", or, "--body", body], cred);
      if (r.ok) posted.push(pr.url); else errors.push(`${repo.name} #${pr.number}: ${(r.stderr || "").trim().slice(0, 120)}`);
    }
  }
  return { posted, errors };
}
// 한 repo 의 이 이슈 관련 PR 들의 리뷰 내용(리뷰·PR 코멘트·인라인 코멘트) 조회 — 대시보드 표시용
async function repoPRReviews(repo, key, cred) {
  const or = ownerRepo(repo.url);
  if (!or) return [];
  const list = await gh(["pr", "list", "--repo", or, "--search", key, "--state", "all", "--json", "number,url,title,state,headRefName"], cred);
  let prs = []; try { prs = JSON.parse(list.stdout || "[]"); } catch {}
  const out = [];
  for (const pr of prs) {
    const v = await gh(["pr", "view", String(pr.number), "--repo", or, "--json", "reviews,comments"], cred);
    let d = {}; try { d = JSON.parse(v.stdout || "{}"); } catch {}
    const ic = await gh(["api", `repos/${or}/pulls/${pr.number}/comments?per_page=100`], cred);
    let inline = []; try { inline = JSON.parse(ic.stdout || "[]"); } catch {}
    out.push({
      repo: repo.name, owner: or, number: pr.number, url: pr.url, title: pr.title, state: pr.state, branch: pr.headRefName,
      reviews: (d.reviews || [])
        .filter((r) => (r.body && r.body.trim()) || (r.state && r.state !== "COMMENTED" && r.state !== "PENDING"))
        .map((r) => ({ author: (r.author && r.author.login) || "?", state: r.state || "", body: r.body || "", submittedAt: r.submittedAt || "" })),
      comments: (d.comments || []).map((c) => ({ author: (c.author && c.author.login) || "?", body: c.body || "", createdAt: c.createdAt || "" })),
      inline: (Array.isArray(inline) ? inline : []).map((c) => ({ author: (c.user && c.user.login) || "?", body: c.body || "", path: c.path || "", line: c.line || c.original_line || null, createdAt: c.created_at || "" })),
    });
  }
  return out;
}

// 병합 완료된 카드의 clone 디렉토리(<repo이름>-<KEY>) 제거 — 작업 종료 후 디스크 정리. base 바로 아래 dir 만 안전 삭제.
function removeCardClones(cfg, key) {
  const base = cfg.cloneBase || path.join(cfg.workDir || SCRIPTS_DIR, "repos");
  const removed = [], errors = [];
  if (fs.existsSync(path.join(base, ".state", `${key}.lock`))) return { removed, errors: ["처리 중(lock) — clone 제거 생략"] };
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return { removed, errors }; }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === ".state" || !ent.name.endsWith(`-${key}`)) continue;
    const dir = path.join(base, ent.name);
    if (path.dirname(path.resolve(dir)) !== path.resolve(base)) continue;   // 경로 안전성: base 직속만
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(ent.name); }
    catch (e) { errors.push(`${ent.name}: ${(e && e.message) || e}`); }
  }
  return { removed, errors };
}

// 이슈를 완료 상태로 전환(설정한 완료 상태명 우선순위대로 시도, 없으면 Done 카테고리 transition)
async function transitionToDone(key, cfg, cred) {
  const t = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, null, cfg, cred);
  const trs = t.transitions || [];
  let tr = null;
  for (const name of effectiveDoneStatuses(cfg)) { tr = trs.find((x) => x.to && x.to.name === name); if (tr) break; }  // doneStatus(주 완료) → 매핑 완료 순으로 전환 시도
  if (!tr) tr = trs.find((x) => x.to && x.to.statusCategory && x.to.statusCategory.key === "done");
  if (!tr) throw new Error(`완료로 가는 transition 없음(가능: ${trs.map((x) => x.name).join(", ")})`);
  await jiraReq("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: tr.id } }, cfg, cred);
  return tr.to.name;
}
// statusStageMap 에서 특정 단계(stage)로 매핑된 Jira 상태로 전환(best-effort). 매핑/전환 없으면 null.
async function transitionToStageStatus(key, cfg, cred, stage) {
  const names = Object.entries((cfg && cfg.statusStageMap) || {}).filter(([, v]) => v === stage).map(([k]) => k);
  if (!names.length) return null;
  const t = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, null, cfg, cred);
  const trs = t.transitions || [];
  let tr = null;
  for (const name of names) { tr = trs.find((x) => x.to && x.to.name === name); if (tr) break; }
  if (!tr) return null;
  await jiraReq("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: tr.id } }, cfg, cred);
  return tr.to.name;
}
// 카드 전용 env: 로컬 card-envs/<KEY>.env 만 읽는다(Jira 폴백 없음). 없으면 null → repo 전용 env 사용.
function resolveCardEnv(key, cfg) {
  const p = cardEnvLocal(cfg, key);
  return fs.existsSync(p) ? p : null;
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
// 선택 엔진(claude|codex|gemini)으로 헤드리스 1회 실행. eng={engine,model} 는 lib.resolveEngine 결과.
function llmArgv(prompt, eng) {
  const model = (eng && eng.model) || "";
  switch ((eng && eng.engine) || "claude") {
    case "codex":  return ["codex", ["exec", ...(model ? ["-m", model] : []), prompt]];
    case "gemini": return ["gemini", [...(model ? ["-m", model] : []), "-p", prompt]];
    default:       return ["claude", ["-p", ...(model ? ["--model", model] : []), prompt]];
  }
}
function runClaude(prompt, cred, eng = null, timeoutMs = 120000) {
  const [bin, args] = llmArgv(prompt, eng || {});
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    if (cred && cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
    if (cred && cred.openaiApiKey) env.OPENAI_API_KEY = cred.openaiApiKey;
    if (cred && cred.geminiApiKey) env.GEMINI_API_KEY = cred.geminiApiKey;
    let child;
    try { child = spawn(bin, args, { env }); }
    catch (e) { return reject(new Error(`${bin} 실행 실패: ` + e.message)); }
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} reject(new Error(`${bin} 응답 시간 초과`)); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${bin} 실행 실패(설치/PATH/로그인 확인): ` + e.message)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(`${bin} 종료 코드 ${code}: ${err.slice(0, 300)}`)); });
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
  if (!["plan", "build", "review"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(startLoop(req.params.type));
});
app.post("/api/loops/:type/stop", (req, res) => {
  if (!["plan", "build", "review"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(stopLoop(req.params.type));
});
app.post("/api/loops/:type/run-once", (req, res) => {
  if (!["plan", "build", "review"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(runOnce(req.params.type));
});

// 특정 카드 1건 즉시 실행
app.post("/api/cards/:key/run", async (req, res) => {
  const key = req.params.key;
  const b = req.body || {};
  const phase = b.phase;
  const rework = !!b.rework;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  if (!["plan", "build", "review"].includes(phase)) return res.status(400).json({ ok: false, message: "phase 는 plan|build|review" });
  try {
    const { id, cfg, cred } = resolveProject(req);
    const reworkOnly = (rework && b.reworkOwner && b.reworkNumber != null) ? { owner: b.reworkOwner, number: String(b.reworkNumber) } : null;
    let reposLines = null, repos = [];
    try {
      // review·개별 PR rework 는 연동 PR 이 어느 repo 에 있든 찾도록 전 repo, 그 외 build 는 카드 대상(라벨) repo
      if (phase === "review" || reworkOnly) { repos = normalizeRepos(cfg); }
      else { const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=labels`, null, cfg, cred); repos = cardRepos(cfg, (issue.fields && issue.fields.labels) || []); }
      // 개별 PR rework: 그 PR 의 repo 로 한정(그 repo 만 clone)
      if (reworkOnly) { const m = repos.filter((r) => ownerRepo(r.url) === reworkOnly.owner); if (m.length) repos = m; }
      const cardEnv = resolveCardEnv(key, cfg);   // 카드 전용 env(로컬) → 있으면 우선
      reposLines = reposToLines(cfg, repos, cardEnv);
    } catch { reposLines = null; } // 조회 실패 시 scriptEnv 기본(전체 repo) 사용
    // rework: 메모가 있으면 PR 코멘트로 남김(반영 요청) — claude 가 PR 코멘트를 읽어 반영
    if (rework && String(b.memo || "").trim()) {
      const body = `[리뷰 반영 요청]\n${b.memo}`;
      if (reworkOnly) {
        const r = await gh(["pr", "comment", reworkOnly.number, "--repo", reworkOnly.owner, "--body", body], cred);
        if (!r.ok) return res.json({ ok: false, message: `PR 코멘트 실패: ${(r.stderr || "").slice(0, 160)}` });
      } else {
        const target = repos.length ? repos : cardRepos(cfg, []);
        const { posted, errors } = await commentCardPRs(key, target, body, cred);
        if (!posted.length) return res.json({ ok: false, message: "PR 코멘트 실패(열린 PR 없음/권한): " + (errors[0] || "") });
      }
    }
    const reviewOnly = (b.reviewOwner && b.reviewNumber != null) ? { owner: b.reviewOwner, number: b.reviewNumber } : null;
    res.json(runCard(key, phase, new Date().toISOString(), id, reposLines, rework, !!b.reviewAfter, reviewOnly, reworkOnly));
  } catch (e) { fail(res, e); }
});

// 처리 중인 카드의 claude 작업 중지 — 락 PID 의 프로세스 트리(run-jira-claude.sh→claude→도구)를 종료.
// body.phase 지정 시 그 단계만: 'review' → <KEY>.review.lock, 'plan'/'build' → <KEY>.lock. 없으면 전부.
// (루프/run-cycle/다른 카드는 건드리지 않음)
app.post("/api/cards/:key/stop", (req, res) => {
  const key = req.params.key;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  try {
    const { cfg } = resolveProject(req);
    const stateDir = path.join(cfg.cloneBase || path.join(cfg.workDir || SCRIPTS_DIR, "repos"), ".state");
    const reqPhase = (req.body && req.body.phase) || req.query.phase || "";
    const suffixes = reqPhase === "review" ? [".review.lock"] : (reqPhase === "plan" || reqPhase === "build") ? [".lock"] : [".lock", ".review.lock"];
    const alive = [];
    for (const suffix of suffixes) {
      const lockDir = path.join(stateDir, `${key}${suffix}`);
      let pid = null; try { pid = parseInt(fs.readFileSync(`${lockDir}.pid`, "utf8").trim(), 10); } catch {}
      if (pid && isAlive(pid)) { let phase = ""; try { phase = fs.readFileSync(`${lockDir}.phase`, "utf8").trim(); } catch {} alive.push({ lockDir, pid, phase }); }
    }
    if (!alive.length) return res.json({ ok: false, message: "처리 중인 작업이 없습니다(이미 종료됨)." });
    let killed = 0;
    for (const { lockDir, pid, phase } of alive) {
      const tree = [...descendantPids(pid), pid]; // 자식 먼저, 루트(bash) 마지막
      for (const p of tree) { try { process.kill(p, "SIGTERM"); } catch {} }
      killed += tree.length;
      // 4초 후: 잔존 프로세스는 SIGKILL, 락은 무조건 정리(SIGKILL 은 trap 미실행 → 스테일 락 방지)
      setTimeout(() => {
        for (const p of [pid, ...descendantPids(pid)].filter(isAlive)) { try { process.kill(p, "SIGKILL"); } catch {} }
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        try { fs.unlinkSync(`${lockDir}.phase`); } catch {}
        try { fs.unlinkSync(`${lockDir}.pid`); } catch {}
      }, 4000);
      try { fs.appendFileSync(HISTORY_PATH, JSON.stringify({ ts: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"), project: cfg.id || "", key, phase: phase || "run", result: "stopped", pr: "", branch: "" }) + "\n"); } catch {}
    }
    res.json({ ok: true, killed, message: `중지 요청됨 (${alive.map((a) => a.phase || "run").join(", ")} · pid ${alive.map((a) => a.pid).join(", ")})` });
  } catch (e) { fail(res, e); }
});

// 기존 카드의 대상 repo 라벨(repo_<name>) 설정 — 프로젝트 repo 목록과 교집합만 반영
app.post("/api/cards/:key/repos", async (req, res) => {
  const key = req.params.key;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  try {
    const { cfg, cred } = resolveProject(req);
    const projNames = normalizeRepos(cfg).map((r) => r.name);
    const want = (Array.isArray(req.body && req.body.repos) ? req.body.repos : []).filter((n) => projNames.includes(n));
    const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=labels`, null, cfg, cred);
    const cur = (issue.fields && issue.fields.labels) || [];
    const curRepo = cur.filter((l) => l.indexOf(REPO_LABEL_PREFIX) === 0);
    const desired = want.map((n) => REPO_LABEL_PREFIX + n);
    const ops = [];
    desired.filter((l) => !curRepo.includes(l)).forEach((l) => ops.push({ add: l }));
    curRepo.filter((l) => !desired.includes(l)).forEach((l) => ops.push({ remove: l }));
    if (ops.length) await jiraReq("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: ops } }, cfg, cred);
    res.json({ ok: true, repos: want });
  } catch (e) { fail(res, e); }
});

// 봇(자동화) GitHub 로그인 — PR author 로 자동화/사람 PR 구분(비면 판별 불가 → 전체를 자동화로 간주하는 폴백)
async function ghUserLogin(cred) {
  try { const r = await gh(["api", "user", "--jq", ".login"], cred); return r.ok ? (r.stdout || "").trim() : ""; } catch { return ""; }
}
// 카드의 '모든' PR(대상 repo들) — author/state 포함. 1:N 표현·병합·완료 판정에 공통 사용.
async function listCardPRs(repos, key, cred) {
  const out = [];
  for (const repo of repos) {
    const or = ownerRepo(repo.url); if (!or) continue;
    const list = await gh(["pr", "list", "--repo", or, "--search", key, "--state", "all", "--json", "number,url,title,state,headRefName,baseRefName,isDraft,author,createdAt,mergeable,mergeStateStatus"], cred);
    let prs = []; try { prs = JSON.parse(list.stdout || "[]"); } catch {}
    for (const pr of prs) out.push({ repo: repo.name, owner: or, number: pr.number, url: pr.url, title: pr.title, state: pr.state, branch: pr.headRefName || "", base: pr.baseRefName || "", isDraft: !!pr.isDraft, author: (pr.author && pr.author.login) || "", createdAt: pr.createdAt || "", mergeable: pr.mergeable || "UNKNOWN", mergeState: pr.mergeStateStatus || "UNKNOWN" });
  }
  return out;
}
// 시스템이 관리하는 설명 섹션 heading — 재실행 시 해당 섹션만 제자리 교체하기 위한 경계 인식용.
const MANAGED_SECTIONS = new Set(["완료 내역", "🤖 Claude 고도화 설명"]);
const isManagedHeading = (n) => n && n.type === "heading" && MANAGED_SECTIONS.has(adfToText(n).trim());
// markdown 섹션을 카드 설명 ADF 에 안전하게 반영(기존 노드·이미지 보존).
// append-summary.js 와 동일하게 markdown↔ADF 왕복 없이 붙여넣은 이미지 media 노드를 보존한다.
// 같은 heading 의 기존 섹션이 있으면 다음 관리 섹션(또는 끝)까지만 제자리 교체 → 뒤따르는 다른 관리 섹션(예: 완료 내역)은 보존.
async function appendMarkdownSection(cfg, cred, key, heading, markdown) {
  const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=description`, null, cfg, cred);
  const adf = (issue.fields && issue.fields.description) || { type: "doc", version: 1, content: [] };
  if (!Array.isArray(adf.content)) adf.content = [];
  const section = [
    { type: "rule" },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: heading }] },
    ...mdToADF(markdown).content,
  ];
  const idx = adf.content.findIndex((n) => n && n.type === "heading" && adfToText(n).trim() === heading);
  if (idx === -1) { adf.content.push(...section); }
  else {
    let start = idx; if (start > 0 && adf.content[start - 1] && adf.content[start - 1].type === "rule") start -= 1;
    let end = adf.content.length;   // 다음 관리 섹션 heading 직전까지가 이 섹션의 범위(본문 내 ## 소제목은 관리 heading 이 아님)
    for (let j = idx + 1; j < adf.content.length; j++) {
      if (isManagedHeading(adf.content[j])) { end = (adf.content[j - 1] && adf.content[j - 1].type === "rule") ? j - 1 : j; break; }
    }
    adf.content.splice(start, end - start, ...section);
  }
  await jiraReq("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { fields: { description: adf } }, cfg, cred);
}
// 완료 내역 append(머지 시점 최종 내용으로 갱신) — 서버에서 직접 수행.
async function appendCompletionSummary(cfg, cred, key, markdown) {
  return appendMarkdownSection(cfg, cred, key, "완료 내역", markdown);
}
// 머지된 PR 들의 최종 본문으로 완료 내역 markdown 구성(PR 본문은 rework 시 갱신되므로 최종 반영 내용).
async function buildMergeSummaryMd(mergedPRs, cred) {
  const parts = [];
  for (const pr of mergedPRs) {
    let body = "", title = "";
    try { const v = await gh(["pr", "view", String(pr.number), "--repo", pr.owner, "--json", "title,body"], cred); const d = JSON.parse(v.stdout || "{}"); body = (d.body || "").trim(); title = d.title || ""; } catch {}
    parts.push(`### ${pr.owner}#${pr.number}${title ? ` — ${title}` : ""}\n\n${body || "(PR 본문 없음)"}\n\n- PR: ${pr.url}\n- 브랜치: ${pr.branch || "-"}`);
  }
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `PR 병합으로 최종 반영된 내용입니다(머지 시점 기준).\n\n${parts.join("\n\n---\n\n")}\n\n- 병합 완료 일시: ${stamp}`;
}
// 카드 완료 확정(공통): 상태 전환 + prOpen 라벨 제거 + clone 정리 + 이력 기록 + '완료 내역'을 최종 머지 내용으로 갱신
async function finalizeCardDone(id, cfg, cred, key, mergedPRs, errors) {
  let doneStatus = null;
  try { doneStatus = await transitionToDone(key, cfg, cred); } catch (e) { if (errors) errors.push(`상태전환: ${e.message}`); }
  try { await jiraReq("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: [{ remove: cfg.prOpenLabel || "claude-pr" }] } }, cfg, cred); } catch {}
  // 머지 시점에 최종 PR 본문으로 완료 내역 갱신(리뷰/rework 로 바뀐 최종 내용 반영, 이미지 보존)
  try { await appendCompletionSummary(cfg, cred, key, await buildMergeSummaryMd(mergedPRs, cred)); } catch (e) { if (errors) errors.push(`완료 내역 갱신: ${e.message}`); }
  const rc = removeCardClones(cfg, key);
  appendHistory(id, key, "merge", "merged", (mergedPRs[0] && mergedPRs[0].url) || "", (mergedPRs[0] && mergedPRs[0].branch) || "");
  return { doneStatus, removed: rc.removed };
}
// 자동화(봇) PR 이 모두 병합됐으면(열린 봇 PR 0 · 병합 봇 PR ≥1) 카드 완료. 사람 PR 은 완료 판정에서 제외.
async function maybeFinalizeCard(id, cfg, cred, key, repos, botLogin) {
  const bot = (await listCardPRs(repos, key, cred)).filter((p) => !botLogin || p.author === botLogin);
  const openBot = bot.filter((p) => p.state === "OPEN");
  const mergedBot = bot.filter((p) => p.state === "MERGED");
  if (mergedBot.length && openBot.length === 0) {
    const fin = await finalizeCardDone(id, cfg, cred, key, mergedBot, []);
    return { finalized: true, ...fin };
  }
  return { finalized: false };
}

// 카드의 PR 목록(1:N) — 자동화/사람 PR 구분(isBot) 포함
app.get("/api/cards/:key/prs", async (req, res) => {
  const key = req.params.key;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  try {
    const { cfg, cred } = resolveProject(req);
    const repos = normalizeRepos(cfg);   // PR 탐색: build 대상 라벨과 무관하게 프로젝트 전 repo 검색(연동 PR 이 어느 repo 에 있든 인식)
    const botLogin = await ghUserLogin(cred);
    const prs = (await listCardPRs(repos, key, cred)).map((p) => ({ ...p, isBot: !botLogin || p.author === botLogin }));
    res.json({ ok: true, prs, botLogin });
  } catch (e) { fail(res, e); }
});

// 카드의 PR 병합 — body.{owner,number} 지정 시 '그 PR 하나만'(사람 PR 포함), 아니면 자동화(봇) PR 전체.
// 병합 후 자동화 PR 이 모두 병합됐으면 카드를 완료 처리한다.
app.post("/api/cards/:key/merge", async (req, res) => {
  const key = req.params.key;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  try {
    const { id, cfg, cred } = resolveProject(req);
    const body = req.body || {};
    const repos = normalizeRepos(cfg);   // PR 탐색: build 대상 라벨과 무관하게 프로젝트 전 repo 검색(연동 PR 이 어느 repo 에 있든 인식)
    if (!repos.length) return res.json({ ok: false, message: "대상 repo 가 없습니다." });
    const botLogin = await ghUserLogin(cred);
    const allPRs = await listCardPRs(repos, key, cred);
    let targets;
    if (body.owner && body.number != null) {   // 개별 PR 지정(사용자가 명시 선택 — 사람 PR 도 가능)
      targets = allPRs.filter((p) => p.owner === body.owner && String(p.number) === String(body.number));
      if (!targets.length) return res.json({ ok: false, message: "지정한 PR 을 찾을 수 없습니다." });
    } else {                                    // 기본: 자동화(봇) PR 전체
      targets = allPRs.filter((p) => !botLogin || p.author === botLogin);
    }
    const mergedUrls = [], branches = [], errors = [];
    for (const pr of targets) {
      if (pr.state === "MERGED") { mergedUrls.push(pr.url); branches.push(pr.branch); continue; }
      if (pr.state !== "OPEN") continue;
      const r = await gh(["pr", "merge", String(pr.number), "--repo", pr.owner, "--rebase", "--delete-branch"], cred);
      if (r.ok) { mergedUrls.push(pr.url); branches.push(pr.branch); } else errors.push(`${pr.repo} #${pr.number}: ${(r.stderr || "").trim().slice(0, 160)}`);
    }
    let doneStatus = null, removed = [];
    if (mergedUrls.length) {
      const fin = await maybeFinalizeCard(id, cfg, cred, key, repos, botLogin);
      if (fin.finalized) { doneStatus = fin.doneStatus; removed = fin.removed; }
    }
    res.json({ ok: mergedUrls.length > 0, merged: mergedUrls.length, doneStatus, errors, prs: mergedUrls, removed });
  } catch (e) { fail(res, e); }
});

// 외부(대시보드 밖)에서 병합된 카드 자동 완료: 자동화(봇) PR 이 모두 병합됐으면 완료 처리(사람 PR 은 무시).
async function completeMergedCards(id) {
  const cfg = getConfig(id), cred = getCreds(id);
  if (!cfg.jiraSite || !cred || !cred.atlassianToken) return { completed: [] };
  let data; try { data = await jiraSearch(detectJql("review", cfg), cfg, cred); } catch { return { completed: [] }; }
  const botLogin = await ghUserLogin(cred);
  const completed = [];
  for (const i of (data.issues || [])) {
    const key = i.key;
    const repos = normalizeRepos(cfg);   // 완료 판정도 프로젝트 전 repo 의 PR 로
    if (!repos.length) continue;
    try { const fin = await maybeFinalizeCard(id, cfg, cred, key, repos, botLogin); if (fin.finalized) completed.push(key); } catch {}
  }
  return { completed };
}
// 외부 병합 동기화(수동 트리거) — project 지정 시 해당 프로젝트, 없으면 전 프로젝트
app.post("/api/cards/sync-merged", async (req, res) => {
  try {
    const pid = req.query.project || (req.body && req.body.project);
    const ids = pid ? [pid] : listProjects().map((p) => p.id);
    const completed = [];
    for (const id of ids) { try { const r = await completeMergedCards(id); r.completed.forEach((k) => completed.push({ project: id, key: k })); } catch {} }
    res.json({ ok: true, completed });
  } catch (e) { fail(res, e); }
});

// 카드의 PR 리뷰 내용(리뷰·PR 코멘트·인라인 코멘트) 조회 — 카드 상세의 '리뷰' 영역에서 표시
app.get("/api/cards/:key/reviews", async (req, res) => {
  const key = req.params.key;
  if (!/^[A-Z][A-Z0-9]+-[0-9]+$/.test(key)) return res.status(400).json({ ok: false, message: "이슈 키 형식 오류" });
  try {
    const { cfg, cred } = resolveProject(req);
    const repos = normalizeRepos(cfg);   // PR 탐색: build 대상 라벨과 무관하게 프로젝트 전 repo 검색(연동 PR 이 어느 repo 에 있든 인식)
    const results = [];
    for (const r of repos) { try { results.push(...await repoPRReviews(r, key, cred)); } catch { /* repo 단위 실패는 건너뜀 */ } }
    res.json({ ok: true, prs: results });
  } catch (e) { fail(res, e); }
});

// REST 탐지
app.get("/api/detect/:mode", async (req, res) => {
  if (!["plan", "build", "review"].includes(req.params.mode)) return res.status(400).json({ ok: false, message: "mode 오류" });
  try {
    const { cfg, cred } = resolveProject(req);
    const data = await jiraSearch(detectJql(req.params.mode, cfg), cfg, cred);
    res.json({ ok: true, mode: req.params.mode, keys: (data.issues || []).map((i) => i.key) });
  } catch (e) { fail(res, e); }
});

// 로그
app.get("/api/logs/:type", (req, res) => {
  if (!["plan", "build", "review"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  const lines = Math.min(parseInt(req.query.lines || "200", 10), 2000);
  const logPath = path.join(SCRIPTS_DIR, `loop-${req.params.type}.log`);
  if (!fs.existsSync(logPath)) return res.json({ log: "(로그 파일 없음 — 아직 실행 전)" });
  res.json({ log: fs.readFileSync(logPath, "utf8").split("\n").slice(-lines).join("\n") });
});
app.post("/api/logs/:type/clear", (req, res) => {
  if (!["plan", "build", "review"].includes(req.params.type)) return res.status(400).json({ ok: false, message: "type 오류" });
  try { fs.writeFileSync(path.join(SCRIPTS_DIR, `loop-${req.params.type}.log`), ""); res.json({ ok: true }); }
  catch (e) { fail(res, e); }
});

// 카드 상태
const myselfCache = new Map();   // cred 토큰 → 내 accountId(할당자=나 판별용)
async function myAccountId(cfg, cred) {
  const k = (cred && cred.atlassianToken) || "";
  if (myselfCache.has(k)) return myselfCache.get(k);
  let id = "";
  try { const me = await jiraReq("GET", "/rest/api/3/myself", null, cfg, cred); id = (me && me.accountId) || ""; } catch {}
  myselfCache.set(k, id);
  return id;
}
// 프로젝트 상태 파이프라인 조회 — 설정의 '상태 → 단계 매핑' UI 에서 사용
app.get("/api/jira/statuses", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    if (!cfg.projectKey) throw new Error("프로젝트 키가 설정되지 않았습니다.");
    const data = await jiraReq("GET", `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}/statuses`, null, cfg, cred);
    const seen = new Set(), statuses = [];
    for (const t of (data || [])) for (const s of (t.statuses || [])) {
      if (seen.has(s.name)) continue; seen.add(s.name);
      statuses.push({ name: s.name, category: (s.statusCategory && s.statusCategory.key) || "" });
    }
    res.json({ ok: true, statuses });
  } catch (e) { fail(res, e); }
});
app.get("/api/cards", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
    // 할당자 무관하게 트리거(claude-work) 카드를 모두 인식. 각 카드에 assignedToMe 플래그로 구분.
    const data = await jiraSearch(`${triggerClause(cfg)}${proj} ORDER BY created DESC`, cfg, cred);
    const myId = await myAccountId(cfg, cred);
    const stateDir = path.join(cfg.cloneBase || path.join(cfg.workDir || SCRIPTS_DIR, "repos"), ".state");
    // 처리 중 여부: 카드별 락 + '살아있는' PID 확인. build/plan(<KEY>.lock)·review(<KEY>.review.lock) 둘 다 인식.
    // 여러 단계가 동시에 돌 수 있으므로(예: build+review) 활성 단계 목록을 반환. 스테일 락(죽은 PID)은 제외.
    const procPhases = (key) => {
      const phases = [];
      for (const suffix of [".lock", ".review.lock"]) {
        const lock = path.join(stateDir, `${key}${suffix}`);
        if (!fs.existsSync(lock)) continue;
        let pid = null; try { pid = parseInt(fs.readFileSync(`${lock}.pid`, "utf8").trim(), 10); } catch {}
        if (pid && !isAlive(pid)) continue;   // 죽은 프로세스(스테일 락) → 무시
        let ph = "run"; try { ph = fs.readFileSync(`${lock}.phase`, "utf8").trim() || "run"; } catch {}
        phases.push(ph);
      }
      return phases;
    };
    const labelStage = (it) => {
      if (it.labels.includes(cfg.failedLabel)) return "failed";
      if (it.labels.includes(cfg.prOpenLabel)) return "await-merge";   // PR 올림 → 병합 대기
      const planned = it.labels.includes(cfg.plannedLabel), answered = it.labels.includes(cfg.answeredLabel);
      if (planned && answered) return "build-ready";
      if (planned) return "awaiting-answer";
      return "plan-ready";
    };
    const issues = (data.issues || []).map((i) => {
      const catKey = i.fields.status?.statusCategory?.key; // "new" | "indeterminate" | "done"
      const assignee = i.fields.assignee;
      const assignedToMe = !!myId && !!assignee && assignee.accountId === myId;
      const it = { key: i.key, summary: i.fields.summary, status: i.fields.status?.name, labels: i.fields.labels || [], url: `https://${cfg.jiraSite}/browse/${i.key}`, assignedToMe, assignee: (assignee && assignee.displayName) || null };
      const phases = procPhases(i.key);
      const proc = phases.join("+") || null;   // 배지 표기용(예: "build+review")
      const mapped = (cfg.statusStageMap || {})[it.status];   // 설정에서 이 상태를 특정 단계로 강제 매핑
      let stage;
      if (phases.length) stage = "processing";                               // 실행 중(살아있는 락)이면 최우선 → 완료 상태여도 중지 가능
      else if (mapped) stage = mapped;                                       // 상태→단계 매핑(예: QA READY → done)
      else if (catKey === "done" || effectiveDoneStatuses(cfg).includes(it.status)) stage = "done"; // 상태 카테고리 Done 이거나 '완료로 인식' 상태(doneStatus ∪ 매핑 완료)
      else stage = labelStage(it);
      return { ...it, stage, proc, procPhases: phases };
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
    const { cfg, cred } = resolveProject(req);
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
    const refined = await runClaude(prompt, cred, lib.resolveEngine(cfg));
    if (!refined) throw new Error("변환 결과가 비어 있습니다.");
    res.json({ ok: true, description: refined });
  } catch (e) { fail(res, e); }
});

// 기존 카드(툴 생성 여부 무관) 본문 → Claude 고도화. 미리보기만 생성하고 Jira 에는 반영하지 않음.
const ENHANCE_HEADING = "🤖 Claude 고도화 설명";
app.post("/api/jira/issue/:key/enhance", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const key = req.params.key;
    const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description`, null, cfg, cred);
    const summary = (issue.fields && issue.fields.summary) || "";
    let current = adfToText(issue.fields && issue.fields.description).trim();
    const hi = current.indexOf(ENHANCE_HEADING);   // 이전 고도화 섹션은 입력에서 제외(중복 고도화 방지)
    if (hi !== -1) current = current.slice(0, hi).trim();
    const prompt = `다음은 기존 Jira 카드의 본문입니다. 개발 담당자가 착수하기 좋도록 체계적인 한국어 설명으로 고도화(보강)하세요.

규칙:
- 입력에 없는 사실/요구사항을 지어내지 마세요. 모호한 부분은 "(확인 필요)" 로 표시하세요.
- 다음 구조를 사용하세요: "## 배경/목적", "## 요구사항"(번호 목록), "## 완료 조건"(- [ ] 체크리스트).
- 결과 본문(마크다운)만 출력하세요. 머리말·맺음말·설명 등 본문 외 텍스트는 절대 출력하지 마세요.

[제목] ${summary || "(없음)"}
[기존 본문]
${current || "(본문 없음)"}`;
    const enhanced = await runClaude(prompt, cred, lib.resolveEngine(cfg));
    if (!enhanced) throw new Error("고도화 결과가 비어 있습니다.");
    res.json({ ok: true, description: enhanced, heading: ENHANCE_HEADING });
  } catch (e) { fail(res, e); }
});

// 고도화 결과를 카드 설명 하단에 '🤖 Claude 고도화 설명' 섹션으로 반영(원문·이미지 보존, 재실행 시 같은 섹션 교체).
app.post("/api/jira/issue/:key/enhance/apply", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const key = req.params.key;
    const markdown = String((req.body && req.body.description) || "").trim();
    if (!markdown) throw new Error("반영할 고도화 본문이 없습니다.");
    await appendMarkdownSection(cfg, cred, key, ENHANCE_HEADING, markdown);
    res.json({ ok: true });
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
    const labels = [];
    if (b.addTriggerLabel) labels.push(cfg.triggerLabel || "claude-work");
    (Array.isArray(b.repos) ? b.repos : []).forEach((n) => { if (n) labels.push(REPO_LABEL_PREFIX + n); }); // 대상 repo 라벨
    if (labels.length) fields.labels = labels;
    if (b.assignSelf) { const me = await jiraReq("GET", "/rest/api/3/myself", null, cfg, cred); if (me.accountId) fields.assignee = { accountId: me.accountId }; }
    const created = await jiraReq("POST", "/rest/api/3/issue", { fields }, cfg, cred);
    const atts = Array.isArray(b.attachments) ? b.attachments : [];
    const attached = [], attachErrors = [];
    for (const a of atts) {
      try { await jiraAttach(created.key, a.filename, a.dataBase64, a.contentType, cfg, cred); attached.push(a.filename || "file"); }
      catch (e) { attachErrors.push(`${a.filename || "file"}: ${e.message}`); }
    }
    // 카드 전용 env: Jira 첨부 없이 로컬 card-envs/<KEY>.env 에 저장(빌드 시 그대로 읽어 각 repo 의 envDest 로 복사)
    if (String(b.env || "").trim()) {
      try {
        const p = cardEnvLocal(cfg, created.key);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, b.env, { mode: 0o600 });
        attached.push(`card-envs/${created.key}.env`);
      } catch (e) { attachErrors.push(`card env: ${e.message}`); }
    }
    res.json({ ok: true, key: created.key, url: `https://${cfg.jiraSite}/browse/${created.key}`, attached, attachErrors, note: autoNote });
  } catch (e) { fail(res, e); }
});

// 카드별 claude 실행 로그
app.get("/api/claude-log/:key/:phase", (req, res) => {
  const { key, phase } = req.params;
  if (!["plan", "build", "review"].includes(phase)) return res.status(400).json({ ok: false, message: "phase 오류" });
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
    const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,labels,attachment`, null, cfg, cred);
    const cs = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=50`, null, cfg, cred);
    const imgByName = {};
    const images = []; // 순서 보존 이미지 첨부 목록(alt 없는 미디어 노드 순서 매칭용)
    ((issue.fields && issue.fields.attachment) || []).forEach((a) => {
      if (String(a.mimeType || "").startsWith("image/")) {
        const att = { id: a.id, filename: a.filename, mimeType: a.mimeType };
        imgByName[a.filename] = att;
        images.push(att);
      }
    });
    const comments = (cs.comments || []).map((c) => ({ id: c.id, author: (c.author && c.author.displayName) || "?", accountId: c.author && c.author.accountId, created: c.created, body: adfToText(c.body), bodySegments: adfSegments(c.body, imgByName, images) }));
    let transitions = [];   // 현재 상태에서 워크플로상 갈 수 있는 상태(수동 전환 드롭다운용)
    try { const t = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, null, cfg, cred); transitions = (t.transitions || []).map((x) => ({ id: x.id, to: (x.to && x.to.name) || x.name })); } catch {}
    res.json({
      ok: true, key,
      summary: issue.fields && issue.fields.summary,
      status: issue.fields && issue.fields.status && issue.fields.status.name,
      labels: (issue.fields && issue.fields.labels) || [],
      description: adfToText(issue.fields && issue.fields.description),
      descriptionSegments: adfSegments(issue.fields && issue.fields.description, imgByName, images),
      // 인라인 임베드 여부와 무관하게 이슈의 '모든' 첨부(이미지·문서)를 목록으로 제공(프록시로 열람/다운로드)
      attachments: ((issue.fields && issue.fields.attachment) || []).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType, size: a.size })),
      comments, transitions, url: `https://${cfg.jiraSite}/browse/${key}`,
    });
  } catch (e) { fail(res, e); }
});

// 카드 첨부 이미지 프록시: 브라우저는 Jira 인증을 못 하므로 백엔드가 Basic auth 로 받아 스트리밍한다.
app.get("/api/jira/issue/:key/attachment/:id", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    if (!/^\d+$/.test(req.params.id)) return res.status(400).end();
    const url = `https://${cfg.jiraSite}/rest/api/3/attachment/content/${req.params.id}`;
    let up = await fetch(url, { headers: { Authorization: `Basic ${jiraAuth(cred)}` }, redirect: "manual" });
    const loc = up.headers.get("location");
    if (up.status >= 300 && up.status < 400 && loc) up = await fetch(loc); // 서명 URL(인증 헤더 미전달)
    if (!up.ok) return res.status(up.status).end();
    res.setHeader("Content-Type", up.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch (e) { res.status(502).end(); }
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
    let movedTo = null;
    if ((req.body || {}).markAnswered) {
      await jiraReq("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, { update: { labels: [{ add: cfg.answeredLabel || "claude-answered" }] } }, cfg, cred);
      // 답변 완료 → '개발 대기(build-ready)' 로 매핑된 Jira 상태로 전환(매핑돼 있고 전환 가능할 때)
      try { movedTo = await transitionToStageStatus(key, cfg, cred, "build-ready"); } catch {}
    }
    res.json({ ok: true, movedTo });
  } catch (e) { fail(res, e); }
});

// 카드의 Jira 상태 수동 전환(대시보드에서 직접) — transitionId 는 상세 응답의 transitions[].id
app.post("/api/jira/issue/:key/transition", async (req, res) => {
  try {
    const { cfg, cred } = resolveProject(req);
    const key = req.params.key;
    const transitionId = (req.body || {}).transitionId;
    if (!transitionId) throw new Error("전환 ID가 필요합니다.");
    await jiraReq("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: String(transitionId) } }, cfg, cred);
    const issue = await jiraReq("GET", `/rest/api/3/issue/${encodeURIComponent(key)}?fields=status`, null, cfg, cred);
    res.json({ ok: true, status: issue.fields && issue.fields.status && issue.fields.status.name });
  } catch (e) { fail(res, e); }
});

// 처리 이력 (?project 로 필터 가능)
// 키→티켓 제목 캐시(이력에 제목 열 표시용). 제목은 거의 안 변하므로 영속 캐시 → 4초 폴링 시 재조회 없음.
const summaryCache = new Map();
async function enrichSummaries(entries) {
  const byProject = new Map();   // project → 조회 필요한 키 Set
  for (const e of entries) {
    if (!e.key || !e.project || summaryCache.has(e.key)) continue;
    if (!byProject.has(e.project)) byProject.set(e.project, new Set());
    byProject.get(e.project).add(e.key);
  }
  for (const [pid, keySet] of byProject) {
    const cfg = getConfig(pid), cred = getCreds(pid);
    if (!cfg.jiraSite || !cred || !cred.atlassianToken) continue;
    const allKeys = [...keySet].filter((k) => /^[A-Z][A-Z0-9]+-[0-9]+$/.test(k));
    for (let i = 0; i < allKeys.length; i += 50) {   // JQL key IN(...) 길이 제한 회피 위해 50개씩 배치
      const keys = allKeys.slice(i, i + 50);
      try {
        const data = await jiraSearch(`key IN (${keys.join(",")})`, cfg, cred);
        for (const iss of (data.issues || [])) summaryCache.set(iss.key, (iss.fields && iss.fields.summary) || "");
      } catch {}
      for (const k of keys) if (!summaryCache.has(k)) summaryCache.set(k, "");   // 실패/누락 키 빈값 캐시(반복 조회 방지)
    }
  }
  return entries.map((e) => ({ ...e, summary: summaryCache.get(e.key) || "" }));
}
app.get("/api/history", async (req, res) => {
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : 0;   // limit 없으면 전체 반환(제한 없음)
  const filter = req.query.project;
  if (!fs.existsSync(HISTORY_PATH)) return res.json({ ok: true, entries: [] });
  const entries = [];
  for (const ln of fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean)) {
    try { const e = JSON.parse(ln); if (!filter || e.project === filter) entries.push(e); } catch {}
  }
  entries.reverse();   // 최신 먼저
  const sliced = limit > 0 ? entries.slice(0, limit) : entries;
  let out = sliced;
  try { out = await enrichSummaries(sliced); } catch { /* 제목 보강 실패해도 이력은 반환 */ }
  res.json({ ok: true, entries: out });
});

// env (프로젝트별 경로)
app.get("/api/env", (req, res) => {
  try {
    const { cfg } = resolveProject(req);
    const p = req.query.repo ? repoEnvFile(cfg, req.query.repo) : projectEnvPath(cfg);
    if (!fs.existsSync(p)) return res.json({ ok: true, path: p, exists: false, content: "", mtime: null, lines: 0 });
    const content = fs.readFileSync(p, "utf8");
    res.json({ ok: true, path: p, exists: true, content, mtime: fs.statSync(p).mtime.toISOString(), lines: content.split("\n").length });
  } catch (e) { fail(res, e); }
});
app.post("/api/env", (req, res) => {
  try {
    const { cfg } = resolveProject(req);
    const p = req.query.repo ? repoEnvFile(cfg, req.query.repo) : projectEnvPath(cfg);
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
  // 구버전 루프 자동 교체: 실행 중이지만 버전 마커가 현재와 다르면(=구버전/마커 없음) 신버전으로 재시작
  for (const t of ["plan", "build", "review"]) {
    const pid = readPid(t);
    if (isAlive(pid) && readVer(t) !== LOOP_VERSION) {
      console.log(`  구버전 ${t} 루프(pid ${pid}, ver ${readVer(t) || "없음"}) 감지 → 신버전(v${LOOP_VERSION})으로 재시작`);
      stopLoop(t);
      const r = startLoop(t);
      if (r.ok) console.log(`  → ${t} 루프 재시작 (pid ${r.pid})`);
    }
  }
  const st = loopStatus();
  for (const t of ["plan", "build", "review"]) if (st[t].running) console.log(`  복구: ${t} 루프 실행 중 (pid ${st[t].pid})`);
  // 외부(대시보드 밖) 병합 자동 반영: 주기적으로 await-merge 카드의 PR 병합 여부를 확인해 완료 처리
  const MERGE_SYNC_MS = 180000; // 3분
  const syncAll = async () => { for (const p of listProjects()) { try { const r = await completeMergedCards(p.id); if (r.completed.length) console.log(`[merge-sync] ${p.id}: 외부 병합 완료 처리 ${r.completed.join(", ")}`); } catch {} } };
  setInterval(syncAll, MERGE_SYNC_MS).unref?.();
  setTimeout(syncAll, 8000).unref?.(); // 부팅 직후 1회
  console.log(`  외부 병합 자동 동기화: ${MERGE_SYNC_MS / 1000}s 주기`);
  console.log("");
});
