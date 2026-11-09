import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { notifyCommand, TOAST_STATEMENTS } from "../daemon/status.js";

/**
 * engram#614 — the Windows toast, through the real Windows PowerShell, on
 * Windows only (CI runs it on windows-latest). Everything but showing it:
 * a CI machine has nobody signed in to see a toast, so the scripts below
 * stop short of Show, or only parse it.
 */

// What a title or body could hold that PowerShell, the Windows command line
// or XML would act on, were it put into the script or the toast's markup.
const TITLE = `Engram's "test" $(Write-Output pwned) \`whoami\``;
const BODY = `<b>not bold</b> & %PATH% C:\\Users\\O'Brien\\.engram $env:USERPROFILE; exit 1 — …`;

/** Run `script` the way notifyDesktop runs the toast, and decode what it prints as base64 UTF-8. */
function powershell(script: string): string {
  const command = notifyCommand(TITLE, BODY, "win32");
  if (!command) throw new Error("no Windows notifier");
  const out = execFileSync(command.file, [...command.args.slice(0, -1), script], {
    encoding: "utf8",
    env: { ...process.env, ...command.env },
    windowsHide: true,
    timeout: 60_000,
  });
  return Buffer.from(out.trim(), "base64").toString("utf8");
}

/** Base64 of UTF-8, so the console's code page can't change what comes back. */
const printed = (expression: string) =>
  `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${expression}))`;

function xmlText(xml: string): string[] {
  const entities: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
  return [...xml.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)].map(([, text]) =>
    text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(lt|gt|amp|quot|apos));/gi, (_, dec, hex, name) =>
      dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : entities[name],
    ),
  );
}

describe.runIf(process.platform === "win32")("the Windows toast (engram#614)", () => {
  it("puts the title and body in the toast exactly as written, as text", { timeout: 120_000 }, () => {
    const last = TOAST_STATEMENTS[TOAST_STATEMENTS.length - 1];
    expect(last).toMatch(/^\[Windows\.UI\.Notifications\.ToastNotificationManager\]::CreateToastNotifier\('[^']+'\)\.Show\(\$toast\)$/);
    const xml = powershell([...TOAST_STATEMENTS.slice(0, -1), printed("$template.GetXml()")].join("; "));
    expect(xmlText(xml)).toEqual([TITLE, BODY]);
    // Markup in the body stayed text: no <b> element in the toast.
    expect(xml).not.toContain("<b>");
  });

  it("gets the whole script through the Windows command line unchanged, and it parses", { timeout: 120_000 }, () => {
    // The script inside a script block is parsed but not run; the block
    // prints the script as PowerShell received it.
    const script = notifyCommand(TITLE, BODY, "win32")!.args[3];
    expect(powershell(`$s = {${script}}; ${printed("$s.ToString()")}`)).toBe(script);
  });
});
