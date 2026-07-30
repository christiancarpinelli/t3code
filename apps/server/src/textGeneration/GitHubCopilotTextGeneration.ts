import {
  type GitHubCopilotSettings,
  type ModelSelection,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  applyGitHubCopilotAcpModelSelection,
  currentGitHubCopilotModelIdFromSessionSetup,
  makeGitHubCopilotAcpRuntime,
} from "../provider/acp/GitHubCopilotAcpSupport.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const REQUEST_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

export const makeGitHubCopilotTextGeneration = Effect.fn("makeGitHubCopilotTextGeneration")(
  function* (settings: GitHubCopilotSettings, environment: NodeJS.ProcessEnv = process.env) {
    const crypto = yield* Crypto.Crypto;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const runJson = <S extends Schema.Top>(input: {
      readonly operation:
        | "generateCommitMessage"
        | "generatePrContent"
        | "generateBranchName"
        | "generateThreadTitle";
      readonly cwd: string;
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: ModelSelection;
    }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
      Effect.gen(function* () {
        const output = yield* Ref.make("");
        const runtime = yield* makeGitHubCopilotAcpRuntime({
          copilotSettings: settings,
          environment,
          childProcessSpawner,
          cwd: input.cwd,
          clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

        yield* runtime.handleSessionUpdate((notification) => {
          const update = notification.update;
          if (update.sessionUpdate !== "agent_message_chunk") return Effect.void;
          const content = update.content;
          return content.type === "text"
            ? Ref.update(output, (current) => current + content.text)
            : Effect.void;
        });

        const promptResult = yield* Effect.gen(function* () {
          const started = yield* runtime.start();
          yield* applyGitHubCopilotAcpModelSelection({
            runtime,
            currentModelId: currentGitHubCopilotModelIdFromSessionSetup(started.sessionSetupResult),
            requestedModelId: input.modelSelection.model,
            mapError: (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "Failed to set the GitHub Copilot model.",
                cause,
              }),
          });
          return yield* runtime.prompt({ prompt: [{ type: "text", text: input.prompt }] });
        }).pipe(
          Effect.timeoutOption(REQUEST_TIMEOUT_MS),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  new TextGenerationError({
                    operation: input.operation,
                    detail: "GitHub Copilot request timed out.",
                  }),
                ),
              onSome: Effect.succeed,
            }),
          ),
          Effect.mapError((cause) =>
            isTextGenerationError(cause)
              ? cause
              : new TextGenerationError({
                  operation: input.operation,
                  detail: "GitHub Copilot ACP request failed.",
                  cause,
                }),
          ),
        );

        const raw = (yield* Ref.get(output)).trim();
        if (!raw) {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail:
              promptResult.stopReason === "cancelled"
                ? "GitHub Copilot request was cancelled."
                : "GitHub Copilot returned empty output.",
          });
        }

        const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
        return yield* decodeOutput(extractJsonObject(raw)).pipe(
          Effect.mapError(
            (cause) =>
              new TextGenerationError({
                operation: input.operation,
                detail: "GitHub Copilot returned invalid structured output.",
                cause,
              }),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "GitHub Copilot text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );

    const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
      Effect.fn("GitHubCopilotTextGeneration.generateCommitMessage")(function* (input) {
        const built = buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        });
        const generated = yield* runJson({
          operation: "generateCommitMessage",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
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
      Effect.fn("GitHubCopilotTextGeneration.generatePrContent")(function* (input) {
        const built = buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        });
        const generated = yield* runJson({
          operation: "generatePrContent",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
      });

    const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
      Effect.fn("GitHubCopilotTextGeneration.generateBranchName")(function* (input) {
        const built = buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* runJson({
          operation: "generateBranchName",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        });
        return { branch: sanitizeBranchFragment(generated.branch) };
      });

    const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
      Effect.fn("GitHubCopilotTextGeneration.generateThreadTitle")(function* (input) {
        const built = buildThreadTitlePrompt({
          message: input.message,
          attachments: input.attachments,
        });
        const generated = yield* runJson({
          operation: "generateThreadTitle",
          cwd: input.cwd,
          prompt: built.prompt,
          outputSchema: built.outputSchema,
          modelSelection: input.modelSelection,
        });
        return { title: sanitizeThreadTitle(generated.title) };
      });

    return TextGeneration.TextGeneration.of({
      generateCommitMessage,
      generatePrContent,
      generateBranchName,
      generateThreadTitle,
    });
  },
);
