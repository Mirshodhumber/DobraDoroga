const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (value) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" }).format(Number(value));
const labels = { before_tax: "Before tax", including_hst: "Including HST", net_hst_recoveries: "Net of HST recoveries" };
const kindLabels = { contract: "Contract / award", amendment: "Amendment", payment: "Payment", inspection: "Inspection", bid: "Bid / evaluation", open_data: "Open data", other: "Document" };
const datasetLabels = { awarded: "Awarded contracts naming the street", non_competitive: "Non-competitive contracts to the same suppliers", road_program: "Road reconstruction program entries", restrictions: "Current permits & closures", requests_311: "311 road-related requests", lobbying: "Lobbyist registry entries (suppliers & street)", bids: "SEAO tenders: bidders & bid amounts", planning: "Planned works, estimates & capital pipeline", solicitations: "Open tenders naming the street", integrity: "Inspector General / Auditor General reports", debarment: "RENA: companies barred from public contracts", development: "Major building permits & development applications", traffic: "Traffic counts at intersections", climate: "Winter severity (freeze-thaw days)",
  fed_contracts: "Federal contracts over $10,000 (with amendments)", fed_grants: "Federal grants & contributions", fed_lobbying: "Registry of Lobbyists: communications with federal officials", fed_ineligible: "PSPC ineligibility & suspension list", on_payments: "Ontario Public Accounts: payments of $50,000+", city_awards: "City contracts awarded to the supplier", city_non_competitive: "City non-competitive contracts to the supplier", city_lobbying: "City lobbyist registry: supplier as client", qc_bids: "SEAO tenders: bidders & bid amounts", qc_debarment: "RENA: companies barred from public contracts" };
const TIER_OF = { fed_contracts: "federal", fed_grants: "federal", fed_lobbying: "federal", fed_ineligible: "federal", on_payments: "provincial", qc_bids: "provincial", qc_debarment: "provincial", city_awards: "municipal", city_non_competitive: "municipal", city_lobbying: "municipal" };
let provinces = [], caseMode = "street";
const isVendorCase = () => current?.anchor === "vendor";
let current = null, projects = [], config = {}, tab = "report", busy = false, loadingProject = 0, evidenceMode = "import";
let sessionInfo = {};
let map = null, mapLayer = null, mapResults = [], cities = [], me = null, discussion = null, discussionTimer = null, discussAnchor = null;
const ROLE_RANK = { viewer: 0, guest: 1, investigator: 1, counsel: 2, admin: 3 };
const canEdit = () => !me || ROLE_RANK[me.role] >= 1;
const isGuest = () => me?.role === "guest";
const STATUS_LABELS = { open: "Open", investigating: "Investigating", explained: "Explained (innocent)", escalated: "Escalated", dismissed: "Dismissed" };
const RISK_LABELS = { low: "Low risk", medium: "Medium risk", high: "High risk", unclear: "Risk unclear" };
let conditionLayer = null, conditionLegend = null, conditionTimer = null, conditionRequest = 0;
const GRADE_COLOURS = { 1: "#1a9850", 2: "#91cf60", 3: "#fee08b", 4: "#fc8d59", 5: "#d73027" };
const cityOf = key => cities.find(c => c.key === key) || cities[0] || { key: "toronto", name: "Toronto", centre: [43.6532, -79.3832] };
function caseCity() { return cityOf(current?.locations?.[0]?.city_key || current?.open_data?.[0]?.city_key || localStorage.getItem("roadwatch.city")); }

async function api(path, method = "GET", body) {
  const response = await fetch(`/api${path}`, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { throw new Error(`Request failed (${response.status}).`); }
    if (response.status === 401 && data.auth) { showLogin(); throw new Error("Please sign in."); }
    if (response.status === 403 && me) throw new Error(`${data.detail || "Not allowed."} (You are signed in as ${me.name} · ${me.role}.)`);
    throw new Error(Array.isArray(data.detail) ? data.detail.map(e => `${e.loc.slice(1).join(".")}: ${e.msg}`).join("; ") : data.detail || "Request failed.");
  }
  return response.json();
}

function notify(message, error = false) {
  const notice = $("#notice");
  (document.querySelector("dialog[open]") || document.body).appendChild(notice);
  notice.textContent = message; notice.className = `notice${error ? " error" : ""}`; notice.hidden = false;
  clearTimeout(notify.timer); notify.timer = setTimeout(() => { notice.hidden = true; }, 8000);
}
function closeDialog(dialog) { document.body.appendChild($("#notice")); dialog.close(); }
function setLoginMode(byKey) {
  $("[data-login-mode='key']").hidden = !byKey; $("[data-login-mode='password']").hidden = byKey;
  $("[data-action='forgot-password']").hidden = byKey;
  $("[data-action='toggle-login-mode']").textContent = byKey ? "Use email and password instead" : "Use an access key instead";
}
// Until someone has an email and password, the only way in is the administrator's access key: open on that.
function showLogin() { const d = $("#login-dialog"); $("#signup-link").hidden = !sessionInfo.signup_open; $("#guest-button").hidden = !sessionInfo.guest_open; if (!d.open) { setLoginMode(sessionInfo.accounts === false); d.showModal(); } }
function showSignup() {
  closeDialog($("#login-dialog"));
  $("#signup-role-help").textContent = `New accounts start as ${sessionInfo.signup_role || "viewer"}: you can read every case and take part in the discussion. An administrator can give you the investigator role.${sessionInfo.email_enabled ? " You will need to confirm your email address." : ""}`;
  $("#signup-rules").textContent = sessionInfo.rules || "";
  $("#signup-dialog").showModal();
}
function setEvidenceMode(mode) {
  evidenceMode = mode;
  document.querySelectorAll("#evidence-dialog .mode-tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  document.querySelectorAll("#evidence-dialog [data-pane]").forEach(p => p.hidden = p.dataset.pane !== mode);
}
function showDialog(name) {
  if (busy) return;
  const dialog = $(`#${name}-dialog`);
  dialog.querySelector("form")?.reset();
  if (name === "evidence") setEvidenceMode("import");
  if (name === "finance") {
    if (!current.evidence.length) return notify("Add a source document first.", true);
    $("#financial-source").innerHTML = current.evidence.map(d => `<option value="${d.id}">${escapeHTML(d.title)}</option>`).join("");
    updateSourcePreview();
  }
  if (name === "observation") dialog.querySelector("[name=observed_on]").value = new Date().toLocaleDateString("en-CA");
  if (name === "setup") {
    $("#setup-provider").textContent = config.enabled ? (config.providers || []).map(p => p.model).join(", ") : "not configured";
    $("#setup-meaning").hidden = !config.semantic_search; $("#setup-embed").textContent = config.embedding_model || "";
    $("#setup-usage").textContent = config.enabled ? `AI investigations today: ${config.ai_runs_today} of ${config.daily_ai_limit} allowed.` : "";
  }
  dialog.showModal();
}
function updateSourcePreview() {
  const doc = current.evidence.find(e => e.id === $("#financial-source").value);
  const page = doc?.pages.find(p => p.number === Number($("#financial-page").value));
  $("#source-preview").textContent = page?.text || "Page not found.";
}
async function refreshList() { projects = await api("/projects"); renderSidebar(); }
async function refreshConfig() {
  config = await api("/config");
  $("#model-status").textContent = config.enabled ? `AI ready · ${(config.providers || []).length > 1 ? `${config.providers.length} models` : config.model}` : "AI not configured · checks only";
}
function renderSidebar() {
  $("#project-list").innerHTML = projects.length ? projects.map(p => `<button class="case-link ${current?.id === p.id ? "active" : ""}" data-project="${p.id}"><strong>${escapeHTML(p.name)}</strong><small>${p.demo ? "Sample case" : escapeHTML(p.contractor || p.road)}</small></button>`).join("") : '<p class="help sidebar-empty">No cases yet.</p>';
}
async function selectProject(id) {
  if (busy) return;
  const requestId = ++loadingProject;
  const project = await api(`/projects/${id}`);
  if (requestId !== loadingProject) return;
  current = project; tab = "report"; discussion = null; discussAnchor = null; renderSidebar(); render();
  loadDiscussion(true);
}
function empty(title, description, button = "") {
  return `<div class="panel empty"><div class="symbol">⌕</div><h2>${title}</h2><p>${description}</p>${button}</div>`;
}
function render() {
  publishSupportContext();
  const workspace = $("#workspace");
  if (!current) {
    workspace.innerHTML = `<div class="welcome"><p class="eyebrow">PUBLIC WORKS. PUBLIC SPENDING. PUBLIC ACCOUNTABILITY.</p><h1>Follow the money.<br>Check the road.<br>Find the evidence.</h1><p class="lead">Investigate a road construction contract from its public records — or follow one supplier across federal, provincial and municipal spending: import the records, record what was paid, and let the investigator surface the discrepancies worth a closer look.</p><div class="actions"><button class="primary" data-action="new-project">Start a case →</button><button class="secondary" data-action="demo">See a sample case</button></div><div class="steps"><div class="step"><span>01</span><h3>Gather the records</h3><p>Pull what governments publish about a road or a company, and import award reports, change orders, invoices and inspections straight from the publisher's site.</p></div><div class="step"><span>02</span><h3>Trace the spending</h3><p>Record each amount with its source quotation. Like-for-like totals are compared automatically.</p></div><div class="step"><span>03</span><h3>Investigate</h3><p>The AI reads every page, follows leads across documents and returns cited findings, counter-explanations and the records still missing.</p></div></div></div>`;
    return;
  }
  const latest = current.reports.at(-1);
  const stale = latest && latest.revision !== current.revision;
  const vendorCase = isVendorCase(), pulledSets = (current.open_data || []).length;
  const tabs = vendorCase
    ? [["report", "Investigation"], ["discussion", `Discussion${discussion?.comments?.length ? ` (${discussion.comments.length})` : ""}`], ["vendor", "Supplier & open data"], ["evidence", "Documents"], ["finances", "Spending"]]
    : [["report", "Investigation"], ["discussion", `Discussion${discussion?.comments?.length ? ` (${discussion.comments.length})` : ""}`], ["map", "Map & open data"], ["evidence", "Documents"], ["finances", "Spending"], ["observations", "Road condition"]];
  if (vendorCase && (tab === "map" || tab === "observations")) tab = "vendor";
  workspace.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">${escapeHTML(vendorCase ? "SUPPLIER CASE" : current.contract_number ? `CONTRACT ${current.contract_number}` : "CASE")}</p><h1>${escapeHTML(current.name)}</h1><p class="subtitle">${vendorCase ? escapeHTML(current.contractor) + " · " + escapeHTML(vendorScope()) : escapeHTML(current.road) + (current.contractor ? " · " + escapeHTML(current.contractor) : "") + (current.completed_on ? " · completed " + escapeHTML(current.completed_on) : "")}</p></div><div class="actions"><a class="link-button" href="/api/projects/${current.id}/export">↓ Export</a><button class="link-button danger" data-action="delete-project">Delete case</button></div></div>
    ${isGuest() ? '<div class="banner"><strong>GUEST</strong> — you can work on every case: add records, pull open data and run investigations. <button class="text-button" data-action="logout">Sign in</button> to post in the discussion.</div>' : ""}
    ${current.demo ? '<div class="banner"><strong>SAMPLE CASE</strong> — every record, company and amount here is fictional, made up to show how a case works. Delete it whenever you like.</div>' : ""}
    <div class="stats"><div class="stat"><div class="label">Documents</div><div class="value">${current.evidence.length}</div><div class="foot">${current.evidence.filter(d => d.source_url).length} with source links</div></div><div class="stat"><div class="label">Financial entries</div><div class="value">${current.finances.length}</div><div class="foot">Sourced amounts · CAD</div></div>${vendorCase ? `<div class="stat"><div class="label">Open-data sets</div><div class="value">${pulledSets}</div><div class="foot">${pulledSets ? `${new Set((current.open_data || []).map(d => TIER_OF[d.key]).filter(Boolean)).size} tier(s) of government` : "Not pulled yet"}</div></div>` : `<div class="stat"><div class="label">Observations</div><div class="value">${current.observations.length}</div><div class="foot">Road condition reports</div></div>`}<div class="stat"><div class="label">Findings</div><div class="value">${latest ? latest.findings.length : "—"}</div><div class="foot">${stale ? "Report out of date" : latest ? "For human review" : "Not investigated yet"}</div></div></div>
    <div class="tabs" role="tablist">${tabs.map(([key, title]) => `<button role="tab" aria-selected="${key === tab}" class="tab ${key === tab ? "active" : ""}" data-tab="${key}">${title}</button>`).join("")}</div>
    ${busy ? `<div class="investigation-progress" role="status"><span class="pulse"></span>${busy === "opendata" ? "Pulling open data… the first pull downloads several datasets and can take a minute." : busy === "deep" ? "Deep investigation: planning hypotheses, testing each against the records, synthesising, then reviewing. This takes several minutes." : "Working… an AI investigation reads every page and can take a minute or two."}</div>` : ""}
    <div id="tab-content">${tab === "report" ? renderReport(latest, stale) : tab === "discussion" ? renderDiscussion(latest) : tab === "map" ? renderMap() : tab === "vendor" ? renderVendor() : tab === "evidence" ? renderEvidence() : tab === "finances" ? renderFinances() : renderObservations()}</div>`;
  if (busy) workspace.querySelectorAll("button").forEach(button => button.disabled = true);
  if (!canEdit()) workspace.querySelectorAll("[data-action='checks'],[data-action='investigate'],[data-action='investigate-deep'],[data-action='evidence'],[data-action='finance'],[data-action='observation'],[data-action='pull-open-data'],[data-action='save-vendor'],[data-action='delete-project'],[data-delete],[data-remove-street],[data-limit]").forEach(el => { el.disabled = true; el.title = "Viewers can read and discuss; ask an admin for the investigator role."; });
  if (tab === "discussion") { if (!discussion) loadDiscussion(); clearTimeout(discussionTimer); discussionTimer = setTimeout(function poll() { if (tab === "discussion" && current) loadDiscussion(true).then(() => { discussionTimer = setTimeout(poll, 20000); }); }, 20000); }
  if (tab === "map") { mountMap(); $("#condition-toggle")?.addEventListener("change", e => toggleCondition(e.target.checked).catch(err => notify(err.message, true))); } else map = null;
}
// Support uses these two events instead of sharing mutable application state.
function publishSupportContext() {
  document.dispatchEvent(new CustomEvent("roadwatch:context", { detail: {
    projectId: current?.id || null, page: current ? tab : "welcome", userId: isGuest() ? null : me?.id || null,
  } }));
}
document.addEventListener("roadwatch:support-ready", publishSupportContext);
document.addEventListener("roadwatch:support-signin", showLogin);
document.addEventListener("roadwatch:support-navigate", event => {
  const { kind, target, projectId } = event.detail || {};
  if (busy) return notify("Wait for the current operation to finish.", true);
  if ((current?.id || null) !== (projectId || null)) return notify("This suggestion belongs to another case.", true);
  if (kind === "tab") {
    const tabs = isVendorCase() ? ["report", "discussion", "vendor", "evidence", "finances"] : ["report", "discussion", "map", "evidence", "finances", "observations"];
    if (current && tabs.includes(target)) { tab = target; render(); document.querySelector(`[data-tab="${target}"]`)?.focus(); }
  } else if (kind === "action") {
    if (target === "setup") return showDialog("setup");
    if (target === "team" && me?.role === "admin") return openTeamDialog().catch(error => notify(error.message, true));
    if (!canEdit()) return notify("Ask an administrator for investigator access to add records.", true);
    if (target === "new-project") { $("#project-form").reset(); return openNewCaseDialog(); }
    if (current && ["evidence", "finance", "observation"].includes(target)) showDialog(target);
  }
});
function streetList(locations, removable) {
  if (!locations.length) return "";
  return `<ul class="street-list">${locations.map((l, i) => `<li><div class="street-main"><div><strong>${escapeHTML(l.road)}</strong><small>${escapeHTML(l.display_name)}</small></div>${removable ? `<button type="button" class="delete-button" data-remove-street="${i}" aria-label="Remove ${escapeHTML(l.road)}">Remove</button>` : ""}</div>
    <div class="limits"><input data-limit="from" data-index="${i}" placeholder="from (cross street)" value="${escapeHTML(l.from_street || "")}" maxlength="120"><input data-limit="to" data-index="${i}" placeholder="to (cross street)" value="${escapeHTML(l.to_street || "")}" maxlength="120"></div></li>`).join("")}</ul>`;
}
async function saveLimits(index) {
  const from = document.querySelector(`[data-limit="from"][data-index="${index}"]`).value, to = document.querySelector(`[data-limit="to"][data-index="${index}"]`).value;
  if ($("#project-dialog").open) { Object.assign(newCasePlaces[index], { from_street: from, to_street: to }); return; }
  const before = current.locations[index];
  if ((before.from_street || "") === from && (before.to_street || "") === to) return;
  current = await api(`/projects/${current.id}/locations/${index}`, "PUT", { from_street: from, to_street: to });
  notify("Contract limits saved. Pull open data again to flag records inside the limits.");
}
document.addEventListener("change", e => { if (e.target.dataset?.limit) saveLimits(Number(e.target.dataset.index)).catch(err => notify(err.message, true)); });
function datasetPanel(pulled, subject, staleNote) {
  if (!pulled.length) return "";
  const groups = [["federal", "Government of Canada"], ["provincial", "Province"], ["municipal", "City"]];
  const rows = d => `<div class="dataset-row"><div><strong>${escapeHTML(datasetLabels[d.key] || d.key)}</strong><br><a href="${escapeHTML(d.source_url)}" target="_blank" rel="noopener noreferrer">dataset page ↗</a> · <button class="citation" data-source="${d.evidence_id}" data-page="1">read records</button></div><span class="count">${d.total ?? d.count}</span></div>`;
  const tiered = pulled.some(d => TIER_OF[d.key]);
  const body = tiered ? groups.map(([tier, label]) => { const sets = pulled.filter(d => TIER_OF[d.key] === tier); return sets.length ? `<h4 class="tier">${label}</h4>${sets.map(rows).join("")}` : ""; }).join("") : pulled.map(rows).join("");
  return `<div class="panel"><p class="eyebrow">OPEN DATA ON FILE</p><p class="help">Pulled ${new Date(pulled[0].pulled_at).toLocaleString()} for ${escapeHTML(subject)} · stored as documents so findings can quote them.</p>${staleNote ? `<div class="callout stale">${escapeHTML(staleNote)}</div>` : ""}${body}${pulled[0].errors?.length ? `<p class="help">Not loaded: ${escapeHTML(pulled[0].errors.join("; "))}.</p>` : ""}</div>`;
}
function vendorScope() {
  const province = provinces.find(p => p.key === current?.vendor?.province);
  return province ? `Government of Canada · ${province.name} · ${province.city_name}` : "Government of Canada";
}
function renderVendor() {
  const vendor = current.vendor || { name: current.contractor, aliases: [], province: "" }, pulled = current.open_data || [];
  const names = [vendor.name, ...(vendor.aliases || [])].filter(Boolean);
  const stale = pulled.length && names.some(n => !(pulled[0].vendor_names || []).includes(n));
  const pending = pulled[0]?.errors?.some(e => e.includes("index is being built"));
  const side = `<div class="panel"><p class="eyebrow">SUPPLIER UNDER INVESTIGATION</p>
      <label>Company name<input id="vendor-name" maxlength="160" value="${escapeHTML(vendor.name || "")}"></label>
      <label>Other names it trades under (comma-separated)<input id="vendor-aliases" maxlength="800" value="${escapeHTML((vendor.aliases || []).join(", "))}" placeholder="numbered company, former name, operating name"></label>
      <label>Province to add<select id="vendor-province"><option value="">Federal records only</option>${provinces.map(p => `<option value="${escapeHTML(p.key)}" ${p.key === vendor.province ? "selected" : ""}>${escapeHTML(p.name)} (+ ${escapeHTML(p.city_name)})</option>`).join("")}</select></label>
      <button class="secondary" data-action="save-vendor">Save names →</button>
      <p class="help">Records are matched by canonical company name, exactly or as a name prefix ("GC Strategies" also finds "GC Strategies Inc."); add the numbered company or former names here so nothing is missed, and check the <em>Vendor name</em> on each cited row.</p>
      <div class="form-grid"><label>Records since<select id="since-year">${[2000, 2005, 2010, 2015, 2018, 2020, 2022].map(y => `<option value="${y}" ${y === (pulled[0]?.since_year ?? 2000) ? "selected" : ""}>${y}</option>`).join("")}</select></label><div></div></div>
      <button class="primary" data-action="pull-open-data">${pulled.length ? (stale ? "Pull open data for the new names →" : pending ? "Pull again (federal index was building) →" : "Refresh open data →") : "Pull open data for this supplier →"}</button>
      <p class="help">${escapeHTML(vendorScope())}: federal contracts over $10,000 with their amendments, sole-source reasons and bid counts; Registry of Lobbyists communications; the PSPC ineligibility list${vendor.province ? "; " + escapeHTML(provinces.find(p => p.key === vendor.province)?.tiers || "") : ""}.</p></div>`;
  return `<div class="section-header"><div><h2>Supplier &amp; open data</h2><p class="help">Follow one company across every government that publishes what it pays it.</p></div></div>
    <div class="map-layout"><div>${side}</div><div>${datasetPanel(pulled, names.join(", "), stale ? "Names were changed since this pull. Pull again to include them." : "")}</div></div>${renderOverview()}`;
}
async function saveVendor() {
  const aliases = $("#vendor-aliases").value.split(",").map(s => s.trim()).filter(Boolean);
  current = await api(`/projects/${current.id}/vendor`, "PUT", { name: $("#vendor-name").value.trim(), aliases, province: $("#vendor-province").value });
  render(); notify("Saved. Pull open data again to apply the new names.");
}
function renderMap() {
  const locations = current.locations || [], pulled = current.open_data || [];
  const stale = pulled.length && locations.some(l => !(pulled[0].streets || []).includes(l.road));
  const city = caseCity();
  const side = `<div class="panel"><p class="eyebrow">${locations.length ? `STREET${locations.length > 1 ? "S" : ""} UNDER INVESTIGATION · ${escapeHTML(city.name.toUpperCase())}` : "PICK THE STREETS"}</p>
      <label class="check"><input type="checkbox" id="condition-toggle" ${current.show_condition !== false ? "checked" : ""}> Show road condition on the map</label>
      ${locations.length ? streetList(locations, true) : "<h3>Search or click the map</h3>"}
      <p class="help">${locations.length ? `Search or click the map to add another street in ${escapeHTML(city.name)}. Streets in one case must be in the same city; their open data is merged, and the investigation looks for the same suppliers, permit holders and timing across them.` : `Type a street or click the road on the map. You can add several streets to investigate them together. Open data is connected for ${escapeHTML(cities.map(c => c.name).join(" and "))}; each city's records are kept apart.`}</p>
      ${locations.length ? `<div class="form-grid"><label>Records since<select id="since-year">${[2000, 2005, 2010, 2015, 2018, 2020, 2022].map(y => `<option value="${y}" ${y === (pulled[0]?.since_year ?? 2000) ? "selected" : ""}>${y}</option>`).join("")}</select></label><div></div></div>
      <button class="primary" data-action="pull-open-data">${pulled.length ? (stale ? "Pull open data for the new streets →" : "Refresh open data →") : `Pull open data for ${locations.length > 1 ? "these streets" : "this street"} →`}</button>
      <p class="help">Pulls ${escapeHTML(city.name)}'s contracts, permits, 311 requests${city.key === "toronto" ? ", road program, non-competitive contracts and lobbyist registry" : ""}, keeps the records that name ${locations.length > 1 ? "any of these streets" : "this street"}, and stores them as citable documents.</p>` : ""}</div>`;
  const datasets = datasetPanel(pulled, (pulled[0]?.streets || []).join(", "), stale ? "Streets were added since this pull. Pull again to include them." : "");
  return `<div class="section-header"><div><h2>Map &amp; open data</h2><p class="help">Choose one or more roads, then pull everything the city publishes about them.</p></div></div>
    <div class="map-layout"><div><div class="map-search"><input id="map-query" placeholder="Add a street in ${escapeHTML(city.name)}" value=""><button class="secondary" data-action="map-search">Search</button></div>
    <ul class="map-results" id="map-results"></ul><div id="road-map" role="application" aria-label="Map"></div><p class="help">Map data © OpenStreetMap contributors. Street lookups go through this server, not your browser.</p></div>
    <div>${side}${datasets}</div></div>${renderOverview()}`;
}
// ---- At-a-glance overview of pulled open data (award values, suppliers, years, streets, 311) ----
const PIE_COLOURS = ["#116c5a", "#a76b1d", "#1f4a7a", "#8a2d6b", "#4b6b1f", "#b23a3a", "#5b6770", "#2e8b9a"];
const compact = (value) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", notation: "compact", maximumFractionDigits: 1 }).format(value);
function groupSum(rows, key, value = () => 1) {
  const out = new Map();
  for (const r of rows) { const k = key(r); if (k == null || k === "") continue; out.set(k, (out.get(k) || 0) + value(r)); }
  return [...out.entries()].sort((a, b) => b[1] - a[1]);
}
function pieChart(entries, total) {
  if (!entries.length || !total) return "";
  const top = entries.slice(0, 7), rest = entries.slice(7).reduce((s, [, v]) => s + v, 0);
  if (rest) top.push(["Other suppliers", rest]);
  let angle = -Math.PI / 2;
  const slices = top.map(([label, value], i) => {
    const share = value / total, end = angle + share * 2 * Math.PI;
    const [x1, y1] = [60 + 54 * Math.cos(angle), 60 + 54 * Math.sin(angle)], [x2, y2] = [60 + 54 * Math.cos(end), 60 + 54 * Math.sin(end)];
    const path = share >= 0.9999 ? `<circle cx="60" cy="60" r="54" fill="${PIE_COLOURS[i % PIE_COLOURS.length]}"/>` : `<path d="M60 60 L${x1} ${y1} A54 54 0 ${share > .5 ? 1 : 0} 1 ${x2} ${y2} Z" fill="${PIE_COLOURS[i % PIE_COLOURS.length]}"><title>${escapeHTML(label)}: ${money(value)} (${Math.round(share * 100)}%)</title></path>`;
    angle = end; return path;
  }).join("");
  const legend = top.map(([label, value], i) => `<li><span class="swatch" data-colour="${i % PIE_COLOURS.length}"></span><span class="legend-label">${escapeHTML(label)}</span><span class="legend-value">${compact(value)} · ${Math.round(value / total * 100)}%</span></li>`).join("");
  return `<div class="pie"><svg viewBox="0 0 120 120" width="150" height="150" role="img" aria-label="Award value by supplier">${slices}</svg><ul class="legend">${legend}</ul></div>`;
}
// Both series on one run of years, so two charts stacked above each other line up; a year without data is a gap.
function sameYears(start, ...series) {
  const years = series.flat().map(([year]) => Number(year)).filter(Boolean);
  if (!years.length) return series;
  const from = Math.min(start || Infinity, ...years), to = Math.max(...years);
  return series.map(entries => { const values = new Map(entries); return Array.from({ length: to - from + 1 }, (_, i) => [String(from + i), values.get(String(from + i)) ?? null]); });
}
function barChart(entries, format, label) {
  if (!entries.length) return "";
  const max = Math.max(...entries.map(([, v]) => v ?? 0)) || 1, w = 100 / entries.length, every = Math.ceil(entries.length / 8);
  const bars = entries.map(([k, v], i) => v == null ? "" : `<rect x="${(i * w + 0.8).toFixed(2)}" y="${(60 - 58 * v / max).toFixed(2)}" width="${(w - 1.6).toFixed(2)}" height="${Math.max(0.5, 58 * v / max).toFixed(2)}" fill="#116c5a"><title>${escapeHTML(k)}: ${format(v)}</title></rect>`).join("");
  const labels = entries.map(([k], i) => `<span>${i % every === 0 ? escapeHTML(String(k).slice(-4)) : ""}</span>`).join("");
  return `<div class="chart"><svg viewBox="0 0 100 60" class="bars" preserveAspectRatio="none" role="img" aria-label="${escapeHTML(label)}">${bars}</svg><div class="axis">${labels}</div></div>`;
}
function renderVendorOverview(pulled) {
  const get = key => pulled.find(d => d.key === key);
  const stat = (label, value, foot) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
  const fed = get("fed_contracts"), summary = fed?.summary || { by_year: [], by_department: [], by_procedure: [], committed: 0, contracts: 0, amendments: 0 };
  const nonComp = summary.by_procedure.filter(p => /non-competitive|advance contract/i.test(p.procedure)).reduce((s, p) => s + p.committed, 0);
  const nonCompShare = summary.committed ? Math.round(100 * nonComp / summary.committed) : 0;
  const lobbying = get("fed_lobbying")?.records || [], institutions = new Set(lobbying.flatMap(r => (r.institutions || "").split("; ").filter(Boolean)));
  const barred = [...(get("fed_ineligible")?.records || []), ...(get("qc_debarment")?.records || [])];
  const payments = get("on_payments"), paid = payments?.summary?.paid || 0;
  const city = get("city_awards"), cityTotal = (city?.records || []).reduce((s, r) => s + (r.amount || 0), 0), cityNonComp = (get("city_non_competitive")?.records || []).reduce((s, r) => s + (r.amount || 0), 0);
  const byDepartment = summary.by_department.map(d => [d.department, d.committed]);
  const perYear = new Map();
  const add = (year, tier, value) => { if (!year || !value) return; const row = perYear.get(year) || { federal: 0, provincial: 0, municipal: 0 }; row[tier] += value; perYear.set(year, row); };
  summary.by_year.forEach(y => add(String(y.year), "federal", y.committed));
  (payments?.summary?.by_year || []).forEach(y => add(y.year.slice(0, 4), "provincial", y.amount));
  (city?.records || []).forEach(r => add(String(r.year || (r.award_date || "").slice(0, 4)), "municipal", r.amount || 0));
  const years = [...perYear.keys()].sort(), byYear = years.map(y => [y, Object.values(perYear.get(y)).reduce((a, b) => a + b, 0)]);
  const tiersPresent = ["federal", "provincial", "municipal"].filter(t => years.some(y => perYear.get(y)[t]));
  const tierTable = years.length ? `<div class="table-wrap"><table class="tiers"><thead><tr><th>Year</th>${tiersPresent.map(t => `<th>${t}</th>`).join("")}</tr></thead><tbody>${years.map(y => `<tr><td>${y}</td>${tiersPresent.map(t => `<td class="amount">${perYear.get(y)[t] ? compact(perYear.get(y)[t]) : "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : "";
  const since = pulled[0].since_year, names = pulled[0].vendor_names || [];
  return `<div class="panel overview"><div class="section-header"><div><p class="eyebrow">AT A GLANCE · ${escapeHTML((pulled[0].city || "").toUpperCase())}</p><h3>What public records show for ${escapeHTML(names[0] || current.contractor)} since ${since}</h3></div></div>
    <div class="stats">${fed ? stat("Federal commitments", compact(summary.committed), `${summary.contracts} contract${summary.contracts === 1 ? "" : "s"} · ${summary.amendments} amendment${summary.amendments === 1 ? "" : "s"} · incl. taxes`) : stat("Federal contracts", "—", pulled[0].errors?.some(e => e.includes("index")) ? "index building — pull again later" : "not loaded")}${fed ? stat("Awarded without competition", `${nonCompShare}%`, `${compact(nonComp)} by value · non-competitive or ACAN`) : ""}${get("fed_lobbying") ? stat("Lobbying communications", lobbying.length, `${institutions.size} institution${institutions.size === 1 ? "" : "s"} lobbied`) : ""}${get("fed_ineligible") || get("qc_debarment") ? stat("Barred-supplier lists", barred.length, barred.length ? escapeHTML(barred[0].company) : `none among the names (${get("fed_ineligible")?.checked ?? "—"} checked)`) : ""}${payments ? stat("Ontario payments", compact(paid), `${payments.records.length} line${payments.records.length === 1 ? "" : "s"} of $50k+ · incl. tax`) : ""}${city ? stat(`${escapeHTML(city.records[0]?.city || "City")} awards`, compact(cityTotal), `${city.records.length} award${city.records.length === 1 ? "" : "s"}${cityNonComp ? ` · ${compact(cityNonComp)} non-competitive` : ""}`) : ""}</div>
    <div class="overview-grid">
      <div><h4>Who buys from the supplier (federal)</h4>${byDepartment.length ? pieChart(byDepartment, summary.committed) : '<p class="help">No federal contract rows on file.</p>'}</div>
      <div><h4>Money by year, all tiers</h4>${byYear.length ? barChart(byYear, compact, "Money by year") : '<p class="help">—</p>'}${summary.by_procedure.length ? `<h4>By procedure</h4><ul class="legend plain">${summary.by_procedure.map(p => `<li><span class="legend-label">${escapeHTML(p.procedure)}</span><span class="legend-value">${p.rows} · ${compact(p.committed)}</span></li>`).join("")}</ul>` : ""}</div>
      <div><h4>Year by tier</h4>${tierTable || '<p class="help">—</p>'}<p class="help">Federal: commitments (award + amendments). Provincial: payments including tax. Municipal: award values.</p></div>
    </div>
    <p class="help">Figures are computed from the open-data rows below and match records by company name; a name-prefix match can include an unrelated firm — check the Vendor name on each row. Run the investigation for indicators and cited findings.</p></div>`;
}
function renderOverview() {
  const pulled = current.open_data || [];
  if (!pulled.length) return "";
  if (isVendorCase()) return renderVendorOverview(pulled);
  const get = key => pulled.find(d => d.key === key);
  const awards = (get("awarded")?.records || []), roadAwards = awards.filter(r => r.road_work);
  const total = roadAwards.reduce((s, r) => s + (r.amount || 0), 0), allTotal = awards.reduce((s, r) => s + (r.amount || 0), 0);
  const bySupplier = groupSum(roadAwards, r => r.supplier, r => r.amount || 0);
  const byYear = groupSum(roadAwards, r => (r.award_date || "").slice(0, 4), r => r.amount || 0).sort((a, b) => a[0].localeCompare(b[0]));
  const byStreet = groupSum(roadAwards, r => r.street, r => r.amount || 0);
  const nonComp = get("non_competitive")?.records || [], nonCompTotal = nonComp.reduce((s, r) => s + (r.amount || 0), 0);
  const programs = get("road_program")?.records || [], permits = get("restrictions")?.records || [], lobbying = get("lobbying")?.records || [];
  const lobbyingSuppliers = new Set(lobbying.filter(r => r.supplier).map(r => r.supplier)).size;
  const bids = (get("bids")?.records || []).filter(r => r.road_work && r.bidders), single = bids.filter(r => r.bidders === 1).length;
  const barred = get("debarment")?.records || [], freeze = (get("climate")?.records || []).filter(r => r.days >= 150).map(r => [String(r.year), r.freeze_thaw_days]);
  const trafficRows = get("traffic")?.records || [], heavy = trafficRows.filter(r => r.heavy_vehicle_pct != null);
  const heavyAvg = heavy.length ? (heavy.reduce((s, r) => s + r.heavy_vehicle_pct, 0) / heavy.length).toFixed(1) : null;
  const avgBidders = bids.length ? (bids.reduce((s, r) => s + r.bidders, 0) / bids.length).toFixed(1) : null;
  const s311 = get("requests_311")?.summary || [];
  const damage311 = groupSum(s311.filter(i => i.year && /pot ?hole|damaged|sinking|utility cut|nid-de-poule|pavage|trottoir ou bordure|affaissement/i.test(i.type)), i => i.year, i => i.count).sort((a, b) => a[0].localeCompare(b[0]));
  const since = pulled[0].since_year, streets = pulled[0].streets || [];
  const [damageYears, freezeYears] = damage311.length && freeze.length ? sameYears(since, damage311, freeze) : [damage311, freeze];
  const first311 = damage311[0]?.[0], blank311 = first311 && damageYears[0][0] < first311 ? ` The city's published 311 records for ${streets.length > 1 ? "these streets" : "this street"} begin in ${first311}; earlier years are blank.` : "";
  const stat = (label, value, foot) => `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="foot">${foot}</div></div>`;
  return `<div class="panel overview"><div class="section-header"><div><p class="eyebrow">AT A GLANCE · ${escapeHTML((pulled[0].city || "").toUpperCase())}</p><h3>What ${escapeHTML(pulled[0].city || "the city")}'s records show for ${escapeHTML(streets.join(", "))} since ${since}</h3></div></div>
    <div class="stats">${stat("Awarded for road work", compact(total), `${roadAwards.length} competitive award${roadAwards.length === 1 ? "" : "s"} · award values, not payments`)}${stat("All awards naming the street" + (streets.length > 1 ? "s" : ""), compact(allTotal), `${awards.length} award${awards.length === 1 ? "" : "s"} incl. non-road work`)}${stat("Non-competitive, same suppliers", compact(nonCompTotal), `${nonComp.length} contract${nonComp.length === 1 ? "" : "s"} anywhere in the city`)}${get("road_program") ? stat("Road program entries", programs.length, `${programs.filter(p => p.status === "Active").length} active · ${permits.length} live permit${permits.length === 1 ? "" : "s"}`) : stat("Live permits", permits.length, `${new Set(permits.map(p => p.contractor).filter(Boolean)).size} organisations named`)}${get("lobbying") ? stat("Suppliers who lobby the City", lobbyingSuppliers, `${lobbying.length} registry entr${lobbying.length === 1 ? "y" : "ies"} incl. street mentions`) : ""}${get("bids") ? stat("Bidders per road tender", avgBidders ?? "—", `${bids.length} SEAO tender${bids.length === 1 ? "" : "s"} · ${single} with a single bidder`) : ""}${get("debarment") ? stat("Barred companies (RENA)", barred.length, barred.length ? escapeHTML(barred[0].company) : "none among suppliers & bidders") : ""}${get("traffic") && heavyAvg ? stat("Heavy-vehicle share", `${heavyAvg}%`, `${trafficRows.length} intersection count${trafficRows.length === 1 ? "" : "s"}`) : ""}</div>
    <div class="overview-grid">
      <div><h4>Who won the road work</h4>${bySupplier.length ? pieChart(bySupplier, total) : '<p class="help">No road-related competitive awards name these streets in the period.</p>'}</div>
      <div><h4>Award value by year</h4>${byYear.length ? barChart(byYear, compact, "Award value by year") : '<p class="help">—</p>'}${streets.length > 1 && byStreet.length ? `<h4>By street</h4><ul class="legend plain">${byStreet.map(([k, v]) => `<li><span class="legend-label">${escapeHTML(k)}</span><span class="legend-value">${compact(v)}</span></li>`).join("")}</ul>` : ""}</div>
      <div><h4>Road-damage 311 requests by year</h4>${damage311.length ? barChart(damageYears, v => `${v} requests`, "Road damage requests by year") : '<p class="help">—</p>'}<p class="help">Potholes, damaged or sinking road, utility-cut settlement at intersections on the street${streets.length > 1 ? "s" : ""}.${blank311}</p>${freeze.length ? `<h4>Freeze-thaw days per winter</h4>${barChart(freezeYears, v => `${v} days`, "Freeze-thaw days per winter")}<p class="help">Winter ending in that year, nearest Environment Canada station. Compare with the complaint bars above.</p>` : ""}</div>
    </div>
    <p class="help">Figures are computed from the open-data rows below and match records by street name; a long street's total includes other segments. Awards are authorizations, not money paid — payments need the ledger. Run the investigation for indicators and cited findings.</p></div>`;
}
// One Leaflet instance at a time: either the Map tab (#road-map) or the New case dialog (#new-case-map).
function createMap(el, places, onPick, city) {
  if (!el || typeof L === "undefined") return null;
  if (map) { map.remove(); map = null; conditionLayer = null; conditionLegend = null; }
  map = L.map(el, { zoomControl: true }).setView(city?.centre || [43.6532, -79.3832], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
  L.Icon.Default.prototype.options.imagePath = "/static/vendor/leaflet/images/";
  mapLayer = L.layerGroup().addTo(map);
  drawPlaces(places);
  map.on("click", async (event) => {
    if (busy) return;
    try {
      const found = await api(`/geocode/reverse?lat=${event.latlng.lat}&lon=${event.latlng.lng}`);
      if (!found.road) return notify("No street at that point. Click directly on a road.", true);
      await onPick(found);
    } catch (error) { notify(error.message, true); }
  });
  return map;
}
function mountMap() {
  createMap($("#road-map"), current.locations || [], chooseStreet, caseCity());
  mountCondition(caseCity().key);
  $("#map-query")?.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); searchStreets("#map-query", "#map-results", caseCity().key).catch(err => notify(err.message, true)); } });
}
const STREET_COLOURS = ["#116c5a", "#a76b1d", "#1f4a7a", "#8a2d6b", "#4b6b1f", "#b23a3a"];
function drawPlaces(places, highlight) {
  if (!map || !mapLayer) return;
  mapLayer.clearLayers();
  const bounds = L.latLngBounds([]);
  places.forEach((place, i) => {
    const colour = STREET_COLOURS[i % STREET_COLOURS.length];
    if (place.geometry) { const line = L.geoJSON(place.geometry, { style: { color: colour, weight: 6, opacity: .85 } }).addTo(mapLayer); bounds.extend(line.getBounds()); }
    const marker = L.marker([place.latitude, place.longitude]).addTo(mapLayer).bindPopup(escapeHTML(place.road || place.display_name));
    bounds.extend(marker.getLatLng());
  });
  if (highlight) {
    if (highlight.geometry) { const line = L.geoJSON(highlight.geometry, { style: { color: "#d94d1a", weight: 7, opacity: .9, dashArray: "8 6" } }).addTo(mapLayer); bounds.extend(line.getBounds()); }
    bounds.extend([highlight.latitude, highlight.longitude]);
  }
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
}
// ---- Road-condition overlay: fetched per viewport from /api/condition, drawn on a canvas renderer ----
function conditionEnabled() {
  if ($("#project-dialog").open) return $("#new-case-condition")?.checked;
  return current ? current.show_condition !== false : true;
}
function mountCondition(cityKey) {
  if (!map) return;
  if (conditionLayer) { map.removeLayer(conditionLayer); conditionLayer = null; }
  if (conditionLegend) { conditionLegend.remove(); conditionLegend = null; }
  if (!conditionEnabled()) return;
  conditionLayer = L.geoJSON(null, {
    renderer: L.canvas({ padding: 0.5 }),
    style: f => ({ color: GRADE_COLOURS[f.properties.grade] || "#888", weight: 4, opacity: .75 }),
    onEachFeature: (f, layer) => layer.bindTooltip(`${escapeHTML(f.properties.label)}<br><small>${escapeHTML(f.properties.detail)}</small>`, { sticky: true }),
  }).addTo(map);
  conditionLayer.bringToBack();
  const refresh = () => { clearTimeout(conditionTimer); conditionTimer = setTimeout(() => loadCondition(cityKey), 250); };
  map.on("moveend zoomend", refresh);
  refresh();
}
async function loadCondition(cityKey) {
  if (!map || !conditionLayer) return;
  const request = ++conditionRequest, bounds = map.getBounds();
  if (map.getZoom() < 13) { conditionLayer.clearLayers(); showLegend(null, "Zoom in to see road condition"); return; }
  try {
    const data = await api(`/condition?city=${encodeURIComponent(cityKey)}&bbox=${bounds.getWest()},${bounds.getSouth()},${bounds.getEast()},${bounds.getNorth()}`);
    if (request !== conditionRequest || !conditionLayer) return;
    conditionLayer.clearLayers(); conditionLayer.addData(data); conditionLayer.bringToBack();
    showLegend(data.legend, data.truncated ? "Zoom in further for every segment" : "");
  } catch (error) { showLegend(null, error.message); }
}
function showLegend(legend, note) {
  if (!map) return;
  if (!conditionLegend) {
    conditionLegend = L.control({ position: "bottomright" });
    conditionLegend.onAdd = () => { const div = L.DomUtil.create("div", "condition-legend"); L.DomEvent.disableClickPropagation(div); return div; };
    conditionLegend.addTo(map);
  }
  const div = conditionLegend.getContainer();
  div.innerHTML = legend
    ? `<strong>${escapeHTML(legend.title)}</strong>${legend.classes.map(([g, label]) => `<div><span class="swatch" data-grade="${g}"></span>${escapeHTML(label)}</div>`).join("")}<small>${escapeHTML(legend.note)} <a href="${escapeHTML(legend.source_url)}" target="_blank" rel="noopener noreferrer">source ↗</a>${note ? " · " + escapeHTML(note) : ""}</small>`
    : `<small>${escapeHTML(note || "")}</small>`;
}
async function toggleCondition(on) {
  current = await api(`/projects/${current.id}/settings`, "PUT", { show_condition: on });
  mountCondition(caseCity().key);
}
async function searchStreets(inputSelector, listSelector, cityKey) {
  const q = $(inputSelector).value.trim();
  if (!q) return;
  $(listSelector).innerHTML = "<li><small>Searching…</small></li>";
  mapResults = await api(`/geocode?q=${encodeURIComponent(q)}${cityKey ? `&city=${encodeURIComponent(cityKey)}` : ""}`);
  $(listSelector).innerHTML = mapResults.length ? mapResults.map((p, i) => `<li><button type="button" data-place="${i}">＋ ${escapeHTML(p.road || p.display_name.split(",")[0])}</button><small>${escapeHTML(p.display_name)}${p.city_key ? "" : " · open data not connected for this city"}</small></li>`).join("") : `<li><small>No streets found in ${escapeHTML(cityOf(cityKey).name)}.</small></li>`;
}
function placePayload(place) {
  return { road: place.road || place.display_name.split(",")[0], display_name: place.display_name, city_key: place.city_key, latitude: place.latitude, longitude: place.longitude, osm_type: place.osm_type, osm_id: place.osm_id, geometry: place.geometry, from_street: place.from_street || "", to_street: place.to_street || "" };
}
function unsupportedCity(place) {
  return `Open data is connected for ${cities.map(c => c.name).join(" and ")} so far. ${place.display_name.split(",").slice(-3).join(",").trim()} isn't supported yet.`;
}
async function chooseStreet(place) {
  if (!place.city_key) return notify(unsupportedCity(place), true);
  current = await api(`/projects/${current.id}/locations`, "POST", placePayload(place));
  render(); notify(`${place.road} added. ${current.locations.length > 1 ? "Pull open data again to include it." : "Now pull its open data."}`);
}
async function removeStreet(index) {
  current = await api(`/projects/${current.id}/locations/${index}`, "DELETE");
  render(); notify("Street removed. Pull open data again to update the records.");
}
// New case dialog: streets picked here are sent with the case and their open data pulled on create.
let newCasePlaces = [];
function renderNewCaseStreets() {
  const box = $("#new-case-street");
  if (!newCasePlaces.length) { box.className = "callout"; box.textContent = "No street selected yet. Search above or click the map. You can add several."; return; }
  box.className = "callout selected";
  box.innerHTML = streetList(newCasePlaces.map(placePayload), true) + '<p class="help">Optionally type the contract limits (the cross streets) so records are flagged inside/outside them. Add more streets, or create the case.</p>';
}
function pickNewCaseStreet(place) {
  const form = $("#project-form");
  if (!place.city_key) { drawPlaces(newCasePlaces, place); return notify(unsupportedCity(place) + " You can still create the case and attach documents manually.", true); }
  if (place.city_key !== $("#new-case-city").value) return notify(`That street is in ${cityOf(place.city_key).name}; switch the city selector to add it.`, true);
  if (newCasePlaces.length && newCasePlaces[0].city_key !== place.city_key) return notify("All streets in a case must be in the same city.", true);
  if (newCasePlaces.some(p => (p.road || "").toLowerCase() === (place.road || "").toLowerCase())) return notify(`${place.road} is already in the list.`, true);
  newCasePlaces.push(place);
  drawPlaces(newCasePlaces); renderNewCaseStreets();
  const roads = newCasePlaces.map(p => p.road || p.display_name.split(",")[0]);
  form.road.value = `${roads.join(" & ")}, ${place.city || ""}`.replace(/, $/, "");
  if (!form.name.value || /road works \d{4}$/.test(form.name.value)) form.name.value = `${roads.join(" & ")} road works ${new Date().getFullYear()}`;
}
function openNewCaseDialog() {
  newCasePlaces = []; mapResults = [];
  renderNewCaseStreets();
  $("#new-case-results").innerHTML = "";
  const select = $("#new-case-city"), chosen = cityOf(localStorage.getItem("roadwatch.city"));
  select.innerHTML = cities.map(c => `<option value="${escapeHTML(c.key)}" ${c.key === chosen.key ? "selected" : ""}>${escapeHTML(c.name)}</option>`).join("");
  $("#new-case-province").innerHTML = '<option value="">Federal records only</option>' + provinces.map(p => `<option value="${escapeHTML(p.key)}">${escapeHTML(p.name)} (+ ${escapeHTML(p.city_name)})</option>`).join("");
  $("#project-dialog").showModal();
  setCaseMode(localStorage.getItem("roadwatch.caseMode") === "vendor" ? "vendor" : "street");
  $("#new-case-condition").checked = localStorage.getItem("roadwatch.condition") !== "off";
  createMap($("#new-case-map"), [], async place => pickNewCaseStreet(place), chosen);
  mountCondition(chosen.key);
  setTimeout(() => map?.invalidateSize(), 50);
}
// The dialog has two panes; the hidden pane's inputs are disabled so they neither validate nor submit.
function setCaseMode(mode) {
  caseMode = mode; localStorage.setItem("roadwatch.caseMode", mode);
  document.querySelectorAll("#project-dialog .mode-tab").forEach(b => b.classList.toggle("active", b.dataset.caseMode === mode));
  document.querySelectorAll("#project-dialog [data-case-pane]").forEach(pane => { pane.hidden = pane.dataset.casePane !== mode; pane.querySelectorAll("input,select").forEach(el => el.disabled = pane.hidden); });
  $("#new-case-title").textContent = mode === "vendor" ? "Which supplier?" : "Which road?";
  updateProvinceHelp();
  if (mode === "street") setTimeout(() => map?.invalidateSize(), 50);
  (mode === "vendor" ? $("#project-form").vendor_name : $("#new-case-query")).focus();
}
function updateProvinceHelp() {
  const province = provinces.find(p => p.key === $("#new-case-province")?.value);
  $("#new-case-province-help").textContent = province ? `Adds ${province.name}: ${province.tiers}.` : "Without a province, only Government of Canada records are pulled. Ontario adds Toronto; Québec adds Montréal.";
}
$("#new-case-province").addEventListener("change", updateProvinceHelp);
let newCaseSince = 0;  // "records since" chosen in the new-case dialog, consumed by the first pull
async function pullOpenData() {
  if (busy) return;
  const since = newCaseSince || Number($("#since-year")?.value || 2000);
  newCaseSince = 0;
  busy = "opendata"; render();
  try { current = await api(`/projects/${current.id}/open-data`, "POST", { since_year: since }); notify("Open data stored as documents. Run the investigation to analyse it."); }
  catch (error) { notify(error.message, true); }
  finally { busy = false; render(); }
}
// ---- Team discussion -------------------------------------------------------------------------
function statusOf(key) { return (discussion?.statuses || []).find(s => s.finding_key === key); }
function observationLabel(o) { return `Observation ${o.observed_on} · ${o.severity}: ${o.description.slice(0, 70)}${o.description.length > 70 ? "…" : ""}`; }
function statusBadge(f) {
  const st = statusOf(f.key);
  return st ? `<span class="badge status-${escapeHTML(st.status)}" title="${escapeHTML(st.note || "")}">${escapeHTML(STATUS_LABELS[st.status] || st.status)}${st.assignee_name ? " · " + escapeHTML(st.assignee_name) : ""}</span>` : "";
}
function threadCount(type, id) {
  const n = (discussion?.comments || []).filter(c => c.anchor_type === type && c.anchor_id === id).length;
  return n ? ` (${n})` : "";
}
function renderAssessments() {
  const items = (discussion?.comments || []).filter(c => c.kind === "assessment");
  if (!items.length) return "";
  return `<div class="panel assessments"><p class="eyebrow">TEAM ASSESSMENTS</p>${items.map(c => assessmentCard(c)).join("")}</div>`;
}
function assessmentCard(c) {
  const a = c.assessment || {};
  return `<article class="assessment ${a.status === "reviewed" ? "reviewed" : ""}"><div class="finding-top"><span class="badge risk-${escapeHTML(a.risk)}">${escapeHTML(RISK_LABELS[a.risk] || a.risk)}</span><span class="badge">${a.status === "reviewed" ? "Reviewed" : "Draft"}</span><span class="badge">${escapeHTML(c.author_name)} · ${escapeHTML(c.author_role)}</span>${c.opinion ? '<span class="badge opinion" title="Conclusory language without a citation">Opinion</span>' : ""}<span class="spacer"></span><small class="help">${new Date(c.created_at).toLocaleString()}</small></div>
    <p class="assessment-summary">${escapeHTML(a.summary)}</p>${a.legal_basis ? `<p><strong>Legal basis / standard:</strong> ${escapeHTML(a.legal_basis)}</p>` : ""}${a.recommended_action ? `<p><strong>Recommended action:</strong> ${escapeHTML(a.recommended_action)}</p>` : ""}${c.anchor_label ? `<p class="help">On: ${escapeHTML(c.anchor_label)}</p>` : ""}<div class="citations">${(c.citations || []).map((ct, i) => citationButton(ct, current.evidence, i)).join("")}</div>${commentActions(c)}</article>`;
}
function commentActions(c) {
  const mine = me && (c.author_id === me.id || me.role === "admin");
  return mine ? `<div class="comment-actions"><button class="text-button" data-edit-comment="${c.id}">Edit</button><button class="text-button danger" data-delete-comment="${c.id}">Delete</button></div>` : "";
}
// A comment in a shared discussion may cite a document held by another case on the same streets: open this case's copy.
function localCitation(citation) {
  if (current.evidence.some(d => d.id === citation.evidence_id)) return citation;
  const twin = citation.title && current.evidence.find(d => d.title === citation.title);
  return twin ? { ...citation, evidence_id: twin.id } : citation;
}
function commentCard(c, depth = 0) {
  return `<article class="comment ${depth ? "reply" : ""}" id="comment-${c.id}"><div class="comment-head"><strong>${escapeHTML(c.author_name)}</strong><span class="badge">${escapeHTML(c.author_role)}</span>${c.opinion ? '<span class="badge opinion" title="Conclusory language without a citation">Opinion</span>' : ""}<small class="help">${new Date(c.created_at).toLocaleString()}${c.edited_at ? " · edited" : ""}${c.case_id && c.case_id !== current.id ? ` · posted in “${escapeHTML(c.case_name || "another case")}”` : ""}</small></div>
    <p>${escapeHTML(c.body)}</p><div class="citations">${(c.citations || []).map((ct, i) => citationButton(localCitation(ct), current.evidence, i)).join("")}</div>
    <div class="comment-actions"${isGuest() ? " hidden" : ""}><button class="text-button" data-reply="${c.id}">Reply</button>${commentActions(c).replace('<div class="comment-actions">', "").replace("</div>", "")}</div></article>`;
}
function renderDiscussion(latest) {
  if (!discussion) return '<div class="panel"><p class="help">Loading discussion…</p></div>';
  const members = discussion.members || [], comments = discussion.comments || [];
  const findings = latest?.findings || [];
  const anchors = [["case", "", "Whole case"], ...findings.map(f => ["finding", f.key, f.title]), ...current.observations.map(o => ["observation", o.id, observationLabel(o)]), ...current.evidence.map(d => ["evidence", d.id, `Document: ${d.title}`])];
  const selected = discussAnchor || { type: "case", id: "" };
  const board = findings.length ? `<div class="panel"><p class="eyebrow">FINDINGS BOARD</p><p class="help">Split the work: set a status and an owner on each finding. Statuses persist across report runs.</p><div class="table-wrap"><table class="board"><thead><tr><th>Finding</th><th>Status</th><th>Owner</th><th>Note</th></tr></thead><tbody>${findings.map(f => { const st = statusOf(f.key) || {}; return `<tr data-finding-row="${escapeHTML(f.key)}" data-finding-title="${escapeHTML(f.title)}"><td><button class="link-button small" data-discuss="${escapeHTML(f.key)}" data-discuss-label="${escapeHTML(f.title)}">${escapeHTML(f.title)}</button></td><td><select data-status-field="status">${Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}" ${(st.status || "open") === k ? "selected" : ""}>${v}</option>`).join("")}</select></td><td><select data-status-field="assignee_id"><option value="">—</option>${members.map(m => `<option value="${m.id}" ${st.assignee_id === m.id ? "selected" : ""}>${escapeHTML(m.name)}</option>`).join("")}${me && !members.some(m => m.id === me.id) ? `<option value="${me.id}" ${st.assignee_id === me.id ? "selected" : ""}>${escapeHTML(me.name)}</option>` : ""}</select></td><td><input data-status-field="note" value="${escapeHTML(st.note || "")}" placeholder="what was checked / found" maxlength="2000"></td></tr>`; }).join("")}</tbody></table></div></div>` : "";
  const roots = comments.filter(c => !c.parent_id && c.kind === "comment"), byParent = {};
  comments.forEach(c => { if (c.parent_id) (byParent[c.parent_id] ||= []).push(c); });
  const grouped = {};
  roots.forEach(c => { (grouped[`${c.anchor_type}|${c.anchor_id}`] ||= []).push(c); });
  const threads = Object.entries(grouped).map(([key, list]) => `<section class="thread"><h4>${escapeHTML(list[0].anchor_label || (list[0].anchor_type === "case" ? "Whole case" : list[0].anchor_type))}</h4>${list.map(c => commentCard(c) + (byParent[c.id] || []).map(r => commentCard(r, 1)).join("")).join("")}</section>`).join("");
  return `<div class="section-header"><div><h2>Discussion</h2><p class="help">${escapeHTML(discussion.notice)}</p>${discussion.shared_streets?.length ? `<p class="help"><strong>One discussion for ${escapeHTML(discussion.shared_streets.join(", "))}.</strong> Every case on exactly ${discussion.shared_streets.length === 1 ? "this street" : "these streets"} shows and adds to it; adding or removing a street moves the case to that set's discussion. Finding statuses and owners stay with each case.</p>` : ""}</div><div class="help">${members.length} member${members.length === 1 ? "" : "s"}${me ? ` · you: ${escapeHTML(me.name)} (${escapeHTML(me.role)})` : ""}</div></div>
    ${renderAssessments()}${board}
    ${isGuest() ? '<div class="panel"><p class="help">Guests can read the discussion and set finding statuses, but not post. <button class="text-button" data-action="logout">Sign in</button> to write a comment or an assessment.</p></div>' : `<div class="panel composer"><p class="eyebrow" id="composer-title">${discussAnchor?.replyTo ? "REPLY" : "NEW POST"}</p>
      <div class="form-grid"><label>Type<select id="post-kind"><option value="comment">Comment / working note</option><option value="assessment">Assessment (structured conclusion)</option></select></label>
      <label>About<select id="post-anchor">${anchors.map(([t, id, label]) => `<option value="${t}|${escapeHTML(id)}" ${t === selected.type && id === selected.id ? "selected" : ""}>${escapeHTML(label.slice(0, 90))}</option>`).join("")}</select></label></div>
      <div id="assessment-fields" hidden><label>Summary of what the evidence supports<textarea id="post-summary" rows="3" maxlength="4000" placeholder="e.g. The award to X on 2024-08-16 exceeds the City's estimate by 26% and the same firm won 3 of 4 tenders on this corridor; the records on file do not show the bid evaluation."></textarea></label>
        <div class="form-grid"><label>Legal basis / standard<input id="post-basis" maxlength="2000" placeholder="e.g. Toronto Municipal Code ch. 195; Competition Act s.47 (bid-rigging)"></label><label>Risk<select id="post-risk"><option value="unclear">Unclear</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label></div>
        <div class="form-grid"><label>Recommended action<input id="post-action" maxlength="2000" placeholder="e.g. FOI request for bid tabulation; refer to Auditor General"></label><label>Status<select id="post-status"><option value="draft">Draft</option><option value="reviewed">Reviewed</option></select></label></div></div>
      <label id="body-label">Comment<textarea id="post-body" rows="4" maxlength="6000" placeholder="What did you check, what did you find, what should someone verify next? Cite the page."></textarea></label>
      <details class="help-details"><summary>Add a citation (optional, verified against the document)</summary><div class="form-grid"><label>Document<select id="post-cite-doc"><option value="">—</option>${current.evidence.map(d => `<option value="${d.id}">${escapeHTML(d.title.slice(0, 80))}</option>`).join("")}</select></label><label>Page<input id="post-cite-page" type="number" min="1" value="1"></label></div><label>Exact quotation<textarea id="post-cite-quote" rows="2" maxlength="2000" placeholder="Copy the passage exactly as it appears on that page."></textarea></label></details>
      <div class="actions"><button class="primary" data-action="post-comment">Post →</button>${discussAnchor?.replyTo ? '<button class="secondary" data-action="cancel-reply">Cancel reply</button>' : ""}</div></div>`}
    ${threads || '<div class="panel empty"><h2>No discussion yet</h2><p>Start with what you checked and what someone should verify next.</p></div>'}`;
}
// Someone is part-way through a post: a background refresh must not redraw the form and lose it.
function composing() { return tab === "discussion" && ["#post-body", "#post-summary", "#post-cite-quote"].some(id => $(id)?.value.trim()); }
async function loadDiscussion(silent = false) {
  if (!current) return;
  try { const fresh = await api(`/projects/${current.id}/discussion`); const changed = JSON.stringify(fresh.comments) !== JSON.stringify(discussion?.comments) || JSON.stringify(fresh.statuses) !== JSON.stringify(discussion?.statuses); discussion = fresh; if (!silent || (changed && !composing())) render(); }
  catch (error) { if (!silent) notify(error.message, true); }
}
async function postComment() {
  const kind = $("#post-kind").value, [anchorType, anchorId] = $("#post-anchor").value.split("|");
  const anchorLabel = $("#post-anchor").selectedOptions[0]?.textContent || "";
  const payload = { kind, anchor_type: anchorType, anchor_id: anchorId, anchor_label: anchorLabel, parent_id: discussAnchor?.replyTo || null, body: $("#post-body").value, citations: [] };
  const doc = $("#post-cite-doc").value, quote = $("#post-cite-quote").value.trim();
  if (doc && quote) payload.citations.push({ evidence_id: doc, page: Number($("#post-cite-page").value || 1), quote });
  if (kind === "assessment") payload.assessment = { summary: $("#post-summary").value, legal_basis: $("#post-basis").value, risk: $("#post-risk").value, recommended_action: $("#post-action").value, status: $("#post-status").value };
  await api(`/projects/${current.id}/comments`, "POST", payload);
  discussAnchor = discussAnchor ? { type: discussAnchor.type, id: discussAnchor.id } : null;
  await loadDiscussion(); notify("Posted.");
}
async function saveStatus(row) {
  const key = row.dataset.findingRow, fields = Object.fromEntries([...row.querySelectorAll("[data-status-field]")].map(el => [el.dataset.statusField, el.value]));
  await api(`/projects/${current.id}/findings/${key}/status`, "PUT", { status: fields.status, assignee_id: fields.assignee_id || null, note: fields.note, title: row.dataset.findingTitle });
  await loadDiscussion(true); notify("Status saved.");
}
document.addEventListener("change", e => {
  if (e.target.id === "post-kind") { $("#assessment-fields").hidden = e.target.value !== "assessment"; $("#body-label").firstChild.textContent = e.target.value === "assessment" ? "Notes (optional)" : "Comment"; }
  const row = e.target.closest?.("[data-finding-row]"); if (row && e.target.dataset.statusField) saveStatus(row).catch(err => notify(err.message, true));
});
// ---- Team dialog --------------------------------------------------------------------------------
async function openTeamDialog() {
  const data = await api("/members");
  const status = m => !m.active ? "deactivated" : m.has_password ? (m.invited ? "reset link pending" : "active") : "invited";
  $("#team-list").innerHTML = data.members.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Last sign-in</th><th></th></tr></thead><tbody>${data.members.map(m => `<tr><td>${escapeHTML(m.name)}</td><td>${escapeHTML(m.email || "—")}</td><td><select data-member-role="${m.id}">${data.roles.map(r => `<option value="${r}" ${m.role === r ? "selected" : ""}>${r}</option>`).join("")}</select></td><td>${status(m)}</td><td>${m.last_login ? new Date(m.last_login).toLocaleDateString() : "never"}</td><td><button class="text-button" data-member-toggle="${m.id}" data-active="${m.active ? 1 : 0}">${m.active ? "Deactivate" : "Reactivate"}</button> <button class="text-button" data-member-reset="${m.id}">${m.has_password ? "Reset password" : "New invite link"}</button></td></tr>`).join("")}</tbody></table></div>` : '<p class="help">No accounts yet. Invite someone below.</p>';
  $("#new-key").hidden = true;
  $("#team-dialog").showModal();
}
function showNewKey(member) {
  $("#new-key").hidden = false;
  const link = member.invite_link || member.key;
  $("#new-key").innerHTML = `<strong>${escapeHTML(member.name)}</strong> (${escapeHTML(member.role)}) — ${member.invite_link ? (member.emailed ? "invite emailed; the link, in case it does not arrive" : "invite link, valid 72 hours, shown once") : "personal key, shown once"}:<br><code class="key">${escapeHTML(link)}</code><br><small>${member.invite_link ? "Send it over a channel you trust. Opening it lets the person set their own password." : "Send it over a channel you trust."}</small>`;
}
function citationButton(citation, sources, index, report = false) {
  const doc = sources.find(d => d.id === citation.evidence_id);
  return `<button class="citation" data-source="${escapeHTML(citation.evidence_id)}" data-page="${citation.page}" ${report ? 'data-report-source="true"' : ""} title="${escapeHTML(citation.quote)}">[${index + 1}] ${escapeHTML(doc?.title || citation.title || "Source")} · p.${citation.page}</button>`;
}
function renderReport(report, stale) {
  const noDocs = !current.evidence.length;
  const providers = config.providers || [];
  const chosen = providers.find(p => p.id === localStorage.getItem("roadwatch.provider")) || providers[0];
  const picker = providers.length > 1 ? `<select id="provider-select" aria-label="AI model" title="Which model runs the investigation">${providers.map(p => `<option value="${escapeHTML(p.id)}" ${p.id === chosen.id ? "selected" : ""}>${escapeHTML(p.label)}</option>`).join("")}</select>` : "";
  const controls = `<div class="section-header"><div><h2>Investigation</h2><p class="help">Financial checks are instant and local. AI investigation reads the documents and follows leads.</p></div><div class="actions">${picker}<button class="secondary" data-action="checks" ${noDocs ? "disabled" : ""}>Run financial checks</button><button class="primary" data-action="${config.enabled ? "investigate" : "setup"}" ${noDocs && config.enabled ? "disabled" : ""}>${config.enabled ? "AI investigation →" : "AI not configured"}</button>${config.enabled ? `<button class="secondary deep" data-action="investigate-deep" ${noDocs ? "disabled" : ""} title="Plans hypotheses, tests each with its own reading budget, synthesises, then an adversarial review. 3-8 minutes.">Deep investigation →</button>` : ""}</div></div>`;
  const overview = renderOverview();
  if (!report && isVendorCase()) return controls + overview + empty(noDocs ? "Start with the supplier's public records" : "Ready to investigate", noDocs ? "Pull what the Government of Canada, the province and the city publish about this company, or import contracts and audit reports from the publishers' websites." : "Run the checks for the cross-government indicators, or start an AI investigation to have every record read and cross-referenced.", noDocs ? '<button class="secondary" data-tab="vendor">Open the supplier tab</button> <button class="secondary" data-action="evidence">＋ Add evidence</button>' : "");
  if (!report) return controls + overview + empty(noDocs ? "Start with the road or the award report" : "Ready to investigate", noDocs ? "Pick the street on the map and pull the city's open data about it, or import the contract award report from the publisher's website. Then add change orders, invoices and inspections as you obtain them." : "Run financial checks for an instant like-for-like comparison, or start an AI investigation to have every page read and cross-referenced.", noDocs ? '<button class="secondary" data-tab="map">Open the map</button> <button class="secondary" data-action="evidence">＋ Add evidence</button>' : "");
  return controls + overview + renderAssessments() + (stale ? '<div class="callout stale">Documents or entries have changed since this report. Run the investigation again before relying on it. Citations below refer to the saved snapshot.</div>' : "") +
    `<p class="report-meta">${report.mode === "ai" ? `${report.depth === "deep" ? "Deep" : "AI"} investigation · ${escapeHTML(report.model)}` : "Financial checks only"} · ${new Date(report.created_at).toLocaleString()} · ${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}</p>` +
    (report.answers?.length ? `<div class="panel answers"><p class="eyebrow">ANSWERS TO THE TEAM'S QUESTIONS</p>${report.answers.map(a => `<div class="answer"><p class="question">${escapeHTML(a.question)}</p><p>${escapeHTML(a.answer)}</p><div class="citations">${(a.citations || []).map((c, i) => citationButton(c, report.source_catalog, i, true)).join("")}</div></div>`).join("")}</div>` : "") +
    `<div class="report-grid"><section>${report.findings.length ? report.findings.map(f => `<article class="panel finding" id="finding-${escapeHTML(f.key || "")}"><div class="finding-top"><span class="badge review">Needs review</span><span class="badge ${f.origin === "ai" ? "ai" : ""}">${f.origin === "ai" ? "AI reading" : f.origin === "open_data" ? "Open-data indicator" : "Financial check"}</span>${statusBadge(f)}<span class="spacer"></span><button class="link-button small" data-discuss="${escapeHTML(f.key || "")}" data-discuss-label="${escapeHTML(f.title)}">Discuss${threadCount("finding", f.key)}</button></div><h3>${escapeHTML(f.title)}</h3>${f.confidence ? `<span class="badge conf-${escapeHTML(f.confidence)}">${escapeHTML(f.confidence)}</span>` : ""}${f.team_calibration != null ? `<span class="badge" title="Share of findings with a similar indicator pattern that this team escalated">team: ${Math.round(f.team_calibration * 100)}% escalated before</span>` : ""}<p>${escapeHTML(f.explanation)}</p><div class="reason"><strong>Possible innocent explanation</strong>${escapeHTML(f.alternative_explanation)}</div>${f.tests_performed?.length ? `<div class="tests"><strong>Tests performed</strong><ul>${f.tests_performed.map(t => `<li>${escapeHTML(t)}</li>`).join("")}</ul></div>` : ""}${f.what_would_change ? `<p class="help"><strong>What would change this:</strong> ${escapeHTML(f.what_would_change)}</p>` : ""}<p><strong>Next step:</strong> ${escapeHTML(f.next_step)}</p><div class="citations">${f.citations.map((c, i) => citationButton(c, report.source_catalog, i, true)).join("")}</div></article>`).join("") : empty("No discrepancies found in this run", "That's not a clearance — the records on file may be incomplete. See the evidence gaps on the right.")}
    <div class="panel"><details><summary>Method, limits &amp; what the AI looked at</summary><ul>${report.limitations.map(l => `<li>${escapeHTML(l)}</li>`).join("")}${report.mode === "ai" ? `<li>AI findings discarded for citing text that doesn't exist: ${report.rejected_findings}.</li>` : ""}${report.calibration ? `<li>${escapeHTML(report.calibration.note)}${report.calibration.available ? ` Trained on ${report.calibration.labels} verdicts (${report.calibration.escalated} escalated); most influential patterns: ${escapeHTML(report.calibration.influential_patterns.map(p => `${p.pattern} (${p.weight})`).join(", "))}.` : ` (${report.calibration.labels}/${report.calibration.needed} verdicts so far)`}</li>` : ""}</ul>${(report.passes || []).map(p => `<p class="help"><strong>${escapeHTML(p.pass)}</strong> (${escapeHTML(p.model || "")}): ${escapeHTML(p.hypotheses ? p.hypotheses.join(" · ") : p.results ? p.results.map(r => `${r.hypothesis} → ${r.verdict} (${r.for} for / ${r.against} against)`).join(" · ") : p.notes ? p.notes.join(" · ") : `${p.findings ?? ""} findings`)}</p>`).join("")}${report.activity.map(a => `<p class="help"><code>${escapeHTML(a.tool)} ${escapeHTML(a.arguments)}</code></p>`).join("")}</details></div></section>
    <aside><div class="panel"><p class="eyebrow">SPENDING SUMMARY</p><h3>Recorded entries only</h3>${report.totals.length ? report.totals.map(t => `<div class="total-group"><p>${escapeHTML(t.scope)} · ${escapeHTML(labels[t.basis])}</p><div class="total-row"><span>Award + amendments</span><strong>${money(t.authorized)}</strong></div><div class="total-row"><span>Recorded payments</span><strong>${money(t.paid)}</strong></div></div>`).join("") : '<p class="help">Record an award and payments of the same scope to see a comparison.</p>'}</div>
    <div class="panel"><p class="eyebrow">EVIDENCE GAPS</p><h3>What to request next</h3><ul class="record-list">${report.missing_records.map((g, i) => `<li><span class="number">${i + 1}</span><span>${escapeHTML(g)}</span></li>`).join("")}</ul></div></aside></div>`;
}
function renderEvidence() {
  return `<div class="section-header"><div><h2>Documents</h2><p class="help">Page text is stored so every finding can quote its source.</p></div><button class="primary" data-action="evidence">＋ Add evidence</button></div>` + (current.evidence.length ? `<div class="panel">${current.evidence.map(d => `<div class="doc-row"><div class="doc-icon">${d.kind === "open_data" ? "DATA" : (d.filename || "").toLowerCase().endsWith(".pdf") ? "PDF" : d.source_url && !d.filename ? "WEB" : "TXT"}</div><div class="doc-info"><h3>${escapeHTML(d.title)}</h3><p>${escapeHTML(kindLabels[d.kind] || d.kind)} · ${d.pages.length} page${d.pages.length === 1 ? "" : "s"} · ${d.source_url ? `<a href="${escapeHTML(d.source_url)}" target="_blank" rel="noopener noreferrer">original source ↗</a>` : "uploaded by user"}</p></div><button class="secondary" data-source="${d.id}">Read</button><button class="delete-button" data-delete="evidence" data-id="${d.id}">Remove</button></div>`).join("")}</div>` : empty("No documents yet", "Import the award report from the publisher's site, upload a PDF, or paste text."));
}
function renderFinances() {
  return `<div class="section-header"><div><h2>Spending</h2><p class="help">Every amount is tied to a quotation on a specific page.</p></div><button class="primary" data-action="finance">＋ Record amount</button></div><div class="callout">Keep budgets, awards and actual payments separate. Only entries with the same scope and tax basis are compared, and each group needs exactly one original award.</div>` + (current.finances.length ? `<div class="panel table-wrap"><table><thead><tr><th>Type / reference</th><th>Amount (CAD)</th><th>Scope / basis</th><th>Source</th><th></th></tr></thead><tbody>${current.finances.map(r => `<tr><td><span class="badge">${escapeHTML(r.kind)}</span><br>${escapeHTML(r.reference)}</td><td class="amount">${money(r.amount)}</td><td>${escapeHTML(r.scope)}<br><span class="help">${escapeHTML(labels[r.basis])}</span></td><td>${citationButton(r, current.evidence, 0)}</td><td><button class="delete-button" data-delete="finances" data-id="${r.id}">Remove</button></td></tr>`).join("")}</tbody></table></div>` : empty("Follow the spending", "Record the original award, each approved change, and each actual payment — with the passage that proves it."));
}
function renderObservations() {
  const threadFor = o => (discussion?.comments || []).filter(c => c.anchor_type === "observation" && c.anchor_id === o.id && !c.parent_id);
  return `<div class="section-header"><div><h2>Road condition</h2><p class="help">What the road looks like now, with date and location. Each observation has its own discussion thread.</p></div><button class="primary" data-action="observation">＋ Add observation</button></div>` + (current.observations.length ? current.observations.map(o => `<article class="panel observation"><div class="section-header"><span class="badge">${escapeHTML(o.severity)}</span><span class="help">${escapeHTML(o.observed_on)}</span></div><p>${escapeHTML(o.description)}</p><div class="section-header"><a class="gps" href="https://www.openstreetmap.org/?mlat=${o.latitude}&mlon=${o.longitude}#map=18/${o.latitude}/${o.longitude}" target="_blank" rel="noopener noreferrer">${o.latitude}, ${o.longitude} ↗</a><div class="actions"><button class="link-button small" data-discuss="${o.id}" data-discuss-type="observation" data-discuss-label="${escapeHTML(observationLabel(o))}">Discuss${threadCount("observation", o.id)}</button><button class="delete-button" data-delete="observations" data-id="${o.id}">Remove</button></div></div>${threadFor(o).length ? `<div class="inline-thread">${threadFor(o).slice(-3).map(c => `<div class="inline-comment"><strong>${escapeHTML(c.author_name)}</strong> <span class="badge">${escapeHTML(c.author_role)}</span> <small class="help">${new Date(c.created_at).toLocaleDateString()}</small><p>${escapeHTML(c.body)}</p></div>`).join("")}${threadFor(o).length > 3 ? `<button class="text-button" data-discuss="${o.id}" data-discuss-type="observation" data-discuss-label="${escapeHTML(observationLabel(o))}">See all ${threadFor(o).length} comments</button>` : ""}</div>` : ""}</article>`).join("") : empty("No observations yet", "Add a dated description and location. Condition reports give the investigation something to compare the paperwork against."));
}
function markWords(snippet, query) {
  const words = [...new Set(query.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) || [])];
  return escapeHTML(snippet).replace(/[\p{L}\p{N}_]+/gu, word => words.includes(word.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()) ? `<mark>${word}</mark>` : word);
}
let lastSearch = "", searchMode = "words";
async function searchCases(query, mode = searchMode) {
  lastSearch = query; searchMode = config.semantic_search ? mode : "words";
  const meaning = searchMode === "meaning";
  $("#search-title").textContent = `“${query}”`;
  const switcher = config.semantic_search ? `<div class="mode-tabs"><button class="mode-tab ${meaning ? "" : "active"}" data-search-mode="words">Exact words</button><button class="mode-tab ${meaning ? "active" : ""}" data-search-mode="meaning">By meaning</button></div>` : "";
  $("#search-results").innerHTML = switcher + '<p class="help">Searching…</p>';
  if (!$("#search-dialog").open) $("#search-dialog").showModal();
  let result;
  try { result = await api(`/search?q=${encodeURIComponent(query)}&mode=${searchMode}`); }
  catch (error) { $("#search-results").innerHTML = switcher + `<p class="error-text">${escapeHTML(error.message)}</p>`; return; }
  if (query !== lastSearch || result.mode !== searchMode) return;
  const cases = Object.values(result.hits.reduce((groups, hit) => { (groups[hit.project_id] ||= []).push(hit); return groups; }, {}));
  const indexing = result.indexing ? `<p class="callout stale">${result.indexing} document${result.indexing === 1 ? " is" : "s are"} still being prepared for search by meaning, so results may be incomplete. Search again in a minute.</p>` : "";
  const intro = meaning
    ? `<p class="help">The ${result.hits.length} page${result.hits.length === 1 ? "" : "s"} closest in meaning to your search, best first. This always returns the nearest pages, even when none is a good match, so read each one before relying on it.</p>`
    : `<p class="help">${result.hits.length}${result.truncated ? "+" : ""} page${result.hits.length === 1 ? "" : "s"} in ${cases.length} case${cases.length === 1 ? "" : "s"} contain every word. Open a page to read it in its case.</p>`;
  const nothing = meaning ? '<p class="help">Nothing is ready to search by meaning yet.</p>'
    : '<p class="help">No page in any case contains every word. Search matches whole words in documents and pulled open-data records, ignoring case and accents.</p>';
  $("#search-results").innerHTML = switcher + indexing + (result.hits.length
    ? intro + cases.map(hits => `<section class="search-case"><p class="eyebrow">${escapeHTML(hits[0].project_name)}</p>${hits.map(hit => `<button class="search-hit" data-hit-project="${escapeHTML(hit.project_id)}" data-hit-source="${escapeHTML(hit.evidence_id)}" data-hit-page="${hit.page}"><strong>${escapeHTML(hit.title)} · p.${hit.page}${meaning ? ` <small>similarity ${Number(hit.score).toFixed(2)}</small>` : ""}</strong><span>${meaning ? escapeHTML(hit.snippet) : markWords(hit.snippet, result.query)}</span></button>`).join("")}</section>`).join("") +
      (result.truncated ? '<p class="help">Only the first 40 pages are shown. Add a word to narrow the search.</p>' : "")
    : nothing);
}
async function openHit(button) {
  closeDialog($("#search-dialog"));
  if (current?.id !== button.dataset.hitProject) await selectProject(button.dataset.hitProject);
  if (current?.id === button.dataset.hitProject) openSource(button.dataset.hitSource, Number(button.dataset.hitPage));
}
function openSource(id, pageNumber, snapshot) {
  const sources = snapshot ? current.reports.at(-1).source_catalog : current.evidence;
  const doc = sources.find(d => d.id === id);
  if (!doc) return notify("Source not found.", true);
  $("#source-title").textContent = doc.title;
  $("#source-content").innerHTML = `${snapshot ? '<p class="help">Evidence snapshot saved with this report.</p>' : ""}${doc.source_url ? `<a href="${escapeHTML(doc.source_url)}" target="_blank" rel="noopener noreferrer">Open original source ↗</a>` : '<p class="help">Uploaded by a user; no source link.</p>'}${doc.sha256 ? `<p class="help">SHA-256 <code>${escapeHTML(doc.sha256.slice(0, 16))}…</code></p>` : ""}${doc.pages.map(p => `<section id="page-${p.number}"><p class="eyebrow">PAGE ${p.number}</p><pre class="page-text">${escapeHTML(p.text)}</pre></section>`).join("")}`;
  $("#source-dialog").showModal();
  if (pageNumber) $(`#page-${pageNumber}`)?.scrollIntoView({ block: "nearest" });
}
async function runInvestigation(useAI, depth = "quick") {
  if (busy) return;
  const provider = $("#provider-select")?.value || localStorage.getItem("roadwatch.provider") || null;
  if (provider) localStorage.setItem("roadwatch.provider", provider);
  busy = depth === "deep" ? "deep" : true; tab = "report"; render();
  try { current = await api(`/projects/${current.id}/investigate`, "POST", { use_ai: useAI, provider: useAI ? provider : null, depth }); notify("Report saved. Open each citation to check the source."); refreshConfig(); }
  catch (error) { notify(error.message, true); }
  finally { busy = false; render(); }
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  try {
    if (button.hasAttribute("data-close")) return closeDialog(button.closest("dialog"));
    if (button.dataset.mode) return setEvidenceMode(button.dataset.mode);
    if (button.dataset.caseMode) return setCaseMode(button.dataset.caseMode);
    if (busy) return;
    if (button.dataset.project) return await selectProject(button.dataset.project);
    if (button.dataset.hitProject) return await openHit(button);
    if (button.dataset.searchMode) return await searchCases(lastSearch, button.dataset.searchMode);
    if (button.dataset.tab) { tab = button.dataset.tab; render(); if (tab === "discussion" && discussion) loadDiscussion(true); return; }
    if (button.dataset.source) return openSource(button.dataset.source, Number(button.dataset.page), !!button.dataset.reportSource);
    if (button.dataset.place !== undefined) {
      const place = mapResults[Number(button.dataset.place)];
      return $("#project-dialog").open ? pickNewCaseStreet(place) : await chooseStreet(place);
    }
    if (button.dataset.removeStreet !== undefined) {
      const index = Number(button.dataset.removeStreet);
      if ($("#project-dialog").open) { newCasePlaces.splice(index, 1); drawPlaces(newCasePlaces); renderNewCaseStreets(); return; }
      return await removeStreet(index);
    }
    if (button.dataset.discuss !== undefined) { discussAnchor = { type: button.dataset.discussType || "finding", id: button.dataset.discuss }; tab = "discussion"; render(); return; }
    if (button.dataset.reply) { const c = (discussion?.comments || []).find(x => x.id === button.dataset.reply); discussAnchor = { type: c.anchor_type, id: c.anchor_id, replyTo: c.id }; render(); $("#post-body")?.focus(); return; }
    if (button.dataset.action === "cancel-reply") { discussAnchor = discussAnchor ? { type: discussAnchor.type, id: discussAnchor.id } : null; render(); return; }
    if (button.dataset.action === "post-comment") { button.disabled = true; try { await postComment(); } finally { button.disabled = false; } return; }
    if (button.dataset.deleteComment) { if (!confirm("Delete this post?")) return; await api(`/projects/${current.id}/comments/${button.dataset.deleteComment}`, "DELETE"); return await loadDiscussion(); }
    if (button.dataset.editComment) {
      const c = (discussion?.comments || []).find(x => x.id === button.dataset.editComment);
      const body = prompt("Edit your post:", c.kind === "assessment" ? (c.assessment?.summary || "") : c.body);
      if (body === null) return;
      await api(`/projects/${current.id}/comments/${c.id}`, "PUT", c.kind === "assessment" ? { assessment: { ...c.assessment, summary: body } } : { body });
      return await loadDiscussion();
    }
    if (button.dataset.action === "guest") { await api("/guest", "POST", {}); location.reload(); return; }
    if (button.dataset.action === "team") return await openTeamDialog();
    if (button.dataset.memberToggle) { await api(`/members/${button.dataset.memberToggle}`, "PUT", { active: button.dataset.active !== "1" }); return await openTeamDialog(); }
    if (button.dataset.memberReset) { if (!confirm("Issue a new link? Their current password and sessions stop working immediately.")) return; const m = await api(`/members/${button.dataset.memberReset}`, "PUT", { reset_password: true }); await openTeamDialog(); return showNewKey(m); }
    if (button.dataset.action === "account") { $("#profile-form").name.value = me?.name || ""; $("#account-title").textContent = me?.email ? `${me.name} · ${me.email}` : "Your account"; return $("#account-dialog").showModal(); }
    if (button.dataset.action === "show-signup") return showSignup();
    if (button.dataset.action === "show-login") { closeDialog($("#signup-dialog")); return showLogin(); }
    if (button.dataset.action === "toggle-login-mode") return setLoginMode($("[data-login-mode='key']").hidden);
    if (button.dataset.action === "forgot-password") {
      const email = $("#login-form").email.value.trim(); if (!email) return notify("Enter your email first.", true);
      const answer = await api("/password/forgot", "POST", { email }); return notify(answer.message);
    }
    if (button.dataset.action === "map-search") return await searchStreets("#map-query", "#map-results", caseCity().key);
    if (button.dataset.action === "new-case-search") return await searchStreets("#new-case-query", "#new-case-results", $("#new-case-city").value);
    if (button.dataset.action === "pull-open-data") return await pullOpenData();
    if (button.dataset.action === "save-vendor") return await saveVendor();
    if (button.dataset.delete) {
      if (!confirm("Remove this item? Saved reports keep their snapshot.")) return;
      current = await api(`/projects/${current.id}/${button.dataset.delete}/${button.dataset.id}`, "DELETE"); render(); return;
    }
    const action = button.dataset.action;
    if (action === "new-project") { if (busy) return; $("#project-form").reset(); return openNewCaseDialog(); }
    if (["evidence", "finance", "observation", "setup"].includes(action)) return showDialog(action);
    if (action === "logout") { await api("/logout", "POST", {}); location.reload(); return; }
    if (action === "delete-project") {
      if (!confirm(`Delete the case "${current.name}" and all its documents and reports? This cannot be undone.`)) return;
      await api(`/projects/${current.id}`, "DELETE"); current = null; await refreshList(); render(); notify("Case deleted."); return;
    }
    if (action === "demo") {
      button.disabled = true;
      current = await api("/demo", "POST", {}); tab = "report"; await refreshList(); render();
      return await runInvestigation(false);
    }
    if (action === "checks" || action === "investigate") return await runInvestigation(action === "investigate");
    if (action === "investigate-deep") return await runInvestigation(true, "deep");
    if (action === "location") {
      if (!navigator.geolocation) return notify("Location is not available. Enter coordinates manually.", true);
      navigator.geolocation.getCurrentPosition(position => {
        $("#observation-form [name=latitude]").value = position.coords.latitude;
        $("#observation-form [name=longitude]").value = position.coords.longitude;
      }, () => notify("Location unavailable. Enter coordinates manually.", true), { timeout: 10000 });
    }
  } catch (error) { notify(error.message, true); }
  finally { if (button.isConnected) button.disabled = false; }
});
$("#financial-source").addEventListener("change", () => { $("#financial-page").value = 1; updateSourcePreview(); });
$("#financial-page").addEventListener("input", updateSourcePreview);
for (const dialog of document.querySelectorAll("dialog")) dialog.addEventListener("close", () => document.body.appendChild($("#notice")));
$("#project-dialog").addEventListener("close", () => { if (map && map.getContainer().id === "new-case-map") { map.remove(); map = null; conditionLayer = null; conditionLegend = null; } if (tab === "map" && current) mountMap(); });
$("#new-case-query").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); searchStreets("#new-case-query", "#new-case-results", $("#new-case-city").value).catch(err => notify(err.message, true)); } });
$("#new-case-city").addEventListener("change", e => {
  const city = cityOf(e.target.value); localStorage.setItem("roadwatch.city", city.key);
  if (newCasePlaces.length && newCasePlaces[0].city_key !== city.key) { newCasePlaces = []; renderNewCaseStreets(); notify(`Switched to ${city.name}; the street list was cleared because a case covers one city.`); }
  $("#new-case-results").innerHTML = ""; drawPlaces([]); map?.setView(city.centre, 12); mountCondition(city.key);
});
$("#new-case-condition").addEventListener("change", e => { localStorage.setItem("roadwatch.condition", e.target.checked ? "on" : "off"); mountCondition($("#new-case-city").value); });
$("#login-dialog").addEventListener("cancel", e => e.preventDefault());
$("#invite-dialog").addEventListener("cancel", e => e.preventDefault());
$("#signup-dialog").addEventListener("cancel", e => { e.preventDefault(); closeDialog($("#signup-dialog")); showLogin(); });
async function encodedFile(file) {
  if (file.size > 15_000_000) throw new Error("Maximum file size is 15 MB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}
document.addEventListener("change", async e => { if (e.target.dataset?.memberRole) { try { await api(`/members/${e.target.dataset.memberRole}`, "PUT", { role: e.target.value }); notify("Role updated."); } catch (err) { notify(err.message, true); } } });
$("#member-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target, data = Object.fromEntries(new FormData(form));
  try { const m = await api("/members", "POST", data); form.reset(); await openTeamDialog(); showNewKey(m); } catch (err) { notify(err.message, true); }
});
$("#profile-form").addEventListener("submit", async e => {
  e.preventDefault();
  try { me = await api("/me", "PUT", { name: e.target.name.value }); showUser(); notify("Name saved."); } catch (err) { notify(err.message, true); }
});
$("#password-form").addEventListener("submit", async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try { await api("/me/password", "PUT", data); e.target.reset(); closeDialog($("#account-dialog")); notify("Password changed. Other devices were signed out."); } catch (err) { notify(err.message, true); }
});
$("#signup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const form = e.target, data = Object.fromEntries(new FormData(form));
  try {
    const result = await api("/signup", "POST", { name: data.name, email: data.email, password: data.password, accept_rules: data.accept_rules === "on" });
    if (result.pending_verification) { closeDialog($("#signup-dialog")); render(); $("#workspace").innerHTML = empty("Check your email", result.message + " Then come back and sign in."); return; }
    me = result.user; showUser(); closeDialog($("#signup-dialog")); await boot(); notify(`Welcome, ${me.name}.`);
  } catch (err) { notify(err.message, true); }
});
$("#invite-form").addEventListener("submit", async e => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  if (data.password !== data.password2) return notify("The two passwords differ.", true);
  const code = location.hash.replace(/^#invite=/, "");
  try { const result = await api("/invite/accept", "POST", { code, password: data.password }); me = result.user; showUser(); history.replaceState(null, "", location.pathname); closeDialog($("#invite-dialog")); await boot(); notify(`Welcome, ${me.name}.`); }
  catch (err) { notify(err.message, true); }
});
async function handleInviteLink() {
  if (location.hash.startsWith("#verify=")) {
    try { const result = await api(`/verify/${encodeURIComponent(location.hash.slice(8))}`); me = result.user; showUser(); history.replaceState(null, "", location.pathname); await boot(); notify(`Email confirmed. Welcome, ${me.name}.`); return true; }
    catch (err) { notify(err.message, true); history.replaceState(null, "", location.pathname); return false; }
  }
  const code = location.hash.startsWith("#invite=") ? location.hash.slice(8) : "";
  if (!code) return false;
  try {
    const who = await api(`/invite/${encodeURIComponent(code)}`);
    $("#invite-title").textContent = who.reset ? `Set a new password, ${who.name}` : `Welcome, ${who.name}`;
    $("#invite-help").textContent = `${who.email} · ${who.role}. ${who.reset ? "Your old password no longer works." : "Choose the password you will sign in with."}`;
    render(); $("#invite-dialog").showModal(); return true;
  } catch (err) { notify(err.message, true); history.replaceState(null, "", location.pathname); return false; }
}
$("#case-search").addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = event.target.q.value.trim();
  if (query.length < 2) return;
  await searchCases(query);
});
$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target, submit = form.querySelector("[type=submit]");
  submit.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const payload = $("[data-login-mode='key']").hidden ? { email: data.email, password: data.password } : { access_key: data.access_key.trim() };
    const result = await api("/login", "POST", payload); me = result.user; showUser(); closeDialog($("#login-dialog")); await boot();
  }
  catch (error) { notify(error.message, true); }
  finally { submit.disabled = false; }
});
for (const name of ["project", "evidence", "finance", "observation"]) {
  $(`#${name}-form`).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target, submit = form.querySelector("[type=submit]");
    if (submit.disabled) return;
    submit.disabled = true;
    const label = submit.textContent;
    try {
      const data = Object.fromEntries(new FormData(form));
      if (name === "project" && caseMode === "vendor") {
        const company = (data.vendor_name || "").trim();
        if (!company) throw new Error("Enter the company's name.");
        const payload = { name: (data.vendor_case_name || "").trim() || `${company} across governments`, road: "", contractor: company, anchor: "vendor",
                          vendor_aliases: (data.vendor_aliases || "").split(",").map(s => s.trim()).filter(Boolean), province: data.vendor_province || "", locations: [] };
        current = await api("/projects", "POST", payload); tab = "vendor"; await refreshList();
        closeDialog(form.closest("dialog")); render();
        newCaseSince = Number(data.vendor_since || 2000);
        await pullOpenData();
        return notify(`Case created. ${current.open_data.length} open-data sets stored — run the investigation when ready.`);
      } else if (name === "project") {
        data.completed_on ||= null;
        const pull = !!data.pull_open_data && newCasePlaces.length > 0;
        delete data.pull_open_data;
        data.show_condition = !!data.show_condition;
        data.locations = newCasePlaces.map(placePayload);
        current = await api("/projects", "POST", data); tab = newCasePlaces.length ? "map" : "evidence"; await refreshList();
        if (pull) {
          closeDialog(form.closest("dialog")); render();
          await pullOpenData();
          return notify(`Case created. ${current.open_data.length} open-data sets stored — run the investigation when ready.`);
        }
      } else if (name === "evidence") {
        if (evidenceMode === "import") {
          if (!data.url) throw new Error("Paste the link to the document.");
          submit.textContent = "Fetching…";
          current = await api(`/projects/${current.id}/evidence/import`, "POST", { url: data.url, title: data.title, kind: data.kind });
        } else {
          const payload = { title: data.title || "Untitled document", kind: data.kind, text: "", filename: "", file_base64: "", source_url: null };
          if (evidenceMode === "upload") {
            const file = $("#evidence-file").files[0];
            if (!file) throw new Error("Choose a file to upload.");
            payload.filename = file.name; payload.file_base64 = await encodedFile(file); payload.source_url = data.source_url || null;
            if (!data.title) payload.title = file.name.replace(/\.[^.]+$/, "");
          } else {
            if (!data.text.trim()) throw new Error("Paste the document text.");
            payload.text = data.text; payload.source_url = data.paste_source_url || null;
          }
          current = await api(`/projects/${current.id}/evidence`, "POST", payload);
        }
        tab = "evidence";
      } else {
        const collection = { finance: "finances", observation: "observations" }[name];
        current = await api(`/projects/${current.id}/${collection}`, "POST", data);
        tab = collection;
      }
      closeDialog(form.closest("dialog")); render(); notify("Saved.");
    } catch (error) { notify(error.message, true); }
    finally { submit.disabled = false; submit.textContent = label; }
  });
}
async function boot() {
  await refreshConfig();
  cities = await api("/cities");
  provinces = await api("/provinces").catch(() => []);
  await refreshList();
  if (projects.length) await selectProject(projects[0].id); else render();
}
function showUser() {
  $("#whoami").textContent = isGuest() ? "Working as a guest" : me ? `Signed in as ${me.name} · ${me.role}` : "";
  $("#logout-button").textContent = isGuest() ? "Sign in" : "Sign out";
  $("#team-button").hidden = !(me && me.role === "admin");
  $("#account-button").hidden = !(me && !["admin", "local"].includes(me.id));
}
async function init() {
  try {
    const session = await api("/session"); sessionInfo = session;
    $("#logout-button").hidden = !session.auth_required;
    me = session.user; showUser();
    if (session.auth_required && await handleInviteLink()) return;
    if (session.auth_required && !session.signed_in) { render(); return showLogin(); }
    await boot();
  } catch (error) { notify(error.message, true); $("#workspace").innerHTML = empty("Could not load", "Check that the server is running and reload."); }
}
init();
