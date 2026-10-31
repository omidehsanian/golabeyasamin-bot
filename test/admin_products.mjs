// تست‌های ساخت و مدیریت محصول از داخل ربات (➕ ساخت محصول / 🛠 مدیریت محصولات)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { parsePriceInput } from '../admin_products.js';
import { addProduct, listProducts } from '../products.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '999';
const SUPPORT = '998';
const USER = '111';

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

function makeEnv() {
  const { prepare, batch, raw } = makeD1();
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));
  return { DB: { prepare, batch }, BOT_TOKEN: 'T', ADMIN_CHAT_ID: ADMIN, SUPPORT_CHAT_ID: SUPPORT, CHANNEL_ENABLED: 'false' };
}

const say = (env, from, text) => handleMessage(env, { chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, text });
const photo = (env, from, fileId) =>
  handleMessage(env, { chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, photo: [{ file_id: fileId }] });
const press = (env, from, data) =>
  handleCallbackQuery(env, { id: `cb${nextId++}`, data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: nextId++ } });
const lastText = (id) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === id).at(-1)?.body.text || '';
const lastMenu = (id) =>
  calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === id && c.body.reply_markup?.keyboard).at(-1)?.body.reply_markup.keyboard;
const alerts = () => calls.filter((c) => c.method === 'answerCallbackQuery' && c.body.show_alert).map((c) => c.body.text);
const order = async (env) => (await listProducts(env)).map((p) => p.title).join(',');

async function seed(env, ...titles) {
  for (const [i, title] of titles.entries()) {
    await addProduct(env, { title, description: `ویژگی ${title}`, photoFileId: `ph-${title}`, price: 1000 * (i + 1), position: i + 1 });
  }
}

async function build(env, from, { title, description = 'ویژگی', file = 'ph', price = '5000', position = '1' }) {
  await say(env, from, '➕ ساخت محصول');
  await say(env, from, title);
  await say(env, from, description);
  await photo(env, from, file);
  await say(env, from, price);
  await say(env, from, position);
}

async function main() {
  // ---- price parsing ----
  assert.equal(parsePriceInput('۲۵۰,۰۰۰ تومان'), 250000);
  assert.equal(parsePriceInput('250٬000'), 250000);
  assert.equal(parsePriceInput('12a'), null);
  console.log('✅ price input parsing');

  {
    // admin menu with no products: only «ساخت محصول»
    const env = makeEnv();
    await say(env, ADMIN, '/start');
    await say(env, ADMIN, '🔙 شاید بعدا');
    const buttons = lastMenu(ADMIN).flat().map((b) => b.text);
    assert.ok(buttons.includes('➕ ساخت محصول'));
    assert.ok(!buttons.includes('🛠 مدیریت محصولات'));
    // normal user never sees admin buttons
    await say(env, USER, '🔙 شاید بعدا');
    assert.ok(!lastMenu(USER).flat().some((b) => b.text === '➕ ساخت محصول'));
    console.log('✅ empty shop: admin sees only «ساخت محصول»');
  }

  {
    // insert at a chosen position among existing products; menu order follows positions
    const env = makeEnv();
    await seed(env, 'A', 'B', 'C');
    await build(env, ADMIN, { title: 'NEW', position: '2' });
    await press(env, ADMIN, 'pnew_ok');
    assert.equal(await order(env), 'A,NEW,B,C');
    assert.deepEqual(lastMenu(ADMIN).slice(0, 2).map((r) => r.map((b) => b.text)), [['A', 'NEW'], ['B', 'C']]);
    console.log('✅ new product lands in the chosen position');
  }

  {
    // validation at each step keeps the admin on the same step
    const env = makeEnv();
    await seed(env, 'A');
    await say(env, ADMIN, '➕ ساخت محصول');
    await say(env, ADMIN, 'A');
    assert.match(lastText(ADMIN), /همین نام/);
    await say(env, ADMIN, 'x'.repeat(41));
    assert.match(lastText(ADMIN), /حداکثر/);
    await say(env, ADMIN, '/abc');
    assert.equal((await db.getSession(env, ADMIN)).data.step, 'title');
    await say(env, ADMIN, 'B');
    await say(env, ADMIN, 'y'.repeat(851));
    assert.equal((await db.getSession(env, ADMIN)).data.step, 'description');
    await say(env, ADMIN, 'ویژگی B');
    await handleMessage(env, { chat: { id: 999 }, from: { id: 999 }, message_id: nextId++, document: { file_id: 'doc' } });
    assert.match(lastText(ADMIN), /نه فایل/);
    await photo(env, ADMIN, 'ph-B');
    await say(env, ADMIN, '0');
    await say(env, ADMIN, 'ارزان');
    assert.equal((await db.getSession(env, ADMIN)).data.step, 'price');
    await say(env, ADMIN, '7000');
    await say(env, ADMIN, '3'); // فقط ۱ یا ۲ مجاز است
    assert.equal((await db.getSession(env, ADMIN)).data.step, 'position');
    await say(env, ADMIN, '2');
    assert.equal((await db.getSession(env, ADMIN)).data.step, 'confirm');
    await press(env, ADMIN, 'pnew_ok');
    assert.equal(await order(env), 'A,B');
    // the same confirm button cannot create a second copy
    calls.length = 0;
    await press(env, ADMIN, 'pnew_ok');
    assert.equal((await listProducts(env)).length, 2);
    assert.ok(alerts().some((t) => t.includes('منقضی')));
    console.log('✅ step validation and single confirm');
  }

  {
    // cancel / leaving the form saves nothing
    const env = makeEnv();
    await build(env, ADMIN, { title: 'X' });
    await say(env, ADMIN, '🔙 انصراف');
    assert.equal((await listProducts(env)).length, 0);
    assert.equal((await db.getSession(env, ADMIN)).state, null);
    await say(env, ADMIN, '➕ ساخت محصول');
    await say(env, ADMIN, 'Y');
    await say(env, ADMIN, '💼 موجودی کیف پول'); // دکمه‌ی منو در وسط فرم = خروج
    assert.equal((await db.getSession(env, ADMIN)).state, null);
    await build(env, ADMIN, { title: 'Z' });
    await press(env, ADMIN, 'pnew_no');
    assert.equal((await listProducts(env)).length, 0);
    console.log('✅ cancel saves nothing');
  }

  {
    // edit every field, move and delete from the manage panel
    const env = makeEnv();
    await seed(env, 'A', 'B', 'C');
    const [a, b] = await listProducts(env);
    await say(env, SUPPORT, '🛠 مدیریت محصولات'); // ادمین پشتیبانی هم دسترسی دارد
    assert.match(lastText(SUPPORT), /مدیریت محصولات/);

    await press(env, SUPPORT, `pe:${a.id}:title`);
    await say(env, SUPPORT, 'B');
    assert.match(lastText(SUPPORT), /همین نام/);
    await say(env, SUPPORT, 'A2');
    await press(env, SUPPORT, `pe:${a.id}:description`);
    await say(env, SUPPORT, 'ویژگی جدید');
    await press(env, SUPPORT, `pe:${a.id}:photo`);
    await photo(env, SUPPORT, 'ph-new');
    await press(env, SUPPORT, `pe:${a.id}:price`);
    await say(env, SUPPORT, '۹۹۰۰۰');
    const edited = (await listProducts(env)).find((p) => p.id === a.id);
    assert.deepEqual(
      { t: edited.title, d: edited.description, p: edited.photoFileId, price: edited.price },
      { t: 'A2', d: 'ویژگی جدید', p: 'ph-new', price: 99000 }
    );

    await press(env, SUPPORT, `pe:${a.id}:position`);
    await say(env, SUPPORT, '4'); // فقط ۱ تا ۳
    await say(env, SUPPORT, '3');
    assert.equal(await order(env), 'B,C,A2');

    await press(env, SUPPORT, `pd:${b.id}`);
    assert.equal((await listProducts(env)).length, 3, 'asks before deleting');
    await press(env, SUPPORT, `pdok:${b.id}`);
    assert.equal(await order(env), 'C,A2');
    assert.deepEqual((await listProducts(env)).map((p) => p.position), [1, 2]);
    console.log('✅ edit, move and delete from the manage panel');
  }

  {
    // non-admins cannot reach any product admin path
    const env = makeEnv();
    await seed(env, 'A');
    const [a] = await listProducts(env);
    calls.length = 0;
    await say(env, USER, '➕ ساخت محصول');
    assert.equal((await db.getSession(env, USER)).state, null);
    for (const data of ['pa_new', 'pa_list', `pe:${a.id}:price`, `pdok:${a.id}`, 'pnew_ok']) await press(env, USER, data);
    assert.equal(alerts().filter((t) => t.includes('دسترسی ندارید')).length, 5);
    assert.equal(await order(env), 'A');
    console.log('✅ non-admins are blocked');
  }

  {
    // HTML in a product name is escaped in the caption
    const env = makeEnv();
    await seed(env, 'R&D <pro>');
    calls.length = 0;
    await say(env, USER, 'R&D <pro>');
    const sent = calls.find((c) => c.method === 'sendPhoto');
    assert.ok(sent.body.caption.includes('R&amp;D &lt;pro&gt;'));
    console.log('✅ product name is HTML-escaped');
  }

  console.log('\nALL ADMIN-PRODUCTS TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('ADMIN-PRODUCTS TEST FAILED:', e);
  process.exit(1);
});
