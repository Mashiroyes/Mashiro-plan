process.env.MASHIROBOT_PLAN_ROOT = "__MASHIROBOT_PLAN_ROOT__";
const { handleMashiroBotMessage } = await import("__MASHIROBOT_INDEX_URI__");
export const handleFastRoutineCommand = handleMashiroBotMessage;
