/**
 * CommandCodeAdapterV2 — orchestrator-v2 adapter for Command Code
 * (https://commandcode.ai), driving the `cmd acp` Agent Client Protocol
 * server over stdio.
 *
 * Command Code ships a full ACP server (`cmd acp`) that keeps the whole
 * harness — tools, skills, the permission engine, sessions and the model
 * catalog — while the ACP host (T3) owns the transport. We therefore reuse
 * the shared `makeAcpAdapterV2` harness rather than speaking a bespoke
 * protocol:
 *
 *   - One `cmd acp` process serves exactly one project directory, so the
 *     session is opened against the thread's `cwd`. A thread for a different
 *     directory gets its own process, matching how Zed runs one agent process
 *     per project window.
 *   - Sessions are real Command Code sessions with durable ids, so
 *     `nativeThreadRef` maps to the same transcript `cmd --resume` lists.
 *     Reopening a thread replays its transcript via `session/load`.
 *   - Modes map onto `default` / `auto-accept` / `plan` / `dont-ask` /
 *     `bypass`; the ACP engine reports the active mode back through session
 *     configuration updates.
 *
 * @module orchestration-v2/Adapters/CommandCodeAdapterV2
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  CommandCodeSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import * as EffectAcpErrors from "effect-acp/errors";

import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";

export const COMMAND_CODE_PROVIDER = ProviderDriverKind.make("commandcode");
const COMMAND_CODE_DRIVER_KIND = COMMAND_CODE_PROVIDER;
export const COMMAND_CODE_DEFAULT_INSTANCE_ID =
  defaultInstanceIdForDriver(COMMAND_CODE_DRIVER_KIND);
const DEFAULT_COMMAND_CODE_SETTINGS = Schema.decodeSync(CommandCodeSettings)({});

/**
 * Command Code's ACP surface plus the harness behavior documented for the
 * protocol server. Capabilities negotiated from `initialize` (model catalog,
 * `session/load`, fork) refine these at runtime.
 */
export const CommandCodeProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    // The model picker and the mode control are live over ACP.
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    // Every thread is a real session; reopening replays the transcript.
    canReadThreadSnapshot: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    // Servers configured in the editor are connected beside Command Code's
    // own MCP servers; the model sees one tool list.
    supportsMcpTools: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    // `todo_write` fills the plan view.
    emitsPlanUpdated: true,
    emitsTodoList: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CommandCodeAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CommandCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly attachmentsDir: string;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
}

/**
 * Maps T3's runtime policy onto Command Code's ACP session mode. Plan mode wins
 * because Command Code treats it as the interaction mode; the remaining modes
 * mirror the CLI's `--permission-mode` spellings.
 */
export function commandCodeSessionModeForPolicy(
  policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): string {
  if (policy.interactionMode === "plan") return "plan";
  switch (policy.runtimeMode) {
    case "full-access":
      return "bypass";
    case "auto-accept-edits":
    case "auto":
      return "auto-accept";
    case "approval-required":
      return "default";
  }
}

function commandCodeLaunchArgs(settings: CommandCodeSettings): ReadonlyArray<string> {
  const raw = settings.launchArgs.trim();
  return raw.length > 0 ? raw.split(/\s+/u) : [];
}

/** Spawns `cmd acp` against the thread's project directory. */
function makeCommandCodeAcpRuntime(options: CommandCodeAdapterV2Options) {
  return (
    input: AcpAdapterV2RuntimeInput,
  ): Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  > =>
    Effect.gen(function* () {
      const { processEnvironment, ...runtimeInput } = input;
      const env =
        processEnvironment === undefined
          ? options.environment
          : { ...options.environment, ...processEnvironment };
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          ...runtimeInput,
          // Command Code reads and writes through its own permission engine, so
          // grant the T3 attachments directory as an extra workspace root or it
          // cannot open pasted files referenced by absolute path.
          additionalDirectories: [options.attachmentsDir],
          spawn: {
            command: options.settings.binaryPath || "cmd",
            args: ["acp", ...commandCodeLaunchArgs(options.settings)],
            cwd: input.cwd,
            env,
          },
        }),
      );
      return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(context),
      );
    });
}

function makeCommandCodeAcpAdapterFlavor(options: CommandCodeAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: COMMAND_CODE_PROVIDER,
    runtimeHarness: "Command Code",
    capabilities: CommandCodeProviderCapabilitiesV2,
    makeRuntime: options.makeRuntime ?? makeCommandCodeAcpRuntime(options),
    sessionModeForPolicy: commandCodeSessionModeForPolicy,
    resolveModelId: (selection: ModelSelection) => selection.model,
    // Reopening a saved thread restores it without replaying the whole
    // transcript into the timeline; Command Code resumes faster that way.
    preferResumeSession: true,
    supportsCompaction: true,
  };
}

function makeCommandCodeAdapterV2(options: CommandCodeAdapterV2Options) {
  return makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCommandCodeAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
}

export type CommandCodeAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const CommandCodeAdapterV2Driver: ProviderAdapterDriver<
  CommandCodeSettings,
  CommandCodeAdapterV2DriverEnv
> = {
  driverKind: COMMAND_CODE_DRIVER_KIND,
  configSchema: CommandCodeSettings,
  defaultConfig: (): CommandCodeSettings => DEFAULT_COMMAND_CODE_SETTINGS,
  create: Effect.fn("CommandCodeAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CommandCodeSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const host = yield* ProviderHost.ProviderHost;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeCommandCodeAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        attachmentsDir: host.paths.attachmentsDir,
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: COMMAND_CODE_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: COMMAND_CODE_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Command Code ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
