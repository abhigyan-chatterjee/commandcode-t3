// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { ProviderAdapterError } from "../Errors.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import {
  makeCommandCodeAdapter,
  permissionModeArgsForRuntimeMode,
} from "../Layers/CommandCodeAdapter.ts";
import {
  parseCommandCodeAuthStatus,
  parseCommandCodeModelsCliOutput,
} from "../Layers/CommandCodeProvider.ts";

const threadId = ThreadId.make("commandcode-test-thread");

const makeScriptedSpawner = (options: {
  readonly stdout: ReadonlyArray<string>;
  readonly exitCode?: number;
  /** When set, the child's exit code only resolves once `kill` runs. */
  readonly exitOnKill?: number;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
}) => {
  let resolveExit: ((code: number) => void) | undefined;
  return ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) {
      return Effect.die("Command Code must be spawned as a standard command");
    }
    options.onSpawn?.(command);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode:
          options.exitOnKill !== undefined
            ? Effect.map(
                Effect.promise(
                  () =>
                    new Promise<number>((resolve) => {
                      resolveExit = resolve;
                    }),
                ),
                ChildProcessSpawner.ExitCode,
              )
            : Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.sync(() => resolveExit?.(options.exitOnKill ?? 0)),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(`${options.stdout.join("\n")}\n`)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
};

type ScriptedSpawner = ReturnType<typeof makeScriptedSpawner>;

const adapterLayer = (spawner: ScriptedSpawner) =>
  Layer.mergeAll(
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers),
  ).pipe(Layer.provideMerge(NodeServices.layer));

/** Collects exactly `count` runtime events from the adapter stream. */
const takeEvents = (
  adapter: {
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  },
  count: number,
): Effect.Effect<Array<ProviderRuntimeEvent>> =>
  adapter.streamEvents.pipe(Stream.take(count), Stream.runCollect);

const startSession = (adapter: {
  readonly startSession: (input: {
    readonly threadId: ThreadId;
    readonly runtimeMode: "full-access";
    readonly cwd: string;
  }) => Effect.Effect<ProviderSession, ProviderAdapterError>;
}) =>
  adapter.startSession({
    threadId,
    runtimeMode: "full-access",
    cwd: "/tmp/commandcode-adapter-test",
  });

it.effect("maps runtime modes and interaction modes onto permission flags", () =>
  Effect.sync(() => {
    expect(permissionModeArgsForRuntimeMode("approval-required", undefined)).toEqual([
      "--permission-mode",
      "default",
    ]);
    expect(permissionModeArgsForRuntimeMode("auto-accept-edits", undefined)).toEqual([
      "--permission-mode",
      "accept-edits",
    ]);
    expect(permissionModeArgsForRuntimeMode("auto", undefined)).toEqual([
      "--permission-mode",
      "accept-edits",
    ]);
    expect(permissionModeArgsForRuntimeMode("full-access", undefined)).toEqual([
      "--permission-mode",
      "yolo",
    ]);
    expect(permissionModeArgsForRuntimeMode("full-access", "plan")).toEqual([
      "--permission-mode",
      "plan",
    ]);
  }),
);

it.effect("runs a scripted headless turn and emits canonical events", () =>
  Effect.gen(function* () {
    const spawned: Array<ChildProcess.StandardCommand> = [];
    const spawner = makeScriptedSpawner({
      stdout: [
        '{"type":"event","event":{"type":"tool_running","toolCallId":"call-1","toolName":"shell_command","description":"ls -la"}}',
        '{"type":"event","event":{"type":"tool_completed","toolCallId":"call-1","toolName":"shell_command"}}',
        '{"type":"result","subtype":"success","sessionId":"sess-1234","stopReason":"end_turn","usage":{"input_tokens":120,"output_tokens":40},"finalText":"All done."}',
      ],
      onSpawn: (command) => spawned.push(command),
    });
    const adapter = yield* makeCommandCodeAdapter(
      { binaryPath: "cmd", launchArgs: "" },
      { instanceId: ProviderInstanceId.make("commandcode-test"), environment: {} },
    ).pipe(Effect.provide(adapterLayer(spawner)));

    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId, input: "list the files" });
    const events = yield* takeEvents(adapter, 11);

    expect(turn.threadId).toBe(threadId);
    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "turn.started",
      "session.state.changed",
      "item.started",
      "item.completed",
      "thread.started",
      "item.started",
      "content.delta",
      "item.completed",
      "turn.completed",
      "session.state.changed",
    ]);
    const turnCompleted = events.find((event) => event.type === "turn.completed");
    expect(turnCompleted).toMatchObject({
      payload: {
        state: "completed",
        stopReason: "end_turn",
        tokenUsage: {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 120,
          outputTokens: 40,
        },
      },
    });
    const toolItem = events.find(
      (event) => event.type === "item.started" && event.itemId !== undefined,
    );
    expect(toolItem).toMatchObject({
      payload: { itemType: "command_execution", status: "inProgress", title: "ls -la" },
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe("cmd");
    expect(spawned[0]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "yolo",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("resumes the captured session id on the next turn", () =>
  Effect.gen(function* () {
    const spawned: Array<ChildProcess.StandardCommand> = [];
    const resultLine =
      '{"type":"result","subtype":"success","sessionId":"sess-1234","finalText":"ok"}';
    const spawner = makeScriptedSpawner({
      stdout: [resultLine],
      onSpawn: (command) => spawned.push(command),
    });
    const adapter = yield* makeCommandCodeAdapter(
      { binaryPath: "cmd", launchArgs: "--no-auto-update" },
      { instanceId: ProviderInstanceId.make("commandcode-test"), environment: {} },
    ).pipe(Effect.provide(adapterLayer(spawner)));

    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId, input: "first" });
    yield* takeEvents(adapter, 7);
    yield* adapter.sendTurn({
      threadId,
      input: "second",
      modelSelection: {
        instanceId: ProviderInstanceId.make("commandcode-test"),
        model: "claude-sonnet-5",
        options: [],
      },
    });
    yield* takeEvents(adapter, 4);

    expect(spawned).toHaveLength(2);
    expect(spawned[1]?.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "yolo",
      "-m",
      "claude-sonnet-5",
      "--resume",
      "sess-1234",
      "--no-auto-update",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("fails the turn when Command Code exits without a result line", () =>
  Effect.gen(function* () {
    const spawner = makeScriptedSpawner({ stdout: [], exitCode: 1 });
    const adapter = yield* makeCommandCodeAdapter(
      { binaryPath: "cmd", launchArgs: "" },
      { instanceId: ProviderInstanceId.make("commandcode-test"), environment: {} },
    ).pipe(Effect.provide(adapterLayer(spawner)));

    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId, input: "hello" });
    const events = yield* takeEvents(adapter, 5);

    const turnCompleted = events.find((event) => event.type === "turn.completed");
    expect(turnCompleted).toMatchObject({
      payload: { state: "failed", stopReason: "exit_1" },
    });
  }).pipe(Effect.scoped),
);

it.effect("aborts an active turn on interrupt", () =>
  Effect.gen(function* () {
    const spawner = makeScriptedSpawner({
      stdout: ['{"type":"event","event":{"type":"unknown_frame"}}'],
      exitOnKill: 130,
    });
    const adapter = yield* makeCommandCodeAdapter(
      { binaryPath: "cmd", launchArgs: "" },
      { instanceId: ProviderInstanceId.make("commandcode-test"), environment: {} },
    ).pipe(Effect.provide(adapterLayer(spawner)));

    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId, input: "long running" });
    yield* takeEvents(adapter, 3);
    yield* adapter.interruptTurn(threadId, turn.turnId);
    const events = yield* takeEvents(adapter, 1);

    expect(events[0]).toMatchObject({
      type: "turn.aborted",
      turnId: turn.turnId,
      payload: { reason: "interrupted" },
    });
    const sessions = yield* adapter.listSessions();
    expect(sessions[0]?.activeTurnId).toBeUndefined();
  }).pipe(Effect.scoped),
);

it.effect("rejects an overlapping sendTurn", () =>
  Effect.gen(function* () {
    const spawner = makeScriptedSpawner({
      stdout: ['{"type":"event","event":{"type":"unknown_frame"}}'],
      exitOnKill: 130,
    });
    const adapter = yield* makeCommandCodeAdapter(
      { binaryPath: "cmd", launchArgs: "" },
      { instanceId: ProviderInstanceId.make("commandcode-test"), environment: {} },
    ).pipe(Effect.provide(adapterLayer(spawner)));

    yield* startSession(adapter);
    yield* adapter.sendTurn({ threadId, input: "long running" });
    yield* takeEvents(adapter, 2);
    const second = yield* Effect.exit(adapter.sendTurn({ threadId, input: "overlapping" }));
    expect(second._tag).toBe("Failure");
    yield* adapter.stopSession(threadId);
  }).pipe(Effect.scoped),
);

it.effect("tracks turns for readThread", () =>
  Effect.gen(function* () {
    const spawner = makeScriptedSpawner({
      stdout: ['{"type":"result","subtype":"success","sessionId":"sess-read","finalText":"reply"}'],
    });
    const adapter = yield* makeCommandCodeAdapter(
      { binaryPath: "cmd", launchArgs: "" },
      { instanceId: ProviderInstanceId.make("commandcode-test"), environment: {} },
    ).pipe(Effect.provide(adapterLayer(spawner)));

    yield* startSession(adapter);
    const turn = yield* adapter.sendTurn({ threadId, input: "hello" });
    yield* takeEvents(adapter, 7);
    const snapshot = yield* adapter.readThread(threadId);

    expect(snapshot.turns).toHaveLength(1);
    expect(snapshot.turns[0]?.id).toBe(turn.turnId);
    const items = snapshot.turns[0]?.items ?? [];
    expect(items).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it("parses `cmd --list-models` output defensively", () => {
  const parsed = parseCommandCodeModelsCliOutput(
    [
      "You are logged in.",
      "Available models:",
      "  * claude-sonnet-5 (default)",
      "  * gpt-6-astra",
      "  - deepseek/deepseek-v4-pro",
      "",
    ].join("\n"),
  );
  expect(parsed.authenticated).toBe(true);
  expect(parsed.models.map((model) => model.slug)).toEqual([
    "claude-sonnet-5",
    "gpt-6-astra",
    "deepseek/deepseek-v4-pro",
  ]);
  expect(parsed.models[0]?.isDefault).toBe(true);
});

it("parses `cmd status` login state", () => {
  expect(parseCommandCodeAuthStatus("Logged in as abhi@example.com")).toMatchObject({
    status: "authenticated",
  });
  expect(parseCommandCodeAuthStatus("Not logged in. Run `cmd login`.")).toEqual({
    status: "unauthenticated",
  });
  expect(parseCommandCodeAuthStatus("something unexpected")).toEqual({ status: "unknown" });
});
