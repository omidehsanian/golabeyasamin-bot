// -*- خروجی Excel لیست کاربران (فقط سوپرادمین) -*-

import * as api from './api.js';
import { money } from './config.js';
import { faTime, fileDate } from './admin_orders.js';
import { buildXlsx, XLSX_MIME } from './xlsx.js';

const PAID_STATUSES_SQL = "'confirmed', 'paid_by_wallet'";

const USER_COLUMNS = [
  { header: 'آیدی عددی', width: 14 },
  { header: 'نام', width: 22 },
  { header: 'نام کاربری', width: 16 },
  { header: 'شماره تماس', width: 15 },
  { header: 'ثبت‌نام', width: 9 },
  { header: 'موجودی کیف پول', type: 'number', width: 15 },
  { header: 'تاریخ عضویت', width: 18 },
  { header: 'تعداد دعوت', type: 'number', width: 11 },
  { header: 'معرف', width: 14 },
  { header: 'خریدهای تاییدشده', type: 'number', width: 15 },
  { header: 'جمع خرید (تومان)', type: 'number', width: 16 },
  { header: 'آخرین خرید', width: 18 },
];

export async function sendUsersExcel(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT u.chat_id, u.full_name, u.first_name, u.last_name, u.username, u.phone, u.wallet, u.created_at,
            COALESCE(inv.n, 0) AS invited, ref.referrer_id,
            COALESCE(paid.n, 0) AS orders_n, COALESCE(paid.amount, 0) AS spent, paid.last_at
     FROM users u
     LEFT JOIN (SELECT referrer_id, COUNT(*) AS n FROM referrals GROUP BY referrer_id) inv ON inv.referrer_id = u.chat_id
     LEFT JOIN referrals ref ON ref.invited_id = u.chat_id
     LEFT JOIN (SELECT user_id, COUNT(*) AS n, SUM(amount) AS amount, MAX(COALESCE(confirmed_at, created_at)) AS last_at
                FROM orders WHERE status IN (${PAID_STATUSES_SQL}) GROUP BY user_id) paid ON paid.user_id = u.chat_id
     ORDER BY u.id DESC`
  ).all();
  const users = results || [];
  if (users.length === 0) {
    await api.sendMessage(env, chatId, '⚠️ هیچ کاربری در دیتابیس یافت نشد.');
    return;
  }

  const rows = users.map((u) => [
    u.chat_id,
    u.full_name || [u.first_name, u.last_name].filter(Boolean).join(' '),
    u.username ? `@${u.username}` : '',
    u.phone || '',
    u.phone ? 'بله' : 'خیر',
    Number(u.wallet) || 0,
    faTime(u.created_at),
    Number(u.invited) || 0,
    u.referrer_id || '',
    Number(u.orders_n) || 0,
    Number(u.spent) || 0,
    u.last_at ? faTime(u.last_at) : '',
  ]);
  const registered = users.filter((u) => u.phone).length;
  const buyers = users.filter((u) => Number(u.orders_n) > 0).length;

  const file = buildXlsx([{ name: 'کاربران', columns: USER_COLUMNS, rows }]);
  await api.sendDocumentFile(
    env,
    chatId,
    `users-${fileDate()}.xlsx`,
    file,
    `👥 <b>${money(users.length)}</b> کاربر | 📱 ثبت‌نام‌شده: ${money(registered)} | 🛍 خریدار: ${money(buyers)}`,
    XLSX_MIME
  );
}
