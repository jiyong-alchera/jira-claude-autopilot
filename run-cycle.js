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
if (!["plan", "build"].includes(phase)) { console.error("usage: run-cycle.js <plan|build>"); process.exit(2); }

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
  maxRetries: 3, maxParallel: 3, intervalSeconds: 3600, envMode: "content", envPath: "", envDest: "", cardEnvDir: "", cloneBase: path.join(SELF, "repos"),
  testCmd: "", buildCmd: "", repoUrl: "", jiraSite: "", projectKey: "", assigneeEmail: "", assigneeName: "",
};

function projectEnv(p, cred) {
  const cfg = { ...DEFAULTS, ...p };
  const repos = lib.normalizeRepos(cfg);
  const env = { ...process.env };
  env.PROJECT_ID = cfg.id || "";
  env.WORK_DIR = cfg.workDir;
  env.REPO_URL = (repos[0] && repos[0].url) || cfg.repoUrl || "";
  env.BASE_BRANCH = (repos[0] && repos[0].baseBranch) || cfg.baseBranch || "main";
  env.CARD_REPOS = reposToLines(cfg, repos);   // 기본=전체 repo(카드별로 좁혀짐)
  env.ASSIGNEE_EMAIL = cfg.assigneeEmail;
  env.ASSIGNEE_NAME = cfg.assigneeName;
  env.TRIGGER_MODE = cfg.triggerMode || "label";
  env.TRIGGER_LABEL = cfg.triggerLabel || "claude-work";
  env.TRIGGER_TEXT = cfg.triggerText;
  env.DONE_STATUS = cfg.doneStatus;
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
  if (cred && cred.githubToken) { env.GH_TOKEN = cred.githubToken; env.GITHUB_TOKEN = cred.githubToken; }
  if (cred && cred.slackWebhookUrl) env.SLACK_WEBHOOK_URL = cred.slackWebhookUrl;
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
      await runWithCap(keys, env, cfg.maxParallel || 3, cfg, cred);
      log(`[${p.id}] ${phase} 사이클 완료`);
    } catch (e) {
      log(`[${p.id}] ${phase} 오류: ${String((e && e.message) || e)}`);
    }
  }
})();
