const $ = (selector) => document.querySelector(selector);

const state = {
  summary: null,
  runs: [],
  selectedRunId: "",
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

function countBy(rows = [], key, value) {
  return rows
    .filter((row) => String(row[key] || "") === value)
    .reduce((total, row) => total + Number(row.count || 0), 0);
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
  return ["done", "failed", "running", "available", "active", "new"].includes(status) ? status : "neutral";
}

function statusLabel(status) {
  const labels = {
    active: "可用",
    available: "可租",
    bound: "已绑定",
    cpa_done: "CPA 完成",
    disabled: "禁用",
    done: "完成",
    email_bound: "邮箱已绑",
    failed: "失败",
    finished: "完成",
    hold_no_sms_access: "无短信权限",
    leased: "租用中",
    new: "可用",
    plus_done: "Plus 完成",
    registered: "已注册",
    requested: "已请求",
    running: "运行中",
    signup_pending: "注册中",
  };
  return labels[status] || status || "-";
}

function chip(label, value, className = "neutral") {
  const text = value === undefined ? label : `${label}: ${value}`;
  return `<span class="chip ${className}" title="${escapeHtml(text)}"><span>${escapeHtml(shortText(text, 30))}</span></span>`;
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

function resourceChipText(row = {}) {
  if (row.lifecycle_status) {
    return row.lease_status
      ? `${statusLabel(row.lifecycle_status)}/${statusLabel(row.lease_status)}`
      : statusLabel(row.lifecycle_status);
  }
  return statusLabel(row.status || "-");
}

function resourceChipClass(row = {}) {
  return statusClass(row.lease_status || row.status || row.lifecycle_status || "");
}

function resourceChips(rows = []) {
  if (!rows.length) return [chip("空", undefined, "neutral")];
  return rows.map((row) => chip(resourceChipText(row), row.count || 0, resourceChipClass(row)));
}

function accountIdentity(run = {}) {
  return [run.accountIdentifierType, run.accountIdentifier].filter(Boolean).join(" ");
}

function renderSummary(data = {}) {
  const gptRows = data.gptPhoneAccounts || [];
  const outlookRows = data.outlookEmails || [];
  const paypalRows = data.paypalPhones || [];
  const gptAvailable = gptRows
    .filter((row) => ["registered", "plus_done", "email_bound"].includes(String(row.lifecycle_status || "")))
    .filter((row) => String(row.lease_status || "") === "available")
    .reduce((total, row) => total + Number(row.count || 0), 0);
  const gptPlusAccounts = gptRows
    .filter((row) => ["plus_done", "email_bound", "cpa_done"].includes(String(row.lifecycle_status || "")))
    .reduce((total, row) => total + Number(row.count || 0), 0);
  $("#summary").innerHTML = [
    metric({
      label: "Running Accounts",
      value: state.runs.length,
      note: "当前正在执行的 run",
    }),
    metric({
      label: "GPT Phone Accounts",
      value: totalCount(gptRows),
      note: `可继续账号 ${gptAvailable}`,
    }),
    metric({
      label: "Outlook Available",
      value: countBy(outlookRows, "status", "new"),
      note: "可租辅助邮箱",
    }),
    metric({
      label: "PayPal Phone Active",
      value: countBy(paypalRows, "status", "active"),
      note: "可用日区手机号",
    }),
    metric({
      label: "Plus Accounts",
      value: gptPlusAccounts,
      note: "GPT 手机号池已 Plus",
    }),
  ].join("");
}

function renderResources(data = {}) {
  const groups = [
    ["Outlook", data.outlookEmails || []],
    ["GPT Phone Accounts", data.gptPhoneAccounts || []],
    ["PayPal Phone", data.paypalPhones || []],
    ["OpenAI SMS", data.openaiPhoneActivations || []],
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
  if (!runs.length) {
    state.selectedRunId = "";
    $("#runs").innerHTML = `<div class="empty-state">当前没有正在运行的账号。启动 runner 后，这里会自动出现 live run。</div>`;
    renderDetail();
    return;
  }
  if (!state.selectedRunId || !runs.some((run) => run.runId === state.selectedRunId)) {
    state.selectedRunId = runs[0]?.runId || "";
  }
  $("#runs").innerHTML = runs.map((run) => {
    const selected = run.runId === state.selectedRunId ? "selected" : "";
    const status = statusClass(run.status);
    const identity = accountIdentity(run);
    return `
      <article class="run-card ${status} ${selected}">
        <button class="run-button" type="button" data-run-id="${escapeHtml(run.runId)}" title="查看 ${escapeHtml(identity || run.email || run.runId)}">
          <div class="run-head">
            <div class="run-title">
              <div class="email">${escapeHtml(run.email || identity || "(running account)")}</div>
              <div class="run-id">${escapeHtml(run.runId || "-")}</div>
            </div>
            <span class="status ${status}">${escapeHtml(statusLabel(run.status))}</span>
          </div>
          <div class="run-tags">
            ${chip("worker", run.workerId || "-", "neutral")}
            ${chip("GPT", run.gptPhoneAccountId || "-", run.gptPhoneAccountId ? "running" : "neutral")}
            ${chip("IP", run.roxyExitIp || "-", run.roxyExitIp ? "running" : "neutral")}
            ${chip("CPA", run.cpaUploadStatus || "-", run.cpaUploadStatus === "done" ? "done" : "neutral")}
          </div>
          <div class="run-flow" aria-label="流程摘要">
            ${flowNode("Step", run.currentStep || "-")}
            ${flowNode("Lifecycle", statusLabel(run.accountLifecycleStatus || "-"))}
            ${flowNode("Window", run.roxyDirId || "-")}
            ${flowNode("Updated", formatTime(run.updatedAt))}
          </div>
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
    $("#run-detail").innerHTML = "当前没有可查看的运行账号。";
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
      ${detailRow("Account Identity", accountIdentity(run) || "-")}
      ${detailRow("GPT Account ID", run.gptPhoneAccountId)}
      ${detailRow("Lifecycle", statusLabel(run.accountLifecycleStatus))}
      ${detailRow("OpenAI Activation ID", run.openAiPhoneActivationId)}
      ${detailRow("PayPal Phone ID", run.paypalPhoneId)}
      ${detailRow("CPA Upload", run.cpaUploadStatus)}
      ${detailRow("Callback JSON", run.callbackJsonPath, { code: true })}
      ${detailRow("Started", formatTime(run.startedAt))}
      ${detailRow("Updated", formatTime(run.updatedAt))}
    </dl>
  `;
}

async function refresh() {
  try {
    $("#sync-dot").className = "sync-dot";
    $("#last-updated").textContent = "刷新中";
    const [summary, runs] = await Promise.all([
      getJson("/api/summary"),
      getJson("/api/runs?status=running&activeOnly=1&limit=100"),
    ]);
    state.summary = summary;
    state.runs = runs.runs || [];
    renderSummary(summary);
    renderResources(summary);
    renderRuns(state.runs);
    $("#sync-dot").className = "sync-dot ok";
    $("#last-updated").textContent = `已刷新 ${formatTime(new Date().toISOString())}`;
  } catch (error) {
    $("#sync-dot").className = "sync-dot error";
    $("#last-updated").textContent = `刷新失败：${error.message}`;
  }
}

$("#refresh").addEventListener("click", refresh);

refresh();
setInterval(refresh, 3000);
