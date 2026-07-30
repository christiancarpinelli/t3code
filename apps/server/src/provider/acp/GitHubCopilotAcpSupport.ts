import type {
  GitHubCopilotSettings,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type GitHubCopilotAcpSettings = Pick<GitHubCopilotSettings, "binaryPath" | "launchArgs">;

export interface GitHubCopilotAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly copilotSettings: GitHubCopilotAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildGitHubCopilotAcpSpawnInput(
  settings: GitHubCopilotAcpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: settings?.binaryPath || "copilot",
    args: ["--acp", "--stdio", ...tokenizeCliArgs(settings?.launchArgs)],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeGitHubCopilotAcpRuntime = (
  input: GitHubCopilotAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        clientCapabilities: {
          ...input.clientCapabilities,
          elicitation: {
            ...input.clientCapabilities?.elicitation,
            form: {},
          },
        },
        spawn: buildGitHubCopilotAcpSpawnInput(input.copilotSettings, input.cwd, input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

function elicitationOptions(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ];
  }
  if (property.type === "string") {
    const values =
      property.oneOf?.map((option) => ({
        label: option.const,
        description: option.title ?? option.const,
      })) ??
      property.enum?.map((value) => ({ label: value, description: value })) ??
      [];
    return values.length > 0 ? values : [{ label: "Enter a value", description: "Other" }];
  }
  if (property.type === "array") {
    const values =
      "enum" in property.items
        ? property.items.enum.map((value) => ({ label: value, description: value }))
        : property.items.anyOf.map((option) => ({
            label: option.const,
            description: option.title ?? option.const,
          }));
    return values.length > 0 ? values : [{ label: "Enter a value", description: "Other" }];
  }
  return [{ label: "Enter a value", description: "Other" }];
}

export function extractGitHubCopilotElicitationQuestions(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
): ReadonlyArray<UserInputQuestion> {
  return Object.entries(request.requestedSchema.properties ?? {}).map(([id, property]) => ({
    id,
    header: property.title?.trim() || request.requestedSchema.title?.trim() || "Question",
    question: property.description?.trim() || request.message.trim() || id,
    options: elicitationOptions(property),
    multiSelect: property.type === "array",
  }));
}

function firstAnswer(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

export function makeGitHubCopilotElicitationResponse(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
  answers: ProviderUserInputAnswers,
): EffectAcpSchema.ElicitationResponse {
  const entries: Array<[string, EffectAcpSchema.ElicitationContentValue]> = [];
  for (const [id, property] of Object.entries(request.requestedSchema.properties ?? {})) {
    const answer = answers[id];
    if (answer === undefined) continue;
    if (property.type === "array") {
      const values = Array.isArray(answer) ? answer : [answer];
      entries.push([id, values.map(String)]);
      continue;
    }
    const value = firstAnswer(answer);
    if (property.type === "boolean") {
      if (typeof value === "boolean") {
        entries.push([id, value]);
        continue;
      }
      const normalized = String(value).trim().toLowerCase();
      if (normalized === "yes" || normalized === "true") {
        entries.push([id, true]);
      } else if (normalized === "no" || normalized === "false") {
        entries.push([id, false]);
      }
      continue;
    }
    if (property.type === "number" || property.type === "integer") {
      const number = Number(value);
      if (Number.isFinite(number)) {
        entries.push([id, number]);
      }
      continue;
    }
    entries.push([id, String(value)]);
  }
  const content = Object.fromEntries(entries);
  return { action: { action: "accept", content } };
}

export function currentGitHubCopilotModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyGitHubCopilotAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requested = input.requestedModelId?.trim() || undefined;
  if (requested === undefined || requested === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requested)
    .pipe(Effect.mapError(input.mapError), Effect.as(requested));
}
