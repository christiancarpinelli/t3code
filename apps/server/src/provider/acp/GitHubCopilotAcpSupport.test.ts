import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGitHubCopilotAcpModelSelection,
  buildGitHubCopilotAcpSpawnInput,
  currentGitHubCopilotModelIdFromSessionSetup,
} from "./GitHubCopilotAcpSupport.ts";

describe("buildGitHubCopilotAcpSpawnInput", () => {
  it("starts the default CLI in ACP stdio mode", () => {
    expect(buildGitHubCopilotAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "copilot",
      args: ["--acp", "--stdio"],
      cwd: "/tmp/project",
    });
  });

  it("preserves instance environment and tokenizes configured server arguments", () => {
    expect(
      buildGitHubCopilotAcpSpawnInput(
        {
          binaryPath: "/opt/copilot",
          launchArgs: '--experimental --reasoning-effort="high"',
        },
        "/tmp/project",
        { COPILOT_GITHUB_TOKEN: "secret" },
      ),
    ).toEqual({
      command: "/opt/copilot",
      args: ["--acp", "--stdio", "--experimental", "--reasoning-effort=high"],
      cwd: "/tmp/project",
      env: { COPILOT_GITHUB_TOKEN: "secret" },
    });
  });
});

describe("GitHub Copilot ACP model selection", () => {
  it("reads the current model and switches only when requested", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const runtime = {
        setSessionModel: (modelId: string) =>
          Effect.sync(() => {
            calls.push(modelId);
            return {};
          }),
      };
      const current = currentGitHubCopilotModelIdFromSessionSetup({
        sessionId: "session",
        models: {
          currentModelId: "claude-sonnet-4.5",
          availableModels: [],
        },
      });
      expect(current).toBe("claude-sonnet-4.5");

      const unchanged = yield* applyGitHubCopilotAcpModelSelection({
        runtime,
        currentModelId: current,
        requestedModelId: "claude-sonnet-4.5",
        mapError: (cause) => cause.message,
      });
      const changed = yield* applyGitHubCopilotAcpModelSelection({
        runtime,
        currentModelId: unchanged,
        requestedModelId: "gpt-5.3-codex",
        mapError: (cause) => cause.message,
      });

      expect(calls).toEqual(["gpt-5.3-codex"]);
      expect(changed).toBe("gpt-5.3-codex");
    }));

  it.effect("maps ACP model switching failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unsupported model");
      const error = yield* Effect.flip(
        applyGitHubCopilotAcpModelSelection({
          runtime: { setSessionModel: () => Effect.fail(failure) },
          currentModelId: "claude-sonnet-4.5",
          requestedModelId: "missing-model",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});
