// -*- Configuration Helpers -*-

// ادمین‌ها فقط از wrangler.toml خوانده می‌شوند (هیچ آیدی ثابتی داخل کد نیست)
export function isSuperAdmin(env, chatId) {
  const currentId = String(chatId || '').trim();
  const adminId = String(env?.ADMIN_CHAT_ID || '').trim();
  return currentId !== '' && currentId === adminId;
}

export function isAdmin(env, chatId) {
  const currentId = String(chatId || '').trim();
  const supportId = String(env?.SUPPORT_CHAT_ID || '').trim();
  return isSuperAdmin(env, chatId) || (currentId !== '' && currentId === supportId);
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

export function referralCommissionPercent(env) {
  return Number(env?.REFERRAL_COMMISSION_PERCENT || 10);
}