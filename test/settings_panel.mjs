// -*- تست پنل ادمین «تنظیمات فروشگاه» -*-
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import { minOrderAmount, cashbackPercent, refreshRuntimeSettings } from '../config.js';
import { SETTINGS_SESSION_STATE, handleSettingsCallback, handleSettingsInput, showSettingsPanel } from '../admin_settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
const ADMIN = '999';

const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  sent.push({ method, body });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
};

const { prepare, batch, raw } = makeD1();
raw.exec(SCHEMA);
const env = {
  DB: { prepare, batch },
  BOT_TOKEN: 'test-token',
  ADMIN_CHAT_ID: ADMIN,
  CASHBACK_ENABLED: 'true',
  CASHBACK_PERCENT: '5',
  MIN_ORDER_AMOUNT: '500000',
  DISCOUNT_ENABLED: 'true',
};

async function main() {
  await refreshRuntimeSettings(env);
  await db.ensureUser(env, ADMIN);

  // پنل: مقادیر فعلی و دکمه‌ها
  sent.length = 0;
  await showSettingsPanel(env, ADMIN);
  const panel = sent.at(-1);
  assert.equal(panel.method, 'sendMessage');
  assert.match(panel.body.text, /تنظیمات فروشگاه/);
  assert.match(panel.body.text, /۵۰۰٬۰۰۰ تومان/, 'حداقل فاکتور فعلی نمایش داده شود');
  const buttons = panel.body.reply_markup.inline_keyboard.flat();
  assert.ok(buttons.some((b) => b.callback_data === 'set:edit:min_order_amount'), 'دکمه ویرایش حداقل فاکتور');
  console.log('✅ settings panel render OK');

  // ویرایش حداقل فاکتور از طریق callback + ورودی متنی
  sent.length = 0;
  await handleSettingsCallback(env, ADMIN, ADMIN, 'set:edit:min_order_amount', 'cb1', 42);
  const prompt = sent.at(-1);
  assert.equal(prompt.method, 'sendMessage');
  assert.match(prompt.body.text, /مقدار جدید/);

  const session = await db.getSession(env, ADMIN);
  assert.equal(session.state, SETTINGS_SESSION_STATE, 'سشن ویرایش تنظیمات');
  assert.equal(session.data.key, 'min_order_amount');

  await handleSettingsInput(env, ADMIN, session, '۹۰۰٬۰۰۰');
  assert.equal(minOrderAmount(env), 900000, 'مقدار جدید (با ارقام فارسی و جداکننده) اعمال شود');
  assert.equal(await db.getSession(env, ADMIN).then((s) => s.state), null, 'سشن بسته شود');
  console.log('✅ settings edit (persian digits) OK');

  // ورودی نامعتبر رد شود و سشن باز بماند
  await db.setSession(env, ADMIN, SETTINGS_SESSION_STATE, { step: 'value', key: 'cashback_percent' });
  const bad = await db.getSession(env, ADMIN);
  sent.length = 0;
  await handleSettingsInput(env, ADMIN, bad, '۱۵۰');
  assert.match(sent.at(-1).body.text, /بین 0 و 100/, 'درصد بیش از ۱۰۰ رد شود');
  assert.ok(await db.getSession(env, ADMIN).then((s) => s.state), 'سشن برای اصلاح باز بماند');
  console.log('✅ settings validation OK');

  // خاموش‌کردن کش‌بک با دکمه‌ی toggle
  await db.clearSession(env, ADMIN);
  await handleSettingsCallback(env, ADMIN, ADMIN, 'set:toggle:cashback_enabled', 'cb2', 43);
  await refreshRuntimeSettings(env);
  assert.equal(cashbackPercent(env), 0, 'کش‌بک خاموش شود');
  assert.equal(await db.getSetting(env, 'cashback_enabled'), '0', 'مقدار در دیتابیس ذخیره شود');
  console.log('✅ settings toggle OK');

  // خاموش‌کردن سیستم کد تخفیف از پنل، همان کلید discount_active را عوض می‌کند
  await handleSettingsCallback(env, ADMIN, ADMIN, 'set:toggle:discount_active', 'cb4', 45);
  assert.equal(await db.getSetting(env, 'discount_active'), '0', 'سیستم تخفیف از پنل خاموش شود');
  assert.equal(await db.isDiscountActive(env), false, 'تخفیف واقعاً غیرفعال شود');
  await handleSettingsCallback(env, ADMIN, ADMIN, 'set:toggle:discount_active', 'cb5', 46);
  assert.equal(await db.isDiscountActive(env), true, 'و با دکمه‌ی بعدی دوباره روشن شود');
  console.log('✅ discount toggle from panel OK');

  // بستن پنل
  sent.length = 0;
  await handleSettingsCallback(env, ADMIN, ADMIN, 'set:close', 'cb3', 44);
  assert.match(sent.at(-1).body.text, /بسته شد/);
  console.log('🎉 همه‌ی تست‌های پنل تنظیمات پاس شدند');
}

main().catch((e) => {
  console.error('❌ تست شکست خورد:', e);
  process.exit(1);
});
