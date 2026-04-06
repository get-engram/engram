import { z } from "zod";

export const MessageInputSchema = z.object({
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  tool_call_id: z.string().optional(),
  tool_name: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const CreateConversationSchema = z.object({
  title: z.string().optional(),
  agent_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const AppendMessagesSchema = z.object({
  conversation_id: z.string(),
  messages: z.array(MessageInputSchema).min(1),
});

export const SearchSchema = z.object({
  query: z.string(),
  limit: z.number().int().min(1).max(50).optional().default(10),
  conversation_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const GetConversationSchema = z.object({
  conversation_id: z.string(),
  message_limit: z.number().int().min(1).max(500).optional().default(100),
  message_offset: z.number().int().min(0).optional().default(0),
});

export const ListConversationsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
  agent_id: z.string().optional(),
  tags: z.array(z.string()).optional(),
  sort: z.enum(["created_at", "updated_at", "message_count"]).optional().default("updated_at"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});

export const DeleteConversationSchema = z.object({
  conversation_id: z.string(),
});

export const SignupSchema = z.object({
  email: z.string().email(),
  plan: z.enum(["free", "pro"]).optional().default("free"),
});
