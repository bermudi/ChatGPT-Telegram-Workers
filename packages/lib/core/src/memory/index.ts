import type * as Telegram from 'telegram-bot-api-types';
import type { HistoryItem, UserMessageItem } from '#/agent';
import type { WorkerContext } from '#/config';
import { extractTextContent } from '#/agent/utils';
import { ENV } from '#/config';

export type MemoryLayer = 'identities' | 'preferences' | 'experiences' | 'activities' | 'contexts' | 'personas';

export interface MemoryContextItem {
    layer: MemoryLayer;
    text: string;
    abstract: string;
    tags: string[];
    score: number;
}

interface MemoryContextResponse {
    items: MemoryContextItem[];
}

interface MemoryExtractionPayload {
    telegramUserId: string;
    sourceChatId: string;
    sourceMessageId: string;
    text: string;
    context: string;
}

const memoryContextHeading = 'User Memory Context';

function isMemoryEnabled(): boolean {
    return ENV.MEMORY_ENABLE && !!ENV.MEMORY_CONVEX_URL;
}

function normalizeConvexUrl(raw: string): string {
    return raw.replace(/\/+$/, '');
}

function resolveUserId(message: Telegram.Message): string {
    const userId = message.from?.id ?? message.chat.id;
    return `${userId}`;
}

function resolveChatId(message: Telegram.Message): string {
    return `${message.chat.id}`;
}

function messageToText(message: UserMessageItem | null): string {
    if (!message) {
        return '';
    }
    if (typeof message.content === 'string') {
        return message.content;
    }
    if (Array.isArray(message.content)) {
        return message.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join(' ')
            .trim();
    }
    return '';
}

function formatMemoryContext(items: MemoryContextItem[]): string {
    if (items.length === 0) {
        return '';
    }
    const lines = items.map((item) => {
        const tags = item.tags?.length ? ` [${item.tags.join(', ')}]` : '';
        const content = item.abstract || item.text;
        return `- (${item.layer}) ${content}${tags}`;
    });
    const content = `${memoryContextHeading}:\n${lines.join('\n')}`;
    if (!ENV.MEMORY_CONTEXT_MAX_CHARS || content.length <= ENV.MEMORY_CONTEXT_MAX_CHARS) {
        return content;
    }
    return content.slice(0, ENV.MEMORY_CONTEXT_MAX_CHARS);
}

async function fetchMemoryContext(query: string, message: Telegram.Message): Promise<MemoryContextItem[]> {
    if (!isMemoryEnabled()) {
        return [];
    }
    const url = `${normalizeConvexUrl(ENV.MEMORY_CONVEX_URL)}/memory/context`;
    const payload = {
        telegramUserId: resolveUserId(message),
        query,
    };
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (ENV.MEMORY_CONVEX_SECRET) {
        headers.Authorization = `Bearer ${ENV.MEMORY_CONVEX_SECRET}`;
    }
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        throw new Error(`Memory context request failed: ${response.statusText}`);
    }
    const data = await response.json() as MemoryContextResponse;
    return data.items || [];
}

async function loadHistory(key: string): Promise<HistoryItem[]> {
    let history: HistoryItem[] = [];
    try {
        history = JSON.parse(await ENV.DATABASE.get(key));
    } catch (e) {
        console.error(e);
    }
    if (!history || !Array.isArray(history)) {
        history = [];
    }
    return history;
}

function buildContextWindow(history: HistoryItem[], limit: number): string {
    if (limit <= 0 || history.length === 0) {
        return '';
    }
    const recent = history.slice(-limit);
    const lines = recent
        .map((item) => extractTextContent(item))
        .filter((text) => text && text.trim().length > 0)
        .map((text) => `- ${text.trim()}`);
    return lines.join('\n');
}

async function shouldExtractMemory(telegramUserId: string): Promise<boolean> {
    if (ENV.MEMORY_EXTRACTION_MIN_INTERVAL_SECONDS <= 0) {
        return true;
    }
    const key = `memory_extract:last:${telegramUserId}`;
    const last = await ENV.DATABASE.get(key).then((value) => Number.parseInt(value || '0', 10)).catch(() => 0);
    const now = Math.floor(Date.now() / 1000);
    if (now - last < ENV.MEMORY_EXTRACTION_MIN_INTERVAL_SECONDS) {
        return false;
    }
    await ENV.DATABASE.put(key, `${now}`, { expirationTtl: ENV.MEMORY_EXTRACTION_MIN_INTERVAL_SECONDS });
    return true;
}

async function sendAutoExtraction(payload: MemoryExtractionPayload): Promise<void> {
    if (!isMemoryEnabled()) {
        return;
    }
    const url = `${normalizeConvexUrl(ENV.MEMORY_CONVEX_URL)}/memory/auto-extract`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (ENV.MEMORY_CONVEX_SECRET) {
        headers.Authorization = `Bearer ${ENV.MEMORY_CONVEX_SECRET}`;
    }
    const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Memory extraction request failed: ${response.status} ${message}`);
    }
}

export async function buildMemoryPrompt(
    message: Telegram.Message,
    params: UserMessageItem | null,
): Promise<string> {
    if (!isMemoryEnabled()) {
        return '';
    }
    const query = messageToText(params);
    if (!query) {
        return '';
    }
    const items = await fetchMemoryContext(query, message);
    return formatMemoryContext(items);
}

export async function queueMemoryExtraction(
    message: Telegram.Message,
    params: UserMessageItem | null,
    context: WorkerContext,
): Promise<void> {
    if (!isMemoryEnabled()) {
        return;
    }
    const telegramUserId = resolveUserId(message);
    if (!(await shouldExtractMemory(telegramUserId))) {
        return;
    }
    const history = await loadHistory(context.SHARE_CONTEXT.chatHistoryKey);
    const text = messageToText(params);
    if (!text) {
        return;
    }
    const payload: MemoryExtractionPayload = {
        telegramUserId,
        sourceChatId: resolveChatId(message),
        sourceMessageId: `${message.message_id}`,
        text,
        context: buildContextWindow(history, ENV.MEMORY_EXTRACTION_MAX_CONTEXT_MESSAGES),
    };
    await sendAutoExtraction(payload);
}

export function mergeSystemPrompt(basePrompt: string | null, memoryPrompt: string): string | null {
    if (!memoryPrompt) {
        return basePrompt;
    }
    if (!basePrompt) {
        return memoryPrompt;
    }
    return `${basePrompt}\n\n${memoryPrompt}`;
}
