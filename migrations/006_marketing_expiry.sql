-- ==========================================
-- 006 — انقضای کش‌بک و یادآوری کدهای تخفیف
-- اجرا:
--   wrangler d1 execute golabeyasamin_db --remote --file=./migrations/006_marketing_expiry.sql
-- (این فایل فقط یک‌بار روی دیتابیس موجود اجرا می‌شود؛ اگر ستون‌ها از قبل باشند خطای duplicate می‌دهد)
-- ==========================================

-- مدت کد تخفیف (day | week | NULL = دائمی) و زمان ارسال یادآوری
ALTER TABLE discount_codes ADD COLUMN duration TEXT;
ALTER TABLE discount_codes ADD COLUMN reminder_sent_at INTEGER;

-- کاربرانی که کد را اعمال کرده‌اند
CREATE TABLE IF NOT EXISTS discount_uses (
    code    TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (code, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_discount_uses_code ON discount_uses (code);

-- یادآوری‌های ارسال‌شده به هر کاربر برای هر کد
CREATE TABLE IF NOT EXISTS discount_notices (
    code    TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (code, chat_id)
);

-- اعتبار کش‌بک با تاریخ انقضا
CREATE TABLE IF NOT EXISTS cashback_credits (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    order_id    INTEGER UNIQUE,
    amount      INTEGER NOT NULL,
    remaining   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    reminded_at INTEGER,
    expired_at  DATETIME,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cashback_chat ON cashback_credits (chat_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_cashback_expiring ON cashback_credits (expires_at) WHERE remaining > 0;
