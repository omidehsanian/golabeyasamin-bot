-- کد تخفیف ساختنی از داخل ربات، قیمت خط‌خورده و پنهان‌کردن محصول.
-- روی دیتابیس موجود فقط یک بار و قبل از deploy همین نسخه اجرا شود:
--   wrangler d1 execute mazchim_db --remote --file=./migrations/002_discounts_cart_switch.sql

ALTER TABLE products ADD COLUMN old_price INTEGER NOT NULL DEFAULT 0;   -- قیمت خط‌خورده (۰ = ندارد)
ALTER TABLE products ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- پیش‌فرض ۱: پیش‌فاکتورهای باز فعلی با همان مبلغی که مشتری دیده باقی می‌مانند
ALTER TABLE order_items ADD COLUMN discounted INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS discount_codes (
    code       TEXT PRIMARY KEY,               -- همیشه با حروف بزرگ
    percent    INTEGER NOT NULL,
    product_id TEXT,                           -- NULL = همه‌ی محصولات
    expires_at INTEGER,                        -- میلی‌ثانیه‌ی Unix؛ NULL = دائمی
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
