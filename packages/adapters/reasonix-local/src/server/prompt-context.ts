import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { parseObject, asString } from "@paperclipai/adapter-utils/server-utils";

export interface PaperclipPromptContextOptions {
  mcpToolPrefix?: string;
  extraTools?: string[];
}

const DEFAULT_PAPERCLIP_TOOL_HINTS = [
  "paperclip_addComment(issueId, body) - post a comment on a Paperclip issue.",
  "paperclip_updateIssue(issueId, fields) - update issue fields (status, title, priority, ...).",
  "paperclip_apiRequest(method, path, body?) - generic Paperclip API call.",
];

export function buildPaperclipPromptContext(
  ctx: AdapterExecutionContext,
  options: PaperclipPromptContextOptions = {},
): string {
  const prefix = options.mcpToolPrefix ?? "paperclip_";
  const context = parseObject(ctx.context);
  const issue = parseObject(context.issue);
  const issueId = asString(issue.id, "").trim() || asString(issue.identifier, "").trim();
  const issueTitle = asString(issue.title, "").trim();
  const agentId = ctx.agent?.id ?? "";

  const tools = DEFAULT_PAPERCLIP_TOOL_HINTS.map((line) =>
    line.replace(/paperclip_/g, prefix),
  );
  for (const extra of options.extraTools ?? []) {
    if (typeof extra === "string" && extra.trim()) tools.push(extra.trim());
  }

  const lines: string[] = ["You are working as a Paperclip agent."];
  if (issueId) {
    lines.push(`Issue: ${issueTitle ? `${issueTitle} (id: ${issueId})` : issueId}`);
  }
  if (agentId) lines.push(`Paperclip agent id: ${agentId}`);
  lines.push("");
  lines.push(`Paperclip tools available via the ${prefix} MCP prefix:`);
  for (const tool of tools) lines.push(`- ${tool}`);
  lines.push("");
  lines.push(
    "The Paperclip API base is exposed via the PAPERCLIP_API_URL environment variable; authentication is preconfigured.",
  );
  lines.push(
    `When the task asks for status updates, prefer ${prefix}updateIssue. When asking for human input, post a ${prefix}addComment and stop.`,
  );

  return lines.join("\n");
}
