const $ = (selector) => document.querySelector(selector);

const state = {
  summary: null,
  runs: [],
  selectedRunId: "",
  filter: "all",
  eventCount: 0,
};

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function totalCount(rows = []) {
  return rows.reduce((total, row) => total + Number(row.count || 0), 0);
}

function shortText(value, max = 36) {
  const text = String(value || "-");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function statusClass(status) {
  return ["done", "failed", "running"].includes(status) ? status : "neutral";
}

function statusLabel(status) {
  const labels = {
    all: "全部",
    done: "完成",
    failed: "失败",
    running: "运行中",
  };
  return labels[status] || status || "-";
}

function chip(label, value, className = "neutral") {
  const text = value === undefined ? label : `${label}: ${value}`;
  return `<span class="chip ${className}" title="${escapeHtml(text)}"><span>${escapeHtml(shortText(text, 28))}</span></span>`;
}

function metric({ label, value, note = "", chips = [] }) {
  return `
    <article class="metric">
      <div class="metric-top">
        <div>
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
        </div>
      </div>
      ${note ? `<div class="metric-note">${escapeHtml(note)}</div>` : ""}
      ${chips.length ? `<div class="metric-chips">${chips.join("")}</div>` : ""}
    </article>
  `;
}

function resourceChips(rows = []) {
  if (!rows.length) return [chip("空", undefined, "neutral")];
  return rows.map((row) => chip(row.status || "-", row.count || 0, statusClass(row.status)));
}

function countRunsByStatus(status) {
  return state.runs.filter((run) => run.status === status).length;
}

function renderSummary(data = {}) {
  const runHistory = data.runHistory || [];
  const runFailed = runHistory.find((row) => row.status === "failed")?.count ?? countRunsByStatus("failed");
  const runDone = runHistory.find((row) => row.status === "done")?.count ?? countRunsByStatus("done");
  $("#summary").innerHTML = [
    metric({
      label: "Plus Accounts",
      value: data.plusAccounts || 0,
      note: "已落库账号",
    }),
    metric({
      label: "Recent Running",
      value: countRunsByStatus("running"),
      note: "当前列表中的运行账号",
    }),
    metric({
      label: "Run Done",
      value: runDone || 0,
      note: "历史完成",
    }),
    metric({
      label: "Run Failed",
      value: runFailed || 0,
      note: "历史失败",
    }),
    metric({
      label: "Run Events",
      value: data.runEvents || 0,
      note: "已记录事件",
    }),
  ].join("");
}

function renderResources(data = {}) {
  const groups = [
    ["Outlook", data.outlookEmails || []],
    ["PayPal Phone", data.paypalPhones || []],
    ["OpenAI SMS", data.openaiPhoneActivations || []],
    ["Run History", data.runHistory || []],
  ];
  $("#resources").innerHTML = groups.map(([name, rows]) => `
    <article class="resource-card">
      <div class="resource-head">
        <div class="resource-name">${escapeHtml(name)}</div>
        <div class="resource-total">${escapeHtml(totalCount(rows))}</div>
      </div>
      <div class="resource-tags">${resourceChips(rows).join("")}</div>
    </article>
  `).join("");
}

function renderRuns(runs = []) {
  const visibleRuns = state.filter === "all" ? runs : runs.filter((run) => run.status === state.filter);
  if (!visibleRuns.length) {
    $("#runs").innerHTML = `<div class="empty-state">当前筛选条件下没有账号运行记录。</div>`;
    renderDetail();
    return;
  }
  if (!state.selectedRunId || !runs.some((run) => run.runId === state.selectedRunId)) {
    state.selectedRunId = visibleRuns[0]?.runId || runs[0]?.runId || "";
  }
  $("#runs").innerHTML = visibleRuns.map((run) => {
    const selected = run.runId === state.selectedRunId ? "selected" : "";
    const status = statusClass(run.status);
    return `
      <article class="run-card ${status} ${selected}">
        <button class="run-button" type="button" data-run-id="${escapeHtml(run.runId)}" title="查看 ${escapeHtml(run.email || run.runId)}">
          <div class="run-head">
            <div class="run-title">
              <div class="email">${escapeHtml(run.email || "(no email)")}</div>
              <div class="run-id">${escapeHtml(run.runId || "-")}</div>
            </div>
            <span class="status ${status}">${escapeHtml(statusLabel(run.status))}</span>
          </div>
          <div class="run-tags">
            ${chip("worker", run.workerId || "-", "neutral")}
            ${chip("IP", run.roxyExitIp || "-", run.roxyExitIp ? "running" : "neutral")}
            ${chip("CPA", run.cpaUploadStatus || "-", run.cpaUploadStatus === "done" ? "done" : "neutral")}
          </div>
          <div class="run-flow" aria-label="流程摘要">
            ${flowNode("Step", run.currentStep || "-")}
            ${flowNode("Window", run.roxyDirId || "-")}
            ${flowNode("Identity", [run.accountIdentifierType, run.accountIdentifier].filter(Boolean).join(" ") || "-")}
            ${flowNode("Updated", formatTime(run.updatedAt))}
          </div>
          ${run.error ? `<div class="run-alert">${escapeHtml(shortText(run.error, 120))}</div>` : ""}
        </button>
      </article>
    `;
  }).join("");

  document.querySelectorAll("[data-run-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedRunId = button.dataset.runId || "";
      renderRuns(state.runs);
      renderDetail();
    });
  });
  renderDetail();
}

function flowNode(label, value) {
  return `
    <div class="flow-node" title="${escapeHtml(value || "-")}">
      <div class="flow-label">${escapeHtml(label)}</div>
      <div class="flow-value">${escapeHtml(shortText(value || "-", 22))}</div>
    </div>
  `;
}

function detailRow(label, value, { code = false } = {}) {
  const text = value || "-";
  return `
    <div class="detail-row">
      <dt>${escapeHtml(label)}</dt>
      <dd>${code ? `<code>${escapeHtml(text)}</code>` : escapeHtml(text)}</dd>
    </div>
  `;
}

function renderDetail() {
  const run = state.runs.find((item) => item.runId === state.selectedRunId);
  const statusEl = $("#detail-status");
  if (!run) {
    statusEl.textContent = "未选择";
    statusEl.className = "status neutral";
    $("#run-detail").className = "detail-empty";
    $("#run-detail").innerHTML = "选择左侧账号后查看完整 runId、路径、错误和回调信息。";
    return;
  }
  statusEl.textContent = statusLabel(run.status);
  statusEl.className = `status ${statusClass(run.status)}`;
  $("#run-detail").className = "";
  $("#run-detail").innerHTML = `
    <dl class="detail-grid">
      ${detailRow("Email", run.email)}
      ${detailRow("Run ID", run.runId, { code: true })}
      ${detailRow("Worker / Window", `${run.workerId || "-"} / ${run.roxyDirId || "-"}`, { code: true })}
      ${detailRow("Roxy Exit IP", run.roxyExitIp)}
      ${detailRow("Current Step", run.currentStep)}
      ${detailRow("Account Identity", [run.accountIdentifierType, run.accountIdentifier].filter(Boolean).join(" ") || "-")}
      ${detailRow("CPA Upload", run.cpaUploadStatus)}
      ${detailRow("Callback JSON", run.callbackJsonPath, { code: true })}
      ${detailRow("Artifact Dir", run.artifactDir, { code: true })}
      ${detailRow("Started", formatTime(run.startedAt))}
      ${detailRow("Finished", formatTime(run.finishedAt))}
      ${detailRow("Updated", formatTime(run.updatedAt))}
      ${run.error ? detailRow("Error", run.error, { code: true }) : ""}
    </dl>
  `;
}

function addEvent(row) {
  const wrap = $("#events");
  const empty = wrap.querySelector(".empty-state");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `event ${row.level === "error" ? "error" : ""}`;
  div.innerHTML = `
    <div class="event-meta">${escapeHtml(formatTime(row.createdAt))} [${escapeHtml(row.level || "-")}] ${escapeHtml(row.workerId || "-")} ${escapeHtml(row.step || "-")} ${escapeHtml(row.eventType || "-")}</div>
    <div class="message">${escapeHtml(row.message || "")}</div>
  `;
  wrap.prepend(div);
  state.eventCount += 1;
  $("#event-count").textContent = state.eventCount;
  while (wrap.children.length > 200) wrap.lastElementChild?.remove();
}

async function refresh() {
  try {
    $("#sync-dot").className = "sync-dot";
    $("#last-updated").textContent = "刷新中";
    const [summary, runs] = await Promise.all([
      getJson("/api/summary"),
      getJson("/api/runs?limit=80"),
    ]);
    state.summary = summary;
    state.runs = runs.runs || [];
    renderSummary(summary);
    renderResources(summary);
    renderFilterCounts();
    renderRuns(state.runs);
    $("#sync-dot").className = "sync-dot ok";
    $("#last-updated").textContent = `已刷新 ${formatTime(new Date().toISOString())}`;
  } catch (error) {
    $("#sync-dot").className = "sync-dot error";
    $("#last-updated").textContent = "刷新失败";
    addEvent({
      level: "error",
      createdAt: new Date().toISOString(),
      eventType: "ui_refresh_failed",
      message: error.message,
    });
  }
}

function renderFilterCounts() {
  document.querySelectorAll(".filter").forEach((button) => {
    const filter = button.dataset.filter || "all";
    const count = filter === "all" ? state.runs.length : countRunsByStatus(filter);
    button.textContent = `${statusLabel(filter)} ${count}`;
    button.classList.toggle("active", state.filter === filter);
  });
}

$("#refresh").addEventListener("click", refresh);
$("#filters").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  state.filter = button.dataset.filter || "all";
  renderFilterCounts();
  renderRuns(state.runs);
});

refresh();
setInterval(refresh, 5000);

const stream = new EventSource("/api/events/stream");
stream.addEventListener("run_event", (event) => {
  addEvent(JSON.parse(event.data));
});
stream.addEventListener("error", () => {
  $("#sync-dot").className = "sync-dot error";
});
