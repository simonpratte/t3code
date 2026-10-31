import type { NextStepsInput, NextStepsResult, RunId, ThreadId } from "@t3tools/contracts";
import type { NextStepsMessage } from "@t3tools/provider-core/server/textGeneration";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MAX_CONTEXT_MESSAGES = 24;
const NO_STEPS: NextStepsResult = { steps: [] };

export class NextStepsService extends Context.Service<
  NextStepsService,
  {
    /** Suggests up to four next prompts after the thread's latest run completed. Never fails. */
    readonly generate: (input: NextStepsInput) => Effect.Effect<NextStepsResult>;
  }
>()("t3/orchestration-v2/NextStepsService") {}

class StepsKey extends Data.Class<{ threadId: ThreadId; runId: RunId }> {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;

  const readSettledThread = Effect.fn("NextStepsService.readSettledThread")(function* (
    key: StepsKey,
  ) {
    const source = yield* threads.getThreadRecords(key.threadId, ["messages", "runs"], {
      messageRoles: ["user", "assistant"],
    });
    const runs = source.runs.filter((run) => run.status !== "rolled_back");
    const latest = runs.reduce<(typeof runs)[number] | undefined>(
      (best, run) => (best === undefined || run.ordinal > best.ordinal ? run : best),
      undefined,
    );
    // Interrupted or failed runs have no reply worth following up on.
    if (latest?.id !== key.runId || latest.status !== "completed") return Option.none();
    const liveRunIds = new Set(runs.map((run) => run.id));
    const messages = source.messages.flatMap((message): Array<NextStepsMessage> => {
      if (message.streaming || message.role === "system") return [];
      if (
        message.runId === null
          ? source.thread.historyOrigin !== "v1_import"
          : !liveRunIds.has(message.runId)
      ) {
        return [];
      }
      return [{ role: message.role, text: message.text }];
    });
    // Not "the last message is the reply": messages without a turn item, such as a delegated
    // task's completion notice, sort after it.
    const replied = source.messages.some(
      (message) =>
        message.runId === key.runId && message.role === "assistant" && !message.streaming,
    );
    return replied
      ? Option.some({ thread: source.thread, messages: messages.slice(-MAX_CONTEXT_MESSAGES) })
      : Option.none();
  });

  const lookup = Effect.fn("NextStepsService.lookup")(function* (key: StepsKey) {
    const settled = yield* readSettledThread(key);
    if (Option.isNone(settled)) return NO_STEPS;
    const { thread, messages } = settled.value;
    const project = yield* projects.get(thread.projectId);
    if (Option.isNone(project)) return NO_STEPS;
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      thread.projectId,
    ).settings;
    return yield* textGeneration.generateNextSteps({
      cwd: thread.worktreePath ?? project.value.workspaceRoot,
      messages,
      modelSelection: settings.textGenerationModelSelection,
    });
  });

  // One generation per run, shared by every client viewing the thread. Failures resolve to no
  // steps so a broken provider is not retried on every render.
  const steps = yield* Cache.make({
    capacity: 256,
    timeToLive: "30 minutes",
    lookup: (key: StepsKey) =>
      lookup(key).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Next steps generation failed", {
                threadId: key.threadId,
                runId: key.runId,
                cause,
              }).pipe(Effect.as(NO_STEPS)),
        ),
      ),
  });

  const generate: NextStepsService["Service"]["generate"] = Effect.fn("NextStepsService.generate")(
    function* (input) {
      return yield* Cache.get(
        steps,
        new StepsKey({ threadId: input.threadId, runId: input.runId }),
      );
    },
  );

  return NextStepsService.of({ generate });
});

export const layer = Layer.effect(NextStepsService, make);
