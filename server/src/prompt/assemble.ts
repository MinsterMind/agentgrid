export function assemblePrompt(input: { memoryDir: string; index: string; task: string }): string {
  const index = input.index.trim() || "empty";
  return [
    `<agent-memory dir="${input.memoryDir}">`,
    `<index>`, index, `</index>`,
    `Read a memory file with Read when its one-line hook looks relevant to the task.`,
    `Before you finish, save any durable, non-obvious fact about this repo, its`,
    `tooling, or this kind of task as a new file in the memory dir (frontmatter:`,
    `name, description) and add one line to MEMORY.md. Do not save what the repo`,
    `or git history already records.`,
    `</agent-memory>`,
    ``,
    `<task>`, input.task.trim(), `</task>`,
  ].join("\n");
}
