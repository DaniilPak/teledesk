export class TelegramError extends Error {
  constructor(method, body, status) {
    super(`Telegram ${method} failed: ${body.description || status}`);
    this.method = method;
    this.code = body.error_code ?? status;
    this.description = body.description || '';
    this.retryAfter = body.parameters?.retry_after;
    this.migrateTo = body.parameters?.migrate_to_chat_id;
  }
}

// Minimal Telegram Bot API client. Without a token it runs in dry-run mode (logs calls, fakes results).
export function createTelegram(token) {
  let fakeId = 1000;

  async function call(method, params = {}) {
    if (!token) {
      console.log(`[telegram dry-run] ${method}`, JSON.stringify(params));
      if (method === 'createForumTopic') return { message_thread_id: ++fakeId, name: params.name };
      if (method === 'getChat') return { id: params.chat_id, is_forum: false };
      if (method === 'getChatMember') return { status: 'member' };
      return { message_id: ++fakeId };
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new TelegramError(method, body, res.status);
    return body.result;
  }

  return { call };
}
