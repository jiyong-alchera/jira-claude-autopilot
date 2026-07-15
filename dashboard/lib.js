// =============================================================================
// lib.js — server.js 의 순수 로직 + 프로젝트 스토어(파일 경로 주입형). 단위 테스트 대상.
// =============================================================================
const fs = require("fs");
const crypto = require("crypto");

// 카드 env 암호화(AES-256-GCM) — 첨부엔 암호문만, 빌드 시 로컬 키로만 복호화
const ENC_PREFIX = "ENCv1:";
function loadOrCreateEnvKey(keyPath) {
  try { const b = Buffer.from(fs.readFileSync(keyPath, "utf8").trim(), "base64"); if (b.length === 32) return b; } catch {}
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
  return key;
}
function encryptEnv(plain, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return ENC_PREFIX + Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
function decryptEnv(data, key) {
  const s = String(data);
  if (!s.startsWith(ENC_PREFIX)) return s; // 평문 첨부 호환
  const buf = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

const DEFAULT_CREDS = { anthropicApiKey: "", openaiApiKey: "", geminiApiKey: "", githubToken: "", atlassianEmail: "", atlassianToken: "", slackWebhookUrl: "" };

const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return f; } };
const writeJson = (p, obj, mode) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), { mode: mode || 0o644 });

function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "proj";
}

// 카드↔repo 매핑 라벨 접두사 (Jira 라벨 안전 문자만 사용: repo_<name>)
const REPO_LABEL_PREFIX = "repo_";
function repoNameFromUrl(url) {
  return slugify(String(url || "").replace(/\.git$/, "").split("/").filter(Boolean).pop() || "repo");
}
// 프로젝트의 repo 목록 정규화: repos 배열 우선, 없으면 레거시 repoUrl 1개로 변환
function normalizeRepos(p) {
  if (Array.isArray(p.repos) && p.repos.length) {
    return p.repos.filter((r) => r && r.url).map((r) => ({
      name: r.name || repoNameFromUrl(r.url),
      url: r.url,
      baseBranch: r.baseBranch || p.baseBranch || "main",
      envDest: r.envDest || "",
    }));
  }
  if (p.repoUrl) return [{ name: repoNameFromUrl(p.repoUrl), url: p.repoUrl, baseBranch: p.baseBranch || "main", envDest: p.envDest || "" }];
  return [];
}
// ===== LLM 엔진 선택 =====
// 지원 엔진과 전역 기본값. 프로젝트가 engine/model 을 비우면 이 기본값을 상속한다.
const ENGINES = ["claude", "codex", "gemini"];
const DEFAULT_ENGINE = "claude";
const DEFAULT_MODEL = "";   // 비우면 엔진 CLI 의 기본 모델 사용

// 프로젝트 설정에서 실제 사용할 엔진/모델을 해석한다(잘못된 값·빈 값은 전역 기본값으로 폴백).
// 반환: { engine, model } — run-cycle.js·server.js 가 ENGINE/MODEL env 로 주입.
function resolveEngine(cfg) {
  const raw = (cfg && typeof cfg.engine === "string" ? cfg.engine : "").trim().toLowerCase();
  const engine = ENGINES.includes(raw) ? raw : DEFAULT_ENGINE;
  const model = (cfg && typeof cfg.model === "string" ? cfg.model : "").trim();
  return { engine, model };
}

// 카드 라벨로 대상 repo 결정: repo_<name> 라벨과 매칭. 없으면 첫 repo(기본).
function cardRepos(p, labels) {
  const repos = normalizeRepos(p);
  const names = (labels || []).filter((l) => l.indexOf(REPO_LABEL_PREFIX) === 0).map((l) => l.slice(REPO_LABEL_PREFIX.length));
  const sel = repos.filter((r) => names.includes(r.name));
  return sel.length ? sel : (repos.length ? [repos[0]] : []);
}

function triggerClause(cfg) {
  return cfg.triggerMode === "text" ? `text ~ "${cfg.triggerText}"` : `labels = "${cfg.triggerLabel}"`;
}

// 완료 전환 대상(doneStatus): 쉼표 구분 복수 허용. 첫 번째가 병합 시 전환 대상(주 완료 상태). 배열/문자열 수용.
function doneStatusList(cfg) {
  const raw = cfg && cfg.doneStatus;
  const arr = Array.isArray(raw) ? raw : String(raw == null ? "" : raw).split(",");
  return arr.map((s) => String(s).trim()).filter(Boolean);
}
// '완료로 인식'할 상태 집합 = doneStatus(전환 대상) ∪ 상태→단계 매핑에서 '완료(done)'로 지정한 상태들.
// 탐지 제외·'완료' 단계 판정에 쓰인다(중복 제거).
function effectiveDoneStatuses(cfg) {
  const mapped = Object.entries((cfg && cfg.statusStageMap) || {}).filter(([, v]) => v === "done").map(([k]) => k);
  return [...new Set([...doneStatusList(cfg), ...mapped])];
}

function detectJql(mode, cfg) {
  const proj = cfg.projectKey ? ` AND project = "${cfg.projectKey}"` : "";
  const failed = ` AND (labels != "${cfg.failedLabel}" OR labels IS EMPTY)`;
  // 완료 제외: 상태 카테고리 Done + '완료로 인식'하는 상태들(doneStatus ∪ 매핑 완료). (워크플로마다 완료가
  // 'Done 카테고리'일 수도, 'DEV COMPLETED'/'QA READY' 처럼 카테고리가 다른 커스텀 상태일 수도 있어 둘 다 제외)
  const dones = effectiveDoneStatuses(cfg);
  const doneName = dones.length === 1 ? ` AND status != "${dones[0]}"`
    : dones.length > 1 ? ` AND status NOT IN (${dones.map((s) => `"${s}"`).join(", ")})` : "";
  const prLabel = cfg.prOpenLabel || "claude-pr";
  const base = `assignee = currentUser() AND statusCategory != Done${doneName} AND ${triggerClause(cfg)}`;
  if (mode === "plan") return `${base} AND (labels != "${cfg.plannedLabel}" OR labels IS EMPTY)${failed}${proj}`;
  // review: PR 을 올린(claude-pr) 카드 = 병합 대기 PR. 이 PR 들을 자동 리뷰한다(build 와 상보적).
  if (mode === "review") return `${base} AND labels = "${prLabel}"${failed}${proj}`;
  // build: PR 을 이미 올린(claude-pr) 카드는 병합 대기 상태이므로 재빌드 대상에서 제외
  return `${base} AND labels = "${cfg.plannedLabel}" AND labels = "${cfg.answeredLabel}" AND (labels != "${prLabel}" OR labels IS EMPTY)${failed}${proj}`;
}

// PR 리뷰 승인 마커(자기 자신의 PR 은 formal approve 불가 → 이 고유 텍스트 코멘트로 승인 표시).
// 이 문자열이 PR 코멘트에 존재하면 review 루프는 해당 PR 을 승인 완료로 보고 이후 영구 스킵한다.
const REVIEW_APPROVED_MARKER = "CLAUDE-REVIEW-APPROVED";

// onMedia(attrs) 를 주면 media/mediaInline 노드를 그 반환값으로 치환(이미지 인라인 표시용). 없으면 무시(기존 동작).
function adfToText(node, onMedia) {
  if (!node) return "";
  if (Array.isArray(node)) return node.map((n) => adfToText(n, onMedia)).join("");
  if (node.type === "text") return node.text || "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return "@" + (node.attrs && node.attrs.text ? node.attrs.text.replace(/^@/, "") : "");
  if (node.type === "emoji") return (node.attrs && (node.attrs.shortName || node.attrs.text)) || "";
  if ((node.type === "media" || node.type === "mediaInline") && onMedia) return onMedia(node.attrs || {});
  const inner = node.content ? adfToText(node.content, onMedia) : "";
  if (node.type === "listItem") return "• " + inner.replace(/\n+$/, "") + "\n";
  if (node.type === "blockquote") { const t = inner.replace(/\n+$/, ""); return t.split("\n").map((l) => "> " + l).join("\n") + "\n"; }
  if (["paragraph", "heading", "codeBlock", "rule", "panel"].indexOf(node.type) !== -1) return inner + "\n";
  return inner;
}

// ADF media 노드 → 세그먼트. imgByName(첨부 filename→{id}) + images(순서 보존 첨부 목록)로 매칭.
// 반환: {type:"image", id|url, filename} | {type:"unavailable", reason, filename} | {type:"text", text}
const SEG_NUL = String.fromCharCode(0); // 일반 텍스트와 충돌하지 않는 구분자
function adfSegments(adf, imgByName, images) {
  imgByName = imgByName || {};
  images = images || [];
  const medias = [];
  const text = adfToText(adf, (a) => { medias.push(a || {}); return SEG_NUL + (medias.length - 1) + SEG_NUL; });
  const used = new Set();
  let cursor = 0; // 순서 기반 폴백용 다음 첨부 인덱스
  const resolve = (a) => {
    const alt = a.alt || "";
    if (alt && imgByName[alt]) { used.add(imgByName[alt].id); return { type: "image", id: imgByName[alt].id, filename: alt }; }
    // 외부 미디어: 공개 http(s) URL 은 직접 표시, blob: 등 서버가 못 가져오는 건 표시 불가 안내
    if (a.type === "external" && a.url) {
      if (/^https?:\/\//i.test(a.url)) return { type: "image", url: a.url, filename: alt };
      return { type: "unavailable", reason: "inline", filename: alt };
    }
    // 순서 기반 폴백: alt 가 없어 매칭 실패한 첨부 이미지를 노드 순서대로 연결
    while (cursor < images.length && used.has(images[cursor].id)) cursor++;
    if (cursor < images.length) { const att = images[cursor++]; used.add(att.id); return { type: "image", id: att.id, filename: att.filename || alt }; }
    return { type: "text", text: `[이미지: ${alt || "?"}]` };
  };
  const segs = [];
  const re = new RegExp(SEG_NUL + "(\\d+)" + SEG_NUL, "g");
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ type: "text", text: text.slice(last, m.index) });
    segs.push(resolve(medias[+m[1]]));
    last = re.lastIndex;
  }
  if (last < text.length) segs.push({ type: "text", text: text.slice(last) });
  return segs;
}

function toADF(text) {
  return { type: "doc", version: 1, content: String(text).split("\n").map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] })) };
}

// 인라인 마크다운(**굵게**, `코드`, [텍스트](url)·맨 URL) → ADF inline 노드 배열
function mdInline(s) {
  const nodes = [];
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s)]+)/g;
  let last = 0, m;
  const pushText = (t) => { if (t) nodes.push({ type: "text", text: t }); };
  while ((m = re.exec(s))) {
    pushText(s.slice(last, m.index));
    if (m[2] !== undefined) nodes.push({ type: "text", text: m[2], marks: [{ type: "strong" }] });
    else if (m[4] !== undefined) nodes.push({ type: "text", text: m[4], marks: [{ type: "code" }] });
    else if (m[5] !== undefined) nodes.push({ type: "text", text: m[6], marks: [{ type: "link", attrs: { href: m[7] } }] });
    else if (m[8] !== undefined) nodes.push({ type: "text", text: m[8], marks: [{ type: "link", attrs: { href: m[8] } }] });
    last = re.lastIndex;
  }
  pushText(s.slice(last));
  return nodes.length ? nodes : [{ type: "text", text: s }];
}

// 요약 마크다운 → ADF 문서(제목/불릿/표/구분선/문단). FE prefill 친화적 서식 보존용.
function mdToADF(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n/g, "\n").split("\n");
  const content = [];
  const isBullet = (l) => /^\s*[*\-]\s+/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i], t = line.trim();
    if (t === "") { i++; continue; }                                   // 빈 줄 = 문단 경계
    if (/^(-{3,}|\*{3,})$/.test(t)) { content.push({ type: "rule" }); i++; continue; }
    const hx = t.match(/^(#{1,6})\s+(.*)$/);
    if (hx) { content.push({ type: "heading", attrs: { level: hx[1].length }, content: mdInline(hx[2]) }); i++; continue; }
    if (isBullet(line)) {
      const items = [];
      while (i < lines.length && isBullet(lines[i])) {
        items.push({ type: "listItem", content: [{ type: "paragraph", content: mdInline(lines[i].replace(/^\s*[*\-]\s+/, "")) }] });
        i++;
      }
      content.push({ type: "bulletList", content: items });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {                                 // 표: 헤더/구분선 행 스킵, 나머지는 '·' 로 연결한 문단(우아한 강등)
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) { i++; continue; }
      const cells = t.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean);
      content.push({ type: "paragraph", content: mdInline(cells.join(" · ")) });
      i++; continue;
    }
    content.push({ type: "paragraph", content: mdInline(t) });
    i++;
  }
  return { type: "doc", version: 1, content };
}

function buildReplyADF(body, replyTo) {
  const content = [];
  if (replyTo && replyTo.snippet) {
    const q = String(replyTo.snippet).split("\n").map((ln) => ({ type: "paragraph", content: ln ? [{ type: "text", text: ln }] : [] }));
    content.push({ type: "blockquote", content: q.length ? q : [{ type: "paragraph", content: [] }] });
  }
  String(body).split("\n").forEach((ln, idx) => {
    const para = { type: "paragraph", content: [] };
    if (idx === 0 && replyTo && replyTo.accountId) {
      para.content.push({ type: "mention", attrs: { id: replyTo.accountId, text: "@" + (replyTo.author || "user") } });
      para.content.push({ type: "text", text: " " });
    }
    if (ln) para.content.push({ type: "text", text: ln });
    content.push(para);
  });
  if (content.length === 0) content.push({ type: "paragraph", content: [] });
  return { type: "doc", version: 1, content };
}

function maskCreds(c) {
  return {
    anthropicApiKey: !!c.anthropicApiKey, openaiApiKey: !!c.openaiApiKey, geminiApiKey: !!c.geminiApiKey, githubToken: !!c.githubToken,
    atlassianEmail: c.atlassianEmail || "", atlassianToken: !!c.atlassianToken, slackWebhookUrl: !!c.slackWebhookUrl,
  };
}

function applyCreds(cur, b) {
  const apply = (k) => (b[k] === undefined ? cur[k] : b[k] === "__CLEAR__" ? "" : b[k] === "" ? cur[k] : b[k]);
  return {
    anthropicApiKey: apply("anthropicApiKey"),
    openaiApiKey: apply("openaiApiKey"),
    geminiApiKey: apply("geminiApiKey"),
    githubToken: apply("githubToken"),
    atlassianEmail: b.atlassianEmail !== undefined ? b.atlassianEmail : cur.atlassianEmail,
    atlassianToken: apply("atlassianToken"),
    slackWebhookUrl: apply("slackWebhookUrl"),
  };
}

// 프로젝트 스토어(파일 경로 주입형) — 단위 테스트는 임시 경로로 생성해 검증한다.
function createStore({ projectsPath, credsPath, configPath, credPath, defaultConfig }) {
  function migrateIfNeeded() {
    if (readJson(projectsPath, null)) return false;
    const legacy = configPath && readJson(configPath, null);
    if (legacy) {
      const id = slugify(legacy.projectKey || "default");
      const name = legacy.projectKey || "기본 프로젝트";
      writeJson(projectsPath, { projects: [{ id, name, ...legacy }] });
      const lc = credPath && readJson(credPath, null);
      if (lc) writeJson(credsPath, { [id]: { ...DEFAULT_CREDS, ...lc } }, 0o600);
      return id;
    }
    writeJson(projectsPath, { projects: [] });
    return false;
  }
  function listProjects() {
    const raw = readJson(projectsPath, { projects: [] });
    return (raw.projects || []).map((p) => { const m = { ...defaultConfig, ...p }; return { ...m, repos: normalizeRepos(m) }; });
  }
  function getProject(id) { return listProjects().find((p) => p.id === id) || null; }
  function defaultProjectId() { const l = listProjects(); return l.length ? l[0].id : null; }
  function saveProject(p) {
    const list = listProjects();
    let id = p.id || slugify(p.name || p.projectKey || "proj");
    if (!p.id) { const base = id; let n = 2; while (list.some((x) => x.id === id)) id = `${base}-${n++}`; }
    const idx = list.findIndex((x) => x.id === id);
    const merged = idx >= 0 ? { ...list[idx], ...p, id } : { ...defaultConfig, ...p, id };
    if (idx >= 0) list[idx] = merged; else list.push(merged);
    writeJson(projectsPath, { projects: list });
    return merged;
  }
  function removeProject(id) {
    writeJson(projectsPath, { projects: listProjects().filter((p) => p.id !== id) });
    const all = readJson(credsPath, {});
    if (all[id]) { delete all[id]; writeJson(credsPath, all, 0o600); }
  }
  function getProjectCreds(id) { const all = readJson(credsPath, {}); return { ...DEFAULT_CREDS, ...(all[id] || {}) }; }
  function setProjectCreds(id, next) { const all = readJson(credsPath, {}); all[id] = { ...DEFAULT_CREDS, ...(all[id] || {}), ...next }; writeJson(credsPath, all, 0o600); }
  return { migrateIfNeeded, listProjects, getProject, defaultProjectId, saveProject, removeProject, getProjectCreds, setProjectCreds };
}

module.exports = {
  DEFAULT_CREDS, readJson, writeJson, slugify, triggerClause, detectJql,
  adfToText, adfSegments, toADF, mdInline, mdToADF, buildReplyADF, maskCreds, applyCreds, createStore, doneStatusList, effectiveDoneStatuses,
  REPO_LABEL_PREFIX, repoNameFromUrl, normalizeRepos, cardRepos, REVIEW_APPROVED_MARKER,
  loadOrCreateEnvKey, encryptEnv, decryptEnv,
  ENGINES, DEFAULT_ENGINE, DEFAULT_MODEL, resolveEngine,
};
