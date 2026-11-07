-- سبد خرید و پروفایل آدرس. روی دیتابیس موجود فقط یک بار و قبل از deploy همین نسخه اجرا شود:
--   wrangler d1 execute golabeyasamin_db --remote --file=./migrations/001_cart_address.sql

ALTER TABLE users ADD COLUMN address TEXT;
ALTER TABLE users ADD COLUMN postal_code TEXT;
ALTER TABLE users ADD COLUMN postal_skipped INTEGER DEFAULT 0;

ALTER TABLE orders ADD COLUMN ship_address TEXT;
ALTER TABLE orders ADD COLUMN ship_postal TEXT;
ALTER TABLE orders ADD COLUMN address_requested_at DATETIME;
ALTER TABLE orders ADD COLUMN address_done_at DATETIME;
ALTER TABLE orders ADD COLUMN address_reminders INTEGER DEFAULT 0;
ALTER TABLE orders ADD COLUMN address_admin_alerted_at DATETIME;

CREATE INDEX IF NOT EXISTS idx_orders_awaiting_address
    ON orders (address_requested_at) WHERE address_requested_at IS NOT NULL AND address_done_at IS NULL;

CREATE TABLE IF NOT EXISTS cart_items (
    chat_id    TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, product_id)
);

CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    title      TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

-- آدرس‌های ذخیره‌شده‌ی قبلی به پروفایل منتقل می‌شوند (کد پستی جدا نداشتند، پس پروفایلشان ناقص می‌ماند)
UPDATE users SET address = (SELECT value FROM settings WHERE key = 'address:' || users.chat_id)
WHERE EXISTS (SELECT 1 FROM settings WHERE key = 'address:' || users.chat_id);
DELETE FROM settings WHERE key LIKE 'address:%';
