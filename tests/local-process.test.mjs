import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  LocalProcessError,
  runLocalProcess,
} from "../core/execution/local-process.mjs";

function createFakeChild({ pid = 41_234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

test("returns text, bounded streams, and elapsed time", async () => {
  const result = await runLocalProcess({
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write('hello'); process.stderr.write('note')",
    ],
    output: "text",
    timeoutMs: 2_000,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "note");
  assert.equal(result.value, "hello");
  assert.equal(typeof result.operationId, "string");
  assert.ok(result.operationId.length > 0);
  assert.ok(result.elapsedMs >= 0);
});

test("returns parsed JSON documents", async () => {
  const result = await runLocalProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ok:true,count:2}))"],
    output: "json",
    timeoutMs: 2_000,
  });

  assert.deepEqual(result.value, { ok: true, count: 2 });
});

test("parses the last non-empty line only when last-line JSON mode is explicit", async () => {
  const result = await runLocalProcess({
    executable: process.execPath,
    args: [
      "-e",
      "process.stdout.write('diagnostic\\n' + JSON.stringify({ok:true}) + '\\n')",
    ],
    output: "json",
    jsonMode: "last-line",
    timeoutMs: 2_000,
  });

  assert.deepEqual(result.value, { ok: true });

  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('diagnostic\\n{\\\"ok\\\":true}')"],
      output: "json",
      jsonMode: "document",
      timeoutMs: 2_000,
    }),
    (error) => error instanceof LocalProcessError
      && error.code === "PROCESS_INVALID_OUTPUT",
  );
});

test("rejects nonzero exits with stable, inspectable details", async () => {
  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      args: [
        "-e",
        "process.stdout.write('partial'); process.stderr.write('failed'); process.exit(7)",
      ],
      operationId: "nonzero-operation",
      timeoutMs: 2_000,
    }),
    (error) => {
      assert.ok(error instanceof LocalProcessError);
      assert.equal(error.code, "PROCESS_EXIT_NONZERO");
      assert.equal(error.operationId, "nonzero-operation");
      assert.equal(error.exitCode, 7);
      assert.equal(error.stdout, "partial");
      assert.equal(error.stderr, "failed");
      assert.ok(error.elapsedMs >= 0);
      return true;
    },
  );
});

test("turns synchronous spawn failures into PROCESS_SPAWN_FAILED", async () => {
  let killCount = 0;
  await assert.rejects(
    runLocalProcess({
      executable: "missing-program",
      spawnImpl() {
        throw new Error("spawn unavailable");
      },
      operationId: "spawn-operation",
      killTreeImpl: async () => {
        killCount += 1;
      },
    }),
    (error) => error instanceof LocalProcessError
      && error.code === "PROCESS_SPAWN_FAILED"
      && error.operationId === "spawn-operation"
      && error.exitCode === null,
  );
  assert.equal(killCount, 0);
});

test("cleans up a live child after an asynchronous child error and waits for close", async () => {
  const child = createFakeChild();
  const cause = new Error("live child failed");
  let killCount = 0;
  let observed;
  const completions = [];
  const promise = runLocalProcess({
    executable: "program.exe",
    spawnImpl: () => child,
    killTreeImpl: async (target) => {
      killCount += 1;
      assert.equal(target, child);
    },
    onComplete: (event) => completions.push(event),
  });
  promise.then(
    () => { observed = "resolved"; },
    () => { observed = "rejected"; },
  );
  child.emit("error", cause);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(killCount, 1);
  assert.equal(observed, undefined, "must wait for child close after cleanup");
  child.emit("close", null, "SIGKILL");
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof LocalProcessError);
    assert.equal(error.code, "PROCESS_SPAWN_FAILED");
    assert.equal(error.cause, cause);
    return true;
  });
  child.emit("error", new Error("late duplicate error"));
  assert.equal(killCount, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].code, "PROCESS_SPAWN_FAILED");
});

for (const streamName of ["stdout", "stderr"]) {
  test(`cleans up a live child after ${streamName} stream error`, async () => {
    const child = createFakeChild();
    const cause = new Error(`${streamName} failed`);
    let killCount = 0;
    let observed;
    const completions = [];
    const promise = runLocalProcess({
      executable: "program.exe",
      spawnImpl: () => child,
      killTreeImpl: async () => {
        killCount += 1;
      },
      onComplete: (event) => completions.push(event),
    });
    promise.then(
      () => { observed = "resolved"; },
      () => { observed = "rejected"; },
    );

    child[streamName].emit("error", cause);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(killCount, 1);
    assert.equal(observed, undefined, "must wait for child close after cleanup");

    child.emit("close", null, "SIGKILL");
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, "PROCESS_SPAWN_FAILED");
      assert.equal(error.cause, cause);
      return true;
    });
    assert.equal(killCount, 1);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].code, "PROCESS_SPAWN_FAILED");
  });
}

test("kills a timed-out process and reports elapsed time", async () => {
  let killCount = 0;
  const child = createFakeChild();
  const promise = runLocalProcess({
    executable: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    timeoutMs: 40,
    spawnImpl: () => child,
    killTreeImpl: async (target) => {
      killCount += 1;
      assert.equal(target, child);
      target.emit("close", null, "SIGKILL");
    },
  });

  await assert.rejects(
    promise,
    (error) => error.code === "PROCESS_TIMEOUT" && error.elapsedMs >= 40,
  );
  assert.equal(killCount, 1);
});

test("settles after a bounded kill grace period when close never arrives", async () => {
  const child = createFakeChild();
  const startedAt = Date.now();

  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      timeoutMs: 10,
      spawnImpl: () => child,
      killTreeImpl: async () => {},
    }),
    (error) => error.code === "PROCESS_TIMEOUT",
  );

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 900, `expected kill grace, received ${elapsed}ms`);
  assert.ok(elapsed < 2_000, `kill grace was not bounded: ${elapsed}ms`);
});

test("honors external AbortSignal, including an already-aborted signal", async () => {
  const controller = new AbortController();
  const child = createFakeChild();
  let spawnCount = 0;
  let killCount = 0;
  const promise = runLocalProcess({
    executable: process.execPath,
    signal: controller.signal,
    spawnImpl: () => {
      spawnCount += 1;
      return child;
    },
    killTreeImpl: async (target) => {
      killCount += 1;
      target.emit("close", null, "SIGKILL");
    },
  });
  controller.abort();

  await assert.rejects(promise, (error) => error.code === "PROCESS_ABORTED");
  assert.equal(spawnCount, 1);
  assert.equal(killCount, 1);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      signal: preAborted.signal,
      spawnImpl: () => {
        throw new Error("must not spawn");
      },
    }),
    (error) => error.code === "PROCESS_ABORTED",
  );
});

for (const streamName of ["stdout", "stderr"]) {
  test(`rejects ${streamName} beyond its byte bound without retaining excess`, async () => {
    const optionName = streamName === "stdout"
      ? "maxStdoutBytes"
      : "maxStderrBytes";
    const script = streamName === "stdout"
      ? "process.stdout.write(Buffer.alloc(2048, 120)); setInterval(()=>{},1000)"
      : "process.stderr.write(Buffer.alloc(2048, 121)); setInterval(()=>{},1000)";

    await assert.rejects(
      runLocalProcess({
        executable: process.execPath,
        args: ["-e", script],
        [optionName]: 1_024,
        timeoutMs: 2_000,
      }),
      (error) => {
        assert.equal(error.code, "PROCESS_OUTPUT_LIMIT");
        assert.ok(Buffer.byteLength(error[streamName], "utf8") <= 1_024);
        return true;
      },
    );
  });
}

test("counts raw bytes before UTF-8 decoding", async () => {
  await assert.rejects(
    runLocalProcess({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('你你')"],
      maxStdoutBytes: 3,
      timeoutMs: 2_000,
    }),
    (error) => error.code === "PROCESS_OUTPUT_LIMIT"
      && error.stdout === "你"
      && Buffer.byteLength(error.stdout, "utf8") === 3,
  );
});

test("settles and calls onComplete exactly once when timeout, error, and close race", async () => {
  const child = createFakeChild();
  let killCount = 0;
  const completions = [];
  const promise = runLocalProcess({
    executable: process.execPath,
    timeoutMs: 10,
    spawnImpl: () => child,
    killTreeImpl: async (target) => {
      killCount += 1;
      target.emit("error", new Error("late child error"));
      target.emit("close", null, "SIGKILL");
      target.emit("close", null, "SIGKILL");
    },
    onComplete: (event) => completions.push(event),
  });

  await assert.rejects(promise, (error) => error.code === "PROCESS_TIMEOUT");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(killCount, 1);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].code, "PROCESS_TIMEOUT");
  assert.equal(completions[0].exitCode, null);
  assert.deepEqual(
    Object.keys(completions[0]).sort(),
    ["code", "elapsedMs", "exitCode", "operationId"],
  );
});

test("calls onComplete once for success and ignores callback failures", async () => {
  const completions = [];
  const result = await runLocalProcess({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('ok')"],
    onComplete(event) {
      completions.push(event);
      throw new Error("telemetry unavailable");
    },
  });

  assert.equal(result.value, "ok");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].code, "OK");
  assert.equal(completions[0].exitCode, 0);
});

test("never enables a shell for the target process", async () => {
  const child = createFakeChild();
  let received;
  const promise = runLocalProcess({
    executable: "program.exe",
    args: ["one", "two"],
    spawnImpl(executable, args, options) {
      received = { executable, args, options };
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });

  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.equal(received.executable, "program.exe");
  assert.deepEqual(received.args, ["one", "two"]);
  assert.equal(received.options.shell, false);
  assert.equal(received.options.windowsHide, true);
});

test("Windows default tree cleanup uses taskkill /T /F without a shell", {
  skip: process.platform !== "win32",
}, async () => {
  const target = createFakeChild({ pid: 54_321 });
  const taskkill = createFakeChild({ pid: 54_322 });
  const invocations = [];

  const promise = runLocalProcess({
    executable: "program.exe",
    timeoutMs: 10,
    spawnImpl(executable, args, options) {
      invocations.push({ executable, args, options });
      if (executable === "taskkill.exe") {
        queueMicrotask(() => {
          taskkill.emit("close", 0, null);
          target.emit("close", null, "SIGKILL");
        });
        return taskkill;
      }
      return target;
    },
  });

  await assert.rejects(promise, (error) => error.code === "PROCESS_TIMEOUT");
  assert.equal(invocations.length, 2);
  assert.equal(invocations[1].executable, "taskkill.exe");
  assert.deepEqual(invocations[1].args, ["/PID", "54321", "/T", "/F"]);
  assert.equal(invocations[1].options.shell, false);
  assert.equal(invocations[1].options.windowsHide, true);
});
