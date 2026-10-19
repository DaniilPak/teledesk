// Minimal Telegram Bot API client. Without a token it runs in dry-run mode (logs calls).
export function createTelegram(token) {
  let fakeId = 1000;

  async function call(method, params = {}) {
    if (!token) {
      console.log(`[telegram dry-run] ${method}`, JSON.stringify(params));
      return { message_id: ++fakeId };
    }
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description || res.status}`);
    return body.result;
  }

  return {
    call,
    sendMessage: (chatId, text, extra = {}) =>
      call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...extra,
      }),
    react: (chatId, messageId, emoji = '👍') =>
      call('setMessageReaction', {
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji }],
      }).catch(() => null),
    answerCallback: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }).catch(() => null),
    editKeyboard: (chatId, messageId, keyboard) =>
      call('editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: { inline_keyboard: keyboard },
      }).catch(() => null),
  };
}
