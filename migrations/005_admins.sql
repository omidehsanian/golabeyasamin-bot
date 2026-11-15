-- ادمین‌های اضافه‌شده از داخل ربات (دکمه‌ی «👮 مدیریت ادمین‌ها» سوپرادمین).
-- روی دیتابیس موجود فقط یک بار، قبل از deploy همین نسخه اجرا شود:
--   wrangler d1 execute golabeyasamin_db --remote --file=./migrations/005_admins.sql

CREATE TABLE IF NOT EXISTS admins (
    chat_id    TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('super', 'support')), -- super = ادمین اینترپرایز (همه‌ی امکانات) | support = ادمین پشتیبانی
    added_by   TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
