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
  const task = manager.start({ mode: "pay-link", ids: [7, 8], limit: 2, windows: 1, paypalPhoneCooldownMinutes: 7 });
  assert.equal(task.mode, "pay-link");
  assert.equal(task.paypalPhoneCooldownMinutes, 7);
  assert.deepEqual(recorder.calls[0].args.slice(1, 4), ["plus", "--mode", "pay-link"]);
  assert.equal(task.headless, true);
  assert.deepEqual(recorder.calls[0].args.includes("--headless"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--headed"), false);
  assert.deepEqual(recorder.calls[0].args.includes("--checkout-link-ids"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--gpt-phone-account-ids"), false);
  assert.equal(recorder.calls[0].args[recorder.calls[0].args.indexOf("--checkout-link-ids") + 1], "7,8");
  assert.deepEqual(recorder.calls[0].args.includes("--paypal-phone-cooldown-minutes"), true);
  assert.equal(recorder.calls[0].args[recorder.calls[0].args.indexOf("--paypal-phone-cooldown-minutes") + 1], "7");
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
  const task = manager.start({ mode: "register-link", limit: 2, windows: 2 });
  recorder.children[0].stdout.emit("data", Buffer.from('{"runId":"run_early"}\n'));
  recorder.children[0].stdout.emit("data", Buffer.from(`${Array.from({ length: 240 }, (_, index) => `line ${index}`).join("\n")}\n`));
  recorder.children[0].stdout.emit("data", Buffer.from('{"runId":"run_late"}\n'));
  recorder.children[0].emit("exit", 0, "");
  const done = manager.get(task.taskId);
  assert.equal(done.status, "done");
  assert.deepEqual(done.runIds, ["run_early", "run_late"]);
  assert.equal(done.output.some((line) => line.includes("run_early")), false);
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
  assert.equal(task.headless, true);
  assert.deepEqual(recorder.calls[0].args.includes("--gpt-phone-account-ids"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--checkout-link-ids"), false);
  assert.equal(recorder.calls[0].args[recorder.calls[0].args.indexOf("--gpt-phone-account-ids") + 1], "12");
}

{
  const recorder = makeSpawnRecorder();
  const manager = new UiJobManager({
    config: { database: { path: "/tmp/paypal.db" } },
    cwd: "/tmp/project",
    spawnFn: recorder.spawnFn,
  });
  const task = manager.start({ mode: "register-link", ids: [12], limit: 1, windows: 1, forceNewPhone: true });
  assert.equal(task.mode, "register-link");
  assert.equal(task.forceNewPhone, true);
  assert.deepEqual(recorder.calls[0].args.includes("--new-phone"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--gpt-phone-account-ids"), false);
  assert.deepEqual(recorder.calls[0].args.includes("--checkout-link-ids"), false);
}

{
  const recorder = makeSpawnRecorder();
  const manager = new UiJobManager({
    config: { database: { path: "/tmp/paypal.db" } },
    cwd: "/tmp/project",
    spawnFn: recorder.spawnFn,
  });
  const task = manager.start({ mode: "register-link", limit: 1, windows: 1, headless: false });
  assert.equal(task.mode, "register-link");
  assert.equal(task.headless, false);
  assert.deepEqual(recorder.calls[0].args.includes("--headed"), true);
  assert.deepEqual(recorder.calls[0].args.includes("--headless"), false);
}

console.log("ui-job-manager tests passed");
