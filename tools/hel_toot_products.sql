-- محصولات «عرق هل» و «عرق برگ توت» در انتهای منو. فقط یک بار اجرا شود (نام تکراری خطا می‌دهد).
INSERT INTO products (title, description, photo_file_id, price, position) VALUES
('عرق هل', 'عرق هل از تقطیر دانه‌های معطر هل؛ با عطری گرم، تند و ماندگار و طبع گرم.

🌿 در طب سنتی: نشاط‌آور، مقوی معده و قلب، کمک به هضم غذا و رفع نفخ، خوش‌بو کردن دهان
☕ کاربرد: در چای و قهوه، شربت، دسرها و شیرینی‌های سنتی

⚠️ در دوران بارداری، شیردهی یا در صورت بیماری، پیش از مصرف با پزشک مشورت کنید.', 'https://golabeyasamin.emediastorbot.workers.dev/img/hel.png', 350000, (SELECT COALESCE(MAX(position), 0) + 1 FROM products));
INSERT INTO products (title, description, photo_file_id, price, position) VALUES
('عرق برگ توت', 'عرق برگ توت از تقطیر برگ‌های تازه‌ی درخت توت؛ ملایم و با طبع خنک.

🌿 در طب سنتی: کمک به تعادل قند خون، خنک‌کننده و رفع عطش، کمک به تصفیه‌ی خون
🥤 کاربرد: ناشتا یا بین وعده‌ها، به‌تنهایی یا رقیق‌شده با آب

⚠️ در دوران بارداری، شیردهی یا در صورت بیماری، پیش از مصرف با پزشک مشورت کنید.', 'https://golabeyasamin.emediastorbot.workers.dev/img/barg-toot.png', 150000, (SELECT COALESCE(MAX(position), 0) + 1 FROM products));
