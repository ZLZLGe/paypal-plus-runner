import assert from "node:assert/strict";
import { RoxyClient, extractRoxyWebSocketUrl } from "../src/roxy/client.js";
import { reconnectRoxyWindowCdp } from "../src/worker.js";
import { runWorkflow } from "../src/workflow.js";
import { isClosedPageError } from "../src/utils/errors.js";

{
  assert.equal(extractRoxyWebSocketUrl({ ws: "ws://direct" }), "ws://direct");
  assert.equal(extractRoxyWebSocketUrl({ webSocketDebuggerUrl: "ws://debugger" }), "ws://debugger");
  assert.equal(extractRoxyWebSocketUrl({ browserWSEndpoint: "ws://browser" }), "ws://browser");
  assert.equal(extractRoxyWebSocketUrl({}), "");
}

{
  const client = new RoxyClient({
    api_base: "http://roxy.test",
    token: "token",
    workspace_id: 1,
  });
  const calls = [];
  client.request = async (pathname) => {
    calls.push(pathname);
    if (pathname === "/browser/mdf") return { ok: true };
    if (pathname === "/browser/open") return { webSocketDebuggerUrl: "ws://opened" };
    return {};
  };
  const result = await client.modifyWindowProxy("dir_1", { reopen: true });
  assert.equal(result.ws, "ws://opened");
  assert.deepEqual(calls, ["/browser/mdf", "/browser/close", "/browser/open"]);
}

{
  let oldClosed = false;
  const nextBrowser = { id: "next-browser" };
  const nextContext = { id: "next-context" };
  const nextPage = { id: "next-page" };
  const windowInfo = {
    dirId: "dir_1",
    browser: {
      async close() {
        oldClosed = true;
      },
    },
    context: { id: "old-context" },
    page: { id: "old-page" },
  };
  let connectWs = "";
  let connectTimeout = 0;
  await reconnectRoxyWindowCdp(windowInfo, {
    roxy: {
      cdpConnectTimeoutMs: 1234,
      localProxyResolveAttempts: 1,
      localProxyResolveDelayMs: 1,
    },
  }, "ws://next", {
    logger: { warn() {} },
    reason: "test_reconnect",
    connect: async (ws, options) => {
      connectWs = ws;
      connectTimeout = options.timeoutMs;
      return {
        browser: nextBrowser,
        context: nextContext,
        page: nextPage,
      };
    },
  });
  assert.equal(oldClosed, true);
  assert.equal(connectWs, "ws://next");
  assert.equal(connectTimeout, 1234);
  assert.equal(windowInfo.ws, "ws://next");
  assert.equal(windowInfo.browser, nextBrowser);
  assert.equal(windowInfo.context, nextContext);
  assert.equal(windowInfo.page, nextPage);
}

{
  assert.equal(isClosedPageError(new Error("page.evaluate: Target page, context or browser has been closed")), true);
  assert.equal(isClosedPageError(new Error("Execution context was destroyed, most likely because of a navigation.")), false);
}

{
  let attempts = 0;
  let recoveries = 0;
  const context = {
    config: { runner: {}, flow: {} },
    completedSteps: [],
    skippedSteps: [],
    recoverClosedPage: async () => {
      recoveries += 1;
    },
  };
  const result = await runWorkflow(context, {
    stepsOverride: [[
      "unstable-step",
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("page.evaluate: Target page, context or browser has been closed");
        }
        return { status: "done", reason: "recovered" };
      },
    ]],
  });
  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
  assert.equal(result.status, "done");
  assert.deepEqual(result.completedSteps, ["unstable-step"]);
}

{
  let attempts = 0;
  let recoveries = 0;
  const context = {
    config: { runner: {}, flow: {} },
    completedSteps: [],
    skippedSteps: [],
    recoverClosedPage: async () => {
      recoveries += 1;
    },
  };
  await assert.rejects(
    () => runWorkflow(context, {
      stepsOverride: [[
        "always-closed",
        async () => {
          attempts += 1;
          throw new Error("Target closed");
        },
      ]],
    }),
    /Target closed/,
  );
  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
}

console.log("roxy-window-recovery tests passed");
