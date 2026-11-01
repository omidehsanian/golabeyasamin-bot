// تست‌های چرخه‌ی سفارش معلق: یادآوری ۱۰ دقیقه‌ای، ادامه خرید، لغو ۶۰ دقیقه‌ای،
// هم‌زمانی با Cron، شکست ارسال پیام و سازگاری با دفتر مالی.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { setTestPrice } from './products_helper.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { processPendingOrders } from '../scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
const ADMIN = '999';

// ---- fetch mock با امکان شبیه‌سازی خطا ----
const calls = [];
let msgId = 1;
let failNext = []; // [{ match(method, body) => bool, respond: 'http500' | 'http403' | 'network' }]
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  const idx = failNext.findIndex((f) => f.match(method, body));
  if (idx >= 0) {
    const [f] = failNext.splice(idx, 1);
    calls.push({ method, body, failed: f.respond });
    if (f.respond === 'network') throw new Error('socket hang up');
    const code = f.respond === 'http403' ? 403 : 500;
    return { ok: false, json: async () => ({ ok: false, error_code: code, description: `simulated ${code}` }) };
  }
  calls.push({ method, body });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: msgId++ } }) };
};

function freshEnv() {
  const { prepare, batch, raw } = makeD1();
  raw.exec(SCHEMA);
  return {
    env: {
      DB: { prepare, batch },
      BOT_TOKEN: 'TEST',
      ADMIN_CHAT_ID: ADMIN,
      SUPPORT_CHAT_ID: '998',
      BOT_USERNAME: 'TestBot',
      CHANNEL_USERNAME: 'test_channel',
      CARD_NUMBER: '1111',
      CARD_HOLDER: 'Test',
      REFERRAL_REWARD: '10000',
      SIGNUP_BONUS: '20000',
      REFERRAL_COMMISSION_PERCENT: '10',
      DISCOUNT_ENABLED: 'false',
    },
    raw,
  };
}

async function makeUser(env, chatId, wallet = 0) {
  await db.ensureUser(env, chatId);
  await db.setChannelConfirmed(env, chatId);
  await db.saveRegistration(env, chatId, { phone_number: `0912${chatId}`, first_name: 'U' });
  if (wallet) await db.adminAdjustWallet(env, chatId, wallet, `test:seed:${chatId}`);
}

const cb = (fromId, data, id) => ({
  id: id || `cb-${Math.random()}`,
  data,
  from: { id: Number(fromId) },
  message: { chat: { id: Number(fromId) }, message_id: msgId++ },
});
const say = (env, chatId, extra) => handleMessage(env, { chat: { id: Number(chatId) }, from: { id: Number(chatId) }, message_id: msgId++, ...extra });

const sentTo = (chatId, filter = () => true) =>
  calls.filter((c) => c.method === 'sendMessage' && !c.failed && String(c.body.chat_id) === String(chatId) && filter(c));
const buttonsOf = (c) => (c.body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const reminders = (chatId) => sentTo(chatId, (c) => buttonsOf(c).some((d) => String(d).startsWith('resume:')));
const cancelNotices = (chatId) => sentTo(chatId, (c) => String(c.body.text).includes('لغو شد'));

async function openInvoice(env, chatId, productId = '1') {
  await handleCallbackQuery(env, cb(chatId, `os:${productId}:p1`));
  return env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'").bind(String(chatId)).first();
}
async function ageOrder(env, orderId, minutes) {
  await env.DB.prepare('UPDATE orders SET created_at = ? WHERE id = ?')
    .bind(db.sqlTime(new Date(Date.now() - minutes * 60000)), orderId)
    .run();
}
const order = (env, id) => db.getOrder(env, id);
const count = async (env, sql, ...a) => (await env.DB.prepare(sql).bind(...a).first()).c;
const cron = (env) => processPendingOrders(env, new Date());

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ----------------------------------------------------------------------------
test('پیش‌فاکتور یک سفارش pending متصل به دکمه‌ها می‌سازد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  assert.equal(o.status, 'pending');
  assert.equal(o.checkout_step, 'invoice');
  assert.equal(o.amount, 25000);
  const invoice = sentTo('111').at(-1);
  assert.deepEqual(buttonsOf(invoice), [`rcpt:${o.id}`]);

  // باز کردن دوباره‌ی همان پیش‌فاکتور سفارش دوم نمی‌سازد و زمان شروع را حفظ می‌کند
  await ageOrder(env, o.id, 5);
  const before = (await order(env, o.id)).created_at;
  await openInvoice(env, '111');
  assert.equal(await count(env, "SELECT COUNT(*) c FROM orders WHERE user_id = '111'"), 1);
  assert.equal((await order(env, o.id)).created_at, before);
});

test('محصول بدون قیمت سفارش pending نمی‌سازد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await handleCallbackQuery(env, cb('111', 'os:2:p1'));
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM orders'), 0);
});

test('یادآوری دقیقاً بعد از ۱۰ دقیقه و با دکمه «ادامه خرید» متصل به همان سفارش', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');

  await ageOrder(env, o.id, 9);
  await cron(env);
  assert.equal(reminders('111').length, 0, 'قبل از ۱۰ دقیقه یادآوری نرود');

  await ageOrder(env, o.id, 11);
  await cron(env);
  assert.equal(reminders('111').length, 1);
  assert.deepEqual(buttonsOf(reminders('111')[0]), [`resume:${o.id}`]);
  assert.ok((await order(env, o.id)).reminder_sent_at);
});

test('یادآوری تکراری ارسال نمی‌شود (اجرای چندباره و هم‌زمان Cron)', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 12);
  await Promise.all([cron(env), cron(env), cron(env)]);
  await cron(env);
  await ageOrder(env, o.id, 30);
  await cron(env);
  assert.equal(reminders('111').length, 1);
  assert.equal((await order(env, o.id)).reminder_attempts, 1);
});

test('ادامه خرید از مرحله پیش‌فاکتور، با قیمت و موجودی به‌روز', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 30000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 15);
  await cron(env);

  // در این فاصله قیمت تغییر کرده و موجودی کم شده
  await setTestPrice(env, 1, 40000);
  await db.adminAdjustWallet(env, '111', -20000, 'test:spend');

  calls.length = 0;
  await handleCallbackQuery(env, cb('111', `resume:${o.id}`));
  const invoice = sentTo('111').at(-1);
  assert.ok(invoice.body.text.includes('۴۰٬۰۰۰'), 'قیمت جدید نمایش داده شود');
  assert.deepEqual(buttonsOf(invoice), [`rcpt:${o.id}`], 'موجودی ۱۰٬۰۰۰ کافی نیست → دکمه کیف پول نیست');
  const fresh = await order(env, o.id);
  assert.equal(fresh.amount, 40000);
  assert.equal(fresh.wallet_used, 10000);
  assert.ok(fresh.resumed_at);
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM orders'), 1, 'سفارش جدید ساخته نشود');
});

test('ادامه خرید از مرحله «ارسال رسید» و ثبت رسید روی همان سفارش', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await handleCallbackQuery(env, cb('111', `rcpt:${o.id}`));
  assert.equal((await order(env, o.id)).checkout_step, 'awaiting_receipt');

  await db.clearSession(env, '111'); // مثلاً کاربر /start زده یا session از دست رفته
  await ageOrder(env, o.id, 20);
  await handleCallbackQuery(env, cb('111', `resume:${o.id}`));
  const s = await db.getSession(env, '111');
  assert.equal(s.state, 'awaiting_receipt');
  assert.equal(s.data.orderId, o.id);

  await say(env, '111', { photo: [{ file_id: 'r' }] });
  const fresh = await order(env, o.id);
  assert.equal(fresh.status, 'receipt_sent');
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM orders'), 1, 'همان سفارش، نه سفارش جدید');
  assert.ok(sentTo(ADMIN).some((c) => buttonsOf(c).includes(`confirm_order:${o.id}`)), 'ادمین دکمه تایید همان سفارش را بگیرد');
});

test('ادامه خرید بعد از مهلت یک ساعته رد می‌شود، حتی اگر Cron هنوز اجرا نشده باشد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 61);
  calls.length = 0;
  await handleCallbackQuery(env, cb('111', `resume:${o.id}`));
  const fresh = await order(env, o.id);
  assert.equal(fresh.resumed_at, null);
  assert.equal(sentTo('111', (c) => String(c.body.text).includes('پیش‌فاکتور')).length, 0);
  const alert = calls.find((c) => c.method === 'answerCallbackQuery');
  assert.match(alert.body.text, /مهلت/);
});

test('کاربر دیگر نمی‌تواند سفارش را ادامه دهد یا پرداخت کند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await makeUser(env, '222', 100000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await handleCallbackQuery(env, cb('222', `resume:${o.id}`));
  await handleCallbackQuery(env, cb('222', `wpay:${o.id}`));
  await handleCallbackQuery(env, cb('222', `rcpt:${o.id}`));
  const fresh = await order(env, o.id);
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.resumed_at, null);
  assert.equal(await db.getWallet(env, '222'), 100000);
  assert.equal((await db.getSession(env, '222')).state, null);
});

test('لغو سفارش معلق بعد از یک ساعت و اطلاع یک‌باره به کاربر', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 5000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 59);
  await cron(env);
  assert.equal((await order(env, o.id)).status, 'pending', 'قبل از یک ساعت لغو نشود');

  await ageOrder(env, o.id, 61);
  await Promise.all([cron(env), cron(env)]);
  await cron(env);
  const fresh = await order(env, o.id);
  assert.equal(fresh.status, 'cancelled');
  assert.equal(fresh.cancel_reason, 'timeout');
  assert.equal(cancelNotices('111').length, 1);
  assert.equal(reminders('111').length, 1, 'فقط همان یادآوری دقیقه‌ی ۵۹؛ بعد از لغو یادآوری دیگری نرود');
  assert.equal(await db.getWallet(env, '111'), 5000);
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ?', o.id), 0);

  // دکمه‌های قدیمی بعد از لغو کار نمی‌کنند
  await handleCallbackQuery(env, cb('111', `resume:${o.id}`));
  await handleCallbackQuery(env, cb('111', `rcpt:${o.id}`));
  assert.equal((await order(env, o.id)).status, 'cancelled');
});

test('سفارشی که بدون یادآوری از یک ساعت گذشته: فقط لغو، بدون یادآوری', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 90);
  await cron(env);
  await cron(env);
  assert.equal((await order(env, o.id)).status, 'cancelled');
  assert.equal(reminders('111').length, 0);
  assert.equal(cancelNotices('111').length, 1);
});

test('سفارش‌های پرداخت‌شده، تاییدشده، در حال بررسی و قدیمی لغو نمی‌شوند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 100000);
  const old = { amount: 380000, walletUsed: 20000 };
  const ids = {
    receipt_sent: await db.saveOrder(env, '111', 'capcut', 'CapCut', { ...old, status: 'receipt_sent' }),
    new: await db.saveOrder(env, '111', 'custom_bot', 'ربات', { status: 'new' }),
    confirmed: await db.saveOrder(env, '111', 'capcut', 'CapCut', { ...old, status: 'confirmed' }),
    paid_by_wallet: await db.saveOrder(env, '111', 'capcut', 'CapCut', { ...old, status: 'paid_by_wallet' }),
    awaiting_wallet: await db.saveOrder(env, '111', 'capcut', 'CapCut', { ...old, status: 'awaiting_wallet' }),
    link_sent: await db.saveOrder(env, '111', 'capcut', 'CapCut', { status: 'link_sent' }),
  };
  for (const id of Object.values(ids)) await ageOrder(env, id, 60 * 24 * 30);

  // سفارش pending که (به هر دلیل) ردیف مالی دارد نیز لغو نمی‌شود
  await setTestPrice(env, 1, 25000);
  const p = await openInvoice(env, '111');
  await env.DB.prepare(
    "INSERT INTO wallet_transactions (idempotency_key, chat_id, order_id, type, amount, applied) VALUES ('probe', '111', ?, 'probe', 0, 1)"
  ).bind(p.id).run();
  await ageOrder(env, p.id, 120);

  await cron(env);
  for (const [status, id] of Object.entries(ids)) assert.equal((await order(env, id)).status, status, `${status} نباید تغییر کند`);
  assert.equal((await order(env, p.id)).status, 'pending', 'pending دارای ردیف مالی لغو نشود');
  assert.equal(sentTo('111').filter((c) => c.body.text.includes('لغو شد') || c.body.text.includes('تکمیل نشده')).length, 0);
});

test('ادمین نمی‌تواند پیش‌فاکتور پرداخت‌نشده (pending) را تایید کند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o.id}`));
  await handleCallbackQuery(env, cb(ADMIN, `reject_order:${o.id}`));
  assert.equal((await order(env, o.id)).status, 'pending');
});

test('کلیک هم‌زمان «ادامه خرید» و اجرای Cron: دقیقاً یک انتقال موفق', async () => {
  // حالت ۱: مهلت تمام شده → فقط لغو
  {
    const { env } = freshEnv();
    await makeUser(env, '111');
    await setTestPrice(env, 1, 25000);
    const o = await openInvoice(env, '111');
    await ageOrder(env, o.id, 60.5);
    calls.length = 0;
    await Promise.all([handleCallbackQuery(env, cb('111', `resume:${o.id}`)), cron(env)]);
    const fresh = await order(env, o.id);
    assert.equal(fresh.status, 'cancelled');
    assert.equal(fresh.resumed_at, null, 'ادامه خرید نباید موفق شود');
    assert.equal(sentTo('111', (c) => String(c.body.text).includes('پیش‌فاکتور')).length, 0, 'پیش‌فاکتور دوباره ارسال نشود');
  }
  // حالت ۲: هنوز در مهلت → فقط ادامه
  {
    const { env } = freshEnv();
    await makeUser(env, '111');
    await setTestPrice(env, 1, 25000);
    const o = await openInvoice(env, '111');
    await ageOrder(env, o.id, 59);
    await Promise.all([handleCallbackQuery(env, cb('111', `resume:${o.id}`)), cron(env)]);
    const fresh = await order(env, o.id);
    assert.equal(fresh.status, 'pending');
    assert.ok(fresh.resumed_at);
  }
});

test('پرداخت هم‌زمان با کیف پول و لغو Cron در لحظه‌ی انقضا: فقط یکی، بدون کسر اضافه', async () => {
  for (let i = 0; i < 5; i++) {
    const { env } = freshEnv();
    await makeUser(env, '111', 25000);
    await setTestPrice(env, 1, 25000);
    const o = await openInvoice(env, '111');
    await ageOrder(env, o.id, 61);
    await Promise.all([handleCallbackQuery(env, cb('111', `wpay:${o.id}`)), cron(env)]);
    const fresh = await order(env, o.id);
    const debits = await count(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ? AND type = 'order_debit'", o.id);
    const wallet = await db.getWallet(env, '111');
    if (fresh.status === 'paid_by_wallet') {
      assert.equal(debits, 1);
      assert.equal(wallet, 0);
    } else {
      assert.equal(fresh.status, 'cancelled');
      assert.equal(debits, 0);
      assert.equal(wallet, 25000);
    }
  }
});

test('شکست موقت ارسال یادآوری: تلاش مجدد بدون پیام تکراری و بدون عملیات مالی', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 7000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 11);
  const ledgerBefore = await count(env, 'SELECT COUNT(*) c FROM wallet_transactions');

  failNext.push({ match: (m, b) => m === 'sendMessage' && String(b.chat_id) === '111', respond: 'http500' });
  await cron(env);
  let fresh = await order(env, o.id);
  assert.equal(fresh.reminder_sent_at, null, 'بعد از خطای موقت، آزاد شود تا دوباره تلاش شود');
  assert.equal(fresh.reminder_attempts, 1);
  assert.match(fresh.notify_error, /500/);

  await cron(env);
  await cron(env);
  fresh = await order(env, o.id);
  assert.equal(reminders('111').length, 1, 'دقیقاً یک یادآوری موفق');
  assert.equal(fresh.reminder_attempts, 2);
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM wallet_transactions'), ledgerBefore);
  assert.equal(await db.getWallet(env, '111'), 7000);
});

test('خطای دائمی (403) یا نامعلوم (شبکه): بدون تلاش مجدد، برای جلوگیری از پیام تکراری', async () => {
  for (const respond of ['http403', 'network']) {
    const { env } = freshEnv();
    await makeUser(env, '111');
    await setTestPrice(env, 1, 25000);
    const o = await openInvoice(env, '111');
    await ageOrder(env, o.id, 11);
    failNext.push({ match: (m, b) => m === 'sendMessage' && String(b.chat_id) === '111', respond });
    calls.length = 0;
    await cron(env);
    await cron(env);
    const fresh = await order(env, o.id);
    assert.ok(fresh.reminder_sent_at, `${respond}: علامت ارسال باقی بماند`);
    assert.equal(fresh.reminder_attempts, 1);
    assert.ok(fresh.notify_error);
    assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 1, `${respond}: فقط یک تلاش`);
  }
});

test('شکست موقت پیام لغو: لغو یک‌بار، پیام در Cron بعدی، بدون تغییر موجودی', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 9000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await ageOrder(env, o.id, 70);
  failNext.push({ match: (m, b) => m === 'sendMessage' && String(b.chat_id) === '111', respond: 'http500' });
  await cron(env);
  assert.equal((await order(env, o.id)).status, 'cancelled');
  assert.equal(cancelNotices('111').length, 0);
  await cron(env);
  await cron(env);
  assert.equal(cancelNotices('111').length, 1);
  assert.equal((await order(env, o.id)).cancel_notice_attempts, 2);
  assert.equal(await db.getWallet(env, '111'), 9000);
});

test('رسید بعد از لغو خودکار گم نمی‌شود: سفارش جدید برای بررسی ادمین', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await handleCallbackQuery(env, cb('111', `rcpt:${o.id}`));
  await ageOrder(env, o.id, 61);
  await cron(env);
  assert.equal((await order(env, o.id)).status, 'cancelled');
  assert.ok(cancelNotices('111')[0].body.text.includes('تصویر رسید'), 'پیام لغو به ارسال رسید اشاره کند');

  await say(env, '111', { photo: [{ file_id: 'late' }] });
  const late = await env.DB.prepare("SELECT * FROM orders WHERE status = 'receipt_sent'").first();
  assert.ok(late, 'سفارش جدید ساخته شود');
  assert.match(late.note, new RegExp(`1000${o.id}`));
  assert.equal((await order(env, o.id)).status, 'cancelled', 'سفارش لغوشده دوباره زنده نشود');
});

test('پیش‌فاکتور محصول دیگر، پیش‌فاکتور قبلی را بدون پیام کنار می‌گذارد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  await setTestPrice(env, 3, 90000);
  const a = await openInvoice(env, '111', '1');
  const b = await openInvoice(env, '111', '3');
  assert.notEqual(a.id, b.id);
  assert.equal((await order(env, a.id)).status, 'cancelled');
  assert.equal((await order(env, a.id)).cancel_reason, 'superseded');
  await cron(env);
  assert.equal(cancelNotices('111').length, 0, 'برای superseded پیام لغو نرود');
  assert.equal(await count(env, "SELECT COUNT(*) c FROM orders WHERE status = 'pending'"), 1);
});

test('سازگاری با کیف پول: دو پرداخت هم‌زمان یک سفارش pending فقط یک کسر', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 60000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await Promise.all([
    handleCallbackQuery(env, cb('111', `wpay:${o.id}`)),
    handleCallbackQuery(env, cb('111', `wpay:${o.id}`)),
    handleCallbackQuery(env, cb('111', `walletpay:1:`)), // دکمه‌ی پیش‌فاکتور قدیمی
  ]);
  assert.equal((await order(env, o.id)).status, 'paid_by_wallet');
  assert.equal(await db.getWallet(env, '111'), 35000);
  assert.equal(await count(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE type = 'order_debit'"), 1);
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM orders'), 1);

  await ageOrder(env, o.id, 120);
  await cron(env);
  assert.equal((await order(env, o.id)).status, 'paid_by_wallet', 'Cron سفارش پرداخت‌شده را لغو نکند');
});

test('سازگاری با کیف پول: موجودی ناکافی → سفارش pending می‌ماند و بعد بدون اثر مالی لغو می‌شود', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 10000);
  await setTestPrice(env, 1, 25000);
  const o = await openInvoice(env, '111');
  await handleCallbackQuery(env, cb('111', `wpay:${o.id}`));
  assert.equal((await order(env, o.id)).status, 'pending');
  await ageOrder(env, o.id, 61);
  await cron(env);
  assert.equal((await order(env, o.id)).status, 'cancelled');
  assert.equal(await db.getWallet(env, '111'), 10000);
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM users WHERE wallet < 0'), 0);
  assert.equal(await count(env, 'SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ?', o.id), 0);
});

test('مسیر کد تخفیف: درصد تخفیف روی سفارش ذخیره و در ادامه خرید حفظ می‌شود', async () => {
  const { env } = freshEnv();
  env.DISCOUNT_CODES = 'GIRL:10';
  env.DISCOUNT_ENABLED = 'true';
  await makeUser(env, '111');
  await setTestPrice(env, 1, 50000);
  await handleCallbackQuery(env, cb('111', 'discount_yes:1:'));
  await say(env, '111', { text: 'girl' });
  const o = await env.DB.prepare("SELECT * FROM orders WHERE status = 'pending'").first();
  assert.equal(o.discount_percent, 10);
  assert.equal(o.amount, 45000);
  await ageOrder(env, o.id, 15);
  calls.length = 0;
  await handleCallbackQuery(env, cb('111', `resume:${o.id}`));
  assert.ok(sentTo('111').at(-1).body.text.includes('۴۵٬۰۰۰'));
});

// ----------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  calls.length = 0;
  failNext = [];
  try {
    await t.fn();
    console.log('✅', t.name);
  } catch (e) {
    failed++;
    console.error('❌', t.name, '\n  ', e.message);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} pending-order tests passed`);
if (failed) process.exit(1);
console.log('ALL PENDING-ORDER TESTS PASSED ✅');
