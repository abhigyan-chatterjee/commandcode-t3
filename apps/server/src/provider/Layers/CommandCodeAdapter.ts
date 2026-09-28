/**
 * CommandCodeAdapter — headless turn runtime for the Command Code CLI.
 *
 * Command Code has no long-lived RPC server and no SDK, so every turn is one
 * `cmd -p --output-format json` child process: the prompt arrives on stdin,
 * stdout is an NDJSON stream of event frames, and the final line is a result
 * object carrying `sessionId`, `stopReason`, and `usage`. Sessions persist
 * per-turn in `~/.commandcode`, so resume is `--resume <id>` on the next turn.
 *
 * The adapter holds threads in memory only; Command Code owns the durable
 * transcript on disk.
 *
 * @module provider/Layers/CommandCodeAdapter
 */
import {
  EventId,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  ProviderInstanceId,
  RuntimeItemId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess } from "effect/unstable/process";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER: ProviderDriverKind = ProviderDriverKind.make("commandcode");

/** SIGTERM grace before interrupt escalates. Command Code commits turns
    atomically, so an interrupted turn is simply never written. */
const INTERRUPT_FORCE_KILL_AFTER = "3 seconds" as const;

export interface CommandCodeAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly nativeEventLogger?: EventNdjsonLogger | undefined;
}

interface TrackedItem {
  readonly itemId: string;
  readonly payload: unknown;
}

interface CommandCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

interface CommandCodeSessionRecord {
  session: ProviderSession;
  readonly env: NodeJS.ProcessEnv;
  /** Command Code's own session id, resolved from the first result line. */
  commandCodeSessionId: string | undefined;
  activeTurnId: TurnId | undefined;
  turnFiber: Fiber.Fiber<void, never> | undefined;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  turnFinished: boolean;
  turns: Array<CommandCodeTurnSnapshot>;
  currentItems: Array<TrackedItem>;
}

interface CommandCodeResultLine {
  readonly type: "result";
  readonly subtype?: unknown;
  readonly sessionId?: unknown;
  readonly stopReason?: unknown;
  readonly usage?: unknown;
  readonly finalText?: unknown;
  readonly error?: unknown;
}

/** The canonical event union minus the fields the adapter stamps itself. */
type RuntimeEventInput = {
  readonly [T in ProviderRuntimeEvent as T["type"]]: Omit<
    T,
    "eventId" | "createdAt" | "provider" | "threadId" | "providerInstanceId"
  >;
}[ProviderRuntimeEvent["type"]];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

type ToolItemType =
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "web_search"
  | "dynamic_tool_call";

function itemTypeForToolName(toolName: string): ToolItemType {
  const name = toolName.toLowerCase();
  if (
    name === "shell_command" ||
    name === "monitor_command" ||
    name === "kill_shell" ||
    name === "bash" ||
    name === "run_command"
  ) {
    return "command_execution";
  }
  if (name === "edit_file" || name === "write_file" || name === "edit" || name === "write") {
    return "file_change";
  }
  if (name.startsWith("mcp__")) {
    return "mcp_tool_call";
  }
  if (name === "web_search" || name === "webfetch" || name === "web_fetch") {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function tokenUsageFromUsage(usage: unknown) {
  if (!isRecord(usage)) return undefined;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  const cached = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens;
  const creation = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  return {
    usageScope: "main_agent" as const,
    hasSubagents: false,
    usageStatus: "complete" as const,
    inputTokens: Math.max(0, Math.floor(input)),
    outputTokens: Math.max(0, Math.floor(output)),
    ...(typeof cached === "number" ? { cachedInputTokens: Math.max(0, Math.floor(cached)) } : {}),
    ...(typeof creation === "number"
      ? { cacheCreationTokens: Math.max(0, Math.floor(creation)) }
      : {}),
  };
}

/** Maps a T3 runtime mode onto Command Code's `--permission-mode` spelling.
    `auto` has no dedicated Command Code mode, so it maps to accept-edits. */
export function permissionModeArgsForRuntimeMode(
  runtimeMode: ProviderSessionStartInput["runtimeMode"],
  interactionMode: ProviderSendTurnInput["interactionMode"],
): ReadonlyArray<string> {
  if (interactionMode === "plan") {
    return ["--permission-mode", "plan"];
  }
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "default"];
    case "auto-accept-edits":
    case "auto":
      return ["--permission-mode", "accept-edits"];
    case "full-access":
      return ["--permission-mode", "yolo"];
  }
}

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (
  commandCodeSettings: { readonly binaryPath: string; readonly launchArgs: string },
  options: CommandCodeAdapterOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, CommandCodeSessionRecord>();
  const instanceId = options.instanceId;
  const nativeEventLogger = options.nativeEventLogger;
  const environment = options.environment ?? process.env;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate a Command Code runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const decodeJsonLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

  const logNativeEvent = (threadId: ThreadId, method: string, payload: unknown) =>
    Effect.gen(function* () {
      if (!nativeEventLogger) return;
      const observedAt = yield* nowIso;
      yield* nativeEventLogger.write(
        {
          observedAt,
          event: {
            id: yield* randomUUIDv4,
            kind: "notification",
            provider: PROVIDER,
            createdAt: observedAt,
            method,
            threadId,
            payload,
          },
        },
        threadId,
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to write native Command Code notification log.", {
          cause,
          threadId,
          method,
        }),
      ),
    );

  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const emitEvent = Effect.fn("CommandCodeAdapter.emitEvent")(function* (
    record: CommandCodeSessionRecord,
    event: RuntimeEventInput,
  ) {
    const full = {
      eventId: yield* nextEventId,
      provider: PROVIDER,
      ...(instanceId ? { providerInstanceId: instanceId } : {}),
      threadId: record.session.threadId,
      createdAt: yield* nowIso,
      ...event,
    } as ProviderRuntimeEvent;
    yield* emit(full);
  });

  const launchArgs =
    commandCodeSettings.launchArgs.trim().length > 0
      ? commandCodeSettings.launchArgs.trim().split(/\s+/u)
      : [];

  const spawnTurn = (record: CommandCodeSessionRecord, input: ProviderSendTurnInput) =>
    Effect.gen(function* () {
      const prompt = input.input ?? "";
      const model = input.modelSelection?.model;
      const permissionArgs = permissionModeArgsForRuntimeMode(
        record.session.runtimeMode,
        input.interactionMode,
      );
      const args = [
        "-p",
        "--output-format",
        "json",
        ...permissionArgs,
        ...(model ? ["-m", model] : []),
        ...(record.commandCodeSessionId ? ["--resume", record.commandCodeSessionId] : []),
        ...launchArgs,
      ];
      const binary = commandCodeSettings.binaryPath || "cmd";
      const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: record.env });
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: record.env,
        cwd: record.session.cwd ?? process.cwd(),
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });
      return yield* spawner.spawn(command);
    });

  const emitItemEvent = Effect.fn("CommandCodeAdapter.emitItemEvent")(function* (
    record: CommandCodeSessionRecord,
    turnId: TurnId,
    lifecycle: "item.started" | "item.updated" | "item.completed",
    itemId: string,
    payload: {
      itemType: ToolItemType | "assistant_message";
      status?: "inProgress" | "completed" | "failed" | undefined;
      title?: string | undefined;
    },
  ) {
    yield* emitEvent(record, {
      type: lifecycle,
      turnId,
      itemId: RuntimeItemId.make(itemId),
      payload,
    });
    if (lifecycle === "item.started") {
      record.currentItems.push({ itemId, payload });
      return;
    }
    const index = record.currentItems.findIndex((entry) => entry.itemId === itemId);
    if (index >= 0) {
      record.currentItems[index] = { itemId, payload };
    } else {
      record.currentItems.push({ itemId, payload });
    }
  });

  const handleTurnLine = Effect.fn("CommandCodeAdapter.handleTurnLine")(function* (
    record: CommandCodeSessionRecord,
    turnId: TurnId,
    resultRef: Ref.Ref<CommandCodeResultLine | undefined>,
    line: string,
  ) {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    const parsedOption = yield* decodeJsonLine(trimmed).pipe(Effect.option);
    if (Option.isNone(parsedOption)) {
      // Torn or non-JSON output is ignored; the stream stays machine-readable.
      return;
    }
    const parsed: unknown = parsedOption.value;
    if (!isRecord(parsed)) return;

    if (parsed.type === "result") {
      yield* Ref.set(resultRef, parsed as unknown as CommandCodeResultLine);
      return;
    }
    if (parsed.type !== "event") return;
    const frame = parsed.event;
    if (!isRecord(frame)) return;

    // Headless frames are tool-granularity; unknown frame types are treated as
    // forward-compatible and ignored (Command Code headless docs).
    if (frame.type === "tool_running") {
      const toolCallId = nonEmptyString(frame.toolCallId) ?? (yield* randomUUIDv4);
      const toolName = nonEmptyString(frame.toolName) ?? "tool";
      const title = nonEmptyString(frame.description);
      yield* emitItemEvent(record, turnId, "item.started", toolCallId, {
        itemType: itemTypeForToolName(toolName),
        status: "inProgress",
        ...(title ? { title } : {}),
      });
      return;
    }
    if (frame.type === "tool_completed" || frame.type === "tool_finished") {
      const toolCallId = nonEmptyString(frame.toolCallId);
      if (!toolCallId) return;
      yield* emitItemEvent(record, turnId, "item.completed", toolCallId, {
        itemType: itemTypeForToolName(nonEmptyString(frame.toolName) ?? "tool"),
        status: "completed",
      });
      return;
    }
    yield* logNativeEvent(
      record.session.threadId,
      `commandcode.frame.${String(frame.type)}`,
      frame,
    );
  });

  const settleSessionAfterTurn = (
    record: CommandCodeSessionRecord,
    status: "ready" | "error",
    updatedAt: string,
  ) => {
    record.activeTurnId = undefined;
    record.child = undefined;
    record.turnFiber = undefined;
    record.session = {
      ...record.session,
      status,
      activeTurnId: undefined,
      updatedAt,
    };
  };

  const finalizeTurn = Effect.fn("CommandCodeAdapter.finalizeTurn")(function* (
    record: CommandCodeSessionRecord,
    turnId: TurnId,
    resultRef: Ref.Ref<CommandCodeResultLine | undefined>,
    exitCode: number,
  ) {
    if (record.turnFinished) return;
    record.turnFinished = true;
    const result = yield* Ref.get(resultRef);

    const sessionId = nonEmptyString(result?.sessionId);
    if (sessionId && !record.commandCodeSessionId) {
      record.commandCodeSessionId = sessionId;
      yield* emitEvent(record, {
        type: "thread.started",
        turnId,
        payload: { providerThreadId: sessionId },
      });
    }

    // The final answer arrives as the result line's `finalText`; surface it as
    // one assistant message so the thread timeline shows the reply.
    if (result) {
      const finalText = typeof result.finalText === "string" ? result.finalText : "";
      const assistantItemId = `assistant-${turnId}`;
      yield* emitItemEvent(record, turnId, "item.started", assistantItemId, {
        itemType: "assistant_message",
        status: "inProgress",
      });
      if (finalText.length > 0) {
        yield* emitEvent(record, {
          type: "content.delta",
          turnId,
          itemId: RuntimeItemId.make(assistantItemId),
          payload: { streamKind: "assistant_text", delta: finalText },
        });
      }
      yield* emitItemEvent(record, turnId, "item.completed", assistantItemId, {
        itemType: "assistant_message",
        status: "completed",
      });
    }

    const subtype = nonEmptyString(result?.subtype);
    const tokenUsage = tokenUsageFromUsage(result?.usage);
    if (subtype === "success" || subtype === "max_turns") {
      yield* emitEvent(record, {
        type: "turn.completed",
        turnId,
        payload: {
          state: "completed",
          stopReason:
            subtype === "max_turns"
              ? "max_turns"
              : (nonEmptyString(result?.stopReason) ?? "end_turn"),
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      });
    } else {
      yield* emitEvent(record, {
        type: "turn.completed",
        turnId,
        payload: {
          state: "failed",
          stopReason: subtype ?? `exit_${exitCode}`,
          errorMessage:
            nonEmptyString(result?.error) ??
            (subtype === "error"
              ? "Command Code run failed. See the server log for stderr."
              : `Command Code exited with code ${exitCode} before completing the turn.`),
        },
      });
    }

    record.turns.push({
      id: turnId,
      items: record.currentItems.map((entry) => entry.payload),
    });
    record.currentItems = [];
    const failed = subtype !== "success" && subtype !== "max_turns";
    settleSessionAfterTurn(record, failed ? "error" : "ready", yield* nowIso);
    yield* emitEvent(record, {
      type: "session.state.changed",
      payload: {
        state: failed ? "error" : "ready",
        ...(failed && subtype ? { reason: subtype } : {}),
      },
    });
  });

  const runTurn = (
    record: CommandCodeSessionRecord,
    input: ProviderSendTurnInput,
    turnId: TurnId,
  ) =>
    Effect.gen(function* () {
      const resultRef = yield* Ref.make<CommandCodeResultLine | undefined>(undefined);
      // The scoped body owns the child process lifetime: the scope closes as
      // soon as the streams drain and the exit code resolves.
      const outcome = yield* Effect.gen(function* () {
        const child = yield* spawnTurn(record, input);
        record.child = child;
        yield* emitEvent(record, {
          type: "session.state.changed",
          payload: { state: "running" },
        });
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => handleTurnLine(record, turnId, resultRef, line)),
        );
        return yield* child.exitCode.pipe(Effect.map(Number));
      }).pipe(Effect.scoped, Effect.exit);
      if (Exit.isSuccess(outcome)) {
        yield* finalizeTurn(record, turnId, resultRef, outcome.value);
      } else if (!record.turnFinished) {
        // The turn fiber must never die silently: a spawn failure or stream
        // error still has to complete the turn so orchestration settles it.
        record.turnFinished = true;
        record.turns.push({
          id: turnId,
          items: record.currentItems.map((entry) => entry.payload),
        });
        record.currentItems = [];
        settleSessionAfterTurn(record, "error", yield* nowIso);
        yield* emitEvent(record, {
          type: "turn.completed",
          turnId,
          payload: {
            state: "failed",
            errorMessage: "Command Code turn failed before completing.",
          },
        });
      }
    }).pipe(Effect.ignore);

  const startSession = (
    input: ProviderSessionStartInput,
  ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const session: ProviderSession = {
        provider: PROVIDER,
        ...(instanceId ? { providerInstanceId: instanceId } : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        threadId: input.threadId,
        createdAt: now,
        updatedAt: now,
      };
      const record: CommandCodeSessionRecord = {
        session,
        env: environment,
        commandCodeSessionId:
          isRecord(input.resumeCursor) &&
          typeof input.resumeCursor.commandCodeSessionId === "string"
            ? input.resumeCursor.commandCodeSessionId
            : undefined,
        activeTurnId: undefined,
        turnFiber: undefined,
        child: undefined,
        turnFinished: true,
        turns: [],
        currentItems: [],
      };
      sessions.set(input.threadId, record);
      yield* emitEvent(record, {
        type: "session.started",
        payload: {
          message: record.commandCodeSessionId
            ? `Resuming Command Code session ${record.commandCodeSessionId}`
            : "Command Code session ready",
          ...(record.commandCodeSessionId ? { resume: record.commandCodeSessionId } : {}),
        },
      });
      return record.session;
    });

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<CommandCodeSessionRecord, ProviderAdapterError> =>
    Effect.gen(function* () {
      const record = sessions.get(threadId);
      if (!record) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (record.session.status === "closed") {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return record;
    });

  const sendTurn = (
    input: ProviderSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
    Effect.gen(function* () {
      const record = yield* requireSession(input.threadId);
      if (record.activeTurnId !== undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "sendTurn",
          detail:
            "A Command Code turn is already running in this thread. Command Code runs one headless turn at a time.",
        });
      }
      const turnId = TurnId.make(yield* randomUUIDv4);
      record.activeTurnId = turnId;
      record.turnFinished = false;
      record.currentItems = [];
      record.session = {
        ...record.session,
        status: "running",
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        activeTurnId: turnId,
        updatedAt: yield* nowIso,
      };
      yield* emitEvent(record, {
        type: "turn.started",
        turnId,
        payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
      });
      const fiber = yield* Effect.forkDetach(runTurn(record, input, turnId));
      record.turnFiber = fiber;
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: record.commandCodeSessionId
          ? { commandCodeSessionId: record.commandCodeSessionId }
          : undefined,
      };
    });

  const interruptTurn = (
    threadId: ThreadId,
    turnId?: TurnId,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      if (
        record.activeTurnId === undefined ||
        record.child === undefined ||
        (turnId !== undefined && turnId !== record.activeTurnId)
      ) {
        return;
      }
      const interruptedTurnId = record.activeTurnId;
      record.turnFinished = true;
      record.turns.push({
        id: interruptedTurnId,
        items: record.currentItems.map((entry) => entry.payload),
      });
      record.currentItems = [];
      yield* record.child.kill({ forceKillAfter: INTERRUPT_FORCE_KILL_AFTER }).pipe(Effect.ignore);
      yield* emitEvent(record, {
        type: "turn.aborted",
        turnId: interruptedTurnId,
        payload: { reason: "interrupted" },
      });
      settleSessionAfterTurn(record, "ready", yield* nowIso);
    });

  const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      if (record.child !== undefined) {
        yield* record.child
          .kill({ forceKillAfter: INTERRUPT_FORCE_KILL_AFTER })
          .pipe(Effect.ignore);
      }
      if (record.turnFiber !== undefined) {
        yield* Fiber.interrupt(record.turnFiber).pipe(Effect.ignore);
      }
      sessions.delete(threadId);
      yield* emitEvent(record, {
        type: "session.exited",
        payload: { exitKind: "graceful", reason: "stopped" },
      });
    });

  const stopAll = (): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Copy the keys: stopSession mutates the map during iteration.
      for (const threadId of Array.from(sessions.keys())) {
        yield* stopSession(threadId).pipe(Effect.ignore);
      }
    });

  const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => [...sessions.values()].map((record) => record.session));

  const hasSession = (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId));

  const readThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const record = yield* requireSession(threadId);
      return {
        threadId,
        turns: record.turns.map((turn) => ({ id: turn.id, items: turn.items })),
      };
    });

  const rollbackThread = (
    threadId: ThreadId,
    _numTurns: number,
  ): Effect.Effect<never, ProviderAdapterError> =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: "Command Code conversation rollback is not supported by the headless driver yet.",
      });
    });

  const respondToRequest = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail:
          "Command Code runs headless with a start-of-turn permission mode; there is no mid-turn approval to answer.",
      });
    });

  const respondToUserInput = (
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ): Effect.Effect<void, ProviderAdapterError> =>
    Effect.gen(function* () {
      yield* requireSession(threadId);
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: "Command Code headless runs cannot answer interactive questions.",
      });
    });

  const capabilities = {
    sessionModelSwitch: "in-session",
    supportsConversationRollback: false,
  } as const;

  return {
    provider: PROVIDER,
    capabilities,
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEventQueue),
  } as const;
});
