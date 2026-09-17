import test from "node:test";
import assert from "node:assert/strict";
import { parseGameTimerCommand } from "../core/parser.mjs";
import { addGameToConfig, findConfiguredGame, inferGameName, loadGameConfig } from "../core/game-config.mjs";

test("parse game timer duration and custom grace", () => {
  assert.deepEqual(parseGameTimerCommand("玩饥荒联机版15分钟，提醒后5分钟强退"), {
    kind: "create",
    game: "饥荒联机版",
    minutes: 15,
    forceAfter: 5,
  });
  assert.deepEqual(parseGameTimerCommand("玩饥荒联机版2小时"), {
    kind: "create",
    game: "饥荒联机版",
    minutes: 120,
    forceAfter: 10,
  });
  assert.deepEqual(parseGameTimerCommand("玩饥荒联机版2分钟，提醒后0分钟强退"), {
    kind: "create",
    game: "饥荒联机版",
    minutes: 2,
    forceAfter: 0,
  });
});

test("parse management commands and reject removed query or invalid durations", () => {
  assert.equal(parseGameTimerCommand("查看游戏计时"), null);
  assert.equal(parseGameTimerCommand("查看计时"), null);
  assert.deepEqual(parseGameTimerCommand("查看游戏"), { kind: "list" });
  assert.equal(parseGameTimerCommand("查询游戏"), null);
  assert.deepEqual(parseGameTimerCommand("加入游戏\nD:\\Games\\Demo-v1.0\\demo.exe"), {
    kind: "add", executablePath: "D:\\Games\\Demo-v1.0\\demo.exe",
  });
  assert.equal(parseGameTimerCommand("玩饥荒联机版0分钟"), null);
  assert.equal(parseGameTimerCommand("玩饥荒联机版1441分钟"), null);
  assert.equal(parseGameTimerCommand("玩饥荒联机版半小时"), null);
});

test("priority marking commands are no longer supported", () => {
  for (const command of ["标记2，4, 6", "取消标记 2， 4", "标记0"]) assert.equal(parseGameTimerCommand(command), null);
});

test("parses batch game deletion with Chinese or ASCII commas", () => {
  assert.deepEqual(parseGameTimerCommand("删除游戏2，4, 6"), { kind: "deletePreview", indices: [2, 4, 6] });
  assert.equal(parseGameTimerCommand("删除游戏0，2"), null);
});

test("infer game name before first hyphen", () => {
  assert.equal(inferGameName("D:\\Tools\\Eden-v0.0.4-win\\eden.exe"), "Eden");
  assert.equal(inferGameName("D:\\Games\\Northgard\\Northgard.exe"), "Northgard");
});

test("validate game config and resolve aliases", () => {
  const configs = loadGameConfig({
    games: [{
      key: "dst",
      displayName: "饥荒联机版",
      aliases: ["饥荒"],
      processName: "dontstarve_steam_x64.exe",
      executablePath: "E:\\Games\\dontstarve_steam_x64.exe",
      steamId: "322330",
    }],
  });
  assert.equal(findConfiguredGame("饥荒", configs)?.key, "dst");
  assert.equal(findConfiguredGame("饥荒联机版", configs)?.key, "dst");
  assert.equal("priority" in configs[0], false);
});

test("reject unsafe game config", () => {
  assert.throws(() => loadGameConfig({ games: [{
    key: "bad",
    displayName: "bad",
    aliases: [],
    processName: "game.exe",
    executablePath: "relative\\game.exe",
  }] }), /absolute/i);
  assert.throws(() => loadGameConfig({ games: [{
    key: "bad",
    displayName: "bad",
    aliases: [],
    processName: "other.exe",
    executablePath: "E:\\Games\\game.exe",
  }] }), /processName/i);
});
