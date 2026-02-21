import type { GenericActionCtx, GenericMutationCtx, GenericQueryCtx, VectorSearch } from "convex/server";
import { anyApi, httpActionGeneric, httpRouter, actionGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
const layers = [
  "identities",
  "preferences",
  "experiences",
  "activities",
  "contexts",
  "personas",
] as const;

type MemoryLayer = (typeof layers)[number];

const layerToTable: Record<MemoryLayer, string> = {
  identities: "memoryIdentities",
  preferences: "memoryPreferences",
  experiences: "memoryExperiences",
  activities: "memoryActivities",
  contexts: "memoryContexts",
  personas: "memoryPersonas",
};

const MemoryLayerValidator = v.union(
  v.literal("identities"),
  v.literal("preferences"),
  v.literal("experiences"),
  v.literal("activities"),
  v.literal("contexts"),
  v.literal("personas"),
);

const MemoryItem = v.object({
  layer: MemoryLayerValidator,
  text: v.string(),
  abstract: v.string(),
  tags: v.array(v.string()),
});

const ExtractionPayload = v.object({
  telegramUserId: v.string(),
  sourceChatId: v.string(),
  sourceMessageId: v.string(),
  text: v.string(),
  context: v.string(),
});

const UpsertPayload = v.object({
  layer: MemoryLayerValidator,
  telegramUserId: v.string(),
  sourceChatId: v.string(),
  sourceMessageId: v.string(),
  text: v.string(),
  abstract: v.string(),
  tags: v.array(v.string()),
  embedding: v.array(v.float64()),
  hash: v.string(),
});

const ContextPayload = v.object({
  telegramUserId: v.string(),
  query: v.string(),
});

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

async function fetchEmbedding(text: string): Promise<number[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_EMBEDDING_MODEL || "text-embedding-3-large";
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const response = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: text,
      model,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter embeddings failed: ${response.status}`);
  }
  const data = await response.json() as EmbeddingResponse;
  return data.data[0]?.embedding || [];
}

function hashMemory(layer: MemoryLayer, text: string): string {
  const normalized = text.trim().toLowerCase();
  const input = `${layer}:${normalized}`;
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return `${hash}`;
}

export const upsertMemory = mutationGeneric({
  args: { payload: UpsertPayload },
  handler: async (ctx: GenericMutationCtx<any>, { payload }: { payload: typeof UpsertPayload.type }) => {
    const table = layerToTable[payload.layer];
    const now = Date.now();
    const existing = await ctx.db
      .query(table)
      .withIndex("by_user_hash", (q: any) =>
        q.eq("telegramUserId", payload.telegramUserId).eq("hash", payload.hash),
      )
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        text: payload.text,
        abstract: payload.abstract,
        tags: payload.tags,
        embedding: payload.embedding,
        updatedAt: now,
      });
      return { updated: true };
    }
    await ctx.db.insert(table, {
      telegramUserId: payload.telegramUserId,
      sourceChatId: payload.sourceChatId,
      sourceMessageId: payload.sourceMessageId,
      text: payload.text,
      abstract: payload.abstract,
      tags: payload.tags,
      embedding: payload.embedding,
      hash: payload.hash,
      createdAt: now,
      updatedAt: now,
    });
    return { inserted: true };
  },
});

export const extractMemories = actionGeneric({
  args: { payload: ExtractionPayload },
  handler: async (ctx: GenericActionCtx<any>, { payload }: { payload: typeof ExtractionPayload.type }) => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const model = process.env.OPENROUTER_CHAT_MODEL || "openai/gpt-4o-mini";
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is not set");
    }
    const system = `You are a memory extraction service. Extract JSON memories grouped by layer: identities, preferences, experiences, activities, contexts, personas. Return strict JSON with key \"items\" as array of objects {layer, text, abstract, tags}. Only include meaningful user-specific facts.`;
    const user = `Conversation message: ${payload.text}\nContext window:\n${payload.context}`;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter extraction failed: ${response.status}`);
    }
    const data = await response.json() as any;
    const content = data.choices?.[0]?.message?.content as string;
    if (!content) {
      return { inserted: 0 };
    }
    let parsed: { items: Array<typeof MemoryItem.type> };
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error("Failed to parse memory extraction response");
    }
    let inserted = 0;
    for (const item of parsed.items || []) {
      if (!layers.includes(item.layer)) {
        continue;
      }
      const embedding = await fetchEmbedding(item.text || item.abstract);
      const hash = hashMemory(item.layer, item.text || item.abstract);
      await ctx.runMutation(anyApi.memory.upsertMemory, {
        payload: {
          layer: item.layer,
          telegramUserId: payload.telegramUserId,
          sourceChatId: payload.sourceChatId,
          sourceMessageId: payload.sourceMessageId,
          text: item.text,
          abstract: item.abstract,
          tags: item.tags,
          embedding,
          hash,
        },
      });
      inserted += 1;
    }
    return { inserted };
  },
});

export const memoryContext = queryGeneric({
  args: { payload: ContextPayload },
  handler: async (ctx: GenericQueryCtx<any>, { payload }: { payload: typeof ContextPayload.type }) => {
    const queryEmbedding = await fetchEmbedding(payload.query);
    const results = await Promise.all(
      layers.map(async (layer) => {
        const table = layerToTable[layer] as any;
        const vectorSearch = (ctx.db as unknown as { vectorSearch: VectorSearch<any, any, any> }).vectorSearch;
        const matches = await vectorSearch(table, "by_embedding", {
          vector: queryEmbedding,
          limit: 3,
          filter: (q: any) => q.eq("telegramUserId", payload.telegramUserId),
        });
        const records = await Promise.all(matches.map((match: any) => ctx.db.get(match._id)));
        return records
          .filter(Boolean)
          .map((record: any, index: number) => ({
            layer,
            record,
            score: matches[index]?._score ?? 0,
          }));
      }),
    );
    const items = results.flat().map(({ layer, record, score }: { layer: MemoryLayer; record: any; score: number }) => ({
      layer,
      text: record?.text,
      abstract: record?.abstract,
      tags: record?.tags ?? [],
      score,
    }));
    items.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
    return { items };
  },
});

export const autoExtractFromMessage = mutationGeneric({
  args: { payload: ExtractionPayload },
  handler: async (ctx: GenericMutationCtx<any>, { payload }: { payload: typeof ExtractionPayload.type }) => {
    await ctx.scheduler.runAfter(0, anyApi.memory.extractMemories, { payload });
    return { queued: true };
  },
});

export const http = httpRouter();

http.route({
  path: "/memory/auto-extract",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    const payload = await request.json();
    const parsed = parseExtractionPayload(payload);
    await ctx.runMutation(anyApi.memory.autoExtractFromMessage, { payload: parsed });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }),
});

http.route({
  path: "/memory/context",
  method: "POST",
  handler: httpActionGeneric(async (ctx, request) => {
    const payload = await request.json();
    const parsed = parseContextPayload(payload);
    const result = await ctx.runQuery(anyApi.memory.memoryContext, { payload: parsed });
    return new Response(JSON.stringify(result), { status: 200 });
  }),
});

function parseExtractionPayload(payload: any): typeof ExtractionPayload.type {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid extraction payload");
  }
  const { telegramUserId, sourceChatId, sourceMessageId, text, context } = payload as Record<string, unknown>;
  if (
    typeof telegramUserId !== "string"
    || typeof sourceChatId !== "string"
    || typeof sourceMessageId !== "string"
    || typeof text !== "string"
    || typeof context !== "string"
  ) {
    throw new Error("Invalid extraction payload fields");
  }
  return { telegramUserId, sourceChatId, sourceMessageId, text, context };
}

function parseContextPayload(payload: any): typeof ContextPayload.type {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid context payload");
  }
  const { telegramUserId, query } = payload as Record<string, unknown>;
  if (typeof telegramUserId !== "string" || typeof query !== "string") {
    throw new Error("Invalid context payload fields");
  }
  return { telegramUserId, query };
}

export default http;
