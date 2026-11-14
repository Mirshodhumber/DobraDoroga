/* Roadwatch support widget. All model/user text is rendered with textContent, never HTML. */
(() => {
  "use strict";
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = text;
    return element;
  };
  const button = (label, className, handler) => {
    const element = node("button", className, label);
    element.type = "button";
    element.addEventListener("click", handler);
    return element;
  };
  let context = { projectId: null, userId: null, page: "welcome" };
  let opened = false, pending = false, loading = false, generation = 0;
  let turns = [], info = null, controller = null, historyController = null, error = "";

  const launcher = button("Ask Roadwatch", "rw-support-launcher", () => setOpen(!opened));
  launcher.id = "roadwatch-support-launcher";
  launcher.hidden = true;
  launcher.setAttribute("aria-controls", "roadwatch-support");
  launcher.setAttribute("aria-expanded", "false");
  const icon = node("span", "rw-support-icon", "?");
  icon.setAttribute("aria-hidden", "true");
  launcher.prepend(icon);

  const panel = node("section", "rw-support-panel");
  panel.id = "roadwatch-support";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "false");
  panel.setAttribute("aria-labelledby", "rw-support-title");
  const header = node("header", "rw-support-header");
  const heading = node("div");
  const title = node("h2", "", "Your Roadwatch guide");
  title.id = "rw-support-title";
  const subtitle = node("p", "rw-support-subtitle", "Find the right next step.");
  heading.append(title, subtitle);
  const close = button("×", "rw-support-close", () => setOpen(false));
  close.setAttribute("aria-label", "Close Roadwatch support");
  header.append(heading, close);
  const contextRow = node("div", "rw-support-context-row");
  const mode = node("span", "rw-support-mode", "Connecting");
  const caseLabel = node("span", "rw-support-case", "Getting started");
  contextRow.append(mode, caseLabel);
  const messages = node("div", "rw-support-messages");
  messages.setAttribute("aria-label", "Support conversation");
  const alert = node("div", "rw-support-error");
  alert.setAttribute("role", "alert");
  alert.hidden = true;
  const form = node("form", "rw-support-form");
  const label = node("label", "rw-support-sr", "Ask a question about Roadwatch");
  label.htmlFor = "rw-support-question";
  const inputRow = node("div", "rw-support-input-row");
  const input = node("textarea", "rw-support-input");
  input.id = "rw-support-question";
  input.placeholder = "What would you like help with?";
  input.rows = 2;
  input.maxLength = 2000;
  input.autocomplete = "off";
  const send = node("button", "rw-support-send", "Send");
  send.type = "submit";
  inputRow.append(input, send);
  const footer = node("div", "rw-support-footer");
  const privacy = node("span", "", "Saved for 30 days · Clear anytime");
  const clear = button("Clear chat", "rw-support-clear", clearHistory);
  clear.title = "Delete this account's support history for this case";
  footer.append(privacy, clear);
  form.append(label, inputRow, footer);
  const live = node("div", "rw-support-sr");
  live.setAttribute("aria-live", "polite");
  panel.append(header, contextRow, messages, alert, form, live);
  document.body.append(panel, launcher);

  function scopeQuery() {
    return context.projectId ? `?project_id=${encodeURIComponent(context.projectId)}` : "";
  }

  async function request(path, options = {}) {
    const response = await fetch(`/api/support${path}`, options);
    let data;
    try { data = await response.json(); } catch { throw new Error("Support could not connect. Please try again."); }
    if (!response.ok) {
      if (response.status === 401) document.dispatchEvent(new CustomEvent("roadwatch:support-signin"));
      throw new Error(typeof data.detail === "string" ? data.detail : "Please check your question and try again.");
    }
    return data;
  }

  function setOpen(value, restoreFocus = true) {
    opened = value;
    panel.hidden = !opened;
    launcher.setAttribute("aria-expanded", String(opened));
    if (opened) {
      if (!info && !loading) loadHistory();
      input.focus();
    } else if (restoreFocus) launcher.focus();
  }

  function render() {
    mode.textContent = info?.mode === "ai" ? "AI support" : info ? "Guide mode" : "Connecting";
    mode.dataset.mode = info?.mode || "loading";
    caseLabel.textContent = info?.case_name || "Getting started";
    caseLabel.title = caseLabel.textContent;
    subtitle.textContent = context.projectId ? "Guidance for the case you are viewing." : "A little help, from start to next step.";
    privacy.textContent = info?.private ? "Private to your account · Saved for 30 days" : "Saved with this local profile · 30 days";
    privacy.title = "In AI mode, recent chat and minimal case progress are sent to the workspace's configured model provider. Document contents are not included.";
    messages.replaceChildren();
    if (!turns.length && !loading) {
      const welcome = node("div", "rw-support-welcome");
      welcome.append(node("span", "rw-support-welcome-icon", "R"), node("h3", "", "How can I help?"),
        node("p", "", "I can explain Roadwatch, check your progress, and help you find the right screen."));
      const suggestions = node("div", "rw-support-suggestions");
      const prompts = context.projectId
        ? ["What should I do next?", "How do I upload a document?", "Why can't I run an investigation?"]
        : ["Where do I start?", "What can Roadwatch do?", "Who can add evidence?"];
      prompts.forEach(question => suggestions.append(button(question, "rw-support-suggestion", () => submit(question))));
      welcome.append(suggestions);
      messages.append(welcome);
    }
    for (const turn of turns) {
      const user = node("div", "rw-support-message rw-support-user");
      user.append(node("span", "rw-support-author", "You"), node("p", "", turn.message));
      const assistant = node("div", "rw-support-message rw-support-assistant");
      assistant.append(node("span", "rw-support-author", turn.mode === "ai" ? "Roadwatch · AI support" : "Roadwatch guide"));
      if (turn.notice) assistant.append(node("p", "rw-support-notice", turn.notice));
      assistant.append(node("p", "rw-support-answer", turn.answer));
      if (turn.actions?.length) {
        const actions = node("div", "rw-support-actions");
        turn.actions.forEach(action => actions.append(button(action.label, "rw-support-action", () => {
          setOpen(false, false);
          document.dispatchEvent(new CustomEvent("roadwatch:support-navigate", { detail: { ...action, projectId: turn.project_id } }));
        })));
        assistant.append(actions);
      }
      if (turn.sources?.length) {
        const sources = node("details", "rw-support-sources");
        sources.append(node("summary", "", `Sources checked · ${turn.sources.length}`));
        turn.sources.forEach(source => {
          const item = node("div", "rw-support-source");
          item.append(node("strong", "", source.title), node("p", "", source.text));
          sources.append(item);
        });
        assistant.append(sources);
      }
      messages.append(user, assistant);
    }
    if (pending || loading) {
      const status = node("p", "rw-support-loading", loading ? "Loading your conversation…" : "Checking the guide and your next step…");
      status.setAttribute("role", "status");
      messages.append(status);
    }
    alert.hidden = !error;
    alert.textContent = error;
    send.disabled = pending || loading || !input.value.trim() || !context.userId;
    input.disabled = pending;
    clear.disabled = loading || (!turns.length && !pending);
    messages.scrollTop = messages.scrollHeight;
  }

  async function loadHistory() {
    historyController?.abort();
    historyController = new AbortController();
    const epoch = generation;
    loading = true; error = ""; render();
    try {
      const data = await request(scopeQuery(), { signal: historyController.signal });
      if (epoch !== generation) return;
      info = data; turns = data.turns;
    } catch (err) {
      if (err.name !== "AbortError" && epoch === generation) error = err.message;
    } finally {
      if (epoch === generation) { loading = false; render(); }
    }
  }

  async function submit(question = input.value.trim()) {
    if (!question || pending || loading || !context.userId) return;
    const epoch = generation;
    pending = true; error = ""; controller = new AbortController();
    render();
    try {
      const data = await request("/message", { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, project_id: context.projectId, page: context.page }) });
      if (epoch !== generation) return;
      turns = [...turns, data.turn].slice(-12);
      input.value = "";
      live.textContent = data.turn.answer;
    } catch (err) {
      if (err.name !== "AbortError" && epoch === generation) error = err.message;
    } finally {
      if (epoch === generation) { pending = false; render(); if (opened) input.focus(); }
    }
  }

  async function clearHistory() {
    const scope = scopeQuery();
    controller?.abort(); historyController?.abort();
    generation++; pending = false; loading = true; error = ""; live.textContent = ""; render();
    const epoch = generation;
    try {
      await request(`/history${scope}`, { method: "DELETE" });
      if (epoch === generation) { turns = []; live.textContent = "Support conversation cleared."; }
    } catch (err) { if (epoch === generation) error = err.message; }
    finally { if (epoch === generation) { loading = false; render(); input.focus(); } }
  }

  document.addEventListener("roadwatch:context", event => {
    const next = event.detail;
    const changed = next.projectId !== context.projectId || next.userId !== context.userId;
    context = next;
    launcher.hidden = !next.userId;
    if (changed) {
      generation++; controller?.abort(); historyController?.abort();
      turns = []; info = null; error = ""; pending = false; loading = false; live.textContent = ""; input.value = "";
      if (!next.userId) setOpen(false, false);
      else if (opened) loadHistory();
      render();
    }
  });
  form.addEventListener("submit", event => { event.preventDefault(); submit(); });
  input.addEventListener("input", () => { send.disabled = pending || loading || !input.value.trim(); });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  });
  panel.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); setOpen(false); } });
  // The main app has a delegated button handler. Keep chat controls in their own UI boundary.
  panel.addEventListener("click", event => event.stopPropagation());
  launcher.addEventListener("click", event => event.stopPropagation());
  document.dispatchEvent(new CustomEvent("roadwatch:support-ready"));
  render();
})();
