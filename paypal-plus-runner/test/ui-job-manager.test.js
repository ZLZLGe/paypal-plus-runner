import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { UiJobManager } from "../src/ui/job-manager.js";

function makeSpawnRecorder() {
  const calls = [];
  const children = [];
  const spawnFn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 12345 + children.length;
    child.kill = (signal = "SIGTERM") => {
      child.emit("exit", null, signal);
      return true;
    };
    children.push(child);
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawnFn, calls, children };
}

{
  const recorder = makeSpawnRecorder();
  const manager = new UiJobManager({
    config: {
      __configPath: "/tmp/config.json",
      database: { path: "/tmp/paypal.db" },
    },
    cwd: "/tmp/project",
    spawnFn: recorder.spawnFn,
  });
  const task = manager.start({ mode: "pay-link", ids: [7, 8], limit: 2, windows: 1 });
  assert.equal(task.mode, "pay-link");
  assert.deepEqual(recorder.calls[0].args.slice(1, 4), ["plus", "--mode", "pay-link"]);
  assert.deepEqual(recorder.calls[0].args.includes("--checkout-link-ids"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--gpt-phone-account-ids"), false);
  assert.equal(recorder.calls[0].args[recorder.calls[0].args.indexOf("--checkout-link-ids") + 1], "7,8");
  assert.equal(recorder.calls[0].options.cwd, "/tmp/project");

  recorder.children[0].stdout.emit("data", Buffer.from('{"runId":"run_pay_1"}\n'));
  recorder.children[0].emit("exit", 0, "");
  const done = manager.get(task.taskId);
  assert.equal(done.status, "done");
  assert.deepEqual(done.runIds, ["run_pay_1"]);
}

{
  const recorder = makeSpawnRecorder();
  const manager = new UiJobManager({
    config: { database: { path: "/tmp/paypal.db" } },
    cwd: "/tmp/project",
    spawnFn: recorder.spawnFn,
  });
  const task = manager.start({ mode: "register-link", ids: [12], limit: 1, windows: 1 });
  assert.equal(task.mode, "register-link");
  assert.deepEqual(recorder.calls[0].args.includes("--gpt-phone-account-ids"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--checkout-link-ids"), false);
  assert.equal(recorder.calls[0].args[recorder.calls[0].args.indexOf("--gpt-phone-account-ids") + 1], "12");
}

console.log("ui-job-manager tests passed");
