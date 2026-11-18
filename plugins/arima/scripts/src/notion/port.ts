import { Client } from '@notionhq/client';
import { Throttle } from '../lib/throttle.js';

/** Name of the kill-switch to-do on the project root page (spec §11.3 "Pause ARIMA"). */
export const PAUSE_TODO_TEXT = 'Pause ARIMA';

export interface TodoBlock {
  id: string;
  text: string;
  checked: boolean;
}

/**
 * The only Notion operations ARIMA is allowed to perform. There is deliberately no delete and no
 * archive (spec §9.3, §11.1; ADR-0003): items are retired by changing a status, never removed.
 * Later tasks extend this port (database access, outbox apply) without ever adding a delete.
 */
export interface NotionPort {
  /** To-do blocks directly under a page. */
  listTodoBlocks(pageId: string): Promise<TodoBlock[]>;
  setTodoChecked(blockId: string, checked: boolean): Promise<void>;
  /** Appends a to-do block to a page and returns its id. */
  appendTodo(pageId: string, text: string, checked: boolean): Promise<string>;
}

/** The slice of the official SDK client the port uses, so tests can fake it. */
export interface NotionClientLike {
  blocks: {
    children: {
      list(args: { block_id: string; start_cursor?: string; page_size?: number }): Promise<{
        results: unknown[];
        has_more: boolean;
        next_cursor: string | null;
      }>;
      append(args: { block_id: string; children: unknown[] }): Promise<{ results: unknown[] }>;
    };
    update(args: { block_id: string; to_do: { checked: boolean } }): Promise<unknown>;
  };
}

interface RawBlock {
  id?: string;
  type?: string;
  to_do?: { rich_text?: { plain_text?: string }[]; checked?: boolean };
}

export function createNotionPort(
  client: NotionClientLike,
  throttle: Throttle = new Throttle(),
): NotionPort {
  return {
    async listTodoBlocks(pageId) {
      const out: TodoBlock[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await throttle.run(() =>
          client.blocks.children.list({
            block_id: pageId,
            page_size: 100,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          }),
        );
        for (const raw of page.results as RawBlock[]) {
          if (raw.type === 'to_do' && raw.id !== undefined && raw.to_do) {
            out.push({
              id: raw.id,
              text: (raw.to_do.rich_text ?? []).map((t) => t.plain_text ?? '').join(''),
              checked: raw.to_do.checked === true,
            });
          }
        }
        if (!page.has_more || page.next_cursor === null) return out;
        cursor = page.next_cursor;
      }
    },

    async setTodoChecked(blockId, checked) {
      await throttle.run(() => client.blocks.update({ block_id: blockId, to_do: { checked } }));
    },

    async appendTodo(pageId, text, checked) {
      const res = await throttle.run(() =>
        client.blocks.children.append({
          block_id: pageId,
          children: [
            {
              object: 'block',
              type: 'to_do',
              to_do: { rich_text: [{ type: 'text', text: { content: text } }], checked },
            },
          ],
        }),
      );
      const id = (res.results[0] as RawBlock | undefined)?.id;
      if (id === undefined) throw new Error('Notion did not return the created block');
      return id;
    },
  };
}

/** Real port from an integration token. Retries on 429 are handled by the SDK. */
export function createNotionPortFromToken(token: string): NotionPort {
  const client = new Client({ auth: token, retry: { maxRetries: 5 } });
  return createNotionPort(client as unknown as NotionClientLike);
}
