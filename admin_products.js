// -*- ساخت و مدیریت محصولات از داخل ربات (ادمین‌ها) -*-
//
// ➕ ساخت محصول: نام (متن دکمه) → ویژگی‌ها → عکس → قیمت → جایگاه دکمه (عدد) → پیش‌نمایش → ✅ ثبت
// 🛠 مدیریت محصولات: لیست به ترتیب جایگاه → محصول → ویرایش نام/ویژگی‌ها/عکس/قیمت، جابجایی، حذف
//
// سشن‌ها:
//   prod_new   { step, title, description, photoFileId, price, position }
//   prod_edit  { productId, field }
//   prod_presale { productId }
//   prod_notice  { productId, kind, text, step }
//
// callback_data:
//   pa_new            شروع ساخت محصول
//   pa_list           لیست محصولات
//   pa:<id>           صفحه‌ی مدیریت یک محصول
//   pe:<id>:<field>   ویرایش یک بخش (title | description | photo | price | position | old_price)
//   ph:<id>           پنهان / نمایش در منو
//   ds_list           لیست انتخاب کالا برای غیرفعال کردن
//   ds:<id>           سوال پیش‌خرید برای یک کالا
//   dsy:<id>          بله: گرفتن قیمت پیش‌خرید      dsn:<id>  خیر: غیرفعال بدون پیش‌خرید
//   dse:<id>          فعال کردن دوباره
//   nt:<id>:<act>     پیام تغییر وضعیت: b ارسال به خریداران پیش‌خرید | a ارسال به همه | e ویرایش متن | x ارسال نشود
//   pd:<id>           سوال حذف      pdok:<id>  حذف قطعی
//   pnew_ok           ثبت محصول جدید (اطلاعات از سشن خوانده می‌شود)
//   pnew_no           انصراف از ساخت

import * as api from './api.js';
import * as db from './db.js';
import { CART_TOGGLE_PREFIX, cancelKeyboard, productRows, RESERVED_BUTTONS } from './keyboards.js';
import { isSuperAdmin, money, productColumns, productFeaturedFirst } from './config.js';
import { broadcastText, menuKeyboardFor } from './flows.js';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  addProduct,
  buildProductCaption,
  countProducts,
  deleteProduct,
  escapeHtml,
  getFullProduct,
  hasButtonMark,
  isPresale,
  listProducts,
  moveProduct,
  titleTaken,
  updateProduct,
} from './products.js';

export const NEW_PRODUCT_STATE = 'prod_new';
export const EDIT_PRODUCT_STATE = 'prod_edit';
export const PRESALE_PRICE_STATE = 'prod_presale';
export const NOTICE_STATE = 'prod_notice';
export const PRODUCT_SESSION_STATES = [NEW_PRODUCT_STATE, EDIT_PRODUCT_STATE, PRESALE_PRICE_STATE, NOTICE_STATE];

const MAX_PRICE = 1_000_000_000;

const FIELD_LABELS = {
  title: 'نام محصول',
  description: 'ویژگی‌های محصول',
  photo: 'عکس محصول',
  price: 'قیمت',
  position: 'جایگاه دکمه',
  old_price: 'قیمت خط‌خورده',
};

// عدد فارسی/عربی، جداکننده‌ی هزارگان و کلمه‌ی «تومان» پذیرفته می‌شود
export function parsePriceInput(text) {
  const normalized = String(text ?? '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/تومان|تومن/g, '')
    .replace(/[,،٬\s]/g, '');
  if (!/^\d+$/.test(normalized)) return null;
  const n = Number(normalized);
  return Number.isSafeInteger(n) && n <= MAX_PRICE ? n : null;
}

// ----------------------------------------------------
// ورودی‌ها
// ----------------------------------------------------

async function validateTitle(env, text, exceptId = null) {
  const title = String(text || '').trim();
  if (!title) return { error: '⚠️ نام محصول را به‌صورت متن بفرستید.' };
  if (title.includes('\n')) return { error: '⚠️ نام محصول باید یک خط باشد.' };
  if (title.length > MAX_TITLE_LENGTH) return { error: `⚠️ نام محصول حداکثر ${MAX_TITLE_LENGTH} کاراکتر باشد (الان ${title.length}).` };
  if (title.startsWith('/')) return { error: '⚠️ نام محصول نباید با / شروع شود.' };
  if (hasButtonMark(title)) return { error: '⚠️ نام محصول نباید با ⏳ یا 🚫 شروع شود؛ این علامت‌ها مخصوص کالای غیرفعال‌اند.' };
  if (RESERVED_BUTTONS.includes(title) || title.startsWith(CART_TOGGLE_PREFIX)) return { error: '⚠️ این نام متعلق به یکی از دکمه‌های ثابت منوست؛ نام دیگری انتخاب کنید.' };
  if (await titleTaken(env, title, exceptId)) return { error: '⚠️ محصولی با همین نام وجود دارد؛ نام دیگری انتخاب کنید.' };
  return { value: title };
}

function validateDescription(text) {
  const description = String(text || '').trim();
  if (!description) return { error: '⚠️ ویژگی‌های محصول را به‌صورت متن بفرستید.' };
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { error: `⚠️ متن ویژگی‌ها حداکثر ${MAX_DESCRIPTION_LENGTH} کاراکتر باشد (الان ${description.length}).` };
  }
  return { value: description };
}

function validatePhoto(message) {
  if (message.photo?.length) return { value: message.photo[message.photo.length - 1].file_id };
  if (message.document) return { error: '⚠️ عکس را به‌صورت «عکس» بفرستید، نه فایل.' };
  return { error: '🖼 لطفاً عکس محصول را بفرستید.' };
}

function validatePrice(text) {
  const price = parsePriceInput(text);
  if (price === null || price <= 0) return { error: '⚠️ قیمت را فقط به‌صورت عدد و به تومان بفرستید (مثلاً <code>250000</code>).' };
  return { value: price };
}

// صفر یعنی بدون تخفیف ویژه
function validateOldPrice(text, price) {
  const oldPrice = parsePriceInput(text);
  if (oldPrice === null) return { error: '⚠️ لطفاً فقط عدد بفرستید یا «🔙 انصراف» را بزنید.' };
  if (oldPrice > 0 && oldPrice <= price) {
    return { error: `⚠️ قیمت خط‌خورده باید از قیمت فروش (${money(price)} تومان) بیشتر باشد. عدد <code>0</code> یعنی بدون تخفیف ویژه.` };
  }
  return { value: oldPrice };
}

function validatePresalePrice(text, price) {
  const presalePrice = parsePriceInput(text);
  if (presalePrice === null || presalePrice <= 0) return { error: '⚠️ قیمت پیش‌خرید را فقط به‌صورت عدد و به تومان بفرستید (مثلاً <code>200000</code>).' };
  if (price > 0 && presalePrice >= price) return { error: `⚠️ قیمت پیش‌خرید باید از قیمت عادی (${money(price)} تومان) کمتر باشد.` };
  return { value: presalePrice };
}

function validatePosition(text, max) {
  const n = parsePriceInput(text);
  if (n === null || n < 1 || n > max) return { error: `⚠️ یک عدد بین ۱ تا ${max} بفرستید.` };
  return { value: n };
}

// ----------------------------------------------------
// کیبورد عددی جایگاه + پیش‌نمایش چیدمان دکمه‌ها
// ----------------------------------------------------

function positionKeyboard(max) {
  const keyboard = [];
  for (let i = 1; i <= max; i += 5) {
    keyboard.push(Array.from({ length: Math.min(5, max - i + 1) }, (_, k) => ({ text: String(i + k) })));
  }
  keyboard.push([{ text: '🔙 انصراف' }]);
  return { keyboard, resize_keyboard: true };
}

// چیدمان منو بعد از قرار گرفتن `title` در جایگاه `position` (برای محصول موجود، از جای قبلی برداشته می‌شود)
function layoutPreview(env, products, title, position, exceptId = null) {
  const names = products.filter((p) => p.id !== exceptId).map((p) => p.title);
  names.splice(position - 1, 0, `⭐ ${title}`);
  return productRows(names, productColumns(env), productFeaturedFirst(env))
    .map((row) => row.map((n) => `[ ${escapeHtml(n)} ]`).join('  '))
    .join('\n');
}

function numberedList(products) {
  return products.map((p) => `${p.position}. ${escapeHtml(p.title)}`).join('\n');
}

async function askPosition(env, chatId, title, exceptId = null) {
  const products = await listProducts(env);
  const max = exceptId ? products.length : products.length + 1;
  const list = products.length ? `ترتیب فعلی دکمه‌ها:\n${numberedList(products)}\n\n` : '';
  await api.sendMessage(
    env,
    chatId,
    `🔢 <b>جایگاه دکمه‌ی «${escapeHtml(title)}»</b>\n\n${list}` +
      `عدد جایگاه را بفرستید (۱ = اولین دکمه${exceptId ? '' : `، ${max} = آخر`}):`,
    positionKeyboard(max)
  );
}

// ----------------------------------------------------
// ساخت محصول
// ----------------------------------------------------

export async function startNewProduct(env, chatId) {
  await db.setSession(env, chatId, NEW_PRODUCT_STATE, { step: 'title' });
  await api.sendMessage(
    env,
    chatId,
    '➕ <b>ساخت محصول جدید</b> (مرحله ۱ از ۵)\n\n' +
      `📝 نام محصول را بفرستید. همین نام روی دکمه‌ی منو نمایش داده می‌شود (حداکثر ${MAX_TITLE_LENGTH} کاراکتر، ایموجی هم مجاز است).\n\n` +
      'مثال: <code>🎧 هدفون بی‌سیم</code>',
    cancelKeyboard()
  );
}

async function handleNewProductStep(env, chatId, session, message) {
  const data = session.data || {};
  const text = String(message.text || '').trim();
  const save = (patch) => db.setSession(env, chatId, NEW_PRODUCT_STATE, { ...data, ...patch });
  const fail = (error) => api.sendMessage(env, chatId, error);

  switch (data.step) {
    case 'title': {
      const r = await validateTitle(env, text);
      if (r.error) return fail(r.error);
      await save({ step: 'description', title: r.value });
      await api.sendMessage(
        env,
        chatId,
        `✅ نام: <b>${escapeHtml(r.value)}</b>\n\n(مرحله ۲ از ۵)\n📋 ویژگی‌ها و توضیحات محصول را بفرستید ` +
          `(حداکثر ${MAX_DESCRIPTION_LENGTH} کاراکتر؛ می‌توانید چند خط بنویسید).`
      );
      return;
    }
    case 'description': {
      const r = validateDescription(text);
      if (r.error) return fail(r.error);
      await save({ step: 'photo', description: r.value });
      await api.sendMessage(env, chatId, '✅ ویژگی‌ها ثبت شد.\n\n(مرحله ۳ از ۵)\n🖼 عکس محصول را بفرستید:');
      return;
    }
    case 'photo': {
      const r = validatePhoto(message);
      if (r.error) return fail(r.error);
      await save({ step: 'price', photoFileId: r.value });
      await api.sendMessage(env, chatId, '✅ عکس ثبت شد.\n\n(مرحله ۴ از ۵)\n💰 قیمت محصول را به تومان بفرستید (مثلاً <code>250000</code>):');
      return;
    }
    case 'price': {
      const r = validatePrice(text);
      if (r.error) return fail(r.error);
      await save({ step: 'position', price: r.value });
      await api.sendMessage(env, chatId, `✅ قیمت: <b>${money(r.value)} تومان</b>\n\n(مرحله ۵ از ۵)`);
      await askPosition(env, chatId, data.title);
      return;
    }
    case 'position': {
      const products = await listProducts(env);
      const r = validatePosition(text, products.length + 1);
      if (r.error) return fail(r.error);
      const draft = { ...data, step: 'confirm', position: r.value };
      await db.setSession(env, chatId, NEW_PRODUCT_STATE, draft);
      await sendNewProductPreview(env, chatId, draft, products);
      return;
    }
    case 'confirm':
      await api.sendMessage(env, chatId, '👆 برای ثبت، دکمه‌ی «✅ ثبت محصول» زیر پیش‌نمایش را بزنید، یا «🔙 انصراف».');
      return;
    default:
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, '⚠️ مراحل ساخت محصول به‌هم ریخت؛ دوباره از دکمه شروع کنید.', await menuKeyboardFor(env, chatId));
  }
}

async function sendNewProductPreview(env, chatId, draft, products) {
  // اول کیبورد عددی برداشته می‌شود
  await api.sendMessage(env, chatId, '🔎 <b>پیش‌نمایش محصول</b> (کاربران دقیقاً همین را می‌بینند):', cancelKeyboard());
  await api.sendPhoto(env, chatId, draft.photoFileId, buildProductCaption({ ...draft }));
  await api.sendMessage(
    env,
    chatId,
    `🔢 جایگاه: <b>${draft.position}</b>\n\nچیدمان دکمه‌ها در منو:\n${layoutPreview(env, products, draft.title, draft.position)}\n\nثبت شود؟`,
    {
      inline_keyboard: [
        [{ text: '✅ ثبت محصول', callback_data: 'pnew_ok' }],
        [{ text: '❌ انصراف', callback_data: 'pnew_no' }],
      ],
    }
  );
}

// ----------------------------------------------------
// ویرایش محصول
// ----------------------------------------------------

async function startEdit(env, chatId, product, field) {
  await db.setSession(env, chatId, EDIT_PRODUCT_STATE, { productId: product.id, field });
  if (field === 'position') {
    await askPosition(env, chatId, product.title, product.id);
    return;
  }
  const prompts = {
    title: `📝 نام فعلی: <b>${escapeHtml(product.title)}</b>\n\nنام جدید را بفرستید (حداکثر ${MAX_TITLE_LENGTH} کاراکتر):`,
    description: `📋 ویژگی‌های فعلی:\n${escapeHtml(product.description)}\n\nمتن جدید ویژگی‌ها را بفرستید (حداکثر ${MAX_DESCRIPTION_LENGTH} کاراکتر):`,
    photo: '🖼 عکس جدید محصول را بفرستید:',
    price: `💰 قیمت فعلی: <b>${money(product.price)} تومان</b>\n\nقیمت جدید را به تومان بفرستید:`,
    old_price: `🏷 قیمت فروش: <b>${money(product.price)} تومان</b>\n\nقیمت قبل از تخفیف را به تومان بفرستید. روی صفحه‌ی محصول خط می‌خورد و مبلغ فاکتور همان قیمت فروش است. عدد <code>0</code> یعنی بدون تخفیف ویژه:`,
  };
  await api.sendMessage(env, chatId, prompts[field], cancelKeyboard());
}

async function handleEditStep(env, chatId, session, message) {
  const { productId, field } = session.data || {};
  const product = await getFullProduct(env, productId);
  if (!product || !FIELD_LABELS[field]) {
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '⚠️ محصول پیدا نشد؛ ممکن است حذف شده باشد.', await menuKeyboardFor(env, chatId));
    return;
  }

  const text = String(message.text || '').trim();
  let r;
  if (field === 'title') r = await validateTitle(env, text, product.id);
  else if (field === 'description') r = validateDescription(text);
  else if (field === 'photo') r = validatePhoto(message);
  else if (field === 'price') {
    r = validatePrice(text);
    if (!r.error && product.presalePrice > 0 && r.value <= product.presalePrice) {
      r = { error: `⚠️ قیمت عادی باید از قیمت پیش‌خرید (${money(product.presalePrice)} تومان) بیشتر باشد.` };
    }
  } else if (field === 'old_price') r = validateOldPrice(text, product.price);
  else r = validatePosition(text, await countProducts(env));
  if (r.error) {
    await api.sendMessage(env, chatId, r.error);
    return;
  }

  if (field === 'position') await moveProduct(env, product.id, r.value);
  else if (field === 'photo') await updateProduct(env, product.id, { photoFileId: r.value });
  else if (field === 'old_price') await updateProduct(env, product.id, { oldPrice: r.value });
  else await updateProduct(env, product.id, { [field]: r.value });

  await db.clearSession(env, chatId);
  await api.sendMessage(env, chatId, `✅ ${FIELD_LABELS[field]} بروزرسانی شد.`, await menuKeyboardFor(env, chatId));
  await showProductAdmin(env, chatId, product.id);
}

// پیام ادمین وقتی در یکی از سشن‌های محصول است
export async function handleProductSessionMessage(env, chatId, session, message) {
  if (session.state === NEW_PRODUCT_STATE) return handleNewProductStep(env, chatId, session, message);
  if (session.state === PRESALE_PRICE_STATE) return handlePresalePriceStep(env, chatId, session, message);
  if (session.state === NOTICE_STATE) return handleNoticeStep(env, chatId, session, message);
  return handleEditStep(env, chatId, session, message);
}

// ----------------------------------------------------
// پیام تغییر وضعیت کالا: متن پیش‌فرض ← ارسال، ویرایش یا انصراف (بدون تایید ادمین چیزی ارسال نمی‌شود)
// ----------------------------------------------------

// متن پیام قبل از ارسال escape می‌شود و قالب‌بندی HTML ندارد
const MAX_NOTICE_HTML_LENGTH = 3500;

function defaultNoticeText(product, kind) {
  if (kind === 'on') {
    return `🎉 خبر خوب! «${product.title}» دوباره موجود شد 🌸\n\n` +
      '🛍 می‌توانید از منوی ربات سفارش بدهید.\n' +
      '📦 اگر پیش‌خرید کرده‌اید، سفارش شما به‌زودی تحویل یا ارسال می‌شود.';
  }
  if (kind === 'presale') {
    const regular = product.price > 0 ? `💰 قیمت عادی: ${money(product.price)} تومان\n` : '';
    return `⏳ پیش‌خرید «${product.title}» شروع شد! 🌸\n\n` +
      '📦 این محصول فعلاً موجود نیست، ولی می‌توانید همین حالا با قیمت پیش‌خرید سفارش بدهید:\n\n' +
      `${regular}🔥 قیمت پیش‌خرید: ${money(product.presalePrice)} تومان\n\n` +
      '🛍 برای ثبت سفارش، این محصول را از منوی ربات انتخاب کنید.';
  }
  return `🚫 «${product.title}» فعلاً موجود نیست.\n\n🌸 از همراهی شما سپاسگزاریم.`;
}

async function sendNoticePreview(env, chatId, productId, text) {
  const buyers = await db.getPresaleBuyers(env, productId);
  const rows = [];
  if (buyers.length) rows.push([{ text: `📤 ارسال به خریداران پیش‌خرید (${buyers.length.toLocaleString('fa-IR')} نفر)`, callback_data: `nt:${productId}:b` }]);
  // پیام به همه مثل «ارسال پیام همگانی» فقط برای سوپرادمین است
  if (isSuperAdmin(env, chatId)) rows.push([{ text: '📢 ارسال به همه‌ی کاربران', callback_data: `nt:${productId}:a` }]);
  rows.push([{ text: '✏️ ویرایش متن', callback_data: `nt:${productId}:e` }]);
  rows.push([{ text: '❌ ارسال نشود', callback_data: `nt:${productId}:x` }]);
  await api.sendMessage(
    env,
    chatId,
    `📢 <b>به کاربران اطلاع داده شود؟</b>\n\nمتن پیام:\n<blockquote>${escapeHtml(text)}</blockquote>\n\nاگر متن مناسب است یکی از گزینه‌های ارسال را بزنید.`,
    { inline_keyboard: rows }
  );
}

// کالای پنهان در منو نیست و اطلاع‌رسانی درباره‌اش معنا ندارد
async function offerNotice(env, chatId, product, kind) {
  if (product.hidden) return;
  const text = defaultNoticeText(product, kind);
  await db.setSession(env, chatId, NOTICE_STATE, { productId: product.id, kind, text, step: 'choose' });
  await sendNoticePreview(env, chatId, product.id, text);
}

async function handleNoticeStep(env, chatId, session, message) {
  const data = session.data || {};
  if (data.step !== 'edit') {
    await api.sendMessage(env, chatId, '👆 یکی از دکمه‌های زیر متن پیام را بزنید، یا «❌ ارسال نشود».');
    return;
  }
  const text = String(message.text || '').trim();
  if (!text) {
    await api.sendMessage(env, chatId, '⚠️ متن پیام را به‌صورت نوشته بفرستید.');
    return;
  }
  if (escapeHtml(text).length > MAX_NOTICE_HTML_LENGTH) {
    await api.sendMessage(env, chatId, '⚠️ متن پیام خیلی طولانی است؛ کوتاه‌تر بفرستید.');
    return;
  }
  await db.setSession(env, chatId, NOTICE_STATE, { ...data, text, step: 'choose' });
  await sendNoticePreview(env, chatId, data.productId, text);
}

async function handleNoticeCallback(env, chatId, actorId, product, act, callbackId, clearButtons) {
  const session = await db.getSession(env, chatId);
  const draft = session.state === NOTICE_STATE && session.data?.productId === product.id ? session.data : null;
  if (!draft || draft.step !== 'choose') {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این پیش‌نمایش منقضی شده است.', show_alert: true });
    await clearButtons();
    return;
  }

  if (act === 'x') {
    await db.clearSession(env, chatId);
    await api.answerCallbackQuery(env, callbackId, { text: 'ارسال نشد' });
    await clearButtons();
    await api.sendMessage(env, chatId, '❌ پیامی برای کاربران ارسال نشد.', await menuKeyboardFor(env, chatId));
    return;
  }

  if (act === 'e') {
    await db.setSession(env, chatId, NOTICE_STATE, { ...draft, step: 'edit' });
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await api.sendMessage(env, chatId, `✏️ متن جدید پیام را بفرستید. متن فعلی برای کپی:\n\n<code>${escapeHtml(draft.text)}</code>`, cancelKeyboard());
    return;
  }

  if (act !== 'b' && act !== 'a') {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ دکمه نامعتبر است.', show_alert: true });
    return;
  }
  if (act === 'a' && !isSuperAdmin(env, actorId)) {
    await api.answerCallbackQuery(env, callbackId, { text: '⛔ ارسال به همه‌ی کاربران فقط برای مدیر اصلی است.', show_alert: true });
    return;
  }

  const recipients = act === 'a' ? await db.getAllChatIds(env) : await db.getPresaleBuyers(env, product.id);
  const result = await broadcastText(env, chatId, recipients, draft.text);
  if (!result.ok) {
    // پیش‌نویس می‌ماند تا بعد از پایان ارسال قبلی دوباره زده شود
    const reason = result.reason === 'running' ? '⚠️ پیام همگانی قبلی هنوز تمام نشده است؛ کمی بعد دوباره بزنید.' : '⚠️ گیرنده‌ای پیدا نشد.';
    await api.answerCallbackQuery(env, callbackId, { text: reason, show_alert: true });
    return;
  }
  if (draft.kind === 'on') await db.markPresaleNotified(env, product.id);
  await db.clearSession(env, chatId);
  await api.answerCallbackQuery(env, callbackId, { text: '📢 در صف ارسال قرار گرفت' });
  await clearButtons();
  await api.sendMessage(
    env,
    chatId,
    `📢 پیام برای ${result.total.toLocaleString('fa-IR')} نفر در صف ارسال قرار گرفت. بعد از پایان ارسال، نتیجه برایتان فرستاده می‌شود.`,
    await menuKeyboardFor(env, chatId)
  );
}

// ----------------------------------------------------
// غیرفعال کردن کالا: انتخاب کالا ← سوال پیش‌خرید ← قیمت پیش‌خرید یا غیرفعال کامل
// ----------------------------------------------------

function statusLabel(product) {
  if (isPresale(product)) return `⏳ پیش‌خرید با قیمت ${money(product.presalePrice)} تومان`;
  return product.disabled ? '🚫 غیرفعال' : '✅ فعال';
}

export async function showDisablePicker(env, chatId) {
  const products = await listProducts(env);
  const rows = products.map((p) => [{ text: `${p.buttonText}${isPresale(p) ? ` — ${money(p.presalePrice)}` : ''}`, callback_data: `ds:${p.id}` }]);
  await api.sendMessage(
    env,
    chatId,
    products.length ? '⏸ <b>فعال / غیرفعال کردن کالا</b>\n\nکالا را انتخاب کنید (⏳ پیش‌خرید، 🚫 غیرفعال):' : '🛠 هنوز هیچ محصولی ساخته نشده است.',
    { inline_keyboard: rows }
  );
}

async function askDisableChoice(env, chatId, product) {
  const rows = [
    [{ text: isPresale(product) ? '💰 تغییر قیمت پیش‌خرید' : '✅ بله، قیمت پیش‌خرید می‌گذارم', callback_data: `dsy:${product.id}` }],
    [{ text: isPresale(product) ? '🚫 لغو پیش‌خرید و غیرفعال ماندن' : '🚫 خیر، غیرفعال شود', callback_data: `dsn:${product.id}` }],
  ];
  if (product.disabled) rows.push([{ text: '🟢 فعال کردن دوباره', callback_data: `dse:${product.id}` }]);
  rows.push([{ text: '🔙 لیست کالاها', callback_data: 'ds_list' }]);
  await api.sendMessage(
    env,
    chatId,
    `⏸ <b>${escapeHtml(product.title)}</b>\nوضعیت: ${statusLabel(product)}\n💰 قیمت عادی: ${money(product.price)} تومان\n\nآیا مایل به ارائه‌ی قیمت پیش‌خرید هستید؟`,
    { inline_keyboard: rows }
  );
}

async function handlePresalePriceStep(env, chatId, session, message) {
  const product = await getFullProduct(env, session.data?.productId);
  if (!product) {
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '⚠️ محصول پیدا نشد؛ ممکن است حذف شده باشد.', await menuKeyboardFor(env, chatId));
    return;
  }
  const r = validatePresalePrice(message.text, product.price);
  if (r.error) {
    await api.sendMessage(env, chatId, r.error);
    return;
  }
  await updateProduct(env, product.id, { disabled: 1, presalePrice: r.value });
  await db.clearSession(env, chatId);
  await api.sendMessage(
    env,
    chatId,
    `⏳ «${escapeHtml(product.title)}» با قیمت پیش‌خرید <b>${money(r.value)} تومان</b> ثبت شد.`,
    await menuKeyboardFor(env, chatId)
  );
  await showProductAdmin(env, chatId, product.id);
  await offerNotice(env, chatId, { ...product, presalePrice: r.value }, 'presale');
}

// ----------------------------------------------------
// لیست و صفحه‌ی مدیریت محصول
// ----------------------------------------------------

export async function showProductsAdmin(env, chatId) {
  const products = await listProducts(env);
  const rows = products.map((p) => [
    { text: `${p.hidden ? '🙈 ' : ''}${p.position}. ${p.buttonText} — ${p.price > 0 ? money(p.price) : 'بدون قیمت'}`, callback_data: `pa:${p.id}` },
  ]);
  rows.push([{ text: '➕ ساخت محصول جدید', callback_data: 'pa_new' }]);
  await api.sendMessage(
    env,
    chatId,
    products.length
      ? '🛠 <b>مدیریت محصولات</b>\n\nمحصولات به ترتیب جایگاه دکمه‌ها (قیمت به تومان؛ 🙈 = پنهان از منو، ⏳ = پیش‌خرید، 🚫 = غیرفعال). برای ویرایش، جابجایی یا حذف روی محصول بزنید:'
      : '🛠 هنوز هیچ محصولی ساخته نشده است.',
    { inline_keyboard: rows }
  );
}

export async function showProductAdmin(env, chatId, productId) {
  const product = await getFullProduct(env, productId);
  if (!product) {
    await api.sendMessage(env, chatId, '⚠️ محصول پیدا نشد؛ ممکن است حذف شده باشد.');
    return;
  }
  const total = await countProducts(env);
  const caption =
    `${buildProductCaption(product)}\n\n🔢 جایگاه: ${product.position} از ${total}` + (product.hidden ? '\n🚫 پنهان از منو' : '');
  const keyboard = {
    inline_keyboard: [
      [
        { text: '📝 نام', callback_data: `pe:${product.id}:title` },
        { text: '📋 ویژگی‌ها', callback_data: `pe:${product.id}:description` },
      ],
      [
        { text: '🖼 عکس', callback_data: `pe:${product.id}:photo` },
        { text: '💰 قیمت', callback_data: `pe:${product.id}:price` },
      ],
      [
        { text: '🏷 قیمت خط‌خورده', callback_data: `pe:${product.id}:old_price` },
        { text: product.hidden ? '👁 نمایش در منو' : '🚫 پنهان از منو', callback_data: `ph:${product.id}` },
      ],
      [
        { text: '🔢 جابجایی', callback_data: `pe:${product.id}:position` },
        { text: '🗑 حذف', callback_data: `pd:${product.id}` },
      ],
      [{ text: product.disabled ? '⏸ وضعیت موجودی / پیش‌خرید' : '⏸ غیرفعال کردن', callback_data: `ds:${product.id}` }],
      [{ text: '🔙 لیست محصولات', callback_data: 'pa_list' }],
    ],
  };
  if (product.photoFileId) await api.sendPhoto(env, chatId, product.photoFileId, caption, keyboard);
  else await api.sendMessage(env, chatId, caption, keyboard);
}

// ----------------------------------------------------
// دکمه‌های شیشه‌ای؛ اگر data مربوط به این بخش نباشد false برمی‌گرداند
// ----------------------------------------------------

export function isProductCallback(data) {
  return data === 'pa_new' || data === 'pa_list' || data === 'ds_list' || data === 'pnew_ok' || data === 'pnew_no' || /^(pa|pe|ph|pd|pdok|ds|dsy|dsn|dse|nt):/.test(data);
}

export async function handleProductCallback(env, chatId, data, callbackId, messageId, actorId = chatId) {
  if (!isProductCallback(data)) return false;
  const clearButtons = () =>
    messageId ? api.editMessageReplyMarkup(env, chatId, messageId, { inline_keyboard: [] }).catch(() => {}) : null;

  if (data === 'pa_new') {
    await api.answerCallbackQuery(env, callbackId);
    await startNewProduct(env, chatId);
    return true;
  }

  if (data === 'pa_list') {
    await api.answerCallbackQuery(env, callbackId);
    await showProductsAdmin(env, chatId);
    return true;
  }

  if (data === 'ds_list') {
    await api.answerCallbackQuery(env, callbackId);
    await db.clearSession(env, chatId);
    await showDisablePicker(env, chatId);
    return true;
  }

  if (data === 'pnew_no') {
    await api.answerCallbackQuery(env, callbackId, { text: 'لغو شد' });
    await clearButtons();
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '❌ ساخت محصول لغو شد.', await menuKeyboardFor(env, chatId));
    return true;
  }

  if (data === 'pnew_ok') {
    const session = await db.getSession(env, chatId);
    const draft = session.state === NEW_PRODUCT_STATE ? session.data || {} : {};
    if (draft.step !== 'confirm') {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این پیش‌نمایش منقضی شده است.', show_alert: true });
      await clearButtons();
      return true;
    }
    // نام ممکن است در این فاصله توسط ادمین دیگری گرفته شده باشد
    if (await titleTaken(env, draft.title)) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ محصولی با همین نام همین الان ثبت شد.', show_alert: true });
      return true;
    }
    await db.clearSession(env, chatId);
    const product = await addProduct(env, draft);
    await api.answerCallbackQuery(env, callbackId, { text: '✅ محصول ثبت شد' });
    await clearButtons();
    await api.sendMessage(
      env,
      chatId,
      `✅ <b>محصول «${escapeHtml(product.title)}» ثبت شد</b> و در جایگاه ${product.position} منو قرار گرفت.`,
      await menuKeyboardFor(env, chatId)
    );
    await api.sendMessage(env, chatId, 'کار بعدی؟', {
      inline_keyboard: [
        [{ text: '➕ ساخت محصول دیگر', callback_data: 'pa_new' }],
        [{ text: '🛠 مدیریت محصولات', callback_data: 'pa_list' }],
      ],
    });
    return true;
  }

  const [action, productId, field] = data.split(':');
  const product = await getFullProduct(env, productId);
  if (!product) {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ محصول پیدا نشد؛ ممکن است حذف شده باشد.', show_alert: true });
    return true;
  }

  if (action === 'pa') {
    await api.answerCallbackQuery(env, callbackId);
    await showProductAdmin(env, chatId, product.id);
    return true;
  }

  if (action === 'pe') {
    if (!FIELD_LABELS[field]) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ دکمه نامعتبر است.', show_alert: true });
      return true;
    }
    await api.answerCallbackQuery(env, callbackId);
    await startEdit(env, chatId, product, field);
    return true;
  }

  if (action === 'ph') {
    await updateProduct(env, product.id, { hidden: product.hidden ? 0 : 1 });
    await api.answerCallbackQuery(env, callbackId, { text: product.hidden ? '👁 در منو نمایش داده می‌شود' : '🚫 از منو پنهان شد' });
    await clearButtons();
    await api.sendMessage(env, chatId, '✅ وضعیت نمایش محصول تغییر کرد.', await menuKeyboardFor(env, chatId));
    await showProductAdmin(env, chatId, product.id);
    return true;
  }

  if (action === 'ds') {
    await api.answerCallbackQuery(env, callbackId);
    await askDisableChoice(env, chatId, product);
    return true;
  }

  if (action === 'dsy') {
    await api.answerCallbackQuery(env, callbackId);
    await clearButtons();
    await db.setSession(env, chatId, PRESALE_PRICE_STATE, { productId: product.id });
    await api.sendMessage(
      env,
      chatId,
      `⏳ قیمت پیش‌خرید «${escapeHtml(product.title)}» را به تومان بفرستید (قیمت عادی: ${money(product.price)} تومان):`,
      cancelKeyboard()
    );
    return true;
  }

  if (action === 'nt') {
    await handleNoticeCallback(env, chatId, actorId, product, field, callbackId, clearButtons);
    return true;
  }

  if (action === 'dsn' || action === 'dse') {
    const enable = action === 'dse';
    // دکمه‌ی تکراری وضعیت را عوض نمی‌کند و نباید پیشنهاد اطلاع‌رسانی بدهد
    const changed = enable ? product.disabled : !product.disabled || isPresale(product);
    await updateProduct(env, product.id, { disabled: enable ? 0 : 1, presalePrice: 0 });
    await api.answerCallbackQuery(env, callbackId, { text: enable ? '🟢 فعال شد' : '🚫 غیرفعال شد' });
    await clearButtons();
    await db.clearSession(env, chatId);
    await api.sendMessage(
      env,
      chatId,
      enable ? `🟢 «${escapeHtml(product.title)}» دوباره فعال شد.` : `🚫 «${escapeHtml(product.title)}» غیرفعال شد و قابل خرید نیست.`,
      await menuKeyboardFor(env, chatId)
    );
    await showProductAdmin(env, chatId, product.id);
    if (changed) await offerNotice(env, chatId, product, enable ? 'on' : 'off');
    return true;
  }

  if (action === 'pd') {
    await api.answerCallbackQuery(env, callbackId);
    await api.sendMessage(env, chatId, `🗑 محصول «<b>${escapeHtml(product.title)}</b>» حذف شود؟\nسفارش‌های قبلی این محصول در گزارش‌ها باقی می‌مانند.`, {
      inline_keyboard: [
        [
          { text: '✅ بله، حذف شود', callback_data: `pdok:${product.id}` },
          { text: '🔙 خیر', callback_data: `pa:${product.id}` },
        ],
      ],
    });
    return true;
  }

  if (action === 'pdok') {
    await deleteProduct(env, product.id);
    await api.answerCallbackQuery(env, callbackId, { text: '🗑 حذف شد' });
    await clearButtons();
    await api.sendMessage(env, chatId, `🗑 محصول «${escapeHtml(product.title)}» حذف شد.`, await menuKeyboardFor(env, chatId));
    await showProductsAdmin(env, chatId);
    return true;
  }

  return false;
}
