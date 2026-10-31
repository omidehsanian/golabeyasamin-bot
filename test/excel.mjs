// تست خروجی اکسل: کاربران (/users و دکمه پنل) و همه‌ی سفارش‌ها؛ فقط برای سوپرادمین
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { readXlsx } from './xlsx_read.mjs';
import * as db from '../db.js';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { buildXlsx } from '../xlsx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '999';
const SUPPORT = '998';

const calls = [];
let nextId = 1;
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  if (opts.body instanceof FormData) {
    const doc = opts.body.get('document');
    body = { chat_id: opts.body.get('chat_id'), caption: opts.body.get('caption'), filename: doc?.name, bytes: new Uint8Array(await doc.arrayBuffer()) };
  } else {
    try {
      body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
    } catch (e) {}
  }
  calls.push({ method, body });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: nextId++ } }) };
};

function makeEnv() {
  const { prepare, batch, raw } = makeD1();
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));
  raw.exec(`INSERT INTO users (chat_id, full_name, username, phone, wallet, created_at) VALUES
    ('111', 'علی <تست> & "co"', 'ali', '09120000001', 25000, '2026-10-01 08:00:00'),
    ('222', NULL, NULL, NULL, 0, '2026-10-02 08:00:00'),
    ('333', 'سارا', 'sara', '09120000003', 0, '2026-10-03 08:00:00')`);
  raw.exec(`INSERT INTO referrals (referrer_id, invited_id) VALUES ('111', '333'), ('111', '222')`);
  return { DB: { prepare, batch }, BOT_TOKEN: 'T', ADMIN_CHAT_ID: ADMIN, SUPPORT_CHAT_ID: SUPPORT, CHANNEL_ENABLED: 'false' };
}

const msg = (from, text) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, text });
const cb = (from, data) => ({ id: `cb${nextId++}`, data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: nextId++ } });
const docs = (to) => calls.filter((c) => c.method === 'sendDocument' && String(c.body.chat_id) === to);

async function main() {
  // ---- سازگاری خود فایل xlsx ----
  {
    const bytes = buildXlsx([{ name: 'a/b:c*?[x]', columns: [{ header: 'h' }], rows: [['x\u0001y'], [null]] }]);
    const { files, sheets } = readXlsx(bytes);
    assert.ok(files['[Content_Types].xml'] && files['xl/styles.xml'] && files['xl/workbook.xml'], 'all parts present');
    assert.equal(sheets[0].name, 'a b c   x', 'invalid sheet-name characters removed');
    assert.equal(sheets[0].rows[1][0], 'xy', 'control characters stripped');
    assert.ok(files['xl/worksheets/sheet1.xml'].includes('rightToLeft="1"'), 'RTL sheet');
    console.log('✅ xlsx structure, sheet names and invalid characters');
  }

  // ---- اکسل کاربران ----
  {
    const env = makeEnv();
    await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 500000, status: 'confirmed' });
    await db.saveOrder(env, '111', 'canva', 'Canva', { amount: 90000, walletUsed: 90000, status: 'paid_by_wallet' });
    await db.saveOrder(env, '111', 'canva', 'Canva', { amount: 90000, status: 'rejected' });
    await db.saveOrder(env, '333', 'canva', 'Canva', { amount: 90000, status: 'receipt_sent' });

    calls.length = 0;
    await handleCallbackQuery(env, cb(ADMIN, 'adm_xls:users'));
    const [doc] = docs(ADMIN);
    assert.match(doc.body.filename, /^users-\d{4}-\d{2}-\d{2}\.xlsx$/);
    assert.ok(doc.body.caption.includes('۳') && doc.body.caption.includes('ثبت‌نام‌شده: ۲') && doc.body.caption.includes('خریدار: ۱'), 'caption summary');
    const [sheet] = readXlsx(doc.body.bytes).sheets;
    assert.equal(sheet.name, 'کاربران');
    const [header, ...rows] = sheet.rows;
    assert.equal(rows.length, 3);
    const col = (name) => header.indexOf(name);
    const ali = rows.find((r) => r[col('آیدی عددی')] === '111');
    assert.equal(ali[col('نام')], 'علی <تست> & "co"', 'special characters intact');
    assert.equal(ali[col('نام کاربری')], '@ali');
    assert.equal(ali[col('شماره تماس')], '09120000001', 'phone kept as text (leading zero)');
    assert.equal(ali[col('موجودی کیف پول')], 25000);
    assert.equal(ali[col('تعداد دعوت')], 2);
    assert.equal(ali[col('خریدهای تاییدشده')], 2, 'confirmed + paid_by_wallet, not rejected');
    assert.equal(ali[col('جمع خرید (تومان)')], 590000);
    const sara = rows.find((r) => r[col('آیدی عددی')] === '333');
    assert.equal(sara[col('معرف')], '111');
    assert.equal(sara[col('خریدهای تاییدشده')], 0, 'order under review not counted');
    const anon = rows.find((r) => r[col('آیدی عددی')] === '222');
    assert.equal(anon[col('ثبت‌نام')], 'خیر');
    console.log('✅ users excel: columns, totals, referrals');

    // /users هم فایل را می‌فرستد
    calls.length = 0;
    await handleMessage(env, msg(ADMIN, '/users'));
    assert.equal(docs(ADMIN).length, 1, '/users sends the excel file');
    console.log('✅ /users includes the excel file');
  }

  // ---- اکسل همه‌ی سفارش‌ها از پنل ----
  {
    const env = makeEnv();
    await db.saveOrder(env, '111', 'chatgpt', 'ChatGPT', { amount: 500000, walletUsed: 20000, status: 'confirmed' });
    await db.saveOrder(env, '333', 'capcut', 'CapCut Pro', { osType: 'ios', amount: 380000, status: 'rejected' });
    await db.saveOrder(env, '222', 'custom_bot', 'ساخت ربات', { status: 'new', note: 'فروشگاه لباس' });
    calls.length = 0;
    await handleCallbackQuery(env, cb(ADMIN, 'adm_xls:orders'));
    const [doc] = docs(ADMIN);
    assert.match(doc.body.filename, /^orders-all-\d{4}-\d{2}-\d{2}\.xlsx$/);
    const [header, ...rows] = readXlsx(doc.body.bytes).sheets[0].rows;
    assert.equal(rows.length, 3);
    const col = (name) => header.indexOf(name);
    const chat = rows.find((r) => r[col('محصول')] === 'ChatGPT');
    assert.equal(chat[col('نقدی')], 480000);
    assert.equal(chat[col('وضعیت')], '✅ تایید نهایی ادمین', 'Persian status label');
    assert.equal(rows.find((r) => r[col('محصول')] === 'CapCut Pro')[col('نسخه')], 'آیفون');
    const bot = rows.find((r) => r[col('محصول')] === 'ساخت ربات');
    assert.equal(bot[col('مبلغ (تومان)')], null, 'custom bot has no amount');
    assert.equal(bot[col('یادداشت')], 'فروشگاه لباس');
    assert.equal(typeof chat[col('شماره سفارش')], 'number');
    console.log('✅ all-orders excel from panel');

    // دسته‌ی خالی
    const empty = makeEnv();
    calls.length = 0;
    await handleCallbackQuery(empty, cb(ADMIN, 'adm_xls:orders'));
    assert.equal(docs(ADMIN).length, 0);
    assert.ok(calls.some((c) => String(c.body.text || '').includes('هیچ سفارشی')));
    console.log('✅ empty orders handled');
  }

  // ---- دسترسی ----
  {
    const env = makeEnv();
    for (const who of [SUPPORT, '111']) {
      for (const data of ['adm_xls:users', 'adm_xls:orders']) {
        calls.length = 0;
        await handleCallbackQuery(env, cb(who, data));
        assert.equal(docs(who).length, 0, `${who} ${data}: no file`);
        assert.ok(calls.find((c) => c.method === 'answerCallbackQuery').body.text.includes('دسترسی ندارید'));
      }
      calls.length = 0;
      await handleMessage(env, msg(who, '/users'));
      assert.equal(docs(who).length, 0, `${who} /users: no file`);
    }
    console.log('✅ only the super admin can export');
  }

  console.log('\nALL EXCEL TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('EXCEL TEST FAILED:', e);
  process.exit(1);
});
