import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const scriptPath = path.resolve(import.meta.dirname, "..", "windows", "routine-reminder.ps1");
const source = readFileSync(scriptPath, "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`function ${name} {`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? source.indexOf(`function ${nextName} {`, start) : source.length;
  assert.notEqual(end, -1, `${nextName} must exist after ${name}`);
  return source.slice(start, end);
}

test("interactive wakeup commands never wait for legacy OpenClaw cron cleanup", () => {
  const setWakeup = functionBody("Invoke-SetWakeup", "Invoke-GetWakeup");
  const getWakeup = functionBody("Invoke-GetWakeup", "Invoke-CancelWakeup");
  const cancelWakeup = functionBody("Invoke-CancelWakeup", "Invoke-CleanupLegacyWakeup");

  for (const [name, body] of [
    ["SetWakeup", setWakeup],
    ["GetWakeup", getWakeup],
    ["CancelWakeup", cancelWakeup],
  ]) {
    assert.doesNotMatch(body, /Remove-LegacyWakeupCronJobs/, `${name} must remain fast`);
  }
});

test("legacy wakeup cron cleanup remains available as an explicit maintenance action", () => {
  const maintenance = functionBody("Invoke-CleanupLegacyWakeup", "Initialize-MasterVolumeType");
  assert.match(maintenance, /Remove-LegacyWakeupCronJobs/);
  assert.match(source, /'CleanupLegacyWakeup'\s*\{\s*Invoke-CleanupLegacyWakeup\s*\}/);
});
