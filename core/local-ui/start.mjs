import { handleMashiroBotMessage, shutdownMashiroBot } from "../index.mjs";
import { createLocalControlServer } from "./server.mjs";
import fs from "node:fs/promises";
import path from "node:path";

const server = await createLocalControlServer({
  handleMessage: (text, context) => handleMashiroBotMessage(text, context),
});
const urlFile = path.join(process.env.TEMP || ".", "MashiroBot", "local-control-url.txt");
await fs.mkdir(path.dirname(urlFile), { recursive: true });
await fs.writeFile(urlFile, `${server.url}\n`, "utf8");
console.log(`Plan 本地控制台：${server.url}`);
process.on("SIGINT", async () => { await shutdownMashiroBot(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdownMashiroBot(); process.exit(0); });
await new Promise(() => {});
