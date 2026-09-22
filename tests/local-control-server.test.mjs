import test from "node:test";
import assert from "node:assert/strict";
import { createLocalControlServer } from "../core/local-ui/server.mjs";

test("local control server routes commands and requires its token", async () => {
  const calls = [];
  const server = await createLocalControlServer({ port: 0, token: "test-token", handleMessage: async (text, context) => { calls.push({ text, context }); return { reply: `ok:${text}`, mediaPaths: [] }; } });
  try {
    const unauthorized = await fetch(`http://${server.host}:${server.port}/`);
    assert.equal(unauthorized.status, 401);
    const page = await fetch(server.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Plan 本地控制台/);
    const response = await fetch(`http://${server.host}:${server.port}/api/command`, { method: "POST", headers: { "content-type": "application/json", "x-mashiro-token": server.token }, body: JSON.stringify({ text: "帮助" }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reply, "ok:帮助");
    assert.deepEqual(calls[0].context, { source: "local-ui", accountId: "local", conversationId: "local" });
  } finally { await server.close(); }
});
