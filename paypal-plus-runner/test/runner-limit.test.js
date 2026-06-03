import assert from "node:assert/strict";
import { distributeWorkerLimits } from "../src/runner.js";

assert.deepEqual(distributeWorkerLimits(0, 3), [0, 0, 0]);
assert.deepEqual(distributeWorkerLimits(1, 10), [1]);
assert.deepEqual(distributeWorkerLimits(2, 2), [1, 1]);
assert.deepEqual(distributeWorkerLimits(3, 2), [2, 1]);
assert.deepEqual(distributeWorkerLimits(5, 2), [3, 2]);
assert.deepEqual(distributeWorkerLimits(5, 10), [1, 1, 1, 1, 1]);

console.log("runner-limit tests passed");
