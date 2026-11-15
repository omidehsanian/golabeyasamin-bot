// تست مدیریت ادمین‌ها از داخل ربات: افزودن اینترپرایز/پشتیبانی، لیست اعضا، جستجو، تغییر نقش و حذف
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { adminIds, isAdmin, isSuperAdmin, refreshDbAdmins } from '../config.js';
import { normalizeDigits } from '../admin_admins.js';
import * as KB from '../keyboards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWNER = '999';
const FIXED_SUPPORT = '998';

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
  raw.exec(`INSERT INTO users (chat_id, full_name, phone, username) VALUES
    ('111', 'علی تست', '989121234567', 'ali'),
    ('222', 'سارا پشتیبان', '+989351112233', 'sara'),
    ('333', 'رضا', NULL, NULL),
    ('${OWNER}', 'مدیر', '09120000000', 'owner')`);
  for (let i = 0; i < 12; i++) raw.exec(`INSERT INTO users (chat_id, full_name) VALUES ('${5000 + i}', 'عضو ${i}')`);
  return { env: { DB: { prepare, batch }, BOT_TOKEN: 'T', CHANNEL_ENABLED: 'false', ADMIN_CHAT_ID: OWNER, SUPPORT_CHAT_ID: FIXED_SUPPORT }, raw };
}

const msg = (from, text) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, text });
const cb = (env, from, data, messageId = 77) =>
  handleCallbackQuery(env, { id: `cb${nextId++}`, data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: messageId } });
const last = (method, chatId) => calls.filter((c) => c.method === method && (chatId === undefined || String(c.body.chat_id) === String(chatId))).at(-1);
const buttons = (markup) => (markup?.inline_keyboard || []).flat();
const replyButtons = (markup) => (markup?.keyboard || []).flat().map((b) => b.text);
const alerts = () => calls.filter((c) => c.method === 'answerCallbackQuery').map((c) => c.body.text || '');

async function main() {
  assert.equal(normalizeDigits('۰۹۱۲۱۲۳'), '0912123');
  assert.equal(normalizeDigits('٠٩١٢'), '0912');

  const { env, raw } = makeEnv();

  // ---- بدون جدول admins (migration اجرا نشده) فقط ادمین‌های wrangler.toml ----
  {
    const { prepare, batch } = makeD1();
    const bare = { DB: { prepare, batch }, ADMIN_CHAT_ID: OWNER };
    await refreshDbAdmins(bare);
    assert.deepEqual(adminIds(bare), [OWNER]);
    console.log('✅ missing admins table falls back to config admins');
  }

  // ---- دکمه فقط برای سوپرادمین ----
  calls.length = 0;
  await handleMessage(env, msg(OWNER, '/start'));
  assert.ok(replyButtons(last('sendMessage', OWNER).body.reply_markup).includes(KB.ADMINS_BUTTON), 'owner sees admins button');
  await handleMessage(env, msg(FIXED_SUPPORT, '/start'));
  assert.ok(!replyButtons(last('sendMessage', FIXED_SUPPORT).body.reply_markup).includes(KB.ADMINS_BUTTON), 'support admin does not');

  calls.length = 0;
  await handleMessage(env, msg('111', KB.ADMINS_BUTTON));
  assert.ok(!calls.some((c) => String(c.body.text || '').includes('مدیریت ادمین‌ها')), 'regular user cannot open panel');
  await cb(env, '111', 'ad_add');
  assert.ok(alerts().some((t) => t.includes('دسترسی ندارید')), 'regular user callbacks blocked');
  await cb(env, FIXED_SUPPORT, 'ad_ok:s:111');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0, 'support admin cannot add admins');
  console.log('✅ admins panel is superadmin-only');

  // ---- پنل و انتخاب نقش ----
  calls.length = 0;
  await handleMessage(env, msg(OWNER, KB.ADMINS_BUTTON));
  let panel = last('sendMessage', OWNER);
  assert.ok(panel.body.text.includes('🔒') && panel.body.text.includes('مدیر'), 'config admins shown locked');
  assert.ok(buttons(panel.body.reply_markup).some((b) => b.callback_data === 'ad_add'));

  calls.length = 0;
  await cb(env, OWNER, 'ad_add');
  let edit = last('editMessageText');
  assert.deepEqual(buttons(edit.body.reply_markup).map((b) => b.callback_data), ['ad_r:s', 'ad_r:p', 'ad_list']);

  // ---- لیست اعضا با صفحه‌بندی ----
  calls.length = 0;
  await cb(env, OWNER, 'ad_r:p');
  edit = last('editMessageText');
  let picks = buttons(edit.body.reply_markup).filter((b) => b.callback_data.startsWith('ad_pk:p:'));
  assert.equal(picks.length, 8, 'first page has 8 members');
  assert.ok(buttons(edit.body.reply_markup).some((b) => b.callback_data === 'ad_r:p:1'), 'next page button');
  assert.ok(edit.body.text.includes('جستجو') || edit.body.text.includes('پیدا کردن'), 'search hint shown');
  calls.length = 0;
  await cb(env, OWNER, 'ad_r:p:1');
  edit = last('editMessageText');
  assert.ok(buttons(edit.body.reply_markup).some((b) => b.callback_data === 'ad_r:p:0'), 'prev page button');
  assert.ok(buttons(edit.body.reply_markup).some((b) => b.callback_data === 'ad_pk:p:222'), 'older members on page 2');
  console.log('✅ role picker and paginated member list');

  // ---- جستجو: شماره در قالب‌های مختلف، آیدی، نام کاربری، نام ----
  const search = async (q) => {
    calls.length = 0;
    await handleMessage(env, msg(OWNER, q));
    const m = last('sendMessage', OWNER);
    return buttons(m.body.reply_markup).filter((b) => b.callback_data.startsWith('ad_pk:')).map((b) => b.callback_data);
  };
  assert.deepEqual(await search('09121234567'), ['ad_pk:p:111'], 'phone with 0');
  assert.deepEqual(await search('۰۹۱۲۱۲۳۴۵۶۷'), ['ad_pk:p:111'], 'Persian digits');
  assert.deepEqual(await search('+98 935 111 2233'), ['ad_pk:p:222'], 'phone with +98 and spaces');
  assert.deepEqual(await search('222'), ['ad_pk:p:222'], 'chat id');
  assert.deepEqual(await search('@sara'), ['ad_pk:p:222'], 'username');
  assert.deepEqual(await search('رضا'), ['ad_pk:p:333'], 'name');
  assert.deepEqual(await search('nobody'), [], 'no result');
  assert.ok(last('sendMessage', OWNER).body.text.includes('پیدا نشد'));
  console.log('✅ member search by phone / id / username / name');

  // ---- افزودن ادمین پشتیبانی ----
  calls.length = 0;
  await cb(env, OWNER, 'ad_pk:p:222');
  edit = last('editMessageText');
  assert.ok(edit.body.text.includes('سارا پشتیبان') && edit.body.text.includes('تایید'), 'confirmation preview');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 0, 'not added before confirm');

  calls.length = 0;
  await cb(env, OWNER, 'ad_ok:p:222');
  assert.deepEqual(raw.prepare('SELECT chat_id, role, added_by FROM admins').all().map((r) => ({ ...r })), [{ chat_id: '222', role: 'support', added_by: OWNER }]);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE chat_id = '${OWNER}'`).get().n, 0, 'search session closed');
  let note = last('sendMessage', '222');
  assert.ok(note.body.text.includes('ادمین پشتیبانی'), 'new admin notified');
  assert.ok(replyButtons(note.body.reply_markup).includes(KB.NEW_PRODUCT_BUTTON), 'new admin gets admin keyboard');
  assert.ok(!replyButtons(note.body.reply_markup).includes(KB.ADMINS_BUTTON), 'support admin has no admins button');
  await refreshDbAdmins(env);
  assert.ok(isAdmin(env, '222') && !isSuperAdmin(env, '222'));
  assert.ok(adminIds(env).includes('222'), 'receives order alerts');
  console.log('✅ add support admin');

  // ادمین جدید واقعاً دسترسی دارد
  calls.length = 0;
  await handleMessage(env, msg('222', '/order 1'));
  assert.ok(last('sendMessage', '222').body.text.includes('پیدا نشد'), 'support admin can use /order');

  // ---- افزودن اینترپرایز ----
  calls.length = 0;
  await cb(env, OWNER, 'ad_r:s');
  await handleMessage(env, msg(OWNER, 'ali'));
  assert.ok(buttons(last('sendMessage', OWNER).body.reply_markup).some((b) => b.callback_data === 'ad_pk:s:111'));
  await cb(env, OWNER, 'ad_ok:s:111');
  note = last('sendMessage', '111');
  assert.ok(note.body.text.includes('اینترپرایز'));
  assert.ok(replyButtons(note.body.reply_markup).includes(KB.ADMINS_BUTTON) && replyButtons(note.body.reply_markup).includes(KB.ADMIN_ORDERS_BUTTON));
  calls.length = 0;
  await handleMessage(env, msg('111', KB.ADMINS_BUTTON));
  panel = last('sendMessage', '111');
  assert.ok(panel.body.text.includes('سارا پشتیبان') && panel.body.text.includes('علی تست'), 'new superadmin opens panel');
  console.log('✅ add enterprise admin, who can manage admins');

  // ---- قوانین: ادمین ثابت، تکراری، خودش ----
  calls.length = 0;
  await cb(env, OWNER, `ad_ok:p:${OWNER}`);
  assert.ok(alerts().some((t) => t.includes('wrangler.toml')), 'config admin cannot be changed');
  await cb(env, OWNER, 'ad_ok:p:222');
  assert.ok(alerts().some((t) => t.includes('همین الان')), 'already that role');
  await cb(env, '111', 'ad_rmok:111');
  assert.ok(alerts().some((t) => t.includes('خودتان')), 'cannot remove self');
  await cb(env, '111', `ad_rmok:${OWNER}`);
  assert.ok(alerts().some((t) => t.includes('wrangler.toml')), 'db superadmin cannot remove config owner');
  await cb(env, OWNER, 'ad_ok:p:424242');
  assert.ok(alerts().some((t) => t.includes('پیدا نشد')), 'unknown user');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM admins').get().n, 2);
  console.log('✅ guard rails (locked, duplicate, self, unknown)');

  // ---- تغییر نقش ----
  calls.length = 0;
  await cb(env, OWNER, 'ad_u:222');
  assert.ok(buttons(last('editMessageText').body.reply_markup).some((b) => b.callback_data === 'ad_sw:222'));
  await cb(env, OWNER, 'ad_sw:222');
  assert.equal(raw.prepare(`SELECT role FROM admins WHERE chat_id = '222'`).get().role, 'super');
  assert.ok(replyButtons(last('sendMessage', '222').body.reply_markup).includes(KB.ADMINS_BUTTON), 'promoted admin keyboard');
  console.log('✅ switch role');

  // ---- حذف ----
  raw.exec(`INSERT INTO sessions (chat_id, state, data) VALUES ('222', 'awaiting_discount_admin', '{}')`);
  calls.length = 0;
  await cb(env, OWNER, 'ad_rm:222');
  assert.ok(buttons(last('editMessageText').body.reply_markup).some((b) => b.callback_data === 'ad_rmok:222'), 'remove asks to confirm');
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM admins WHERE chat_id = '222'`).get().n, 1);
  await cb(env, OWNER, 'ad_rmok:222');
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM admins WHERE chat_id = '222'`).get().n, 0);
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE chat_id = '222'`).get().n, 0, 'removed admin session cleared');
  note = last('sendMessage', '222');
  assert.ok(note.body.text.includes('برداشته شد'));
  assert.ok(!replyButtons(note.body.reply_markup).includes(KB.NEW_PRODUCT_BUTTON), 'removed admin gets user keyboard');
  calls.length = 0;
  await handleMessage(env, msg('222', '/order 1'));
  assert.ok(!calls.some((c) => String(c.body.text || '').includes('پیدا نشد')), 'removed admin lost access');
  console.log('✅ remove admin');

  // ---- خروج از جستجو با دکمه‌ی منو ----
  await cb(env, OWNER, 'ad_r:p');
  calls.length = 0;
  await handleMessage(env, msg(OWNER, KB.WALLET_BUTTON));
  assert.equal(raw.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE chat_id = '${OWNER}'`).get().n, 0, 'menu button leaves search');
  assert.ok(!calls.some((c) => String(c.body.text || '').includes('نتیجه‌ی جستجو')), 'menu button not treated as search');
  console.log('✅ menu button exits search');

  console.log('\n🎉 admins tests passed');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
