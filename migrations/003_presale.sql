-- غیرفعال کردن کالا و پیش‌خرید.
-- روی دیتابیس موجود فقط یک بار و قبل از deploy همین نسخه اجرا شود:
--   wrangler d1 execute mazchim_db --remote --file=./migrations/003_presale.sql

ALTER TABLE products ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;       -- ناموجود؛ دکمه در منو می‌ماند
ALTER TABLE products ADD COLUMN presale_price INTEGER NOT NULL DEFAULT 0;  -- با disabled = 1 و مقدار مثبت یعنی پیش‌خرید

-- قیمت پیش‌خرید در لحظه‌ی صدور پیش‌فاکتور (۰ = سفارش عادی)
ALTER TABLE orders ADD COLUMN presale_price INTEGER NOT NULL DEFAULT 0;
