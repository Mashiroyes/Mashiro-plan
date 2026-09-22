import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";

const directory = path.dirname(fileURLToPath(import.meta.url));
const pagePath = path.join(directory, "index.html");

function tokenMatches(request, token) {
  const supplied = request.headers["x-mashiro-token"] ?? new URL(request.url, "http://127.0.0.1").searchParams.get("token") ?? "";
  const left = Buffer.from(String(supplied));
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function createLocalControlServer({ handleMessage, host = "127.0.0.1", port = 17860, token = randomBytes(24).toString("hex") } = {}) {
  if (typeof handleMessage !== "function") throw new TypeError("handleMessage is required");
  const html = await fs.readFile(pagePath, "utf8");
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${host}`);
      if (!tokenMatches(request, token)) {
        response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        response.end("Unauthorized");
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(html.replaceAll("__MASHIRO_TOKEN__", token));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/command") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const payload = JSON.parse(body || "{}");
        const text = String(payload.text ?? "").trim();
        if (!text) throw new Error("请输入指令。");
        const result = await handleMessage(text, { source: "local-ui", accountId: "local", conversationId: "local" });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404); response.end("Not found");
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ handled: true, command: "本地控制台错误", reply: String(error.message || error), mediaPaths: [] }));
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  return Object.freeze({ server, host, port: address.port, token, url: `http://${host}:${address.port}/?token=${encodeURIComponent(token)}`, close: () => new Promise((resolve) => server.close(resolve)) });
}
