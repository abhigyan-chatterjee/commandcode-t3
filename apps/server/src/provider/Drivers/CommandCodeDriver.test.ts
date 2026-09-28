// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import * as ModelManifest from "../ModelManifest.ts";
import { CommandCodeDriver } from "./CommandCodeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-commandcode-driver-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Command Code must not make an HTTP request")),
    ),
  ),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Command Code must not spawn a process"),
);

it.layer(testLayer)("CommandCodeDriver", (it) => {
  it.effect("decodes an empty config into enabled defaults", () =>
    Effect.sync(() => {
      const config = CommandCodeDriver.defaultConfig();
      expect(config.enabled).toBe(true);
      // The schema's decoding default fills in the provider binary name.
      expect(config.binaryPath).toBe("cmd");
      expect(config.launchArgs).toBe("");
      expect(config.customModels).toEqual([]);
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("runs the standalone updater against the resolved binary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-commandcode-driver-" });
      const binaryPath = NodePath.join(tempDir, "bin", "cmd");
      yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* CommandCodeDriver.create({
        instanceId: ProviderInstanceId.make("commandcode-default"),
        displayName: "Command Code test",
        enabled: false,
        environment: [],
        config: {
          ...CommandCodeDriver.defaultConfig(),
          binaryPath,
        },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toMatchObject({
        executable: binaryPath,
        args: ["update"],
        lockKey: "commandcode",
      });
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* CommandCodeDriver.create({
        instanceId: ProviderInstanceId.make("commandcode-missing"),
        displayName: "Command Code test",
        enabled: false,
        environment: [],
        config: {
          ...CommandCodeDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-commandcode-missing", "cmd"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );
});
