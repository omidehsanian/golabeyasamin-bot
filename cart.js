// -*- سبد خرید و اقلام سفارش -*-
//
// سبد در cart_items است و با صدور پیش‌فاکتور در order_items کپی می‌شود. خود سفارش همان یک ردیف orders
// با product_id = 'cart' و os_type تک‌حرفی (c | p | s) است، پس منطق پرداخت، کیف پول و تایید تغییری نمی‌کند.
// قیمت سفارش از همان کپی خوانده می‌شود: مبلغی که مشتری روی پیش‌فاکتور دیده، با تغییر قیمت عوض نمی‌شود.

import * as db from './db.js';
import { cartConfigEnabled } from './config.js';
import { getFullProduct, isPresale, isPurchasable, MAX_QUANTITY } from './products.js';

export const CART_PRODUCT_ID = 'cart';

const SWITCH_KEY = 'cart_active';

// CART_ENABLED در wrangler.toml کل بخش را باز یا بسته می‌کند و دکمه‌ی «⚙️ سبد خرید» ادمین،
// در صورت باز بودن، آن را برای کاربران روشن یا خاموش می‌کند (پیش‌فرض روشن).
export async function isCartActive(env) {
  if (!cartConfigEnabled(env)) return false;
  return (await db.getSetting(env, SWITCH_KEY, '1')) !== '0';
}

export async function setCartActive(env, on) {
  await db.setSetting(env, SWITCH_KEY, on ? '1' : '0');
}

const validId = (productId) => /^\d+$/.test(String(productId ?? ''));

// محصول حذف‌شده، پنهان، غیرفعال یا بدون قیمت در سبد نمی‌ماند (پیش‌خرید هم فقط خرید مستقیم دارد)
export async function getCart(env, chatId) {
  const { results } = await env.DB.prepare(
    `SELECT c.product_id, c.quantity, p.title, p.price
     FROM cart_items c JOIN products p ON p.id = c.product_id
     WHERE c.chat_id = ? AND p.price > 0 AND p.hidden = 0 AND p.disabled = 0
     ORDER BY p.position, p.id`
  ).bind(String(chatId)).all();
  return (results || []).map((r) => ({
    productId: String(r.product_id),
    title: r.title,
    unitPrice: Number(r.price) || 0,
    quantity: Number(r.quantity) || 0,
  }));
}

export async function cartQuantity(env, chatId, productId) {
  if (!validId(productId)) return 0;
  const row = await env.DB.prepare('SELECT quantity FROM cart_items WHERE chat_id = ? AND product_id = ?')
    .bind(String(chatId), Number(productId))
    .first();
  return Number(row?.quantity) || 0;
}

// تعداد را تغییر می‌دهد و مقدار نهایی را برمی‌گرداند (null: محصول قابل خرید نیست)؛ تعداد صفر یعنی حذف از سبد
export async function changeCartQuantity(env, chatId, productId, delta) {
  const product = await getFullProduct(env, productId);
  if (!product || product.price <= 0 || product.hidden || product.disabled) return null;
  const current = await cartQuantity(env, chatId, productId);
  const quantity = Math.min(Math.max(0, current + delta), MAX_QUANTITY);
  if (quantity === 0) {
    await env.DB.prepare('DELETE FROM cart_items WHERE chat_id = ? AND product_id = ?')
      .bind(String(chatId), Number(productId))
      .run();
    return 0;
  }
  await env.DB.prepare(
    `INSERT INTO cart_items (chat_id, product_id, quantity) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, product_id) DO UPDATE SET quantity = excluded.quantity`
  ).bind(String(chatId), Number(productId), quantity).run();
  return quantity;
}

export async function clearCart(env, chatId) {
  await env.DB.prepare('DELETE FROM cart_items WHERE chat_id = ?').bind(String(chatId)).run();
}

// بعد از پرداخت فقط کالاهای همین سفارش از سبد برداشته می‌شوند
export async function removeOrderItemsFromCart(env, chatId, orderId) {
  await env.DB.prepare(
    'DELETE FROM cart_items WHERE chat_id = ? AND product_id IN (SELECT product_id FROM order_items WHERE order_id = ?)'
  ).bind(String(chatId), Number(orderId)).run();
}

export async function getOrderItems(env, orderId) {
  const { results } = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').bind(Number(orderId)).all();
  return (results || []).map((r) => ({
    productId: String(r.product_id),
    title: r.title,
    unitPrice: Number(r.unit_price) || 0,
    quantity: Number(r.quantity) || 0,
    discounted: Boolean(r.discounted),
  }));
}

export async function replaceOrderItems(env, orderId, items) {
  const insert = env.DB.prepare('INSERT INTO order_items (order_id, product_id, title, unit_price, quantity, discounted) VALUES (?, ?, ?, ?, ?, ?)');
  await env.DB.batch([
    env.DB.prepare('DELETE FROM order_items WHERE order_id = ?').bind(Number(orderId)),
    ...items.map((i) => insert.bind(Number(orderId), Number(i.productId), i.title, i.unitPrice, i.quantity, i.discounted === false ? 0 : 1)),
  ]);
}

export function itemsTotal(items) {
  return items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
}

export function itemsSummary(items) {
  return items.map((i) => `${i.title} ×${i.quantity.toLocaleString('fa-IR')}`).join('، ');
}

// سبد به شکل یک «محصول» با قیمت کل، تا محاسبه‌ی تخفیف و هزینه‌ی ارسال همان مسیر تک‌محصولی باشد
export function cartAsProduct(items) {
  return {
    id: CART_PRODUCT_ID,
    title: itemsSummary(items),
    price: itemsTotal(items),
    // فقط ردیف‌هایی که کد تخفیف شامل آن‌ها می‌شود
    discountableTotal: itemsTotal(items.filter((i) => i.discounted !== false)),
    items,
  };
}

// scope: محصولی که کد تخفیف فقط روی آن اعمال می‌شود (null = همه)
export function applyDiscountScope(items, scope = null) {
  return items.map((i) => ({ ...i, discounted: !scope || scope === i.productId }));
}

// محصول با نوع فروشی که روی پیش‌فاکتور آمده؛ مشتری با تغییر وضعیت کالا مبلغی غیر از فاکتورش پرداخت نمی‌کند.
// closed: وضعیت کالا با فاکتور نمی‌خواند؛ رسید پذیرفته می‌شود ولی کیف پول و «ادامه خرید» بسته است
export async function getOrderProduct(env, order) {
  if (order?.product_id !== CART_PRODUCT_ID) {
    const product = await getFullProduct(env, order?.product_id);
    if (!product) return null;
    const presalePrice = Number(order.presale_price) || 0;
    const closed = !isPurchasable(product) || isPresale(product) !== presalePrice > 0;
    return { ...product, disabled: presalePrice > 0, presalePrice, closed };
  }
  const items = await getOrderItems(env, order.id);
  return items.length ? cartAsProduct(items) : null;
}
