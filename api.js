// -*- Telegram API Wrappers -*-

export async function callTelegram(env, method, payload) {
  const token = env.BOT_TOKEN;
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

export async function sendMessage(env, chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  return callTelegram(env, 'sendMessage', payload);
}

export async function sendPhoto(env, chatId, photoId, caption = '', replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    photo: photoId,
    caption: caption,
    parse_mode: 'HTML',
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  return callTelegram(env, 'sendPhoto', payload);
}

export async function sendPhotoFromBase64(env, chatId, base64Data, caption = '', replyMarkup = null) {
  try {
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const formData = new FormData();
    formData.append('chat_id', String(chatId));
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    if (replyMarkup) {
      formData.append('reply_markup', JSON.stringify(replyMarkup));
    }
    formData.append('photo', new Blob([bytes], { type: 'image/png' }), 'logo.png');

    const token = env.BOT_TOKEN;
    const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST',
      body: formData,
    });
    return res.json();
  } catch (e) {
    return sendMessage(env, chatId, caption, replyMarkup);
  }
}

export async function sendDocument(env, chatId, documentId, caption = '', replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    document: documentId,
    caption: caption,
    parse_mode: 'HTML',
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  return callTelegram(env, 'sendDocument', payload);
}

// ارسال یک فایل متنی ساخته‌شده در حافظه (مثلاً گزارش CSV) به‌صورت سند
export async function sendDocumentFile(env, chatId, filename, content, caption = '', mime = 'text/csv') {
  const formData = new FormData();
  formData.append('chat_id', String(chatId));
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  formData.append('document', new Blob([content], { type: mime }), filename);
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formData,
  });
  return res.json();
}

export async function answerCallbackQuery(env, callbackQueryId, options = {}) {
  const payload = {
    callback_query_id: callbackQueryId,
    text: options.text || '',
    show_alert: options.show_alert || false,
  };
  return callTelegram(env, 'answerCallbackQuery', payload);
}

export async function getChatMember(env, channelUsername, chatId) {
  return callTelegram(env, 'getChatMember', {
    chat_id: channelUsername,
    user_id: chatId,
  });
}

export async function getFile(env, fileId) {
  return callTelegram(env, 'getFile', {
    file_id: fileId,
  });
}

export async function downloadFileAsBase64(env, filePath) {
  const token = env.BOT_TOKEN;
  const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const res = await fetch(url);
  const buffer = await res.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function forwardMessage(env, toChatId, fromChatId, messageId) {
  return callTelegram(env, 'forwardMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

// کپی یک پیام (متن، عکس، فیلم، گیف، فایل، ویس و...) با همان کپشن و قالب‌بندی، بدون برچسب «فوروارد»
export async function copyMessage(env, toChatId, fromChatId, messageId) {
  return callTelegram(env, 'copyMessage', {
    chat_id: toChatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

export async function editMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  return callTelegram(env, 'editMessageReplyMarkup', {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}