import { handleMashiroBotMessage, shutdownMashiroBot } from "../index.mjs";
import { createLocalControlServer } from "./server.mjs";

const server = await createLocalControlServer({
  handleMessage: (text, context) => handleMashiroBotMessage(text, context),
});
console.log(`Plan 本地控制台：${server.url}`);
process.on("SIGINT", async () => { await shutdownMashiroBot(); process.exit(0); });
process.on("SIGTERM", async () => { await shutdownMashiroBot(); process.exit(0); });
await new Promise(() => {});
