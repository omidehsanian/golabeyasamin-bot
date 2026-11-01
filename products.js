// -*- محصولات فروشگاه -*-
//
// محصولات دیگر داخل کد ثابت نیستند؛ ادمین از داخل ربات (➕ ساخت محصول) آن‌ها را می‌سازد و در جدول
// products ذخیره می‌شوند. position ترتیب دکمه‌ها در منوی اصلی است (۱ = اولین دکمه) و همیشه
// پشت‌سرهم ۱..n نگه داشته می‌شود: درج در جایگاه k محصولات k به بعد را یک خانه جلو می‌برد.

import { courierFee, freeShippingMin, money } from './config.js';

export const MAX_TITLE_LENGTH = 40;
// کپشن عکس در تلگرام حداکثر ۱۰۲۴ کاراکتر است؛ بقیه برای عنوان و قیمت می‌ماند
export const MAX_DESCRIPTION_LENGTH = 850;

function toProduct(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    title: row.title,
    buttonText: row.title,
    description: row.description || '',
    photoFileId: row.photo_file_id || '',
    price: Number(row.price) || 0,
    position: Number(row.position) || 0,
    needsOs: false,
  };
}

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
  const row = await env.DB.prepare('SELECT id FROM products WHERE title = ?').bind(buttonText).first();
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

const EDITABLE_FIELDS = { title: 'title', description: 'description', photoFileId: 'photo_file_id', price: 'price' };

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
  let text = `🛍 <b>${escapeHtml(product.title)}</b>\n\n${escapeHtml(product.description)}\n\n`;
  text += product.price > 0
    ? `💰 قیمت: <b>${money(product.price)} تومان</b>`
    : '⚠️ این محصول هنوز قیمت‌گذاری نشده است.';
  return text;
}

// ----------------------------------------------------
// تعداد و روش تحویل سفارش در ستون os_type ذخیره می‌شود:
//   «p3» = ۳ عدد با تحویل حضوری | «c3» = ۳ عدد با ارسال پیک
// مقدار خالی (سفارش‌های قدیمی) یعنی ۱ عدد بدون هزینه‌ی ارسال.
// ----------------------------------------------------
export const MAX_QUANTITY = 20;
export const QUANTITY_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];

export function parseVariant(variant) {
  const m = /^([pc])(\d{1,3})$/.exec(String(variant || ''));
  if (!m) return { delivery: '', quantity: 1 };
  const quantity = Math.min(Math.max(1, Number(m[2])), MAX_QUANTITY);
  return { delivery: m[1] === 'c' ? 'courier' : 'pickup', quantity };
}

export function variantCode(delivery, quantity) {
  const q = Math.min(Math.max(1, Math.trunc(Number(quantity) || 1)), MAX_QUANTITY);
  return `${delivery === 'courier' ? 'c' : 'p'}${q}`;
}

export function variantLabel(variant) {
  const { delivery, quantity } = parseVariant(variant);
  if (!delivery) return '';
  return `${quantity.toLocaleString('fa-IR')} عدد · ${delivery === 'courier' ? '🛵 ارسال با پیک' : '🏬 تحویل حضوری'}`;
}

// قیمت کالا (قیمت واحد × تعداد)، بدون هزینه‌ی ارسال
export function resolvePrice(product, variant = '') {
  return product ? (product.price || 0) * parseVariant(variant).quantity : 0;
}

// هزینه‌ی ارسال بر اساس مبلغ کالا بعد از تخفیف
export function shippingFee(env, variant, itemsTotal) {
  if (parseVariant(variant).delivery !== 'courier') return 0;
  return itemsTotal >= freeShippingMin(env) ? 0 : courierFee(env);
}

// مبلغ نهایی سفارش: تخفیف فقط روی کالا، هزینه‌ی ارسال بعد از تخفیف اضافه می‌شود
export function orderPrice(env, product, variant = '', discountPercent = 0) {
  const basePrice = resolvePrice(product, variant);
  const discountAmount = Math.round((basePrice * discountPercent) / 100);
  const itemsTotal = Math.max(0, basePrice - discountAmount);
  const shipping = basePrice > 0 ? shippingFee(env, variant, itemsTotal) : 0;
  return { basePrice, discountAmount, itemsTotal, shipping, price: itemsTotal + shipping };
}

export function shippingInfoText(env) {
  return `🚚 تحویل حضوری: رایگان | ارسال با پیک: ${money(courierFee(env))} تومان\n` +
    `🎁 خرید بالای ${money(freeShippingMin(env))} تومان: ارسال با پیک رایگان`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
