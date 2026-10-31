// -*- users / wallet / referrals / orders (D1) -*-

// وضعیت‌هایی که سفارش هنوز منتظر تصمیم ادمین است (فقط این‌ها قابل تایید/رد هستند).
// 'pending' عمداً اینجا نیست: یعنی پیش‌فاکتور صادر شده ولی هنوز رسید یا پرداختی ثبت نشده.
const PENDING_ORDER_STATUSES_SQL = "'new', 'receipt_sent', 'awaiting_confirmation'";

// جلوی ساخت رکوردهایی مثل chat_id = "undefined" را می‌گیرد
export function assertChatId(chatId) {
  const id = String(chatId ?? '').trim();
  if (!/^-?\d+$/.test(id)) {
    throw new Error(`invalid chat_id: "${id}"`);
  }
  return id;
}

export async function getUser(env, chatId) {
  return env.DB.prepare('SELECT * FROM users WHERE chat_id = ?').bind(String(chatId)).first();
}

export async function ensureUser(env, chatId) {
  const id = assertChatId(chatId);
  const existing = await getUser(env, id);
  if (existing) return existing;
  await env.DB.prepare('INSERT OR IGNORE INTO users (chat_id) VALUES (?)').bind(id).run();
  return getUser(env, id);
}

// نام کاربری تلگرام (برای گزارش سفارش‌های ادمین)؛ فقط وقتی تغییر کرده نوشته می‌شود
export async function rememberUsername(env, chatId, username) {
  const name = String(username || '').trim();
  if (!name) return;
  await env.DB.prepare(
    "UPDATE users SET username = ? WHERE chat_id = ? AND COALESCE(username, '') <> ?"
  ).bind(name, String(chatId), name).run();
}

export async function saveRegistration(env, chatId, contact) {
  const phone = contact.phone_number || '';
  const firstName = contact.first_name || '';
  const lastName = contact.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim();

  await ensureUser(env, chatId);
  await env.DB.prepare(
    'UPDATE users SET first_name = ?, last_name = ?, full_name = ?, phone = ? WHERE chat_id = ?'
  )
    .bind(firstName, lastName, fullName, phone, String(chatId))
    .run();
}

export async function isRegistered(env, chatId) {
  const u = await getUser(env, chatId);
  return !!(u && u.phone && u.phone.trim() !== '');
}

export async function getFullName(env, chatId) {
  const u = await getUser(env, chatId);
  return (u && u.full_name) || '';
}

export async function getPhone(env, chatId) {
  const u = await getUser(env, chatId);
  return (u && u.phone) || '';
}

export async function getWallet(env, chatId) {
  const u = await getUser(env, chatId);
  return (u && u.wallet) || 0;
}

// ==========================================
// گردش مالی کیف پول (اتمیک + ایمن در برابر اجرای تکراری)
// ==========================================
//
// هر تغییر موجودی فقط از این مسیر انجام می‌شود: یک ردیف با کلید یکتا
// (idempotency_key) در wallet_transactions ثبت می‌شود و موجودی فقط وقتی
// تغییر می‌کند که آن ردیف همین الان ساخته شده باشد. هر سه دستور در یک
// DB.batch (یک تراکنش D1) اجرا می‌شوند، پس:
//   - اجرای دوباره با همان کلید هیچ اثری ندارد (INSERT OR IGNORE)
//   - موجودی هرگز منفی نمی‌شود (شرط wallet + amount >= 0 در همان تراکنش)
//   - درخواست‌های هم‌زمان پشت سر هم اجرا می‌شوند، نه درهم
function walletTxStatements(env, { key, chatId, orderId = null, type, amount, note = '', requireSql = '', requireBinds = [] }) {
  const id = assertChatId(chatId);
  const amt = Math.trunc(Number(amount));
  if (!Number.isFinite(amt)) throw new Error(`invalid wallet amount: ${amount}`);

  let cond = 'EXISTS (SELECT 1 FROM users WHERE chat_id = ? AND wallet + ? >= 0)';
  if (requireSql) cond += ` AND ${requireSql}`;

  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO wallet_transactions (idempotency_key, chat_id, order_id, type, amount, note, applied)
       SELECT ?, ?, ?, ?, ?, ?, 0 WHERE ${cond}`
    ).bind(key, id, orderId, type, amt, note, id, amt, ...requireBinds),
    env.DB.prepare(
      `UPDATE users SET wallet = wallet + ?
       WHERE chat_id = ? AND wallet + ? >= 0
         AND EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key = ? AND applied = 0)`
    ).bind(amt, id, amt, key),
    env.DB.prepare(
      `UPDATE wallet_transactions SET applied = 1, balance_after = (SELECT wallet FROM users WHERE chat_id = ?)
       WHERE idempotency_key = ? AND applied = 0`
    ).bind(id, key),
  ];
}

// نتیجه‌ی سه دستور بالا: آیا تراکنش در همین اجرا اعمال شد؟
function txAppliedNow(results, startIndex) {
  return results[startIndex + 2]?.meta?.changes === 1;
}

export async function applyWalletTransaction(env, tx) {
  const results = await env.DB.batch(walletTxStatements(env, tx));
  if (txAppliedNow(results, 0)) return { applied: true, duplicate: false };
  const existing = await env.DB.prepare('SELECT id FROM wallet_transactions WHERE idempotency_key = ?')
    .bind(tx.key)
    .first();
  return { applied: false, duplicate: !!existing };
}

// اصلاح دستی موجودی توسط ادمین (کلید یکتا را خود فراخواننده می‌دهد)
export async function adminAdjustWallet(env, chatId, amount, key, note = '') {
  await ensureUser(env, chatId);
  return applyWalletTransaction(env, { key, chatId, type: 'admin_adjustment', amount, note });
}

// هدیه ثبت‌نام: فقط یک‌بار برای هر کاربر و فقط اگر این شماره قبلاً برای کاربر دیگری ثبت نشده باشد
export async function grantSignupBonus(env, chatId, amount, phone) {
  if (!(amount > 0)) return { applied: false, duplicate: false };
  return applyWalletTransaction(env, {
    key: `signup:${assertChatId(chatId)}`,
    chatId,
    type: 'signup_bonus',
    amount,
    requireSql: "NOT EXISTS (SELECT 1 FROM users WHERE phone = ? AND phone <> '' AND chat_id <> ?)",
    requireBinds: [String(phone || ''), String(chatId)],
  });
}

export async function getWalletTransactions(env, chatId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM wallet_transactions WHERE chat_id = ? ORDER BY id'
  ).bind(String(chatId)).all();
  return results || [];
}

export async function isChannelConfirmed(env, chatId) {
  const u = await getUser(env, chatId);
  return !!(u && u.channel_confirmed);
}

export async function setChannelConfirmed(env, chatId) {
  await ensureUser(env, chatId);
  await env.DB.prepare('UPDATE users SET channel_confirmed = 1 WHERE chat_id = ?').bind(String(chatId)).run();
}

export async function removeChannelConfirmed(env, chatId) {
  await env.DB.prepare('UPDATE users SET channel_confirmed = 0 WHERE chat_id = ?').bind(String(chatId)).run();
}

export async function resetAllChannelConfirmations(env) {
  await env.DB.prepare('UPDATE users SET channel_confirmed = 0').run();
}

export async function getAllUsersDetails(env) {
  const { results } = await env.DB.prepare(
    'SELECT chat_id, full_name, first_name, phone FROM users ORDER BY id DESC'
  ).all();
  return results || [];
}

export async function deleteUser(env, chatId) {
  await env.DB.prepare('DELETE FROM users WHERE chat_id = ?').bind(String(chatId)).run();
  await env.DB.prepare('DELETE FROM sessions WHERE chat_id = ?').bind(String(chatId)).run();
}

// ==========================================
// تنظیمات عمومی (Settings)
// ==========================================

export async function getSetting(env, key, fallback = '0') {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
    return row ? row.value : fallback;
  } catch (e) {
    return fallback;
  }
}

// وضعیت سیستم کد تخفیف: مقداری که ادمین با /toggrediscount در دیتابیس ذخیره کرده اولویت دارد؛
// فقط اگر هنوز هیچ مقداری ذخیره نشده، پیش‌فرض DISCOUNT_ENABLED در wrangler.toml استفاده می‌شود.
export async function isDiscountActive(env) {
  const dbVal = await getSetting(env, 'discount_active', null);
  if (dbVal === '1') return true;
  if (dbVal === '0') return false;
  return env.DISCOUNT_ENABLED === 'true';
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?`
  ).bind(key, value, value).run();
}

// ==========================================
// مدیریت قفل کد تخفیف کاربر
// ==========================================

export async function setUserDiscountLock(env, chatId, lockUntil) {
  await ensureUser(env, chatId);
  await env.DB.prepare('UPDATE users SET discount_locked_until = ? WHERE chat_id = ?')
    .bind(lockUntil, String(chatId))
    .run();
}

// ==========================================
// رفرال
// ==========================================

// فقط رابطه‌ی دعوت را ثبت می‌کند؛ هیچ پولی در این مرحله جابه‌جا نمی‌شود.
// پاداش دعوت پس از اولین خرید تاییدشده‌ی کاربر دعوت‌شده پرداخت می‌شود (confirmOrder).
export async function registerReferral(env, referrerId, invitedId) {
  const referrer = String(referrerId ?? '').trim();
  const invited = String(invitedId ?? '').trim();
  if (!/^\d+$/.test(referrer) || !/^\d+$/.test(invited) || referrer === invited) return false;

  const result = await env.DB.prepare(
    `INSERT OR IGNORE INTO referrals (referrer_id, invited_id)
     SELECT ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE chat_id = ?)`
  )
    .bind(referrer, invited, referrer)
    .run();
  return result.meta.changes === 1;
}

export async function getReferralStats(env, chatId) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM referrals WHERE referrer_id = ?')
    .bind(String(chatId))
    .first();
  return (row && row.c) || 0;
}

export async function getReferrerOf(env, invitedId) {
  const row = await env.DB.prepare('SELECT referrer_id FROM referrals WHERE invited_id = ?')
    .bind(String(invitedId))
    .first();
  return (row && row.referrer_id) || null;
}

// ==========================================
// لیست کل کاربران
// ==========================================

export async function getAllChatIds(env) {
  const { results } = await env.DB.prepare('SELECT chat_id FROM users').all();
  return results.map((r) => r.chat_id);
}

// ==========================================
// سفارش‌ها
// ==========================================

export async function saveOrder(env, chatId, productId, productTitle, opts = {}) {
  const { osType = '', amount = 0, walletUsed = 0, status = 'pending', note = '' } = opts;

  const result = await env.DB.prepare(
    `INSERT INTO orders (user_id, product_id, product_title, os_type, amount, wallet_used, status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(String(chatId), productId, productTitle, osType, amount, walletUsed, status, note)
    .run();

  return result.meta.last_row_id;
}

export async function getOrder(env, orderId) {
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
}

// تایید سفارش: کسر کیف پول، تغییر وضعیت، کش‌بک خریدار، کمیسیون و پاداش دعوت همه در یک تراکنش.
// اجرای دوباره (دوبار کلیک، کلیک هم‌زمان دو ادمین، retry تلگرام) هیچ مبلغی را
// دوباره جابه‌جا نمی‌کند؛ ولی اگر اجرای قبلی نیمه‌کاره مانده باشد، تکمیلش می‌کند.
//
// خروجی: { ok, reason, order, cashback, commission, referralReward }
//   reason: 'confirmed' | 'already_confirmed' | 'insufficient_wallet' | 'invalid_status' | 'not_found'
export async function confirmOrder(env, orderId, { commissionPercent = 0, referralReward = 0, cashbackPercent = 0 } = {}) {
  const id = Number(orderId);
  const order = Number.isInteger(id) ? await getOrder(env, id) : null;
  if (!order) return { ok: false, reason: 'not_found', order: null };

  const walletDebit = Math.max(0, Number(order.wallet_used) || 0);
  const netPaid = Math.max(0, (Number(order.amount) || 0) - walletDebit);
  const debitKey = `order:${id}:debit`;
  const stmts = [];

  if (walletDebit > 0) {
    stmts.push(
      ...walletTxStatements(env, {
        key: debitKey,
        chatId: order.user_id,
        orderId: id,
        type: 'order_debit',
        amount: -walletDebit,
        requireSql: `EXISTS (SELECT 1 FROM orders WHERE id = ? AND status IN (${PENDING_ORDER_STATUSES_SQL}))`,
        requireBinds: [id],
      })
    );
  }

  const confirmIndex = stmts.length;
  stmts.push(
    env.DB.prepare(
      `UPDATE orders SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN (${PENDING_ORDER_STATUSES_SQL})
       ${walletDebit > 0 ? 'AND EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key = ? AND applied = 1)' : ''}`
    ).bind(...(walletDebit > 0 ? [id, debitKey] : [id]))
  );

  // پاداش‌ها فقط برای سفارش‌هایی که با این نسخه تایید شده‌اند (confirmed_at دارند)
  // و فقط برای مبلغ نقدی واقعاً پرداخت‌شده.
  const confirmedSql = "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'confirmed' AND confirmed_at IS NOT NULL)";
  const referrerId = await getReferrerOf(env, order.user_id);
  const commissionAmount = Math.round((netPaid * Number(commissionPercent || 0)) / 100);
  const rewardAmount = Math.trunc(Number(referralReward || 0));
  let commissionIndex = -1;
  let rewardIndex = -1;

  // کش‌بک فقط روی مبلغ نقدی (بخش پرداخت‌شده با کیف پول کش‌بک نمی‌گیرد)
  const cashbackAmount =
    order.product_id !== 'custom_bot' ? Math.round((netPaid * Number(cashbackPercent || 0)) / 100) : 0;
  let cashbackIndex = -1;
  if (cashbackAmount > 0) {
    cashbackIndex = stmts.length;
    stmts.push(
      ...walletTxStatements(env, {
        key: `order:${id}:cashback`,
        chatId: order.user_id,
        orderId: id,
        type: 'cashback',
        amount: cashbackAmount,
        note: `${Number(cashbackPercent)}%`,
        requireSql: confirmedSql,
        requireBinds: [id],
      })
    );
  }

  if (referrerId && /^\d+$/.test(referrerId) && order.product_id !== 'custom_bot' && netPaid > 0) {
    if (commissionAmount > 0) {
      commissionIndex = stmts.length;
      stmts.push(
        ...walletTxStatements(env, {
          key: `order:${id}:commission`,
          chatId: referrerId,
          orderId: id,
          type: 'referral_commission',
          amount: commissionAmount,
          requireSql: confirmedSql,
          requireBinds: [id],
        })
      );
    }
    if (rewardAmount > 0) {
      // کلید بر اساس کاربر دعوت‌شده است، پس فقط یک‌بار (اولین خرید واجد شرایط) پرداخت می‌شود
      rewardIndex = stmts.length;
      stmts.push(
        ...walletTxStatements(env, {
          key: `referral:${order.user_id}:reward`,
          chatId: referrerId,
          orderId: id,
          type: 'referral_reward',
          amount: rewardAmount,
          requireSql: confirmedSql,
          requireBinds: [id],
        })
      );
    }
  }

  const results = await env.DB.batch(stmts);
  const confirmedNow = results[confirmIndex].meta.changes === 1;
  const fresh = await getOrder(env, id);

  let reason = 'confirmed';
  if (!confirmedNow) {
    if (fresh.status === 'confirmed') reason = 'already_confirmed';
    else if (PENDING_ORDER_STATUSES_SQL.includes(`'${fresh.status}'`)) reason = 'insufficient_wallet';
    else reason = 'invalid_status';
  }

  return {
    ok: confirmedNow,
    reason,
    order: fresh,
    referrerId,
    cashback: { amount: cashbackAmount, appliedNow: cashbackIndex >= 0 && txAppliedNow(results, cashbackIndex) },
    commission: { amount: commissionAmount, appliedNow: commissionIndex >= 0 && txAppliedNow(results, commissionIndex) },
    referralReward: { amount: rewardAmount, appliedNow: rewardIndex >= 0 && txAppliedNow(results, rewardIndex) },
  };
}

// رد سفارش: فقط سفارش در انتظار رد می‌شود؛ هیچ مبلغی جابه‌جا نمی‌شود.
export async function rejectOrder(env, orderId) {
  const id = Number(orderId);
  const order = Number.isInteger(id) ? await getOrder(env, id) : null;
  if (!order) return { ok: false, reason: 'not_found', order: null };

  const result = await env.DB.prepare(
    `UPDATE orders SET status = 'rejected' WHERE id = ? AND status IN (${PENDING_ORDER_STATUSES_SQL})`
  ).bind(id).run();
  const fresh = await getOrder(env, id);
  if (result.meta.changes === 1) return { ok: true, reason: 'rejected', order: fresh };
  return { ok: false, reason: fresh.status === 'rejected' ? 'already_rejected' : 'invalid_status', order: fresh };
}

// خرید کامل با کیف پول. payKey باید برای هر کلیک یکتا باشد (مثلا شناسه callback)،
// تا ارسال دوباره‌ی همان درخواست سفارش/کسر دوم نسازد.
// خروجی: { ok, reason, order } با reason: 'paid' | 'duplicate' | 'insufficient_wallet' | 'invalid_price'
export async function payOrderWithWallet(env, { payKey, chatId, productId, productTitle, osType = '', price }) {
  const id = assertChatId(chatId);
  const amount = Math.trunc(Number(price));
  if (!(amount > 0)) return { ok: false, reason: 'invalid_price', order: null };

  await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (user_id, product_id, product_title, os_type, amount, wallet_used, status, idempotency_key)
     VALUES (?, ?, ?, ?, ?, ?, 'awaiting_wallet', ?)`
  ).bind(id, productId, productTitle, osType, amount, amount, payKey).run();

  let order = await env.DB.prepare('SELECT * FROM orders WHERE idempotency_key = ?').bind(payKey).first();
  if (order.status === 'paid_by_wallet') return { ok: true, reason: 'duplicate', order };
  if (order.status !== 'awaiting_wallet') return { ok: false, reason: 'insufficient_wallet', order };

  const debitKey = `order:${order.id}:debit`;
  const stmts = [
    ...walletTxStatements(env, {
      key: debitKey,
      chatId: id,
      orderId: order.id,
      type: 'order_debit',
      amount: -order.amount,
      requireSql: "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'awaiting_wallet')",
      requireBinds: [order.id],
    }),
    env.DB.prepare(
      `UPDATE orders SET status = 'paid_by_wallet'
       WHERE id = ? AND status = 'awaiting_wallet'
         AND EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key = ? AND applied = 1)`
    ).bind(order.id, debitKey),
    env.DB.prepare("UPDATE orders SET status = 'wallet_insufficient' WHERE id = ? AND status = 'awaiting_wallet'").bind(order.id),
  ];
  const results = await env.DB.batch(stmts);
  order = await getOrder(env, order.id);
  if (results[3].meta.changes === 1) return { ok: true, reason: 'paid', order };
  return { ok: false, reason: 'insufficient_wallet', order };
}

// ==========================================
// سفارش معلق: پیش‌فاکتور صادر شده، هنوز رسید یا پرداخت ثبت نشده (status = 'pending')
// ==========================================
//
// چرخه: pending ──رسید──> receipt_sent
//                ──کیف پول──> paid_by_wallet
//                ──۶۰ دقیقه / پیش‌فاکتور جدید──> cancelled
// هر انتقال یک UPDATE شرطی روی status = 'pending' است، پس در اجرای هم‌زمان فقط یکی موفق می‌شود.
// سفارش pending هیچ‌وقت ردیف مالی ندارد؛ لغو هم فقط وقتی انجام می‌شود که هیچ ردیف مالی‌ای نداشته باشد.

export const PENDING_REMINDER_MINUTES = 10;
export const PENDING_EXPIRE_MINUTES = 60;

// زمان به قالب CURRENT_TIMESTAMP در SQLite (UTC)
export function sqlTime(date = new Date()) {
  return new Date(date).toISOString().replace('T', ' ').slice(0, 19);
}

function minutesBefore(now, minutes) {
  return sqlTime(new Date(new Date(now).getTime() - minutes * 60000));
}

const NO_LEDGER_SQL = 'NOT EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.order_id = orders.id)';

// صدور/تازه‌سازی پیش‌فاکتور. هر کاربر حداکثر یک سفارش pending دارد (ایندکس یکتای جزئی):
// - پیش‌فاکتور دوباره برای همان محصول، همان سفارش را با مبلغ جدید به‌روز می‌کند (زمان شروع حفظ می‌شود)
// - پیش‌فاکتور برای محصول دیگر، سفارش قبلی را با دلیل superseded لغو می‌کند (بدون پیام، بدون پول)
export async function upsertPendingOrder(env, { chatId, productId, productTitle, osType = '', discountPercent = 0, amount, walletUsed, now = new Date() }) {
  const id = assertChatId(chatId);
  const nowSql = sqlTime(now);
  const expiredBefore = minutesBefore(now, PENDING_EXPIRE_MINUTES);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'superseded', checkout_step = NULL
       WHERE user_id = ? AND status = 'pending' AND (product_id <> ? OR os_type <> ? OR created_at <= ?) AND ${NO_LEDGER_SQL}`
    ).bind(nowSql, id, productId, osType, expiredBefore),
    env.DB.prepare(
      `INSERT OR IGNORE INTO orders (user_id, product_id, product_title, os_type, amount, wallet_used, status, discount_percent, checkout_step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'invoice', ?)`
    ).bind(id, productId, productTitle, osType, amount, walletUsed, discountPercent, nowSql),
    env.DB.prepare(
      `UPDATE orders SET amount = ?, wallet_used = ?, discount_percent = ?, product_title = ?, checkout_step = 'invoice'
       WHERE user_id = ? AND status = 'pending' AND product_id = ? AND os_type = ?`
    ).bind(amount, walletUsed, discountPercent, productTitle, id, productId, osType),
  ]);
  return env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'").bind(id).first();
}

export async function findPendingOrder(env, chatId, productId, osType = '') {
  return env.DB.prepare(
    "SELECT * FROM orders WHERE user_id = ? AND status = 'pending' AND product_id = ? AND os_type = ?"
  ).bind(String(chatId), productId, osType).first();
}

// تغییر مرحله‌ی جاری (invoice / awaiting_receipt) فقط برای سفارش pending خود کاربر
export async function setCheckoutStep(env, orderId, chatId, step) {
  const result = await env.DB.prepare(
    "UPDATE orders SET checkout_step = ? WHERE id = ? AND user_id = ? AND status = 'pending'"
  ).bind(step, Number(orderId), String(chatId)).run();
  return result.meta.changes === 1;
}

// به‌روزرسانی مبلغ ذخیره‌شده‌ی پیش‌فاکتور پس از بررسی مجدد قیمت/موجودی
export async function refreshPendingAmounts(env, orderId, amount, walletUsed) {
  await env.DB.prepare(
    "UPDATE orders SET amount = ?, wallet_used = ? WHERE id = ? AND status = 'pending'"
  ).bind(amount, walletUsed, Number(orderId)).run();
}

// «ادامه خرید»: فقط پیش از مهلت لغو. شرط زمانی دقیقاً مکمل شرط لغو خودکار است،
// پس در یک لحظه یا ادامه موفق می‌شود یا لغو، نه هر دو.
export async function resumePendingOrder(env, orderId, chatId, now = new Date()) {
  const id = Number(orderId);
  const result = await env.DB.prepare(
    `UPDATE orders SET resumed_at = ?
     WHERE id = ? AND user_id = ? AND status = 'pending' AND created_at > ? AND ${NO_LEDGER_SQL}`
  ).bind(sqlTime(now), id, String(chatId), minutesBefore(now, PENDING_EXPIRE_MINUTES)).run();
  return { ok: result.meta.changes === 1, order: await getOrder(env, id) };
}

// ثبت رسید برای سفارش pending (انتقال شرطی pending -> receipt_sent)
export async function submitReceiptForOrder(env, orderId, chatId, { amount, walletUsed }) {
  const id = Number(orderId);
  const result = await env.DB.prepare(
    `UPDATE orders SET status = 'receipt_sent', amount = ?, wallet_used = ?, checkout_step = NULL
     WHERE id = ? AND user_id = ? AND status = 'pending' AND ${NO_LEDGER_SQL}`
  ).bind(amount, walletUsed, id, String(chatId)).run();
  return { ok: result.meta.changes === 1, order: await getOrder(env, id) };
}

// پرداخت سفارش pending با کیف پول. قیمت توسط فراخواننده دوباره محاسبه شده است.
// خروجی reason: 'paid' | 'duplicate' | 'insufficient_wallet' | 'not_active' | 'invalid_price' | 'not_found'
export async function payPendingOrderWithWallet(env, orderId, chatId, price) {
  const id = Number(orderId);
  const userId = assertChatId(chatId);
  const amount = Math.trunc(Number(price));
  const order = await getOrder(env, id);
  if (!order || order.user_id !== userId) return { ok: false, reason: 'not_found', order: null };
  if (order.status === 'paid_by_wallet') return { ok: true, reason: 'duplicate', order };
  if (order.status !== 'pending') return { ok: false, reason: 'not_active', order };
  if (!(amount > 0)) return { ok: false, reason: 'invalid_price', order };

  const debitKey = `order:${id}:debit`;
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE orders SET amount = ? WHERE id = ? AND user_id = ? AND status = 'pending'").bind(amount, id, userId),
    ...walletTxStatements(env, {
      key: debitKey,
      chatId: userId,
      orderId: id,
      type: 'order_debit',
      amount: -amount,
      requireSql: "EXISTS (SELECT 1 FROM orders WHERE id = ? AND status = 'pending' AND amount = ?)",
      requireBinds: [id, amount],
    }),
    env.DB.prepare(
      `UPDATE orders SET status = 'paid_by_wallet', wallet_used = amount, checkout_step = NULL
       WHERE id = ? AND status = 'pending'
         AND EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key = ? AND applied = 1)`
    ).bind(id, debitKey),
  ]);

  const fresh = await getOrder(env, id);
  if (results[4].meta.changes === 1) return { ok: true, reason: 'paid', order: fresh };
  if (fresh.status === 'paid_by_wallet') return { ok: true, reason: 'duplicate', order: fresh };
  if (fresh.status === 'pending') return { ok: false, reason: 'insufficient_wallet', order: fresh };
  return { ok: false, reason: 'not_active', order: fresh };
}

// ---- زمان‌بندی (Cron): یادآوری و لغو ----
// ارسال پیام «حداکثر یک‌بار» است: ابتدا ارسال ثبت (claim) و بعد پیام فرستاده می‌شود.
// فقط اگر تلگرام صریحاً خطای موقت داد، claim آزاد می‌شود تا Cron بعدی دوباره تلاش کند.

export async function listDueReminders(env, now, maxAttempts, limit) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders
     WHERE status = 'pending' AND reminder_sent_at IS NULL AND COALESCE(reminder_attempts, 0) < ?
       AND created_at <= ? AND created_at > ?
     ORDER BY created_at LIMIT ?`
  ).bind(maxAttempts, minutesBefore(now, PENDING_REMINDER_MINUTES), minutesBefore(now, PENDING_EXPIRE_MINUTES), limit).all();
  return results || [];
}

export async function claimReminder(env, orderId, now, maxAttempts) {
  const result = await env.DB.prepare(
    `UPDATE orders SET reminder_sent_at = ?, reminder_attempts = COALESCE(reminder_attempts, 0) + 1
     WHERE id = ? AND status = 'pending' AND reminder_sent_at IS NULL AND COALESCE(reminder_attempts, 0) < ?
       AND created_at <= ? AND created_at > ?`
  ).bind(sqlTime(now), Number(orderId), maxAttempts, minutesBefore(now, PENDING_REMINDER_MINUTES), minutesBefore(now, PENDING_EXPIRE_MINUTES)).run();
  return result.meta.changes === 1;
}

export async function releaseReminder(env, orderId, error) {
  await env.DB.prepare(
    "UPDATE orders SET reminder_sent_at = NULL, notify_error = ? WHERE id = ? AND status = 'pending'"
  ).bind(String(error || ''), Number(orderId)).run();
}

export async function recordNotifyError(env, orderId, error) {
  await env.DB.prepare('UPDATE orders SET notify_error = ? WHERE id = ?').bind(String(error || ''), Number(orderId)).run();
}

export async function listExpiredPendingOrders(env, now, limit) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM orders WHERE status = 'pending' AND created_at <= ? ORDER BY created_at LIMIT ?"
  ).bind(minutesBefore(now, PENDING_EXPIRE_MINUTES), limit).all();
  return results || [];
}

// لغو شرطی: فقط اگر هنوز pending، بیش از یک ساعت گذشته، و هیچ عملیات مالی‌ای برایش ثبت نشده باشد
export async function cancelExpiredPendingOrder(env, orderId, now) {
  const result = await env.DB.prepare(
    `UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'timeout'
     WHERE id = ? AND status = 'pending' AND created_at <= ? AND ${NO_LEDGER_SQL}`
  ).bind(sqlTime(now), Number(orderId), minutesBefore(now, PENDING_EXPIRE_MINUTES)).run();
  return result.meta.changes === 1;
}

export async function listPendingCancelNotices(env, maxAttempts, limit) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM orders
     WHERE status = 'cancelled' AND cancel_reason = 'timeout' AND cancel_notice_sent_at IS NULL
       AND COALESCE(cancel_notice_attempts, 0) < ?
     ORDER BY cancelled_at LIMIT ?`
  ).bind(maxAttempts, limit).all();
  return results || [];
}

export async function claimCancelNotice(env, orderId, now, maxAttempts) {
  const result = await env.DB.prepare(
    `UPDATE orders SET cancel_notice_sent_at = ?, cancel_notice_attempts = COALESCE(cancel_notice_attempts, 0) + 1
     WHERE id = ? AND status = 'cancelled' AND cancel_reason = 'timeout' AND cancel_notice_sent_at IS NULL
       AND COALESCE(cancel_notice_attempts, 0) < ?`
  ).bind(sqlTime(now), Number(orderId), maxAttempts).run();
  return result.meta.changes === 1;
}

export async function releaseCancelNotice(env, orderId, error) {
  await env.DB.prepare(
    "UPDATE orders SET cancel_notice_sent_at = NULL, notify_error = ? WHERE id = ? AND status = 'cancelled'"
  ).bind(String(error || ''), Number(orderId)).run();
}

// ==========================================
// سشن (فرم‌های چند مرحله‌ای)
// ==========================================

export async function getSession(env, chatId) {
  const row = await env.DB.prepare('SELECT state, data FROM sessions WHERE chat_id = ?')
    .bind(String(chatId))
    .first();
  if (!row) return { state: null, data: {} };
  let data = {};
  try {
    data = JSON.parse(row.data || '{}');
  } catch (e) {
    data = {};
  }
  return { state: row.state, data };
}

export async function setSession(env, chatId, state, data = {}) {
  await env.DB.prepare(
    `INSERT INTO sessions (chat_id, state, data) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET state = excluded.state, data = excluded.data`
  )
    .bind(String(chatId), state, JSON.stringify(data))
    .run();
}

export async function clearSession(env, chatId) {
  await env.DB.prepare('DELETE FROM sessions WHERE chat_id = ?').bind(String(chatId)).run();
}
