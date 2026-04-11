import { nanoid } from "nanoid";

const PREFIXES = {
  org: "org_",
  conv: "conv_",
  msg: "msg_",
  key: "key_",
  chk: "chk_",
  seat: "seat_",
  whk: "whk_",
  whd: "whd_",
  usg: "usg_",
} as const;

type PrefixKey = keyof typeof PREFIXES;

export function generateId(prefix: PrefixKey, size = 21): string {
  return `${PREFIXES[prefix]}${nanoid(size)}`;
}

export function generateApiKeyRaw(): { raw: string; prefix: string } {
  const raw = `engram_sk_live_${nanoid(32)}`;
  const prefix = raw.slice(0, 20);
  return { raw, prefix };
}

export function generateWebhookSecret(): string {
  return `whsec_${nanoid(32)}`;
}
