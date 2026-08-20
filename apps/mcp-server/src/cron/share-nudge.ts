import type { Env } from "../types.js";

// Weekly share-drafts email (Mondays, piggybacking the 13:00 UTC cron):
// read the blog's RSS feed, find posts published in the last 7 days, and
// email the owner ready-to-paste share blurbs for X and LinkedIn via the
// engram-web support-reply route. Automation up to — but not including —
// the post button: outbound social copy stays human-approved, and
// auto-posting bots get punished on Reddit/HN anyway.

const FEED_URL = "https://getengram.app/feed.xml";
const OWNER_EMAIL = "hello@getengram.app";

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: Date;
}

function extract(tag: string, xml: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : "";
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export async function sendShareNudge(env: Env): Promise<number> {
  const res = await fetch(FEED_URL, { headers: { "User-Agent": "engram-share-nudge/1.0" } });
  if (!res.ok) throw new Error(`feed fetch failed: ${res.status}`);
  const xml = await res.text();

  const items: FeedItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const body = m[1];
    const pub = new Date(extract("pubDate", body));
    if (Number.isNaN(pub.getTime())) continue;
    items.push({
      title: unescapeXml(extract("title", body)),
      link: extract("link", body),
      description: unescapeXml(extract("description", body)),
      pubDate: pub,
    });
  }

  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const fresh = items.filter((i) => i.pubDate.getTime() >= weekAgo);
  if (fresh.length === 0) return 0;

  const sections = fresh
    .map((p) => {
      const short = p.description.length > 200 ? p.description.slice(0, 197) + "…" : p.description;
      return `── ${p.title}
${p.link}

X/Twitter draft:
${short}
${p.link}

LinkedIn draft:
${p.title}

${p.description}

Read: ${p.link}`;
    })
    .join("\n\n\n");

  const text = `You published ${fresh.length} blog post${fresh.length > 1 ? "s" : ""} this week that ${fresh.length > 1 ? "haven't" : "hasn't"} been shared yet. Paste-ready drafts below — edit freely, the hook is usually worth personalizing.

${sections}

(Automated weekly nudge from the Engram worker. Posts detected via getengram.app/feed.xml.)`;

  const send = await fetch(`${env.APP_URL}/api/email/support-reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${(env as Env & { ADMIN_SECRET?: string }).ADMIN_SECRET ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: OWNER_EMAIL,
      subject: `Share drafts: ${fresh.length} new blog post${fresh.length > 1 ? "s" : ""} this week`,
      text,
    }),
  });
  if (!send.ok) throw new Error(`share-nudge email failed: ${send.status}`);
  return fresh.length;
}
