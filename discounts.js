// -*- بررسی کد تخفیف واردشده توسط کاربر -*-
// دو منبع دارد: DISCOUNT_CODES در wrangler.toml (ثابت، برای همه‌ی محصولات) و کدهای ساخته‌شده در ربات.

import * as db from './db.js';
import { CART_PRODUCT_ID, getCart } from './cart.js';

export function configDiscountCodes(env) {
  const raw = env.DISCOUNT_CODES || '';
  const codes = {};
  raw.split(',').forEach((item) => {
    const [code, percent] = item.split(':');
    if (code && percent) {
      codes[code.trim().toUpperCase()] = Number(percent);
    }
  });
  return codes;
}

export function normalizeCode(text) {
  return String(text ?? '')
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .toUpperCase();
}

// خروجی: { ok: true, percent, scope } یا { ok: false, reason: 'invalid' | 'expired' | 'not_applicable' }
// scope: شناسه‌ی محصولی که کد فقط روی آن اعمال می‌شود (null = همه)
export async function resolveDiscountCode(env, text, productId, chatId, now = Date.now()) {
  const code = normalizeCode(text);
  const row = await db.getDiscountCode(env, code);

  if (!row) {
    const percent = configDiscountCodes(env)[code];
    return percent ? { ok: true, percent, scope: null } : { ok: false, reason: 'invalid' };
  }

  if (row.expires_at !== null && row.expires_at !== undefined && Number(row.expires_at) <= now) {
    return { ok: false, reason: 'expired' };
  }
  if (row.product_id) {
    const applies =
      productId === CART_PRODUCT_ID
        ? (await getCart(env, chatId)).some((i) => i.productId === row.product_id)
        : String(productId) === row.product_id;
    if (!applies) return { ok: false, reason: 'not_applicable' };
  }
  return { ok: true, percent: Number(row.percent), scope: row.product_id || null };
}
