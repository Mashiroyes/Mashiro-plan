import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createLocalControlServer } from "../core/local-ui/server.mjs";

test("local control server routes commands and requires its token", async () => {
  const calls = [];
  const server = await createLocalControlServer({ port: 0, token: "test-token", handleMessage: async (text, context) => { calls.push({ text, context }); return { reply: `ok:${text}`, mediaPaths: [] }; } });
  try {
    const publicPage = await fetch(`http://${server.host}:${server.port}/`);
    assert.equal(publicPage.status, 200);
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Plan 本地控制台/);
    const response = await fetch(`http://${server.host}:${server.port}/api/command`, { method: "POST", headers: { "content-type": "application/json", "x-mashiro-token": server.token }, body: JSON.stringify({ text: "帮助" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply, "ok:帮助");
    assert.deepEqual(calls[0].context, { source: "local-ui", accountId: "local", conversationId: "local" });
    const mediaRoot = path.resolve(process.env.TEMP, "MashiroBot", "outbound");
    const mediaPath = path.join(mediaRoot, "local-ui-test.png");
    await fs.mkdir(mediaRoot, { recursive: true });
    await fs.writeFile(mediaPath, Buffer.from([137, 80, 78, 71]));
    const media = await fetch(`http://${server.host}:${server.port}/media?path=${encodeURIComponent(mediaPath)}&token=${server.token}`);
    assert.equal(media.status, 200);
    assert.equal(media.headers.get("content-type"), "image/png");
    await fs.rm(mediaPath, { force: true });
  } finally { await server.close(); }
});
