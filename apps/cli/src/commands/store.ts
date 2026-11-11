import { readFile } from "node:fs/promises";
import { Engram, type MessageInput } from "@getengram/sdk";
import { json, green, dim, plural } from "../output.js";
import { MAX_MESSAGE_CONTENT_CHARS, boundContent, stripBinaryPayloads } from "../message-bounds.js";

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

  // Bounded the way Engram bounds it on arrival (engram#750): Engram stores
  // the same text, or in one case less (see message-bounds.ts), and a large
  // file is no longer refused for its size. Said, so nobody is surprised by
  // what was kept.
  const bounded = boundContent(content);
  const stripped = stripBinaryPayloads(content);
  const kept: string[] = [];
  if (stripped !== content) {
    kept.push("file data in it (base64 images, PDFs) is saved as a note saying what it was");
  }
  if (stripped.length > MAX_MESSAGE_CONTENT_CHARS) {
    kept.push("it is saved cut at 100,000 characters, the most Engram keeps of one message");
  }
  if (kept.length > 0) console.error(dim(`Note: ${kept.join(", and ")}.`));

  const role = (flags.role ?? "user") as MessageInput["role"];
  const messages: MessageInput[] = [{ role, content: bounded }];

  if (flags.tool) {
    messages[0].toolName = flags.tool;
  }

  const result = await engram.store({ conversationId, messages });

  if (flags.json !== undefined) {
    json(result);
    return;
  }

  console.log(green(`✓ Stored ${plural(result.appended, "message")}`));
  console.log(`  IDs: ${result.messageIds.join(", ")}`);
}
