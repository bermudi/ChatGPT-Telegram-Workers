import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const embeddingDimensions = 1536;

const memoryFields = {
  telegramUserId: v.string(),
  sourceChatId: v.string(),
  sourceMessageId: v.string(),
  text: v.string(),
  abstract: v.string(),
  tags: v.array(v.string()),
  embedding: v.array(v.float64()),
  hash: v.string(),
  createdAt: v.int64(),
  updatedAt: v.int64(),
};

const memoryTable = defineTable(memoryFields)
  .index("by_user", ["telegramUserId"])
  .index("by_user_hash", ["telegramUserId", "hash"])
  .vectorIndex("by_embedding", {
    vectorField: "embedding",
    dimensions: embeddingDimensions,
    filterFields: ["telegramUserId"],
  });

export default defineSchema({
  memoryIdentities: memoryTable,
  memoryPreferences: memoryTable,
  memoryExperiences: memoryTable,
  memoryActivities: memoryTable,
  memoryContexts: memoryTable,
  memoryPersonas: memoryTable,
});
