// -*- پنل سفارش‌های ادمین (فقط سوپرادمین) -*-
//
// سفارشات → دسته (همه / تایید نهایی / لغوشده توسط ادمین / در انتظار بررسی / فاکتورهای باز و لغو خودکار)
//         → «۱۰ سفارش آخر» با جزئیات کامل، یا «گزارش کل» (خلاصه + فایل CSV همه‌ی سفارش‌های آن دسته)

import * as api from './api.js';
import { money } from './config.js';
import { adminOrderKeyboard } from './keyboards.js';
import { buildXlsx, XLSX_MIME } from './xlsx.js';

export const ORDER_CATEGORIES = {
  all: { label: '📋 همه سفارش‌ها', where: '1 = 1' },
  confirmed: { label: '✅ تایید نهایی', where: "o.status IN ('confirmed', 'paid_by_wallet')" },
  rejected: { label: '❌ لغوشده توسط ادمین', where: "o.status = 'rejected'" },
  review: { label: '⏳ در انتظار بررسی', where: "o.status IN ('receipt_sent', 'new', 'awaiting_confirmation')" },
  invoices: {
    label: '🧾 فاکتورهای باز / لغو خودکار',
    where: "o.status IN ('pending', 'cancelled', 'awaiting_wallet', 'wallet_insufficient')",
  },
};

const STATUS_LABELS = {
  pending: '🧾 پیش‌فاکتور باز',
  receipt_sent: '⏳ رسید ارسال شده (در انتظار بررسی)',
  new: '🆕 سفارش ساخت ربات (در انتظار بررسی)',
  awaiting_confirmation: '⏳ در انتظار تایید',
  confirmed: '✅ تایید نهایی ادمین',
  paid_by_wallet: '💼 پرداخت کامل با کیف پول',
  rejected: '❌ لغو/رد توسط ادمین',
  cancelled: '⌛ لغو خودکار',
  awaiting_wallet: '⚙️ پرداخت کیف پول نیمه‌تمام',
  wallet_insufficient: '💼 کیف پول ناکافی',
  link_sent: '🔗 لینک اندروید ارسال شد',
};

const CANCEL_REASONS = {
  timeout: 'عدم تکمیل در یک ساعت',
  superseded: 'کاربر پیش‌فاکتور محصول دیگری گرفت',
};

const MESSAGE_LIMIT = 3500; // کمتر از سقف ۴۰۹۶ کاراکتری تلگرام

export const orderNumber = (id) => `1000${id}`;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// تاریخ UTC دیتابیس → تاریخ شمسی به وقت تهران
// (یک formatter مشترک؛ ساختن formatter برای هر تاریخ در خروجی اکسل چندصدردیفی کند است)
let faFormatter = null;
export function faTime(sqlTime) {
  if (!sqlTime) return '—';
  const d = new Date(String(sqlTime).replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return String(sqlTime);
  faFormatter ??= new Intl.DateTimeFormat('fa-IR', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return faFormatter.format(d);
}

const walletPart = (o) => Math.max(0, Number(o.wallet_used) || 0);
const cashPart = (o) => Math.max(0, (Number(o.amount) || 0) - walletPart(o));
const osLabel = (os) => (os === 'ios' ? ' (آیفون)' : os === 'android' ? ' (اندروید)' : '');

export function ordersPanelKeyboard() {
  return {
    inline_keyboard: [
      ...Object.entries(ORDER_CATEGORIES).map(([key, c]) => [{ text: c.label, callback_data: `adm_ord:${key}` }]),
      [
        { text: '📥 اکسل همه سفارش‌ها', callback_data: 'adm_xls:orders' },
        { text: '👥 اکسل کاربران', callback_data: 'adm_xls:users' },
      ],
    ],
  };
}

function categoryKeyboard(key) {
  return {
    inline_keyboard: [
      [{ text: '🔟 ۱۰ سفارش آخر', callback_data: `adm_ord:${key}:last` }],
      [{ text: '📊 گزارش کل', callback_data: `adm_ord:${key}:report` }],
      [{ text: '🔙 بازگشت به دسته‌ها', callback_data: 'adm_orders' }],
    ],
  };
}

export async function showOrdersPanel(env, chatId) {
  await api.sendMessage(env, chatId, '📦 <b>مدیریت سفارش‌ها</b>\n\nدسته‌ی مورد نظر را انتخاب کنید:', ordersPanelKeyboard());
}

export async function showCategoryMenu(env, chatId, key) {
  const cat = ORDER_CATEGORIES[key];
  if (!cat) return;
  await api.sendMessage(env, chatId, `${cat.label}\n\nچه چیزی را می‌خواهید ببینید؟`, categoryKeyboard(key));
}

async function queryOrders(env, key, limit) {
  const cat = ORDER_CATEGORIES[key];
  const { results } = await env.DB.prepare(
    `SELECT o.*, u.full_name, u.first_name, u.phone, u.username
     FROM orders o LEFT JOIN users u ON u.chat_id = o.user_id
     WHERE ${cat.where}
     ORDER BY o.id DESC LIMIT ?`
  ).bind(limit).all();
  return results || [];
}

function orderBlock(o) {
  const name = o.full_name || o.first_name || 'بدون نام';
  const lines = [
    `🧾 <b>سفارش #${orderNumber(o.id)}</b> — ${STATUS_LABELS[o.status] || escapeHtml(o.status)}`,
    `👤 ${escapeHtml(name)}${o.username ? ` (@${escapeHtml(o.username)})` : ''}`,
    `📱 ${escapeHtml(o.phone || 'بدون شماره')}`,
    `🆔 <code>${escapeHtml(o.user_id)}</code> — <a href="tg://user?id=${encodeURIComponent(o.user_id)}">پروفایل</a>`,
    `🛍 ${escapeHtml(o.product_title || o.product_id)}${osLabel(o.os_type)}`,
  ];
  if (o.product_id !== 'custom_bot') {
    lines.push(`💰 مبلغ: ${money(o.amount)} | 💼 کیف پول: ${money(walletPart(o))} | 💳 نقدی: ${money(cashPart(o))} تومان`);
    if (Number(o.discount_percent) > 0) lines.push(`🎟 تخفیف: ${Number(o.discount_percent)}%`);
  }
  lines.push(`🕒 ثبت: ${faTime(o.created_at)}`);
  if (o.confirmed_at) lines.push(`✅ تایید: ${faTime(o.confirmed_at)}`);
  if (o.cancelled_at) lines.push(`⌛ لغو: ${faTime(o.cancelled_at)} — ${CANCEL_REASONS[o.cancel_reason] || escapeHtml(o.cancel_reason || '')}`);
  if (o.note) lines.push(`📝 ${escapeHtml(String(o.note).slice(0, 400))}`);
  return lines.join('\n');
}

// پیام‌های بلند به چند پیام زیر سقف تلگرام تقسیم می‌شوند (بدون شکستن وسط یک سفارش)
function chunkBlocks(header, blocks) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    const piece = `\n\n${block}`;
    if (current.length + piece.length > MESSAGE_LIMIT && current !== header) {
      messages.push(current);
      current = block;
    } else {
      current += piece;
    }
  }
  messages.push(current);
  return messages;
}

export async function sendLastOrders(env, chatId, key, limit = 10) {
  const cat = ORDER_CATEGORIES[key];
  if (!cat) return;
  const orders = await queryOrders(env, key, limit);
  if (orders.length === 0) {
    await api.sendMessage(env, chatId, `${cat.label}\n\n⚠️ هیچ سفارشی در این دسته وجود ندارد.`, categoryKeyboard(key));
    return;
  }
  const header = `${cat.label} — <b>${orders.length} سفارش آخر</b>`;
  const messages = chunkBlocks(header, orders.map(orderBlock));
  for (let i = 0; i < messages.length; i++) {
    await api.sendMessage(env, chatId, messages[i], i === messages.length - 1 ? categoryKeyboard(key) : null);
  }
}

// شماره‌ی نمایشی سفارش «1000<id>» است؛ هم شماره‌ی نمایشی و هم id خام پذیرفته می‌شود
export function parseOrderNumber(input) {
  const s = String(input ?? '').trim().replace(/^#/, '');
  if (!/^\d+$/.test(s)) return null;
  const id = s.length > 4 && s.startsWith('1000') ? Number(s.slice(4)) : Number(s);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// جزئیات کامل یک سفارش (دستور /order)؛ سفارش در انتظار بررسی دکمه‌ی تایید/رد هم دارد
export async function sendOrderDetails(env, chatId, input) {
  const id = parseOrderNumber(input);
  if (!id) {
    await api.sendMessage(env, chatId, '⚠️ شماره سفارش نامعتبر است. مثال: <code>/order 100026</code>');
    return;
  }
  const o = await env.DB.prepare(
    `SELECT o.*, u.full_name, u.first_name, u.phone, u.username
     FROM orders o LEFT JOIN users u ON u.chat_id = o.user_id
     WHERE o.id = ?`
  ).bind(id).first();
  if (!o) {
    await api.sendMessage(env, chatId, `⚠️ سفارش #${orderNumber(id)} پیدا نشد.`);
    return;
  }
  const reviewable = ['new', 'receipt_sent', 'awaiting_confirmation'].includes(o.status);
  await api.sendMessage(env, chatId, orderBlock(o), reviewable ? adminOrderKeyboard(o.id) : null);
}

const EXPORT_MAX_ROWS = 5000;

export async function sendOrdersReport(env, chatId, key) {
  const cat = ORDER_CATEGORIES[key];
  if (!cat) return;
  const where = cat.where;

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT o.user_id) AS customers,
            COALESCE(SUM(o.amount), 0) AS amount,
            COALESCE(SUM(MAX(o.wallet_used, 0)), 0) AS wallet,
            MIN(o.created_at) AS first_at, MAX(o.created_at) AS last_at
     FROM orders o WHERE ${where}`
  ).first();

  if (!totals || totals.n === 0) {
    await api.sendMessage(env, chatId, `${cat.label}\n\n⚠️ هیچ سفارشی در این دسته وجود ندارد.`, categoryKeyboard(key));
    return;
  }

  const { results: byStatus } = await env.DB.prepare(
    `SELECT o.status, COUNT(*) AS n, COALESCE(SUM(o.amount), 0) AS amount FROM orders o WHERE ${where} GROUP BY o.status ORDER BY n DESC`
  ).all();
  const { results: byProduct } = await env.DB.prepare(
    `SELECT COALESCE(MAX(o.product_title), o.product_id) AS product, COUNT(*) AS n, COALESCE(SUM(o.amount), 0) AS amount
     FROM orders o WHERE ${where} GROUP BY o.product_id ORDER BY n DESC`
  ).all();

  const cash = Math.max(0, totals.amount - totals.wallet);
  let text =
    `📊 <b>گزارش کل — ${cat.label}</b>\n\n` +
    `🧾 تعداد سفارش: ${money(totals.n)}\n` +
    `👥 تعداد مشتری: ${money(totals.customers)}\n` +
    `💰 جمع مبلغ: ${money(totals.amount)} تومان\n` +
    `💼 از کیف پول: ${money(totals.wallet)} تومان\n` +
    `💳 نقدی (کارت‌به‌کارت): ${money(cash)} تومان\n` +
    `🗓 از ${faTime(totals.first_at)} تا ${faTime(totals.last_at)}\n`;

  text += `\n<b>به تفکیک وضعیت:</b>\n`;
  for (const r of byStatus || []) text += `▪️ ${STATUS_LABELS[r.status] || escapeHtml(r.status)}: ${money(r.n)} سفارش — ${money(r.amount)} تومان\n`;
  text += `\n<b>به تفکیک محصول:</b>\n`;
  for (const r of byProduct || []) text += `▪️ ${escapeHtml(r.product)}: ${money(r.n)} سفارش — ${money(r.amount)} تومان\n`;

  await api.sendMessage(env, chatId, text.trimEnd());

  await sendOrdersExcel(env, chatId, key, totals.n);
  await api.sendMessage(env, chatId, 'گزینه‌ی بعدی را انتخاب کنید:', categoryKeyboard(key));
}

const ORDER_COLUMNS = [
  { header: 'شماره سفارش', type: 'number', width: 13 },
  { header: 'وضعیت', width: 30 },
  { header: 'تاریخ ثبت', width: 18 },
  { header: 'نام', width: 20 },
  { header: 'نام کاربری', width: 16 },
  { header: 'شماره تماس', width: 15 },
  { header: 'آیدی عددی', width: 14 },
  { header: 'محصول', width: 20 },
  { header: 'نسخه', width: 9 },
  { header: 'مبلغ (تومان)', type: 'number', width: 14 },
  { header: 'از کیف پول', type: 'number', width: 13 },
  { header: 'نقدی', type: 'number', width: 13 },
  { header: 'تخفیف ٪', type: 'number', width: 9 },
  { header: 'تاریخ تایید', width: 18 },
  { header: 'تاریخ لغو', width: 18 },
  { header: 'دلیل لغو', width: 22 },
  { header: 'یادداشت', width: 40 },
];

// فایل Excel با جزئیات همه‌ی سفارش‌های یک دسته
export async function sendOrdersExcel(env, chatId, key, total = null) {
  const cat = ORDER_CATEGORIES[key];
  if (!cat) return;
  const orders = await queryOrders(env, key, EXPORT_MAX_ROWS);
  if (orders.length === 0) {
    await api.sendMessage(env, chatId, `${cat.label}\n\n⚠️ هیچ سفارشی در این دسته وجود ندارد.`);
    return;
  }
  const os = (v) => (v === 'ios' ? 'آیفون' : v === 'android' ? 'اندروید' : '');
  const rows = orders.map((o) => [
    Number(orderNumber(o.id)),
    STATUS_LABELS[o.status] || o.status,
    faTime(o.created_at),
    o.full_name || o.first_name || '',
    o.username ? `@${o.username}` : '',
    o.phone || '',
    o.user_id,
    o.product_title || o.product_id,
    os(o.os_type),
    o.product_id === 'custom_bot' ? '' : Number(o.amount) || 0,
    o.product_id === 'custom_bot' ? '' : walletPart(o),
    o.product_id === 'custom_bot' ? '' : cashPart(o),
    Number(o.discount_percent) || '',
    o.confirmed_at ? faTime(o.confirmed_at) : '',
    o.cancelled_at ? faTime(o.cancelled_at) : '',
    o.cancel_reason ? CANCEL_REASONS[o.cancel_reason] || o.cancel_reason : '',
    o.note || '',
  ]);
  const file = buildXlsx([{ name: 'سفارش‌ها', columns: ORDER_COLUMNS, rows }]);
  const all = total ?? orders.length;
  const truncated = all > orders.length ? ` (فقط ${money(orders.length)} سفارش آخر)` : '';
  await api.sendDocumentFile(
    env,
    chatId,
    `orders-${key}-${fileDate()}.xlsx`,
    file,
    `📎 ${cat.label}: ${money(orders.length)} سفارش${truncated}`,
    XLSX_MIME
  );
}

// تاریخ امروز به وقت تهران برای نام فایل (مثلاً 2026-10-18)
export function fileDate(now = new Date()) {
  return now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tehran' });
}
