// -*- Configuration Helpers -*-

// ادمین‌ها فقط از wrangler.toml خوانده می‌شوند (هیچ آیدی ثابتی داخل کد نیست)
// هر متغیر می‌تواند چند آیدی جدا با ویرگول داشته باشد: "111,222"
function idList(value) {
  return String(value || '').split(/[,،\s]+/).map((id) => id.trim()).filter(Boolean);
}

// ادمین‌هایی که سوپرادمین از داخل ربات (👮 مدیریت ادمین‌ها) اضافه کرده، از جدول admins.
// در شروع هر آپدیت با refreshDbAdmins خوانده می‌شوند تا بررسی‌های دسترسی همگام بمانند.
const dbAdmins = new WeakMap();

export const ADMIN_ROLES = { super: 'super', support: 'support' };

export async function refreshDbAdmins(env) {
  if (!env || typeof env !== 'object') return;
  let rows = [];
  try {
    rows = (await env.DB.prepare('SELECT chat_id, role FROM admins').all()).results || [];
  } catch (e) {
    // جدول هنوز ساخته نشده (migration 005 اجرا نشده): فقط ادمین‌های wrangler.toml
    rows = [];
  }
  dbAdmins.set(env, {
    super: rows.filter((r) => r.role === ADMIN_ROLES.super).map((r) => String(r.chat_id)),
    support: rows.filter((r) => r.role === ADMIN_ROLES.support).map((r) => String(r.chat_id)),
  });
}

// ادمین‌های ثابت wrangler.toml (از داخل ربات حذف‌شدنی نیستند)
export function configSuperAdminIds(env) {
  return idList(env?.ADMIN_CHAT_ID);
}

export function configSupportIds(env) {
  return idList(env?.SUPPORT_CHAT_ID);
}

export function superAdminIds(env) {
  return [...new Set([...configSuperAdminIds(env), ...(dbAdmins.get(env)?.super || [])])];
}

export function supportIds(env) {
  return [...new Set([...configSupportIds(env), ...(dbAdmins.get(env)?.support || [])])];
}

// گیرندگان پیام‌های پشتیبانی/سفارش: همه‌ی ادمین‌های پشتیبانی و سوپرادمین‌ها (بدون تکرار)
export function adminIds(env) {
  return [...new Set([...supportIds(env), ...superAdminIds(env)])];
}

export function isSuperAdmin(env, chatId) {
  const currentId = String(chatId || '').trim();
  return currentId !== '' && superAdminIds(env).includes(currentId);
}

export function isAdmin(env, chatId) {
  const currentId = String(chatId || '').trim();
  return currentId !== '' && adminIds(env).includes(currentId);
}

export function shopName(env) {
  return String(env?.SHOP_NAME || 'فروشگاه').trim();
}

export function customBotEnabled(env) {
  return String(env?.CUSTOM_BOT_ENABLED || 'false').toLowerCase() === 'true';
}

// تعداد دکمه‌ی محصول در هر ردیف منوی اصلی
export function productColumns(env) {
  const n = Number(env?.PRODUCT_COLUMNS || 2);
  return Number.isInteger(n) && n >= 1 && n <= 4 ? n : 2;
}

// لینک چت مستقیم با شماره‌ی پشتیبانی (09xxxxxxxxx → https://t.me/+989xxxxxxxxx)؛ خالی یعنی تنظیم نشده
export function supportPhoneLink(env) {
  let digits = String(env?.SUPPORT_PHONE || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `98${digits.slice(1)}`;
  return digits.length >= 10 ? `https://t.me/+${digits}` : '';
}

// اولین محصول منو در یک ردیف تکی (دکمه‌ی ویژه)
export function productFeaturedFirst(env) {
  return String(env?.PRODUCT_FEATURED_FIRST || 'false').toLowerCase() === 'true';
}

export function cartConfigEnabled(env) {
  return String(env?.CART_ENABLED ?? 'true').toLowerCase() === 'true';
}

export function money(amount) {
  return Number(amount || 0).toLocaleString('fa-IR');
}

export function registrationEnabled(env) {
  return String(env?.REGISTRATION_ENABLED || 'true').toLowerCase() === 'true';
}

export function channelEnabled(env) {
  return String(env?.CHANNEL_ENABLED || 'true').toLowerCase() === 'true';
}

export function referralReward(env) {
  return Number(env?.REFERRAL_REWARD || 10000);
}

export function signupBonus(env) {
  return Number(env?.SIGNUP_BONUS || 20000);
}

// کش‌بک خریدار: درصدی از مبلغ نهایی پرداختی (بعد از کد تخفیف و کسر کیف پول) که پس از تایید
// سفارش به کیف پول خودش برمی‌گردد. خاموش‌کردن: CASHBACK_ENABLED = "false" یا CASHBACK_PERCENT = "0".
// اگر فعال باشد ولی CASHBACK_PERCENT تنظیم نشده باشد، ۵٪ در نظر گرفته می‌شود.
const DEFAULT_CASHBACK_PERCENT = 5;
export function cashbackPercent(env) {
  if (String(env?.CASHBACK_ENABLED || 'false').toLowerCase() !== 'true') return 0;
  const raw = env?.CASHBACK_PERCENT;
  const percent = raw === undefined || String(raw).trim() === '' ? DEFAULT_CASHBACK_PERCENT : Number(raw);
  return Number.isFinite(percent) && percent > 0 && percent <= 100 ? percent : 0;
}

// هزینه‌ی ارسال با پیک (تومان) و حداقل مبلغ خرید برای ارسال رایگان؛ تحویل حضوری همیشه رایگان است
export function courierFee(env) {
  const n = Number(env?.COURIER_FEE ?? 300000);
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

// هزینه‌ی ارسال با پست به شهرهای دیگر؛ آستانه‌ی ارسال رایگان همان FREE_SHIPPING_MIN است
export function postFee(env) {
  const n = Number(env?.POST_FEE ?? 300000);
  return Number.isFinite(n) && n >= 0 ? n : 300000;
}

// حداقل مبلغ کالاها برای ثبت سفارش (تومان، قبل از کد تخفیف و هزینه‌ی ارسال)؛ ۰ = بدون حداقل
export function minOrderAmount(env) {
  const n = Number(env?.MIN_ORDER_AMOUNT ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function freeShippingMin(env) {
  const n = Number(env?.FREE_SHIPPING_MIN ?? 5000000);
  return Number.isFinite(n) && n >= 0 ? n : 5000000;
}

export function referralCommissionPercent(env) {
  return Number(env?.REFERRAL_COMMISSION_PERCENT || 10);
}