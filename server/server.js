#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8788);
const SITE_ID = "workplace-personality";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SUBMISSIONS_FILE = path.join(DATA_DIR, "submissions.jsonl");
const STATS_HTML_PATH = process.env.STATS_HTML_PATH || path.join(__dirname, "..", "stats.html");
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://personality.kiraown.com,https://personalitystats.kiraown.com,http://127.0.0.1:4173,http://localhost:4173")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

ensureDataDir();
let state = readState();
let writeQueue = Promise.resolve();

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      return sendJson(req, res, 204, {});
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/stats.html")) {
      return sendHtml(req, res, 200, readStatsHtml());
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(req, res, 200, { ok: true, service: "personality-stats", updatedAt: new Date().toISOString() });
    }

    if (req.method === "GET" && url.pathname === "/api/summary") {
      return sendJson(req, res, 200, buildSummary(url.searchParams.get("siteId") || SITE_ID));
    }

    if (req.method === "POST" && url.pathname === "/api/complete") {
      const body = await readRequestBody(req);
      const payload = JSON.parse(body || "{}");
      const result = await saveCompletion(payload);
      return sendJson(req, res, 200, result);
    }

    return sendJson(req, res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    return sendJson(req, res, error.statusCode || 500, {
      ok: false,
      error: error.message || "Internal error"
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Personality stats server running at http://127.0.0.1:${PORT}`);
});

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readState() {
  const empty = {
    siteId: SITE_ID,
    completions: 0,
    submissionIds: {},
    counters: {},
    recentTextAnswers: [],
    updatedAt: new Date().toISOString()
  };

  if (!fs.existsSync(STATE_FILE)) {
    return empty;
  }

  try {
    return {
      ...empty,
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    };
  } catch {
    return empty;
  }
}

function readStatsHtml() {
  if (fs.existsSync(STATS_HTML_PATH)) {
    return fs.readFileSync(STATS_HTML_PATH, "utf8");
  }
  throw statusError(404, "stats.html not found");
}

async function saveCompletion(payload) {
  return enqueueWrite(async () => {
    const record = normalizeSubmission(payload);
    if (state.submissionIds[record.submissionId]) {
      return { ok: true, duplicated: true, completionsChanged: false };
    }

    state.submissionIds[record.submissionId] = true;
    state.completions += 1;
    state.updatedAt = new Date().toISOString();

    buildCounters(record).forEach(counter => incrementCounter(counter));
    addRecentTextAnswer(record);

    fs.appendFileSync(SUBMISSIONS_FILE, `${JSON.stringify(record)}\n`, "utf8");
    writeJsonAtomic(STATE_FILE, state);

    return { ok: true, duplicated: false, completionsChanged: true };
  });
}

function enqueueWrite(task) {
  writeQueue = writeQueue.then(task, task);
  return writeQueue;
}

function normalizeSubmission(payload) {
  const siteId = sanitize(payload.siteId || SITE_ID, 80);
  const submissionId = sanitize(payload.submissionId || "", 160);
  if (!submissionId) {
    throw statusError(400, "submissionId is required");
  }

  const answers = Array.isArray(payload.answers)
    ? payload.answers.map(normalizeAnswer).filter(Boolean)
    : [];
  if (!answers.length) {
    throw statusError(400, "answers are required");
  }

  const results = normalizeResults(payload.results || {});
  if (!results.topRole.name || !results.persona.code || !results.feasibility.level) {
    throw statusError(400, "result fields are required");
  }

  const now = new Date().toISOString();
  return {
    siteId,
    submissionId,
    visitorId: sanitize(payload.visitorId || "", 160),
    answerSignature: sanitize(payload.answerSignature || "", 4000),
    completedAt: sanitize(payload.completedAt || now, 40),
    receivedAt: now,
    page: normalizePage(payload.page || {}),
    answers,
    results
  };
}

function normalizeAnswer(answer) {
  if (!answer || !answer.id) return null;
  const type = sanitize(answer.type || "", 24);
  const textValue = sanitize(answer.textValue || "", 500);
  const normalized = {
    id: sanitize(answer.id, 32),
    index: Number(answer.index || 0),
    type,
    text: sanitize(answer.text || "", 240),
    tags: Array.isArray(answer.tags) ? answer.tags.map(tag => sanitize(tag, 24)).filter(Boolean) : [],
    value: sanitize(answer.value || "", type === "text" ? 500 : 120),
    label: sanitize(answer.label || answer.value || "", 160)
  };

  if (type === "text") {
    normalized.textValue = textValue;
    normalized.value = textValue ? "filled" : "empty";
    normalized.label = textValue ? "已填写" : "未填写";
  }

  return normalized;
}

function normalizeResults(results) {
  const topRole = results.topRole || {};
  const persona = results.persona || {};
  const feasibility = results.feasibility || {};
  return {
    topRole: {
      id: sanitize(topRole.id || "", 60),
      name: sanitize(topRole.name || "", 80),
      short: sanitize(topRole.short || "", 40),
      score: toScore(topRole.score),
      skillScore: toScore(topRole.skillScore),
      feasibilityScore: toScore(topRole.feasibilityScore)
    },
    persona: {
      code: sanitize(persona.code || "", 12),
      title: sanitize(persona.title || "", 40),
      subtitle: sanitize(persona.subtitle || "", 80)
    },
    feasibility: {
      score: toScore(feasibility.score),
      level: sanitize(feasibility.level || "", 80),
      subtitle: sanitize(feasibility.subtitle || "", 120),
      baseScore: toScore(feasibility.baseScore),
      preparationScore: toScore(feasibility.preparationScore)
    },
    dimensions: normalizeScoreMap(results.dimensions || {}),
    traits: normalizeScoreMap(results.traits || {}),
    selfChoice: sanitize(results.selfChoice || "", 500)
  };
}

function normalizePage(page) {
  return {
    path: sanitize(page.path || "", 160),
    referrer: sanitize(page.referrer || "", 300),
    userAgent: sanitize(page.userAgent || "", 300)
  };
}

function normalizeScoreMap(source) {
  return Object.fromEntries(
    Object.entries(source)
      .filter(([key]) => /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key))
      .map(([key, value]) => [key, toScore(value)])
  );
}

function buildCounters(record) {
  const results = record.results;
  const counters = [
    {
      key: "completion:total",
      type: "completion",
      label: "完成测评总数"
    },
    {
      key: `result:role:${results.topRole.name}`,
      type: "result_role",
      label: results.topRole.name,
      resultId: results.topRole.id,
      score: results.topRole.score
    },
    {
      key: `result:persona:${results.persona.code}`,
      type: "result_persona",
      label: `${results.persona.code} · ${results.persona.title}`,
      resultId: results.persona.code
    },
    {
      key: `result:feasibility:${results.feasibility.level}`,
      type: "result_feasibility",
      label: results.feasibility.level,
      score: results.feasibility.score
    }
  ];

  record.answers.forEach(answer => {
    counters.push({
      key: `question:${answer.id}:${answer.value}`,
      type: "question_option",
      label: answer.label,
      questionId: answer.id,
      questionIndex: answer.index,
      questionText: answer.text,
      answerValue: answer.value,
      answerLabel: answer.label,
      tags: answer.tags
    });

    if (answer.type === "text" && answer.textValue) {
      counters.push({
        key: `question:${answer.id}:text-filled`,
        type: "text_answer",
        label: "自由输入题填写数",
        questionId: answer.id,
        questionIndex: answer.index,
        questionText: answer.text
      });
    }
  });

  return counters;
}

function incrementCounter(counter) {
  const existing = state.counters[counter.key] || {
    ...counter,
    count: 0,
    createdAt: new Date().toISOString()
  };
  state.counters[counter.key] = {
    ...existing,
    ...counter,
    count: Number(existing.count || 0) + 1,
    updatedAt: new Date().toISOString()
  };
}

function addRecentTextAnswer(record) {
  const answer = record.answers.find(item => item.type === "text" && item.textValue);
  if (!answer) return;
  state.recentTextAnswers = [
    {
      text: answer.textValue,
      completedAt: record.completedAt
    },
    ...(state.recentTextAnswers || [])
  ].slice(0, 50);
}

function buildSummary(siteId) {
  const counters = Object.values(state.counters || {});
  const completions = Number(state.completions || 0);
  return {
    ok: true,
    siteId,
    completions,
    questionStats: buildQuestionStats(counters),
    resultStats: {
      roles: buildDistribution(counters, "result_role", completions),
      personas: buildDistribution(counters, "result_persona", completions),
      feasibility: buildDistribution(counters, "result_feasibility", completions)
    },
    textAnswers: {
      filled: counters
        .filter(counter => counter.type === "text_answer")
        .reduce((sum, counter) => sum + Number(counter.count || 0), 0),
      recent: state.recentTextAnswers || []
    },
    updatedAt: state.updatedAt || new Date().toISOString()
  };
}

function buildDistribution(counters, type, total) {
  return counters
    .filter(counter => counter.type === type)
    .map(counter => ({
      id: counter.resultId || counter.key,
      label: counter.label,
      count: Number(counter.count || 0),
      percent: percent(Number(counter.count || 0), total),
      score: Number(counter.score || 0)
    }))
    .sort((a, b) => b.count - a.count || String(a.label).localeCompare(String(b.label), "zh-CN"));
}

function buildQuestionStats(counters) {
  const grouped = new Map();
  counters
    .filter(counter => counter.type === "question_option")
    .forEach(counter => {
      const questionId = counter.questionId || "";
      if (!grouped.has(questionId)) {
        grouped.set(questionId, {
          id: questionId,
          index: Number(counter.questionIndex || 0),
          text: counter.questionText || questionId,
          tags: counter.tags || [],
          total: 0,
          options: []
        });
      }

      const question = grouped.get(questionId);
      const count = Number(counter.count || 0);
      question.total += count;
      question.options.push({
        value: counter.answerValue,
        label: counter.answerLabel || counter.label,
        count,
        percent: 0
      });
    });

  return [...grouped.values()]
    .map(question => ({
      ...question,
      options: question.options
        .map(option => ({
          ...option,
          percent: percent(option.count, question.total)
        }))
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value), "zh-CN"))
    }))
    .sort((a, b) => a.index - b.index);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(statusError(413, "Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tempPath, filePath);
}

function sendJson(req, res, statusCode, payload) {
  const body = statusCode === 204 ? "" : JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": allowedOrigin(req),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  });
  res.end(body);
}

function sendHtml(req, res, statusCode, html) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(html);
}

function allowedOrigin(req) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.includes("*")) return "*";
  if (origin && ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0] || "";
}

function statusError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sanitize(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function toScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, Math.round(number)));
}

function percent(count, total) {
  return total ? Math.round((count / total) * 100) : 0;
}
