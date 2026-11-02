// تست‌های سبد خرید، پروفایل آدرس و پیگیری آدرس بعد از پرداخت
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
import { sendLastOrders, sendOrdersReport } from '../admin_orders.js';
import { getCart, getOrderItems } from '../cart.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
const ADMIN = '999';
const ADDRESS = 'تهران، خیابان آزادی، کوچه ۵، پلاک ۱۲';
const POSTAL = '1234567890';
// ۱۱:۳۰ به وقت تهران
const NOON = new Date('2026-11-02T08:00:00Z');

const calls = [];
let msgId = 1;
let failFor = null;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  calls.push({ method, body });
  if (failFor && String(body.chat_id) === failFor) {
    return { ok: false, json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) };
  }
  return { ok: true, json: async () => ({ ok: true, result: { message_id: msgId++ } }) };
};

function freshEnv(extra = {}) {
  const { prepare, batch, raw } = makeD1();
  raw.exec(SCHEMA);
  return {
    DB: { prepare, batch },
    BOT_TOKEN: 'TEST',
    ADMIN_CHAT_ID: ADMIN,
    CHANNEL_ENABLED: 'false',
    CARD_NUMBER: '1111',
    CARD_HOLDER: 'Test',
    DISCOUNT_ENABLED: 'false',
    POST_FEE: '100000',
    ...extra,
  };
}

async function shop(env, chatId = '111', wallet = 0) {
  await db.ensureUser(env, chatId);
  await db.saveRegistration(env, chatId, { phone_number: `0912${chatId}`, first_name: 'U' });
  if (wallet) await db.adminAdjustWallet(env, chatId, wallet, `test:seed:${chatId}`);
  await setTestPrice(env, 1, 350000);
  await setTestPrice(env, 2, 150000);
}

const cb = (fromId, data) => ({
  id: `cb-${Math.random()}`,
  data,
  from: { id: Number(fromId) },
  message: { chat: { id: Number(fromId) }, message_id: msgId++ },
});
const click = (env, data, chatId = '111') => handleCallbackQuery(env, cb(chatId, data));
const say = (env, extra, chatId = '111') => handleMessage(env, { chat: { id: Number(chatId) }, from: { id: Number(chatId) }, message_id: msgId++, ...extra });
const messagesTo = (chatId) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId));
const lastMessage = (chatId) => messagesTo(chatId).pop();
const buttonsOf = (c) => (c?.body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const pendingOrder = (env, chatId = '111') => env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'").bind(chatId).first();

// دو عدد از محصول ۱ و یک عدد از محصول ۲ با روش تحویل داده‌شده تا پیش‌فاکتور
async function checkout(env, delivery, chatId = '111') {
  await click(env, 'buy:1', chatId);
  await click(env, 'pq:inc:1', chatId);
  await click(env, 'buy:2', chatId);
  await click(env, 'cart:checkout', chatId);
  await click(env, `cart:ship:${delivery}`, chatId);
  return pendingOrder(env, chatId);
}

async function payByReceipt(env, order, chatId = '111') {
  await click(env, `rcpt:${order.id}`, chatId);
  await say(env, { photo: [{ file_id: 'R' }] }, chatId);
  return db.getOrder(env, order.id);
}

async function fillProfile(env, chatId = '111') {
  await db.saveProfileAddress(env, chatId, ADDRESS);
  await db.saveProfilePostal(env, chatId, POSTAL);
}

const setRequestedAt = (env, id, minutesAgo) =>
  env.DB.prepare('UPDATE orders SET address_requested_at = ? WHERE id = ?')
    .bind(db.sqlTime(new Date(NOON.getTime() - minutesAgo * 60000)), id)
    .run();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('افزودن چند محصول و تغییر تعداد در سبد', async () => {
  const env = freshEnv();
  await shop(env);

  await click(env, 'buy:1');
  const edit = calls.filter((c) => c.method === 'editMessageReplyMarkup').pop();
  assert.deepEqual(edit.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ['pq:dec:1', 'cart:noop', 'pq:inc:1']);

  await click(env, 'pq:inc:1');
  await click(env, 'buy:2');
  assert.deepEqual((await getCart(env, '111')).map((i) => [i.productId, i.quantity]), [['1', 2], ['2', 1]]);

  await say(env, { text: '🛒 سبد خرید' });
  const page = lastMessage('111');
  assert.match(page.body.text, /جمع کالاها: <b>۸۵۰٬۰۰۰ تومان/);
  assert.ok(buttonsOf(page).includes('cart:checkout'));

  await click(env, 'cart:dec:2');
  assert.deepEqual((await getCart(env, '111')).map((i) => i.productId), ['1'], 'تعداد صفر یعنی حذف');
  const edited = calls.filter((c) => c.method === 'editMessageText').pop();
  assert.match(edited.body.text, /۷۰۰٬۰۰۰/);

  await click(env, 'cart:clear');
  assert.equal((await getCart(env, '111')).length, 0);
  assert.match(calls.filter((c) => c.method === 'editMessageText').pop().body.text, /خالی است/);
});

test('سقف تعداد هر محصول و حذف‌شدن محصول ناموجود از سبد', async () => {
  const env = freshEnv();
  await shop(env);
  for (let i = 0; i < 22; i++) await click(env, 'pq:inc:1');
  assert.equal((await getCart(env, '111'))[0].quantity, 20);
  await env.DB.prepare('DELETE FROM products WHERE id = 1').run();
  assert.equal((await getCart(env, '111')).length, 0);
  await click(env, 'cart:checkout');
  assert.match(lastMessage('111').body.text, /خالی است/);
});

test('کاربر ثبت‌نام‌نشده سبد دارد ولی برای ثبت سفارش باید ثبت‌نام کند', async () => {
  const env = freshEnv();
  await shop(env, '222');
  await db.ensureUser(env, '111');
  await click(env, 'buy:1');
  await click(env, 'cart:checkout');
  assert.match(lastMessage('111').body.text, /ثبت‌نام/);
  assert.equal((await getCart(env, '111')).length, 1);
});

test('پیش‌فاکتور سبد: چند قلم، هزینه‌ی پست و ثبت اقلام', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 's');
  assert.equal(order.product_id, 'cart');
  assert.equal(order.os_type, 's');
  assert.equal(order.amount, 950000);
  assert.equal(order.product_title, 'محصول 1 ×۲، محصول 2 ×۱');
  const text = lastMessage('111').body.text;
  assert.match(text, /محصول 1: ۲ × ۳۵۰٬۰۰۰/);
  assert.match(text, /هزینه ارسال با پست: ۱۰۰٬۰۰۰/);
  assert.deepEqual((await getOrderItems(env, order.id)).map((i) => [i.productId, i.unitPrice, i.quantity]), [['1', 350000, 2], ['2', 150000, 1]]);
});

test('تغییر سبد و پیش‌فاکتور دوباره، همان سفارش را با اقلام جدید به‌روز می‌کند', async () => {
  const env = freshEnv();
  await shop(env);
  const first = await checkout(env, 'p');
  assert.equal(first.amount, 850000);
  await click(env, 'cart:dec:2');
  await click(env, 'cart:ship:p');
  const second = await pendingOrder(env);
  assert.equal(second.id, first.id);
  assert.equal(second.amount, 700000);
  assert.equal((await getOrderItems(env, first.id)).length, 1);
});

test('تحویل حضوری: بعد از پرداخت چیزی پرسیده نمی‌شود و سبد خالی می‌شود', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 'p');
  assert.equal((await getCart(env, '111')).length, 2, 'سبد تا قبل از پرداخت می‌ماند');

  const paid = await payByReceipt(env, order);
  assert.equal(paid.status, 'receipt_sent');
  assert.equal(paid.amount, 850000);
  assert.equal(paid.address_requested_at, null);
  assert.equal((await db.getSession(env, '111')).state, null);
  assert.equal((await getCart(env, '111')).length, 0);
  assert.match(lastMessage('111').body.text, /رسید شما ارسال شد/);

  await click(env, `confirm_order:${order.id}`, ADMIN);
  assert.match(lastMessage('111').body.text, /تحویل حضوری/);
});

test('پیک با پروفایل کامل: آدرس خودکار روی سفارش می‌آید و درخواستی نمی‌رود', async () => {
  const env = freshEnv();
  await shop(env);
  await fillProfile(env);
  const order = await checkout(env, 'c');

  const paid = await payByReceipt(env, order);
  assert.equal(paid.ship_address, ADDRESS);
  assert.equal(paid.ship_postal, POSTAL);
  assert.ok(paid.address_done_at);
  assert.equal((await db.getSession(env, '111')).state, null);
  assert.deepEqual(buttonsOf(lastMessage('111')), ['addr:edit']);
  const adminMsg = messagesTo(ADMIN).pop().body.text;
  assert.match(adminMsg, /خیابان آزادی/);
  assert.match(adminMsg, /1234567890/);
  assert.doesNotMatch(adminMsg, /منتظر/);
});

test('پست با پروفایل خالی: همان لحظه آدرس و کد پستی گرفته و به ادمین خبر داده می‌شود', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 's');

  const paid = await payByReceipt(env, order);
  assert.ok(paid.address_requested_at);
  assert.equal(paid.address_done_at, null);
  assert.match(messagesTo(ADMIN).pop().body.text, /منتظر آدرس مشتری/);
  assert.equal((await db.getSession(env, '111')).state, 'profile_address');
  assert.match(lastMessage('111').body.text, /آخرین قدم/);

  await say(env, { text: 'کوتاه' });
  assert.equal((await db.getSession(env, '111')).state, 'profile_address', 'آدرس کوتاه پذیرفته نمی‌شود');

  await say(env, { text: ADDRESS });
  assert.equal((await db.getSession(env, '111')).state, 'profile_postal');
  assert.equal((await db.getOrder(env, order.id)).ship_address, ADDRESS, 'آدرس تا همین‌جا به ادمین می‌رسد');

  await say(env, { text: '12345' });
  assert.equal((await db.getSession(env, '111')).state, 'profile_postal', 'کد پستی کوتاه پذیرفته نمی‌شود');

  await say(env, { text: '۱۲۳۴۵-۶۷۸۹۰' });
  const done = await db.getOrder(env, order.id);
  assert.equal(done.ship_postal, POSTAL, 'اعداد فارسی و خط تیره پذیرفته می‌شوند');
  assert.ok(done.address_done_at);
  assert.equal((await db.getSession(env, '111')).state, null);
  assert.match(lastMessage('111').body.text, /ذخیره شد/);
  assert.match(messagesTo(ADMIN).pop().body.text, /آدرس سفارش/);
  assert.equal((await db.getAddressProfile(env, '111')).complete, true);
});

test('دکمه‌ی «کد پستی را نمی‌دانم» سفارش را کامل می‌کند', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 'c');
  await payByReceipt(env, order);
  await say(env, { text: ADDRESS });
  await click(env, 'addr:skip_postal');
  const done = await db.getOrder(env, order.id);
  assert.ok(done.address_done_at);
  assert.equal(done.ship_postal, '');
  assert.match(messagesTo(ADMIN).pop().body.text, /مشتری نمی‌داند/);
});

test('آدرس قدیمی بدون کد پستی: فقط کد پستی پرسیده می‌شود', async () => {
  const env = freshEnv();
  await shop(env);
  await db.saveProfileAddress(env, '111', ADDRESS);
  const order = await checkout(env, 'c');
  const paid = await payByReceipt(env, order);
  assert.equal(paid.ship_address, ADDRESS);
  assert.equal(paid.address_done_at, null);
  assert.equal((await db.getSession(env, '111')).state, 'profile_postal');
  await say(env, { text: POSTAL });
  assert.ok((await db.getOrder(env, order.id)).address_done_at);
});

test('پرداخت کامل با کیف پول هم آدرس را می‌گیرد و سبد را خالی می‌کند', async () => {
  const env = freshEnv();
  await shop(env, '111', 2000000);
  const order = await checkout(env, 's');
  await click(env, `wpay:${order.id}`);
  const paid = await db.getOrder(env, order.id);
  assert.equal(paid.status, 'paid_by_wallet');
  assert.equal(await db.getWallet(env, '111'), 1050000);
  assert.ok(paid.address_requested_at);
  assert.equal((await db.getSession(env, '111')).state, 'profile_address');
  assert.equal((await getCart(env, '111')).length, 0);
});

test('کد تخفیف روی سبد فقط به کالا می‌خورد', async () => {
  const env = freshEnv({ DISCOUNT_ENABLED: 'true', DISCOUNT_CODES: 'OFF10:10' });
  await shop(env);
  await click(env, 'buy:1');
  await click(env, 'cart:ship:s');
  assert.deepEqual(buttonsOf(lastMessage('111')), ['discount_yes:cart:s', 'discount_no:cart:s']);
  await click(env, 'discount_yes:cart:s');
  await say(env, { text: 'OFF10' });
  const order = await pendingOrder(env);
  assert.equal(order.amount, 415000);
  assert.equal(order.discount_percent, 10);
});

test('رسید بعد از لغو خودکار: اقلام و آدرس از دست نمی‌رود', async () => {
  const env = freshEnv();
  await shop(env);
  await fillProfile(env);
  const order = await checkout(env, 'c');
  await click(env, `rcpt:${order.id}`);
  await env.DB.prepare("UPDATE orders SET status = 'cancelled' WHERE id = ?").bind(order.id).run();
  await say(env, { photo: [{ file_id: 'R' }] });

  const fresh = await env.DB.prepare("SELECT * FROM orders WHERE status = 'receipt_sent'").first();
  assert.notEqual(fresh.id, order.id);
  assert.equal(fresh.amount, order.amount);
  assert.equal(fresh.os_type, 'c');
  assert.equal(fresh.ship_address, ADDRESS);
  assert.equal((await getOrderItems(env, fresh.id)).length, 2);
});

test('پیگیری آدرس: ۱ ساعت و ۲۴ ساعت یادآوری، ۴۸ ساعت تماس ادمین', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 'c');
  await payByReceipt(env, order);
  await db.clearSession(env, '111');

  await setRequestedAt(env, order.id, 30);
  assert.equal((await processPendingOrders(env, NOON)).addressReminders, 0, 'قبل از ۱ ساعت');

  await setRequestedAt(env, order.id, 61);
  assert.equal((await processPendingOrders(env, NOON)).addressReminders, 1);
  assert.deepEqual(buttonsOf(lastMessage('111')), ['addr:fill']);
  assert.equal((await processPendingOrders(env, NOON)).addressReminders, 0, 'یادآوری تکراری نمی‌رود');

  await setRequestedAt(env, order.id, 24 * 60 + 1);
  assert.equal((await processPendingOrders(env, NOON)).addressReminders, 1);

  await setRequestedAt(env, order.id, 48 * 60 + 1);
  assert.equal((await processPendingOrders(env, NOON)).addressAlerts, 1);
  const alert = messagesTo(ADMIN).pop().body.text;
  assert.match(alert, /تماس بگیرید/);
  assert.match(alert, /0912111/);
  const again = await processPendingOrders(env, NOON);
  assert.equal(again.addressAlerts + again.addressReminders, 0, 'هشدار تکراری نمی‌رود');
});

test('پیگیری آدرس: ساعت خواب پیام نمی‌رود', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 'c');
  await payByReceipt(env, order);
  await setRequestedAt(env, order.id, 120);
  // ۰۳:۳۰ به وقت تهران
  const night = new Date('2026-11-02T00:00:00Z');
  await env.DB.prepare('UPDATE orders SET address_requested_at = ? WHERE id = ?').bind(db.sqlTime(new Date(night.getTime() - 120 * 60000)), order.id).run();
  assert.equal((await processPendingOrders(env, night)).addressReminders, 0);
});

test('پیگیری آدرس: مشتری ربات را بلاک کرده باشد ادمین همان موقع خبردار می‌شود', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 'c');
  await payByReceipt(env, order);
  await setRequestedAt(env, order.id, 61);
  failFor = '111';
  try {
    const summary = await processPendingOrders(env, NOON);
    assert.equal(summary.addressAlerts, 1);
  } finally {
    failFor = null;
  }
  assert.match(messagesTo(ADMIN).pop().body.text, /بلاک/);
});

test('ثبت آدرس یا رد سفارش، پیگیری را متوقف می‌کند', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 'c');
  await payByReceipt(env, order);
  await setRequestedAt(env, order.id, 61);
  await click(env, `reject_order:${order.id}`, ADMIN);
  assert.equal((await processPendingOrders(env, NOON)).addressReminders, 0, 'رد شده');

  const env2 = freshEnv();
  await shop(env2);
  const order2 = await checkout(env2, 'c');
  await payByReceipt(env2, order2);
  await say(env2, { text: ADDRESS });
  await say(env2, { text: POSTAL });
  await setRequestedAt(env2, order2.id, 61);
  assert.equal((await processPendingOrders(env2, NOON)).addressReminders, 0, 'آدرس ثبت شده');
});

test('تایید سفارش بدون آدرس: دوباره درخواست آدرس می‌رود', async () => {
  const env = freshEnv();
  await shop(env);
  const order = await checkout(env, 's');
  await payByReceipt(env, order);
  await click(env, `confirm_order:${order.id}`, ADMIN);
  assert.equal((await db.getOrder(env, order.id)).status, 'confirmed');
  assert.deepEqual(buttonsOf(lastMessage('111')), ['addr:fill']);
});

test('دکمه‌ی مشخصات آدرس: ثبت، نمایش و ویرایش', async () => {
  const env = freshEnv();
  await shop(env);
  await say(env, { text: '📍 مشخصات آدرس' });
  assert.deepEqual(buttonsOf(lastMessage('111')), ['addr:edit']);
  await click(env, 'addr:edit');
  await say(env, { text: ADDRESS });
  await say(env, { text: POSTAL });

  await say(env, { text: '📍 مشخصات آدرس' });
  assert.match(lastMessage('111').body.text, /خیابان آزادی/);
  assert.match(lastMessage('111').body.text, /1234567890/);

  // زدن دکمه‌ی منو وسط فرم از فرم بیرون می‌آید
  await click(env, 'addr:edit');
  await say(env, { text: '💼 موجودی کیف پول' });
  assert.equal((await db.getSession(env, '111')).state, null);
  assert.equal((await db.getAddressProfile(env, '111')).address, ADDRESS);
});

test('ویرایش آدرس: سفارش در حال بررسی عوض می‌شود، سفارش تاییدشده نه', async () => {
  const env = freshEnv();
  await shop(env);
  await fillProfile(env);
  const confirmed = await checkout(env, 'c');
  await payByReceipt(env, confirmed);
  await click(env, `confirm_order:${confirmed.id}`, ADMIN);
  const reviewing = await checkout(env, 'c');
  await payByReceipt(env, reviewing);

  await click(env, 'addr:edit');
  await say(env, { text: 'مشهد، بلوار وکیل‌آباد، پلاک ۹۹' });
  await say(env, { text: '9876543210' });

  assert.equal((await db.getOrder(env, confirmed.id)).ship_address, ADDRESS);
  const updated = await db.getOrder(env, reviewing.id);
  assert.match(updated.ship_address, /مشهد/);
  assert.equal(updated.ship_postal, '9876543210');
  assert.match(messagesTo(ADMIN).pop().body.text, /مشهد/);
});

test('پنل ادمین: دسته‌ی منتظر آدرس، آدرس سفارش و گزارش به تفکیک کالا', async () => {
  const env = freshEnv();
  await shop(env);
  const waiting = await checkout(env, 's');
  await payByReceipt(env, waiting);
  await db.clearSession(env, '111');

  await sendLastOrders(env, ADMIN, 'awaiting_address', 10);
  const panel = messagesTo(ADMIN).pop().body.text;
  assert.match(panel, new RegExp(`1000${waiting.id}`));
  assert.match(panel, /منتظر آدرس/);

  await sendOrdersReport(env, ADMIN, 'all');
  const report = messagesTo(ADMIN).at(-2).body.text;
  assert.match(report, /محصول 1: ۱ سفارش — ۷۰۰٬۰۰۰/);
  assert.match(report, /محصول 2: ۱ سفارش — ۱۵۰٬۰۰۰/);
});

test('حذف کاربر، سبد او را هم پاک می‌کند', async () => {
  const env = freshEnv();
  await shop(env);
  await click(env, 'buy:1');
  await db.deleteUser(env, '111');
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM cart_items').first();
  assert.equal(row.c, 0);
});

test('فایل migration روی دیتابیس قدیمی اجرا می‌شود و آدرس‌ها منتقل می‌شوند', async () => {
  const { raw } = makeD1();
  raw.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, chat_id TEXT UNIQUE NOT NULL);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO users (chat_id) VALUES ('111'), ('222');
    INSERT INTO settings VALUES ('address:111', '${ADDRESS}'), ('discount_active', '1');
  `);
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'migrations', '001_cart_address.sql'), 'utf-8'));
  assert.equal(raw.prepare("SELECT address FROM users WHERE chat_id = '111'").get().address, ADDRESS);
  assert.equal(raw.prepare("SELECT address FROM users WHERE chat_id = '222'").get().address, null);
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM settings').get().c, 1);
});

let passed = 0;
for (const t of tests) {
  calls.length = 0;
  try {
    await t.fn();
    passed++;
    console.log(`✅ ${t.name}`);
  } catch (err) {
    console.error(`❌ ${t.name}\n   ${err.message}`);
  }
}
console.log(`\n${passed}/${tests.length} cart tests passed`);
if (passed !== tests.length) process.exit(1);
console.log('ALL CART TESTS PASSED ✅');
