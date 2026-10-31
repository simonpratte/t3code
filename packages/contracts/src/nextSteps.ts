import * as Schema from "effect/Schema";

import { RunId, ThreadId } from "./baseSchemas.ts";

/** Keyed by run so each settled turn gets one set of suggestions and later turns cannot reuse it. */
export const NextStepsInput = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
});
export type NextStepsInput = typeof NextStepsInput.Type;

export const NextStep = Schema.Struct({
  /** A few words for the card row. */
  label: Schema.String,
  /** The full message sent to the agent. */
  prompt: Schema.String,
});
export type NextStep = typeof NextStep.Type;

export const NextStepsResult = Schema.Struct({
  /** At most four. Empty when the run is not the thread's settled latest or generation failed. */
  steps: Schema.Array(NextStep),
});
export type NextStepsResult = typeof NextStepsResult.Type;
