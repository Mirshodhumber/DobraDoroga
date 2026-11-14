// DOM behavior tests, not a substitute for visual QA in a real browser.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { JSDOM } = require("jsdom");
const source = readFileSync("roadwatch/static/support.js", "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness(options = {}) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://roadwatch.test/", runScripts: "outside-only" });
  const w = dom.window, d = w.document;
  const conversations = new Map(), requests = [], navigation = [];
  const context = { userId: "member-test", projectId: null, page: "welcome" };
  let appClicks = 0;
  const emitContext = () => d.dispatchEvent(new w.CustomEvent("roadwatch:context", { detail: { ...context } }));
  d.addEventListener("roadwatch:support-ready", emitContext);
  d.addEventListener("roadwatch:support-navigate", e => navigation.push(e.detail));
  d.addEventListener("click", () => appClicks++);
  const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(data) });
  w.fetch = async (url, init = {}) => {
    requests.push({ url, init });
    const parsed = new URL(url, "http://roadwatch.test");
    const scope = parsed.searchParams.get("project_id") || "welcome";
    if (options.fetch) {
      const response = await options.fetch(url, init);
      if (response) return response;
    }
    if (init.method === "DELETE") { conversations.delete(scope); return json({ cleared: true }); }
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const turn = { id: "turn-" + requests.length, message: body.message, answer: options.answer || "Open Documents, then Add evidence.",
        mode: "guide", project_id: body.project_id, sources: [{ id: "help:documents", title: "Add documents", text: "Upload a readable PDF." }],
        actions: [{ id: "evidence", label: "Open documents", kind: "tab", target: "evidence" }] };
      const key = body.project_id || "welcome";
      conversations.set(key, [...(conversations.get(key) || []), turn]);
      return json({ turn });
    }
    return json({ turns: conversations.get(scope) || [], mode: "guide", private: true, retention_days: 30,
      case_name: scope === "welcome" ? null : scope, project_id: scope === "welcome" ? null : scope });
  };
  w.eval(source);
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const open = async () => { d.querySelector(".rw-support-launcher").click(); await settle(); };
  const send = async text => {
    const input = d.querySelector("#rw-support-question"); input.value = text;
    input.dispatchEvent(new w.Event("input", { bubbles: true }));
    d.querySelector(".rw-support-form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  };
  return { w, d, requests, navigation, context, emitContext, settle, open, send, json,
    clicks: () => appClicks, close: () => w.close() };
}

test("opens accessibly, sends context, shows sources and offers only navigation", async () => {
  const h = await harness();
  try {
    await h.open();
    assert.equal(h.d.querySelector(".rw-support-launcher").getAttribute("aria-expanded"), "true");
    assert.equal(h.d.activeElement.id, "rw-support-question");
    await h.send("How do I upload a receipt?");
    const posted = JSON.parse(h.requests.find(r => r.init.method === "POST").init.body);
    assert.deepEqual(posted, { message: "How do I upload a receipt?", project_id: null, page: "welcome" });
    assert.match(h.d.querySelector(".rw-support-answer").textContent, /Documents/);
    assert.match(h.d.querySelector(".rw-support-sources").textContent, /Upload a readable PDF/);
    h.d.querySelector(".rw-support-action").click();
    assert.deepEqual(h.navigation.map(a => a.target), ["evidence"]);
    assert.equal(h.d.querySelector(".rw-support-panel").hidden, true);
    assert.equal(h.clicks(), 0, "widget clicks must not reach the app's delegated action handler");
  } finally { h.close(); }
});

test("renders user and model HTML as text", async () => {
  const payload = '<img src=x onerror="window.injected=true">';
  const h = await harness({ answer: payload });
  try {
    await h.open(); await h.send(payload);
    assert.equal(h.d.querySelectorAll(".rw-support-messages img").length, 0);
    assert.equal(h.d.querySelector(".rw-support-answer").textContent, payload);
    assert.equal(h.w.injected, undefined);
  } finally { h.close(); }
});

test("switching cases discards a late reply and loads the new case's conversation", async () => {
  let resolve;
  const h = await harness({ fetch: async (url, init) => init.method === "POST" ? new Promise(r => { resolve = r; }) : null });
  try {
    await h.open(); await h.send("Old case question");
    assert.equal(h.d.querySelector(".rw-support-send").disabled, true);
    h.context.projectId = "project-new"; h.context.page = "evidence"; h.emitContext(); await h.settle();
    resolve(h.json({ turn: { message: "Old case question", answer: "Old answer", project_id: null } }));
    await h.settle();
    assert.equal(h.d.querySelectorAll(".rw-support-user").length, 0);
    assert.equal(h.d.querySelector(".rw-support-case").textContent, "project-new");
    assert(h.requests.find(r => r.init.method === "POST").init.signal.aborted);
  } finally { h.close(); }
});

test("clearing while a reply is pending prevents that reply reappearing", async () => {
  let resolve;
  const h = await harness({ fetch: async (url, init) => init.method === "POST" ? new Promise(r => { resolve = r; }) : null });
  try {
    await h.open(); await h.send("Pending question");
    assert.equal(h.d.querySelector(".rw-support-clear").disabled, false);
    h.d.querySelector(".rw-support-clear").click(); await h.settle();
    resolve(h.json({ turn: { message: "Pending question", answer: "Late answer", project_id: null } })); await h.settle();
    assert.equal(h.d.querySelectorAll(".rw-support-user").length, 0);
    assert(h.requests.some(r => r.init.method === "DELETE" && r.url === "/api/support/history"));
    assert.equal(h.d.querySelector("#rw-support-question").disabled, false);
  } finally { h.close(); }
});

test("Escape returns focus and signing out hides the widget and previous history", async () => {
  const h = await harness();
  try {
    await h.open(); await h.send("Question");
    h.d.querySelector("#rw-support-question").dispatchEvent(new h.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(h.d.querySelector(".rw-support-panel").hidden, true);
    assert.equal(h.d.activeElement.className, "rw-support-launcher");
    h.context.userId = null; h.emitContext(); await h.settle();
    assert.equal(h.d.querySelector(".rw-support-launcher").hidden, true);
    assert.equal(h.d.querySelectorAll(".rw-support-user").length, 0);
  } finally { h.close(); }
});

test("failed requests preserve the question and show an actionable error", async () => {
  const h = await harness({ fetch: async (url, init) => init.method === "POST"
    ? { ok: false, status: 429, json: async () => ({ detail: "Today's support message limit has been reached." }) } : null });
  try {
    await h.open(); await h.send("Keep my question");
    assert.equal(h.d.querySelector("#rw-support-question").value, "Keep my question");
    assert.match(h.d.querySelector("[role=alert]").textContent, /limit/);
    assert.equal(h.d.querySelector(".rw-support-send").disabled, false);
  } finally { h.close(); }
});
