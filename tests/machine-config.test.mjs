import test from "node:test";
import assert from "node:assert/strict";
import { applyGameExecutableOverrides, machineConfigPath, readMachineConfig } from "../core/config/machine-config.mjs";

test("locates config below LOCALAPPDATA", () => {
  assert.match(machineConfigPath({ LOCALAPPDATA: "C:\\Local" }), /MashiroBot[\\/]config[\\/]machine\.json$/);
});

test("validates and normalizes config", () => {
  const config = readMachineConfig({
    configPath: "fixture.json", exists: () => true,
    readFile: () => JSON.stringify({ schemaVersion: 1, weixinTarget: " target ", gameExecutableOverrides: { eden: "F:\\Eden\\eden.exe" } }),
  });
  assert.equal(config.weixinTarget, "target");
  assert.equal(config.gameExecutableOverrides.eden, "F:\\Eden\\eden.exe");
});

test("rejects missing config", () => {
  assert.throws(() => readMachineConfig({ configPath: "missing.json", exists: () => false }), /initialize-machine-config/);
});

test("applies only executable path overrides", () => {
  const games = [{ key: "eden", displayName: "Eden", processName: "eden.exe", executablePath: "D:\\old\\eden.exe" }];
  const result = applyGameExecutableOverrides(games, { gameExecutableOverrides: { eden: "F:\\new\\eden.exe", unknown: "X:\\x.exe" } });
  assert.equal(result[0].executablePath, "F:\\new\\eden.exe");
  assert.equal(result[0].displayName, "Eden");
});
