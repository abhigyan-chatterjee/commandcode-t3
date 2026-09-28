/**
 * CommandCodeTextGeneration — text generation via `cmd -p --output-format json`.
 *
 * Titles, commit messages, PR content, and branch names are one-shot headless
 * queries: the prompt arrives on stdin and the reply is the result line's
 * `finalText`. Headless runs block system-modifying tools by default, which is
 * exactly the right sandbox for metadata generation.
 *
 * @module CommandCodeTextGeneration
 */
import {
  TextGenerationError,
  type CommandCodeSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const COMMAND_CODE_TIMEOUT_MS = 180_000;

const decodeJsonLineExit = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

interface CommandCodeRunResult {
  readonly type: "result";
  readonly subtype?: unknown;
  readonly finalText?: unknown;
}

/** Returns the last parsable `{"type":"result", ...}` line of the NDJSON stream. */
function parseCommandCodeJsonOutput(stdout: string): CommandCodeRunResult | undefined {
  let result: CommandCodeRunResult | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const decoded = decodeJsonLineExit(trimmed);
    if (!Exit.isSuccess(decoded)) continue;
    const parsed: unknown = decoded.value;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { type?: unknown }).type === "result"
    ) {
      result = parsed as CommandCodeRunResult;
    }
  }
  return result;
}

export const makeCommandCodeTextGeneration = Effect.fn("makeCommandCodeTextGeneration")(function* (
  commandCodeSettings: CommandCodeSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("cmd", operation, cause, "Failed to collect process output"),
      ),
    );

  const runCommandCodeJson = Effect.fn("runCommandCodeJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const model = modelSelection.model;
    const args = [
      "-p",
      "--output-format",
      "json",
      "--skip-onboarding",
      ...(model ? ["-m", model] : []),
    ];
    const binary = commandCodeSettings.binaryPath || "cmd";
    const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: environment });
    const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      cwd,
      shell: spawnCommand.shell,
      stdin: {
        stream: Stream.encodeText(Stream.make(prompt)),
      },
    });

    const runCommand = Effect.gen(function* () {
      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("cmd", operation, cause, "Failed to spawn Command Code CLI process"),
          ),
        );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.mapError((cause) =>
              normalizeCliError("cmd", operation, cause, "Failed to read Command Code exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Command Code CLI command failed: ${detail}`
              : `Command Code CLI command failed with code ${exitCode}.`,
        });
      }
      return stdout;
    });

    const stdout = yield* runCommand.pipe(
      Effect.scoped,
      Effect.timeoutOption(COMMAND_CODE_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Command Code CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const result = parseCommandCodeJsonOutput(stdout);
    const finalText = typeof result?.finalText === "string" ? result.finalText : "";
    const trimmed = finalText.trim();
    if (result === undefined || trimmed.length === 0) {
      return yield* new TextGenerationError({
        operation,
        detail: "Command Code returned empty output.",
      });
    }

    const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
    return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Command Code returned invalid structured output.",
              cause,
            }),
          ),
      }),
    );
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CommandCodeTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CommandCodeTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CommandCodeTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CommandCodeTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runCommandCodeJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
