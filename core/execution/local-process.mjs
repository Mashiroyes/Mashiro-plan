import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const PROCESS_TIMEOUT_PROFILES = Object.freeze({
  python: 30_000,
  powershell: 45_000,
  schtasks: 15_000,
  external: 30_000,
});
const DEFAULT_TIMEOUT_MS = PROCESS_TIMEOUT_PROFILES.external;
const DEFAULT_MAX_STDOUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 1_000;
const TASKKILL_WAIT_MS = 1_000;

export class LocalProcessError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = "LocalProcessError";
    this.code = code;
    this.ok = false;
    this.operation = details.operation ?? null;
    this.operationId = details.operationId ?? null;
    this.requestId = details.requestId ?? null;
    this.durationMs = details.durationMs ?? details.elapsedMs ?? 0;
    this.elapsedMs = details.elapsedMs ?? 0;
    this.exitCode = details.exitCode ?? null;
    this.stdout = details.stdout ?? "";
    this.stderr = details.stderr ?? "";
  }
}

export function resolveProcessTimeout(profile, override) {
  if (override !== undefined) return finiteNonnegative(override, DEFAULT_TIMEOUT_MS, "timeoutMs");
  if (profile === undefined || profile === null || profile === "") return DEFAULT_TIMEOUT_MS;
  if (!Object.hasOwn(PROCESS_TIMEOUT_PROFILES, profile)) {
    throw new TypeError(`unknown process timeout profile: ${profile}`);
  }
  return PROCESS_TIMEOUT_PROFILES[profile];
}

function finiteNonnegative(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(`${name} must be a finite nonnegative number`);
  }
  return resolved;
}

function normalizeOptions(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }
  if (typeof options.executable !== "string" || options.executable.length === 0) {
    throw new TypeError("executable must be a non-empty string");
  }
  if (options.args !== undefined && !Array.isArray(options.args)) {
    throw new TypeError("args must be an array");
  }

  const output = options.output ?? "text";
  if (output !== "text" && output !== "json") {
    throw new TypeError('output must be "text" or "json"');
  }
  const jsonMode = options.jsonMode ?? "document";
  if (jsonMode !== "document" && jsonMode !== "last-line") {
    throw new TypeError('jsonMode must be "document" or "last-line"');
  }

  return {
    ...options,
    args: options.args ?? [],
    operation: String(options.operation ?? options.executable),
    operationId: options.operationId ?? randomUUID(),
    requestId: options.requestId == null ? null : String(options.requestId),
    timeoutMs: resolveProcessTimeout(options.timeoutProfile, options.timeoutMs),
    maxStdoutBytes: finiteNonnegative(
      options.maxStdoutBytes,
      DEFAULT_MAX_STDOUT_BYTES,
      "maxStdoutBytes",
    ),
    maxStderrBytes: finiteNonnegative(
      options.maxStderrBytes,
      DEFAULT_MAX_STDERR_BYTES,
      "maxStderrBytes",
    ),
    output,
    jsonMode,
    spawnImpl: options.spawnImpl ?? spawn,
  };
}

function emitProcessLog(logger, record) {
  if (!logger) return;
  try {
    const pending = typeof logger === "function"
      ? logger(record)
      : (logger[record.level] ?? logger.log)?.call(logger, record);
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Observability must never alter the process result.
  }
}

function waitForAuxiliaryProcess(child, timeoutMs = TASKKILL_WAIT_MS) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once?.("close", finish);
    child.once?.("error", finish);
  });
}

async function defaultKillTree(child, { spawnImpl }) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) return;

  if (process.platform === "win32") {
    let taskkill;
    try {
      taskkill = spawnImpl(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          shell: false,
          windowsHide: true,
          stdio: "ignore",
        },
      );
    } catch {
      return;
    }
    await waitForAuxiliaryProcess(taskkill);
    return;
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // The process may have exited between the terminal condition and cleanup.
  }
}

function parseValue(stdout, output, jsonMode) {
  if (output === "text") return stdout;

  let source = stdout;
  if (jsonMode === "last-line") {
    const lines = stdout.split(/\r?\n/u);
    while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
    source = lines.at(-1) ?? "";
  }
  return JSON.parse(source);
}

function executeProcess(options, startedAt) {
  const {
    executable,
    args,
    cwd,
    env,
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    output,
    jsonMode,
    signal,
    operation,
    operationId,
    requestId,
    spawnImpl,
  } = options;
  const killTreeImpl = options.killTreeImpl ?? defaultKillTree;

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let terminal = null;
    let timeoutTimer = null;
    let killGraceTimer = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutChunks = [];
    const stderrChunks = [];

    const elapsed = (minimum = 0) => Math.max(
      minimum,
      Math.max(0, Math.round(performance.now() - startedAt)),
    );
    const stdoutText = () => Buffer.concat(stdoutChunks).toString("utf8");
    const stderrText = () => Buffer.concat(stderrChunks).toString("utf8");

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killGraceTimer) clearTimeout(killGraceTimer);
      signal?.removeEventListener("abort", onAbort);
      child?.stdout?.removeListener?.("data", onStdoutData);
      child?.stderr?.removeListener?.("data", onStderrData);
    };

    const finishError = ({ exitCode = null, cause } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      const reason = terminal ?? {
        code: "PROCESS_SPAWN_FAILED",
        message: "The local process failed before completion.",
      };
      const durationMs = elapsed(reason.minimumElapsedMs);
      reject(new LocalProcessError(reason.code, reason.message, {
        operation,
        operationId,
        requestId,
        durationMs,
        elapsedMs: durationMs,
        exitCode,
        stdout: stdoutText(),
        stderr: stderrText(),
        cause: cause ?? reason.cause,
      }));
    };

    const beginTermination = (reason) => {
      if (settled || terminal) return;
      terminal = reason;

      try {
        Promise.resolve(killTreeImpl(child, {
          operationId,
          reasonCode: reason.code,
          spawnImpl,
        })).catch(() => {});
      } catch {
        // Preserve the original terminal reason; cleanup failure is secondary.
      }

      if (!settled) {
        killGraceTimer = setTimeout(() => finishError(), KILL_GRACE_MS);
      }
    };

    const appendBounded = (chunk, streamName) => {
      if (settled || terminal) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const isStdout = streamName === "stdout";
      const currentBytes = isStdout ? stdoutBytes : stderrBytes;
      const limit = isStdout ? maxStdoutBytes : maxStderrBytes;
      const remaining = Math.max(0, limit - currentBytes);
      if (remaining > 0) {
        const retained = buffer.length <= remaining
          ? buffer
          : buffer.subarray(0, remaining);
        (isStdout ? stdoutChunks : stderrChunks).push(retained);
        if (isStdout) stdoutBytes += retained.length;
        else stderrBytes += retained.length;
      }
      if (buffer.length > remaining) {
        beginTermination({
          code: "PROCESS_OUTPUT_LIMIT",
          message: `${streamName} exceeded its configured byte limit.`,
        });
      }
    };

    function onStdoutData(chunk) {
      appendBounded(chunk, "stdout");
    }

    function onStderrData(chunk) {
      appendBounded(chunk, "stderr");
    }

    function onAbort() {
      beginTermination({
        code: "PROCESS_ABORTED",
        message: "The local process was cancelled.",
      });
    }

    if (signal?.aborted) {
      terminal = {
        code: "PROCESS_ABORTED",
        message: "The local process was cancelled.",
      };
      finishError();
      return;
    }

    try {
      child = spawnImpl(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
      });
    } catch (cause) {
      terminal = {
        code: "PROCESS_SPAWN_FAILED",
        message: "The local process could not be started.",
      };
      finishError({ cause });
      return;
    }

    child.stdout?.on?.("data", onStdoutData);
    child.stderr?.on?.("data", onStderrData);
    child.stdout?.on?.("error", (cause) => {
      if (settled || terminal) return;
      beginTermination({
        code: "PROCESS_SPAWN_FAILED",
        message: "The local process output stream failed.",
        cause,
      });
    });
    child.stderr?.on?.("error", (cause) => {
      if (settled || terminal) return;
      beginTermination({
        code: "PROCESS_SPAWN_FAILED",
        message: "The local process error stream failed.",
        cause,
      });
    });

    child.on?.("error", (cause) => {
      if (settled || terminal) return;
      const reason = {
        code: "PROCESS_SPAWN_FAILED",
        message: "The local process could not be started.",
        cause,
      };
      if (Number.isInteger(child?.pid) && child.pid > 0) {
        beginTermination(reason);
        return;
      }
      terminal = reason;
      finishError();
    });

    child.once?.("close", (exitCode) => {
      if (settled) return;
      if (terminal) {
        finishError({ exitCode });
        return;
      }
      if (exitCode !== 0) {
        terminal = {
          code: "PROCESS_EXIT_NONZERO",
          message: "The local process exited unsuccessfully.",
        };
        finishError({ exitCode });
        return;
      }

      const stdout = stdoutText();
      const stderr = stderrText();
      let value;
      try {
        value = parseValue(stdout, output, jsonMode);
      } catch (cause) {
        terminal = {
          code: "PROCESS_INVALID_OUTPUT",
          message: "The local process returned invalid JSON output.",
        };
        finishError({ exitCode, cause });
        return;
      }

      const durationMs = elapsed();
      settled = true;
      cleanup();
      resolve({
        ok: true,
        operation,
        operationId,
        requestId,
        exitCode,
        stdout,
        stderr,
        durationMs,
        elapsedMs: durationMs,
        value,
      });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => beginTermination({
        code: "PROCESS_TIMEOUT",
        message: "The local process exceeded its timeout.",
        minimumElapsedMs: timeoutMs,
      }), timeoutMs);
    }

    // Abort may have raced with listener registration after the initial check.
    if (signal?.aborted) onAbort();
  });
}

export async function runLocalProcess(rawOptions) {
  const startedAt = performance.now();
  let options;
  try {
    options = normalizeOptions(rawOptions);
  } catch (cause) {
    throw cause;
  }

  let completion = {
    ok: false,
    operation: options.operation,
    operationId: options.operationId,
    requestId: options.requestId,
    durationMs: 0,
    elapsedMs: 0,
    code: "PROCESS_SPAWN_FAILED",
    exitCode: null,
  };

  emitProcessLog(options.logger, {
    timestamp: new Date().toISOString(),
    level: "info",
    pluginId: options.pluginId ?? "mashirobot-core",
    event: "process_start",
    message: options.operation,
    operation: options.operation,
    operationId: options.operationId,
    requestId: options.requestId,
  });

  try {
    const result = await executeProcess(options, startedAt);
    completion = {
      ok: true,
      operation: result.operation,
      operationId: result.operationId,
      requestId: result.requestId,
      durationMs: result.durationMs,
      elapsedMs: result.elapsedMs,
      code: "OK",
      exitCode: result.exitCode,
    };
    return result;
  } catch (error) {
    completion = {
      ok: false,
      operation: options.operation,
      operationId: options.operationId,
      requestId: options.requestId,
      durationMs: error?.durationMs ?? error?.elapsedMs
        ?? Math.max(0, Math.round(performance.now() - startedAt)),
      elapsedMs: error?.elapsedMs
        ?? Math.max(0, Math.round(performance.now() - startedAt)),
      code: error?.code ?? "PROCESS_SPAWN_FAILED",
      exitCode: error?.exitCode ?? null,
    };
    throw error;
  } finally {
    emitProcessLog(options.logger, {
      timestamp: new Date().toISOString(),
      level: completion.ok ? "info" : "error",
      pluginId: options.pluginId ?? "mashirobot-core",
      event: "process_complete",
      message: completion.code,
      operation: completion.operation,
      operationId: completion.operationId,
      requestId: completion.requestId,
      durationMs: completion.durationMs,
      exitCode: completion.exitCode,
      errorCode: completion.ok ? "" : completion.code,
    });
    if (typeof options.onComplete === "function") {
      try {
        await options.onComplete(completion);
      } catch {
        // Metrics and logging callbacks must never change the process result.
      }
    }
  }
}
