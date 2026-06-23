// =============================================================================
// Jira -> Claude 루프 자동화 대시보드 백엔드 (Express)
// - 설정(config) / 자격증명(credentials) 로컬 저장
// - loop-plan / loop-build 스크립트 start/stop/status
// - 로그 tail
// - Jira REST 로 claude-work 카드 상태 조회
// =============================================================================
const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4317;
const ROOT = __dirname;                       // dashboard 폴더
const SCRIPTS_DIR = path.resolve(ROOT, ".."); // loop-work 폴더 (스크립트/로그 위치)
const CONFIG_PATH = path.join(ROOT, "config.json");
const CRED_PATH = path.join(ROOT, "credentials.json");
const HISTORY_PATH = path.join(SCRIPTS_DIR, "history.jsonl"); // run-jira-claude.sh 가 기록하는 처리 이력

// ----- 기본 설정값 (중립 기본값 — 대시보드에서 프로젝트별로 설정) -----
const DEFAULT_CONFIG = {
  workDir: SCRIPTS_DIR,
  repoUrl: "",                                  // 대상 GitHub repo URL
  baseBranch: "main",
  jiraSite: "",                                 // 예: your-team.atlassian.net
  projectKey: "",                               // 예: PROJ
  assigneeEmail: "",
  assigneeName: "",
  triggerMode: "label",                         // label | text — 트리거 판정 방식(label 권장)
  triggerLabel: "claude-work",                  // label 모드 트리거 라벨
  triggerText: "claude-work",                   // text 모드(레거시) 트리거 텍스트
  doneStatus: "DEV COMPLETED",
  plannedLabel: "claude-planned",
  answeredLabel: "claude-answered",             // 담당자 답변 완료 신호(build 진입 게이트)
  failedLabel: "claude-failed",                 // 반복 실패 카드 표시(탐지 제외)
  maxRetries: 3,                                // 연속 실패 N회 초과 시 실패 처리
  maxParallel: 3,                               // 동시에 처리할 카드 수 상한
  testCmd: "",                                  // 테스트 명령(비우면 claude 자동 감지)
  buildCmd: "",                                 // 빌드 명령(비우면 claude 자동 감지)
  intervalSeconds: 3600,
  envPath: path.join(SCRIPTS_DIR, "work.env"),  // 대상 repo로 복사할 env 파일
  cloneBase: path.join(SCRIPTS_DIR, "repos"),   // clone 베이스 폴더
};

// ----- 파일 IO 헬퍼 -----
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJson(p, obj, mode) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });
}
function getConfig() {
  return { ...DEFAULT_CONFIG, ...readJson(CONFIG_PATH, {}) };
}
function getCreds() {
  return readJson(CRED_PATH, {
    anthropicApiKey: "",
    githubToken: "",
    atlassianEmail: "",
    atlassianToken: "",
    slackWebhookUrl: "",
  });
}

// ----- 실행 중인 루프 프로세스 추적 (pidfile 기반: 백엔드 재시작 후에도 상태 일치) -----
const loops = { plan: null, build: null }; // 메모리 핸들(있으면 사용): { proc }
const pidFile = (type) => path.join(SCRIPTS_DIR, `loop-${type}.pid`);

function readPid(type) {
  try {
    const pid = parseInt(fs.readFileSync(pidFile(type), "utf8").trim(), 10);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}
function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function clearPid(type) {
  try { fs.unlinkSync(pidFile(type)); } catch {}
}

function scriptEnv() {
  const cfg = getConfig();
  const cred = getCreds();
  const env = { ...process.env };
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
  env.ENV_SRC = cfg.envPath || path.join(cfg.workDir, "work.env");
  env.CLONE_BASE = cfg.cloneBase || path.join(cfg.workDir, "repos");
  env.LOOP_INTERVAL = String(cfg.intervalSeconds || 3600);
  env.MAX_PARALLEL = String(cfg.maxParallel || 3);
  env.DASHBOARD_URL = `http://localhost:${PORT}`; // 루프가 REST 탐지를 호출할 주소
  if (cred.anthropicApiKey) env.ANTHROPIC_API_KEY = cred.anthropicApiKey;
  if (cred.githubToken) {
    env.GH_TOKEN = cred.githubToken;
    env.GITHUB_TOKEN = cred.githubToken;
  }
  if (cred.slackWebhookUrl) env.SLACK_WEBHOOK_URL = cred.slackWebhookUrl;
  return env;
}

function startLoop(type) {
  const existing = readPid(type);
  if (isAlive(existing)) {
    return { ok: false, message: `${type} 루프가 이미 실행 중입니다 (pid ${existing}).` };
  }
  clearPid(type); // 죽은 프로세스의 잔여 pidfile 정리
  const script = path.join(SCRIPTS_DIR, `loop-${type}.sh`);
  if (!fs.existsSync(script)) {
    return { ok: false, message: `스크립트를 찾을 수 없습니다: ${script}` };
  }
  const proc = spawn("bash", [script], {
    cwd: SCRIPTS_DIR,
    env: scriptEnv(),
    detached: true,
    stdio: "ignore",
  });
  fs.writeFileSync(pidFile(type), String(proc.pid)); // 디스크에 pid 기록(재시작 후 복구용)
  loops[type] = { proc };
  proc.on("exit", () => {
    if (loops[type] && loops[type].proc === proc) loops[type] = null;
    if (readPid(type) === proc.pid) clearPid(type); // 스스로 종료 시 pidfile 정리
  });
  proc.unref(); // 백엔드가 자식 때문에 이벤트 루프를 붙들지 않도록
  return { ok: true, pid: proc.pid };
}

function stopLoop(type) {
  const pid = readPid(type);
  if (!isAlive(pid)) {
    clearPid(type);
    loops[type] = null;
    return { ok: false, message: `${type} 루프가 실행 중이 아닙니다.` };
  }
  try {
    process.kill(-pid, "SIGTERM"); // 프로세스 그룹 종료(loop + run-jira-claude + claude 자식 포함)
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  clearPid(type);
  loops[type] = null;
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
    } else {
      if (pid) clearPid(t); // stale pidfile 정리(크래시 등으로 죽은 경우)
      out[t] = { running: false };
    }
  }
  return out;
}

// ----- Jira REST: 카드 상태 조회 -----
async function jiraSearch(jql) {
  const cfg = getConfig();
  const cred = getCreds();
  if (!cred.atlassianEmail || !cred.atlassianToken) {
    throw new Error("Atlassian 이메일/토큰이 설정되지 않았습니다.");
  }
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  const url = `https://${cfg.jiraSite}/rest/api/3/search/jql`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ jql, fields: ["summary", "status", "labels", "assignee"], maxResults: 50 }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jira ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// 범용 Jira REST 요청(인증 + 에러 처리). jiraSearch 와 동일 자격증명 사용.
async function jiraReq(method, urlPath, body) {
  const cfg = getConfig();
  const cred = getCreds();
  if (!cred.atlassianEmail || !cred.atlassianToken) throw new Error("Atlassian 이메일/토큰이 설정되지 않았습니다.");
  if (!cfg.jiraSite) throw new Error("Jira 사이트가 설정되지 않았습니다.");
  const auth = Buffer.from(`${cred.atlassianEmail}:${cred.atlassianToken}`).toString("base64");
  const res = await fetch(`https://${cfg.jiraSite}${urlPath}`, {
    method,
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Jira ${res.status}: ${txt.slice(0, 400)}`);
  return txt ? JSON.parse(txt) : {};
}

// 평문 설명 → Atlassian Document Format(ADF) 변환(REST v3 description 필드용)
function toADF(text) {
  const lines = String(text).split("\n");
  return {
    type: "doc",
    version: 1,
    content: lines.map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] })),
  };
}

// 트리거 판정 절(label 모드 권장, text 모드는 레거시)
function triggerClause(cfg) {
  return cfg.triggerMode === "text"
    ? `text ~ "${cfg.triggerText}"`
    : `labels = "${cfg.triggerLabel}"`;
}

// detect-cards.sh 와 동일한 JQL 을 구성(REST 결정적 탐지용)
function detectJql(mode, cfg) {
  const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
  const failed = ` AND (labels != "${cfg.failedLabel}" OR labels IS EMPTY)`;
  const base = `assignee = currentUser() AND status != "${cfg.doneStatus}" AND ${triggerClause(cfg)}`;
  if (mode === "plan") {
    return `${base} AND (labels != "${cfg.plannedLabel}" OR labels IS EMPTY)${failed}${proj}`;
  }
  return `${base} AND labels = "${cfg.plannedLabel}" AND labels = "${cfg.answeredLabel}"${failed}${proj}`;
}

// =============================== API ROUTES ==================================
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/config", (req, res) => res.json(getConfig()));
app.post("/api/config", (req, res) => {
  const merged = { ...getConfig(), ...(req.body || {}) };
  writeJson(CONFIG_PATH, merged);
  res.json({ ok: true, config: merged });
});

// 자격증명: GET 은 값 노출 없이 설정 여부만 반환
app.get("/api/credentials", (req, res) => {
  const c = getCreds();
  res.json({
    anthropicApiKey: !!c.anthropicApiKey,
    githubToken: !!c.githubToken,
    atlassianEmail: c.atlassianEmail || "",
    atlassianToken: !!c.atlassianToken,
    slackWebhookUrl: !!c.slackWebhookUrl,
  });
});
app.post("/api/credentials", (req, res) => {
  const cur = getCreds();
  const b = req.body || {};
  // 빈 문자열로 덮어쓰지 않도록(마스킹된 필드 유지). 명시적으로 지우려면 "__CLEAR__".
  const apply = (k) => {
    if (b[k] === undefined) return cur[k];
    if (b[k] === "__CLEAR__") return "";
    if (b[k] === "") return cur[k];
    return b[k];
  };
  const next = {
    anthropicApiKey: apply("anthropicApiKey"),
    githubToken: apply("githubToken"),
    atlassianEmail: b.atlassianEmail !== undefined ? b.atlassianEmail : cur.atlassianEmail,
    atlassianToken: apply("atlassianToken"),
    slackWebhookUrl: apply("slackWebhookUrl"),
  };
  writeJson(CRED_PATH, next, 0o600);
  res.json({ ok: true });
});

app.get("/api/loops/status", (req, res) => res.json(loopStatus()));
app.post("/api/loops/:type/start", (req, res) => {
  const { type } = req.params;
  if (!["plan", "build"].includes(type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(startLoop(type));
});
app.post("/api/loops/:type/stop", (req, res) => {
  const { type } = req.params;
  if (!["plan", "build"].includes(type)) return res.status(400).json({ ok: false, message: "type 오류" });
  res.json(stopLoop(type));
});

// REST 기반 결정적 탐지 (루프가 claude 탐지 대신 우선 사용; 실패 시 claude 폴백)
app.get("/api/detect/:mode", async (req, res) => {
  const { mode } = req.params;
  if (!["plan", "build"].includes(mode)) return res.status(400).json({ ok: false, message: "mode 오류" });
  try {
    const data = await jiraSearch(detectJql(mode, getConfig()));
    res.json({ ok: true, mode, keys: (data.issues || []).map((i) => i.key) });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

app.get("/api/logs/:type", (req, res) => {
  const { type } = req.params;
  if (!["plan", "build"].includes(type)) return res.status(400).json({ ok: false, message: "type 오류" });
  const lines = Math.min(parseInt(req.query.lines || "200", 10), 2000);
  const logPath = path.join(SCRIPTS_DIR, `loop-${type}.log`);
  if (!fs.existsSync(logPath)) return res.json({ log: "(로그 파일 없음 — 아직 실행 전)" });
  const content = fs.readFileSync(logPath, "utf8").split("\n");
  res.json({ log: content.slice(-lines).join("\n") });
});

app.get("/api/cards", async (req, res) => {
  try {
    const cfg = getConfig();
    const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
    const base = `assignee = currentUser() AND ${triggerClause(cfg)}${proj}`;
    const data = await jiraSearch(`${base} ORDER BY key ASC`);
    const issues = (data.issues || []).map((i) => ({
      key: i.key,
      summary: i.fields.summary,
      status: i.fields.status?.name,
      labels: i.fields.labels || [],
      url: `https://${cfg.jiraSite}/browse/${i.key}`,
    }));
    // 단계 분류
    const classify = (it) => {
      if (it.status === cfg.doneStatus) return "done";
      if (it.labels.includes(cfg.failedLabel)) return "failed";
      const planned = it.labels.includes(cfg.plannedLabel);
      const answered = it.labels.includes(cfg.answeredLabel);
      if (planned && answered) return "build-ready";   // 라벨 게이트 통과(실제 답변은 build 단계에서 재확인)
      if (planned) return "awaiting-answer";           // plan 완료, claude-answered 라벨 대기
      return "plan-ready";
    };
    res.json({ ok: true, issues: issues.map((it) => ({ ...it, stage: classify(it) })) });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// ----- 카드 등록: 메타(이슈 타입 + 에픽 목록) -----
app.get("/api/jira/meta", async (req, res) => {
  try {
    const cfg = getConfig();
    if (!cfg.projectKey) throw new Error("프로젝트 키가 설정되지 않았습니다.");
    const proj = await jiraReq("GET", `/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`);
    const issueTypes = (proj.issueTypes || []).map((t) => ({ id: t.id, name: t.name, subtask: !!t.subtask }));
    let epics = [];
    try {
      const data = await jiraSearch(`project = "${cfg.projectKey}" AND issuetype = Epic ORDER BY created DESC`);
      epics = (data.issues || []).map((i) => ({ key: i.key, summary: i.fields.summary }));
    } catch { /* 에픽 없음/권한 등은 무시 */ }
    res.json({ ok: true, projectKey: cfg.projectKey, issueTypes, epics });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// ----- 카드 등록: 생성 -----
app.post("/api/jira/issue", async (req, res) => {
  try {
    const cfg = getConfig();
    if (!cfg.projectKey) throw new Error("프로젝트 키가 설정되지 않았습니다.");
    const b = req.body || {};
    const summary = String(b.summary || "").trim();
    if (!summary) throw new Error("요약(summary)은 필수입니다.");
    const fields = {
      project: { key: cfg.projectKey },
      issuetype: { name: b.issueType || "Task" },
      summary,
    };
    if (b.description) fields.description = toADF(b.description);
    const parentKey = String(b.parentKey || "").trim();
    if (parentKey) fields.parent = { key: parentKey };
    if (b.addTriggerLabel) fields.labels = [cfg.triggerLabel || "claude-work"];
    if (b.assignSelf) {
      const me = await jiraReq("GET", "/rest/api/3/myself");
      if (me.accountId) fields.assignee = { accountId: me.accountId };
    }
    const created = await jiraReq("POST", "/rest/api/3/issue", { fields });
    res.json({ ok: true, key: created.key, url: `https://${cfg.jiraSite}/browse/${created.key}` });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// ----- 처리 이력 -----
app.get("/api/history", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "100", 10), 1000);
  if (!fs.existsSync(HISTORY_PATH)) return res.json({ ok: true, entries: [] });
  const lines = fs.readFileSync(HISTORY_PATH, "utf8").split("\n").filter(Boolean);
  const entries = [];
  for (const ln of lines) {
    try { entries.push(JSON.parse(ln)); } catch {} // 깨진 줄은 건너뜀
  }
  res.json({ ok: true, entries: entries.reverse().slice(0, limit) }); // 최신순
});

// ----- work.env 모니터링/편집 -----
app.get("/api/env", (req, res) => {
  const cfg = getConfig();
  const p = cfg.envPath || path.join(cfg.workDir, "work.env");
  try {
    if (!fs.existsSync(p)) {
      return res.json({ ok: true, path: p, exists: false, content: "", mtime: null, lines: 0 });
    }
    const content = fs.readFileSync(p, "utf8");
    const stat = fs.statSync(p);
    res.json({
      ok: true,
      path: p,
      exists: true,
      content,
      mtime: stat.mtime.toISOString(),
      lines: content.split("\n").length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

app.post("/api/env", (req, res) => {
  const cfg = getConfig();
  const p = cfg.envPath || path.join(cfg.workDir, "work.env");
  const content = (req.body && req.body.content != null) ? String(req.body.content) : "";
  try {
    // 저장 전 기존 파일 백업(.bak)
    if (fs.existsSync(p)) {
      try { fs.copyFileSync(p, `${p}.bak`); } catch {}
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, { mode: 0o600 });
    const stat = fs.statSync(p);
    res.json({ ok: true, path: p, mtime: stat.mtime.toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e.message || e) });
  }
});

// ----- 라이브 리로드 (SSE + 파일 감시, 외부 의존성 없음) -----
// 프론트 파일이 바뀌면 연결된 브라우저에 reload 이벤트를 보내 자동 새로고침한다.
// 백엔드 재시작(nodemon 등) 시에도 SSE 가 끊겼다 재연결되며 브라우저가 새로고침된다.
// 비활성화: DASHBOARD_NO_LIVERELOAD=1
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
  const broadcastReload = () => {
    for (const c of liveClients) { try { c.write("data: reload\n\n"); } catch {} }
  };
  try {
    fs.watch(path.join(ROOT, "public"), { recursive: true }, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(broadcastReload, 100); // 연속 저장 디바운스
    });
  } catch (e) {
    console.warn("  (livereload) 파일 감시 실패:", e.message);
  }
}

// 정적 프론트
app.use(express.static(path.join(ROOT, "public")));

app.listen(PORT, () => {
  console.log(`\n  Jira→Claude 대시보드: http://localhost:${PORT}`);
  console.log(`  스크립트 위치: ${SCRIPTS_DIR}`);
  // pidfile 로 살아있는 루프 복구 보고(백엔드 재시작 후 상태 일치)
  const st = loopStatus();
  for (const t of ["plan", "build"]) {
    if (st[t].running) console.log(`  복구: ${t} 루프 실행 중 (pid ${st[t].pid})`);
  }
  console.log("");
});
