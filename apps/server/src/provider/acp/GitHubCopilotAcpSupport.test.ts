import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyGitHubCopilotAcpModelSelection,
  buildGitHubCopilotAcpSpawnInput,
  currentGitHubCopilotModelIdFromSessionSetup,
  extractGitHubCopilotElicitationQuestions,
  makeGitHubCopilotElicitationResponse,
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

describe("GitHub Copilot ACP elicitation", () => {
  const request = {
    mode: "form" as const,
    sessionId: "session",
    message: "Choose release settings",
    requestedSchema: {
      type: "object" as const,
      title: "Release",
      properties: {
        channel: {
          type: "string" as const,
          title: "Channel",
          description: "Where should this ship?",
          enum: ["preview", "stable"],
        },
        notify: {
          type: "boolean" as const,
          title: "Notify",
        },
      },
    },
  };

  it("projects ACP form fields into T3 Code questions", () => {
    expect(extractGitHubCopilotElicitationQuestions(request)).toEqual([
      {
        id: "channel",
        header: "Channel",
        question: "Where should this ship?",
        options: [
          { label: "preview", description: "preview" },
          { label: "stable", description: "stable" },
        ],
        multiSelect: false,
      },
      {
        id: "notify",
        header: "Notify",
        question: "Choose release settings",
        options: [
          { label: "Yes", description: "Yes" },
          { label: "No", description: "No" },
        ],
        multiSelect: false,
      },
    ]);
  });

  it("converts T3 Code answers back to typed ACP form content", () => {
    expect(
      makeGitHubCopilotElicitationResponse(request, {
        channel: "stable",
        notify: "Yes",
      }),
    ).toEqual({
      action: {
        action: "accept",
        content: {
          channel: "stable",
          notify: true,
        },
      },
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
