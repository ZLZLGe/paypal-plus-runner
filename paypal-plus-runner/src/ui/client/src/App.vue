<script setup>
import { computed, h, onMounted, onUnmounted, ref, watch } from "vue";
import {
  NButton,
  NCode,
  NIcon,
  NTag,
} from "naive-ui";
import {
  Activity,
  CreditCard,
  ExternalLink,
  FileText,
  Layers,
  ListChecks,
  PhoneCall,
  Play,
  RefreshCw,
  Square,
  UploadCloud,
} from "@lucide/vue";

const modes = [
  {
    key: "register-link",
    label: "注册并生成长链接",
    icon: PhoneCall,
    title: "注册并生成长链接",
    targetLabel: "可生成链接账号",
    action: "启动 register-link",
  },
  {
    key: "pay-link",
    label: "长链接支付",
    icon: CreditCard,
    title: "长链接支付",
    targetLabel: "待支付长链接",
    action: "启动 pay-link",
  },
  {
    key: "cpa-upload",
    label: "CPA 上传",
    icon: UploadCloud,
    title: "CPA 上传",
    targetLabel: "可上传账号",
    action: "启动 cpa-upload",
  },
  {
    key: "full",
    label: "完整流程",
    icon: Layers,
    title: "完整流程",
    targetLabel: "一体化任务",
    action: "启动 full",
  },
  {
    key: "logs",
    label: "运行日志",
    icon: FileText,
    title: "运行日志",
    targetLabel: "Run events",
    action: "",
  },
];

const statusMeta = {
  ready: { label: "ready", type: "info", className: "status-ready" },
  paying: { label: "paying", type: "warning", className: "status-running" },
  running: { label: "running", type: "warning", className: "status-running" },
  paid: { label: "paid", type: "success", className: "status-paid" },
  plus_done: { label: "plus_done", type: "success", className: "status-paid" },
  email_bound: { label: "email_bound", type: "success", className: "status-paid" },
  cpa_done: { label: "cpa_done", type: "success", className: "status-cpa" },
  expired: { label: "expired", type: "default", className: "status-expired" },
  failed: { label: "failed", type: "error", className: "status-failed" },
  done: { label: "done", type: "success", className: "status-cpa" },
  stopped: { label: "stopped", type: "default", className: "status-expired" },
  registered: { label: "registered", type: "info", className: "status-ready" },
  available: { label: "available", type: "info", className: "status-ready" },
  leased: { label: "leased", type: "warning", className: "status-running" },
};

const activeTab = ref("register-link");
const loading = ref(false);
const starting = ref("");
const stoppingTaskId = ref("");
const lastError = ref("");
const lastUpdated = ref("");
const taskDrawerOpen = ref(false);
const selectedTask = ref(null);
const selectedRunId = ref("");
const selectedRegisterAccountIds = ref([]);
const selectedCpaAccountIds = ref([]);
const selectedCheckoutLinkIds = ref([]);
const limit = ref(1);
const windows = ref(1);
const headlessMode = ref(false);
const settingsLoaded = ref(false);
let applyingRemoteSettings = false;
const summary = ref({});
const accounts = ref([]);
const registerAccounts = ref([]);
const cpaAccounts = ref([]);
const checkoutLinks = ref([]);
const tasks = ref([]);
const runs = ref([]);
const activeRuns = ref([]);
const events = ref([]);
let refreshTimer = null;

function normalizeStatus(value = "") {
  return String(value || "").trim().toLowerCase() || "unknown";
}

function statusInfo(value = "") {
  const normalized = normalizeStatus(value);
  return statusMeta[normalized] || { label: normalized || "-", type: "default", className: "status-neutral" };
}

function renderStatus(value) {
  const info = statusInfo(value);
  return h(NTag, {
    round: true,
    size: "small",
    type: info.type,
    class: ["status-tag", info.className],
  }, { default: () => info.label });
}

function renderText(value, empty = "-") {
  const text = String(value ?? "").trim();
  return text || empty;
}

function formatTime(value = "") {
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

function icon(iconComponent) {
  return () => h(NIcon, { size: 16 }, { default: () => h(iconComponent) });
}

async function getJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || `${url} failed: ${response.status}`);
  }
  return body;
}

async function postJson(url, body = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `${url} failed: ${response.status}`);
  }
  return payload;
}

async function refreshSettings() {
  const result = await getJson("/api/plus/settings");
  applyingRemoteSettings = true;
  headlessMode.value = result.settings?.headless === true;
  settingsLoaded.value = true;
  applyingRemoteSettings = false;
}

async function saveSettings({ force = false } = {}) {
  if ((!settingsLoaded.value && !force) || applyingRemoteSettings) return;
  await postJson("/api/plus/settings", {
    headless: headlessMode.value === true,
  });
  settingsLoaded.value = true;
}

function countRows(rows = []) {
  return rows.reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function countStatus(rows = [], status) {
  return rows
    .filter((row) => String(row.status || row.lifecycle_status || "") === status)
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
}

const metrics = computed(() => {
  const gptRows = summary.value.gptPhoneAccounts || [];
  return [
    { label: "注册账号", value: countStatus(gptRows, "registered"), status: "ready" },
    { label: "待支付链接", value: checkoutLinks.value.filter((item) => item.status === "ready").length, status: "ready" },
    { label: "Plus 成功", value: countStatus(gptRows, "plus_done") + countStatus(gptRows, "email_bound"), status: "paid" },
    { label: "CPA 完成", value: countStatus(gptRows, "cpa_done"), status: "cpa_done" },
    { label: "运行中", value: activeRuns.value.length, status: "running" },
  ];
});

const currentMode = computed(() => modes.find((item) => item.key === activeTab.value) || modes[0]);

const latestTask = computed(() => tasks.value[0] || null);

const selectedRun = computed(() => runs.value.find((run) => run.runId === selectedRunId.value) || runs.value[0] || null);

const taskRunIds = computed(() => {
  const ids = new Set();
  for (const task of tasks.value) {
    for (const runId of task.runIds || []) ids.add(runId);
  }
  return ids;
});

const relevantRuns = computed(() => {
  if (!taskRunIds.value.size) return runs.value;
  const active = runs.value.filter((run) => taskRunIds.value.has(run.runId));
  return active.length ? active : runs.value;
});

const taskColumns = [
  { title: "任务", key: "taskId", width: 150, ellipsis: { tooltip: true } },
  { title: "模式", key: "mode", width: 96, ellipsis: { tooltip: true }, render: (row) => renderText(row.mode) },
  { title: "状态", key: "status", width: 90, render: (row) => renderStatus(row.status) },
];

const accountColumns = [
  { type: "selection", width: 44 },
  { title: "ID", key: "id", width: 74 },
  { title: "手机号", key: "signupPhoneNumber", minWidth: 140, render: (row) => renderText(row.signupPhoneNumber) },
  { title: "生命周期", key: "lifecycleStatus", width: 130, render: (row) => renderStatus(row.lifecycleStatus) },
  { title: "租用", key: "leaseStatus", width: 100, render: (row) => renderStatus(row.leaseStatus) },
  { title: "邮箱", key: "boundEmail", minWidth: 170, render: (row) => renderText(row.boundEmail) },
  { title: "CPA", key: "cpaUploadStatus", width: 110, render: (row) => renderStatus(row.cpaUploadStatus || "-") },
  { title: "长链接", key: "latestCheckoutLinkStatus", width: 120, render: (row) => renderStatus(row.latestCheckoutLinkStatus || "-") },
  { title: "更新", key: "updatedAt", width: 140, render: (row) => formatTime(row.updatedAt) },
  { title: "错误", key: "lastError", minWidth: 180, ellipsis: { tooltip: true }, render: (row) => renderText(row.lastError) },
];

const linkColumns = [
  { type: "selection", width: 44 },
  { title: "ID", key: "id", width: 74 },
  { title: "账号", key: "gptPhoneAccountId", width: 92 },
  { title: "手机号", key: "signupPhoneNumber", minWidth: 140, render: (row) => renderText(row.signupPhoneNumber) },
  { title: "状态", key: "status", width: 110, render: (row) => renderStatus(row.status) },
  { title: "链接", key: "linkPreview", minWidth: 270, ellipsis: { tooltip: true }, render: (row) => renderText(row.linkPreview) },
  { title: "Run", key: "runId", minWidth: 150, ellipsis: { tooltip: true }, render: (row) => renderText(row.runId) },
  { title: "支付时间", key: "paidAt", width: 140, render: (row) => formatTime(row.paidAt) },
  { title: "更新", key: "updatedAt", width: 140, render: (row) => formatTime(row.updatedAt) },
  { title: "错误", key: "lastError", minWidth: 180, ellipsis: { tooltip: true }, render: (row) => renderText(row.lastError) },
];

const runColumns = [
  { title: "Run ID", key: "runId", minWidth: 190, ellipsis: { tooltip: true } },
  { title: "状态", key: "status", width: 100, render: (row) => renderStatus(row.status) },
  { title: "当前步骤", key: "currentStep", minWidth: 180, ellipsis: { tooltip: true }, render: (row) => renderText(row.currentStep) },
  { title: "账号", key: "gptPhoneAccountId", width: 90, render: (row) => renderText(row.gptPhoneAccountId) },
  { title: "生命周期", key: "accountLifecycleStatus", width: 130, render: (row) => renderStatus(row.accountLifecycleStatus || "-") },
  { title: "CPA", key: "cpaUploadStatus", width: 100, render: (row) => renderStatus(row.cpaUploadStatus || "-") },
  { title: "Artifact", key: "artifactDir", minWidth: 190, ellipsis: { tooltip: true }, render: (row) => renderText(row.artifactDir) },
  { title: "更新", key: "updatedAt", width: 140, render: (row) => formatTime(row.updatedAt) },
  {
    title: "操作",
    key: "actions",
    width: 100,
    render: (row) => h(NButton, {
      size: "small",
      secondary: true,
      onClick: () => selectRun(row.runId),
    }, { icon: icon(Activity), default: () => "事件" }),
  },
];

async function refreshAll({ silent = false } = {}) {
  if (!silent) loading.value = true;
  lastError.value = "";
  try {
    const [
      summaryResult,
      allAccounts,
      registerResult,
      cpaResult,
      linksResult,
      tasksResult,
      runsResult,
      activeRunsResult,
    ] = await Promise.all([
      getJson("/api/summary"),
      getJson("/api/plus/accounts?limit=300"),
      getJson("/api/plus/accounts?stage=register-link&limit=300"),
      getJson("/api/plus/accounts?stage=cpa-upload&limit=300"),
      getJson("/api/plus/checkout-links?limit=300"),
      getJson("/api/plus/tasks"),
      getJson("/api/runs?limit=120"),
      getJson("/api/runs?status=running&activeOnly=1&limit=120"),
    ]);
    summary.value = summaryResult;
    accounts.value = allAccounts.accounts || [];
    registerAccounts.value = registerResult.accounts || [];
    cpaAccounts.value = cpaResult.accounts || [];
    checkoutLinks.value = linksResult.links || [];
    tasks.value = tasksResult.tasks || [];
    runs.value = runsResult.runs || [];
    activeRuns.value = activeRunsResult.runs || [];
    if (!selectedRunId.value && runs.value[0]) selectedRunId.value = runs.value[0].runId;
    if (selectedRunId.value) await refreshEvents(selectedRunId.value);
    lastUpdated.value = new Date().toISOString();
  } catch (error) {
    lastError.value = error.message;
  } finally {
    loading.value = false;
  }
}

async function refreshEvents(runId = "") {
  if (!runId) {
    events.value = [];
    return;
  }
  const result = await getJson(`/api/runs/${encodeURIComponent(runId)}/events?limit=200`);
  events.value = result.events || [];
}

function selectedIdsForMode(mode) {
  if (mode === "pay-link") return selectedCheckoutLinkIds.value;
  if (mode === "register-link") return selectedRegisterAccountIds.value;
  if (mode === "cpa-upload") return selectedCpaAccountIds.value;
  return [];
}

async function startMode(mode, options = {}) {
  const forceNewPhone = options.forceNewPhone === true;
  const startKey = forceNewPhone ? `${mode}:new-phone` : mode;
  starting.value = startKey;
  lastError.value = "";
  try {
    await saveSettings({ force: true });
    const payload = {
      mode,
      ids: forceNewPhone ? [] : selectedIdsForMode(mode),
      limit: Number(limit.value || 1),
      windows: Number(windows.value || 1),
      forceNewPhone,
      headless: headlessMode.value === true,
    };
    const result = await postJson("/api/plus/tasks", payload);
    selectedTask.value = result.task;
    taskDrawerOpen.value = true;
    await refreshAll({ silent: true });
  } catch (error) {
    lastError.value = error.message;
  } finally {
    starting.value = "";
  }
}

async function stopTask(taskId) {
  stoppingTaskId.value = taskId;
  lastError.value = "";
  try {
    await postJson(`/api/plus/tasks/${encodeURIComponent(taskId)}/stop`);
    await refreshAll({ silent: true });
  } catch (error) {
    lastError.value = error.message;
  } finally {
    stoppingTaskId.value = "";
  }
}

function openTask(task) {
  selectedTask.value = task;
  if ((task.runIds || [])[0]) {
    selectedRunId.value = task.runIds[0];
    refreshEvents(selectedRunId.value).catch((error) => {
      lastError.value = error.message;
    });
  }
  taskDrawerOpen.value = true;
}

function taskRowProps(row) {
  return {
    class: "task-row",
    onClick: () => openTask(row),
  };
}

function selectRun(runId) {
  selectedRunId.value = runId;
  refreshEvents(runId).catch((error) => {
    lastError.value = error.message;
  });
}

function rowClassName(row) {
  return `row-${normalizeStatus(row.status || row.lifecycleStatus || row.accountLifecycleStatus)}`;
}

onMounted(() => {
  refreshSettings().catch((error) => {
    lastError.value = error.message;
    settingsLoaded.value = true;
  });
  refreshAll();
  refreshTimer = setInterval(() => refreshAll({ silent: true }), 3500);
});

watch(headlessMode, () => {
  saveSettings().catch((error) => {
    lastError.value = error.message;
  });
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <n-config-provider>
    <n-layout class="app-shell">
      <n-layout-header bordered class="topbar">
        <div class="brand">
          <div class="brand-mark">P+</div>
          <div>
            <h1>PayPal Plus 控制台</h1>
            <p>三段式任务：注册生成长链接、长链接支付、CPA 上传。</p>
          </div>
        </div>
        <div class="toolbar">
          <n-input-number v-model:value="limit" :min="1" :max="100" size="small">
            <template #prefix>limit</template>
          </n-input-number>
          <n-input-number v-model:value="windows" :min="1" :max="10" size="small">
            <template #prefix>windows</template>
          </n-input-number>
          <div class="toolbar-switch">
            <span>无头模式</span>
            <n-switch v-model:value="headlessMode" size="small" />
          </div>
          <n-button secondary :loading="loading" @click="refreshAll()">
            <template #icon>
              <n-icon><RefreshCw /></n-icon>
            </template>
            刷新
          </n-button>
        </div>
      </n-layout-header>

      <n-layout-content class="content">
        <n-alert v-if="lastError" type="error" closable class="error-alert" @close="lastError = ''">
          {{ lastError }}
        </n-alert>

        <section class="metrics" aria-label="summary">
          <article v-for="item in metrics" :key="item.label" class="metric-card" :class="statusInfo(item.status).className">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
          </article>
          <article class="metric-card muted">
            <span>最近刷新</span>
            <strong>{{ formatTime(lastUpdated) }}</strong>
          </article>
        </section>

        <n-grid :cols="24" :x-gap="14" responsive="screen">
          <n-gi :span="17">
            <n-card class="main-panel" :bordered="false">
              <n-tabs v-model:value="activeTab" type="line" animated>
                <n-tab-pane v-for="mode in modes" :key="mode.key" :name="mode.key">
                  <template #tab>
                    <span class="tab-label">
                      <n-icon><component :is="mode.icon" /></n-icon>
                      {{ mode.label }}
                    </span>
                  </template>

                  <template v-if="mode.key === 'register-link'">
                    <div class="panel-head">
                      <div>
                        <h2>{{ mode.title }}</h2>
                        <p>{{ registerAccounts.length }} 个注册完成但未生成可用链接的账号。</p>
                      </div>
                      <div class="panel-actions">
                        <n-button type="primary" :loading="starting === mode.key" @click="startMode(mode.key)">
                          <template #icon>
                            <n-icon><Play /></n-icon>
                          </template>
                          {{ mode.action }}
                        </n-button>
                        <n-button
                          type="warning"
                          secondary
                          :loading="starting === `${mode.key}:new-phone`"
                          @click="startMode(mode.key, { forceNewPhone: true })"
                        >
                          <template #icon>
                            <n-icon><PhoneCall /></n-icon>
                          </template>
                          购买新号并生成长链接
                        </n-button>
                      </div>
                    </div>
                    <n-data-table
                      v-model:checked-row-keys="selectedRegisterAccountIds"
                      :columns="accountColumns"
                      :data="registerAccounts"
                      :row-key="row => row.id"
                      :row-class-name="rowClassName"
                      :scroll-x="1300"
                      size="small"
                      :pagination="{ pageSize: 12 }"
                      striped
                    />
                  </template>

                  <template v-else-if="mode.key === 'pay-link'">
                    <div class="panel-head">
                      <div>
                        <h2>{{ mode.title }}</h2>
                        <p>只消费已保存的 ready 长链接；链接失效时标记 expired/failed，不隐式重新生成。</p>
                      </div>
                      <n-button type="primary" :loading="starting === mode.key" @click="startMode(mode.key)">
                        <template #icon>
                          <n-icon><Play /></n-icon>
                        </template>
                        {{ mode.action }}
                      </n-button>
                    </div>
                    <n-data-table
                      v-model:checked-row-keys="selectedCheckoutLinkIds"
                      :columns="linkColumns"
                      :data="checkoutLinks"
                      :row-key="row => row.id"
                      :row-class-name="rowClassName"
                      :scroll-x="1450"
                      size="small"
                      :pagination="{ pageSize: 12 }"
                      striped
                    />
                  </template>

                  <template v-else-if="mode.key === 'cpa-upload'">
                    <div class="panel-head">
                      <div>
                        <h2>{{ mode.title }}</h2>
                        <p>{{ cpaAccounts.length }} 个 Plus 已完成且未 CPA 完成的账号。</p>
                      </div>
                      <n-button type="primary" :loading="starting === mode.key" @click="startMode(mode.key)">
                        <template #icon>
                          <n-icon><Play /></n-icon>
                        </template>
                        {{ mode.action }}
                      </n-button>
                    </div>
                    <n-data-table
                      v-model:checked-row-keys="selectedCpaAccountIds"
                      :columns="accountColumns"
                      :data="cpaAccounts"
                      :row-key="row => row.id"
                      :row-class-name="rowClassName"
                      :scroll-x="1300"
                      size="small"
                      :pagination="{ pageSize: 12 }"
                      striped
                    />
                  </template>

                  <template v-else-if="mode.key === 'full'">
                    <div class="panel-head">
                      <div>
                        <h2>{{ mode.title }}</h2>
                        <p>按 register-link -> pay-link -> cpa-upload 顺序执行，失败停在对应状态。</p>
                      </div>
                      <n-button type="primary" :loading="starting === mode.key" @click="startMode(mode.key)">
                        <template #icon>
                          <n-icon><Play /></n-icon>
                        </template>
                        {{ mode.action }}
                      </n-button>
                    </div>
                    <n-steps :current="1" size="small" class="full-steps">
                      <n-step title="注册并生成长链接" description="HeroSMS 手机号注册 GPT，保存 checkout 长链接" />
                      <n-step title="长链接支付" description="打开保存长链接，完成 PayPal hosted checkout 并校验 Plus" />
                      <n-step title="CPA 上传" description="手机号登录 GPT，必要时绑定邮箱，然后上传 CPA" />
                    </n-steps>
                    <n-data-table
                      :columns="accountColumns.filter(column => column.type !== 'selection')"
                      :data="accounts"
                      :row-key="row => row.id"
                      :row-class-name="rowClassName"
                      :scroll-x="1250"
                      size="small"
                      :pagination="{ pageSize: 12 }"
                      striped
                    />
                  </template>

                  <template v-else>
                    <div class="panel-head">
                      <div>
                        <h2>{{ mode.title }}</h2>
                        <p>查看最近任务、run 状态、事件 timeline 和 artifact 路径。</p>
                      </div>
                      <n-button secondary :loading="loading" @click="refreshAll()">
                        <template #icon>
                          <n-icon><RefreshCw /></n-icon>
                        </template>
                        刷新日志
                      </n-button>
                    </div>
                    <n-data-table
                      :columns="runColumns"
                      :data="runs"
                      :row-key="row => row.runId"
                      :row-class-name="rowClassName"
                      :scroll-x="1300"
                      size="small"
                      :pagination="{ pageSize: 12 }"
                      striped
                    />
                    <div class="timeline-panel">
                      <div class="timeline-head">
                        <h3>{{ selectedRun?.runId || "未选择 Run" }}</h3>
                        <n-tag v-if="selectedRun" round :type="statusInfo(selectedRun.status).type">
                          {{ selectedRun.currentStep || selectedRun.status }}
                        </n-tag>
                      </div>
                      <n-timeline>
                        <n-timeline-item
                          v-for="event in events"
                          :key="event.id"
                          :type="event.level === 'error' ? 'error' : event.level === 'warn' ? 'warning' : 'info'"
                          :title="event.eventType || event.message"
                          :content="event.message"
                          :time="`${formatTime(event.createdAt)} ${event.step || ''}`"
                        />
                      </n-timeline>
                    </div>
                  </template>
                </n-tab-pane>
              </n-tabs>
            </n-card>
          </n-gi>

          <n-gi :span="7">
            <div class="side-stack">
              <n-card title="任务队列" :bordered="false" class="side-card">
                <template #header-extra>
                  <n-tag v-if="latestTask" round :type="statusInfo(latestTask.status).type">{{ latestTask.status }}</n-tag>
                </template>
                <n-data-table
                  class="task-queue-table"
                  :columns="taskColumns"
                  :data="tasks"
                  :row-key="row => row.taskId"
                  :row-props="taskRowProps"
                  :scroll-x="336"
                  size="small"
                  :pagination="{ pageSize: 6 }"
                />
              </n-card>

              <n-card title="当前段落" :bordered="false" class="side-card">
                <div class="mode-summary">
                  <n-icon size="22"><component :is="currentMode.icon" /></n-icon>
                  <div>
                    <strong>{{ currentMode.title }}</strong>
                    <span>{{ currentMode.targetLabel }}</span>
                  </div>
                </div>
                <n-divider />
                <n-space vertical size="small">
                  <n-tag round type="info">注册选中 {{ selectedRegisterAccountIds.length }}</n-tag>
                  <n-tag round type="info">CPA 选中 {{ selectedCpaAccountIds.length }}</n-tag>
                  <n-tag round type="info">选中链接 {{ selectedCheckoutLinkIds.length }}</n-tag>
                  <n-tag round>limit {{ limit }}</n-tag>
                  <n-tag round>windows {{ windows }}</n-tag>
                  <n-tag round>{{ headlessMode ? "headless" : "headed" }}</n-tag>
                </n-space>
              </n-card>

              <n-card title="最近 Run" :bordered="false" class="side-card">
                <n-list hoverable clickable>
                  <n-list-item v-for="run in relevantRuns.slice(0, 8)" :key="run.runId" @click="selectRun(run.runId)">
                    <div class="run-item">
                      <div>
                        <strong>{{ run.runId }}</strong>
                        <span>{{ run.currentStep || "-" }}</span>
                      </div>
                      <n-tag round size="small" :type="statusInfo(run.status).type">{{ run.status }}</n-tag>
                    </div>
                  </n-list-item>
                </n-list>
              </n-card>
            </div>
          </n-gi>
        </n-grid>
      </n-layout-content>

      <n-drawer v-model:show="taskDrawerOpen" width="560">
        <n-drawer-content title="任务详情" closable>
          <template v-if="selectedTask">
            <n-descriptions label-placement="left" bordered size="small" :column="1">
              <n-descriptions-item label="Task ID">{{ selectedTask.taskId }}</n-descriptions-item>
              <n-descriptions-item label="Mode">{{ selectedTask.mode }}</n-descriptions-item>
              <n-descriptions-item label="新手机号">{{ selectedTask.forceNewPhone ? "yes" : "no" }}</n-descriptions-item>
              <n-descriptions-item label="无头模式">{{ selectedTask.headless ? "yes" : "no" }}</n-descriptions-item>
              <n-descriptions-item label="Status">{{ selectedTask.status }}</n-descriptions-item>
              <n-descriptions-item label="PID">{{ selectedTask.pid || "-" }}</n-descriptions-item>
              <n-descriptions-item label="Run IDs">{{ (selectedTask.runIds || []).join(", ") || "-" }}</n-descriptions-item>
              <n-descriptions-item label="Command">{{ selectedTask.command || "-" }}</n-descriptions-item>
              <n-descriptions-item label="Started">{{ formatTime(selectedTask.startedAt) }}</n-descriptions-item>
              <n-descriptions-item label="Finished">{{ formatTime(selectedTask.finishedAt) }}</n-descriptions-item>
              <n-descriptions-item label="Error">{{ selectedTask.error || "-" }}</n-descriptions-item>
            </n-descriptions>
            <n-divider />
            <div class="drawer-actions">
              <n-button
                v-if="selectedTask.status === 'running'"
                type="error"
                secondary
                :loading="stoppingTaskId === selectedTask.taskId"
                @click="stopTask(selectedTask.taskId)"
              >
                <template #icon>
                  <n-icon><Square /></n-icon>
                </template>
                停止任务
              </n-button>
              <n-button secondary @click="refreshAll({ silent: true })">
                <template #icon>
                  <n-icon><RefreshCw /></n-icon>
                </template>
                刷新
              </n-button>
            </div>
            <n-divider />
            <h3>输出</h3>
            <n-code :code="(selectedTask.output || []).join('\n') || '暂无输出'" language="json" word-wrap />
          </template>
          <n-empty v-else description="未选择任务" />
        </n-drawer-content>
      </n-drawer>
    </n-layout>
  </n-config-provider>
</template>
