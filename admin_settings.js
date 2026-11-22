// -*- پنل تنظیمات فروشگاه (ادمین) -*-
//
// ⚙️ تنظیمات فروشگاه → حداقل مبلغ فاکتور، کش‌بک (روشن/درصد/مدت اعتبار)
// مقدارها در جدول settings ذخیره می‌شوند و بلافاصله بر wrangler.toml اولویت می‌گیرند.
//
// callback_data:
//   set:edit:<key>     ورود مقدار جدید با پیام متنی
//   set:toggle:<key>   روشن/خاموش کردن فیلد بولین
//   set:close          بستن پنل

import * as api from './api.js';
import * as db from './db.js';
import * as KB from './keyboards.js';
import { menuKeyboardFor } from './flows.js';
import { refreshRuntimeSettings } from './config.js';
import { FIELDS, effectiveSettings, parseFieldValue, saveSetting } from './settings.js';

export const SETTINGS_SESSION_STATE = 'awaiting_setting_value';

const FIELD_BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

const ICONS = {
  min_order_amount: '🛒',
  cashback_enabled: '💸',
  cashback_percent: '📊',
  cashback_expire_days: '⏳',
  discount_active: '🎟',
};

const faNumber = (n) => Number(n || 0).toLocaleString('fa-IR');

export function isSettingsCallback(data) {
  return /^set:(edit|toggle|close)/.test(data);
}

function formatValue(field, raw) {
  if (field.type === 'bool') return raw === '1' ? 'روشن ✅' : 'خاموش ⛔';
  if (field.type === 'amount') return `${faNumber(raw)} تومان`;
  if (field.type === 'percent') return `${faNumber(raw)}٪`;
  return `${faNumber(raw)} ${field.unit || ''}`.trim();
}

export async function showSettingsPanel(env, chatId) {
  const values = await effectiveSettings(env);
  const lines = FIELDS.map((f) => `${ICONS[f.key] || '•'} <b>${f.label}:</b> ${formatValue(f, values[f.key])}`);
  const rows = FIELDS.map((f) => [
    {
      text: `${f.type === 'bool' ? '🔄' : '✏️'} ${f.label}`,
      callback_data: `set:${f.type === 'bool' ? 'toggle' : 'edit'}:${f.key}`,
    },
  ]);
  rows.push([{ text: '❌ بستن', callback_data: 'set:close' }]);

  await api.sendMessage(
    env,
    chatId,
    `⚙️ <b>تنظیمات فروشگاه</b>\n\n${lines.join('\n')}\n\n` +
      `این مقدارها در دیتابیس ذخیره می‌شوند و مقدارهای فایل تنظیمات (wrangler.toml) را بازنویسی می‌کنند.`,
    { inline_keyboard: rows }
  );
}

export async function handleSettingsCallback(env, chatId, actorId, data, callbackId, messageId) {
  const clearButtons = () =>
    messageId ? api.editMessageReplyMarkup(env, chatId, messageId, { inline_keyboard: [] }).catch(() => {}) : null;

  if (data === 'set:close') {
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '⚙️ پنل تنظیمات بسته شد.', await menuKeyboardFor(env, chatId));
    return;
  }

  const [, action, key] = data.split(':');
  const field = FIELD_BY_KEY.get(key);
  if (!field) {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این تنظیم شناخته نشد.', show_alert: true });
    return;
  }

  const values = await effectiveSettings(env);

  if (action === 'toggle' && field.type === 'bool') {
    const next = values[key] === '1' ? '0' : '1';
    await saveSetting(env, key, next);
    await refreshRuntimeSettings(env);
    await api.answerCallbackQuery(env, callbackId, { text: next === '1' ? '✅ روشن شد' : '⛔ خاموش شد' });
    await clearButtons();
    await showSettingsPanel(env, chatId);
    return;
  }

  if (action === 'edit') {
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await db.setSession(env, chatId, SETTINGS_SESSION_STATE, { step: 'value', key });
    const current = formatValue(field, values[key]);
    await api.sendMessage(
      env,
      chatId,
      `✍️ مقدار جدید <b>${field.label}</b> را بفرستید.\n` +
        `مقدار فعلی: <b>${current}</b>\n` +
        (field.hint ? `ℹ️ ${field.hint}\n` : '') +
        (field.type === 'percent' ? 'مثال: <code>5</code>' : field.type === 'amount' ? 'مثال: <code>500000</code>' : ''),
      KB.cancelKeyboard()
    );
  }
}

// پیام متنی ادمین وقتی مقدار جدید یک تنظیم را می‌فرستد
export async function handleSettingsInput(env, chatId, session, text) {
  const { key } = session.data || {};
  const field = FIELD_BY_KEY.get(key);
  if (!field) {
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '⚠️ این فرم منقضی شده؛ دوباره از «⚙️ تنظیمات فروشگاه» شروع کنید.', await menuKeyboardFor(env, chatId));
    return;
  }

  const parsed = parseFieldValue(field, text);
  if (!parsed.ok) {
    await api.sendMessage(env, chatId, `⚠️ ${parsed.error}`, KB.cancelKeyboard());
    return;
  }

  await saveSetting(env, key, parsed.value);
  await refreshRuntimeSettings(env);
  await db.clearSession(env, chatId);
  await api.sendMessage(
    env,
    chatId,
    `✅ <b>${field.label}</b> به <b>${formatValue(field, parsed.value)}</b> تغییر کرد.`,
    await menuKeyboardFor(env, chatId)
  );
  await showSettingsPanel(env, chatId);
}
