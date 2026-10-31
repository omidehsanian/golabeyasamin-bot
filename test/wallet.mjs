// تست‌های مالی: کیف پول اتمیک، تایید/رد سفارش ایمن در برابر تکرار و هم‌زمانی،
// کمیسیون و پاداش دعوت، و بررسی دسترسی ادمین در سمت سرور.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { setTestPrice } from './products_helper.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');

const ADMIN = '999';
const SUPPORT = '998';

// ---- fetch mock: همه‌ی درخواست‌های خروجی به API تلگرام را ضبط می‌کند ----
const calls = [];
let msgId = 1;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  calls.push({ method, body });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: msgId++ } }) };
};

function freshEnv() {
  const { prepare, batch, raw } = makeD1();
  raw.exec(SCHEMA);
  const env = {
    DB: { prepare, batch },
    BOT_TOKEN: 'TEST',
    ADMIN_CHAT_ID: ADMIN,
    SUPPORT_CHAT_ID: SUPPORT,
    BOT_USERNAME: 'TestBot',
    CHANNEL_USERNAME: 'test_channel',
    CARD_NUMBER: '1111',
    CARD_HOLDER: 'Test',
    REFERRAL_REWARD: '10000',
    SIGNUP_BONUS: '20000',
    REFERRAL_COMMISSION_PERCENT: '10',
    DISCOUNT_ENABLED: 'false',
  };
  return { env, raw };
}

async function makeUser(env, chatId, wallet = 0) {
  await db.ensureUser(env, chatId);
  await db.setChannelConfirmed(env, chatId);
  await db.saveRegistration(env, chatId, { phone_number: `0912${chatId}`, first_name: 'U', last_name: chatId });
  if (wallet) await db.adminAdjustWallet(env, chatId, wallet, `test:seed:${chatId}`);
}

const cb = (fromId, data, id) => ({
  id: id || `cb-${Math.random()}`,
  data,
  from: { id: Number(fromId) },
  message: { chat: { id: Number(fromId) }, message_id: msgId++ },
});

const wallet = (env, id) => db.getWallet(env, id);
const countRows = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).first()).c;
const noNegative = async (env) =>
  assert.equal(await countRows(env, 'SELECT COUNT(*) c FROM users WHERE wallet < 0'), 0, 'هیچ کیف پولی نباید منفی باشد');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ----------------------------------------------------------------------------
test('پرداخت با موجودی کمتر از مبلغ سفارش رد می‌شود', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 20000);
  await setTestPrice(env, 1, 25000);

  await handleCallbackQuery(env, cb('111', 'walletpay:1:'));
  assert.equal(await wallet(env, '111'), 20000);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM orders WHERE status = 'paid_by_wallet'"), 0);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE type = 'order_debit'"), 0);
  await noNegative(env);
});

test('پرداخت با موجودی دقیقاً برابر مبلغ سفارش موفق است', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 25000);
  await setTestPrice(env, 1, 25000);

  await handleCallbackQuery(env, cb('111', 'walletpay:1:'));
  assert.equal(await wallet(env, '111'), 0);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE user_id = '111'").first();
  assert.equal(order.status, 'paid_by_wallet');
  const tx = await env.DB.prepare('SELECT * FROM wallet_transactions WHERE idempotency_key = ?').bind(`order:${order.id}:debit`).first();
  assert.equal(tx.amount, -25000);
  assert.equal(tx.order_id, order.id, 'گردش مالی باید به سفارش مربوطه لینک باشد');
  assert.equal(tx.balance_after, 0);
});

test('محصول بدون قیمت با کیف پول قابل خرید نیست', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 25000);
  await handleCallbackQuery(env, cb('111', 'walletpay:2:'));
  assert.equal(await wallet(env, '111'), 25000);
  assert.equal(await countRows(env, 'SELECT COUNT(*) c FROM orders'), 0);
});

test('دو برداشت هم‌زمان بیش از موجودی واقعی برداشت نمی‌کنند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 25000);
  await setTestPrice(env, 1, 25000);

  await Promise.all([
    handleCallbackQuery(env, cb('111', 'walletpay:1:', 'click-A')),
    handleCallbackQuery(env, cb('111', 'walletpay:1:', 'click-B')),
    handleCallbackQuery(env, cb('111', 'walletpay:1:', 'click-C')),
  ]);
  assert.equal(await wallet(env, '111'), 0);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM orders WHERE status = 'paid_by_wallet'"), 1, 'فقط یک خرید موفق');
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE type = 'order_debit'"), 1);
  await noNegative(env);
});

test('ارسال دوباره‌ی همان کلیک (retry تلگرام) سفارش یا کسر دوم نمی‌سازد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 100000);
  await setTestPrice(env, 1, 25000);

  const same = cb('111', 'walletpay:1:', 'retry-1');
  await Promise.all([handleCallbackQuery(env, same), handleCallbackQuery(env, same)]);
  await handleCallbackQuery(env, same);
  assert.equal(await wallet(env, '111'), 75000);
  assert.equal(await countRows(env, 'SELECT COUNT(*) c FROM orders'), 1);
});

test('تایید هم‌زمان دو سفارش رسید که مجموعاً بیش از موجودی هستند: فقط یکی کسر می‌شود', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 30000);
  const o1 = await db.saveOrder(env, '111', 'capcut', 'CapCut', { osType: 'ios', amount: 400000, walletUsed: 20000, status: 'receipt_sent' });
  const o2 = await db.saveOrder(env, '111', 'capcut', 'CapCut', { osType: 'ios', amount: 400000, walletUsed: 20000, status: 'receipt_sent' });

  await Promise.all([
    handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o1}`)),
    handleCallbackQuery(env, cb(SUPPORT, `confirm_order:${o2}`)),
  ]);
  assert.equal(await wallet(env, '111'), 10000);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM orders WHERE status = 'confirmed'"), 1);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM orders WHERE status = 'receipt_sent'"), 1, 'سفارش دوم بدون تغییر می‌ماند');
  await noNegative(env);
});

test('تایید چندباره (پشت‌سرهم و هم‌زمان، دو ادمین) کسر یا کمیسیون تکراری ایجاد نمی‌کند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '500'); // معرف
  await makeUser(env, '111', 50000);
  await db.registerReferral(env, '500', '111');
  const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 300000, walletUsed: 50000, status: 'receipt_sent' });

  await Promise.all([
    handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`)),
    handleCallbackQuery(env, cb(SUPPORT, `confirm_order:${o}`)),
    handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`)),
  ]);
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`));
  await handleCallbackQuery(env, cb(SUPPORT, `confirm_order:${o}`));

  assert.equal(await wallet(env, '111'), 0, 'فقط یک‌بار 50,000 کسر شود');
  // کمیسیون: 10% از 250,000 نقدی = 25,000 + پاداش دعوت یک‌باره 10,000
  assert.equal(await wallet(env, '500'), 35000);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ? AND type = 'order_debit'", o), 1);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ? AND type = 'referral_commission'", o), 1);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE type = 'referral_reward'"), 1);
  const commissionMsgs = calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '500' && c.body.text.includes('کمیسیون'));
  assert.equal(commissionMsgs.length, 1, 'به معرف فقط یک‌بار اطلاع داده شود');
  await noNegative(env);
});

test('رد سفارش هیچ کسر وجه یا کمیسیونی ایجاد نمی‌کند و بعد از رد قابل تایید نیست', async () => {
  const { env } = freshEnv();
  await makeUser(env, '500');
  await makeUser(env, '111', 50000);
  await db.registerReferral(env, '500', '111');
  const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 300000, walletUsed: 50000, status: 'receipt_sent' });

  await Promise.all([
    handleCallbackQuery(env, cb(ADMIN, `reject_order:${o}`)),
    handleCallbackQuery(env, cb(SUPPORT, `reject_order:${o}`)),
  ]);
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`));

  assert.equal((await db.getOrder(env, o)).status, 'rejected');
  assert.equal(await wallet(env, '111'), 50000);
  assert.equal(await wallet(env, '500'), 0);
  assert.equal(await countRows(env, 'SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ?', o), 0);
  const rejectNotices = calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '111' && c.body.text.includes('تایید نشد'));
  assert.equal(rejectNotices.length, 1, 'پیام رد فقط یک‌بار ارسال شود');
});

test('سفارش تاییدشده قابل رد نیست', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 50000);
  const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 300000, walletUsed: 50000, status: 'receipt_sent' });
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`));
  await handleCallbackQuery(env, cb(ADMIN, `reject_order:${o}`));
  assert.equal((await db.getOrder(env, o)).status, 'confirmed');
  assert.equal(await wallet(env, '111'), 0);
});

test('کاربر غیرادمین نمی‌تواند سفارش را تایید یا رد کند (بررسی سمت سرور)', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 50000);
  const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 300000, walletUsed: 50000, status: 'receipt_sent' });

  await handleCallbackQuery(env, cb('111', `confirm_order:${o}`));
  // حتی اگر پیام در چت ادمین باشد ولی کلیک‌کننده ادمین نباشد
  await handleCallbackQuery(env, { ...cb('111', `confirm_order:${o}`), message: { chat: { id: Number(ADMIN) } } });
  await handleCallbackQuery(env, cb('111', `reject_order:${o}`));
  await handleCallbackQuery(env, cb('111', 'bc_next'));
  await handleCallbackQuery(env, cb('111', 'ord_fetch:store:all'));

  assert.equal((await db.getOrder(env, o)).status, 'receipt_sent');
  assert.equal(await wallet(env, '111'), 50000);
  const leaked = calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === '111' && /لیست سفارش|دسته جدید/.test(c.body.text));
  assert.equal(leaked.length, 0);
});

test('خطا در میانه‌ی تایید rollback می‌شود و اجرای مجدد فقط یک‌بار کسر می‌کند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 50000);
  const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 300000, walletUsed: 50000, status: 'receipt_sent' });

  // شبیه‌سازی قطع شدن در وسط تراکنش (آخرین دستور batch خطا می‌دهد)
  const realBatch = env.DB.batch;
  const brokenEnv = {
    ...env,
    DB: { ...env.DB, batch: (stmts) => realBatch([...stmts, env.DB.prepare('INSERT INTO table_that_does_not_exist VALUES (1)')]) },
  };
  await assert.rejects(() => db.confirmOrder(brokenEnv, o, { commissionPercent: 10 }));
  assert.equal(await wallet(env, '111'), 50000, 'بعد از خطا موجودی دست نخورده');
  assert.equal((await db.getOrder(env, o)).status, 'receipt_sent');
  assert.equal(await countRows(env, 'SELECT COUNT(*) c FROM wallet_transactions WHERE order_id = ?', o), 0);

  const r1 = await db.confirmOrder(env, o, { commissionPercent: 10 });
  const r2 = await db.confirmOrder(env, o, { commissionPercent: 10 });
  assert.equal(r1.ok, true);
  assert.equal(r2.reason, 'already_confirmed');
  assert.equal(await wallet(env, '111'), 0);
  await noNegative(env);
});

test('موجودی ناکافی هنگام تایید: سفارش تایید نمی‌شود و موجودی منفی نمی‌شود', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 50000);
  const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 300000, walletUsed: 50000, status: 'receipt_sent' });
  // کاربر در این فاصله اعتبارش را جای دیگری خرج کرده
  await db.adminAdjustWallet(env, '111', -40000, 'test:spend');

  const r = await db.confirmOrder(env, o);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'insufficient_wallet');
  assert.equal((await db.getOrder(env, o)).status, 'receipt_sent');
  assert.equal(await wallet(env, '111'), 10000);
  await noNegative(env);
});

test('سفارش قدیمی با wallet_used منفی هنگام تایید اعتبار جعلی نمی‌سازد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 0);
  const o = await db.saveOrder(env, '111', 'telegram_premium', 'TP', { amount: 3900000, walletUsed: -886400, status: 'receipt_sent' });
  const r = await db.confirmOrder(env, o);
  assert.equal(r.ok, true);
  assert.equal(await wallet(env, '111'), 0);
});

test('دیتابیس هیچ موجودی منفی را نمی‌پذیرد (trigger)', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', 1000);
  await assert.rejects(() => env.DB.prepare("UPDATE users SET wallet = -1 WHERE chat_id = '111'").run(), /negative/);
  const r = await db.adminAdjustWallet(env, '111', -5000, 'test:overdraw');
  assert.equal(r.applied, false);
  assert.equal(await wallet(env, '111'), 1000);
});

test('پاداش دعوت در /start و ثبت‌نام پرداخت نمی‌شود؛ فقط یک‌بار پس از اولین خرید تاییدشده', async () => {
  const { env } = freshEnv();
  await makeUser(env, '500');
  const before = await wallet(env, '500');

  // کاربر جدید با لینک دعوت وارد می‌شود و ثبت‌نام می‌کند
  await handleMessage(env, { chat: { id: 222 }, from: { id: 222 }, text: '/start 500', message_id: msgId++ });
  await handleMessage(env, { chat: { id: 222 }, from: { id: 222 }, text: '/start 500', message_id: msgId++ });
  await db.setChannelConfirmed(env, '222');
  await handleMessage(env, { chat: { id: 222 }, from: { id: 222 }, contact: { user_id: 222, phone_number: '0912222', first_name: 'B' }, message_id: msgId++ });
  assert.equal(await wallet(env, '500'), before, 'هیچ پاداشی در /start یا ثبت‌نام');
  assert.equal(await db.getReferrerOf(env, '222'), '500');

  // سفارش رد شده واجد شرایط نیست
  const rejected = await db.saveOrder(env, '222', 'chatgpt', 'ChatGPT', { amount: 100000, status: 'receipt_sent' });
  await handleCallbackQuery(env, cb(ADMIN, `reject_order:${rejected}`));
  assert.equal(await wallet(env, '500'), before);

  // سفارش ساخت ربات (بدون مبلغ) واجد شرایط نیست
  const bot = await db.saveOrder(env, '222', 'custom_bot', 'ربات', { status: 'new' });
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${bot}`));
  assert.equal(await wallet(env, '500'), before);

  // اولین خرید تاییدشده: پاداش 10,000 + کمیسیون 10% از 100,000
  const first = await db.saveOrder(env, '222', 'chatgpt', 'ChatGPT', { amount: 100000, status: 'receipt_sent' });
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${first}`));
  assert.equal(await wallet(env, '500'), before + 10000 + 10000);

  // خرید دوم: فقط کمیسیون، پاداش دعوت دوباره پرداخت نمی‌شود
  const second = await db.saveOrder(env, '222', 'chatgpt', 'ChatGPT', { amount: 200000, status: 'receipt_sent' });
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${second}`));
  assert.equal(await wallet(env, '500'), before + 10000 + 10000 + 20000);
  assert.equal(await countRows(env, "SELECT COUNT(*) c FROM wallet_transactions WHERE type = 'referral_reward'"), 1);
});

test('خرید کامل با کیف پول کمیسیون یا پاداش دعوت ایجاد نمی‌کند (پرداخت نقدی صفر)', async () => {
  const { env } = freshEnv();
  await makeUser(env, '500');
  await makeUser(env, '111', 25000);
  await db.registerReferral(env, '500', '111');
  await setTestPrice(env, 1, 25000);
  await handleCallbackQuery(env, cb('111', 'walletpay:1:'));
  assert.equal(await wallet(env, '500'), 0);
});

test('هدیه ثبت‌نام فقط یک‌بار و فقط با شماره‌ی خود کاربر', async () => {
  const { env } = freshEnv();
  await db.ensureUser(env, '333');
  await db.setChannelConfirmed(env, '333');
  const contact = { user_id: 333, phone_number: '0912333', first_name: 'C' };
  const msg = () => ({ chat: { id: 333 }, from: { id: 333 }, contact, message_id: msgId++ });

  await Promise.all([handleMessage(env, msg()), handleMessage(env, msg())]);
  await handleMessage(env, msg());
  assert.equal(await wallet(env, '333'), 20000);

  // contact شخص دیگر پذیرفته نمی‌شود
  await db.ensureUser(env, '444');
  await handleMessage(env, { chat: { id: 444 }, from: { id: 444 }, contact: { user_id: 333, phone_number: '0912333' }, message_id: msgId++ });
  assert.equal(await db.isRegistered(env, '444'), false);
  assert.equal(await wallet(env, '444'), 0);

  // همان شماره با حساب دیگر (شماره‌ی تکراری) هدیه‌ی دوم نمی‌گیرد
  await db.ensureUser(env, '555');
  await handleMessage(env, { chat: { id: 555 }, from: { id: 555 }, contact: { user_id: 555, phone_number: '0912333' }, message_id: msgId++ });
  assert.equal(await wallet(env, '555'), 0);
});

test('ارسال رسید با کیف پول منفی (داده‌ی قدیمی) مبلغ فاکتور را افزایش نمی‌دهد', async () => {
  const { env, raw } = freshEnv();
  await makeUser(env, '111');
  raw.exec('DROP TRIGGER trg_users_wallet_non_negative_update');
  raw.exec("UPDATE users SET wallet = -886400 WHERE chat_id = '111'");
  await setTestPrice(env, 3, 3900000);
  await db.setSession(env, '111', 'awaiting_receipt', { productId: '3', osType: '' });
  await handleMessage(env, { chat: { id: 111 }, from: { id: 111 }, photo: [{ file_id: 'x' }], message_id: msgId++ });
  const order = await env.DB.prepare("SELECT * FROM orders WHERE user_id = '111'").first();
  assert.equal(order.wallet_used, 0);
  assert.equal(order.amount, 3900000);
});

test('در مرحله رسید، «انصراف» و متن معمولی سفارش نمی‌سازند؛ فقط عکس رسید سفارش می‌سازد', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  const say = (extra) => handleMessage(env, { chat: { id: 111 }, from: { id: 111 }, message_id: msgId++, ...extra });
  const orders = () => countRows(env, 'SELECT COUNT(*) c FROM orders');

  await handleCallbackQuery(env, cb('111', 'receipt:1:'));
  await say({ text: 'سلام' });
  await say({ text: '💼 موجودی کیف پول' });
  assert.equal(await orders(), 0, 'متن معمولی نباید سفارش بسازد');
  assert.equal((await db.getSession(env, '111')).state, 'awaiting_receipt', 'هنوز منتظر رسید');

  await say({ text: '🔙 انصراف' });
  assert.equal(await orders(), 0, 'انصراف نباید سفارش بسازد');
  assert.equal((await db.getSession(env, '111')).state, null, 'انصراف session را پاک می‌کند');
  assert.equal(calls.filter((c) => c.method === 'forwardMessage').length, 0, 'چیزی برای ادمین فوروارد نشود');

  await handleCallbackQuery(env, cb('111', 'receipt:1:'));
  await say({ photo: [{ file_id: 'receipt' }] });
  assert.equal(await orders(), 1, 'عکس رسید سفارش می‌سازد');
});

test('انصراف در فرم سفارش ساخت ربات، نام را ذخیره نمی‌کند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  const say = (text) => handleMessage(env, { chat: { id: 111 }, from: { id: 111 }, message_id: msgId++, text });
  await say('🤖 ساخت ربات');
  await say('🔙 انصراف');
  assert.equal((await db.getSession(env, '111')).state, null);
  assert.equal(await countRows(env, 'SELECT COUNT(*) c FROM orders'), 0);
});

// ----------------------------------------------------------------------------
let failed = 0;
for (const t of tests) {
  calls.length = 0;
  try {
    await t.fn();
    console.log('✅', t.name);
  } catch (e) {
    failed++;
    console.error('❌', t.name, '\n  ', e.message);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} wallet tests passed`);
if (failed) process.exit(1);
console.log('ALL WALLET TESTS PASSED ✅');
