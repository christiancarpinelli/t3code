import {
  type GitHubCopilotSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as EffectAcpSchema from "effect-acp/schema";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { makeGitHubCopilotAcpRuntime } from "../acp/GitHubCopilotAcpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PRESENTATION = {
  displayName: "GitHub Copilot",
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_DISCOVERY_TIMEOUT_MS = 20_000;

function modelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, customModels ?? [], EMPTY_CAPABILITIES);
}

function modelsFromAcpState(
  state: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!state) return [];
  const seen = new Set<string>();
  return state.availableModels.flatMap((model) => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

function slashCommandsFromAcp(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return commands.flatMap((command) => {
    const name = command.name.trim().replace(/^\/+/, "");
    if (!name) return [];
    const description = command.description?.trim() || undefined;
    const hint = command.input?.hint?.trim() || undefined;
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

export const buildInitialGitHubCopilotProviderSnapshot = Effect.fn(
  "buildInitialGitHubCopilotProviderSnapshot",
)(function* (settings: GitHubCopilotSettings) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: modelsFromSettings(settings.customModels),
    probe: settings.enabled
      ? {
          installed: true,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Checking GitHub Copilot CLI availability...",
        }
      : {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "GitHub Copilot is disabled in T3 Code settings.",
        },
  });
});

const discoverModels = Effect.fn("discoverGitHubCopilotModels")(function* (
  settings: GitHubCopilotSettings,
  environment: NodeJS.ProcessEnv,
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const acp = yield* makeGitHubCopilotAcpRuntime({
    copilotSettings: settings,
    environment,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  });
  const started = yield* acp.start();
  yield* Effect.yieldNow;
  return {
    models: modelsFromAcpState(started.sessionSetupResult.models),
    slashCommands: slashCommandsFromAcp(yield* acp.getAvailableCommands),
  };
}, Effect.scoped);

export const checkGitHubCopilotProviderStatus = Effect.fn("checkGitHubCopilotProviderStatus")(
  function* (
    settings: GitHubCopilotSettings,
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallbackModels = modelsFromSettings(settings.customModels);
    if (!settings.enabled) {
      return yield* buildInitialGitHubCopilotProviderSnapshot(settings);
    }

    const command = settings.binaryPath || "copilot";
    const versionResult = yield* Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
      return yield* spawnAndCollect(
        command,
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          env: environment,
          shell: spawnCommand.shell,
        }),
      );
    }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(versionResult)) {
      const missing = isCommandMissingCause(versionResult.failure);
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? "GitHub Copilot CLI (`copilot`) is not installed or not on PATH."
            : "Failed to execute GitHub Copilot CLI health check.",
        },
      });
    }
    if (Option.isNone(versionResult.success)) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "GitHub Copilot CLI timed out while checking its version.",
        },
      });
    }

    const output = versionResult.success.value;
    const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
    if (output.code !== 0) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "GitHub Copilot CLI is installed but failed to run.",
        },
      });
    }

    const discovery = yield* discoverModels(settings, environment).pipe(
      Effect.timeoutOption(ACP_DISCOVERY_TIMEOUT_MS),
      Effect.exit,
    );
    if (Exit.isFailure(discovery)) {
      yield* Effect.logWarning("GitHub Copilot ACP discovery failed.", {
        errorTag: causeErrorTag(discovery.cause),
      });
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message:
            "GitHub Copilot CLI is installed but ACP startup failed. Run `copilot login` or configure a supported token/BYOK provider.",
        },
      });
    }
    if (Option.isNone(discovery.value)) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "GitHub Copilot CLI ACP startup timed out.",
        },
      });
    }

    const discovered = discovery.value.value;
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings.customModels, discovered.models),
      slashCommands: discovered.slashCommands,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "authenticated" },
      },
    });
  },
);

export const enrichGitHubCopilotSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("GitHub Copilot version advisory enrichment failed.", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
