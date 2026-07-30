import {
  ApprovalRequestId,
  EventId,
  type GitHubCopilotSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  applyGitHubCopilotAcpModelSelection,
  currentGitHubCopilotModelIdFromSessionSetup,
  makeGitHubCopilotAcpRuntime,
} from "../acp/GitHubCopilotAcpSupport.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("githubCopilot");
const RESUME_VERSION = 1 as const;

export interface GitHubCopilotAdapterOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface PendingApproval {
  readonly request: EffectAcpSchema.RequestPermissionRequest;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  currentModelId: string | undefined;
  stopped: boolean;
}

function parseResume(raw: unknown): { sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== RESUME_VERSION) return undefined;
  return typeof value.sessionId === "string" && value.sessionId.trim()
    ? { sessionId: value.sessionId.trim() }
    : undefined;
}

function permissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind)?.optionId;
}

export function makeGitHubCopilotAdapter(
  settings: GitHubCopilotSettings,
  options?: GitHubCopilotAdapterOptions,
) {
  return Effect.gen(function* () {
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("githubCopilot");
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const sessions = new Map<ThreadId, SessionContext>();
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomId = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate a GitHub Copilot runtime identifier.",
            cause,
          }),
      ),
    );
    const stamp = () =>
      Effect.all({
        eventId: Effect.map(randomId, EventId.make),
        createdAt: nowIso,
      });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<SessionContext, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      return context && !context.stopped
        ? Effect.succeed(context)
        : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };

    const settleApprovals = (context: SessionContext) =>
      Effect.forEach(
        context.pendingApprovals.values(),
        ({ decision }) => Deferred.succeed(decision, "cancel").pipe(Effect.ignore),
        { discard: true },
      );

    const stopSessionInternal = (context: SessionContext) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        yield* settleApprovals(context);
        if (context.notificationFiber) {
          yield* Fiber.interrupt(context.notificationFiber);
        }
        yield* Scope.close(context.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(context.threadId);
        yield* publish({
          type: "session.exited",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: context.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const existing = sessions.get(input.threadId);
        if (existing) yield* stopSessionInternal(existing);

        const cwd = path.resolve(input.cwd.trim());
        const selectedModel =
          input.modelSelection?.instanceId === instanceId ? input.modelSelection.model : undefined;
        const resumeSessionId = parseResume(input.resumeCursor)?.sessionId;
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        let context: SessionContext | undefined;

        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const acp = yield* makeGitHubCopilotAcpRuntime({
          copilotSettings: settings,
          ...(options?.environment ? { environment: options.environment } : {}),
          childProcessSpawner,
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "t3-code", version: "0.0.0" },
          ...(mcpSession
            ? {
                mcpServers: [
                  {
                    type: "http",
                    name: "t3-code",
                    url: mcpSession.endpoint,
                    headers: [
                      {
                        name: "Authorization",
                        value: mcpSession.authorizationHeader,
                      },
                    ],
                  },
                ],
              }
            : {}),
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        yield* acp.handleRequestPermission((request) =>
          Effect.gen(function* () {
            if (input.runtimeMode === "full-access") {
              const optionId =
                permissionOptionId(request, "acceptForSession") ??
                permissionOptionId(request, "accept");
              if (optionId) {
                return { outcome: { outcome: "selected" as const, optionId } };
              }
            }

            const permissionRequest = parsePermissionRequest(request);
            const requestId = ApprovalRequestId.make(yield* randomId);
            const runtimeRequestId = RuntimeRequestId.make(requestId);
            const decision = yield* Deferred.make<ProviderApprovalDecision>();
            pendingApprovals.set(requestId, { request, decision });
            yield* publish(
              makeAcpRequestOpenedEvent({
                stamp: yield* stamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: context?.activeTurnId,
                requestId: runtimeRequestId,
                permissionRequest,
                detail: permissionRequest.detail ?? "GitHub Copilot requested permission.",
                args: request,
                source: "acp.jsonrpc",
                method: "session/request_permission",
                rawPayload: request,
              }),
            );
            const resolved = yield* Deferred.await(decision);
            pendingApprovals.delete(requestId);
            yield* publish(
              makeAcpRequestResolvedEvent({
                stamp: yield* stamp(),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId: context?.activeTurnId,
                requestId: runtimeRequestId,
                permissionRequest,
                decision: resolved,
              }),
            );
            if (resolved === "cancel") {
              return { outcome: { outcome: "cancelled" as const } };
            }
            const optionId = permissionOptionId(request, resolved);
            return optionId
              ? { outcome: { outcome: "selected" as const, optionId } }
              : { outcome: { outcome: "cancelled" as const } };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  detail: "Failed to resolve GitHub Copilot permission request.",
                  cause,
                }),
            ),
          ),
        );

        const started = yield* acp
          .start()
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );
        let currentModelId = currentGitHubCopilotModelIdFromSessionSetup(
          started.sessionSetupResult,
        );
        currentModelId = yield* applyGitHubCopilotAcpModelSelection({
          runtime: acp,
          currentModelId,
          requestedModelId: selectedModel,
          mapError: (error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
        });

        const now = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          model: currentModelId,
          threadId: input.threadId,
          resumeCursor: { schemaVersion: RESUME_VERSION, sessionId: started.sessionId },
          createdAt: now,
          updatedAt: now,
        };
        context = {
          threadId: input.threadId,
          acpSessionId: started.sessionId,
          scope: sessionScope,
          acp,
          pendingApprovals,
          turns: [],
          session,
          notificationFiber: undefined,
          activeTurnId: undefined,
          currentModelId,
          stopped: false,
        };

        const liveContext = context;
        liveContext.notificationFiber = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              switch (event._tag) {
                case "EventStreamBarrier":
                  yield* Deferred.succeed(event.acknowledge, undefined);
                  return;
                case "ModeChanged":
                  return;
                case "AssistantItemStarted":
                case "AssistantItemCompleted":
                  yield* publish(
                    makeAcpAssistantItemEvent({
                      stamp: yield* stamp(),
                      provider: PROVIDER,
                      threadId: liveContext.threadId,
                      turnId: liveContext.activeTurnId,
                      itemId: event.itemId,
                      lifecycle:
                        event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
                    }),
                  );
                  return;
                case "PlanUpdated":
                  yield* publish(
                    makeAcpPlanUpdatedEvent({
                      stamp: yield* stamp(),
                      provider: PROVIDER,
                      threadId: liveContext.threadId,
                      turnId: liveContext.activeTurnId,
                      payload: event.payload,
                      source: "acp.jsonrpc",
                      method: "session/update",
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ToolCallUpdated":
                  yield* publish(
                    makeAcpToolCallEvent({
                      stamp: yield* stamp(),
                      provider: PROVIDER,
                      threadId: liveContext.threadId,
                      turnId: liveContext.activeTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
                case "ContentDelta":
                  yield* publish(
                    makeAcpContentDeltaEvent({
                      stamp: yield* stamp(),
                      provider: PROVIDER,
                      threadId: liveContext.threadId,
                      turnId: liveContext.activeTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  );
                  return;
              }
            }),
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logError("Failed to process GitHub Copilot runtime notification.", { cause }),
          ),
          Effect.forkChild,
        );

        sessions.set(input.threadId, liveContext);
        sessionScopeTransferred = true;
        yield* publish({
          type: "session.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* publish({
          type: "session.state.changed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "GitHub Copilot ACP session ready" },
        });
        yield* publish({
          type: "thread.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });
        return session;
      }).pipe(Effect.scoped);

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* randomId);
        const requestedModel =
          input.modelSelection?.instanceId === instanceId
            ? input.modelSelection.model
            : context.currentModelId;
        context.currentModelId = yield* applyGitHubCopilotAcpModelSelection({
          runtime: context.acp,
          currentModelId: context.currentModelId,
          requestedModelId: requestedModel,
          mapError: (error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", error),
        });
        context.activeTurnId = turnId;
        context.session = {
          ...context.session,
          activeTurnId: turnId,
          model: context.currentModelId,
          updatedAt: yield* nowIso,
        };
        yield* publish({
          type: "turn.started",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model: context.currentModelId },
        });

        const prompt: Array<EffectAcpSchema.ContentBlock> = [];
        if (input.input?.trim()) prompt.push({ type: "text", text: input.input.trim() });
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          prompt.push({
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }
        if (prompt.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }

        const result = yield* context.acp
          .prompt({ prompt })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );
        context.turns.push({ id: turnId, items: [{ prompt, result }] });
        yield* publish({
          type: "turn.completed",
          ...(yield* stamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {
            state: result.stopReason === "cancelled" ? "cancelled" : "completed",
            stopReason: result.stopReason ?? null,
          },
        });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: context.session.resumeCursor,
        };
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* settleApprovals(context);
        yield* context.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
          Effect.ignore,
        );
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap(
          () =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/elicitation",
              detail: "GitHub Copilot user-input forms are not supported by the base adapter.",
            }),
        ),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal));
    const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));
    const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });
    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((context) => ({ threadId, turns: context.turns })));
    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
      numTurns,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        context.turns.splice(Math.max(0, context.turns.length - numTurns));
        return { threadId, turns: context.turns };
      });
    const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.tap(() => PubSub.shutdown(events)),
        Effect.catch((cause) =>
          Effect.logError("Failed to stop GitHub Copilot sessions.", { cause }),
        ),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(events),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
