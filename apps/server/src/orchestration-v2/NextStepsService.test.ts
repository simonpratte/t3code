import { assert, describe, it, vi } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as NextSteps from "./NextStepsService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:next-steps");
const projectId = ProjectId.make("project:next-steps");
const firstRun = RunId.make("run:first");
const latestRun = RunId.make("run:latest");
const steps = [{ label: "Run the tests", prompt: "Run the test suite" }];

function message(
  id: string,
  runId: RunId | null,
  role: "user" | "assistant" | "system",
  text: string,
  streaming = false,
) {
  return { id: MessageId.make(id), threadId, runId, role, text, streaming, attachments: [] };
}

function makeHarness(
  options: {
    readonly latestStatus?: OrchestrationV2RunStatus;
    readonly generate?: TextGeneration.TextGeneration["Service"]["generateNextSteps"];
  } = {},
) {
  const records = {
    thread: { id: threadId, projectId, worktreePath: "/worktree", historyOrigin: "native" },
    runs: [
      { id: firstRun, ordinal: 1, status: "completed" },
      { id: RunId.make("run:rolled-back"), ordinal: 3, status: "rolled_back" },
      { id: latestRun, ordinal: 2, status: options.latestStatus ?? "completed" },
    ],
    messages: [
      message("m1", firstRun, "user", "Add a dark mode toggle"),
      message("m2", firstRun, "assistant", "Added the toggle. Want me to persist the choice?"),
      message("m3", RunId.make("run:rolled-back"), "user", "Undone request"),
      message("m4", latestRun, "user", "Yes, persist it"),
      message("m5", latestRun, "system", "Context compacted"),
      message("m6", latestRun, "assistant", "Persisted it in localStorage."),
      message("m7", latestRun, "assistant", "", true),
      // A delegated task's completion notice has no turn item, so it sorts after the reply.
      message("m8", latestRun, "user", "Delegated task finished"),
    ],
  };
  const getThreadRecords = vi.fn(() => Effect.succeed(records));
  const generateNextSteps = vi.fn(options.generate ?? (() => Effect.succeed({ steps })));
  const layer = NextSteps.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords:
            getThreadRecords as unknown as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () => Effect.succeedSome({ workspaceRoot: "/repo" } as ProjectStore.ProjectRow),
        }),
        Layer.mock(TextGeneration.TextGeneration)({ generateNextSteps }),
        ServerSettings.layerTest(),
      ),
    ),
  );
  return { layer, generateNextSteps };
}

const generate = (runId: RunId) =>
  NextSteps.NextStepsService.pipe(
    Effect.flatMap((service) => service.generate({ threadId, runId })),
  );

describe("NextStepsService", () => {
  it.effect("generates once per completed latest run from its settled conversation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const [first, second] = yield* Effect.all([generate(latestRun), generate(latestRun)], {
        concurrency: "unbounded",
      });
      assert.deepStrictEqual(first, { steps });
      assert.deepStrictEqual(second, first);
      assert.deepStrictEqual(yield* generate(latestRun), first);
      assert.strictEqual(harness.generateNextSteps.mock.calls.length, 1);
      assert.deepStrictEqual(harness.generateNextSteps.mock.calls[0]?.[0], {
        cwd: "/worktree",
        messages: [
          { role: "user", text: "Add a dark mode toggle" },
          { role: "assistant", text: "Added the toggle. Want me to persist the choice?" },
          { role: "user", text: "Yes, persist it" },
          { role: "assistant", text: "Persisted it in localStorage." },
          { role: "user", text: "Delegated task finished" },
        ],
        modelSelection: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection,
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect.each([
    { name: "a run that is no longer the latest", runId: firstRun },
    { name: "an interrupted latest run", runId: latestRun, latestStatus: "interrupted" as const },
    { name: "a failed latest run", runId: latestRun, latestStatus: "failed" as const },
  ])("suggests nothing after $name", ({ runId, latestStatus }) => {
    const harness = makeHarness(latestStatus === undefined ? {} : { latestStatus });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* generate(runId), { steps: [] });
      assert.strictEqual(harness.generateNextSteps.mock.calls.length, 0);
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("resolves a failed generation to no steps without retrying it", () => {
    const harness = makeHarness({
      generate: () =>
        Effect.fail(new TextGenerationError({ operation: "generateNextSteps", detail: "offline" })),
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* generate(latestRun), { steps: [] });
      assert.deepStrictEqual(yield* generate(latestRun), { steps: [] });
      assert.strictEqual(harness.generateNextSteps.mock.calls.length, 1);
    }).pipe(Effect.provide(harness.layer));
  });
});
