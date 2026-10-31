// تست‌های /order، webhook secret و پیام خلاصه‌ی لغو خودکار برای ادمین
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { handleMessage } from '../message.js';
import { processPendingOrders } from '../scheduler.js';
import { parseOrderNumber } from '../admin_orders.js';
import worker from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '999';
const SUPPORT = '998';

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

function makeEnv(extra = {}) {
  const { prepare, batch, raw } = makeD1();
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));
  raw.exec(`INSERT INTO users (chat_id, full_name, phone, username) VALUES ('111', 'علی تست', '0912', 'ali')`);
  return { env: { DB: { prepare, batch }, BOT_TOKEN: 'T', ADMIN_CHAT_ID: ADMIN, SUPPORT_CHAT_ID: SUPPORT, ...extra }, raw };
}

const msg = (from, text) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, text });
const textsTo = (id) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === id);

async function main() {
  // ---- parseOrderNumber ----
  assert.equal(parseOrderNumber('100026'), 26);
  assert.equal(parseOrderNumber('#100026'), 26);
  assert.equal(parseOrderNumber('26'), 26);
  assert.equal(parseOrderNumber('10001000'), 1000);
  assert.equal(parseOrderNumber('abc'), null);
  assert.equal(parseOrderNumber(''), null);
  console.log('✅ order number parsing');

  // ---- /order ----
  {
    const { env, raw } = makeEnv();
    raw.exec(`INSERT INTO orders (id, user_id, product_id, product_title, amount, wallet_used, status)
              VALUES (26, '111', 'chatgpt', 'ChatGPT Plus', 500000, 20000, 'receipt_sent'),
                     (27, '111', 'canva', 'Canva Pro', 90000, 0, 'confirmed')`);

    calls.length = 0;
    await handleMessage(env, msg(ADMIN, '/order 100026'));
    let [m] = textsTo(ADMIN);
    assert.ok(m.body.text.includes('#100026') && m.body.text.includes('علی تست') && m.body.text.includes('@ali'), 'details shown');
    assert.equal(m.body.reply_markup.inline_keyboard[0][0].callback_data, 'confirm_order:26', 'reviewable → confirm button');

    calls.length = 0;
    await handleMessage(env, msg(SUPPORT, '/order 27'));
    [m] = textsTo(SUPPORT);
    assert.ok(m.body.text.includes('#100027'), 'support admin can look up');
    assert.equal(m.body.reply_markup, undefined, 'confirmed order → no buttons');

    calls.length = 0;
    await handleMessage(env, msg(ADMIN, '/order 100099'));
    assert.ok(textsTo(ADMIN)[0].body.text.includes('پیدا نشد'), 'not found');

    calls.length = 0;
    await handleMessage(env, msg('111', '/order 100026'));
    assert.ok(!calls.some((c) => String(c.body.text || '').includes('علی تست')), 'regular user gets no order details');
    console.log('✅ /order lookup');
  }

  // ---- webhook secret ----
  {
    const update = JSON.stringify({ message: msg('111', '/id') });
    const req = (headers = {}) => new Request('https://bot.example/', { method: 'POST', body: update, headers });

    let { env } = makeEnv({ WEBHOOK_SECRET: 's3cret' });
    calls.length = 0;
    assert.equal((await worker.fetch(req(), env, {})).status, 401, 'missing secret rejected');
    assert.equal((await worker.fetch(req({ 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }), env, {})).status, 401, 'wrong secret rejected');
    assert.equal(calls.length, 0, 'rejected requests do nothing');
    assert.equal((await worker.fetch(req({ 'X-Telegram-Bot-Api-Secret-Token': 's3cret' }), env, {})).status, 200, 'right secret accepted');
    assert.equal(calls.length, 1, 'accepted request handled');

    ({ env } = makeEnv());
    calls.length = 0;
    assert.equal((await worker.fetch(req(), env, {})).status, 200, 'no secret configured → accepted (backward compatible)');
    console.log('✅ webhook secret');
  }

  // ---- خلاصه‌ی لغو خودکار برای ادمین ----
  {
    const { env, raw } = makeEnv();
    raw.exec(`INSERT INTO orders (id, user_id, product_id, product_title, amount, status, checkout_step, created_at) VALUES
      (40, '111', 'chatgpt', 'ChatGPT Plus', 500000, 'pending', 'awaiting_receipt', datetime('now', '-2 hours'))`);
    raw.exec(`INSERT INTO users (chat_id) VALUES ('222')`);
    raw.exec(`INSERT INTO orders (id, user_id, product_id, product_title, amount, status, checkout_step, created_at) VALUES
      (41, '222', 'canva', 'Canva Pro', 90000, 'pending', 'invoice', datetime('now', '-2 hours'))`);

    calls.length = 0;
    const summary = await processPendingOrders(env, new Date());
    assert.equal(summary.cancelled, 2);
    const notices = textsTo(ADMIN);
    assert.equal(notices.length, 1, 'one combined admin notice');
    const t = notices[0].body.text;
    assert.ok(t.includes('2 سفارش') && t.includes('100040') && t.includes('100041'), 'lists cancelled orders');
    assert.ok(/100040[^\n]*رسید/.test(t) && !/100041[^\n]*رسید/.test(t), 'flags only the order awaiting receipt');
    assert.equal(textsTo(SUPPORT).length, 0, 'support not spammed');

    calls.length = 0;
    await processPendingOrders(env, new Date());
    assert.equal(textsTo(ADMIN).length, 0, 'no repeat notice on next run');
    console.log('✅ admin notice on auto-cancel');
  }

  console.log('\nALL ADMIN-EXTRAS TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('ADMIN-EXTRAS TEST FAILED:', e);
  process.exit(1);
});
