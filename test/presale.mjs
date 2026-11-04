// تست غیرفعال کردن کالا و پیش‌خرید
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { makeD1 } from './d1_mock.mjs';
import { setTestPrice } from './products_helper.mjs';
import { handleMessage } from '../message.js';
import { handleCallbackQuery } from '../callback.js';
import * as db from '../db.js';
import { getCart } from '../cart.js';
import { getFullProduct } from '../products.js';
import { processBroadcastQueue } from '../flows.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = '999';
const USER = '111';
const DISABLE = '⏸ فعال / غیرفعال کردن کالا';

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

async function makeEnv(extra = {}) {
  const { prepare, batch, raw } = makeD1();
  raw.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf-8'));
  const env = {
    DB: { prepare, batch },
    raw,
    BOT_TOKEN: 'T',
    ADMIN_CHAT_ID: ADMIN,
    SUPPORT_CHAT_ID: ADMIN,
    CHANNEL_ENABLED: 'false',
    DISCOUNT_ENABLED: 'true',
    DISCOUNT_CODES: 'OFF10:10',
    POST_FEE: '100000',
    ...extra,
  };
  for (const id of [USER, ADMIN]) {
    await db.ensureUser(env, id);
    await db.saveRegistration(env, id, { phone_number: `0912${id}`, first_name: 'U' });
  }
  await setTestPrice(env, 1, 100000);
  await setTestPrice(env, 2, 200000);
  return env;
}

const msg = (from, text) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, text });
const photo = (from) => ({ chat: { id: Number(from) }, from: { id: Number(from) }, message_id: nextId++, photo: [{ file_id: 'F' }] });
const cb = (from, data) => ({ id: `cb${nextId++}`, data, from: { id: Number(from) }, message: { chat: { id: Number(from) }, message_id: nextId++ } });
const sent = (to) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === to);
const last = (to) => sent(to).at(-1).body;
const callbacks = (body) => (body.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);
const alertText = () => calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).body.text;
const pending = (env, who) => env.DB.prepare("SELECT * FROM orders WHERE user_id = ? AND status = 'pending'").bind(who).first();

async function menuButton(env, who, match) {
  await handleMessage(env, msg(who, '/start'));
  return (last(who).reply_markup?.keyboard || []).flat().find((b) => b.text.includes(match));
}

async function setPresale(env, id, price) {
  await handleCallbackQuery(env, cb(ADMIN, `ds:${id}`));
  await handleCallbackQuery(env, cb(ADMIN, `dsy:${id}`));
  await handleMessage(env, msg(ADMIN, String(price)));
}

async function main() {
  // ---- مسیر ادمین ----
  {
    const env = await makeEnv();
    assert.ok(await menuButton(env, ADMIN, DISABLE), 'admin has the disable button');
    assert.ok(!(await menuButton(env, USER, DISABLE)), 'user does not');

    await handleMessage(env, msg(ADMIN, DISABLE));
    assert.ok(callbacks(last(ADMIN)).includes('ds:1') && callbacks(last(ADMIN)).includes('ds:2'), 'picks a product');
    await handleCallbackQuery(env, cb(ADMIN, 'ds:1'));
    assert.ok(last(ADMIN).text.includes('پیش‌خرید') && callbacks(last(ADMIN)).includes('dsy:1') && callbacks(last(ADMIN)).includes('dsn:1'), 'asks about presale');

    // خیر: غیرفعال کامل
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:1'));
    let p = await getFullProduct(env, '1');
    assert.equal(p.disabled, true);
    assert.equal(p.presalePrice, 0);

    // بله: قیمت باید عدد و کمتر از قیمت عادی باشد
    await handleCallbackQuery(env, cb(ADMIN, 'dsy:2'));
    await handleMessage(env, msg(ADMIN, 'abc'));
    assert.ok(last(ADMIN).text.includes('عدد'), 'rejects text');
    await handleMessage(env, msg(ADMIN, '200000'));
    assert.ok(last(ADMIN).text.includes('کمتر باشد'), 'must be lower than the regular price');
    assert.equal((await getFullProduct(env, '2')).disabled, false, 'nothing saved yet');
    await handleMessage(env, msg(ADMIN, '۱۵۰,۰۰۰'));
    p = await getFullProduct(env, '2');
    assert.equal(p.disabled, true);
    assert.equal(p.presalePrice, 150000);

    // انصراف از گرفتن قیمت چیزی را عوض نمی‌کند
    await handleCallbackQuery(env, cb(ADMIN, 'dsy:2'));
    await handleMessage(env, msg(ADMIN, '🔙 انصراف'));
    assert.equal((await getFullProduct(env, '2')).presalePrice, 150000);

    // قیمت عادی نمی‌تواند زیر قیمت پیش‌خرید برود
    await handleCallbackQuery(env, cb(ADMIN, 'pe:2:price'));
    await handleMessage(env, msg(ADMIN, '150000'));
    assert.ok(last(ADMIN).text.includes('بیشتر باشد'));
    await handleMessage(env, msg(ADMIN, '🔙 انصراف'));

    // فعال کردن دوباره
    await handleCallbackQuery(env, cb(ADMIN, 'ds:2'));
    assert.ok(callbacks(last(ADMIN)).includes('dse:2'), 'offers re-enable');
    await handleCallbackQuery(env, cb(ADMIN, 'dse:2'));
    p = await getFullProduct(env, '2');
    assert.equal(p.disabled, false);
    assert.equal(p.presalePrice, 0);

    // نام با علامت کالای غیرفعال پذیرفته نمی‌شود
    await handleCallbackQuery(env, cb(ADMIN, 'pe:2:title'));
    await handleMessage(env, msg(ADMIN, '⏳ نام جدید'));
    assert.ok(last(ADMIN).text.includes('شروع شود'));
    await handleMessage(env, msg(ADMIN, '🔙 انصراف'));
    console.log('✅ admin: pick, presale question, price validation, re-enable');
  }

  // ---- منو و صفحه‌ی محصول ----
  {
    const env = await makeEnv();
    assert.deepEqual(await menuButton(env, USER, 'محصول 1'), { text: 'محصول 1' }, 'active button is plain');

    await setPresale(env, 1, 80000);
    await handleCallbackQuery(env, cb(ADMIN, 'ds:2'));
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:2'));
    assert.deepEqual(await menuButton(env, USER, 'محصول 1'), { text: '⏳ محصول 1', style: 'success' });
    assert.deepEqual(await menuButton(env, USER, 'محصول 2'), { text: '🚫 محصول 2', style: 'danger' });

    await handleMessage(env, msg(USER, '⏳ محصول 1'));
    let page = last(USER);
    assert.ok(page.text.includes('<s>۱۰۰٬۰۰۰</s>') && page.text.includes('۸۰٬۰۰۰'), 'shows both prices');
    assert.ok(callbacks(page).includes('qty:1:1') && !callbacks(page).includes('buy:1'), 'direct buy, not cart');

    await handleMessage(env, msg(USER, '🚫 محصول 2'));
    page = last(USER);
    assert.ok(page.text.includes('موجود نیست'));
    assert.equal(callbacks(page).length, 0, 'disabled product has no buy buttons');

    // کیبورد قدیمی بدون علامت و دکمه‌ی علامت‌دار بعد از فعال شدن هر دو کار می‌کنند
    await handleMessage(env, msg(USER, 'محصول 1'));
    assert.ok(last(USER).text.includes('۸۰٬۰۰۰'), 'stale plain button');
    await handleCallbackQuery(env, cb(ADMIN, 'dse:1'));
    await handleMessage(env, msg(USER, '⏳ محصول 1'));
    assert.ok(!last(USER).text.includes('پیش‌خرید'), 'stale marked button');
    assert.ok(callbacks(last(USER)).includes('buy:1'), 'back to the cart');
    console.log('✅ menu buttons and product page');
  }

  // ---- خرید پیش‌خرید ----
  {
    const env = await makeEnv();
    await setPresale(env, 1, 80000);

    await handleCallbackQuery(env, cb(USER, 'qty:1:2'));
    assert.ok(callbacks(last(USER)).includes('os:1:p2'), 'asks delivery');
    await handleCallbackQuery(env, cb(USER, 'os:1:p2'));
    assert.ok(!last(USER).text.includes('کد تخفیف'), 'no discount prompt');
    let order = await pending(env, USER);
    assert.equal(order.amount, 160000, 'presale price × quantity');
    assert.equal(order.presale_price, 80000);
    assert.ok(order.product_title.includes('پیش‌خرید'), 'tagged for admin reports');
    assert.ok(last(USER).text.includes('پیش‌خرید است'), 'invoice says presale');

    // دکمه‌ی قدیمی کد تخفیف قیمت پیش‌خرید را کم نمی‌کند
    await handleCallbackQuery(env, cb(USER, 'discount_yes:1:p2'));
    assert.equal((await db.getSession(env, USER)).state, null, 'no code entry');
    assert.equal((await pending(env, USER)).discount_percent, 0);

    // رسید و تایید
    await handleCallbackQuery(env, cb(USER, `rcpt:${order.id}`));
    await handleMessage(env, photo(USER));
    order = await db.getOrder(env, order.id);
    assert.equal(order.status, 'receipt_sent');
    assert.equal(order.amount, 160000);
    await handleCallbackQuery(env, cb(ADMIN, `confirm_order:${order.id}`));
    assert.equal((await db.getOrder(env, order.id)).status, 'confirmed');
    assert.ok(sent(USER).some((m) => m.body.text.includes('بعد از موجود شدن')), 'customer told it ships later');

    // کیف پول
    await db.adminAdjustWallet(env, USER, 100000, 'test:presale:wallet');
    await handleCallbackQuery(env, cb(USER, 'discount_no:1:p1'));
    order = await pending(env, USER);
    assert.equal(order.presale_price, 80000);
    await handleCallbackQuery(env, cb(USER, `wpay:${order.id}`));
    assert.equal((await db.getOrder(env, order.id)).status, 'paid_by_wallet', 'wallet pays presale');
    console.log('✅ presale purchase: invoice, no discount, receipt, confirm, wallet');
  }

  // ---- تغییر وضعیت کالا وسط خرید ----
  {
    const env = await makeEnv();
    await db.adminAdjustWallet(env, USER, 500000, 'test:presale:mid');

    // پیش‌فاکتور پیش‌خرید، بعد فعال شدن کالا: رسید با همان مبلغ فاکتور، کیف پول و ادامه خرید بسته
    await setPresale(env, 1, 80000);
    await handleCallbackQuery(env, cb(USER, 'discount_no:1:p1'));
    let order = await pending(env, USER);
    await handleCallbackQuery(env, cb(ADMIN, 'dse:1'));
    await handleCallbackQuery(env, cb(USER, `wpay:${order.id}`));
    assert.ok(alertText().includes('قابل خرید نیست'), 'wallet closed after re-enable');
    assert.equal((await db.getOrder(env, order.id)).status, 'pending');
    await handleCallbackQuery(env, cb(USER, `resume:${order.id}`));
    assert.ok(last(USER).text.includes('قابل خرید نیست'), 'resume closed');
    await handleCallbackQuery(env, cb(USER, `rcpt:${order.id}`));
    await handleMessage(env, photo(USER));
    order = await db.getOrder(env, order.id);
    assert.equal(order.status, 'receipt_sent');
    assert.equal(order.amount, 80000, 'receipt keeps the presale amount');
    assert.ok(sent(ADMIN).at(-1).body.text.includes('پیش‌خرید'), 'admin sees presale');

    // پیش‌فاکتور عادی، بعد پیش‌خرید شدن کالا: رسید با قیمت عادی
    await handleCallbackQuery(env, cb(USER, 'discount_no:2:p1'));
    order = await pending(env, USER);
    await setPresale(env, 2, 150000);
    await handleCallbackQuery(env, cb(USER, `wpay:${order.id}`));
    assert.ok(alertText().includes('قابل خرید نیست'));
    await handleCallbackQuery(env, cb(USER, `rcpt:${order.id}`));
    await handleMessage(env, photo(USER));
    assert.equal((await db.getOrder(env, order.id)).amount, 200000, 'regular invoice keeps its amount');

    // پیش‌فاکتور پیش‌خرید، بعد لغو پیش‌خرید: خرید جدید بسته است
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:2'));
    await handleCallbackQuery(env, cb(USER, 'discount_no:2:p1'));
    assert.ok(last(USER).text.includes('موجود نیست'), 'no invoice for disabled product');
    assert.equal(await pending(env, USER), null);
    await handleCallbackQuery(env, cb(USER, 'qty:2:1'));
    await handleCallbackQuery(env, cb(USER, 'os:2:p1'));
    assert.equal(await pending(env, USER), null, 'old buy buttons cannot buy it');
    console.log('✅ status changes during checkout');
  }

  // ---- سبد ----
  {
    const env = await makeEnv();
    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    await handleCallbackQuery(env, cb(USER, 'buy:2'));
    assert.equal((await getCart(env, USER)).length, 2);

    await handleCallbackQuery(env, cb(ADMIN, 'ds:1'));
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:1'));
    await setPresale(env, 2, 150000);
    assert.equal((await getCart(env, USER)).length, 0, 'leaves the cart view');

    await handleCallbackQuery(env, cb(USER, 'buy:1'));
    assert.ok(alertText().includes('موجود نیست'), 'disabled cannot be added');
    await handleCallbackQuery(env, cb(USER, 'buy:2'));
    assert.ok(callbacks(last(USER)).includes('qty:2:1'), 'old add button becomes direct presale');
    await handleCallbackQuery(env, cb(USER, 'cart:inc:2'));
    assert.equal((await getCart(env, USER)).length, 0, 'cart buttons cannot add presale');

    await handleCallbackQuery(env, cb(ADMIN, 'dse:1'));
    await handleCallbackQuery(env, cb(ADMIN, 'dse:2'));
    assert.equal((await getCart(env, USER)).length, 2, 'returns to the cart when re-enabled');
    console.log('✅ cart excludes disabled and presale products');
  }

  // ---- پیام تغییر وضعیت ----
  {
    const SUPPORT = '998';
    const OTHER = '222';
    const env = await makeEnv({ SUPPORT_CHAT_ID: SUPPORT });
    await db.ensureUser(env, SUPPORT);
    await db.ensureUser(env, OTHER);
    const noticeCount = () => env.raw.prepare('SELECT COUNT(*) AS n FROM broadcast_queue').get().n;
    const queued = () => env.raw.prepare('SELECT chat_id, text FROM broadcast_queue ORDER BY chat_id').all();
    const flush = async () => {
      await processBroadcastQueue(env);
      assert.equal(env.raw.prepare("SELECT COUNT(*) AS n FROM broadcast_queue WHERE status = 'pending'").get().n, 0);
    };

    // بعد از قیمت‌گذاری متن پیش‌فرض می‌آید و تا تایید چیزی در صف نیست
    await setPresale(env, 1, 80000);
    let preview = last(ADMIN);
    assert.ok(preview.text.includes('به کاربران اطلاع داده شود') && preview.text.includes('۸۰٬۰۰۰') && preview.text.includes('⏳'), 'presale default text');
    assert.ok(callbacks(preview).includes('nt:1:a') && callbacks(preview).includes('nt:1:e') && callbacks(preview).includes('nt:1:x'));
    assert.ok(!callbacks(preview).includes('nt:1:b'), 'no buyers yet');
    assert.equal(noticeCount(), 0, 'nothing queued before approval');

    // «ارسال نشود»
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:x'));
    assert.equal(noticeCount(), 0);
    assert.equal((await db.getSession(env, ADMIN)).state, null);
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:a'));
    assert.ok(alertText().includes('منقضی'), 'old preview cannot send');
    assert.equal(noticeCount(), 0);

    // ویرایش متن و ارسال به همه؛ متن ادمین escape می‌شود
    await handleCallbackQuery(env, cb(ADMIN, 'ds:1'));
    await handleCallbackQuery(env, cb(ADMIN, 'dsy:1'));
    await handleMessage(env, msg(ADMIN, '70000'));
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:e'));
    assert.ok(last(ADMIN).text.includes('<code>'), 'shows current text for copying');
    await handleMessage(env, photo(ADMIN));
    assert.ok(last(ADMIN).text.includes('نوشته'), 'text only');
    await handleMessage(env, msg(ADMIN, 'پیش‌خرید <شروع> شد'));
    assert.ok(last(ADMIN).text.includes('پیش‌خرید &lt;شروع&gt; شد') && callbacks(last(ADMIN)).includes('nt:1:a'), 'previews the edited text');
    assert.equal(noticeCount(), 0, 'edit alone sends nothing');
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:a'));
    assert.deepEqual(queued().map((r) => r.chat_id).sort(), [OTHER, USER, ADMIN, SUPPORT].sort());
    assert.ok(queued().every((r) => r.text === 'پیش‌خرید &lt;شروع&gt; شد'));

    // تا پایان ارسال قبلی، پیام جدید صف را خراب نمی‌کند و پیش‌نویس می‌ماند
    await handleCallbackQuery(env, cb(ADMIN, 'ds:2'));
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:2'));
    assert.ok(last(ADMIN).text.includes('موجود نیست'), 'disable default text');
    await handleCallbackQuery(env, cb(ADMIN, 'nt:2:a'));
    assert.ok(alertText().includes('تمام نشده'), 'previous broadcast still running');
    assert.equal((await db.getSession(env, ADMIN)).data.productId, '2', 'draft kept');
    calls.length = 0;
    await flush();
    assert.ok(sent(OTHER).some((m) => m.body.text.includes('&lt;شروع&gt;')), 'delivered as text');
    await handleCallbackQuery(env, cb(ADMIN, 'nt:2:x'));

    // فعال شدن: فقط خریداران منتظر؛ مشتری ناموفق و سفارش عادی پیام نمی‌گیرند
    await db.saveOrder(env, USER, '1', 'x', { amount: 70000, status: 'receipt_sent', presalePrice: 70000 });
    await db.saveOrder(env, USER, '1', 'x', { amount: 70000, status: 'confirmed', presalePrice: 70000 });
    await db.saveOrder(env, OTHER, '1', 'x', { amount: 70000, status: 'rejected', presalePrice: 70000 });
    await db.saveOrder(env, OTHER, '1', 'x', { amount: 100000, status: 'confirmed' });
    await handleCallbackQuery(env, cb(ADMIN, 'dse:1'));
    preview = last(ADMIN);
    assert.ok(preview.text.includes('دوباره موجود شد') && preview.text.includes('🎉'), 'enable default text');
    assert.ok(callbacks(preview).includes('nt:1:b'));
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:b'));
    assert.deepEqual(queued().map((r) => r.chat_id), [USER], 'each waiting buyer once');
    await flush();

    // دوره‌ی بعدی پیش‌خرید: خریدار قبلی دوباره پیام «موجود شد» نمی‌گیرد
    assert.deepEqual(await db.getPresaleBuyers(env, '1'), []);
    await setPresale(env, 1, 60000);
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:x'));
    await handleCallbackQuery(env, cb(ADMIN, 'dse:1'));
    assert.ok(!callbacks(last(ADMIN)).includes('nt:1:b'), 'old buyers are not offered again');
    await handleCallbackQuery(env, cb(ADMIN, 'nt:1:x'));

    // انصراف سبب ارسال نشدن؛ دکمه‌ی تکراری پیشنهاد جدید نمی‌دهد؛ کالای پنهان پیشنهاد ندارد
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:2'));
    assert.ok(!(last(ADMIN).text || '').includes('اطلاع داده شود'), 'repeat disable: no offer');
    await handleCallbackQuery(env, cb(ADMIN, 'ph:1'));
    await handleCallbackQuery(env, cb(ADMIN, 'dsn:1'));
    assert.ok(!(last(ADMIN).text || '').includes('اطلاع داده شود'), 'hidden product: no offer');

    // ادمین پشتیبانی به خریداران می‌فرستد ولی به همه نه
    await db.saveOrder(env, OTHER, '2', 'x', { amount: 100, status: 'confirmed', presalePrice: 100 });
    await handleCallbackQuery(env, cb(SUPPORT, 'dse:2'));
    preview = last(SUPPORT);
    assert.ok(callbacks(preview).includes('nt:2:b') && !callbacks(preview).includes('nt:2:a'), 'support: buyers only');
    await handleCallbackQuery(env, cb(SUPPORT, 'nt:2:a'));
    assert.ok(alertText().includes('مدیر اصلی'), 'support cannot send to all');
    await handleCallbackQuery(env, cb(SUPPORT, 'nt:2:b'));
    assert.deepEqual(queued().map((r) => r.chat_id), [OTHER]);
    console.log('✅ status notices: default text, edit, approval, recipients');
  }

  // ---- امنیت ----
  {
    const env = await makeEnv();
    for (const data of ['ds_list', 'ds:1', 'dsy:1', 'dsn:1', 'dse:1', 'nt:1:a', 'nt:1:b', 'nt:1:e', 'nt:1:x']) {
      await handleCallbackQuery(env, cb(USER, data));
      assert.ok(alertText().includes('دسترسی ندارید'), `${data}: denied`);
    }
    assert.equal((await getFullProduct(env, '1')).disabled, false);
    calls.length = 0;
    await handleMessage(env, msg(USER, DISABLE));
    assert.ok(!sent(USER).some((m) => callbacks(m).includes('ds:1')), 'user gets no picker');
    console.log('✅ access control');
  }
}

main().then(
  () => console.log('\nALL PRESALE TESTS PASSED ✅'),
  (e) => {
    console.error('PRESALE TEST FAILED:', e);
    process.exit(1);
  }
);
