import { readFile } from "node:fs/promises";
import { Engram, type MessageInput } from "@getengram/sdk";
import { json, green } from "../output.js";

export async function store(
  engram: Engram,
  args: string[],
  flags: Record<string, string>,
): Promise<void> {
  const conversationId = flags.conversation ?? flags.c;

  if (!conversationId) {
    console.error("Usage: engram store --conversation <id> [options]");
    console.error("\nOptions:");
    console.error("  --conversation, -c  Conversation ID (required)");
    console.error("  --role              Message role (default: user)");
    console.error("  --file              Read content from file (- for stdin)");
    console.error("  --json              Output as JSON");
    console.error("\nExamples:");
    console.error('  engram store -c conv_abc "Hello world"');
    console.error('  echo "content" | engram store -c conv_abc --file -');
    console.error('  engram store -c conv_abc --role assistant "Response text"');
    process.exit(1);
  }

  let content: string;

  if (flags.file === "-") {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    content = Buffer.concat(chunks).toString("utf-8").trim();
  } else if (flags.file) {
    content = await readFile(flags.file, "utf-8");
  } else {
    content = args.join(" ");
  }

  if (!content) {
    console.error("Error: No message content provided");
    process.exit(1);
  }

  const role = (flags.role ?? "user") as MessageInput["role"];
  const messages: MessageInput[] = [{ role, content }];

  if (flags.tool) {
    messages[0].toolName = flags.tool;
  }

  const result = await engram.store({ conversationId, messages });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  console.log(green(`✓ Stored ${result.appended} message(s)`));
  console.log(`  IDs: ${result.messageIds.join(", ")}`);
}
