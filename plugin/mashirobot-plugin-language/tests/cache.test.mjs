import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPlanRuntime } from "../../mashirobot-plugin-plan/bridge/planner-runner.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("English chart cache runs the renderer once and creates unique outbound copies", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "language-chart-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keywords = path.join(root, "keywords.json");
  await writeFile(keywords, "{}\n");
  let starts = 0;
  const runtime = createPlanRuntime({
    sqlitePath: path.join(root, "planner.sqlite"),
    englishKeywordsPath: keywords,
    tempRoot: root,
    runLocalProcess: async ({ args }) => {
      starts += 1;
      const output = args[args.indexOf("--output") + 1];
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, png);
      return { value: { ok: true }, exitCode: 0, stdout: "{}", stderr: "", elapsedMs: 1 };
    },
  });
  const payload = { fromDate: "2026-09-14", toDate: "2026-09-16", totals: {} };
  const first = await runtime.generateEnglishSkillsChart(payload);
  const second = await runtime.generateEnglishSkillsChart({ totals: {}, toDate: "2026-09-16", fromDate: "2026-09-14" });
  assert.equal(first, second);
  assert.equal(starts, 1);
  const [copyOne] = runtime.copyChartForUse([first]);
  const [copyTwo] = runtime.copyChartForUse([second]);
  assert.notEqual(copyOne, copyTwo);
  assert.ok(fs.existsSync(copyOne));
  assert.ok(fs.existsSync(copyTwo));
});
