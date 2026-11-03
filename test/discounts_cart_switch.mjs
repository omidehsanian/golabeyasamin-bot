// تست کد تخفیف ساختنی از داخل ربات، کلید سبد خرید، قیمت خط‌خورده و پنهان‌کردن محصول
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { setTestPrice } from './products_helper.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import * as db from '../db.js';
import { getCart } from '../cart.js';
import { getFullProduct } from '../products.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '999';
const SUPPORT = '998';
const USER = '111';
const DAY = 86400000;
const CART = '🛒 سبد خرید';
const ON = '⚙️ سبد خرید: روشن ✅';
const OFF = '⚙️ سبد خرید: خاموش ⛔';

const calls = [];
let nextId = 1;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  calls.push({ method, body });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: nextId++ } }) };
};

async function makeEnv(extra = {}) {
  const { prepare, batch, raw } = makeD1();
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));
  const env = {
    DB: { prepare, batch },
    raw,
    BOT_TOKEN: 'T',
    ADMIN_CHAT_ID: ADMIN,
    SUPPORT_CHAT_ID: SUPPORT,
    CHANNEL_ENABLED: 'false',
    DISCOUNT_ENABLED: 'true',
    DISCOUNT_CODES: 'CONFIG5:5',
    POST_FEE: '100000',
    ...extra,
  };
  for (const id of [USER, ADMIN, SUPPORT]) {
    await db.ensureUser(env, id);
    await db.saveRegistration(env, id, { phone_number: `0912${id}`, first_name: 'U' });
  }
  await setTestPrice(env, 1, 100000);
  await setTestPrice(env, 2, 200000);
  return env;
}

const msg = (from, text) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, text });
const photo = (from) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, photo: [{ file_id: 'F' }] });
const cb = (from, data) => ({ id: `cb${nextId++}`, data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: nextId++ } });
const sent = (to) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === to);
const last = (to) => sent(to).at(-1).body;
const callbacks = (body) => (body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const menuButtons = (body) => (body.reply_markup?.keyboard || []).flat().map((b) => b.text);
const alertText = () => calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).body.text;
const pending = (env, who) => env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'").bind(who).first();

async function menuFor(env, who) {
  await handleMessage(env, msg(who, '/start'));
  return menuButtons(last(who));
}

async function createCode(env, who, code, percent, product, duration) {
  await handleCallbackQuery(env, cb(who, 'dc_new'));
  await handleMessage(env, msg(who, code));
  await handleMessage(env, msg(who, String(percent)));
  await handleCallbackQuery(env, cb(who, `dcp:${product}`));
  await handleCallbackQuery(env, cb(who, `dcd:${duration}`));
  await handleCallbackQuery(env, cb(who, 'dcok'));
}

async function enterCode(env, productId, osType, code) {
  await handleCallbackQuery(env, cb(USER, `discount_yes:${productId}:${osType}`));
  await handleMessage(env, msg(USER, code));
}

async function main() {
  // ---- ساخت کد ----
  {
    const env = await makeEnv();
    const before = Date.now();
    await handleMessage(env, msg(ADMIN, '🎟 کدهای تخفیف'));
    assert.ok(last(ADMIN).text.includes('CONFIG5'), 'config codes are listed');

    await handleCallbackQuery(env, cb(ADMIN, 'dc_new'));
    await handleMessage(env, msg(ADMIN, 'a b'));
    assert.ok(last(ADMIN).text.includes('۳ تا ۲۰'), 'bad code text');
    await handleMessage(env, msg(ADMIN, 'config5'));
    assert.ok(last(ADMIN).text.includes('فعال است'), 'clashes with config code');
    await handleMessage(env, msg(ADMIN, 'yalda20'));
    await handleMessage(env, msg(ADMIN, '100'));
    assert.ok(last(ADMIN).text.includes('۱ تا ۹۹'), 'percent limit');
    await handleMessage(env, msg(ADMIN, '۲۰'));
    assert.ok(callbacks(last(ADMIN)).includes('dcp:*') && callbacks(last(ADMIN)).includes('dcp:1'));
    await handleCallbackQuery(env, cb(ADMIN, 'dcok'));
    assert.ok(alertText().includes('منقضی'), 'cannot skip steps');
    await handleCallbackQuery(env, cb(ADMIN, 'dcp:*'));
    await handleCallbackQuery(env, cb(ADMIN, 'dcd:day'));
    assert.ok(!(await db.getDiscountCode(env, 'YALDA20')), 'not saved before confirm');
    await handleCallbackQuery(env, cb(ADMIN, 'dcok'));
    const day = await db.getDiscountCode(env, 'YALDA20');
    assert.equal(day.percent, 20);
    assert.equal(day.product_id, null);
    assert.ok(day.expires_at >= before + DAY && day.expires_at <= Date.now() + DAY, 'one day');

    await createCode(env, SUPPORT, 'WEEK10', 10, '1', 'week');
    const week = await db.getDiscountCode(env, 'WEEK10');
    assert.equal(week.product_id, '1');
    assert.ok(week.expires_at >= before + 7 * DAY && week.expires_at <= Date.now() + 7 * DAY, 'one week');

    await createCode(env, ADMIN, 'FOREVER', 15, '*', 'forever');
    assert.equal((await db.getDiscountCode(env, 'FOREVER')).expires_at, null, 'permanent');
    await handleCallbackQuery(env, cb(ADMIN, 'dcx:FOREVER'));
    assert.ok(!(await db.getDiscountCode(env, 'FOREVER')), 'deleted');
    console.log('✅ create codes: all durations, validation, delete');
  }

  // ---- استفاده از کد و سبد با تخفیف محصولی ----
  {
    const env = await makeEnv();
    await createCode(env, ADMIN, 'ALL20', 20, '*', 'forever');
    await createCode(env, ADMIN, 'P1HALF', 50, '1', 'week');
    await createCode(env, ADMIN, 'OLD', 30, '*', 'day');
    env.raw.exec(`UPDATE discount_codes SET expires_at = ${Date.now() - 1000} WHERE code = 'OLD'`);

    await enterCode(env, '1', 'p1', 'all20');
    assert.equal((await pending(env, USER)).amount, 80000, 'all-products code');

    await enterCode(env, '2', 'p1', 'P1HALF');
    assert.ok(last(USER).text.includes('معتبر نیست'), 'product code rejected on another product');
    await handleMessage(env, msg(USER, '🔙 انصراف'));

    await enterCode(env, '1', 'p1', 'P1HALF');
    assert.equal((await pending(env, USER)).amount, 50000, 'product code on its product');

    await enterCode(env, '1', 'p1', 'OLD');
    assert.ok(last(USER).text.includes('مهلت'), 'expired code rejected');
    await handleMessage(env, msg(USER, '🔙 انصراف'));

    await enterCode(env, '2', 'p1', 'config5');
    assert.equal((await pending(env, USER)).amount, 190000, 'config codes still work');

    // سبد: ۲ × ۱۰۰ هزار + ۱ × ۲۰۰ هزار، تحویل حضوری؛ کد فقط روی محصول ۱
    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    await handleCallbackQuery(env, cb(USER, 'pq:inc:1'));
    await handleCallbackQuery(env, cb(USER, 'buy:2'));
    await enterCode(env, 'cart', 'p', 'P1HALF');
    let order = await pending(env, USER);
    assert.equal(order.product_id, 'cart');
    assert.equal(order.amount, 300000, 'product code only discounts its lines (400k - 50% of 200k)');

    // تغییر قیمت بعد از صدور، مبلغ را عوض نمی‌کند و تخفیف محصولی روی رسید حفظ می‌شود
    await setTestPrice(env, 1, 999000);
    await handleCallbackQuery(env, cb(USER, `rcpt:${order.id}`));
    await handleMessage(env, photo(USER));
    order = await db.getOrder(env, order.id);
    assert.equal(order.status, 'receipt_sent');
    assert.equal(order.amount, 300000, 'receipt keeps the invoice amount');

    // کالاهای سفارش قبلی با رسید از سبد رفته‌اند؛ کد همه‌ی محصولات روی کل سبد جدید
    await setTestPrice(env, 1, 100000);
    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    await handleCallbackQuery(env, cb(USER, 'buy:2'));
    await enterCode(env, 'cart', 'p', 'ALL20');
    assert.equal((await pending(env, USER)).amount, 240000, 'all-products code on the whole cart');

    // پیش‌فاکتور باز قبل از migration: ستون discounted پیش‌فرض ۱ دارد و مبلغش عوض نمی‌شود
    const open = await pending(env, USER);
    env.raw.exec(`UPDATE order_items SET discounted = 1 WHERE order_id = ${open.id}`);
    await handleCallbackQuery(env, cb(USER, `resume:${open.id}`));
    assert.equal((await pending(env, USER)).amount, 240000, 'old invoice keeps its amount');
    console.log('✅ redeem: scope, expiry, config codes, scoped cart');
  }

  // ---- کلید سبد: فایل کانفیگ و دکمه‌ی ربات ----
  {
    const off = await makeEnv({ CART_ENABLED: 'false' });
    const adminMenu = await menuFor(off, ADMIN);
    assert.ok(!adminMenu.some((b) => b.startsWith('⚙️ سبد خرید')), 'config off: no admin toggle');
    assert.ok(!adminMenu.includes(CART), 'config off: no cart button');
    await handleMessage(off, msg(ADMIN, OFF));
    assert.ok(!(await menuFor(off, USER)).includes(CART), 'config off: toggle has no effect');

    const env = await makeEnv();
    assert.ok((await menuFor(env, ADMIN)).includes(ON), 'admin sees toggle, on by default');
    assert.ok((await menuFor(env, USER)).includes(CART), 'user sees cart by default');
    await handleMessage(env, msg(USER, ON));
    assert.ok((await menuFor(env, USER)).includes(CART), 'user cannot toggle');

    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    assert.equal((await getCart(env, USER)).length, 1);

    await handleMessage(env, msg(SUPPORT, ON));
    assert.ok(menuButtons(last(SUPPORT)).includes(OFF), 'toggle updates label');
    assert.ok(!(await menuFor(env, USER)).includes(CART), 'hidden for users');
    assert.equal((await getCart(env, USER)).length, 1, 'cart contents survive');

    await handleCallbackQuery(env, cb(USER, 'cart:view'));
    assert.ok(alertText().includes('غیرفعال'), 'old cart buttons closed');
    await handleCallbackQuery(env, cb(USER, 'discount_no:cart:p'));
    assert.ok(last(USER).text.includes('غیرفعال'), 'cart invoice closed');

    // خرید مستقیم: تعداد ← روش تحویل ← پیش‌فاکتور
    await handleMessage(env, msg(USER, 'محصول 1'));
    assert.ok(callbacks(last(USER)).includes('qty:1:2') && !callbacks(last(USER)).includes('buy:1'), 'direct buy buttons');
    await handleCallbackQuery(env, cb(USER, 'qty:1:2'));
    assert.ok(callbacks(last(USER)).includes('os:1:p2'), 'asks delivery');
    await handleCallbackQuery(env, cb(USER, 'discount_no:1:p2'));
    assert.equal((await pending(env, USER)).amount, 200000, 'direct invoice');

    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    assert.ok(callbacks(last(USER)).includes('qty:1:1'), 'old add button becomes direct buy');
    assert.equal((await getCart(env, USER))[0].quantity, 1, 'cart untouched while off');

    await handleMessage(env, msg(ADMIN, OFF));
    assert.ok((await menuFor(env, USER)).includes(CART), 'back on');
    console.log('✅ cart switch: config file, bot button, direct buy');
  }

  // ---- قیمت خط‌خورده ----
  {
    const env = await makeEnv();
    await handleCallbackQuery(env, cb(ADMIN, 'pe:1:old_price'));
    await handleMessage(env, msg(ADMIN, '50000'));
    assert.ok(last(ADMIN).text.includes('بیشتر باشد'), 'must exceed price');
    await handleMessage(env, msg(ADMIN, '۱۵۰,۰۰۰'));
    assert.equal((await getFullProduct(env, '1')).oldPrice, 150000);

    await handleMessage(env, msg(USER, 'محصول 1'));
    assert.ok(last(USER).text.includes('<s>۱۵۰٬۰۰۰</s>') && last(USER).text.includes('تخفیف ویژه'), 'struck through');
    await handleCallbackQuery(env, cb(USER, 'discount_no:1:p1'));
    assert.equal((await pending(env, USER)).amount, 100000, 'invoice uses the sale price');

    await handleCallbackQuery(env, cb(ADMIN, 'pe:1:old_price'));
    await handleMessage(env, msg(ADMIN, '0'));
    await handleMessage(env, msg(USER, 'محصول 1'));
    assert.ok(!last(USER).text.includes('<s>'), 'removed with zero');
    console.log('✅ strikethrough price');
  }

  // ---- پنهان‌کردن ----
  {
    const env = await makeEnv();
    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    await handleCallbackQuery(env, cb(USER, 'discount_no:cart:p'));
    const open = await pending(env, USER);

    await handleCallbackQuery(env, cb(ADMIN, 'ph:1'));
    const menu = await menuFor(env, USER);
    assert.ok(!menu.includes('محصول 1') && menu.includes('محصول 2'), 'hidden from menu');
    assert.equal((await getCart(env, USER)).length, 0, 'leaves the cart view');
    await handleMessage(env, msg(USER, 'محصول 1'));
    assert.ok(!sent(USER).at(-1).body.text.includes('ویژگی تستی'), 'old menu button shows no product');
    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    assert.ok(alertText().includes('موجود نیست'), 'cannot add');
    await handleCallbackQuery(env, cb(USER, 'discount_no:1:p1'));
    assert.ok(last(USER).text.includes('موجود نیست'), 'cannot buy directly');

    // پیش‌فاکتور بازی که قبل از پنهان شدن صادر شده، رسیدش پذیرفته می‌شود ولی کیف پول بسته است
    assert.equal((await db.getOrder(env, open.id)).status, 'pending', 'open invoice stays');
    await handleCallbackQuery(env, cb(USER, `rcpt:${open.id}`));
    await handleMessage(env, photo(USER));
    assert.equal((await db.getOrder(env, open.id)).status, 'receipt_sent', 'receipt accepted');

    await handleCallbackQuery(env, cb(ADMIN, 'ph:2'));
    await handleCallbackQuery(env, cb(ADMIN, 'ph:1'));
    assert.ok((await menuFor(env, USER)).includes('محصول 1'), 'shown again');
    await handleCallbackQuery(env, cb(ADMIN, 'ph:1'));
    const adminMenu = await menuFor(env, ADMIN);
    assert.ok(adminMenu.includes('🛠 مدیریت محصولات'), 'manage button stays when all are hidden');
    console.log('✅ hide product');
  }

  // ---- امنیت ----
  {
    const env = await makeEnv();
    for (const data of ['dc_list', 'dc_new', 'dc_close', 'dcok', 'dcno', 'dcp:*', 'dcd:day', 'dcx:CONFIG5', 'ph:1', 'pe:1:old_price']) {
      await handleCallbackQuery(env, cb(USER, data));
      assert.ok(alertText().includes('دسترسی ندارید'), `${data}: denied`);
    }
    assert.equal((await getFullProduct(env, '1')).hidden, false);
    calls.length = 0;
    await handleMessage(env, msg(USER, '🎟 کدهای تخفیف'));
    assert.ok(!sent(USER).some((m) => callbacks(m).includes('dc_new')), 'user gets no panel');
    console.log('✅ access control');
  }
}

main().then(
  () => console.log('\nALL DISCOUNT-CART-SWITCH TESTS PASSED ✅'),
  (e) => {
    console.error('DISCOUNT-CART-SWITCH TEST FAILED:', e);
    process.exit(1);
  }
);
