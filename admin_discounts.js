// -*- ساخت کد تخفیف از داخل ربات (ادمین‌ها) -*-
//
// 🎟 کدهای تخفیف → لیست کدهای فعال
//   → ➕ ساخت کد: متن کد ← درصد ← یک محصول یا همه ← یک روز / یک هفته / دائمی ← پیش‌نمایش و تایید
//
// callback_data:
//   dc_list / dc_new / dc_close   لیست / شروع ساخت / بستن
//   dcp:<product|*>               انتخاب محصول
//   dcd:<day|week|forever>        انتخاب مدت
//   dcok / dcno                   تایید / انصراف
//   dcx:<code>                    حذف کد

import * as api from './api.js';
import * as db from './db.js';
import * as KB from './keyboards.js';
import { menuKeyboardFor } from './flows.js';
import { configDiscountCodes, normalizeCode } from './discounts.js';
import { escapeHtml, getFullProduct, listProducts } from './products.js';

export const DISCOUNT_SESSION_STATE = 'awaiting_discount_admin';

const DAY_MS = 86400000;
const DURATIONS = {
  day: { label: 'یک روز', ms: DAY_MS },
  week: { label: 'یک هفته', ms: 7 * DAY_MS },
  forever: { label: 'دائمی', ms: null },
};

let dateFormatter;
function faDate(ms) {
  dateFormatter ??= new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', dateStyle: 'long', timeStyle: 'short' });
  return dateFormatter.format(new Date(ms));
}

export function isDiscountAdminCallback(data) {
  return /^dc(_list|_new|_close|ok|no)$|^dc[pdx]:/.test(data);
}

async function scopeLabel(env, productId) {
  if (!productId) return 'همه‌ی محصولات';
  const product = await getFullProduct(env, productId);
  return product ? escapeHtml(product.title) : 'محصول حذف‌شده';
}

const expiryLabel = (expiresAt) => (expiresAt ? `تا ${faDate(Number(expiresAt))}` : 'دائمی');

export async function showDiscountsPanel(env, chatId) {
  const codes = await db.listActiveDiscountCodes(env, Date.now());
  const lines = [];
  const rows = [];
  for (const c of codes) {
    lines.push(`🎟 <code>${c.code}</code> — ${Number(c.percent)}٪ — ${await scopeLabel(env, c.product_id)} — ${expiryLabel(c.expires_at)}`);
    rows.push([{ text: `🗑 حذف ${c.code}`, callback_data: `dcx:${c.code}` }]);
  }
  for (const [code, percent] of Object.entries(configDiscountCodes(env))) {
    lines.push(`📄 <code>${escapeHtml(code)}</code> — ${percent}٪ — همه‌ی محصولات — از فایل کانفیگ`);
  }
  rows.push([{ text: '➕ ساخت کد جدید', callback_data: 'dc_new' }]);
  rows.push([{ text: '❌ بستن', callback_data: 'dc_close' }]);

  const off = (await db.isDiscountActive(env)) ? '' : '\n\n⚠️ سیستم کد تخفیف خاموش است؛ با <code>/toggrediscount</code> روشن می‌شود.';
  await api.sendMessage(
    env,
    chatId,
    `🎟 <b>کدهای تخفیف فعال</b>\n\n${lines.join('\n') || 'هیچ کدی فعال نیست.'}${off}`,
    { inline_keyboard: rows }
  );
}

// پیام متنی ادمین هنگام ساخت کد
export async function handleDiscountInput(env, chatId, session, text) {
  const { step, draft = {} } = session.data || {};

  if (step === 'code') {
    const code = normalizeCode(text);
    if (!/^[A-Z0-9_-]{3,20}$/.test(code)) {
      await api.sendMessage(env, chatId, '⚠️ کد باید ۳ تا ۲۰ کاراکتر و فقط حروف انگلیسی، عدد، خط تیره یا زیرخط باشد.');
      return;
    }
    const existing = await db.getDiscountCode(env, code);
    const stillActive = existing && (!existing.expires_at || Number(existing.expires_at) > Date.now());
    if (stillActive || configDiscountCodes(env)[code]) {
      await api.sendMessage(env, chatId, '⚠️ این کد الان فعال است؛ کد دیگری بفرستید.');
      return;
    }
    await db.setSession(env, chatId, DISCOUNT_SESSION_STATE, { step: 'percent', draft: { ...draft, code } });
    await api.sendMessage(env, chatId, '✍️ <b>درصد تخفیف</b> را بفرستید (عدد ۱ تا ۹۹، مثلاً <code>10</code>):', KB.cancelKeyboard());
    return;
  }

  if (step === 'percent') {
    const percent = Number(normalizeCode(text).replace(/[%٪]/g, ''));
    if (!Number.isInteger(percent) || percent < 1 || percent > 99) {
      await api.sendMessage(env, chatId, '⚠️ درصد باید عددی بین ۱ تا ۹۹ باشد.');
      return;
    }
    await db.setSession(env, chatId, DISCOUNT_SESSION_STATE, { step: 'product', draft: { ...draft, percent } });
    const rows = [[{ text: '🛍 همه‌ی محصولات', callback_data: 'dcp:*' }]];
    for (const p of await listProducts(env)) {
      if (!p.hidden) rows.push([{ text: p.title, callback_data: `dcp:${p.id}` }]);
    }
    await api.sendMessage(env, chatId, 'این کد برای کدام محصول باشد؟', { inline_keyboard: rows });
    return;
  }

  await api.sendMessage(env, chatId, '👆 لطفاً از دکمه‌های پیام بالا استفاده کنید یا «🔙 انصراف» را بزنید.');
}

export async function handleDiscountCallback(env, chatId, actorId, data, callbackId, messageId) {
  const clearButtons = () =>
    messageId ? api.editMessageReplyMarkup(env, chatId, messageId, { inline_keyboard: [] }).catch(() => {}) : null;

  if (data === 'dc_list' || data === 'dc_close') {
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await db.clearSession(env, chatId);
    if (data === 'dc_list') await showDiscountsPanel(env, chatId);
    return;
  }

  if (data === 'dc_new') {
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await db.setSession(env, chatId, DISCOUNT_SESSION_STATE, { step: 'code', draft: {} });
    await api.sendMessage(env, chatId, '✍️ <b>متن کد تخفیف</b> را بفرستید (مثلاً <code>YALDA20</code>):', KB.cancelKeyboard());
    return;
  }

  if (data === 'dcno') {
    await api.answerCallbackQuery(env, callbackId, { text: 'لغو شد' });
    await clearButtons();
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '❌ ساخت کد لغو شد.', await menuKeyboardFor(env, chatId));
    return;
  }

  if (data.startsWith('dcx:')) {
    const code = data.slice(4);
    await db.deleteDiscountCode(env, code);
    await api.answerCallbackQuery(env, callbackId, { text: `🗑 ${code} حذف شد` });
    await clearButtons();
    await showDiscountsPanel(env, chatId);
    return;
  }

  // بقیه‌ی مراحل به فرم در حال پر شدن وابسته‌اند
  const session = await db.getSession(env, chatId);
  const { step, draft = {} } = session.data || {};
  const expected = data.startsWith('dcp:') ? 'product' : data.startsWith('dcd:') ? 'duration' : 'confirm';
  if (session.state !== DISCOUNT_SESSION_STATE || step !== expected) {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این فرم منقضی شده؛ دوباره از «🎟 کدهای تخفیف» شروع کنید.', show_alert: true });
    await clearButtons();
    return;
  }

  if (data.startsWith('dcp:')) {
    const picked = data.slice(4);
    const product = picked === '*' ? null : await getFullProduct(env, picked);
    if (picked !== '*' && !product) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ محصول پیدا نشد.', show_alert: true });
      return;
    }
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await db.setSession(env, chatId, DISCOUNT_SESSION_STATE, {
      step: 'duration',
      draft: { ...draft, productId: product ? product.id : null },
    });
    await api.sendMessage(env, chatId, 'این کد تا چه مدت معتبر باشد؟', {
      inline_keyboard: [
        [
          { text: '📅 یک روز', callback_data: 'dcd:day' },
          { text: '🗓 یک هفته', callback_data: 'dcd:week' },
        ],
        [{ text: '♾ دائمی', callback_data: 'dcd:forever' }],
      ],
    });
    return;
  }

  if (data.startsWith('dcd:')) {
    const key = data.slice(4);
    if (!DURATIONS[key]) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ مدت نامعتبر است.', show_alert: true });
      return;
    }
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    const next = { ...draft, duration: key };
    await db.setSession(env, chatId, DISCOUNT_SESSION_STATE, { step: 'confirm', draft: next });
    await api.sendMessage(
      env,
      chatId,
      `🔎 <b>پیش‌نمایش کد تخفیف</b>\n\n🎟 کد: <code>${next.code}</code>\n📉 تخفیف: ${next.percent}٪\n` +
        `🛍 محصول: ${await scopeLabel(env, next.productId)}\n⏳ مدت: ${DURATIONS[key].label}\n\nساخته شود؟`,
      {
        inline_keyboard: [
          [{ text: '✅ تایید و ساخت کد', callback_data: 'dcok' }],
          [{ text: '❌ انصراف', callback_data: 'dcno' }],
        ],
      }
    );
    return;
  }

  // مدت از لحظه‌ی تایید حساب می‌شود
  const { ms } = DURATIONS[draft.duration];
  const expiresAt = ms ? Date.now() + ms : null;
  await db.saveDiscountCode(env, {
    code: draft.code,
    percent: draft.percent,
    productId: draft.productId,
    expiresAt,
    createdBy: actorId,
  });
  await db.clearSession(env, chatId);
  await api.answerCallbackQuery(env, callbackId, { text: '✅ کد ساخته شد' });
  await clearButtons();
  await api.sendMessage(
    env,
    chatId,
    `✅ <b>کد تخفیف ساخته شد</b>\n\n🎟 <code>${draft.code}</code> — ${draft.percent}٪\n` +
      `🛍 ${await scopeLabel(env, draft.productId)}\n⏳ ${expiryLabel(expiresAt)}`,
    await menuKeyboardFor(env, chatId)
  );
}
