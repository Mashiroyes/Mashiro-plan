import { formatLessonCard, getLesson } from "./curriculum.mjs";
import { getFinancialReportSlot, getProspectusSlot } from "./calendar.mjs";

function result(reply, command = "财报课程") {
  return { handled: true, command, reply, mediaPaths: [] };
}

function identity(context) {
  const accountId = String(context.accountId ?? "default");
  const conversationId = String(context.conversationId ?? "default");
  return { accountId, conversationId };
}

function sourceForLesson(curriculum, lesson) {
  const ids = new Set([lesson.sourceId, ...lesson.facts.map((fact) => fact.sourceId).filter(Boolean)]);
  return curriculum.sources.filter((source) => ids.has(source.sourceId));
}

function card(curriculum, courseType, lessonNumber) {
  const lesson = getLesson(curriculum, courseType, lessonNumber);
  return formatLessonCard(lesson, sourceForLesson(curriculum, lesson));
}

function currentSlot(courseType, state, now) {
  return courseType === "financial_report" ? getFinancialReportSlot(state, now) : getProspectusSlot(state, now);
}

function lessonLabel(courseType, lessonNumber) {
  return courseType === "financial_report" ? `第 ${lessonNumber} 天财报` : `第 ${lessonNumber} 课招股书`;
}

function statusReply(courseType, state, progress, now) {
  const slot = currentSlot(courseType, state, now);
  const sent = Number(progress.deliveryCounts.find((row) => row.course_type === courseType && row.status === "sent")?.count ?? 0);
  const answered = Number(progress.answerCounts.find((row) => row.course_type === courseType)?.count ?? 0);
  const total = courseType === "financial_report" ? 30 : 8;
  const schedule = courseType === "financial_report" ? "每天 12:20" : "每周二、周五 18:10";
  const current = slot.lessonNumber ? lessonLabel(courseType, slot.lessonNumber) : slot.reason === "complete" ? "已完成" : "今天没有计划课程";
  return [
    `${courseType === "financial_report" ? "财报" : "招股书"}课程：${state.paused ? "已暂停" : "进行中"}`,
    `时间：${schedule}`,
    `当前：${current}`,
    `已发送：${sent}/${total}；已回答：${answered} 次`,
    state.paused ? "暂停期间课程日历冻结；手动补学仍可使用。" : "未答题不会阻止下一节课程自动发送。",
  ].join("\n");
}

export function handleLearningCommand(command, context, dependencies) {
  const { store, curriculum, now = context.now ?? new Date(), wakeFeedbackTask = () => {} } = dependencies;
  const ids = identity(context);
  if (command.kind === "invalid") return result(command.error, command.command);

  if (command.kind === "status") {
    const state = store.getCourseState(ids.accountId, ids.conversationId, command.courseType);
    return result(statusReply(command.courseType, state, store.listProgress(ids.accountId, ids.conversationId), now), "查询课程进度");
  }

  if (command.kind === "pause") {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    store.pauseCourses(ids.accountId, ids.conversationId, date);
    return result("财报和招股书自动推送已暂停，课程日历从今天起冻结。手动补学仍可使用。", "暂停财报课程");
  }

  if (command.kind === "resume") {
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
    store.resumeCourses(ids.accountId, ids.conversationId, date);
    return result("财报和招股书自动推送已继续，将从暂停前的下一课开始，不补发暂停期间课程。", "继续财报课程");
  }

  if (["today", "relearn"].includes(command.kind)) {
    const state = store.getCourseState(ids.accountId, ids.conversationId, command.courseType);
    const slot = currentSlot(command.courseType, state, now);
    if (slot.reason === "not_started") return result("课程尚未开始。安装后的下一个计划日是第一课。", "今日课程");
    if (slot.reason === "wrong_day") return result("今天没有招股书课程；招股书在每周二、周五 18:10 推送。", "今日招股书");
    if (slot.reason === "complete") return result("这门课程已经完成，仍可使用补学指令查看任意一课。", "今日课程");
    if (!slot.lessonNumber) return result("今天课程日历已暂停；可使用补学指令手动查看课程。", "今日课程");
    return result(card(curriculum, command.courseType, slot.lessonNumber), command.kind === "relearn" ? "重学今日财报" : "今日课程");
  }

  if (command.kind === "catchup") {
    const state = store.getCourseState(ids.accountId, ids.conversationId, command.courseType);
    const slot = currentSlot(command.courseType, state, now);
    const highestStarted = slot.reason === "complete" ? (command.courseType === "financial_report" ? 30 : 8) : (slot.lessonNumber ?? 0);
    if (command.lessonNumber > highestStarted) return result(`${lessonLabel(command.courseType, command.lessonNumber)}尚未开始。`, "补学课程");
    return result(card(curriculum, command.courseType, command.lessonNumber), "补学课程");
  }

  if (command.kind === "answer") {
    let lessonNumber = command.lessonNumber;
    if (lessonNumber == null) {
      const candidates = store.findUnansweredLessons(ids.accountId, ids.conversationId, command.courseType);
      if (candidates.length !== 1) {
        const sample = command.courseType === "financial_report" ? "财报答案 第N天 内容" : "招股书答案 第N课 内容";
        return result(`无法唯一判断这份答案对应哪一课，请使用“${sample}”。`, "提交课程答案");
      }
      lessonNumber = candidates[0].lesson_number;
    }
    store.saveAnswer({ ...ids, courseType: command.courseType, lessonNumber, answerText: command.answer, now });
    let warning = "";
    try { wakeFeedbackTask(); } catch (error) { warning = `\n答案已安全保存，但点评任务暂时未启动：${error.message}`; }
    const wording = command.courseType === "financial_report"
      ? `已收到第 ${lessonNumber} 天财报答案，正在使用聊天模式生成点评。`
      : `已收到第 ${lessonNumber} 课招股书答案，正在使用聊天模式生成点评。`;
    return result(`${wording}${warning}`, "提交课程答案");
  }

  throw new TypeError(`未支持的课程命令: ${command.kind}`);
}
