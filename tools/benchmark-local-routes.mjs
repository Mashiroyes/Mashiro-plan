import { performance } from "node:perf_hooks";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderMainMenu } from "../core/menu/help-service.mjs";
import { handle as handleGameTimer } from "../plugin/mashirobot-plugin-game-timer/index.mjs";
import { handle as handleLoot } from "../plugin/mashirobot-plugin-loot/index.mjs";
import * as lootStoreModule from "../plugin/mashirobot-plugin-loot/core/store.mjs";

const DEFAULT_SAMPLES = 5;

function parseArguments(argv) {
  let output = null;
  let samples = DEFAULT_SAMPLES;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--output") output = argv[++index];
    else if (token === "--samples") samples = Number.parseInt(argv[++index], 10);
    else throw new Error(`未知参数：${token}`);
  }
  if (!output) throw new Error("必须提供 --output <json>。");
  if (!Number.isInteger(samples) || samples < 5) throw new Error("--samples 必须是不小于 5 的整数。");
  return { output: path.resolve(output), samples };
}

function roundMs(value) {
  return Number(value.toFixed(3));
}

function summarize(command, samplesMs, externalStarts) {
  const ordered = [...samplesMs].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const median = ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
  return {
    command,
    samplesMs: samplesMs.map(roundMs),
    medianMs: roundMs(median),
    maxMs: roundMs(Math.max(...samplesMs)),
    externalStarts,
  };
}

export function createExternalStartCounter() {
  let count = 0;
  return Object.freeze({
    mark() { count += 1; },
    get value() { return count; },
  });
}

async function sample(command, count, operation, counter = createExternalStartCounter()) {
  const samplesMs = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = performance.now();
    await operation(index, counter);
    samplesMs.push(performance.now() - startedAt);
  }
  return summarize(command, samplesMs, counter.value);
}

function pythonExecutable() {
  const candidates = [
    process.env.MASHIROBOT_PYTHON,
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Python", "pythoncore-3.14-64", "python.exe")
      : null,
    process.env.PYTHON,
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates.at(-1) ?? "python";
}

function helpPlugin(description = "计划、记录、作息与提醒") {
  return {
    manifest: {
      id: "mashirobot-plugin-plan",
      name: "计划",
      version: "1.0.0",
      description,
      hideDescription: false,
      menuIndex: 1,
      priority: 100,
      enabled: true,
      exactCommands: ["/计划", "/计划详细"],
    },
    module: { getHelp: () => ({ groups: [], detailedGroups: [], fallbackText: "计划" }) },
  };
}

function registryFor(plugin) {
  return { plugins: [plugin], failures: [] };
}

function writeGameConfig(configPath, executablePath) {
  const processName = path.win32.basename(executablePath);
  writeFileSync(configPath, `${JSON.stringify({ games: [{
    key: "benchmark-game",
    displayName: "Benchmark Game",
    aliases: [],
    processName,
    executablePath: path.win32.normalize(executablePath),
    steamId: null,
    priority: false,
  }] }, null, 2)}\n`, "utf8");
}

function createFixture(root) {
  const executableDirectory = path.join(root, "BenchmarkGame");
  mkdirSync(executableDirectory, { recursive: true });
  const executablePath = path.join(executableDirectory, "benchmark.exe");
  const cmdPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  copyFileSync(cmdPath, executablePath);
  const configPath = path.join(root, "games.json");
  writeGameConfig(configPath, executablePath);
  return {
    executablePath,
    configPath,
    gameSqlitePath: path.join(root, "game-timer.sqlite"),
    lootSqlitePath: path.join(root, "loot.sqlite"),
    auditTargetsPath: path.join(root, "usage-audit", "targets.json"),
    helpTempRoot: path.join(root, "help-cache"),
  };
}

export async function runBenchmarks({ samples = DEFAULT_SAMPLES } = {}) {
  if (!Number.isInteger(samples) || samples < 5) throw new Error("samples 必须是不小于 5 的整数。");
  const root = mkdtempSync(path.join(os.tmpdir(), "mashirobot-baseline-"));
  try {
    const fixture = createFixture(root);
    const fixedNow = new Date("2026-09-16T05:00:00.000Z");
    const gameContext = {
      gameTimerConfigPath: fixture.configPath,
      sqlitePath: fixture.gameSqlitePath,
      auditTargetsPath: fixture.auditTargetsPath,
      auditStore: { replaceTargets() {} },
      now: fixedNow,
    };

    const records = [];
    records.push(await sample("查看游戏", samples, async () => {
      await Promise.resolve(handleGameTimer("查看游戏", gameContext));
    }));
    records.push(await sample("查看游戏计时", samples, async () => {
      await Promise.resolve(handleGameTimer("查看游戏计时", gameContext));
    }));
    records.push(await sample("爽点保存", samples, async (index) => {
      await Promise.resolve(handleLoot(`爽点\n基准记录 ${index}`, {
        sqlitePath: fixture.lootSqlitePath,
        now: fixedNow,
      }));
    }));

    const cachedRegistry = registryFor(helpPlugin());
    await Promise.resolve(renderMainMenu(cachedRegistry, {
      tempRoot: fixture.helpTempRoot,
      pythonExecutable: pythonExecutable(),
    }));
    records.push(await sample("帮助图片（缓存命中）", samples, async () => {
      await Promise.resolve(renderMainMenu(cachedRegistry, {
        tempRoot: fixture.helpTempRoot,
        pythonExecutable: pythonExecutable(),
      }));
    }));

    const renderStarts = createExternalStartCounter();
    records.push(await sample("帮助图片（缓存未命中）", samples, async (index, counter) => {
      counter.mark();
      await Promise.resolve(renderMainMenu(registryFor(helpPlugin(`未缓存基准 ${index}`)), {
        tempRoot: fixture.helpTempRoot,
        pythonExecutable: pythonExecutable(),
      }));
    }, renderStarts));

    const addStarts = createExternalStartCounter();
    const addContext = {
      ...gameContext,
      qqSessionScheduler: {
        status() {
          addStarts.mark();
          return { status: { qqExecutablePaths: [] } };
        },
      },
    };
    records.push(await sample("加入游戏", samples, async () => {
      await Promise.resolve(handleGameTimer(`加入游戏\n${fixture.executablePath}`, addContext));
    }, addStarts));

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      samplesPerRoute: samples,
      records,
    };
  } finally {
    lootStoreModule.closeAllLootStores?.();
    rmSync(root, { recursive: true, force: true });
  }
}

async function writeJsonAtomically(outputPath, value) {
  const directory = path.dirname(outputPath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(outputPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, outputPath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = await runBenchmarks({ samples: options.samples });
  await writeJsonAtomically(options.output, report);
  process.stdout.write(`${options.output}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]).toLocaleLowerCase("en") : "";
const modulePath = fileURLToPath(import.meta.url).toLocaleLowerCase("en");
if (invokedPath === modulePath) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
