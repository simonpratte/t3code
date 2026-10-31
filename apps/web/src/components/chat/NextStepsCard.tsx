import type {
  EnvironmentId,
  NextStep,
  ProviderInteractionMode,
  ProviderInstanceId,
  RunId,
  RuntimeMode,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CornerDownLeftIcon,
  SparklesIcon,
  SquarePlusIcon,
} from "lucide-react";
import { useState, type ComponentProps } from "react";
import { create } from "zustand";

import { cn, newMessageId, newThreadId } from "~/lib/utils";
import { useComposerHandleContext } from "../../composerHandleContext";
import { useProject, useQuietThreadProjection } from "../../state/entities";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { CheckboxMark } from "../ui/checkbox";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ComposerBanner } from "./ComposerBanner";
import {
  buildDelegatePrompt,
  combineNextStepPrompts,
  findDelegatedThreadId,
  nextStepsRows,
  type NextStepsDestination,
  type NextStepsRow,
  type NextStepsSentGroup,
} from "./nextSteps.logic";
import { ProviderModelPicker } from "./ProviderModelPicker";

type PickerProps = ComponentProps<typeof ProviderModelPicker>;

/** What the composer's model picker knows, so Delegate lists the same models. */
export interface NextStepsModelOptions {
  readonly instanceEntries: PickerProps["instanceEntries"];
  readonly modelOptionsByInstance: PickerProps["modelOptionsByInstance"];
}

interface NextStepsCardState {
  readonly runId: RunId;
  readonly steps: ReadonlyArray<NextStep>;
  readonly selected: ReadonlyArray<number>;
  readonly sent: ReadonlyArray<NextStepsSentGroup>;
  readonly closed: boolean;
}

// In memory per thread: survives switching threads, not a reload. Written only by user actions.
const useNextStepsCards = create<{
  readonly cards: Readonly<Record<string, NextStepsCardState>>;
  readonly save: (key: string, card: NextStepsCardState) => void;
}>((set) => ({
  cards: {},
  save: (key, card) => set((state) => ({ cards: { ...state.cards, [key]: card } })),
}));

/**
 * Suggested next prompts for the thread's last completed turn. Rows can be combined and sent
 * here, to a new thread, or delegated by this thread's agent to another model.
 */
export function NextStepsCard(props: {
  readonly environmentId: EnvironmentId;
  readonly thread: EnvironmentThreadShell;
  /** The last completed run; it stays while a newer turn runs. */
  readonly runId: RunId | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly models: NextStepsModelOptions;
}) {
  const { environmentId, thread, runId } = props;
  const threadRef = scopeThreadRef(environmentId, thread.id);
  const key = scopedThreadKey(threadRef);
  const project = useProject(scopeProjectRef(environmentId, thread.projectId));
  const composerRef = useComposerHandleContext();
  const stored = useNextStepsCards((state) => state.cards[key]);
  const save = useNextStepsCards((state) => state.save);
  const query = useEnvironmentQuery(
    runId === null
      ? null
      : orchestrationEnvironment.nextSteps({
          environmentId,
          input: { threadId: thread.id, runId },
        }),
  );
  const navigate = useNavigate();
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const [worktree, setWorktree] = useState(false);
  const [pending, setPending] = useState(false);

  // A newer completed run replaces the whole card; what was done on an older one never shows.
  const card: NextStepsCardState | undefined =
    stored?.runId === runId
      ? stored
      : runId !== null && query.data !== null
        ? { runId, steps: query.data.steps, selected: [], sent: [], closed: false }
        : undefined;
  if (card === undefined || card.closed) return null;
  const sentCount = card.sent.reduce((count, group) => count + group.indices.length, 0);
  if (sentCount >= card.steps.length) return null;

  const rows = nextStepsRows(card.steps, card.sent);
  // Combine in the order the card shows the rows, not the order they were clicked.
  const selected = rows.flatMap((row) => (card.selected.includes(row.index) ? [row.index] : []));
  const branch = thread.branch;
  const canWorktree = branch !== null && project !== null;
  const useWorktree = worktree && canWorktree;

  const toggle = (index: number) =>
    save(key, {
      ...card,
      selected: card.selected.includes(index)
        ? card.selected.filter((candidate) => candidate !== index)
        : [...card.selected, index],
    });

  const markSent = (destination: NextStepsDestination) =>
    save(key, {
      ...card,
      selected: [],
      sent: [...card.sent, { indices: selected, destination }],
    });

  const fail = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "Something went wrong.",
      }),
    );

  const currentModel = () =>
    composerRef?.current?.getSendContext().selectedModelSelection ?? thread.modelSelection;

  // Queues behind a running turn, like a normal send.
  const sendHere = async (text: string, createdAt: string) => {
    const messageId = newMessageId();
    const result = await startTurn({
      environmentId,
      input: {
        threadId: thread.id,
        message: { messageId, role: "user", text, attachments: [] },
        modelSelection: currentModel(),
        runtimeMode: props.runtimeMode,
        interactionMode: props.interactionMode,
        dispatchMode: "queue",
        createdAt,
      },
    });
    if (result._tag === "Failure") {
      fail("Could not send the next steps", squashAtomCommandFailure(result));
      return null;
    }
    return messageId;
  };

  // Promise.finally, not try/finally: the React Compiler skips components that use the latter.
  const run = (action: () => Promise<void>) => {
    if (pending || selected.length === 0) return;
    setPending(true);
    void action().finally(() => setPending(false));
  };

  const onSendHere = () =>
    run(async () => {
      const messageId = await sendHere(
        combineNextStepPrompts(card.steps, selected),
        new Date().toISOString(),
      );
      if (messageId !== null) markSent({ type: "here", messageId });
    });

  const onDelegate = (instanceId: ProviderInstanceId, model: string) =>
    run(async () => {
      const text = buildDelegatePrompt({
        task: combineNextStepPrompts(card.steps, selected),
        target: { instanceId, model },
        worktree: useWorktree,
      });
      const messageId = await sendHere(text, new Date().toISOString());
      const modelLabel =
        props.models.modelOptionsByInstance.get(instanceId)?.find((option) => option.slug === model)
          ?.name ?? model;
      if (messageId !== null) markSent({ type: "delegate", messageId, modelLabel });
    });

  const onNewThread = () =>
    run(async () => {
      const threadId = newThreadId();
      const modelSelection = currentModel();
      const title = card.steps[selected[0] ?? 0]?.label ?? "Next steps";
      const createdAt = new Date().toISOString();
      const result = await startTurn({
        environmentId,
        input: {
          threadId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: combineNextStepPrompts(card.steps, selected),
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: props.runtimeMode,
          interactionMode: props.interactionMode,
          bootstrap: {
            createThread: {
              projectId: thread.projectId,
              title,
              modelSelection,
              runtimeMode: props.runtimeMode,
              interactionMode: props.interactionMode,
              branch,
              worktreePath: useWorktree ? null : thread.worktreePath,
              createdAt,
            },
            ...(useWorktree && branch !== null && project !== null
              ? {
                  prepareWorktree: {
                    projectCwd: project.workspaceRoot,
                    baseBranch: branch,
                    requireWorktree: true,
                  },
                  runSetupScript: true,
                }
              : {}),
          },
          createdAt,
        },
      });
      if (result._tag === "Failure") {
        fail("Could not start the new thread", squashAtomCommandFailure(result));
        return;
      }
      markSent({ type: "thread", threadId, worktree: useWorktree });
    });

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-next-steps-card="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <SparklesIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="font-medium text-muted-foreground">Next steps</span>
            <span className="ms-auto text-muted-foreground/70">
              {sentCount}/{card.steps.length} done
            </span>
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <ComposerBanner.Dismiss
              aria-label="Close next steps"
              onClick={() => save(key, { ...card, closed: true })}
            />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <div className="grid">
          {rows.map((row) =>
            row.sent === null ? (
              <button
                key={row.index}
                type="button"
                aria-pressed={card.selected.includes(row.index)}
                onClick={() => toggle(row.index)}
                className="flex min-w-0 items-start gap-2.5 rounded-xl px-2 py-1.5 text-start hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <span className="mt-0.5 flex-none">
                  <CheckboxMark checked={card.selected.includes(row.index)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm/5 text-foreground">{row.step.label}</span>
                  <span className="block truncate text-muted-foreground/70">{row.step.prompt}</span>
                </span>
              </button>
            ) : (
              <SentRow key={row.index} row={row} threadRef={threadRef} onOpenThread={openThread} />
            ),
          )}
        </div>
        {/* Hidden, not removed, while nothing is selected so the rows don't jump when it shows. */}
        <div
          className={cn(
            "mt-1 flex flex-wrap items-center gap-1.5 border-t border-(--chat-composer-attached-outline) px-2 pt-2",
            selected.length === 0 && "invisible",
          )}
        >
          <span className="me-auto text-muted-foreground">
            {selected.length} selected
            {selected.length > 1 ? " · combined into one prompt" : ""}
          </span>
          <ProviderModelPicker
            environmentId={environmentId}
            activeInstanceId={thread.modelSelection.instanceId}
            model={thread.modelSelection.model}
            lockedProvider={null}
            instanceEntries={props.models.instanceEntries}
            modelOptionsByInstance={props.models.modelOptionsByInstance}
            size="xs"
            compact
            disabled={pending}
            triggerLabel="Delegate"
            triggerAriaLabel="Delegate to a model"
            onInstanceModelChange={(instanceId, picked) => onDelegate(instanceId, picked)}
          />
          <label
            className={cn(
              "flex items-center gap-1.5 px-1 text-muted-foreground",
              !canWorktree && "opacity-50",
            )}
          >
            <Switch
              size="sm"
              checked={useWorktree}
              disabled={!canWorktree}
              onCheckedChange={(checked) => setWorktree(Boolean(checked))}
            />
            Worktree
          </label>
          <Button size="xs" variant="outline" disabled={pending} onClick={onNewThread}>
            <SquarePlusIcon />
            New thread
          </Button>
          <Button size="xs" disabled={pending} onClick={onSendHere}>
            <CornerDownLeftIcon />
            Send here
          </Button>
        </div>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
}

function SentRow({
  row,
  threadRef,
  onOpenThread,
}: {
  readonly row: NextStepsRow;
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const sent = row.sent;
  const destination = sent?.group.destination;
  // Only a delegate tag needs the projection, to find the thread the agent started.
  const projection = useQuietThreadProjection(
    sent?.first === true && destination?.type === "delegate" ? threadRef : null,
  )?.projection;
  if (sent === null || destination === undefined) return null;
  const threadId =
    destination.type === "thread"
      ? destination.threadId
      : destination.type === "delegate"
        ? findDelegatedThreadId(projection ?? null, destination.messageId)
        : null;
  const label =
    destination.type === "here"
      ? "Sent here"
      : destination.type === "thread"
        ? `New thread${destination.worktree ? " · worktree" : ""}`
        : `Delegated · ${destination.modelLabel}`;
  const tagContent = (
    <>
      <CheckIcon className="size-3 text-success" />
      {label}
    </>
  );
  return (
    <div className="flex min-w-0 items-start gap-2.5 px-2 py-1.5">
      {/* A dot in the checkbox column; rows sent together are joined by a line. */}
      <span aria-hidden className="relative -my-1.5 w-4 flex-none self-stretch">
        {sent.joinsUp ? (
          <span className="absolute top-0 left-1/2 h-4 w-0.5 -translate-x-1/2 bg-foreground/85" />
        ) : null}
        {sent.joinsDown ? (
          <span className="absolute top-4 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-foreground/85" />
        ) : null}
        <span className="absolute top-4 left-1/2 size-1.5 -translate-1/2 rounded-full bg-foreground/85" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm/5 text-muted-foreground/70 line-through decoration-foreground/20">
        {row.step.label}
      </span>
      {!sent.first ? null : threadId === null ? (
        <span className="flex flex-none items-center gap-1 text-muted-foreground">
          {tagContent}
        </span>
      ) : (
        <button
          type="button"
          aria-label={`Open thread: ${label}`}
          onClick={() => onOpenThread(threadId)}
          className="group/tag -mx-1.5 -my-0.5 flex flex-none items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          {tagContent}
          <ArrowUpRightIcon className="size-3 opacity-0 transition-opacity group-hover/tag:opacity-100" />
        </button>
      )}
    </div>
  );
}
