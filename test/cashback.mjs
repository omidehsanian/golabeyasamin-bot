// تست کش‌بک خریدار: تنظیم/غیرفعال‌سازی، محاسبه روی مبلغ نقدی، یک‌بار پرداخت، پیام و پیش‌فاکتور
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { setTestPrice } from './products_helper.mjs';
import { handleCallbackQuery } from '../callback.js';
import { handleMessage } from '../message.js';
import { cashbackPercent } from '../config.js';

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
  raw.exec(`INSERT INTO users (chat_id, wallet, phone) VALUES ('111', 50000, '0912'), ('222', 0, '0913')`);
  const env = { DB: { prepare, batch }, BOT_TOKEN: 'T', ADMIN_CHAT_ID: ADMIN, SUPPORT_CHAT_ID: SUPPORT, CHANNEL_ENABLED: 'false', CARD_NUMBER: '1111', CARD_HOLDER: 'X', ...extra };
  return { env, raw };
}

const ON = { CASHBACK_ENABLED: 'true', CASHBACK_PERCENT: '5' };
const cb = (from, data) => ({ id: `cb${nextId++}`, data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: nextId++, text: 'x' } });
const wallet = (env, id) => db.getWallet(env, id);
const cashbackRows = async (env) => (await env.DB.prepare("SELECT * FROM wallet_transactions WHERE type = 'cashback'").all()).results;
const cashbackMessages = (to) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === to && c.body.text.includes('کش‌بک خرید'));

async function main() {
  // ---- تنظیمات ----
  assert.equal(cashbackPercent({}), 0, 'off by default');
  assert.equal(cashbackPercent({ CASHBACK_PERCENT: '5' }), 0, 'percent alone does not enable');
  assert.equal(cashbackPercent({ CASHBACK_ENABLED: 'true' }), 5, 'enabled without percent = default 5%');
  assert.equal(cashbackPercent({ CASHBACK_ENABLED: 'true', CASHBACK_PERCENT: '0' }), 0, 'percent 0 = off');
  assert.equal(cashbackPercent({ CASHBACK_ENABLED: 'false', CASHBACK_PERCENT: '5' }), 0, 'disabled flag wins');
  assert.equal(cashbackPercent({ CASHBACK_ENABLED: 'TRUE', CASHBACK_PERCENT: '7.5' }), 7.5);
  assert.equal(cashbackPercent({ CASHBACK_ENABLED: 'true', CASHBACK_PERCENT: '150' }), 0, 'invalid percent = off');
  assert.equal(cashbackPercent({ CASHBACK_ENABLED: 'true', CASHBACK_PERCENT: 'abc' }), 0, 'invalid percent = off');
  console.log('✅ config: enable / disable / invalid values');

  // ---- خاموش: هیچ کش‌بکی ----
  {
    const { env } = makeEnv();
    const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 500000, walletUsed: 20000, status: 'receipt_sent' });
    calls.length = 0;
    await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`));
    assert.equal((await db.getOrder(env, o)).status, 'confirmed');
    assert.equal(await wallet(env, '111'), 30000, 'only the wallet debit');
    assert.equal((await cashbackRows(env)).length, 0);
    assert.equal(cashbackMessages('111').length, 0, 'no cashback message when disabled');
    console.log('✅ disabled: no cashback, no message');
  }

  // ---- روشن: ۵٪ از مبلغ نقدی، یک‌بار ----
  {
    const { env } = makeEnv(ON);
    // ۵۰۰,۰۰۰ قیمت، ۲۰,۰۰۰ از کیف پول → نقدی ۴۸۰,۰۰۰ → کش‌بک ۲۴,۰۰۰
    const o = await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 500000, walletUsed: 20000, status: 'receipt_sent' });
    calls.length = 0;
    await Promise.all([
      handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`)),
      handleCallbackQuery(env, cb(SUPPORT, `confirm_order:${o}`)),
    ]);
    await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${o}`));
    assert.equal(await wallet(env, '111'), 50000 - 20000 + 24000, 'debit + cashback exactly once');
    const rows = await cashbackRows(env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, 24000);
    assert.equal(rows[0].order_id, o);
    assert.equal(rows[0].idempotency_key, `order:${o}:cashback`);
    assert.equal(rows[0].balance_after, 54000);
    const msgs = cashbackMessages('111');
    assert.equal(msgs.length, 1, 'one cashback message');
    assert.ok(msgs[0].body.text.includes('۲۴٬۰۰۰') && msgs[0].body.text.includes(`1000${o}`), 'message shows amount and order');
    console.log('✅ enabled: 5% of cash part, credited once, buyer notified');
  }

  // ---- مسیر کامل با کد تخفیف + کیف پول: کش‌بک روی مبلغ نهایی پرداختی ----
  {
    const { env } = makeEnv({ ...ON, DISCOUNT_ENABLED: 'true', DISCOUNT_CODES: 'GIRL:10' });
    await setTestPrice(env, 1, 300000);
    // ۳۰۰,۰۰۰ − ۱۰٪ تخفیف = ۲۷۰,۰۰۰ − ۵۰,۰۰۰ کیف پول = ۲۲۰,۰۰۰ نقدی → کش‌بک ۱۱,۰۰۰
    await handleCallbackQuery(env, cb('111', 'discount_yes:1:'));
    await handleMessage(env, { chat: { id: 111 }, from: { id: 111 }, message_id: nextId++, text: 'girl' });
    const pending = await env.DB.prepare("SELECT * FROM orders WHERE status = 'pending'").first();
    assert.equal(pending.amount, 270000, 'discount applied');
    assert.equal(pending.wallet_used, 50000, 'wallet applied');
    await handleCallbackQuery(env, cb('111', `rcpt:${pending.id}`));
    await handleMessage(env, { chat: { id: 111 }, from: { id: 111 }, message_id: nextId++, photo: [{ file_id: 'r' }] });
    assert.equal((await db.getOrder(env, pending.id)).status, 'receipt_sent');
    await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${pending.id}`));
    const [row] = await cashbackRows(env);
    assert.equal(row.amount, 11000, '5% of final cash paid (after discount and wallet)');
    assert.equal(await wallet(env, '111'), 50000 - 50000 + 11000);
    console.log('✅ discount code + wallet: cashback on final amount paid');
  }

  // ---- سفارش رد شده / ساخت ربات / پرداخت کامل با کیف پول: بدون کش‌بک ----
  {
    const { env } = makeEnv(ON);
    const rejected = await db.saveOrder(env, '222', 'chatgpt', 'ChatGPT', { amount: 300000, status: 'receipt_sent' });
    await handleCallbackQuery(env, cb(ADMIN, `reject_order:${rejected}`));
    await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${rejected}`));
    const bot = await db.saveOrder(env, '222', 'custom_bot', 'ساخت ربات', { amount: 1000000, status: 'new' });
    await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${bot}`));
    assert.equal((await cashbackRows(env)).length, 0, 'no cashback for rejected or custom bot');
    assert.equal(await wallet(env, '222'), 0);

    await setTestPrice(env, 2, 40000);
    await handleCallbackQuery(env, cb('111', 'walletpay:2:'));
    assert.equal(await wallet(env, '111'), 10000, 'full wallet purchase: no cashback on wallet money');
    assert.equal((await cashbackRows(env)).length, 0);
    console.log('✅ no cashback for rejected, custom bot or full-wallet orders');
  }

  // ---- پیش‌فاکتور ----
  {
    let { env } = makeEnv(ON);
    await setTestPrice(env, 1, 300000);
    calls.length = 0;
    await handleCallbackQuery(env, cb('222', 'buy:1'));
    let invoice = calls.find((c) => c.method === 'sendMessage' && c.body.text.includes('پیش‌فاکتور'));
    assert.ok(invoice.body.text.includes('کش‌بک') && invoice.body.text.includes('۱۵٬۰۰۰'), 'invoice shows cashback');

    ({ env } = makeEnv());
    await setTestPrice(env, 1, 300000);
    calls.length = 0;
    await handleCallbackQuery(env, cb('222', 'buy:1'));
    invoice = calls.find((c) => c.method === 'sendMessage' && c.body.text.includes('پیش‌فاکتور'));
    assert.ok(!invoice.body.text.includes('کش‌بک'), 'no cashback line when disabled');
    console.log('✅ invoice shows cashback only when enabled');
  }

  console.log('\nALL CASHBACK TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('CASHBACK TEST FAILED:', e);
  process.exit(1);
});
