// تست سرتاسری مسیر اصلی کاربر با هندلرهای واقعی و یک API تلگرام شبیه‌سازی‌شده
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { listProducts } from '../products.js';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { prepare, batch, raw } = makeD1();
raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));

const env = {
  DB: { prepare, batch },
  BOT_TOKEN: 'TEST_TOKEN',
  ADMIN_CHAT_ID: '999',
  SUPPORT_CHAT_ID: '998',
  BOT_USERNAME: 'TestBot',
  CHANNEL_USERNAME: 'test_channel',
  CARD_NUMBER: '1111-2222-3333-4444',
  CARD_HOLDER: 'Test Holder',
  REFERRAL_REWARD: '10000',
  SIGNUP_BONUS: '20000',
  REFERRAL_COMMISSION_PERCENT: '10',
  DISCOUNT_ENABLED: 'false',
};

// ---- fetch mock: captures every outgoing Telegram API call ----
const calls = [];
let messageIdCounter = 1;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  calls.push({ method, body });
  const result = method === 'getChatMember' ? { status: 'member' } : { message_id: messageIdCounter++ };
  return { ok: true, json: async () => ({ ok: true, result }) };
};

const textsSentTo = (chatId) =>
  calls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === String(chatId)).map((c) => c.body.text);
const msg = (chatId, extra) => ({ chat: { id: Number(chatId) }, from: { id: Number(chatId) }, message_id: messageIdCounter++, ...extra });
const cb = (chatId, data) => ({ id: `cb${messageIdCounter++}`, data, from: { id: Number(chatId) }, message: { chat: { id: Number(chatId) }, message_id: messageIdCounter++ } });

async function main() {
  const USER = '111';
  const FRIEND = '222';
  const ADMIN = env.ADMIN_CHAT_ID;

  // 1) /start -> channel join prompt
  await handleMessage(env, msg(USER, { text: '/start' }));
  assert.ok(textsSentTo(USER).some((t) => t.includes('عضو شوید')), '/start prompts channel join');
  console.log('✅ /start prompts channel join');

  // 2) membership confirmed -> registration prompt
  calls.length = 0;
  await handleCallbackQuery(env, cb(USER, 'check_membership'));
  assert.equal(await db.isChannelConfirmed(env, USER), true);
  assert.ok(textsSentTo(USER).some((t) => t.includes('ثبت‌نام')), 'asks for registration');
  console.log('✅ membership check -> registration prompt');

  // 3) contact -> signup bonus
  calls.length = 0;
  await handleMessage(env, msg(USER, { contact: { user_id: Number(USER), phone_number: '0912111', first_name: 'Ali', last_name: 'R' } }));
  assert.equal(await db.getWallet(env, USER), 20000);
  console.log('✅ registration grants signup bonus');

  // 4) friend joins via referral link: relation recorded, no reward yet
  await handleMessage(env, msg(FRIEND, { text: `/start ${USER}` }));
  assert.equal(await db.getReferrerOf(env, FRIEND), USER);
  assert.equal(await db.getWallet(env, USER), 20000);
  console.log('✅ referral recorded without paying at /start');

  // 5) admin builds a product inside the bot: name → features → photo → price → position → confirm
  const say = (text) => handleMessage(env, msg(ADMIN, { text }));
  await say('➕ ساخت محصول');
  await say('🎧 هدفون بی‌سیم');
  await say('بلوتوث ۵.۳\nباتری ۳۰ ساعته');
  await say('عکس نیست'); // در مرحله‌ی عکس متن پذیرفته نمی‌شود
  await handleMessage(env, msg(ADMIN, { photo: [{ file_id: 'small' }, { file_id: 'product-photo' }] }));
  await say('۲۵,۰۰۰ تومان');
  await say('1');
  assert.equal((await db.getSession(env, ADMIN)).data.step, 'confirm', 'preview before saving');
  assert.equal((await listProducts(env)).length, 0, 'nothing saved before confirm');
  calls.length = 0;
  await handleCallbackQuery(env, cb(ADMIN, 'pnew_ok'));
  const [product] = await listProducts(env);
  assert.deepEqual(
    { title: product.title, description: product.description, photo: product.photoFileId, price: product.price, position: product.position },
    { title: '🎧 هدفون بی‌سیم', description: 'بلوتوث ۵.۳\nباتری ۳۰ ساعته', photo: 'product-photo', price: 25000, position: 1 }
  );
  const menu = calls.find((c) => c.method === 'sendMessage' && c.body.reply_markup?.keyboard)?.body.reply_markup.keyboard;
  assert.equal(menu[0][0].text, '🎧 هدفون بی‌سیم', 'product button is first in the menu');
  assert.ok(menu.flat().some((b) => b.text === '🛠 مدیریت محصولات'), 'manage button appears once a product exists');
  console.log('✅ admin builds a product step by step');

  // non-admin cannot use product admin buttons
  calls.length = 0;
  await handleCallbackQuery(env, cb(USER, `pdok:${product.id}`));
  assert.equal((await listProducts(env)).length, 1, 'non-admin cannot delete');

  // user opens the product from its menu button -> photo with caption and buy button
  calls.length = 0;
  await handleMessage(env, msg(USER, { text: '🎧 هدفون بی‌سیم' }));
  const photo = calls.find((c) => c.method === 'sendPhoto');
  assert.equal(photo.body.photo, 'product-photo');
  assert.ok(photo.body.caption.includes('باتری ۳۰ ساعته') && photo.body.caption.includes('۲۵٬۰۰۰'));
  assert.equal(photo.body.reply_markup.inline_keyboard[0][0].callback_data, `buy:${product.id}`);
  console.log('✅ user sees product photo, features and price');

  // 6) friend registers, buys with receipt, admin confirms -> referrer gets reward + commission
  await db.setChannelConfirmed(env, FRIEND);
  await handleMessage(env, msg(FRIEND, { contact: { user_id: Number(FRIEND), phone_number: '0912222', first_name: 'F' } }));
  calls.length = 0;
  await handleCallbackQuery(env, cb(FRIEND, 'buy:1'));
  assert.ok(textsSentTo(FRIEND).some((t) => t.includes('پیش‌فاکتور')), 'invoice shown');
  await handleCallbackQuery(env, cb(FRIEND, 'receipt:1:'));
  await handleMessage(env, msg(FRIEND, { photo: [{ file_id: 'receipt-photo' }] }));
  const order = await env.DB.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').bind(FRIEND).first();
  assert.equal(order.status, 'receipt_sent');
  assert.equal(order.wallet_used, 20000, 'signup bonus applied to invoice');
  console.log('✅ receipt flow creates order');

  await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${order.id}`));
  assert.equal((await db.getOrder(env, order.id)).status, 'confirmed');
  assert.equal(await db.getWallet(env, FRIEND), 0, 'wallet credit deducted on confirm');
  // پاداش دعوت 10,000 + کمیسیون 10% از (25,000 - 20,000) = 500
  assert.equal(await db.getWallet(env, USER), 20000 + 10000 + 500);
  console.log('✅ admin confirm deducts wallet once and pays referrer');

  console.log('\nALL INTEGRATION TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('INTEGRATION TEST FAILED:', e);
  process.exit(1);
});
