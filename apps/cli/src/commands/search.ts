import { Engram } from "@getengram/sdk";
import { json, dim, cyan, bold } from "../output.js";

export async function search(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const query = args.join(" ");

  if (!query) {
    console.error("Usage: engram search <query> [options]");
    console.error("\nOptions:");
    console.error("  --limit        Max results (default: 10)");
    console.error("  --conversation Limit to specific conversation");
    console.error("  --tags         Filter by tags (comma-separated)");
    console.error("  --json         Output as JSON");
    console.error("\nExamples:");
    console.error('  engram search "deployment to production"');
    console.error('  engram search "user preferences" --limit 5');
    console.error('  engram search "error handling" --tags prod,api');
    process.exit(1);
  }

  const result = await engram.search({
    query,
    limit: flags.limit ? parseInt(flags.limit) : undefined,
    conversationId: flags.conversation ?? flags.c,
    tags: flags.tags ? flags.tags.split(",") : undefined,
  });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  if (result.total === 0) {
    console.log("No results found.");
    return;
  }

  console.log(`${result.total} result(s)\n`);

  for (const r of result.results) {
    const score = (r.score * 100).toFixed(1);
    console.log(
      `${cyan(`[${score}%]`)} ${bold(r.conversationId)} ${dim(`seq ${r.startSequence}–${r.endSequence}`)}`,
    );

    // Show chunk text, indented
    const lines = r.chunkText.split("\n");
    for (const line of lines) {
      console.log(`  ${line}`);
    }
    console.log();
  }
}
