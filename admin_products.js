// -*- ساخت و مدیریت محصولات از داخل ربات (ادمین‌ها) -*-
//
// ➕ ساخت محصول: نام (متن دکمه) → ویژگی‌ها → عکس → قیمت → جایگاه دکمه (عدد) → پیش‌نمایش → ✅ ثبت
// 🛠 مدیریت محصولات: لیست به ترتیب جایگاه → محصول → ویرایش نام/ویژگی‌ها/عکس/قیمت، جابجایی، حذف
//
// سشن‌ها:
//   prod_new   { step, title, description, photoFileId, price, position }
//   prod_edit  { productId, field }
//
// callback_data:
//   pa_new            شروع ساخت محصول
//   pa_list           لیست محصولات
//   pa:<id>           صفحه‌ی مدیریت یک محصول
//   pe:<id>:<field>   ویرایش یک بخش (title | description | photo | price | position)
//   pd:<id>           سوال حذف      pdok:<id>  حذف قطعی
//   pnew_ok           ثبت محصول جدید (اطلاعات از سشن خوانده می‌شود)
//   pnew_no           انصراف از ساخت

import * as api from './api.js';
import * as db from './db.js';
import { cancelKeyboard, RESERVED_BUTTONS } from './keyboards.js';
import { money, productColumns } from './config.js';
import { menuKeyboardFor } from './flows.js';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
  addProduct,
  buildProductCaption,
  countProducts,
  deleteProduct,
  escapeHtml,
  getFullProduct,
  listProducts,
  moveProduct,
  titleTaken,
  updateProduct,
} from './products.js';

export const NEW_PRODUCT_STATE = 'prod_new';
export const EDIT_PRODUCT_STATE = 'prod_edit';
export const PRODUCT_SESSION_STATES = [NEW_PRODUCT_STATE, EDIT_PRODUCT_STATE];

const MAX_PRICE = 1_000_000_000;

const FIELD_LABELS = {
  title: 'نام محصول',
  description: 'ویژگی‌های محصول',
  photo: 'عکس محصول',
  price: 'قیمت',
  position: 'جایگاه دکمه',
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
  if (RESERVED_BUTTONS.includes(title)) return { error: '⚠️ این نام متعلق به یکی از دکمه‌های ثابت منوست؛ نام دیگری انتخاب کنید.' };
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
  const columns = productColumns(env);
  const rows = [];
  for (let i = 0; i < names.length; i += columns) {
    rows.push(names.slice(i, i + columns).map((n) => `[ ${escapeHtml(n)} ]`).join('  '));
  }
  return rows.join('\n');
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
  else if (field === 'price') r = validatePrice(text);
  else r = validatePosition(text, await countProducts(env));
  if (r.error) {
    await api.sendMessage(env, chatId, r.error);
    return;
  }

  if (field === 'position') await moveProduct(env, product.id, r.value);
  else if (field === 'photo') await updateProduct(env, product.id, { photoFileId: r.value });
  else await updateProduct(env, product.id, { [field]: r.value });

  await db.clearSession(env, chatId);
  await api.sendMessage(env, chatId, `✅ ${FIELD_LABELS[field]} بروزرسانی شد.`, await menuKeyboardFor(env, chatId));
  await showProductAdmin(env, chatId, product.id);
}

// پیام ادمین وقتی در یکی از سشن‌های محصول است
export async function handleProductSessionMessage(env, chatId, session, message) {
  if (session.state === NEW_PRODUCT_STATE) return handleNewProductStep(env, chatId, session, message);
  return handleEditStep(env, chatId, session, message);
}

// ----------------------------------------------------
// لیست و صفحه‌ی مدیریت محصول
// ----------------------------------------------------

export async function showProductsAdmin(env, chatId) {
  const products = await listProducts(env);
  const rows = products.map((p) => [
    { text: `${p.position}. ${p.title} — ${p.price > 0 ? money(p.price) : 'بدون قیمت'}`, callback_data: `pa:${p.id}` },
  ]);
  rows.push([{ text: '➕ ساخت محصول جدید', callback_data: 'pa_new' }]);
  await api.sendMessage(
    env,
    chatId,
    products.length
      ? '🛠 <b>مدیریت محصولات</b>\n\nمحصولات به ترتیب جایگاه دکمه‌ها (قیمت به تومان). برای ویرایش، جابجایی یا حذف روی محصول بزنید:'
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
  const caption = `${buildProductCaption(product)}\n\n🔢 جایگاه: ${product.position} از ${total}`;
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
        { text: '🔢 جابجایی', callback_data: `pe:${product.id}:position` },
        { text: '🗑 حذف', callback_data: `pd:${product.id}` },
      ],
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
  return data === 'pa_new' || data === 'pa_list' || data === 'pnew_ok' || data === 'pnew_no' || /^(pa|pe|pd|pdok):/.test(data);
}

export async function handleProductCallback(env, chatId, data, callbackId, messageId) {
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
