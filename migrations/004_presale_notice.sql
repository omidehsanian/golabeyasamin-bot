-- ثبت اطلاع‌رسانی «موجود شد» به خریداران پیش‌خرید، تا خریداران دوره‌های قبلی دوباره پیام نگیرند.
-- روی دیتابیس موجود فقط یک بار، بعد از 003 و قبل از deploy همین نسخه اجرا شود:
--   wrangler d1 execute golabeyasamin_db --remote --file=./migrations/004_presale_notice.sql

ALTER TABLE orders ADD COLUMN presale_notified_at DATETIME;
