// تست‌های مراحل خرید: تعداد ← روش تحویل ← آدرس پیک ← پیش‌فاکتور با هزینه‌ی ارسال
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { setTestPrice } from './products_helper.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { orderPrice, parseVariant, variantCode } from '../products.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
const ADMIN = '999';

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
    ...extra,
  };
}

async function makeUser(env, chatId, wallet = 0) {
  await db.ensureUser(env, chatId);
  await db.saveRegistration(env, chatId, { phone_number: `0912${chatId}`, first_name: 'U' });
  if (wallet) await db.adminAdjustWallet(env, chatId, wallet, `test:seed:${chatId}`);
}

const cb = (fromId, data) => ({
  id: `cb-${Math.random()}`,
  data,
  from: { id: Number(fromId) },
  message: { chat: { id: Number(fromId) }, message_id: msgId++ },
});
const say = (env, chatId, extra) => handleMessage(env, { chat: { id: Number(chatId) }, from: { id: Number(chatId) }, message_id: msgId++, ...extra });
const lastMessage = (chatId) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId)).pop();
const buttonsOf = (c) => (c?.body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const pending = (env, chatId) => env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'").bind(chatId).first();

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('کد تعداد و روش تحویل', () => {
  assert.deepEqual(parseVariant('c3'), { delivery: 'courier', quantity: 3 });
  assert.deepEqual(parseVariant('p1'), { delivery: 'pickup', quantity: 1 });
  assert.deepEqual(parseVariant(''), { delivery: '', quantity: 1 });
  assert.deepEqual(parseVariant('ios'), { delivery: '', quantity: 1 });
  assert.equal(parseVariant('c999').quantity, 20, 'سقف تعداد');
  assert.equal(variantCode('courier', 0), 'c1');
});

test('محاسبه‌ی هزینه‌ی ارسال', () => {
  const env = {};
  const product = { price: 600000 };
  assert.equal(orderPrice(env, product, 'p2').price, 1200000, 'حضوری رایگان');
  assert.deepEqual(orderPrice(env, product, 'c2'), { basePrice: 1200000, discountAmount: 0, itemsTotal: 1200000, shipping: 300000, price: 1500000 });
  // ۹ × ۶۰۰ = ۵٬۴۰۰٬۰۰۰ → ارسال رایگان
  assert.equal(orderPrice(env, product, 'c9').shipping, 0);
  // آستانه بعد از تخفیف حساب می‌شود: ۹ × ۶۰۰ با ۱۰٪ = ۴٬۸۶۰٬۰۰۰ → هزینه دارد، تخفیف روی ارسال نیست
  assert.deepEqual(orderPrice(env, product, 'c9', 10), { basePrice: 5400000, discountAmount: 540000, itemsTotal: 4860000, shipping: 300000, price: 5160000 });
  assert.equal(orderPrice({ COURIER_FEE: '50000', FREE_SHIPPING_MIN: '1000000' }, product, 'c1').shipping, 50000);
  assert.equal(orderPrice({ COURIER_FEE: '50000', FREE_SHIPPING_MIN: '1000000' }, product, 'c2').shipping, 0);
});

test('خرید ← تعداد ← روش تحویل ← پیش‌فاکتور حضوری', async () => {
  const env = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 350000);

  await handleCallbackQuery(env, cb('111', 'buy:1'));
  assert.ok(buttonsOf(lastMessage('111')).includes('qty:1:3'), 'دکمه‌های تعداد');
  assert.equal(await pending(env, '111'), null, 'قبل از انتخاب تحویل سفارشی ساخته نمی‌شود');

  await handleCallbackQuery(env, cb('111', 'qty:1:3'));
  assert.deepEqual(buttonsOf(lastMessage('111')), ['os:1:p3', 'os:1:c3']);

  await handleCallbackQuery(env, cb('111', 'os:1:p3'));
  const o = await pending(env, '111');
  assert.equal(o.os_type, 'p3');
  assert.equal(o.amount, 1050000);
  const text = lastMessage('111').body.text;
  assert.match(text, /تحویل حضوری: رایگان/);
  assert.match(text, /۱٬۰۵۰٬۰۰۰/);
});

test('ارسال با پیک: آدرس گرفته می‌شود و هزینه روی فاکتور می‌آید', async () => {
  const env = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 600000);

  await handleCallbackQuery(env, cb('111', 'os:1:c2'));
  assert.equal(await pending(env, '111'), null);
  assert.equal((await db.getSession(env, '111')).state, 'awaiting_address');

  await say(env, '111', { text: 'کوتاه' });
  assert.equal((await db.getSession(env, '111')).state, 'awaiting_address', 'آدرس کوتاه پذیرفته نمی‌شود');

  await say(env, '111', { text: 'تهران، خیابان آزادی، کوچه ۵، پلاک ۱۲ - کد پستی ۱۲۳۴۵' });
  const o = await pending(env, '111');
  assert.equal(o.amount, 1500000);
  assert.match(o.note, /خیابان آزادی/);
  assert.match(lastMessage('111').body.text, /هزینه ارسال با پیک: ۳۰۰٬۰۰۰ تومان/);

  // رسید: آدرس و روش تحویل در پیام ادمین
  await handleCallbackQuery(env, cb('111', `rcpt:${o.id}`));
  await say(env, '111', { photo: [{ file_id: 'R' }] });
  const adminMsg = lastMessage(ADMIN).body.text;
  assert.match(adminMsg, /ارسال با پیک/);
  assert.match(adminMsg, /خیابان آزادی/);
  assert.equal((await db.getOrder(env, o.id)).amount, 1500000);
});

test('خرید بالای ۵ میلیون: ارسال با پیک رایگان', async () => {
  const env = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 600000);
  await db.setSetting(env, 'address:111', 'تهران، خیابان انقلاب، پلاک ۱');

  await handleCallbackQuery(env, cb('111', 'os:1:c10'));
  assert.deepEqual(buttonsOf(calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === '111').at(-2)), ['addr_ok:1:c10']);
  await handleCallbackQuery(env, cb('111', 'addr_ok:1:c10'));
  const o = await pending(env, '111');
  assert.equal(o.amount, 6000000);
  assert.match(o.note, /خیابان انقلاب/);
  assert.match(lastMessage('111').body.text, /ارسال با پیک: <b>رایگان<\/b>/);
});

test('پرداخت با کیف پول شامل هزینه‌ی ارسال است', async () => {
  const env = freshEnv();
  await makeUser(env, '111', 1000000);
  await setTestPrice(env, 1, 200000);
  await db.setSetting(env, 'address:111', 'تهران، خیابان انقلاب، پلاک ۱');

  await handleCallbackQuery(env, cb('111', 'addr_ok:1:c1'));
  const o = await pending(env, '111');
  assert.equal(o.amount, 500000);
  await handleCallbackQuery(env, cb('111', `wpay:${o.id}`));
  assert.equal((await db.getOrder(env, o.id)).status, 'paid_by_wallet');
  assert.equal(await db.getWallet(env, '111'), 500000);
  assert.match(lastMessage(ADMIN).body.text, /خیابان انقلاب/);
});

test('زدن دکمه‌ی منو وسط گرفتن آدرس، از خرید بیرون می‌آید', async () => {
  const env = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 200000);
  await handleCallbackQuery(env, cb('111', 'os:1:c1'));
  await say(env, '111', { text: '💼 موجودی کیف پول' });
  assert.equal((await db.getSession(env, '111')).state, null);
  assert.equal(await db.getSetting(env, 'address:111', ''), '');
  assert.match(lastMessage('111').body.text, /موجودی کیف پول/);
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
console.log(`\n${passed}/${tests.length} shipping tests passed`);
if (passed !== tests.length) process.exit(1);
console.log('ALL SHIPPING TESTS PASSED ✅');
