// -*- محصولات فروشگاه -*-
//
// محصولات دیگر داخل کد ثابت نیستند؛ ادمین از داخل ربات (➕ ساخت محصول) آن‌ها را می‌سازد و در جدول
// products ذخیره می‌شوند. position ترتیب دکمه‌ها در منوی اصلی است (۱ = اولین دکمه) و همیشه
// پشت‌سرهم ۱..n نگه داشته می‌شود: درج در جایگاه k محصولات k به بعد را یک خانه جلو می‌برد.

import { courierFee, freeShippingMin, money, postFee } from './config.js';

export const MAX_TITLE_LENGTH = 40;
// کپشن عکس در تلگرام حداکثر ۱۰۲۴ کاراکتر است؛ بقیه برای عنوان و قیمت می‌ماند
export const MAX_DESCRIPTION_LENGTH = 600;
// زیر توضیحات همه‌ی محصولات خوراکی می‌آید
export const PRODUCT_QUALITY_NOTE = '🌿 ارگانیک و بدون هیچ‌گونه افزودنی\n🗓 بهترین زمان مصرف: تا ۶ ماه پس از خرید';

// محصولی که عنوانش «شیشه» دارد ظرف خالی است (مثل «🎨 شیشه‌ی نقاشی‌شده») و نکته‌ی بالا را نمی‌گیرد
export function isEdibleProduct(product) {
  return !String(product?.title || '').includes('شیشه');
}

// علامت دکمه‌ی منو برای کالای غیرفعال؛ رنگ دکمه (style) فقط در نسخه‌های جدید تلگرام دیده می‌شود
const PRESALE_MARK = '⏳';
const DISABLED_MARK = '🚫';
const BUTTON_MARK_RE = new RegExp(`^(?:${PRESALE_MARK}|${DISABLED_MARK}) `);

export function hasButtonMark(title) {
  return BUTTON_MARK_RE.test(String(title ?? ''));
}

// کالای غیرفعال با قیمت پیش‌خرید: فقط با همان قیمت و خرید مستقیم فروخته می‌شود
export function isPresale(product) {
  return Boolean(product?.disabled && product.presalePrice > 0);
}

export function isPurchasable(product) {
  return Boolean(product && !product.hidden && (!product.disabled || isPresale(product)));
}

export function unitPrice(product) {
  return isPresale(product) ? product.presalePrice : product?.price || 0;
}

// نام محصول روی سفارش؛ پیام‌های ادمین، گزارش و اکسل پیش‌خرید را از همین تشخیص می‌دهند
export function orderTitle(product) {
  return isPresale(product) ? `${product.title} (پیش‌خرید)` : product?.title;
}

function menuButton(title, disabled, presalePrice) {
  if (!disabled) return { buttonText: title, buttonStyle: '' };
  return presalePrice > 0
    ? { buttonText: `${PRESALE_MARK} ${title}`, buttonStyle: 'success' }
    : { buttonText: `${DISABLED_MARK} ${title}`, buttonStyle: 'danger' };
}

function toProduct(row) {
  if (!row) return null;
  const disabled = Boolean(row.disabled);
  const presalePrice = Number(row.presale_price) || 0;
  return {
    id: String(row.id),
    title: row.title,
    ...menuButton(row.title, disabled, presalePrice),
    description: row.description || '',
    photoFileId: row.photo_file_id || '',
    price: Number(row.price) || 0,
    position: Number(row.position) || 0,
    oldPrice: Number(row.old_price) || 0,
    hidden: Boolean(row.hidden),
    disabled,
    presalePrice,
    needsOs: false,
  };
}

// همه‌ی محصولات، حتی پنهان‌ها (پنل ادمین)؛ منوی کاربر فقط !hidden را نشان می‌دهد
export async function listProducts(env) {
  const { results } = await env.DB.prepare('SELECT * FROM products ORDER BY position, id').all();
  return (results || []).map(toProduct);
}

export async function countProducts(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM products').first();
  return Number(row?.cnt) || 0;
}

export async function getFullProduct(env, productId) {
  if (!/^\d+$/.test(String(productId ?? ''))) return null;
  const row = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(Number(productId)).first();
  return toProduct(row);
}

export async function findProductIdByButton(env, buttonText) {
  if (!buttonText) return null;
  // کیبورد قدیمی کاربر ممکن است هنوز علامت قبلی را داشته باشد، پس علامت بدون توجه به وضعیت فعلی حذف می‌شود
  const title = String(buttonText).replace(BUTTON_MARK_RE, '');
  const row = await env.DB.prepare('SELECT id FROM products WHERE title = ? AND hidden = 0').bind(title).first();
  return row ? String(row.id) : null;
}

export async function titleTaken(env, title, exceptId = null) {
  const row = await env.DB.prepare('SELECT id FROM products WHERE title = ? AND id != ?')
    .bind(title, Number(exceptId) || 0)
    .first();
  return Boolean(row);
}

const clampPosition = (position, max) => Math.min(Math.max(1, Math.trunc(Number(position) || 1)), max);

export async function addProduct(env, { title, description, photoFileId, price, position }) {
  const pos = clampPosition(position, (await countProducts(env)) + 1);
  const [, inserted] = await env.DB.batch([
    env.DB.prepare('UPDATE products SET position = position + 1 WHERE position >= ?').bind(pos),
    env.DB.prepare(
      'INSERT INTO products (title, description, photo_file_id, price, position) VALUES (?, ?, ?, ?, ?)'
    ).bind(title, description, photoFileId || '', Number(price) || 0, pos),
  ]);
  return getFullProduct(env, inserted.meta.last_row_id);
}

const EDITABLE_FIELDS = {
  title: 'title',
  description: 'description',
  photoFileId: 'photo_file_id',
  price: 'price',
  oldPrice: 'old_price',
  hidden: 'hidden',
  disabled: 'disabled',
  presalePrice: 'presale_price',
};

export async function updateProduct(env, productId, patch) {
  for (const [key, column] of Object.entries(EDITABLE_FIELDS)) {
    if (patch[key] === undefined) continue;
    await env.DB.prepare(`UPDATE products SET ${column} = ? WHERE id = ?`).bind(patch[key], Number(productId)).run();
  }
  return getFullProduct(env, productId);
}

export async function moveProduct(env, productId, newPosition) {
  const product = await getFullProduct(env, productId);
  if (!product) return null;
  const to = clampPosition(newPosition, await countProducts(env));
  const from = product.position;
  if (to === from) return product;

  const shift =
    to < from
      ? env.DB.prepare('UPDATE products SET position = position + 1 WHERE position >= ? AND position < ?').bind(to, from)
      : env.DB.prepare('UPDATE products SET position = position - 1 WHERE position > ? AND position <= ?').bind(from, to);
  await env.DB.batch([shift, env.DB.prepare('UPDATE products SET position = ? WHERE id = ?').bind(to, Number(productId))]);
  return getFullProduct(env, productId);
}

export async function deleteProduct(env, productId) {
  const product = await getFullProduct(env, productId);
  if (!product) return false;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM products WHERE id = ?').bind(Number(productId)),
    env.DB.prepare('UPDATE products SET position = position - 1 WHERE position > ?').bind(product.position),
  ]);
  return true;
}

export function buildProductCaption(product) {
  const note = isEdibleProduct(product) ? `${PRODUCT_QUALITY_NOTE}\n\n` : '';
  let text = `🛍 <b>${escapeHtml(product.title)}</b>\n\n${escapeHtml(product.description)}\n\n${note}`;
  if (isPresale(product)) {
    if (product.price > 0) text += `💰 قیمت عادی: <s>${money(product.price)}</s> تومان\n`;
    text += `⏳ قیمت پیش‌خرید: <b>${money(product.presalePrice)} تومان</b>\n📦 فعلاً ناموجود؛ بعد از موجود شدن ارسال می‌شود.`;
  } else if (product.disabled) {
    text += '🚫 این محصول فعلاً موجود نیست.';
  } else if (product.price > 0 && product.oldPrice > product.price) {
    text += `💰 قیمت: <s>${money(product.oldPrice)}</s> تومان\n🔥 تخفیف ویژه: <b>${money(product.price)} تومان</b>`;
  } else {
    text += product.price > 0
      ? `💰 قیمت: <b>${money(product.price)} تومان</b>`
      : '⚠️ این محصول هنوز قیمت‌گذاری نشده است.';
  }
  return text;
}

// ----------------------------------------------------
// تعداد و روش تحویل سفارش در ستون os_type ذخیره می‌شود:
//   «p3» = ۳ عدد با تحویل حضوری | «c3» = ۳ عدد با ارسال پیک | «s3» = ۳ عدد با پست
//   تک‌حرفی («c») = سفارش سبد خرید؛ تعداد هر کالا در order_items است
// مقدار خالی (سفارش‌های قدیمی) یعنی ۱ عدد بدون هزینه‌ی ارسال.
// ----------------------------------------------------
export const MAX_QUANTITY = 20;

const DELIVERY_BY_CODE = { p: 'pickup', c: 'courier', s: 'post' };
const DELIVERY_LABELS = { pickup: '🏬 تحویل حضوری', courier: '🛵 ارسال با پیک', post: '📦 ارسال با پست' };

export function parseVariant(variant) {
  const m = /^([pcs])(\d{1,3})?$/.exec(String(variant || ''));
  if (!m) return { delivery: '', quantity: 1 };
  const quantity = Math.min(Math.max(1, Number(m[2] ?? 1)), MAX_QUANTITY);
  return { delivery: DELIVERY_BY_CODE[m[1]], quantity };
}

export function variantCode(delivery, quantity) {
  const q = Math.min(Math.max(1, Math.trunc(Number(quantity) || 1)), MAX_QUANTITY);
  const code = Object.keys(DELIVERY_BY_CODE).find((c) => DELIVERY_BY_CODE[c] === delivery) || 'p';
  return `${code}${q}`;
}

// پیک و پست آدرس لازم دارند
export function needsAddress(variant) {
  return ['courier', 'post'].includes(parseVariant(variant).delivery);
}

export function variantLabel(variant) {
  const { delivery, quantity } = parseVariant(variant);
  if (!delivery) return '';
  if (String(variant).length === 1) return DELIVERY_LABELS[delivery];
  return `${quantity.toLocaleString('fa-IR')} عدد · ${DELIVERY_LABELS[delivery]}`;
}

// قیمت کالا (قیمت واحد × تعداد)، بدون هزینه‌ی ارسال
export function resolvePrice(product, variant = '') {
  return product ? unitPrice(product) * parseVariant(variant).quantity : 0;
}

// هزینه‌ی ارسال بر اساس مبلغ کالا بعد از تخفیف
export function shippingFee(env, variant, itemsTotal) {
  const { delivery } = parseVariant(variant);
  if (delivery !== 'courier' && delivery !== 'post') return 0;
  if (itemsTotal >= freeShippingMin(env)) return 0;
  return delivery === 'post' ? postFee(env) : courierFee(env);
}

// مبلغ نهایی سفارش: تخفیف فقط روی کالا، هزینه‌ی ارسال بعد از تخفیف اضافه می‌شود
export function orderPrice(env, product, variant = '', discountPercent = 0) {
  const basePrice = resolvePrice(product, variant);
  // در سبد خرید، کد ممکن است فقط شامل بعضی ردیف‌ها شود
  const discountAmount = Math.round(((product?.discountableTotal ?? basePrice) * discountPercent) / 100);
  const itemsTotal = Math.max(0, basePrice - discountAmount);
  const shipping = basePrice > 0 ? shippingFee(env, variant, itemsTotal) : 0;
  return { basePrice, discountAmount, itemsTotal, shipping, price: itemsTotal + shipping };
}

export function shippingInfoText(env) {
  return `🏬 تحویل حضوری: رایگان\n` +
    `🛵 پیک (فقط تهران): ${money(courierFee(env))} تومان\n` +
    `📦 پست (سایر شهرها): ${money(postFee(env))} تومان\n` +
    `🎁 خرید بالای ${money(freeShippingMin(env))} تومان: پیک و پست رایگان`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
