/**
 * CommandCodeProvider — status probes for the Command Code CLI (`cmd`).
 *
 * All probes are side-effect free: `cmd --version` for the binary, `cmd status`
 * for auth, and `cmd --list-models` for the model catalog. None of them open a
 * session, run hooks, or start MCP servers.
 *
 * @module provider/Layers/CommandCodeProvider
 */
import type {
  CommandCodeSettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const COMMAND_CODE_PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const MODELS_PROBE_TIMEOUT_MS = 10_000;

const COMMAND_CODE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "gpt-6-astra",
    name: "GPT-6 Astra",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function commandCodeModelsFromSettings(
  customModels: CommandCodeSettings["customModels"],
  builtInModels: ReadonlyArray<ServerProviderModel> = COMMAND_CODE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

const runCommandCodeCliCommand = (
  commandCodeSettings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = commandCodeSettings.binaryPath || "cmd";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export interface CommandCodeModelsCliOutput {
  /** True or false when the CLI printed a login line, null when it printed neither. */
  readonly authenticated: boolean | null;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

const HEADER_WORDS = new Set([
  "model",
  "models",
  "name",
  "id",
  "slug",
  "available",
  "default",
  "provider",
  "status",
  "context",
  "effort",
]);

const looksLikeModelSlug = (token: string): boolean =>
  token.length > 1 &&
  !token.startsWith("-") &&
  !token.startsWith("@t3") &&
  (token.includes("/") || token.includes("-") || token.includes(".")) &&
  !HEADER_WORDS.has(token.toLowerCase());

function modelFromSlug(slug: string): ServerProviderModel {
  const tail = slug.split("/").pop() ?? slug;
  const name =
    tail
      .split(/[-_.]/g)
      .map((part) => (/^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ")
      .trim() || slug;
  return {
    slug,
    name,
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  };
}

/**
 * Parses `cmd --list-models`. Only lines that plausibly name a model are
 * trusted: bullet entries (`* slug`, `- slug`), and table rows whose first
 * column looks like a model id. A `(default)` marker marks the default.
 * The command's exact layout is not guaranteed, so anything unparseable
 * yields an empty list rather than invented slugs.
 */
export function parseCommandCodeModelsCliOutput(output: string): CommandCodeModelsCliOutput {
  const authenticated =
    /logged in|authenticated|signed in/i.test(output) &&
    !/not logged in|not authenticated|unauthenticated|logged out/i.test(output)
      ? true
      : /not logged in|not authenticated|unauthenticated|logged out/i.test(output)
        ? false
        : null;

  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const line of output.split(/\r?\n/)) {
    const bullet = line.match(/^\s*[*\-•]\s+(\S+)(.*)$/);
    const bulletSlug = bullet?.[1];
    const row = bullet ? undefined : line.match(/^(\S+)\s{2,}(\S.*)$/);
    const rowSlug = row?.[1];
    let slug: string | undefined;
    let rest = "";
    if (bulletSlug && looksLikeModelSlug(bulletSlug)) {
      slug = bulletSlug;
      rest = bullet[2] ?? "";
    } else if (rowSlug && looksLikeModelSlug(rowSlug) && !/^\s*(yes|no)\b/i.test(row?.[2] ?? "")) {
      slug = rowSlug;
      rest = row[2] ?? "";
    }
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      ...modelFromSlug(slug),
      ...(/\(default\)|\bdefault\b/i.test(rest) ? { isDefault: true } : {}),
    });
  }
  return { authenticated, models };
}

export function parseCommandCodeAuthStatus(output: string): ServerProviderAuth {
  if (/not logged in|not authenticated|unauthenticated|logged out/i.test(output)) {
    return { status: "unauthenticated" };
  }
  if (/logged in|authenticated|signed in/i.test(output)) {
    return { status: "authenticated", type: "cached_token", label: "Command Code account" };
  }
  return { status: "unknown" };
}

export function buildInitialCommandCodeProviderSnapshot(
  commandCodeSettings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = commandCodeModelsFromSettings(commandCodeSettings.customModels);

    if (!commandCodeSettings.enabled) {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Command Code CLI availability...",
      },
    });
  });
}

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    commandCodeSettings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv = process.env,
    _cwd?: string,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = commandCodeModelsFromSettings(commandCodeSettings.customModels);

    if (!commandCodeSettings.enabled) {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Command Code is disabled in T3 Code settings.",
        },
      });
    }

    const versionResult = yield* runCommandCodeCliCommand(
      commandCodeSettings,
      ["--version"],
      environment,
    ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const error = versionResult.failure;
      yield* Effect.logWarning("Command Code CLI health check failed.", {
        errorTag: error._tag,
      });
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: commandCodeSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !isCommandMissingCause(error),
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: isCommandMissingCause(error)
            ? "Command Code CLI (`cmd`) is not installed or not on PATH. Install it with `npm i -g command-code`."
            : "Failed to execute Command Code CLI health check.",
        },
      });
    }

    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: commandCodeSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but timed out while running `cmd --version`.",
        },
      });
    }

    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      yield* Effect.logWarning("Command Code CLI version probe exited non-zero.", {
        exitCode: versionOutput.code,
        stdoutLength: versionOutput.stdout.length,
        stderrLength: versionOutput.stderr.length,
      });
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: commandCodeSettings.enabled,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but failed to run.",
        },
      });
    }

    // `cmd status` reports login state without starting an agent session.
    const authResult = yield* runCommandCodeCliCommand(
      commandCodeSettings,
      ["status"],
      environment,
    ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);
    const authOutput: CommandResult | undefined =
      Result.isSuccess(authResult) && Option.isSome(authResult.success)
        ? authResult.success.value
        : undefined;
    const auth: ServerProviderAuth = authOutput
      ? parseCommandCodeAuthStatus(`${authOutput.stdout}\n${authOutput.stderr}`)
      : { status: "unknown" };
    if (!authOutput) {
      yield* Effect.logWarning("Command Code CLI auth probe failed or timed out.", {
        errorTag: Result.isFailure(authResult) ? authResult.failure._tag : "Timeout",
      });
    }

    // `cmd --list-models` prints the model catalog without starting a session.
    const modelsResult = yield* runCommandCodeCliCommand(
      commandCodeSettings,
      ["--list-models"],
      environment,
    ).pipe(Effect.timeoutOption(MODELS_PROBE_TIMEOUT_MS), Effect.result);
    const modelsOutput =
      Result.isSuccess(modelsResult) &&
      Option.isSome(modelsResult.success) &&
      modelsResult.success.value.code === 0
        ? modelsResult.success.value
        : undefined;
    const cliModels = modelsOutput
      ? parseCommandCodeModelsCliOutput(`${modelsOutput.stdout}\n${modelsOutput.stderr}`)
      : { authenticated: null, models: [] };
    if (!modelsOutput) {
      yield* Effect.logWarning("Command Code CLI model listing failed or timed out.", {
        errorTag: Result.isFailure(modelsResult) ? modelsResult.failure._tag : "Timeout",
      });
    }

    const resolvedAuth: ServerProviderAuth =
      auth.status === "authenticated"
        ? auth
        : cliModels.authenticated === false
          ? { status: "unauthenticated" }
          : auth.status === "unauthenticated"
            ? auth
            : { status: "unknown" };

    const models =
      cliModels.models.length > 0
        ? commandCodeModelsFromSettings(commandCodeSettings.customModels, cliModels.models)
        : fallbackModels;
    const modelsIncomplete = cliModels.models.length === 0;

    if (resolvedAuth.status === "unauthenticated") {
      return buildServerProvider({
        presentation: COMMAND_CODE_PRESENTATION,
        enabled: commandCodeSettings.enabled,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: resolvedAuth,
          message: "Command Code CLI is installed but not logged in. Run `cmd login`.",
        },
      });
    }

    return buildServerProvider({
      presentation: COMMAND_CODE_PRESENTATION,
      enabled: commandCodeSettings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: {
        installed: true,
        version,
        // A failed metadata probe degrades the model picker, it does not make chats fail.
        status: resolvedAuth.status === "unknown" || modelsIncomplete ? "warning" : "ready",
        auth: resolvedAuth,
        ...(resolvedAuth.status === "unknown"
          ? {
              message:
                "Could not determine the Command Code login state. Run `cmd status` to check.",
            }
          : modelsIncomplete
            ? {
                message:
                  "Command Code CLI is installed, but the model listing could not be read. The built-in model list is shown.",
              }
            : {}),
      },
    });
  },
);

export const enrichCommandCodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Command Code version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
