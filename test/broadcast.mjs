// تست پیام همگانی خودکار: صف با پیام ادمین ساخته می‌شود، Cron دسته‌ها را خودش می‌فرستد
// و در پایان یک‌بار گزارش نتیجه برای ادمین ارسال می‌شود.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import { processBroadcastQueue } from '../flows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '999';

// legacy = جدول broadcast_queue قدیمی (بدون photo_id و created_at)، مثل دیتابیس اصلی
function makeEnv({ legacy = false, users = ['111', '222', '333'], batch } = {}) {
  const { prepare, batch: dbBatch, raw } = makeD1();
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));
  if (legacy) {
    raw.exec(`DROP TABLE broadcast_queue;
      CREATE TABLE broadcast_queue (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, text TEXT, status TEXT DEFAULT 'pending');`);
  }
  for (const id of users) raw.prepare('INSERT INTO users (chat_id) VALUES (?)').run(id);
  const env = { DB: { prepare, batch: dbBatch }, BOT_TOKEN: 'TEST_TOKEN', ADMIN_CHAT_ID: ADMIN, SUPPORT_CHAT_ID: '998' };
  if (batch) env.BROADCAST_BATCH_SIZE = String(batch);
  return { env, raw };
}

const calls = [];
let nextId = 1;
let failFor = new Set();
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop();
  let body = {};
  try {
    body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {};
  } catch (e) {}
  calls.push({ method, body });
  if (failFor.has(String(body.chat_id))) {
    return { ok: true, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
  }
  return { ok: true, json: async () => ({ ok: true, result: { message_id: nextId++ } }) };
};

const msg = (extra) => ({ chat: { id: Number(ADMIN) }, from: { id: Number(ADMIN) }, message_id: nextId++, ...extra });
const cb = (data) => ({ id: `cb${nextId++}`, data, from: { id: Number(ADMIN) }, message: { chat: { id: Number(ADMIN) }, message_id: nextId++ } });
const adminTexts = () => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === ADMIN).map((c) => c.body.text);
const copies = () => calls.filter((c) => c.method === 'copyMessage');
const reports = () => adminTexts().filter((t) => t.includes('به پایان رسید'));

async function startBroadcast(env, payload) {
  calls.length = 0;
  await handleMessage(env, msg({ text: '📢 ارسال پیام همگانی' }));
  const source = msg(payload);
  await handleMessage(env, source);
  assert.ok(adminTexts().some((t) => t.includes('صف پیام همگانی ساخته شد')), 'queue created');
  assert.ok(adminTexts().some((t) => t.includes('خودکار')), 'admin told it is automatic');
  assert.equal(copies().length, 0, 'nothing sent before cron');
  calls.length = 0;
  return source;
}

async function runCronUntilDone(env, max = 20) {
  for (let i = 0; i < max; i++) {
    const r = await processBroadcastQueue(env);
    if (r.finished) return i + 1;
  }
  throw new Error('broadcast never finished');
}

function assertCopiedToAll(source, label, users = ['111', '222', '333']) {
  assert.deepEqual(copies().map((c) => c.body.chat_id).sort(), [...users].sort(), `${label}: copied to every user exactly once`);
  for (const c of copies()) {
    assert.equal(c.body.from_chat_id, ADMIN, `${label}: from admin chat`);
    assert.equal(c.body.message_id, source.message_id, `${label}: original message`);
  }
  assert.equal(reports().length, 1, `${label}: exactly one final report`);
  assert.ok(reports()[0].includes(`موفق: ${users.length} | ❌ ناموفق: 0`), `${label}: summary`);
}

async function main() {
  for (const legacy of [false, true]) {
    const tag = legacy ? ' (legacy table)' : '';

    let { env } = makeEnv({ legacy });
    let src = await startBroadcast(env, { photo: [{ file_id: 'small' }, { file_id: 'big' }], caption: 'عکس <b>تست</b>' });
    await runCronUntilDone(env);
    assertCopiedToAll(src, 'photo');
    console.log(`✅ photo broadcast${tag}`);

    ({ env } = makeEnv({ legacy }));
    src = await startBroadcast(env, { video: { file_id: 'vid1' } });
    await runCronUntilDone(env);
    assertCopiedToAll(src, 'video');
    console.log(`✅ video broadcast without caption${tag}`);

    ({ env } = makeEnv({ legacy }));
    src = await startBroadcast(env, { text: 'سلام به همه' });
    await runCronUntilDone(env);
    assertCopiedToAll(src, 'text');
    console.log(`✅ text broadcast${tag}`);
  }

  // چند دسته‌ای: بدون هیچ کلیکی، در چند اجرای Cron تمام می‌شود و فقط یک گزارش می‌آید
  {
    const users = Array.from({ length: 23 }, (_, i) => String(1000 + i));
    const { env } = makeEnv({ users, batch: 5 });
    const src = await startBroadcast(env, { text: 'چند دسته' });
    const runs = await runCronUntilDone(env);
    assert.equal(runs, 5, '23 users / 5 per run = 5 runs');
    assertCopiedToAll(src, 'multi-batch', users);
    await processBroadcastQueue(env);
    await processBroadcastQueue(env);
    assert.equal(reports().length, 1, 'no extra report after finish');
    assert.equal(copies().length, 23, 'no resend after finish');
    console.log('✅ multi-batch broadcast runs by itself and reports once');
  }

  // اجرای هم‌زمان Cron: هیچ کاربری دو پیام نمی‌گیرد و گزارش یک‌بار است
  {
    const users = Array.from({ length: 12 }, (_, i) => String(2000 + i));
    const { env } = makeEnv({ users, batch: 4 });
    const src = await startBroadcast(env, { text: 'هم‌زمان' });
    for (let i = 0; i < 5; i++) {
      await Promise.all([processBroadcastQueue(env), processBroadcastQueue(env), processBroadcastQueue(env)]);
    }
    assertCopiedToAll(src, 'concurrent', users);
    console.log('✅ concurrent cron runs do not double-send');
  }

  // کاربری که ربات را بلاک کرده: شمارش ناموفق + نمایش دلیل خطا به ادمین
  {
    const { env } = makeEnv();
    failFor = new Set(['222']);
    await startBroadcast(env, { video: { file_id: 'vid2' }, caption: 'ویدیو' });
    await runCronUntilDone(env);
    failFor = new Set();
    const summary = reports()[0];
    assert.ok(summary.includes('موفق: 2 | ❌ ناموفق: 1'), 'summary 2/1');
    assert.ok(summary.includes('bot was blocked by the user'), 'error reason shown');
    console.log('✅ failure count and reason reported');
  }

  // در حین ارسال: پیام همگانی جدید پذیرفته نمی‌شود، وضعیت و توقف کار می‌کنند
  {
    const users = Array.from({ length: 10 }, (_, i) => String(3000 + i));
    const { env } = makeEnv({ users, batch: 3 });
    await startBroadcast(env, { text: 'اول' });
    await processBroadcastQueue(env);

    await handleMessage(env, msg({ text: '📢 ارسال پیام همگانی' }));
    await handleMessage(env, msg({ text: 'دوم' }));
    assert.ok(adminTexts().some((t) => t.includes('قبلی هنوز تمام نشده')), 'second broadcast refused');
    assert.ok(!adminTexts().some((t) => t.includes('صف پیام همگانی ساخته شد')), 'queue not replaced');

    calls.length = 0;
    await handleMessage(env, msg({ text: '/broadcaststatus' }));
    assert.ok(adminTexts()[0].includes('موفق: 3') && adminTexts()[0].includes('باقی‌مانده: 7'), 'status shows progress');

    calls.length = 0;
    await handleCallbackQuery(env, cb('bc_next'));
    assert.equal(copies().length, 0, 'old bc_next button does not send');
    assert.ok(adminTexts()[0].includes('در حال ارسال'), 'old bc_next button shows status');

    calls.length = 0;
    await handleMessage(env, msg({ text: '/stopbroadcast' }));
    assert.ok(adminTexts()[0].includes('برای 7 نفر'), 'stop reports remaining');
    await processBroadcastQueue(env);
    assert.equal(copies().length, 0, 'nothing sent after stop');
    assert.ok(reports()[0].includes('موفق: 3') && reports()[0].includes('متوقف‌شده (ارسال‌نشده): 7'), 'final report after stop');

    // بعد از پایان، پیام همگانی جدید مجاز است
    calls.length = 0;
    await handleMessage(env, msg({ text: '📢 ارسال پیام همگانی' }));
    await handleMessage(env, msg({ text: 'سوم' }));
    assert.ok(adminTexts().some((t) => t.includes('صف پیام همگانی ساخته شد')), 'new broadcast allowed after finish');
    console.log('✅ status / stop / no overlapping broadcasts');
  }

  // صف قدیمی (نسخه‌ی دستی قبلی، بدون job) نباید بعد از Deploy خودکار ارسال شود
  {
    const { env, raw } = makeEnv({ legacy: true });
    raw.exec("INSERT INTO broadcast_queue (chat_id, text, status) VALUES ('111', 'قدیمی', 'pending'), ('222', 'قدیمی', 'pending')");
    calls.length = 0;
    await processBroadcastQueue(env);
    assert.equal(calls.length, 0, 'legacy queue ignored');
    console.log('✅ leftover legacy queue is not auto-sent');
  }

  // اجرای نیمه‌کاره (ردیف‌های sending): بعد از چند دقیقه ناموفق حساب می‌شوند و گزارش می‌آید
  {
    const { env, raw } = makeEnv();
    await startBroadcast(env, { text: 'قطع' });
    raw.exec("UPDATE broadcast_queue SET status = 'sending' WHERE chat_id = '333'");
    raw.exec("UPDATE broadcast_queue SET status = 'sent' WHERE chat_id IN ('111', '222')");
    raw.exec("UPDATE settings SET value = '2000-01-01 00:00:00' WHERE key = 'broadcast_heartbeat'");
    const fresh = await processBroadcastQueue(env, new Date('2000-01-01T00:02:00Z'));
    assert.equal(fresh.finished, false, 'recent sending rows: wait');
    const late = await processBroadcastQueue(env, new Date('2000-01-01T00:10:00Z'));
    assert.equal(late.finished, true, 'stale sending rows: finish');
    assert.ok(reports()[0].includes('موفق: 2 | ❌ ناموفق: 1'), 'stale rows counted as failed');
    assert.equal(copies().length, 0, 'stale rows not resent');
    console.log('✅ interrupted batch is closed out and reported');
  }

  // پیش‌فرض: هر اجرای Cron دقیقاً ۴۰ نفر؛ سقف ارسال (maxSends) رعایت می‌شود
  {
    const users = Array.from({ length: 90 }, (_, i) => String(4000 + i));
    const { env } = makeEnv({ users });
    await startBroadcast(env, { text: 'چهل‌تایی' });
    await processBroadcastQueue(env);
    assert.equal(copies().length, 40, 'first cron run sends 40');
    await processBroadcastQueue(env, new Date(), 30);
    assert.equal(copies().length, 70, 'capped run sends only 30');
    assert.equal(reports().length, 0, 'not finished yet');
    await processBroadcastQueue(env);
    assert.equal(copies().length, 90, 'last run sends the remaining 20');
    assert.equal(reports().length, 1, 'report after last batch');
    console.log('✅ 40 per cron run, respects send cap');
  }

  // خود Cron (index.js): پیام‌های سفارش همان دقیقه از سهمیه‌ی پیام همگانی کم می‌شوند
  {
    const { default: worker } = await import('../index.js');
    const users = Array.from({ length: 60 }, (_, i) => String(5000 + i));
    const { env, raw } = makeEnv({ users });
    await startBroadcast(env, { text: 'کرون' });
    // ۱۲ سفارش منقضی → ۶ لغو در این اجرا (۶ پیام کاربر + ۱ پیام خلاصه برای ادمین)
    for (let i = 0; i < 12; i++) {
      raw.exec(`INSERT INTO orders (user_id, product_id, product_title, status, checkout_step, created_at)
                VALUES ('${5000 + i}', 'canva', 'Canva Pro', 'pending', 'invoice', datetime('now', '-2 hours'))`);
    }
    // ۸ سفارش ۱۵ دقیقه‌ای → ۸ یادآوری
    for (let i = 12; i < 20; i++) {
      raw.exec(`INSERT INTO orders (user_id, product_id, product_title, status, checkout_step, created_at)
                VALUES ('${5000 + i}', 'canva', 'Canva Pro', 'pending', 'invoice', datetime('now', '-15 minutes'))`);
    }
    let pending;
    await worker.scheduled({ scheduledTime: Date.now() }, env, { waitUntil: (p) => (pending = p) });
    await pending;
    const outgoing = calls.filter((c) => c.method === 'sendMessage' || c.method === 'copyMessage').length;
    assert.equal(copies().length, 49 - 1 - 15, 'broadcast uses the remaining budget');
    assert.ok(outgoing <= 49, `total requests within limit (${outgoing})`);
    console.log('✅ cron keeps total requests under the limit');
  }

  console.log('\nALL BROADCAST TESTS PASSED ✅');
}

main().catch((e) => {
  console.error('BROADCAST TEST FAILED:', e);
  process.exit(1);
});
