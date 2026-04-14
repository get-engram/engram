import { Engram } from "@getengram/sdk";
import { json, dim, bold, cyan } from "../output.js";

/**
 * `engram log` — show recent AI conversation activity, like `git log`.
 * Defaults to auto-captured sessions. Shows project, branch, timestamp,
 * message count, and the first user message as a preview.
 */
export async function log(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const limit = flags.limit ? parseInt(flags.limit) : 15;
  const tags = flags.tags
    ? flags.tags.split(",")
    : flags.all !== undefined
      ? undefined
      : ["auto-capture"];

  const result = await engram.listConversations({
    limit,
    tags,
    sort: "updated_at",
    order: "desc",
  });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  if (result.conversations.length === 0) {
    console.log("No conversations found.");
    if (!flags.all) {
      console.log(dim("Use --all to show manually-created conversations too."));
    }
    return;
  }

  for (const c of result.conversations) {
    const meta = c.metadata as Record<string, unknown> | undefined;
    const branch = meta?.gitBranch as string | undefined;
    const project = meta?.projectDir as string | undefined;
    const capturedBy = meta?.capturedBy as string | undefined;

    // Title line: project (branch) or conversation title
    const titleParts: string[] = [];
    if (project) titleParts.push(bold(project));
    if (branch) titleParts.push(cyan(branch));
    const title = titleParts.length > 0
      ? titleParts.join(" ")
      : bold(c.title ?? "(untitled)");

    // Timestamp
    const ts = c.updatedAt.slice(0, 16).replace("T", " ");

    // Status line
    const msgs = `${c.messageCount} msg${c.messageCount === 1 ? "" : "s"}`;
    const auto = capturedBy === "engram-daemon" ? dim(" [auto]") : "";

    console.log(`${title}${auto}`);
    console.log(`  ${dim(ts)}  ${dim(msgs)}  ${dim(c.id)}`);
    console.log();
  }
}
