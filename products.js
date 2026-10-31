// -*- محصولات فروشگاه -*-
//
// محصولات دیگر داخل کد ثابت نیستند؛ ادمین از داخل ربات (➕ ساخت محصول) آن‌ها را می‌سازد و در جدول
// products ذخیره می‌شوند. position ترتیب دکمه‌ها در منوی اصلی است (۱ = اولین دکمه) و همیشه
// پشت‌سرهم ۱..n نگه داشته می‌شود: درج در جایگاه k محصولات k به بعد را یک خانه جلو می‌برد.

import { money } from './config.js';

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

export function resolvePrice(product) {
  return product ? product.price || 0 : 0;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
