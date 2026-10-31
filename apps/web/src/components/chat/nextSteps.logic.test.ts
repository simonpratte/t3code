import {
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  findDelegatedThreadId,
  nextStepsCardRunId,
  nextStepsRows,
  type NextStepsSentGroup,
} from "./nextSteps.logic";

const steps = ["A", "B", "C", "D"].map((label) => ({ label, prompt: `Do ${label}` }));

describe("nextStepsCardRunId", () => {
  const run = (ordinal: number, status: "completed" | "running" | "failed") => ({
    id: RunId.make(`run:${ordinal}`),
    ordinal,
    status,
  });

  it("keeps the last completed run while newer turns run, fail, or settle", () => {
    const runs = [run(2, "completed"), run(1, "completed"), run(3, "failed"), run(4, "running")];
    expect(nextStepsCardRunId(runs, null)).toBe("run:2");
    const finished = [...runs.slice(0, 3), run(4, "completed")];
    expect(nextStepsCardRunId(finished, RunId.make("run:4"))).toBe("run:2");
    expect(nextStepsCardRunId(finished, null)).toBe("run:4");
  });
});

describe("nextStepsRows", () => {
  it("moves rows sent together next to each other and joins them", () => {
    const toThread: NextStepsSentGroup = {
      indices: [1, 3],
      destination: { type: "thread", threadId: ThreadId.make("thread:new"), worktree: false },
    };
    const here: NextStepsSentGroup = {
      indices: [0],
      destination: { type: "here", messageId: MessageId.make("message:here") },
    };
    const rows = nextStepsRows(steps, [toThread, here]);
    expect(
      rows.map((row) => [
        row.step.label,
        row.sent && {
          first: row.sent.first,
          joinsUp: row.sent.joinsUp,
          joinsDown: row.sent.joinsDown,
        },
      ]),
    ).toEqual([
      ["A", { first: true, joinsUp: false, joinsDown: false }],
      ["B", { first: true, joinsUp: false, joinsDown: true }],
      ["D", { first: false, joinsUp: true, joinsDown: false }],
      ["C", null],
    ]);
  });
});

describe("findDelegatedThreadId", () => {
  const messageId = MessageId.make("message:delegate");
  const runId = RunId.make("run:delegate");
  const projection = (
    subagents: ReadonlyArray<Record<string, unknown>>,
  ): Pick<OrchestrationV2ThreadProjection, "messages" | "subagents"> =>
    ({
      messages: [{ id: messageId, runId }],
      subagents,
    }) as unknown as Pick<OrchestrationV2ThreadProjection, "messages" | "subagents">;

  it("finds the app-owned task started by the run that answered our message", () => {
    const child = ThreadId.make("thread:child");
    expect(
      findDelegatedThreadId(
        projection([
          { runId: RunId.make("run:other"), origin: "app_owned", childThreadId: "thread:x" },
          { runId, origin: "provider_native", childThreadId: "thread:native" },
          { runId, origin: "app_owned", childThreadId: child },
        ]),
        messageId,
      ),
    ).toBe(child);
  });

  it("is null until the task's thread exists", () => {
    expect(
      findDelegatedThreadId(
        projection([{ runId, origin: "app_owned", childThreadId: null }]),
        messageId,
      ),
    ).toBeNull();
  });
});
