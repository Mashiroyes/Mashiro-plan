import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { readRuntimeDescriptor, runtimeDescriptorPath } from "../core/deployment/runtime-descriptor.mjs";

const valid = {
  schemaVersion: 1,
  planRoot: "D:\\repo\\plan",
  sqlitePath: "D:\\repo\\plan\\sqlite\\openclaw-planner.sqlite",
  pwshPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  nodePath: "C:\\Program Files\\nodejs\\node.exe",
  pythonPath: "C:\\Python313\\python.exe",
  openClawCommand: "C:\\Users\\test\\AppData\\Roaming\\npm\\openclaw.cmd",
  openClawPackageRoot: "C:\\Users\\test\\.openclaw\\npm\\projects\\weixin\\node_modules\\@tencent-weixin\\openclaw-weixin",
  openClawPackageVersion: "2.4.8",
  openClawLayoutId: "tencent-weixin-2.4.8",
  interactiveUser: "DESKTOP\\test",
};

test("locates descriptor below LOCALAPPDATA", () => {
  assert.match(runtimeDescriptorPath({ LOCALAPPDATA: "C:\\Local" }), /MashiroBot[\\/]config[\\/]runtime\.json$/);
});

test("accepts absolute validated runtime paths", () => {
  const value = readRuntimeDescriptor({
    descriptorPath: "fixture.json",
    exists: () => true,
    readFile: () => JSON.stringify(valid),
  });
  assert.equal(value.schemaVersion, 1);
  assert.match(value.pwshPath, /pwsh\.exe$/i);
  assert.equal(path.isAbsolute(value.planRoot), true);
});

test("rejects a relative executable path", () => {
  assert.throws(() => readRuntimeDescriptor({
    descriptorPath: "fixture.json",
    exists: () => true,
    readFile: () => JSON.stringify({ ...valid, nodePath: "node.exe" }),
  }), /nodePath must be absolute/);
});

test("rejects a missing interactive user", () => {
  assert.throws(() => readRuntimeDescriptor({
    descriptorPath: "fixture.json",
    exists: () => true,
    readFile: () => JSON.stringify({ ...valid, interactiveUser: "" }),
  }), /interactiveUser is required/);
});
