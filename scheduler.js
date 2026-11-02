// -*- مدیریت خودکار سفارش‌های معلق (اجرا با Cron Trigger هر دقیقه) -*-
//
// Worker منتظر نمی‌ماند: هر اجرای Cron فقط سفارش‌هایی را پردازش می‌کند که زمانشان رسیده.
// همه‌ی تصمیم‌ها با UPDATE شرطی در D1 گرفته می‌شوند، پس اجرای چندباره یا هم‌زمان Cron
// یادآوری یا لغو تکراری ایجاد نمی‌کند. هیچ مبلغی در این مسیر جابه‌جا نمی‌شود.

import * as api from './api.js';
import * as db from './db.js';
import { fillAddressKeyboard, resumeKeyboard } from './keyboards.js';
import { escapeHtml } from './products.js';

const MAX_NOTIFY_ATTEMPTS = 3;
// سقف کار در هر اجرا (محدودیت تعداد کوئری/درخواست خروجی هر اجرای Worker)
const CANCEL_BATCH = 6;
const NOTICE_BATCH = 6;
const REMINDER_BATCH = 8;
const ADDRESS_BATCH = 4;
// پیام پیگیری آدرس فقط در این بازه به وقت تهران فرستاده می‌شود
const ADDRESS_HOURS = { from: 9, to: 22 };

// نتیجه‌ی ارسال: sent | retry (خطای موقت قطعی از تلگرام) | failed (دائمی یا نامعلوم)
async function deliver(env, chatId, text, keyboard = null) {
  try {
    const res = await api.sendMessage(env, chatId, text, keyboard);
    if (res && res.ok) return { outcome: 'sent' };
    const code = Number(res?.error_code || 0);
    const error = `${code || 'no_code'} ${res?.description || ''}`.trim();
    if (code === 429 || code >= 500) return { outcome: 'retry', error };
    return { outcome: 'failed', error };
  } catch (e) {
    // معلوم نیست پیام رسیده یا نه؛ برای جلوگیری از پیام تکراری دوباره ارسال نمی‌شود
    return { outcome: 'failed', error: `network: ${e?.message || e}` };
  }
}

function parseSqlTime(value) {
  return new Date(String(value).replace(' ', 'T') + 'Z');
}

function reminderText(order, now) {
  const elapsed = Math.floor((now.getTime() - parseSqlTime(order.created_at).getTime()) / 60000);
  const left = Math.max(1, db.PENDING_EXPIRE_MINUTES - elapsed);
  return (
    `⏰ <b>سفارش شما هنوز تکمیل نشده است</b>\n\n` +
    `🛍 محصول: ${escapeHtml(order.product_title || order.product_id)}\n` +
    `🧾 شماره سفارش: <b>1000${order.id}</b>\n\n` +
    `برای ادامه از همان مرحله، دکمه زیر را بزنید. این سفارش حدود ${left} دقیقه دیگر به‌طور خودکار لغو می‌شود.`
  );
}

function cancelText(order) {
  let text =
    `⌛ <b>سفارش 1000${order.id} لغو شد</b>\n\n` +
    `🛍 محصول: ${escapeHtml(order.product_title || order.product_id)}\n` +
    `این سفارش ظرف یک ساعت تکمیل نشد و به‌طور خودکار لغو شد. هیچ مبلغی از کیف پول شما کسر نشده است.\n`;
  if (order.checkout_step === 'awaiting_receipt') {
    text += `\nاگر مبلغ را واریز کرده‌اید، همین حالا تصویر رسید را ارسال کنید تا برای بررسی ثبت شود.`;
  } else {
    text += `\nبرای خرید دوباره، محصول را از منو انتخاب کنید.`;
  }
  return text;
}

function adminCancelText(orders) {
  const lines = orders.map((o) => {
    const receipt = o.checkout_step === 'awaiting_receipt' ? ' — ⚠️ در مرحله‌ی ارسال رسید بود' : '';
    return `• <b>1000${o.id}</b> | ${escapeHtml(o.product_title || o.product_id)} | <code>${o.user_id}</code>${receipt}`;
  });
  return (
    `⌛ <b>${orders.length} سفارش به‌طور خودکار لغو شد</b> (عدم تکمیل در یک ساعت)\n\n` +
    `${lines.join('\n')}\n\nجزئیات: <code>/order شماره</code>`
  );
}

function tehranHour(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran', hour: 'numeric', hourCycle: 'h23' }).format(now));
}

function addressReminderText(order) {
  return (
    `📍 <b>سفارش شما منتظر آدرس است</b>\n\n` +
    `🧾 شماره سفارش: <b>1000${order.id}</b>\n` +
    `🛍 ${escapeHtml(order.product_title || order.product_id)}\n\n` +
    `پرداخت شما ثبت شده؛ برای ارسال سفارش فقط آدرس و کد پستی لازم است. دکمه زیر را بزنید 👇`
  );
}

function addressAlertText(order, reason) {
  const name = order.full_name || order.first_name || 'بدون نام';
  return (
    `☎️ <b>سفارش #1000${order.id} آدرس ندارد — با مشتری تماس بگیرید</b>\n${reason}\n\n` +
    `🛍 ${escapeHtml(order.product_title || order.product_id)}\n` +
    `👤 ${escapeHtml(name)}\n` +
    `📱 <code>${escapeHtml(order.phone || 'بدون شماره')}</code>\n` +
    `جزئیات: <code>/order 1000${order.id}</code>`
  );
}

// پیگیری سفارش‌های پرداخت‌شده‌ی بدون آدرس: دو یادآوری به مشتری، بعد تماس ادمین.
// اگر پیام به مشتری نرسد (مثلاً ربات را بلاک کرده) ادمین همان موقع خبردار می‌شود.
async function processAddressFollowups(env, now, summary) {
  const hour = tehranHour(now);
  if (hour < ADDRESS_HOURS.from || hour >= ADDRESS_HOURS.to) return;

  const alert = async (order, reason) => {
    if (!env.ADMIN_CHAT_ID || !(await db.claimAddressAlert(env, order.id, now))) return;
    await deliver(env, env.ADMIN_CHAT_ID, addressAlertText(order, reason));
    summary.addressAlerts++;
  };

  for (const order of await db.listAddressFollowups(env, now, ADDRESS_BATCH)) {
    const elapsed = (now.getTime() - parseSqlTime(order.address_requested_at).getTime()) / 60000;
    if (elapsed >= db.ADDRESS_ALERT_MINUTES && !order.address_admin_alerted_at) {
      await alert(order, '۴۸ ساعت از پرداخت گذشته و مشتری آدرس را ثبت نکرده است.');
      continue;
    }
    const reminders = Number(order.address_reminders) || 0;
    if (reminders >= db.ADDRESS_REMINDER_MINUTES.length || elapsed < db.ADDRESS_REMINDER_MINUTES[reminders]) continue;
    if (!(await db.claimAddressReminder(env, order.id, reminders))) continue;
    const result = await deliver(env, order.user_id, addressReminderText(order), fillAddressKeyboard());
    summary.addressReminders++;
    if (result.outcome === 'retry') {
      await db.releaseAddressReminder(env, order.id, reminders, result.error);
    } else if (result.outcome === 'failed') {
      await db.recordNotifyError(env, order.id, result.error);
      await alert(order, 'پیام یادآوری به مشتری نرسید (احتمالاً ربات را بلاک کرده است).');
    }
  }
}

export async function processPendingOrders(env, now = new Date()) {
  const summary = {
    cancelled: 0,
    cancelNotified: 0,
    cancelNoticeRetry: 0,
    cancelNoticeFailed: 0,
    reminded: 0,
    reminderRetry: 0,
    reminderFailed: 0,
    addressReminders: 0,
    addressAlerts: 0,
  };

  // ۱) لغو سفارش‌های منقضی (قبل از یادآوری، تا برای سفارش منقضی یادآوری نرود)
  const cancelledOrders = [];
  for (const order of await db.listExpiredPendingOrders(env, now, CANCEL_BATCH)) {
    if (await db.cancelExpiredPendingOrder(env, order.id, now)) {
      summary.cancelled++;
      cancelledOrders.push(order);
    }
  }

  // ۱-ب) یک پیام خلاصه برای ادمین (فقط اطلاع‌رسانی؛ در صورت خطا تکرار نمی‌شود)
  if (cancelledOrders.length > 0 && env.ADMIN_CHAT_ID) {
    const result = await deliver(env, env.ADMIN_CHAT_ID, adminCancelText(cancelledOrders));
    summary.adminNotice = result.outcome;
  }

  // ۲) اطلاع‌رسانی لغو (شامل تلاش مجدد برای خطاهای موقت)
  for (const order of await db.listPendingCancelNotices(env, MAX_NOTIFY_ATTEMPTS, NOTICE_BATCH)) {
    if (!(await db.claimCancelNotice(env, order.id, now, MAX_NOTIFY_ATTEMPTS))) continue;
    const result = await deliver(env, order.user_id, cancelText(order));
    if (result.outcome === 'sent') {
      summary.cancelNotified++;
    } else if (result.outcome === 'retry') {
      await db.releaseCancelNotice(env, order.id, result.error);
      summary.cancelNoticeRetry++;
    } else {
      await db.recordNotifyError(env, order.id, result.error);
      summary.cancelNoticeFailed++;
    }
  }

  // ۳) یادآوری ۱۰ دقیقه‌ای (حداکثر یک یادآوری موفق برای هر سفارش)
  for (const order of await db.listDueReminders(env, now, MAX_NOTIFY_ATTEMPTS, REMINDER_BATCH)) {
    if (!(await db.claimReminder(env, order.id, now, MAX_NOTIFY_ATTEMPTS))) continue;
    const result = await deliver(env, order.user_id, reminderText(order, now), resumeKeyboard(order.id));
    if (result.outcome === 'sent') {
      summary.reminded++;
    } else if (result.outcome === 'retry') {
      await db.releaseReminder(env, order.id, result.error);
      summary.reminderRetry++;
    } else {
      await db.recordNotifyError(env, order.id, result.error);
      summary.reminderFailed++;
    }
  }

  // ۴) پیگیری آدرس سفارش‌های پیک/پست
  await processAddressFollowups(env, now, summary);

  // تعداد درخواست‌های ارسالی این اجرا (بقیه‌ی سهمیه به پیام همگانی می‌رسد)
  summary.messages =
    summary.cancelNotified + summary.cancelNoticeRetry + summary.cancelNoticeFailed +
    summary.reminded + summary.reminderRetry + summary.reminderFailed + (summary.adminNotice ? 1 : 0) +
    summary.addressReminders + summary.addressAlerts;

  return summary;
}
