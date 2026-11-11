import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode/core/agent"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionSearchText } from "@opencode/core/session/search-text"
import { Shell } from "@opencode/schema/shell"
import { Skill } from "@opencode/schema/skill"
import { DateTime } from "effect"

const created = DateTime.makeUnsafe(0)
const id = SessionMessage.ID.make("msg_1")
const compaction = { id, type: "compaction", reason: "auto", time: { created } } as const
const text = (value: string) => SessionMessage.AssistantText.make({ type: "text", text: value })

describe("SessionSearchText", () => {
  test("extracts user text and attachment names, assistant text parts and completed compaction summaries", () => {
    expect(
      SessionSearchText.fromMessage(
        SessionMessage.User.make({
          id,
          type: "user",
          text: "Why does login fail?",
          files: [{ data: "", mime: "text/plain", source: { type: "inline" }, name: "leakfile.txt" }],
          time: { created },
        }),
      ),
    ).toEqual({ summary: "", user_text: "Why does login fail?\n\nleakfile.txt", assistant_text: "" })
    expect(
      SessionSearchText.fromMessage(
        SessionMessage.Assistant.make({
          id,
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
          content: [
            text("Looking at the handler."),
            SessionMessage.AssistantReasoning.make({ type: "reasoning", text: "leak reasoning" }),
            text(""),
            text("Found the bug."),
          ],
          time: { created },
        }),
      ),
    ).toEqual({ summary: "", user_text: "", assistant_text: "Looking at the handler.\n\nFound the bug." })
    expect(
      SessionSearchText.fromMessage(
        SessionMessage.CompactionCompleted.make({ ...compaction, status: "completed", summary: "Fixed login." }),
      ),
    ).toEqual({ summary: "Fixed login.", user_text: "", assistant_text: "" })
  })

  test("returns nothing for running compactions, blank text, runtime notices and system or skill messages", () => {
    const messages = [
      SessionMessage.CompactionRunning.make({ ...compaction, status: "running", summary: "draft" }),
      SessionMessage.User.make({ id, type: "user", text: "   ", time: { created } }),
      SessionMessage.Synthetic.make({
        id,
        type: "synthetic",
        text: "reloaded instructions",
        metadata: { notice: "instructions" },
        time: { created },
      }),
      SessionMessage.System.make({ id, type: "system", text: "system", time: { created } }),
      SessionMessage.Skill.make({
        id,
        type: "skill",
        skill: Skill.ID.make("skill"),
        name: Skill.Name.make("skill"),
        text: "skill",
        time: { created },
      }),
    ]
    expect(messages.map(SessionSearchText.fromMessage)).toEqual(messages.map(() => undefined))
  })

  test("extracts shell commands, tool calls and synthetic notes, but no outputs", () => {
    expect(
      SessionSearchText.fromMessage(
        SessionMessage.Shell.make({
          id,
          type: "shell",
          shellID: Shell.ID.make("sh_1"),
          command: "git log --oneline",
          status: "exited",
          output: { output: "leakoutput", cursor: 10, size: 10, truncated: false },
          time: { created },
        }),
      ),
    ).toEqual({ summary: "", user_text: "git log --oneline", assistant_text: "" })
    expect(
      SessionSearchText.fromMessage(
        SessionMessage.Assistant.make({
          id,
          type: "assistant",
          agent: Agent.defaultID,
          model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
          content: [
            text("Checking."),
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call_1",
              name: "read",
              state: SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: { filePath: "src/app.ts", limit: 20, options: { tags: ["hot"] } },
                content: [{ type: "text", text: "leakoutput" }],
              }),
              time: { created },
            }),
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call_2",
              name: "bash",
              state: SessionMessage.ToolStateStreaming.make({ status: "streaming", input: '{"command":"leakpartial' }),
              time: { created },
            }),
          ],
          time: { created },
        }),
      ),
    ).toEqual({ summary: "", user_text: "", assistant_text: "Checking.\n\nread src/app.ts hot" })
    expect(
      SessionSearchText.fromMessage(
        SessionMessage.Synthetic.make({
          id,
          type: "synthetic",
          text: "subagent found the bug",
          description: "Find the bug",
          metadata: { source: "subagent" },
          time: { created },
        }),
      ),
    ).toEqual({ summary: "Find the bug\n\nsubagent found the bug", user_text: "", assistant_text: "" })
  })

  test("bounds each call, and calls apart from the text, so they never crowd text out", () => {
    const call = (n: number) =>
      SessionMessage.AssistantTool.make({
        type: "tool",
        id: `call_${n}`,
        name: "write",
        state: SessionMessage.ToolStateRunning.make({
          status: "running",
          input: { content: "y".repeat(SessionSearchText.MaxCall * 2) },
          metadata: {},
        }),
        time: { created },
      })
    const fields = SessionSearchText.fromMessage(
      SessionMessage.Assistant.make({
        id,
        type: "assistant",
        agent: Agent.defaultID,
        model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
        content: [...Array.from({ length: 40 }, (_, n) => call(n)), text("z".repeat(SessionSearchText.MaxText + 10))],
        time: { created },
      }),
    )
    const [body, calls] = fields?.assistant_text.split("\n\n") ?? []
    expect(body).toBe("z".repeat(SessionSearchText.MaxText))
    expect(calls).toHaveLength(SessionSearchText.MaxAudit)
    expect(calls?.split("\n").every((line) => line.length <= SessionSearchText.MaxCall)).toBe(true)
  })

  test.each([
    ["decodeMessageRow", "decodeMessageRow\ndecode Message Row"],
    ["XMLHttpRequest", "XMLHttpRequest\nXML Http Request"],
    ["parseJSON", "parseJSON\nparse JSON"],
    ["base64Encode", "base64Encode\nbase64 Encode"],
    ["v2 HTTP 2FA snake_case", "v2 HTTP 2FA snake_case"],
    ["call parseJSON, then SessionStore.get", "call parseJSON, then SessionStore.get\nparse JSON Session Store"],
    ["Ошибка разборСтроки", "Ошибка разборСтроки\nразбор Строки"],
  ])("expands %p", (input, output) => {
    expect(SessionSearchText.expand(input)).toBe(output)
  })

  test("indexes at most MaxText characters of each field", () => {
    const fields = SessionSearchText.fromMessage(
      SessionMessage.User.make({
        id,
        type: "user",
        text: "a".repeat(SessionSearchText.MaxText + 10),
        time: { created },
      }),
    )
    expect(fields?.user_text).toHaveLength(SessionSearchText.MaxText)
  })
})
