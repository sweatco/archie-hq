/**
 * Tool calls issued inside a subagent, by id. A background task started by one
 * of these is the subagent's own business: once the subagent has returned,
 * nothing waits on it, so it must not hold the PM busy.
 */
export function recordSubagentToolUses(
  event: { parent_tool_use_id: string | null; message: { content: unknown } },
  ids: Set<string>,
): void {
  if (!event.parent_tool_use_id) return;
  const content = event.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === 'tool_use' && typeof block.id === 'string') ids.add(block.id);
  }
}

export function isSubagentToolUse(toolUseId: string | undefined, ids: Set<string>): boolean {
  return toolUseId !== undefined && ids.has(toolUseId);
}
