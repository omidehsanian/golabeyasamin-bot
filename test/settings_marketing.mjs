// -*- تست پنل تنظیمات، کش‌بک با انقضا و یادآوری کد تخفیف -*-
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import * as db from '../db.js';
import {
  cashbackExpireDays,
  cashbackPercent,
  minOrderAmount,
  refreshRuntimeSettings,
} from '../config.js';
import { saveSetting } from '../settings.js';
import { processMarketingNotifications } from '../scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8');
const HOUR = 3600000;
const DAY = 24 * HOUR;

const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  if (method === 'sendMessage') sent.push({ chatId: String(body.chat_id), text: String(body.text || '') });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: sent.length } }) };
};

function freshEnv(extra = {}) {
  const { prepare, batch, raw } = makeD1();
  raw.exec(SCHEMA);
  return {
    env: {
      DB: { prepare, batch },
      BOT_TOKEN: 'test-token',
      CASHBACK_ENABLED: 'true',
      CASHBACK_PERCENT: '5',
      MIN_ORDER_AMOUNT: '500000',
      ...extra,
    },
    raw,
  };
}

async function main() {
  // ---------- ۱) تنظیمات ادمین روی env اولویت می‌گیرند ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    assert.equal(minOrderAmount(env), 500000, 'پیش‌فرض از wrangler.toml');
    assert.equal(cashbackPercent(env), 5, 'درصد پیش‌فرض کش‌بک');
    assert.equal(cashbackExpireDays(env), 30, 'اعتبار پیش‌فرض کش‌بک');

    await saveSetting(env, 'min_order_amount', '750000');
    await saveSetting(env, 'cashback_percent', '10');
    await saveSetting(env, 'cashback_expire_days', '45');
    await refreshRuntimeSettings(env);
    assert.equal(minOrderAmount(env), 750000, 'حداقل فاکتور از پنل اعمال شود');
    assert.equal(cashbackPercent(env), 10, 'درصد کش‌بک از پنل اعمال شود');
    assert.equal(cashbackExpireDays(env), 45, 'مدت اعتبار از پنل اعمال شود');

    await saveSetting(env, 'cashback_enabled', '0');
    await refreshRuntimeSettings(env);
    assert.equal(cashbackPercent(env), 0, 'خاموش‌کردن کش‌بک از پنل');
    console.log('✅ settings override OK');
  }

  // ---------- ۲) کش‌بک با تاریخ انقضا ساخته می‌شود ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    await db.ensureUser(env, '111');
    const orderId = await db.saveOrder(env, '111', '1', 'گلاب', { amount: 1000000, status: 'new' });
    const expiresAt = Date.now() + 30 * DAY;
    const res = await db.confirmOrder(env, orderId, { cashbackPercent: 10, cashbackExpiresAt: expiresAt });
    assert.equal(res.ok, true, 'سفارش تایید شود');
    assert.equal(await db.getWallet(env, '111'), 100000, 'کش‌بک به کیف پول اضافه شود');
    const rows = (await env.DB.prepare('SELECT * FROM cashback_credits WHERE chat_id = ?').bind('111').all()).results;
    assert.equal(rows.length, 1, 'یک ردیف اعتبار کش‌بک');
    assert.equal(Number(rows[0].remaining), 100000, 'باقی‌مانده اولیه');
    assert.equal(Number(rows[0].expires_at), expiresAt, 'تاریخ انقضا ذخیره شود');

    // تایید دوباره اعتبار جدید نمی‌سازد
    await db.confirmOrder(env, orderId, { cashbackPercent: 10, cashbackExpiresAt: expiresAt });
    const again = (await env.DB.prepare('SELECT COUNT(*) AS c FROM cashback_credits').first()).c;
    assert.equal(Number(again), 1, 'تایید تکراری اعتبار دوم نسازد');
    console.log('✅ cashback credit OK');
  }

  // ---------- ۳) مصرف کش‌بک با خرید از کیف پول ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    await db.ensureUser(env, '111');
    const orderId = await db.saveOrder(env, '111', '1', 'گلاب', { amount: 1000000, status: 'new' });
    await db.confirmOrder(env, orderId, { cashbackPercent: 50, cashbackExpiresAt: Date.now() + 30 * DAY });
    assert.equal(await db.getWallet(env, '111'), 500000, 'کیف پول بعد از کش‌بک');
    const used = await db.consumeCashback(env, '111', 200000);
    assert.equal(used, 200000, 'مبلغ مصرف‌شده');
    const row = await env.DB.prepare('SELECT remaining FROM cashback_credits WHERE chat_id = ?').bind('111').first();
    assert.equal(Number(row.remaining), 300000, 'باقی‌مانده بعد از مصرف');
    console.log('✅ cashback consumption OK');
  }

  // ---------- ۴) یادآوری ۲ روز مانده ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    await db.ensureUser(env, '111');
    await db.createCashbackCredit(env, { chatId: '111', orderId: null, amount: 40000, expiresAt: Date.now() + DAY });
    sent.length = 0;
    const now = new Date();
    const out = await processMarketingNotifications(env, now, 10);
    assert.equal(out.cashbackReminders, 1, 'یک یادآوری کش‌بک');
    assert.equal(sent.length, 1, 'یک پیام ارسال شود');
    assert.match(sent[0].text, /کش‌بک شما در حال انقضاست/, 'متن یادآوری');

    const out2 = await processMarketingNotifications(env, now, 10);
    assert.equal(out2.cashbackReminders, 0, 'یادآوری دوباره ارسال نشود');
    console.log('✅ cashback reminder OK');
  }

  // ---------- ۵) انقضای کش‌بک: کسر از کیف پول ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    await db.ensureUser(env, '111');
    await db.adminAdjustWallet(env, '111', 100000, 'test:seed');
    await db.createCashbackCredit(env, { chatId: '111', orderId: null, amount: 30000, expiresAt: Date.now() - 1000 });
    sent.length = 0;
    const out = await processMarketingNotifications(env, new Date(), 10);
    assert.equal(out.cashbackExpired, 1, 'یک کش‌بک منقضی');
    assert.equal(await db.getWallet(env, '111'), 70000, 'باقی‌مانده از کیف پول کسر شود');
    const row = await env.DB.prepare('SELECT expired_at FROM cashback_credits WHERE chat_id = ?').bind('111').first();
    assert.ok(row.expired_at, 'زمان انقضا ثبت شود');
    const tx = await env.DB.prepare("SELECT * FROM wallet_transactions WHERE idempotency_key LIKE 'cashback:%:expire'").first();
    assert.ok(tx, 'تراکنش کسر در دفتر مالی ثبت شود');

    // اجرای دوباره کسر نمی‌کند
    await processMarketingNotifications(env, new Date(), 10);
    assert.equal(await db.getWallet(env, '111'), 70000, 'کسر تکراری انجام نشود');
    console.log('✅ cashback expiry OK');
  }

  // ---------- ۶) یادآوری کد تخفیف برای کاربران استفاده‌نکرده ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    await db.ensureUser(env, '111');
    await db.ensureUser(env, '222');
    await db.saveDiscountCode(env, {
      code: 'YALDA10',
      percent: 10,
      productId: null,
      expiresAt: Date.now() + 4 * HOUR,
      createdBy: '999',
      duration: 'day',
    });
    // کاربر 111 کد را مصرف کرده است
    await db.recordDiscountUse(env, 'YALDA10', '111');

    sent.length = 0;
    const out = await processMarketingNotifications(env, new Date(), 10);
    assert.equal(out.discountNotices, 1, 'فقط یک نفر پیام بگیرد');
    assert.equal(sent.length, 1, 'یک پیام');
    assert.equal(sent[0].chatId, '222', 'یادآوری برای کاربری که کد را مصرف نکرده');
    assert.match(sent[0].text, /YALDA10/, 'نام کد در پیام');

    const out2 = await processMarketingNotifications(env, new Date(), 10);
    assert.equal(out2.discountNotices, 0, 'یادآوری تکراری ارسال نشود');
    console.log('✅ discount notice OK');
  }

  // ---------- ۷) خارج از بازه‌ی یادآوری، پیامی ارسال نمی‌شود ----------
  {
    const { env } = freshEnv();
    await refreshRuntimeSettings(env);
    await db.ensureUser(env, '111');
    await db.saveDiscountCode(env, {
      code: 'WEEK20',
      percent: 20,
      productId: null,
      expiresAt: Date.now() + 3 * DAY,
      createdBy: '999',
      duration: 'week',
    });
    sent.length = 0;
    await processMarketingNotifications(env, new Date(), 10);
    assert.equal(sent.length, 0, 'برای کد هفتگی با ۳ روز باقی‌مانده پیامی نرود');

    // با یک روز باقی‌مانده باید ارسال شود
    await env.DB.prepare('UPDATE discount_codes SET expires_at = ? WHERE code = ?')
      .bind(Date.now() + 20 * HOUR, 'WEEK20')
      .run();
    await processMarketingNotifications(env, new Date(), 10);
    assert.equal(sent.length, 1, 'یک روز مانده برای کد هفتگی پیام برود');
    console.log('✅ discount notice window OK');
  }

  console.log('🎉 همه‌ی تست‌های تنظیمات/کش‌بک/تخفیف پاس شدند');
}

main().catch((e) => {
  console.error('❌ تست شکست خورد:', e);
  process.exit(1);
});
