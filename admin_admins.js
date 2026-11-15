// -*- مدیریت ادمین‌ها از داخل ربات (فقط سوپرادمین) -*-
//
// 👮 مدیریت ادمین‌ها → لیست ادمین‌ها
//   → ➕ افزودن ادمین ← 👑 اینترپرایز / 🛠 پشتیبانی ← انتخاب از لیست اعضا یا جستجو ← تایید
//   → روی هر ادمین: تغییر نقش / حذف
//
// ادمین‌های wrangler.toml (ADMIN_CHAT_ID / SUPPORT_CHAT_ID) با 🔒 نشان داده می‌شوند و از اینجا تغییر نمی‌کنند.
//
// callback_data:
//   ad_list / ad_close / ad_add       لیست / بستن / شروع افزودن
//   ad_r:<s|p>[:<page>]               انتخاب نقش و صفحه‌ی لیست اعضا
//   ad_pk:<s|p>:<chat_id>             انتخاب کاربر → پیش‌نمایش
//   ad_ok:<s|p>:<chat_id>             تایید افزودن
//   ad_u:<chat_id>                    جزئیات یک ادمین
//   ad_sw:<chat_id>                   تغییر نقش
//   ad_rm:<chat_id> / ad_rmok:<id>    حذف / تایید حذف

import * as api from './api.js';
import * as db from './db.js';
import { menuKeyboardFor } from './flows.js';
import { escapeHtml } from './products.js';
import { ADMIN_ROLES, configSuperAdminIds, configSupportIds, isSuperAdmin, money, refreshDbAdmins } from './config.js';

export const ADMIN_SEARCH_STATE = 'awaiting_admin_search';

const PAGE_SIZE = 8;
const ROLE_CODES = { s: ADMIN_ROLES.super, p: ADMIN_ROLES.support };
const ROLE_LABELS = { super: '👑 ادمین اینترپرایز', support: '🛠 ادمین پشتیبانی' };
const ROLE_ACCESS = {
  super: 'همه‌ی امکانات: سفارش‌ها، پیام همگانی، کاربران، محصولات، تخفیف و مدیریت ادمین‌ها',
  support: 'محصولات، کدهای تخفیف، سبد خرید و تایید/رد سفارش‌ها',
};
const roleCode = (role) => (role === ADMIN_ROLES.super ? 's' : 'p');

export function isAdminsCallback(data) {
  return /^ad_(list|close|add)$|^ad_(r|pk|ok|u|sw|rm|rmok):/.test(data);
}

// ارقام فارسی/عربی → انگلیسی، تا جستجوی شماره با کیبورد فارسی هم کار کند
export function normalizeDigits(text) {
  return String(text || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .trim();
}

function displayName(u) {
  const name = u?.full_name || [u?.first_name, u?.last_name].filter(Boolean).join(' ');
  return name || (u?.username ? `@${u.username}` : 'بدون نام');
}

function userLine(u) {
  const parts = [`👤 ${escapeHtml(displayName(u))}`];
  if (u?.username) parts.push(`@${escapeHtml(u.username)}`);
  if (u?.phone) parts.push(`📱 ${escapeHtml(u.phone)}`);
  parts.push(`🆔 <code>${u.chat_id}</code>`);
  return parts.join(' | ');
}

function userButton(u) {
  const extra = u.phone || (u.username ? `@${u.username}` : u.chat_id);
  const label = `${displayName(u)} · ${extra}`;
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

function configRole(env, chatId) {
  if (configSuperAdminIds(env).includes(String(chatId))) return ADMIN_ROLES.super;
  if (configSupportIds(env).includes(String(chatId))) return ADMIN_ROLES.support;
  return null;
}

// نقش فعلی یک کاربر (ثابت از wrangler.toml یا از دیتابیس)
async function currentRole(env, chatId) {
  const fixed = configRole(env, chatId);
  if (fixed) return { role: fixed, locked: true };
  const row = await db.getDbAdmin(env, chatId);
  return row ? { role: row.role, locked: false } : null;
}

// ویرایش همان پیام پنل؛ اگر نشد (پیام قدیمی/حذف‌شده) پیام جدید
async function render(env, chatId, messageId, text, rows) {
  const reply_markup = { inline_keyboard: rows };
  if (messageId) {
    const res = await api
      .callTelegram(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup })
      .catch(() => null);
    if (res?.ok || /not modified/i.test(res?.description || '')) return;
  }
  await api.sendMessage(env, chatId, text, reply_markup);
}

export async function showAdminsPanel(env, chatId, messageId = null) {
  const dbRows = await db.listDbAdmins(env).catch(() => []);
  const users = new Map();
  for (const id of [...configSuperAdminIds(env), ...configSupportIds(env)]) {
    if (!users.has(id)) users.set(id, (await db.getUser(env, id)) || { chat_id: id });
  }

  const sections = { super: [], support: [] };
  const seen = new Set();
  for (const id of configSuperAdminIds(env)) {
    if (seen.has(id)) continue;
    seen.add(id);
    sections.super.push(`🔒 ${userLine(users.get(id))}`);
  }
  for (const id of configSupportIds(env)) {
    if (seen.has(id)) continue;
    seen.add(id);
    sections.support.push(`🔒 ${userLine(users.get(id))}`);
  }
  const rows = [];
  for (const a of dbRows) {
    if (seen.has(String(a.chat_id))) continue;
    seen.add(String(a.chat_id));
    (sections[a.role] || sections.support).push(`• ${userLine(a)}`);
    rows.push([{ text: `${a.role === ADMIN_ROLES.super ? '👑' : '🛠'} ${userButton(a)}`, callback_data: `ad_u:${a.chat_id}` }]);
  }
  rows.push([{ text: '➕ افزودن ادمین', callback_data: 'ad_add' }]);
  rows.push([{ text: '❌ بستن', callback_data: 'ad_close' }]);

  const text =
    `👮 <b>مدیریت ادمین‌ها</b>\n\n` +
    `<b>${ROLE_LABELS.super}</b> (${ROLE_ACCESS.super}):\n${sections.super.join('\n') || '—'}\n\n` +
    `<b>${ROLE_LABELS.support}</b> (${ROLE_ACCESS.support}):\n${sections.support.join('\n') || '—'}\n\n` +
    `🔒 = تعریف‌شده در wrangler.toml (از داخل ربات تغییر نمی‌کند)\n` +
    `برای تغییر نقش یا حذف، روی نام ادمین بزنید.`;
  await render(env, chatId, messageId, text, rows);
}

async function showRolePicker(env, chatId, messageId) {
  await render(env, chatId, messageId, '➕ <b>افزودن ادمین</b>\n\nنوع ادمین را انتخاب کنید:', [
    [{ text: ROLE_LABELS.super, callback_data: 'ad_r:s' }],
    [{ text: ROLE_LABELS.support, callback_data: 'ad_r:p' }],
    [{ text: '🔙 برگشت', callback_data: 'ad_list' }],
  ]);
}

const searchHint =
  '🔍 برای پیدا کردن سریع، <b>شماره موبایل</b>، <b>آیدی عددی</b>، <b>نام کاربری</b> یا <b>نام</b> را همین‌جا بفرستید.';

async function showUserPicker(env, chatId, messageId, code, page = 0) {
  const role = ROLE_CODES[code];
  const { users, total } = await db.listUsersPage(env, page * PAGE_SIZE, PAGE_SIZE);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = users.map((u) => [{ text: userButton(u), callback_data: `ad_pk:${code}:${u.chat_id}` }]);
  const nav = [];
  if (page > 0) nav.push({ text: '◀️ قبلی', callback_data: `ad_r:${code}:${page - 1}` });
  if (page + 1 < pages) nav.push({ text: 'بعدی ▶️', callback_data: `ad_r:${code}:${page + 1}` });
  if (nav.length) rows.push(nav);
  rows.push([{ text: '🔙 برگشت', callback_data: 'ad_add' }]);

  await db.setSession(env, chatId, ADMIN_SEARCH_STATE, { role });
  await render(
    env,
    chatId,
    messageId,
    `${ROLE_LABELS[role]}\n\nکاربر مورد نظر را از لیست اعضا انتخاب کنید (صفحه‌ی ${money(page + 1)} از ${money(pages)}، ` +
      `${money(total)} عضو):\n\n${searchHint}`,
    rows
  );
}

// متن جستجو از ادمین (session = ADMIN_SEARCH_STATE)
export async function handleAdminSearchInput(env, chatId, session, text) {
  if (!isSuperAdmin(env, chatId)) {
    await db.clearSession(env, chatId);
    return;
  }
  const role = session.data?.role === ADMIN_ROLES.super ? ADMIN_ROLES.super : ADMIN_ROLES.support;
  const code = roleCode(role);
  const query = normalizeDigits(text);
  if (query.length < 2) {
    await api.sendMessage(env, chatId, '⚠️ حداقل ۲ کاراکتر بفرستید.');
    return;
  }
  const users = await db.searchUsers(env, query);
  const rows = users.map((u) => [{ text: userButton(u), callback_data: `ad_pk:${code}:${u.chat_id}` }]);
  rows.push([{ text: '📋 لیست همه‌ی اعضا', callback_data: `ad_r:${code}` }]);
  rows.push([{ text: '❌ انصراف', callback_data: 'ad_list' }]);
  const head = users.length
    ? `🔍 نتیجه‌ی جستجوی «${escapeHtml(query)}» (${money(users.length)} مورد${users.length >= 20 ? '، فقط ۲۰ مورد اول' : ''}):`
    : `🔍 کاربری با «${escapeHtml(query)}» پیدا نشد.\nدقت کنید کاربر باید قبلاً ربات را استارت کرده باشد.`;
  await api.sendMessage(env, chatId, `${ROLE_LABELS[role]}\n\n${head}\n\nبرای جستجوی دوباره، متن جدید بفرستید.`, { inline_keyboard: rows });
}

// بعد از هر تغییر، کیبورد منوی کاربر عوض می‌شود تا دکمه‌های ادمین ظاهر/پنهان شوند
async function notifyUser(env, chatId, text) {
  await refreshDbAdmins(env);
  await api.sendMessage(env, chatId, text, await menuKeyboardFor(env, chatId)).catch(() => {});
}

export async function handleAdminsCallback(env, chatId, actorId, data, callbackId, messageId) {
  if (!isSuperAdmin(env, actorId)) {
    await api.answerCallbackQuery(env, callbackId, { text: '⛔ دسترسی ندارید.', show_alert: true });
    return;
  }
  const [action, a1, a2] = data.split(':');

  if (action === 'ad_close') {
    await api.answerCallbackQuery(env, callbackId);
    await db.clearSession(env, chatId);
    if (messageId) await api.editMessageReplyMarkup(env, chatId, messageId, { inline_keyboard: [] }).catch(() => {});
    return;
  }

  if (action === 'ad_list') {
    await api.answerCallbackQuery(env, callbackId);
    await db.clearSession(env, chatId);
    await showAdminsPanel(env, chatId, messageId);
    return;
  }

  if (action === 'ad_add') {
    await api.answerCallbackQuery(env, callbackId);
    await db.clearSession(env, chatId);
    await showRolePicker(env, chatId, messageId);
    return;
  }

  if (action === 'ad_r') {
    if (!ROLE_CODES[a1]) return api.answerCallbackQuery(env, callbackId);
    await api.answerCallbackQuery(env, callbackId);
    const page = Math.max(0, Number.parseInt(a2 || '0', 10) || 0);
    await showUserPicker(env, chatId, messageId, a1, page);
    return;
  }

  if (action === 'ad_pk' || action === 'ad_ok') {
    const role = ROLE_CODES[a1];
    const user = role && /^\d+$/.test(a2 || '') ? await db.getUser(env, a2) : null;
    if (!user) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ کاربر پیدا نشد.', show_alert: true });
      return;
    }
    const existing = await currentRole(env, user.chat_id);
    if (existing?.locked) {
      await api.answerCallbackQuery(env, callbackId, {
        text: `🔒 این کاربر در wrangler.toml ${existing.role === ADMIN_ROLES.super ? 'سوپرادمین' : 'ادمین پشتیبانی'} است.`,
        show_alert: true,
      });
      return;
    }
    if (existing?.role === role) {
      await api.answerCallbackQuery(env, callbackId, { text: `ℹ️ این کاربر همین الان ${ROLE_LABELS[role]} است.`, show_alert: true });
      return;
    }

    if (action === 'ad_pk') {
      await api.answerCallbackQuery(env, callbackId);
      const change = existing ? `\n\nنقش فعلی: ${ROLE_LABELS[existing.role]} ← نقش جدید: ${ROLE_LABELS[role]}` : '';
      await render(
        env,
        chatId,
        messageId,
        `➕ <b>افزودن ${ROLE_LABELS[role]}</b>\n\n${userLine(user)}\n\nدسترسی: ${ROLE_ACCESS[role]}${change}\n\nتایید می‌کنید؟`,
        [
          [{ text: '✅ تایید', callback_data: `ad_ok:${a1}:${user.chat_id}` }],
          [{ text: '🔙 برگشت به لیست', callback_data: `ad_r:${a1}` }],
        ]
      );
      return;
    }

    await db.setDbAdmin(env, user.chat_id, role, actorId);
    await db.clearSession(env, chatId);
    await api.answerCallbackQuery(env, callbackId, { text: '✅ ادمین اضافه شد.' });
    await refreshDbAdmins(env);
    await showAdminsPanel(env, chatId, messageId);
    await notifyUser(
      env,
      user.chat_id,
      `🎉 شما به‌عنوان <b>${ROLE_LABELS[role]}</b> ربات اضافه شدید.\n\nدسترسی: ${ROLE_ACCESS[role]}\nدکمه‌های مدیریت در منوی پایین اضافه شد؛ راهنما: /help`
    );
    return;
  }

  // ---- عملیات روی یک ادمین موجود ----
  const targetId = a1;
  if (!/^\d+$/.test(targetId || '')) return api.answerCallbackQuery(env, callbackId);
  if (configRole(env, targetId)) {
    await api.answerCallbackQuery(env, callbackId, { text: '🔒 این ادمین در wrangler.toml تعریف شده و از داخل ربات تغییر نمی‌کند.', show_alert: true });
    return;
  }
  const admin = await db.getDbAdmin(env, targetId);
  if (!admin) {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این کاربر دیگر ادمین نیست.', show_alert: true });
    await showAdminsPanel(env, chatId, messageId);
    return;
  }
  const user = (await db.getUser(env, targetId)) || { chat_id: targetId };
  const self = String(targetId) === String(actorId);

  if (action === 'ad_u') {
    await api.answerCallbackQuery(env, callbackId);
    const other = admin.role === ADMIN_ROLES.super ? ADMIN_ROLES.support : ADMIN_ROLES.super;
    const rows = self
      ? []
      : [
          [{ text: `🔄 تغییر به ${ROLE_LABELS[other]}`, callback_data: `ad_sw:${targetId}` }],
          [{ text: '🗑 حذف از ادمین‌ها', callback_data: `ad_rm:${targetId}` }],
        ];
    rows.push([{ text: '🔙 برگشت', callback_data: 'ad_list' }]);
    await render(
      env,
      chatId,
      messageId,
      `${ROLE_LABELS[admin.role]}\n\n${userLine(user)}\n\nدسترسی: ${ROLE_ACCESS[admin.role]}` +
        (self ? '\n\nℹ️ نقش خودتان را نمی‌توانید تغییر دهید یا حذف کنید.' : ''),
      rows
    );
    return;
  }

  if (self) {
    await api.answerCallbackQuery(env, callbackId, { text: '⛔ نقش خودتان را نمی‌توانید تغییر دهید یا حذف کنید.', show_alert: true });
    return;
  }

  if (action === 'ad_sw') {
    const role = admin.role === ADMIN_ROLES.super ? ADMIN_ROLES.support : ADMIN_ROLES.super;
    await db.setDbAdmin(env, targetId, role, actorId);
    await api.answerCallbackQuery(env, callbackId, { text: '✅ نقش تغییر کرد.' });
    await refreshDbAdmins(env);
    await showAdminsPanel(env, chatId, messageId);
    await notifyUser(env, targetId, `🔄 نقش شما در ربات به <b>${ROLE_LABELS[role]}</b> تغییر کرد.\n\nدسترسی: ${ROLE_ACCESS[role]}`);
    return;
  }

  if (action === 'ad_rm') {
    await api.answerCallbackQuery(env, callbackId);
    await render(env, chatId, messageId, `🗑 <b>حذف ادمین</b>\n\n${userLine(user)}\n\nاین کاربر از ${ROLE_LABELS[admin.role]} حذف شود؟`, [
      [{ text: '✅ بله، حذف شود', callback_data: `ad_rmok:${targetId}` }],
      [{ text: '🔙 برگشت', callback_data: `ad_u:${targetId}` }],
    ]);
    return;
  }

  if (action === 'ad_rmok') {
    await db.removeDbAdmin(env, targetId);
    // اگر وسط ساخت محصول/کد تخفیف بود، فرم نیمه‌کاره‌اش بسته شود
    await db.clearSession(env, targetId);
    await api.answerCallbackQuery(env, callbackId, { text: '🗑 حذف شد.' });
    await refreshDbAdmins(env);
    await showAdminsPanel(env, chatId, messageId);
    await notifyUser(env, targetId, 'ℹ️ دسترسی ادمین شما در ربات برداشته شد.');
  }
}
