-- ==========================================
-- اسکیمای دیتابیس D1 (فقط برای نصب جدید / دیتابیس خالی)
-- اجرا: wrangler d1 execute store_bot_db --file=./schema.sql --remote
--
-- ⚠️ برای دیتابیسی که از قبل داده دارد این فایل را اجرا نکنید؛
--    به‌جایش فایل‌های پوشه‌ی migrations/ را به ترتیب اجرا کنید.
-- ==========================================

CREATE TABLE IF NOT EXISTS users (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id               TEXT UNIQUE NOT NULL,
    first_name            TEXT,
    last_name             TEXT,
    full_name             TEXT,
    phone                 TEXT,
    wallet                INTEGER DEFAULT 0,
    channel_confirmed     INTEGER DEFAULT 0,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
    discount_locked_until INTEGER DEFAULT 0,
    username              TEXT,         -- نام کاربری تلگرام (برای گزارش سفارش‌ها)
    -- پروفایل آدرس برای ارسال با پیک/پست
    address               TEXT,
    postal_code           TEXT,
    postal_skipped        INTEGER DEFAULT 0 -- کاربر گفته کد پستی را نمی‌داند
);

CREATE TABLE IF NOT EXISTS referrals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id  TEXT NOT NULL,
    invited_id   TEXT UNIQUE NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         TEXT NOT NULL,
    product_id      TEXT,
    product_title   TEXT,
    os_type         TEXT,
    amount          INTEGER DEFAULT 0,
    wallet_used     INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',
    note            TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
    idempotency_key TEXT,
    confirmed_at    DATETIME,
    -- چرخه‌ی سفارش معلق (status = 'pending': پیش‌فاکتور صادر شده، رسید/پرداخت نشده)
    discount_percent       INTEGER DEFAULT 0,
    checkout_step          TEXT,        -- invoice | awaiting_receipt
    resumed_at             DATETIME,
    reminder_sent_at       DATETIME,
    reminder_attempts      INTEGER DEFAULT 0,
    cancelled_at           DATETIME,
    cancel_reason          TEXT,        -- timeout | superseded
    cancel_notice_sent_at  DATETIME,
    cancel_notice_attempts INTEGER DEFAULT 0,
    notify_error           TEXT,
    -- آدرس سفارش پیک/پست (بعد از پرداخت از پروفایل کپی می‌شود)
    ship_address             TEXT,
    ship_postal              TEXT,
    address_requested_at     DATETIME,
    address_done_at          DATETIME,  -- خالی با address_requested_at پر یعنی «منتظر آدرس»
    address_reminders        INTEGER DEFAULT 0,
    address_admin_alerted_at DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
    ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- هر کاربر حداکثر یک پیش‌فاکتور باز
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_pending_per_user
    ON orders (user_id) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders (status, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_awaiting_address
    ON orders (address_requested_at) WHERE address_requested_at IS NOT NULL AND address_done_at IS NULL;

-- سبد خرید هر کاربر
CREATE TABLE IF NOT EXISTS cart_items (
    chat_id    TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    PRIMARY KEY (chat_id, product_id)
);

-- اقلام سفارش‌های سبد (product_id = 'cart')؛ کپی نام و قیمت در لحظه‌ی صدور پیش‌فاکتور
CREATE TABLE IF NOT EXISTS order_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id   INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    title      TEXT NOT NULL,
    unit_price INTEGER NOT NULL,
    quantity   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

-- محصولات فروشگاه (ادمین از داخل ربات می‌سازد: ➕ ساخت محصول)
-- position: جایگاه دکمه در منوی اصلی، پشت‌سرهم از ۱
CREATE TABLE IF NOT EXISTS products (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT NOT NULL UNIQUE,     -- متن دکمه و عنوان محصول
    description   TEXT NOT NULL DEFAULT '', -- ویژگی‌ها
    photo_file_id TEXT NOT NULL DEFAULT '',
    price         INTEGER NOT NULL DEFAULT 0,
    position      INTEGER NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- سشن کاربر برای فرم‌های چند مرحله‌ای
CREATE TABLE IF NOT EXISTS sessions (
    chat_id TEXT PRIMARY KEY,
    state   TEXT,
    data    TEXT DEFAULT '{}'
);

-- صف پیام همگانی (پشتیبانی از ارسال متن و عکس همراه با وضعیت پردازش)
CREATE TABLE IF NOT EXISTS broadcast_queue (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT,
    text       TEXT,
    status     TEXT DEFAULT 'pending',
    photo_id   TEXT
);

-- تنظیمات عمومی (مثل discount_active)
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- دفتر گردش مالی کیف پول. هر تغییر موجودی دقیقا یک ردیف با کلید یکتا دارد:
--   order:<id>:debit           کسر کیف پول بابت سفارش
--   order:<id>:commission      کمیسیون معرف بابت سفارش
--   referral:<invited>:reward  پاداش یک‌باره‌ی دعوت
--   signup:<chat_id>           هدیه ثبت‌نام
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT UNIQUE NOT NULL,
    chat_id         TEXT NOT NULL,
    order_id        INTEGER,
    type            TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    balance_after   INTEGER,
    applied         INTEGER NOT NULL DEFAULT 0,
    note            TEXT,
    created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_chat  ON wallet_transactions (chat_id);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_order ON wallet_transactions (order_id);

-- لایه‌ی محافظ نهایی: موجودی منفی در هیچ مسیری ذخیره نمی‌شود
CREATE TRIGGER IF NOT EXISTS trg_users_wallet_non_negative_update
BEFORE UPDATE OF wallet ON users
WHEN NEW.wallet < 0
BEGIN
    SELECT RAISE(ABORT, 'wallet cannot be negative');
END;

CREATE TRIGGER IF NOT EXISTS trg_users_wallet_non_negative_insert
BEFORE INSERT ON users
WHEN NEW.wallet < 0
BEGIN
    SELECT RAISE(ABORT, 'wallet cannot be negative');
END;
