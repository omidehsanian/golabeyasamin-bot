// تست‌های پنل سفارش‌های ادمین و یکتایی شماره سفارش‌ها
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { readXlsx } from './xlsx_read.mjs';
import * as db from '../db.js';
import { setTestPrice } from './products_helper.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { processPendingOrders } from '../scheduler.js';
import { orderNumber } from '../admin_orders.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
const ADMIN = '999';
const SUPPORT = '998';

const calls = [];
let msgId = 1;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  if (opts.body instanceof FormData) {
    const doc = opts.body.get('document');
    body = { chat_id: opts.body.get('chat_id'), caption: opts.body.get('caption'), filename: doc?.name, mime: doc?.type, bytes: doc ? new Uint8Array(await doc.arrayBuffer()) : null };
  } else {
    try {
      body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
    } catch (e) {}
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
      SUPPORT_CHAT_ID: SUPPORT,
      BOT_USERNAME: 'TestBot',
      CHANNEL_USERNAME: 'c',
      CARD_NUMBER: '1',
      CARD_HOLDER: 'T',
      DISCOUNT_ENABLED: 'false',
    },
    raw,
  };
}

async function makeUser(env, chatId, { name = `User${chatId}`, phone = `0912${chatId}`, username = null } = {}) {
  await db.ensureUser(env, chatId);
  await db.setChannelConfirmed(env, chatId);
  await db.saveRegistration(env, chatId, { phone_number: phone, first_name: name });
  if (username) await db.rememberUsername(env, chatId, username);
}

const cb = (fromId, data) => ({ id: `cb-${Math.random()}`, data, from: { id: Number(fromId) }, message: { chat: { id: Number(fromId) }, message_id: msgId++ } });
const textsTo = (chatId) => calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId)).map((c) => c.body.text);
const buttonsTo = (chatId) =>
  calls
    .filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId))
    .flatMap((c) => (c.body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data || b.text));
const docsTo = (chatId) => calls.filter((c) => c.method === 'sendDocument' && String(c.body.chat_id) === String(chatId));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ----------------------------------------------------------------------------
test('دکمه «📦 سفارشات» فقط در منوی سوپرادمین است و پنل دسته‌ها را باز می‌کند', async () => {
  const { env } = freshEnv();
  await makeUser(env, ADMIN);
  await makeUser(env, '111');

  await handleMessage(env, { chat: { id: 111 }, from: { id: 111 }, text: '/start', message_id: msgId++ });
  const userMenu = calls.filter((c) => String(c.body.chat_id) === '111').flatMap((c) => (c.body.reply_markup?.keyboard || []).flat().map((b) => b.text));
  assert.ok(!userMenu.includes('📦 سفارشات'), 'کاربر عادی دکمه را نبیند');

  calls.length = 0;
  await handleMessage(env, { chat: { id: Number(ADMIN) }, from: { id: Number(ADMIN) }, text: '/start', message_id: msgId++ });
  const adminMenu = calls.filter((c) => String(c.body.chat_id) === ADMIN).flatMap((c) => (c.body.reply_markup?.keyboard || []).flat().map((b) => b.text));
  assert.ok(adminMenu.includes('📦 سفارشات'));

  for (const trigger of ['📦 سفارشات', '/orders']) {
    calls.length = 0;
    await handleMessage(env, { chat: { id: Number(ADMIN) }, from: { id: Number(ADMIN) }, text: trigger, message_id: msgId++ });
    assert.deepEqual(buttonsTo(ADMIN), ['adm_ord:all', 'adm_ord:confirmed', 'adm_ord:rejected', 'adm_ord:review', 'adm_ord:awaiting_address', 'adm_ord:invoices', 'adm_xls:orders', 'adm_xls:users']);
  }

  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:confirmed'));
  assert.deepEqual(buttonsTo(ADMIN), ['adm_ord:confirmed:last', 'adm_ord:confirmed:report', 'adm_orders']);
});

test('کاربر عادی و ادمین پشتیبانی به پنل و جزئیات دسترسی ندارند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', { phone: '09120000111' });
  await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 100, status: 'confirmed' });
  for (const who of ['111', SUPPORT]) {
    calls.length = 0;
    await handleMessage(env, { chat: { id: Number(who) }, from: { id: Number(who) }, text: '📦 سفارشات', message_id: msgId++ });
    for (const data of ['adm_orders', 'adm_ord:all', 'adm_ord:all:last', 'adm_ord:all:report', 'ord_type:store']) {
      await handleCallbackQuery(env, cb(who, data));
    }
    assert.ok(!textsTo(who).some((t) => String(t).includes('09120000111') || String(t).includes('گزارش کل')), `${who} نباید جزئیات ببیند`);
    assert.equal(docsTo(who).length, 0);
  }
});

test('۱۰ سفارش آخر با جزئیات کامل: نام، شماره، آیدی، chat_id، شماره سفارش، محصول و مبلغ', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', { name: 'سارا', phone: '09121112233', username: 'sara_shop' });
  const ids = [];
  for (let i = 0; i < 12; i++) {
    ids.push(await db.saveOrder(env, '111', 'capcut', 'CapCut Pro', { osType: 'c2', amount: 400000 + i, walletUsed: 20000, status: 'confirmed' }));
  }
  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:confirmed:last'));
  const out = textsTo(ADMIN).join('\n');
  for (const id of ids.slice(2)) assert.ok(out.includes(`#${orderNumber(id)}`), `سفارش ${id} باید باشد`);
  for (const id of ids.slice(0, 2)) assert.ok(!out.includes(`#${orderNumber(id)}<`), `سفارش قدیمی ${id} نباید باشد`);
  assert.equal((out.match(/🧾 <b>سفارش #/g) || []).length, 10);
  for (const s of ['سارا', '09121112233', '@sara_shop', '<code>111</code>', 'CapCut Pro (۲ عدد · 🛵 ارسال با پیک)', 'کیف پول', 'نقدی', 'تایید نهایی']) {
    assert.ok(out.includes(s), `باید شامل «${s}» باشد`);
  }
  assert.ok(textsTo(ADMIN).every((t) => t.length < 4096));
});

test('هر دسته فقط سفارش‌های خودش را نشان می‌دهد؛ لغو توسط ادمین جدا از لغو خودکار', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  const confirmed = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 1, status: 'confirmed' });
  const wallet = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 1, status: 'paid_by_wallet' });
  const rejected = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 1, status: 'rejected' });
  const review = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 1, status: 'receipt_sent' });
  const bot = await db.saveOrder(env, '111', 'custom_bot', 'سفارش ساخت ربات', { status: 'new', note: 'نام ربات: تست' });

  const seen = async (key) => {
    calls.length = 0;
    await handleCallbackQuery(env, cb(ADMIN, `adm_ord:${key}:last`));
    const out = textsTo(ADMIN).join('\n');
    return [confirmed, wallet, rejected, review, bot].filter((id) => out.includes(`#${orderNumber(id)}<`));
  };
  assert.deepEqual(await seen('confirmed'), [confirmed, wallet]);
  assert.deepEqual(await seen('rejected'), [rejected]);
  assert.deepEqual(await seen('review'), [review, bot]);
  assert.deepEqual((await seen('all')).sort(), [confirmed, wallet, rejected, review, bot].sort());
});

test('فاکتورهای باز و لغو خودکار از دید ادمین پنهان نیستند (با دلیل لغو)', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await makeUser(env, '222');
  await setTestPrice(env, 1, 25000);
  await handleCallbackQuery(env, cb('111', 'os:1:p1'));
  await handleCallbackQuery(env, cb('222', 'os:1:p1'));
  const p222 = await env.DB.prepare("SELECT id FROM orders WHERE user_id = '222'").first();
  await env.DB.prepare('UPDATE orders SET created_at = ? WHERE id = ?').bind(db.sqlTime(new Date(Date.now() - 61 * 60000)), p222.id).run();
  await processPendingOrders(env, new Date());

  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:invoices:last'));
  const out = textsTo(ADMIN).join('\n');
  assert.ok(out.includes('پیش‌فاکتور باز'));
  assert.ok(out.includes('لغو خودکار'));
  assert.ok(out.includes('عدم تکمیل در یک ساعت'));
  assert.equal((out.match(/🧾 <b>سفارش #/g) || []).length, 2);

  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:all:last'));
  assert.equal((textsTo(ADMIN).join('\n').match(/🧾 <b>سفارش #/g) || []).length, 2, 'در «همه» هم دیده شوند');
});

test('گزارش کل: جمع‌ها درست، تفکیک وضعیت و محصول، و فایل اکسل همه‌ی سفارش‌ها', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', { name: 'Ali, "A"', phone: '0912111' });
  await makeUser(env, '222', { name: 'Reza', phone: '0912222' });
  await db.saveOrder(env, '111', 'capcut', 'CapCut Pro', { amount: 400000, walletUsed: 20000, status: 'confirmed' });
  await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 6000000, walletUsed: 0, status: 'confirmed' });
  await db.saveOrder(env, '222', 'capcut', 'CapCut Pro', { amount: 420000, walletUsed: 420000, status: 'paid_by_wallet' });
  await db.saveOrder(env, '222', 'canva', 'Canva', { amount: 220000, status: 'rejected' }); // نباید در «تایید نهایی» شمرده شود
  await db.saveOrder(env, '222', 'chatgpt', 'ChatGPT', { amount: 4500000, walletUsed: -40000, status: 'confirmed' }); // داده‌ی قدیمی با wallet_used منفی

  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:confirmed:report'));
  const report = textsTo(ADMIN).find((t) => t.includes('گزارش کل'));
  const fa = (n) => n.toLocaleString('fa-IR');
  assert.ok(report.includes(`تعداد سفارش: ${fa(4)}`));
  assert.ok(report.includes(`تعداد مشتری: ${fa(2)}`));
  assert.ok(report.includes(`جمع مبلغ: ${fa(11320000)}`));
  assert.ok(report.includes(`از کیف پول: ${fa(440000)}`), 'wallet_used منفی صفر حساب شود');
  assert.ok(report.includes(`نقدی (کارت‌به‌کارت): ${fa(10880000)}`));
  assert.ok(report.includes('به تفکیک وضعیت') && report.includes('به تفکیک محصول'));
  assert.ok(report.includes('CapCut Pro') && report.includes('ChatGPT'));

  const [doc] = docsTo(ADMIN);
  assert.ok(doc, 'فایل اکسل ارسال شود');
  assert.match(doc.body.filename, /^orders-confirmed-\d{4}-\d{2}-\d{2}\.xlsx$/);
  assert.equal(doc.body.mime, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const [sheet] = readXlsx(doc.body.bytes).sheets;
  assert.equal(sheet.name, 'سفارش‌ها');
  assert.equal(sheet.rows.length, 1 + 4);
  assert.deepEqual(sheet.rows[0].slice(0, 3), ['شماره سفارش', 'وضعیت', 'تاریخ ثبت']);
  const flat = sheet.rows.flat();
  assert.ok(flat.includes('Ali, "A"'), 'نام با کاما و کوتیشن سالم بماند');
  assert.ok(!flat.includes('Canva'), 'سفارش ردشده در این دسته نباشد');
  const amountCol = sheet.rows[0].indexOf('مبلغ (تومان)');
  assert.equal(sheet.rows.slice(1).reduce((n, r) => n + r[amountCol], 0), 11320000, 'مبلغ‌ها عدد واقعی و قابل جمع باشند');
  const walletCol = sheet.rows[0].indexOf('از کیف پول');
  assert.ok(sheet.rows.slice(1).every((r) => r[walletCol] >= 0), 'wallet_used منفی صفر باشد');
});

test('نام و یادداشت حاوی HTML باعث خراب شدن پیام نمی‌شوند (escape)', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111', { name: '<b>hack</b> & co' });
  await db.saveOrder(env, '111', 'custom_bot', 'سفارش ساخت ربات', { status: 'new', note: 'فعالیت: <script>x</script>' });
  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:review:last'));
  const out = textsTo(ADMIN).join('\n');
  assert.ok(out.includes('&lt;b&gt;hack&lt;/b&gt; &amp; co'));
  assert.ok(out.includes('&lt;script&gt;'));
  assert.ok(!out.includes('<script>'));
});

test('خروجی بلند به چند پیام زیر سقف تلگرام تقسیم می‌شود', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  for (let i = 0; i < 10; i++) {
    await db.saveOrder(env, '111', 'custom_bot', 'سفارش ساخت ربات', { status: 'new', note: 'ت'.repeat(390) });
  }
  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:review:last'));
  const msgs = textsTo(ADMIN);
  assert.ok(msgs.length > 1);
  assert.ok(msgs.every((t) => t.length < 4096));
  assert.equal((msgs.join('\n').match(/🧾 <b>سفارش #/g) || []).length, 10);
});

test('دسته‌ی خالی پیام مناسب می‌دهد و دکمه‌های قدیمی /orders به پنل جدید می‌روند', async () => {
  const { env } = freshEnv();
  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:rejected:last'));
  await handleCallbackQuery(env, cb(ADMIN, 'adm_ord:rejected:report'));
  assert.equal(textsTo(ADMIN).filter((t) => t.includes('هیچ سفارشی')).length, 2);
  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'ord_fetch:store:20'));
  assert.ok(buttonsTo(ADMIN).includes('adm_ord:all'));
});

test('شماره سفارش‌ها: یکتا، بدون استفاده‌ی مجدد، و فاکتورهای باز/لغوشده با سفارش‌های دیگر تداخل ندارند', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await makeUser(env, '222');
  await setTestPrice(env, 1, 25000);
  await setTestPrice(env, 2, 90000);

  const legacy = await db.saveOrder(env, '222', 'capcut', 'CapCut', { amount: 1, status: 'confirmed' });
  await handleCallbackQuery(env, cb('111', 'os:1:p1')); // pending
  await handleCallbackQuery(env, cb('111', 'os:2:p1')); // قبلی superseded، pending جدید
  const receipt = await db.saveOrder(env, '222', 'capcut', 'CapCut', { amount: 1, status: 'receipt_sent' });

  // حذف آخرین ردیف و درج دوباره: AUTOINCREMENT شماره را دوباره استفاده نمی‌کند
  await env.DB.prepare('DELETE FROM orders WHERE id = ?').bind(receipt).run();
  const after = await db.saveOrder(env, '222', 'capcut', 'CapCut', { amount: 1, status: 'receipt_sent' });
  assert.ok(after > receipt, 'شماره‌ی حذف‌شده دوباره استفاده نشود');

  const { results } = await env.DB.prepare('SELECT id, status FROM orders ORDER BY id').all();
  const ids = results.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  const numbers = ids.map(orderNumber);
  assert.equal(new Set(numbers).size, numbers.length, 'شماره‌ی نمایشی هم یکتا باشد');
  assert.ok(results.some((r) => r.status === 'cancelled') && results.some((r) => r.status === 'pending'));
  assert.equal(results.find((r) => r.id === legacy).status, 'confirmed', 'سفارش قبلی دست نخورد');

  // دکمه‌های ادمین با شناسه‌ی خام کار می‌کنند و فقط روی همان سفارش اثر دارند
  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${after}`));
  const final = await env.DB.prepare('SELECT id, status FROM orders ORDER BY id').all();
  assert.deepEqual(
    final.results.map((r) => r.status),
    results.map((r) => (r.id === after ? 'confirmed' : r.status))
  );
});

test('یکتایی شماره‌ی نمایشی (1000 + id) برای بازه‌ی بزرگ شناسه‌ها', async () => {
  const seen = new Set();
  for (let id = 1; id <= 200000; id++) seen.add(orderNumber(id));
  assert.equal(seen.size, 200000);
});

test('نام کاربری تلگرام در مراحل خرید ذخیره می‌شود', async () => {
  const { env } = freshEnv();
  await makeUser(env, '111');
  await setTestPrice(env, 1, 25000);
  await handleCallbackQuery(env, { ...cb('111', 'os:1:p1'), from: { id: 111, username: 'new_name' } });
  assert.equal((await db.getUser(env, '111')).username, 'new_name');
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
console.log(`\n${tests.length - failed}/${tests.length} admin-orders tests passed`);
if (failed) process.exit(1);
console.log('ALL ADMIN-ORDERS TESTS PASSED ✅');
