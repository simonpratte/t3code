import { describe, expect, it } from "vite-plus/test";

import { sanitizeNextSteps } from "./nextStepsPrompt.ts";

describe("sanitizeNextSteps", () => {
  it("drops blank and repeated prompts, cleans labels, and keeps four", () => {
    expect(
      sanitizeNextSteps([
        { label: '"Run the tests."', prompt: "  Run the test suite  " },
        { label: "Again", prompt: "run the   TEST suite" },
        { label: "Empty", prompt: "   " },
        { label: "", prompt: "Commit the\nchange" },
        { label: "Two\nlines", prompt: "Open a PR" },
        { label: "Docs", prompt: "Update the docs" },
        { label: "Extra", prompt: "One too many" },
      ]),
    ).toEqual([
      { label: "Run the tests", prompt: "Run the test suite" },
      { label: "Commit the change", prompt: "Commit the\nchange" },
      { label: "Two", prompt: "Open a PR" },
      { label: "Docs", prompt: "Update the docs" },
    ]);
  });
});
