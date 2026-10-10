import { assert, describe, it } from "@effect/vitest";
import { defaultInstanceIdForDriver } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import {
  COMMAND_CODE_DEFAULT_INSTANCE_ID,
  COMMAND_CODE_PROVIDER,
  CommandCodeAdapterV2Driver,
  CommandCodeProviderCapabilitiesV2,
  commandCodeSessionModeForPolicy,
} from "./CommandCodeAdapterV2.ts";

const decodePolicy = Schema.decodeSync(ProviderAdapterV2RuntimePolicy);

const policy = (
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
  interactionMode: "default" | "plan" = "default",
) => decodePolicy({ runtimeMode, interactionMode, cwd: null });

describe("CommandCodeAdapterV2", () => {
  it("maps runtime policies onto Command Code session modes", () => {
    assert.strictEqual(commandCodeSessionModeForPolicy(policy("approval-required")), "default");
    assert.strictEqual(commandCodeSessionModeForPolicy(policy("auto-accept-edits")), "auto-accept");
    assert.strictEqual(commandCodeSessionModeForPolicy(policy("auto")), "auto-accept");
    assert.strictEqual(commandCodeSessionModeForPolicy(policy("full-access")), "bypass");
  });

  it("lets plan interaction mode win over the runtime mode", () => {
    assert.strictEqual(commandCodeSessionModeForPolicy(policy("full-access", "plan")), "plan");
  });

  it("registers as a built-in v2 adapter driver", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(COMMAND_CODE_PROVIDER));
    assert.strictEqual(CommandCodeAdapterV2Driver.driverKind, COMMAND_CODE_PROVIDER);
  });

  it("uses the default instance id for the driver kind", () => {
    assert.strictEqual(
      COMMAND_CODE_DEFAULT_INSTANCE_ID,
      defaultInstanceIdForDriver(COMMAND_CODE_PROVIDER),
    );
  });

  it("declares live model switching, editor MCP servers, and session reload on mode change", () => {
    assert.isTrue(CommandCodeProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    // The shared ACP harness only re-applies config on model/interaction-mode
    // changes, so a runtime-mode change must recycle the session to take effect.
    assert.isFalse(CommandCodeProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isTrue(CommandCodeProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(CommandCodeProviderCapabilitiesV2.threads.canReadThreadSnapshot);
  });

  it("decodes an empty config into the cmd defaults", () => {
    const config = CommandCodeAdapterV2Driver.defaultConfig();
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.binaryPath, "cmd");
    assert.strictEqual(config.launchArgs, "");
  });
});
