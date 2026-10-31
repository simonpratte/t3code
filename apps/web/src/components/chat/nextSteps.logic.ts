import type {
  MessageId,
  ModelSelection,
  NextStep,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

/** Where a group of suggestions went. "here" and "delegate" are messages sent in this thread. */
export type NextStepsDestination =
  | { readonly type: "here"; readonly messageId: MessageId }
  | { readonly type: "thread"; readonly threadId: ThreadId; readonly worktree: boolean }
  | { readonly type: "delegate"; readonly messageId: MessageId; readonly modelLabel: string };

export interface NextStepsSentGroup {
  readonly indices: ReadonlyArray<number>;
  readonly destination: NextStepsDestination;
}

export interface NextStepsRow {
  readonly index: number;
  readonly step: NextStep;
  /** Set once the row was sent. `first` rows carry the group's tag; joins draw the connecting line. */
  readonly sent: {
    readonly group: NextStepsSentGroup;
    readonly first: boolean;
    readonly joinsUp: boolean;
    readonly joinsDown: boolean;
  } | null;
}

/**
 * The run the card shows suggestions for: the last completed one, so its card stays up while a
 * newer turn runs. A just-finished run waits until it settled (`unsettledRunId`).
 */
export function nextStepsCardRunId(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>,
  unsettledRunId: RunId | null,
): RunId | null {
  let shown: (typeof runs)[number] | undefined;
  for (const run of runs) {
    if (run.status !== "completed" || run.id === unsettledRunId) continue;
    if (shown === undefined || run.ordinal > shown.ordinal) shown = run;
  }
  return shown?.id ?? null;
}

/** One prompt as is; several become a numbered list, in the order the card shows them. */
export function combineNextStepPrompts(
  steps: ReadonlyArray<NextStep>,
  indices: ReadonlyArray<number>,
): string {
  const prompts = indices.flatMap((index) => steps[index]?.prompt ?? []);
  return prompts.length === 1
    ? (prompts[0] ?? "")
    : prompts.map((prompt, position) => `${position + 1}. ${prompt}`).join("\n");
}

/** Asks this thread's agent to hand the task to another model with T3 Code's delegate_task tool. */
export function buildDelegatePrompt(input: {
  readonly task: string;
  readonly target: Pick<ModelSelection, "instanceId" | "model">;
  readonly worktree: boolean;
}): string {
  const target = JSON.stringify({
    providerInstanceId: input.target.instanceId,
    model: input.target.model,
  });
  return [
    `Delegate the task below with T3 Code's delegate_task tool: target ${target}, isolation "${input.worktree ? "worktree" : "shared"}", mode "async". Do not do the task yourself.`,
    "",
    "Task:",
    input.task,
  ].join("\n");
}

/**
 * The card's rows in display order. Rows sent together move next to each other, at the first
 * one's position, so a line can join them without crossing an unrelated row.
 */
export function nextStepsRows(
  steps: ReadonlyArray<NextStep>,
  sent: ReadonlyArray<NextStepsSentGroup>,
): Array<NextStepsRow> {
  let order = steps.map((_, index) => index);
  for (const group of sent) {
    const members = order.filter((index) => group.indices.includes(index));
    const at = order.indexOf(members[0] ?? -1);
    if (at === -1) continue;
    const rest = order.filter((index) => !members.includes(index));
    order = [...rest.slice(0, at), ...members, ...rest.slice(at)];
  }
  const groupOf = (index: number | undefined) =>
    index === undefined ? undefined : sent.find((group) => group.indices.includes(index));
  return order.flatMap((index, position): Array<NextStepsRow> => {
    const step = steps[index];
    if (step === undefined) return [];
    const group = groupOf(index);
    if (group === undefined) return [{ index, step, sent: null }];
    const joinsUp = groupOf(order[position - 1]) === group;
    const joinsDown = groupOf(order[position + 1]) === group;
    return [{ index, step, sent: { group, first: !joinsUp, joinsUp, joinsDown } }];
  });
}

/** The delegated thread the agent started in reply to our message, once it exists. */
export function findDelegatedThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "subagents"> | null,
  messageId: MessageId,
): ThreadId | null {
  const runId = projection?.messages.find((message) => message.id === messageId)?.runId;
  if (runId == null) return null;
  return (
    projection?.subagents.find(
      (task) => task.runId === runId && task.origin === "app_owned" && task.childThreadId !== null,
    )?.childThreadId ?? null
  );
}
