// -*- تنظیمات قابل تغییر از پنل ادمین -*-
//
// این مقادیر در جدول settings دیتابیس ذخیره می‌شوند و مقدارهای هم‌نام در
// wrangler.toml را بازنویسی می‌کنند (config.js آن‌ها را روی env سوار می‌کند).
// اگر کلیدی در دیتابیس نباشد، همان مقدار wrangler.toml معتبر است.

export const KEYS = {
  minOrderAmount: 'min_order_amount',
  cashbackEnabled: 'cashback_enabled',
  cashbackPercent: 'cashback_percent',
  cashbackExpireDays: 'cashback_expire_days',
  discountActive: 'discount_active',
};

export const DEFAULT_CASHBACK_EXPIRE_DAYS = 30;

// تعریف فیلدهای پنل ادمین (ترتیب نمایش هم همین است)
export const FIELDS = [
  {
    key: KEYS.minOrderAmount,
    label: 'حداقل مبلغ فاکتور',
    unit: 'تومان',
    type: 'amount',
    min: 0,
    max: 1_000_000_000,
    hint: 'جمع کالاها قبل از تخفیف و هزینه‌ی ارسال؛ ۰ = بدون حداقل',
  },
  { key: KEYS.cashbackEnabled, label: 'کش‌بک', type: 'bool', hint: 'واریز درصدی از خرید به کیف پول' },
  {
    key: KEYS.cashbackPercent,
    label: 'درصد کش‌بک',
    unit: '٪',
    type: 'percent',
    min: 0,
    max: 100,
    hint: '۰ = کش‌بک داده نمی‌شود',
  },
  {
    key: KEYS.cashbackExpireDays,
    label: 'اعتبار کش‌بک',
    unit: 'روز',
    type: 'int',
    min: 1,
    max: 365,
    hint: 'بعد از این مدت، کش‌بک مصرف‌نشده از کیف پول حذف می‌شود',
  },
];

const RUNTIME_KEYS = FIELDS.map((f) => f.key);

// مقادیر خام تنظیمات از دیتابیس (فقط کلیدهای همین پنل)
export async function loadRuntimeSettings(env) {
  const out = {};
  try {
    const { results } = await env.DB.prepare(
      `SELECT key, value FROM settings WHERE key IN (${RUNTIME_KEYS.map(() => '?').join(', ')})`
    )
      .bind(...RUNTIME_KEYS)
      .all();
    for (const row of results || []) out[row.key] = row.value;
  } catch (e) {
    // جدول settings ساخته نشده: همه‌چیز از wrangler.toml خوانده می‌شود
  }
  return out;
}

export async function saveSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = ?`
  )
    .bind(key, String(value), String(value))
    .run();
}

// اعتبارسنجی ورودی ادمین برای یک فیلد؛ خروجی: { ok, value } یا { ok:false, error }
export function parseFieldValue(field, text) {
  const raw = String(text ?? '')
    .trim()
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[,٬\s]/g, '');
  if (!field) return { ok: false, error: 'این تنظیم شناخته نشد.' };

  if (field.type === 'bool') {
    const on = /^(1|on|true|روشن|بله|فعال)$/i.test(raw);
    const off = /^(0|off|false|خاموش|نه|غیرفعال)$/i.test(raw);
    if (on) return { ok: true, value: '1' };
    if (off) return { ok: true, value: '0' };
    return { ok: false, error: 'مقدار باید «روشن» یا «خاموش» باشد.' };
  }

  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'یک عدد صحیح بفرستید.' };
  }
  if (n < field.min || n > field.max) {
    return { ok: false, error: `عدد باید بین ${field.min} و ${field.max} باشد.` };
  }
  return { ok: true, value: String(n) };
}

// مقدار مؤثر هر فیلد برای نمایش در پنل: اولویت با دیتابیس، بعد wrangler.toml
export function defaultValueFromEnv(env, key) {
  if (key === KEYS.minOrderAmount) return String(env?.MIN_ORDER_AMOUNT ?? '0');
  if (key === KEYS.cashbackEnabled) return String(env?.CASHBACK_ENABLED || 'false').toLowerCase() === 'true' ? '1' : '0';
  if (key === KEYS.cashbackPercent) {
    const raw = env?.CASHBACK_PERCENT;
    return raw === undefined || String(raw).trim() === '' ? '5' : String(Number(raw) || 0);
  }
  if (key === KEYS.cashbackExpireDays) return String(DEFAULT_CASHBACK_EXPIRE_DAYS);
  return '';
}

export async function effectiveSettings(env) {
  const dbValues = await loadRuntimeSettings(env);
  const out = {};
  for (const field of FIELDS) {
    out[field.key] = dbValues[field.key] !== undefined ? String(dbValues[field.key]) : defaultValueFromEnv(env, field.key);
  }
  return out;
}
