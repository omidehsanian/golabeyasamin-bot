// تست حداقل مبلغ سفارش (MIN_ORDER_AMOUNT): سبد خرید، خرید مستقیم و دکمه‌های قدیمی روش تحویل
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { setTestPrice } from './products_helper.mjs';
import { handleCallbackQuery } from '../callback.js';
import { minOrderAmount } from '../config.js';
import { minOrderText } from '../flows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');

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

async function freshEnv(extra = {}) {
  const { prepare, batch, raw } = makeD1();
  raw.exec(SCHEMA);
  const env = {
    DB: { prepare, batch },
    BOT_TOKEN: 'TEST',
    ADMIN_CHAT_ID: '999',
    CHANNEL_ENABLED: 'false',
    CARD_NUMBER: '1111',
    CARD_HOLDER: 'Test',
    DISCOUNT_ENABLED: 'false',
    MIN_ORDER_AMOUNT: '500000',
    ...extra,
  };
  await db.ensureUser(env, '111');
  await db.saveRegistration(env, '111', { phone_number: '09121111111', first_name: 'U' });
  await setTestPrice(env, 1, 350000);
  await setTestPrice(env, 2, 150000);
  return env;
}

const click = (env, data) =>
  handleCallbackQuery(env, { id: `cb-${msgId++}`, data, from: { id: 111 }, message: { chat: { id: 111 }, message_id: msgId++ } });
const lastText = () => calls.filter((c) => c.method === 'sendMessage').at(-1)?.body.text || '';
const pending = (env) => env.DB.prepare("SELECT * FROM orders WHERE user_id = '111' AND status = 'pending'").first();

async function main() {
  assert.equal(minOrderAmount({}), 0, 'default: no minimum');
  assert.equal(minOrderAmount({ MIN_ORDER_AMOUNT: '0' }), 0);
  assert.equal(minOrderAmount({ MIN_ORDER_AMOUNT: 'abc' }), 0);
  assert.equal(minOrderAmount({ MIN_ORDER_AMOUNT: '500000' }), 500000);
  assert.equal(minOrderText({ MIN_ORDER_AMOUNT: '500000' }, 500000), null, 'exactly the minimum is allowed');
  assert.ok(minOrderText({ MIN_ORDER_AMOUNT: '500000' }, 350000).includes('۱۵۰٬۰۰۰'), 'shows the shortfall');
  console.log('✅ MIN_ORDER_AMOUNT parsing');

  // ---- سبد خرید: ۳۵۰ هزار کمتر از حداقل ----
  {
    const env = await freshEnv();
    await click(env, 'buy:1');
    calls.length = 0;
    await click(env, 'cart:checkout');
    assert.ok(lastText().includes('حداقل مبلغ سفارش'), 'cart checkout blocked');
    assert.ok(!calls.some((c) => String(c.body.text || '').includes('روش تحویل')), 'no delivery prompt');
    // دکمه‌ی روش تحویل پیام قدیمی هم پیش‌فاکتور نمی‌سازد
    await click(env, 'cart:ship:p');
    assert.equal(await pending(env), null, 'no invoice below minimum');

    // با افزودن محصول دوم به ۵۰۰ هزار می‌رسد
    await click(env, 'buy:2');
    calls.length = 0;
    await click(env, 'cart:checkout');
    assert.ok(lastText().includes('روش تحویل'), 'at minimum → delivery prompt');
    await click(env, 'cart:ship:p');
    assert.equal(Number((await pending(env)).amount), 500000, 'invoice created at minimum');
    console.log('✅ cart respects minimum order');
  }

  // ---- خرید مستقیم (سبد خاموش) ----
  {
    const env = await freshEnv({ CART_ENABLED: 'false' });
    calls.length = 0;
    await click(env, 'qty:1:1');
    assert.ok(lastText().includes('حداقل مبلغ سفارش'), '1 × 350k blocked');
    await click(env, 'os:1:p1');
    assert.equal(await pending(env), null, 'old delivery button blocked too');
    calls.length = 0;
    await click(env, 'qty:1:2');
    assert.ok(lastText().includes('روش تحویل'), '2 × 350k allowed');
    await click(env, 'os:1:p2');
    assert.equal(Number((await pending(env)).amount), 700000);
    console.log('✅ direct buy respects minimum order');
  }

  // ---- بدون تنظیم: رفتار قبلی ----
  {
    const env = await freshEnv({ MIN_ORDER_AMOUNT: '' });
    await click(env, 'buy:2');
    await click(env, 'cart:checkout');
    await click(env, 'cart:ship:p');
    assert.equal(Number((await pending(env)).amount), 150000, 'no minimum when unset');
    console.log('✅ no minimum when unset');
  }

  console.log('\n🎉 min order tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
