import { helpData } from "./help/help-data.mjs";
import { runPlanHealthChecks } from "./health.mjs";
import { handlePlanPlugin, matchPlanPlugin } from "./routes/index.mjs";

export const match = (message, context) => matchPlanPlugin(message, context);

export const handle = async (message, context) => {
  const text = String(message).trim();
  if (text === "/计划") return await context.renderPluginHelp("mashirobot-plugin-plan", { detailed: false });
  if (text === "/计划详细") return await context.renderPluginHelp("mashirobot-plugin-plan", { detailed: true });
  const result = await handlePlanPlugin(message, context);
  if (!result) throw new Error("plan plugin handler was called for an unmatched message");
  return {
    handled: true,
    command: result.command,
    reply: result.reply ?? "",
    mediaPaths: Array.isArray(result.mediaPaths) ? result.mediaPaths : [],
  };
};

export const healthCheck = () => runPlanHealthChecks();
export const getHelp = () => helpData;
