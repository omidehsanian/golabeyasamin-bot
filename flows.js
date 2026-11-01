import * as api from './api.js';
import * as db from './db.js';
import * as KB from './keyboards.js';
import {
  buildProductCaption,
  getFullProduct,
  listProducts,
  orderPrice,
  parseVariant,
  QUANTITY_CHOICES,
  shippingInfoText,
  variantLabel,
} from './products.js';
import { cashbackPercent, channelEnabled, customBotEnabled, freeShippingMin, money, isAdmin, isSuperAdmin, productColumns, productFeaturedFirst } from './config.js';

const BROADCAST_SOURCE_KEY = 'broadcast_source';

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ----------------------------------------------------
// بررسی گام‌به‌گام دسترسی کاربر (فقط عضویت کانال در ابتدا)
// ----------------------------------------------------
export async function canProceed(env, chatId) {
  if (!channelEnabled(env)) return true;
  const channelConfirmed = await db.isChannelConfirmed(env, chatId);
  if (!channelConfirmed) {
    const channelUsername = (env.CHANNEL_USERNAME || '').replace('@', '');
    const joinLink = `https://t.me/${channelUsername}`;
    await api.sendMessage(
      env,
      chatId,
      `🌸 برای استفاده از امکانات ربات، ابتدا باید در کانال ما عضو شوید:\n\n👉 @${channelUsername}`,
      KB.channelRequireKeyboard(joinLink)
    );
    return false;
  }

  // بررسی ثبت‌نام اجباری اولیه برداشته شد تا دکمه «شاید بعدا» کار کند.
  // ثبت‌نام فقط در بخش‌های حساس مثل کیف پول، دعوت از دوستان، پرداخت و دانلود اندروید چک می‌شود.

  return true;
}

// ----------------------------------------------------
// منوی اصلی: دکمه‌ی محصولات به ترتیب جایگاه + دکمه‌های ادمین
// ----------------------------------------------------
export async function menuKeyboardFor(env, chatId) {
  return KB.mainMenuKeyboard(await listProducts(env), {
    superAdmin: isSuperAdmin(env, chatId),
    admin: isAdmin(env, chatId),
    columns: productColumns(env),
    featuredFirst: productFeaturedFirst(env),
    customBot: customBotEnabled(env),
  });
}

// ----------------------------------------------------
// ورود به منوی اصلی پس از ثبت‌نام
// ----------------------------------------------------
export async function resumeAfterRegistration(env, chatId) {
  await db.clearSession(env, chatId);
  await api.sendMessage(
    env,
    chatId,
    'از منوی زیر یکی رو انتخاب کن 👇',
    await menuKeyboardFor(env, chatId)
  );
}

// ----------------------------------------------------
// نمایش جزئیات محصول
// ----------------------------------------------------
export async function showProduct(env, chatId, productId) {
  const product = await getFullProduct(env, productId);
  if (!product) {
    await api.sendMessage(env, chatId, '❌ محصول پیدا نشد.', await menuKeyboardFor(env, chatId));
    return;
  }

  let text = buildProductCaption(product);
  if (product.price > 0) text += `\n\n${shippingInfoText(env)}`;
  const keyboard = product.price > 0 ? KB.productKeyboard(product) : null;
  if (product.photoFileId) {
    await api.sendPhoto(env, chatId, product.photoFileId, text, keyboard);
  } else {
    await api.sendMessage(env, chatId, text, keyboard);
  }
}

// ----------------------------------------------------
// نمایش صفحه پرداخت (اصلاح قیمت و رفع مشکل پرانتزها در تلگرام)
// ----------------------------------------------------
// ----------------------------------------------------
// مراحل خرید: تعداد ← روش تحویل ← (آدرس برای پیک) ← کد تخفیف ← پیش‌فاکتور
// ----------------------------------------------------
const addressKey = (chatId) => `address:${chatId}`;
export const MAX_ADDRESS_LENGTH = 400;

export async function getSavedAddress(env, chatId) {
  return String((await db.getSetting(env, addressKey(chatId), '')) || '').trim();
}

export async function saveAddress(env, chatId, address) {
  await db.setSetting(env, addressKey(chatId), address);
}

export async function askQuantity(env, chatId, productId) {
  const product = await getFullProduct(env, productId);
  if (!product) {
    await api.sendMessage(env, chatId, '❌ این محصول دیگر موجود نیست.', await menuKeyboardFor(env, chatId));
    return;
  }
  await api.sendMessage(env, chatId, `🔢 چند عدد «${escapeHtml(product.title)}» می‌خواهید؟`, KB.quantityKeyboard(productId, QUANTITY_CHOICES));
}

export async function askDelivery(env, chatId, productId, quantity) {
  await api.sendMessage(env, chatId, `🚚 روش تحویل را انتخاب کنید:\n\n${shippingInfoText(env)}`, KB.deliveryKeyboard(productId, quantity));
}

// بعد از انتخاب روش تحویل: برای پیک آدرس گرفته می‌شود، بعد کد تخفیف / پیش‌فاکتور
export async function chooseDelivery(env, chatId, productId, osType) {
  if (parseVariant(osType).delivery === 'courier') {
    const saved = await getSavedAddress(env, chatId);
    await db.setSession(env, chatId, 'awaiting_address', { productId, osType });
    if (saved) {
      await api.sendMessage(env, chatId, `📍 آدرس قبلی شما:\n${escapeHtml(saved)}`, KB.savedAddressKeyboard(productId, osType));
      await api.sendMessage(env, chatId, 'یا آدرس جدید را بنویسید 👇', KB.cancelKeyboard());
    } else {
      await api.sendMessage(env, chatId, '📍 آدرس کامل و کد پستی برای ارسال با پیک را بنویسید:', KB.cancelKeyboard());
    }
    return;
  }
  await continueCheckout(env, chatId, productId, osType);
}

export async function continueCheckout(env, chatId, productId, osType) {
  if (await db.isDiscountActive(env)) {
    await api.sendMessage(env, chatId, '🎟️ آیا کد تخفیف دارید؟', KB.discountPromptKeyboard(productId, osType));
  } else {
    await showPayment(env, chatId, productId, osType, 0);
  }
}

// محاسبه‌ی مبلغ از روی قیمت فعلی محصول، تعداد، تخفیف، هزینه‌ی ارسال و موجودی فعلی (موجودی منفی = صفر)
export async function priceBreakdown(env, chatId, product, osType = '', discountPercent = 0) {
  const p = orderPrice(env, product, osType, discountPercent);
  const wallet = Math.max(0, await db.getWallet(env, chatId));
  const walletUsed = p.price > 0 ? Math.min(wallet, p.price) : 0;
  return { ...p, wallet, walletUsed, payable: p.price - walletUsed };
}

// متن تحویل برای پیام‌های ادمین: روش تحویل، تعداد و آدرس (از یادداشت سفارش)
export function deliveryLines(order) {
  const label = variantLabel(order?.os_type);
  if (!label) return '';
  let text = `📦 ${label}\n`;
  if (parseVariant(order.os_type).delivery === 'courier' && order.note) text += `${escapeHtml(order.note)}\n`;
  return text;
}

// صدور پیش‌فاکتور: یک سفارش pending ساخته یا تازه می‌شود و دکمه‌ها به همان سفارش متصل‌اند
export async function showPayment(env, chatId, productId, osType = '', discountPercent = 0) {
  const product = await getFullProduct(env, productId);
  if (!product) {
    await api.sendMessage(env, chatId, '❌ این محصول دیگر موجود نیست.', await menuKeyboardFor(env, chatId));
    return;
  }

  const b = await priceBreakdown(env, chatId, product, osType, discountPercent);
  if (b.basePrice <= 0) {
    await api.sendMessage(env, chatId, '⚠️ این محصول هنوز قیمت‌گذاری نشده است.');
    return;
  }

  const order = await db.upsertPendingOrder(env, {
    chatId,
    productId,
    productTitle: product.title,
    osType,
    discountPercent,
    amount: b.price,
    walletUsed: b.walletUsed,
  });
  if (order && parseVariant(osType).delivery === 'courier') {
    const address = await getSavedAddress(env, chatId);
    if (address) await db.setPendingOrderNote(env, order.id, chatId, `📍 آدرس: ${address}`);
  }

  const keyboard = order
    ? KB.orderPaymentKeyboard(order.id, b.price > 0 && b.wallet >= b.price)
    : KB.paymentKeyboard(productId, osType, b.price > 0 && b.wallet >= b.price);
  await api.sendMessage(env, chatId, invoiceText(env, product, osType, discountPercent, b), keyboard);
}

// «ادامه خرید»: قیمت، موجودی و وضعیت دوباره بررسی و همان مرحله‌ی قبلی بازیابی می‌شود
export async function resumeCheckout(env, chatId, order) {
  const product = await getFullProduct(env, order.product_id);
  const discountPercent = Number(order.discount_percent) || 0;
  const b = product ? await priceBreakdown(env, chatId, product, order.os_type || '', discountPercent) : null;
  if (!product || b.basePrice <= 0) {
    await api.sendMessage(env, chatId, '⚠️ این محصول در حال حاضر قابل خرید نیست. لطفاً از منو محصول دیگری انتخاب کنید.', await menuKeyboardFor(env, chatId));
    return;
  }

  await db.refreshPendingAmounts(env, order.id, b.price, b.walletUsed);
  const text = invoiceText(env, product, order.os_type || '', discountPercent, b);

  if (order.checkout_step === 'awaiting_receipt') {
    await db.setSession(env, chatId, 'awaiting_receipt', {
      orderId: order.id,
      productId: order.product_id,
      osType: order.os_type || '',
      discountPercent,
    });
    await api.sendMessage(env, chatId, `${text}\n\n📸 لطفاً تصویر رسید واریزی خود را ارسال کنید:`, KB.cancelKeyboard());
    return;
  }

  await api.sendMessage(env, chatId, text, KB.orderPaymentKeyboard(order.id, b.price > 0 && b.wallet >= b.price));
}

function invoiceText(env, product, osType, discountPercent, b) {
  const { basePrice, discountAmount, shipping, price, wallet, walletUsed, payable } = b;
  const { delivery, quantity } = parseVariant(osType);

  let text = `💳 <b>پیش‌فاکتور خرید:</b>\n\n🛍 محصول: ${escapeHtml(product.title)}\n`;
  if (delivery) {
    text += `🔢 تعداد: ${quantity.toLocaleString('fa-IR')} × ${money(product.price)} تومان\n`;
    text += `💰 مبلغ کالا: ${money(basePrice)} تومان\n`;
  } else {
    text += `💰 قیمت: ${money(basePrice)} تومان\n`;
  }

  if (discountPercent > 0) {
    text += `📉 تخفیف (${discountPercent}%): ${money(discountAmount)} تومان\n`;
  }

  if (delivery === 'pickup') {
    text += '🏬 تحویل حضوری: رایگان\n';
  } else if (delivery === 'courier') {
    text += shipping > 0
      ? `🛵 هزینه ارسال با پیک: ${money(shipping)} تومان\n`
      : `🛵 ارسال با پیک: <b>رایگان</b> (خرید بالای ${money(freeShippingMin(env))} تومان)\n`;
  }
  text += `🧾 جمع کل: <b>${money(price)} تومان</b>\n`;

  if (walletUsed > 0) {
    text += `💼 اعتبار کیف پول: ${money(wallet)} تومان\n`;
    text += `🔹 کسر شده از کیف پول: ${money(walletUsed)} تومان\n`;
  }

  text += `💳 مبلغ قابل پرداخت: <b>${money(payable)} تومان</b>\n`;

  // همان محاسبه‌ی confirmOrder: درصدی از مبلغ نقدی
  const cashback = Math.round((payable * cashbackPercent(env)) / 100);
  if (cashback > 0) {
    text += `💸 کش‌بک: <b>${money(cashback)} تومان</b> (${cashbackPercent(env)}٪) بعد از تایید سفارش به کیف پول شما برمی‌گردد\n`;
  }
  text += '\n';

  if (payable <= 0) {
    text += '🎉 موجودی کیف پول شما برای خرید این محصول کافی است!';
  } else {
    text += `لطفاً مبلغ <b>${money(payable)} تومان</b> را به شماره کارت زیر واریز کرده و دکمه «ارسال رسید» را بزنید.\n\n` +
            `💳 شماره کارت: <code>${env.CARD_NUMBER || ''}</code>\n` +
            `👤 به نام: ${env.CARD_HOLDER || ''}`;
  }

  return text;
}

// ----------------------------------------------------
// اطلاع‌رسانی به ادمین‌ها
// ----------------------------------------------------
export async function notifyAdmin(env, text, keyboard = null) {
  const supportId = env.SUPPORT_CHAT_ID || env.ADMIN_CHAT_ID;
  if (supportId) {
    await api.sendMessage(env, supportId, text, keyboard);
  }
  if (env.ADMIN_CHAT_ID && env.ADMIN_CHAT_ID !== supportId) {
    await api.sendMessage(env, env.ADMIN_CHAT_ID, text, keyboard);
  }
}

// ----------------------------------------------------
// پیام همگانی خودکار
// ادمین فقط پیام را می‌فرستد؛ صف در دیتابیس ساخته می‌شود و Cron هر دقیقه یک دسته را
// ارسال می‌کند (processBroadcastQueue). پایان کار، خلاصه‌ی نتیجه برای ادمین فرستاده می‌شود.
// خود پیام ادمین با copyMessage کپی می‌شود، پس متن، عکس، فیلم، گیف، فایل و ویس همگی با
// همان کپشن و قالب‌بندی ارسال می‌شوند. وضعیت کار در settings نگه داشته می‌شود تا نیازی به
// تغییر ساختار جدول broadcast_queue نباشد.
// وضعیت ردیف‌های صف: pending → sending → sent | failed  (یا cancelled با /stopbroadcast)
// ----------------------------------------------------
const BROADCAST_JOB_KEY = 'broadcast_job';
const BROADCAST_ERROR_KEY = 'broadcast_last_error';
const BROADCAST_HEARTBEAT_KEY = 'broadcast_heartbeat';
// ردیف‌هایی که بیش از این مدت در وضعیت sending مانده‌اند (اجرای نیمه‌کاره) ناموفق حساب می‌شوند
const BROADCAST_STALE_MINUTES = 5;

// هر اجرای Cron یک دسته‌ی ۴۰تایی می‌فرستد (قابل تغییر با BROADCAST_BATCH_SIZE)
const DEFAULT_BROADCAST_BATCH = 40;
function broadcastBatchSize(env) {
  const n = Number(env.BROADCAST_BATCH_SIZE || DEFAULT_BROADCAST_BATCH);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BROADCAST_BATCH;
}

async function getBroadcastJob(env) {
  try {
    return JSON.parse(await db.getSetting(env, BROADCAST_JOB_KEY, 'null'));
  } catch (e) {
    return null;
  }
}

async function broadcastCounts(env) {
  const { results } = await env.DB.prepare(
    'SELECT status, COUNT(*) AS cnt FROM broadcast_queue GROUP BY status'
  ).all();
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
  for (const r of results || []) counts[r.status] = Number(r.cnt) || 0;
  return counts;
}

function broadcastEta(env, left) {
  return Math.max(1, Math.ceil(left / broadcastBatchSize(env)));
}

export async function broadcastStatusText(env) {
  const job = await getBroadcastJob(env);
  if (!job || job.done) return '📭 در حال حاضر هیچ پیام همگانی در حال ارسال نیست.';
  const c = await broadcastCounts(env);
  const left = c.pending + c.sending;
  return (
    `📢 <b>پیام همگانی در حال ارسال است</b>\n\n` +
    `✅ موفق: ${c.sent} | ❌ ناموفق: ${c.failed}\n` +
    `⏳ باقی‌مانده: ${left} نفر (حدود ${broadcastEta(env, left)} دقیقه)\n\n` +
    `برای توقف: <code>/stopbroadcast</code>`
  );
}

export async function broadcastToAll(env, adminChatId, messageObj) {
  try {
    const running = await getBroadcastJob(env);
    if (running && !running.done) {
      await api.sendMessage(
        env,
        adminChatId,
        `⚠️ پیام همگانی قبلی هنوز تمام نشده است.\n\n${await broadcastStatusText(env)}`,
        await menuKeyboardFor(env, adminChatId)
      );
      return;
    }

    const chatIds = await db.getAllChatIds(env);

    if (!chatIds || chatIds.length === 0) {
      await api.sendMessage(env, adminChatId, '⚠️ هیچ کاربری در دیتابیس یافت نشد.', await menuKeyboardFor(env, adminChatId));
      return;
    }

    const textContent = (messageObj && (messageObj.text || messageObj.caption)) || '';
    const source = { from_chat_id: String(messageObj.chat.id), message_id: messageObj.message_id };
    await db.setSetting(env, BROADCAST_SOURCE_KEY, JSON.stringify(source));
    await db.setSetting(env, BROADCAST_ERROR_KEY, '');
    await db.setSetting(env, BROADCAST_HEARTBEAT_KEY, db.sqlTime());

    await env.DB.prepare("DELETE FROM broadcast_queue").run();

    const stmt = env.DB.prepare("INSERT INTO broadcast_queue (chat_id, text, status) VALUES (?, ?, 'pending')");
    const batchStmts = chatIds.map((cid) => stmt.bind(cid, textContent));
    await env.DB.batch(batchStmts);

    // job آخر از همه ذخیره می‌شود تا Cron فقط صف کامل‌شده را بردارد
    const job = { admin: String(adminChatId), total: chatIds.length, started_at: db.sqlTime(), done: false };
    await db.setSetting(env, BROADCAST_JOB_KEY, JSON.stringify(job));

    await api.sendMessage(
      env,
      adminChatId,
      `📢 <b>صف پیام همگانی ساخته شد!</b>\n\n` +
        `👥 تعداد کل کاربران: ${chatIds.length} نفر\n` +
        `⏱ زمان تقریبی ارسال: حدود ${broadcastEta(env, chatIds.length)} دقیقه\n\n` +
        `ارسال به‌صورت خودکار انجام می‌شود و نیازی به کاری از طرف شما نیست. ` +
        `بعد از پایان، نتیجه برایتان ارسال می‌شود.\n\n` +
        `وضعیت: <code>/broadcaststatus</code> | توقف: <code>/stopbroadcast</code>`,
      await menuKeyboardFor(env, adminChatId)
    );

  } catch (err) {
    await api.sendMessage(
      env,
      adminChatId,
      `❌ خطا در ایجاد صف پیام همگانی: ${err.message || err}`,
      await menuKeyboardFor(env, adminChatId)
    );
  }
}

// توقف ارسال: ردیف‌های ارسال‌نشده لغو می‌شوند؛ گزارش نهایی در اجرای بعدی Cron ارسال می‌شود
export async function stopBroadcast(env) {
  const job = await getBroadcastJob(env);
  if (!job || job.done) return null;
  const result = await env.DB.prepare("UPDATE broadcast_queue SET status = 'cancelled' WHERE status = 'pending'").run();
  return result.meta.changes || 0;
}

// گزارش پایان فقط یک بار ارسال می‌شود (compare-and-swap روی مقدار job در settings)
async function finishBroadcast(env, job, rawJob) {
  const doneJob = JSON.stringify({ ...job, done: true, finished_at: db.sqlTime() });
  const claimed = await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
    .bind(doneJob, BROADCAST_JOB_KEY, rawJob)
    .run();
  if (claimed.meta.changes !== 1) return false;

  const c = await broadcastCounts(env);
  const lastError = await db.getSetting(env, BROADCAST_ERROR_KEY, '');
  const errorLine = lastError ? `\n⚠️ آخرین خطا: <code>${escapeHtml(lastError)}</code>` : '';
  const cancelledLine = c.cancelled > 0 ? `\n⛔ متوقف‌شده (ارسال‌نشده): ${c.cancelled} نفر` : '';
  await api.sendMessage(
    env,
    job.admin,
    `🎉 <b>ارسال پیام همگانی به پایان رسید!</b>\n\n` +
      `👥 کل: ${job.total} نفر\n` +
      `✅ موفق: ${c.sent} | ❌ ناموفق: ${c.failed}${cancelledLine}${errorLine}`,
    await menuKeyboardFor(env, job.admin)
  );
  return true;
}

// اجرا با Cron: ارسال یک دسته و در صورت اتمام صف، گزارش نهایی به ادمین.
// maxSends: سقف ارسال در این اجرا (اگر Cron در همین دقیقه پیام سفارش‌ها را هم فرستاده باشد کمتر از ۴۰ است)
export async function processBroadcastQueue(env, now = new Date(), maxSends = Infinity) {
  const summary = { sent: 0, failed: 0, finished: false };
  const rawJob = await db.getSetting(env, BROADCAST_JOB_KEY, null);
  let job = null;
  try {
    job = JSON.parse(rawJob);
  } catch (e) {}
  // صف‌های قدیمی بدون job (نسخه‌ی دستی قبلی) خودکار ارسال نمی‌شوند
  if (!job || job.done) return summary;

  // برداشتن اتمی یک دسته: اجرای هم‌زمان Cron ردیف تکراری برنمی‌دارد
  const { results: rows } = await env.DB.prepare(
    `UPDATE broadcast_queue SET status = 'sending'
     WHERE id IN (SELECT id FROM broadcast_queue WHERE status = 'pending' ORDER BY id LIMIT ?)
     RETURNING id, chat_id, text`
  ).bind(Math.max(0, Math.min(broadcastBatchSize(env), maxSends))).all();

  if (rows && rows.length > 0) {
    await db.setSetting(env, BROADCAST_HEARTBEAT_KEY, db.sqlTime(now));

    let source = null;
    try {
      source = JSON.parse(await db.getSetting(env, BROADCAST_SOURCE_KEY, 'null'));
    } catch (e) {}

    const sentIds = [];
    const failedIds = [];
    let lastError = '';

    for (const row of rows) {
      try {
        let res;
        if (source && source.message_id) {
          res = await api.copyMessage(env, row.chat_id, source.from_chat_id, source.message_id);
        } else if (row.text) {
          res = await api.sendMessage(env, row.chat_id, row.text);
        }

        if (res && res.ok) {
          sentIds.push(row.id);
        } else {
          failedIds.push(row.id);
          lastError = res?.description || 'پیام قابل ارسالی پیدا نشد';
        }
      } catch (e) {
        failedIds.push(row.id);
        lastError = e.message || String(e);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const mark = (status, ids) =>
      env.DB.prepare(`UPDATE broadcast_queue SET status = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(status, ...ids);
    const stmts = [];
    if (sentIds.length) stmts.push(mark('sent', sentIds));
    if (failedIds.length) stmts.push(mark('failed', failedIds));
    await env.DB.batch(stmts);
    if (lastError) await db.setSetting(env, BROADCAST_ERROR_KEY, lastError);

    summary.sent = sentIds.length;
    summary.failed = failedIds.length;
  }

  const c = await broadcastCounts(env);
  if (c.pending > 0) return summary;

  if (c.sending > 0) {
    // ردیف sending فقط وقتی باقی می‌ماند که اجرای قبلی وسط کار قطع شده باشد
    const heartbeat = await db.getSetting(env, BROADCAST_HEARTBEAT_KEY, job.started_at);
    const staleBefore = db.sqlTime(new Date(now.getTime() - BROADCAST_STALE_MINUTES * 60000));
    if (String(heartbeat) > staleBefore) return summary;
    await env.DB.prepare("UPDATE broadcast_queue SET status = 'failed' WHERE status = 'sending'").run();
    await db.setSetting(env, BROADCAST_ERROR_KEY, 'اجرای ارسال نیمه‌کاره قطع شد؛ وضعیت این ردیف‌ها نامعلوم است');
  }

  summary.finished = await finishBroadcast(env, job, rawJob);
  return summary;
}
