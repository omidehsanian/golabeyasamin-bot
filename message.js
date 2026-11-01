import * as api from './api.js';
import * as db from './db.js';
import * as KB from './keyboards.js';
import { findProductIdByButton, getFullProduct, orderPrice, escapeHtml } from './products.js';
import { isSuperAdmin, isAdmin, money, signupBonus, shopName, customBotEnabled, supportPhoneLink } from './config.js';
import {
  menuKeyboardFor,
  canProceed,
  showProduct,
  notifyAdmin,
  broadcastToAll,
  broadcastStatusText,
  stopBroadcast,
  showPayment,
  continueCheckout,
  deliveryLines,
  saveAddress,
  MAX_ADDRESS_LENGTH,
} from './flows.js';
import { sendOrderDetails, showOrdersPanel } from './admin_orders.js';
import {
  PRODUCT_SESSION_STATES,
  handleProductSessionMessage,
  showProductsAdmin,
  startNewProduct,
} from './admin_products.js';
import { sendUsersExcel } from './admin_users.js';

function getValidDiscountCodes(env) {
  const raw = env.DISCOUNT_CODES || '';
  const codes = {};
  raw.split(',').forEach(item => {
    const [code, percent] = item.split(':');
    if (code && percent) {
      codes[code.trim().toUpperCase()] = Number(percent);
    }
  });
  return codes;
}

export async function handleMessage(env, message) {
  const chatId = String(message.chat.id);
  const text = String(message.text || '').trim();

  if (text === '/id' || text === '/whoami') {
    await api.sendMessage(env, chatId, `🆔 chat_id شما: <code>${chatId}</code>`);
    return;
  }

  if (text === '/help') {
    let helpMsg = `📖 <b>راهنمای دستورات ربات:</b>\n\n` +
      `🔹 <code>/id</code> یا <code>/whoami</code>\n👉 دریافت آیدی عددی (chat_id) خودتان\n\n`;

    if (isAdmin(env, chatId)) {
      helpMsg += `📖 <b>پنل مدیریت:</b>\n` +
        `🔹 دکمه «${KB.NEW_PRODUCT_BUTTON}»\n👉 ساخت محصول: نام ← ویژگی‌ها ← عکس ← قیمت ← جایگاه دکمه\n` +
        `🔹 دکمه «${KB.MANAGE_PRODUCTS_BUTTON}»\n👉 ویرایش نام/ویژگی‌ها/عکس/قیمت، جابجایی و حذف محصولات\n` +
        `🔹 <code>/toggrediscount</code>\n👉 روشن یا خاموش کردن سیستم کد تخفیف\n` +
        `🔹 <code>/unlockdiscount [chat_id]</code>\n👉 برداشتن قفل کد تخفیف کاربر (یا خودتان)\n` +
        `🔹 <code>/order شماره</code>\n👉 جزئیات کامل یک سفارش (مثال: <code>/order 100026</code>)\n\n`;

      if (isSuperAdmin(env, chatId)) {
        helpMsg += `🔹 <code>/orders</code>\n👉 پنل سفارش‌ها، گزارش و خروجی اکسل سفارش‌ها و کاربران\n` +
          `🔹 <code>/users</code>\n👉 لیست کامل کاربران + فایل اکسل\n` +
          `🔹 <code>/unverify chat_id</code>\n👉 لغو تاییدیه عضویت کانال یک کاربر\n` +
          `🔹 <code>/unverifyall</code>\n👉 لغو تاییدیه عضویت کانال همه کاربران\n` +
          `🔹 <code>/deleteuser chat_id</code>\n👉 حذف کامل یک کاربر از دیتابیس\n` +
          `🔹 <code>/broadcaststatus</code>\n👉 وضعیت پیام همگانی در حال ارسال\n` +
          `🔹 <code>/stopbroadcast</code>\n👉 توقف پیام همگانی در حال ارسال\n`;
      }
    }

    await api.sendMessage(env, chatId, helpMsg);
    return;
  }

  // دستور ادمین برای تغییر وضعیت تخفیف
  if (isAdmin(env, chatId) && text === '/toggrediscount') {
    try {
      const current = await db.isDiscountActive(env);
      const newState = current ? '0' : '1';
      await db.setSetting(env, 'discount_active', newState);

      const statusText = newState === '1' ? '🟢 فعال (روشن)' : '🔴 غیرفعال (خاموش)';
      await api.sendMessage(env, chatId, `✅ سیستم کد تخفیف با موفقیت تغییر کرد:\nوضعیت جدید: <b>${statusText}</b>`);
    } catch (e) {
      await api.sendMessage(env, chatId, `❌ خطا در تغییر وضعیت تخفیف: ${e.message || e}`);
    }
    return;
  }

  // دستور ادمین برای آنلاک کردن قفل تخفیف کاربر یا خود ادمین
  if (isAdmin(env, chatId) && text.startsWith('/unlockdiscount')) {
    const parts = text.split(/\s+/);
    const targetChatId = parts[1] || chatId;
    try {
      await db.setUserDiscountLock(env, targetChatId, 0);
      await api.sendMessage(env, chatId, `✅ قفل کد تخفیف برای کاربر <code>${targetChatId}</code> با موفقیت برداشته شد.`);
    } catch (e) {
      await api.sendMessage(env, chatId, `❌ خطا در آنلاک کردن: ${e.message || e}`);
    }
    return;
  }

  if (isSuperAdmin(env, chatId) && text === '/users') {
    try {
      const users = await db.getAllUsersDetails(env);
      if (!users || users.length === 0) {
        await api.sendMessage(env, chatId, '⚠️ هیچ کاربری در دیتابیس یافت نشد.');
        return;
      }

      await api.sendMessage(env, chatId, `👥 تعداد کل کاربران ثبت‌شده در دیتابیس: ${users.length} نفر`);
      await sendUsersExcel(env, chatId);

      const batchSize = 50;
      for (let i = 0; i < users.length; i += batchSize) {
        const chunk = users.slice(i, i + batchSize);
        let msg = `📋 <b>لیست کاربران (بخش ${Math.floor(i / batchSize) + 1}):</b>\n\n`;
        
        chunk.forEach((u, index) => {
          const name = u.full_name || u.first_name || 'کاربر بدون نام';
          const phone = u.phone || 'بدون شماره';
          msg += `${i + index + 1}. 👤 ${name}\n📱 ${phone}\n🆔 <code>${u.chat_id}</code>\n-------------------\n`;
        });

        await api.sendMessage(env, chatId, msg);
      }
    } catch (err) {
      await api.sendMessage(env, chatId, `❌ خطا در دریافت لیست کاربران: ${err.message || err}`);
    }
    return;
  }

  if (isSuperAdmin(env, chatId) && (text === '/orders' || text === KB.ADMIN_ORDERS_BUTTON)) {
    await showOrdersPanel(env, chatId);
    return;
  }

  if (isAdmin(env, chatId) && text === KB.NEW_PRODUCT_BUTTON) {
    await db.clearSession(env, chatId);
    await startNewProduct(env, chatId);
    return;
  }

  if (isAdmin(env, chatId) && text === KB.MANAGE_PRODUCTS_BUTTON) {
    await db.clearSession(env, chatId);
    await showProductsAdmin(env, chatId);
    return;
  }

  if (isAdmin(env, chatId) && /^\/order(\s|$)/.test(text)) {
    await sendOrderDetails(env, chatId, text.split(/\s+/)[1]);
    return;
  }

  if (isSuperAdmin(env, chatId) && text === '/broadcaststatus') {
    await api.sendMessage(env, chatId, await broadcastStatusText(env));
    return;
  }

  if (isSuperAdmin(env, chatId) && text === '/stopbroadcast') {
    const stopped = await stopBroadcast(env);
    await api.sendMessage(
      env,
      chatId,
      stopped === null
        ? '📭 در حال حاضر هیچ پیام همگانی در حال ارسال نیست.'
        : `⛔ پیام همگانی متوقف شد؛ برای ${stopped} نفر باقی‌مانده ارسال نمی‌شود. گزارش نهایی حداکثر تا یک دقیقه‌ی دیگر ارسال می‌شود.`
    );
    return;
  }

  if (isSuperAdmin(env, chatId) && /^\/unverify(\s|$)/.test(text)) {
    const parts = text.split(/\s+/);
    const targetChatId = parts[1];
    if (targetChatId) {
      await db.removeChannelConfirmed(env, targetChatId);
      await api.sendMessage(env, chatId, `✅ تاییدیه عضویت کانال برای کاربر «${targetChatId}» لغو شد.`);
    }
    return;
  }

  if (isSuperAdmin(env, chatId) && text === '/unverifyall') {
    await db.resetAllChannelConfirmations(env);
    await api.sendMessage(env, chatId, '✅ تاییدیه عضویت کانال برای تمامی کاربران لغو شد.');
    return;
  }

  if (isSuperAdmin(env, chatId) && text.startsWith('/deleteuser')) {
    const parts = text.split(/\s+/);
    const targetChatId = parts[1];
    if (targetChatId) {
      await db.deleteUser(env, targetChatId);
      await api.sendMessage(env, chatId, `✅ کاربر با آیدی «${targetChatId}» با موفقیت حذف شد.`);
    }
    return;
  }

  if (text.startsWith('/start') || text === 'شروع مجدد' || text === '/restart') {
    let refId = null;
    const parts = text.split(/\s+/);
    if (parts.length === 2 && parts[0] === '/start' && /^\d+$/.test(parts[1])) {
      refId = parts[1];
    }

    await db.clearSession(env, chatId);
    const existing = await db.getUser(env, chatId);
    await db.ensureUser(env, chatId);
    await db.rememberUsername(env, chatId, message.from?.username);
    // فقط رابطه‌ی دعوت ثبت می‌شود؛ پاداش بعد از اولین خرید تاییدشده‌ی این کاربر پرداخت می‌شود
    if (refId && refId !== chatId && !existing) {
      await db.registerReferral(env, refId, chatId);
    }

    if (!(await canProceed(env, chatId))) {
      return; 
    }

    const registered = await db.isRegistered(env, chatId);
    if (!registered) {
      await api.sendMessage(
        env,
        chatId,
        `🌸 به ${escapeHtml(shopName(env))} خوش آمدید!\n\nبرای فعال‌سازی کیف پول و هدیه ثبت‌نام، لطفا ثبت‌نام کنید:`,
        KB.registerKeyboard()
      );
      return;
    }

    await api.sendMessage(env, chatId, `🌸 به ${escapeHtml(shopName(env))} خوش آمدید!\nاز منوی زیر یکی رو انتخاب کن 👇`, await menuKeyboardFor(env, chatId));
    return;
  }

  if (text === '🔙 شاید بعدا' || text === 'شاید بعدا') {
    await db.setSession(env, chatId, 'skipped_registration', {});
    await api.sendMessage(env, chatId, 'باشه، هر زمان مایل بودی می‌تونی ثبت‌نام کنی 🌸', await menuKeyboardFor(env, chatId));
    return;
  }

  const session = await db.getSession(env, chatId);

  // انصراف از هر فرم چندمرحله‌ای (رسید، کد تخفیف، سفارش ساخت ربات، پیام همگانی)
  if (session.state && (text === '🔙 انصراف' || text === '/cancel')) {
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '❌ لغو شد.', await menuKeyboardFor(env, chatId));
    return;
  }

  // ساخت/ویرایش محصول؛ زدن یکی از دکمه‌های ثابت منو یعنی ادمین از این فرم بیرون رفته
  if (PRODUCT_SESSION_STATES.includes(session.state) && isAdmin(env, chatId)) {
    if (KB.RESERVED_BUTTONS.includes(text)) {
      await db.clearSession(env, chatId);
      session.state = null;
    } else {
      await handleProductSessionMessage(env, chatId, session, message);
      return;
    }
  }

  // آدرس ارسال با پیک؛ زدن یکی از دکمه‌های منو یعنی کاربر از خرید بیرون رفته
  if (session.state === 'awaiting_address') {
    if (KB.RESERVED_BUTTONS.includes(text) || (await findProductIdByButton(env, text))) {
      await db.clearSession(env, chatId);
      session.state = null;
    } else {
      const address = text.replace(/\s+/g, ' ').trim();
      if (address.length < 10 || address.length > MAX_ADDRESS_LENGTH || address.startsWith('/')) {
        await api.sendMessage(env, chatId, `⚠️ لطفاً آدرس کامل را به‌صورت متن بنویسید (بین ۱۰ تا ${MAX_ADDRESS_LENGTH} کاراکتر):`, KB.cancelKeyboard());
        return;
      }
      const { productId, osType } = session.data || {};
      await saveAddress(env, chatId, address);
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, '✅ آدرس ثبت شد.', await menuKeyboardFor(env, chatId));
      await continueCheckout(env, chatId, productId, osType);
      return;
    }
  }

  if (session.state === 'awaiting_discount_code') {
    if (text === '🔙 انصراف' || text === '/cancel') {
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, '❌ لغو شد.', await menuKeyboardFor(env, chatId));
      return;
    }

    // سیستم تخفیف در همین فاصله خاموش شده: بدون تخفیف به پرداخت
    if (!(await db.isDiscountActive(env))) {
      const pending = session.data || {};
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, '⚠️ سیستم کد تخفیف در حال حاضر غیرفعال است.', await menuKeyboardFor(env, chatId));
      await showPayment(env, chatId, pending.productId, pending.osType || '', 0);
      return;
    }

    const user = await db.getUser(env, chatId);
    const now = Date.now();
    if (user && user.discount_locked_until && user.discount_locked_until > now) {
      const remainingMinutes = Math.ceil((user.discount_locked_until - now) / 60000);
      await db.clearSession(env, chatId);
      await api.sendMessage(
        env,
        chatId,
        `❌ به دلیل تلاش‌های مکرر اشتباه، استفاده از کد تخفیف برای شما قفل است. لطفاً ${remainingMinutes} دقیقه دیگر مجدداً تلاش کنید.`,
        await menuKeyboardFor(env, chatId)
      );
      return;
    }

    const data = session.data || {};
    let attempts = data.attempts || 0;

    const validCodes = getValidDiscountCodes(env);
    const code = text.toUpperCase();

    if (validCodes[code]) {
      await db.setUserDiscountLock(env, chatId, 0);
      const percentOff = validCodes[code];
      // درصد تخفیف روی خود سفارش pending ذخیره می‌شود (نه در session)
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, `🎟️ <b>کد تخفیف ${percentOff}% با موفقیت اعمال شد!</b>`, await menuKeyboardFor(env, chatId));
      await showPayment(env, chatId, data.productId, data.osType || '', percentOff);
      return;
    } else {
      attempts++;
      if (attempts >= 3) {
        const lockUntil = Date.now() + 3600000;
        await db.setUserDiscountLock(env, chatId, lockUntil);
        await db.clearSession(env, chatId);
        await api.sendMessage(
          env,
          chatId,
          '❌ شما بیش از حد مجاز تلاش کردید. استفاده از کد تخفیف برای شما به مدت ۱ ساعت قفل شد.',
          await menuKeyboardFor(env, chatId)
        );
        return;
      } else {
        await db.setSession(env, chatId, 'awaiting_discount_code', { ...data, attempts });
        await api.sendMessage(
          env,
          chatId,
          `❌ کد تخفیف اشتباه است. (${attempts} از ۳ تلاش)\nلطفاً دوباره کد صحیح را وارد کنید یا /cancel را بزنید:`
        );
        return;
      }
    }
  }

  if (text === '💼 موجودی کیف پول') {
    if (!(await canProceed(env, chatId))) return;
    if (!(await db.isRegistered(env, chatId))) {
      await api.sendMessage(env, chatId, '⚠️ برای استفاده از کیف پول ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }
    const wallet = await db.getWallet(env, chatId);
    const count = await db.getReferralStats(env, chatId);
    await api.sendMessage(env, chatId, `💼 موجودی کیف پول شما: ${money(wallet)} تومان\n\n👥 دعوت‌شده‌ها: ${count} نفر`, await menuKeyboardFor(env, chatId));
    return;
  }

  if (text === '👥 دعوت از دوستان') {
    if (!(await canProceed(env, chatId))) return;
    if (!(await db.isRegistered(env, chatId))) {
      await api.sendMessage(env, chatId, '⚠️ برای استفاده از سیستم دعوت و دریافت پاداش ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }
    const count = await db.getReferralStats(env, chatId);
    const inviteLink = `https://t.me/${env.BOT_USERNAME}?start=${chatId}`;
    await api.sendMessage(env, chatId, `🔗 لینک دعوت اختصاصی شما:\n<code>${inviteLink}</code>\n\n📊 تعداد دعوت‌شده‌ها: ${count} نفر`, await menuKeyboardFor(env, chatId));
    return;
  }

  if (text === '📞 ارتباط با ادمین') {
    // با شماره‌ی پشتیبانی: دکمه‌ی شیشه‌ای که مستقیم چت را باز می‌کند (خود شماره در متن نمایش داده نمی‌شود)
    const phoneLink = supportPhoneLink(env);
    if (phoneLink) {
      await api.sendMessage(env, chatId, '📞 برای گفتگو با پشتیبانی روی دکمه‌ی زیر بزنید:', {
        inline_keyboard: [[{ text: '💬 پیام به پشتیبانی', url: phoneLink }]],
      });
      return;
    }
    const supportId = env.SUPPORT_CHAT_ID || env.ADMIN_CHAT_ID;
    const supportName = env.SUPPORT_USERNAME ? `@${String(env.SUPPORT_USERNAME).replace('@', '')}` : 'پشتیبانی';
    await api.sendMessage(env, chatId, `📞 آیدی پشتیبانی:\n👉 <a href="tg://user?id=${supportId}">${escapeHtml(supportName)}</a>`, await menuKeyboardFor(env, chatId));
    return;
  }

  if (text === KB.CUSTOM_BOT_BUTTON && customBotEnabled(env)) {
    if (!(await canProceed(env, chatId))) return;
    if (!(await db.isRegistered(env, chatId))) {
      await api.sendMessage(env, chatId, '⚠️ برای ثبت سفارش ساخت ربات ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }
    await db.setSession(env, chatId, 'order_full_name', {});
    await api.sendMessage(env, chatId, '✍️ نام و نام خانوادگی را وارد کنید:');
    return;
  }

  if (text === '📢 ارسال پیام همگانی' && isSuperAdmin(env, chatId)) {
    await db.setSession(env, chatId, 'awaiting_broadcast_text', {});
    await api.sendMessage(
      env,
      chatId,
      '📝 پیام همگانی رو بفرست (متن، عکس، فیلم، فایل یا ویس).\n\n' +
        'ارسال خودکار انجام می‌شه (هر دقیقه ۴۰ نفر) و آخر کار نتیجه رو برات می‌فرستم.',
      KB.cancelKeyboard()
    );
    return;
  }

  if (session.state === 'awaiting_broadcast_text' && isSuperAdmin(env, chatId)) {
    if (text === '🔙 انصراف' || text === '/cancel') {
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, '❌ لغو شد.', await menuKeyboardFor(env, chatId));
      return;
    }
    await db.clearSession(env, chatId);
    await broadcastToAll(env, chatId, message);
    return;
  }

  if (message.contact) {
    // فقط شماره‌ی خود کاربر قابل قبول است (نه contact فوروارد‌شده‌ی شخص دیگر)
    const contactOwner = String(message.contact.user_id ?? '');
    const senderId = String(message.from?.id ?? chatId);
    if (contactOwner !== senderId) {
      await api.sendMessage(env, chatId, '⚠️ لطفاً فقط با دکمه «📱 ثبت نام» شماره‌ی خودتان را ارسال کنید.', KB.registerKeyboard());
      return;
    }

    const alreadyRegistered = await db.isRegistered(env, chatId);
    await db.saveRegistration(env, chatId, message.contact);
    await db.rememberUsername(env, chatId, message.from?.username);

    // هدیه با کلید یکتای signup:<chat_id> ثبت می‌شود، پس ارسال دوباره‌ی contact هدیه‌ی دوم نمی‌دهد
    const bonus = await db.grantSignupBonus(env, chatId, signupBonus(env), message.contact.phone_number);
    if (bonus.applied) {
      await api.sendMessage(env, chatId, `🎉 ثبت‌نام با موفقیت انجام شد!\n🎁 مبلغ ${money(signupBonus(env))} تومان هدیه به کیف پول شما اضافه شد.`);
    } else if (!alreadyRegistered) {
      await api.sendMessage(env, chatId, '🎉 ثبت‌نام با موفقیت انجام شد!');
    } else {
      await api.sendMessage(env, chatId, '✅ اطلاعات شما بروزرسانی شد.');
    }

    await api.sendMessage(env, chatId, 'از منوی زیر یکی رو انتخاب کن 👇', await menuKeyboardFor(env, chatId));
    return;
  }

  if (session.state === 'awaiting_receipt') {
    // فقط عکس یا فایل به‌عنوان رسید پذیرفته می‌شود؛ متن یا دکمه‌ی منو سفارش نمی‌سازد
    if (!message.photo && !message.document) {
      await api.sendMessage(
        env,
        chatId,
        '📸 لطفاً تصویر رسید واریزی را ارسال کنید، یا برای لغو دکمه «🔙 انصراف» را بزنید.',
        KB.cancelKeyboard()
      );
      return;
    }

    const info = session.data || {};
    const boundOrder = info.orderId ? await db.getOrder(env, Number(info.orderId)) : null;
    const productId = boundOrder?.product_id || info.productId || '';
    const osType = boundOrder ? boundOrder.os_type || '' : info.osType || '';
    const discountPercent = boundOrder ? Number(boundOrder.discount_percent) || 0 : info.discountPercent || 0;

    // رسید تکراری برای سفارشی که رسیدش قبلاً ثبت شده: سفارش دوم ساخته نمی‌شود
    if (boundOrder && boundOrder.user_id === chatId && boundOrder.status === 'receipt_sent') {
      await db.clearSession(env, chatId);
      await api.sendMessage(env, chatId, '🧾 رسید این سفارش قبلاً ثبت شده و در حال بررسی است.', await menuKeyboardFor(env, chatId));
      return;
    }

    const product = await getFullProduct(env, productId);
    const title = escapeHtml(product?.title || boundOrder?.product_title || info.title || productId);
    const discountedPrice = orderPrice(env, product, osType, discountPercent).price;
    // موجودی منفی هرگز نباید به «اعتبار منفی» و افزایش مبلغ فاکتور تبدیل شود
    const wallet = Math.max(0, await db.getWallet(env, chatId));
    const walletUsed = Math.min(wallet, discountedPrice);
    const payable = Math.max(0, discountedPrice - walletUsed);

    // اگر سفارش pending است، همان سفارش به receipt_sent می‌رود (انتقال شرطی).
    // اگر در این فاصله لغو شده، رسید گم نمی‌شود: یک سفارش جدید برای بررسی ادمین ساخته می‌شود.
    let rawOrderId = null;
    if (boundOrder && boundOrder.user_id === chatId) {
      const submitted = await db.submitReceiptForOrder(env, boundOrder.id, chatId, { amount: discountedPrice, walletUsed });
      if (submitted.ok) rawOrderId = boundOrder.id;
    }
    if (!rawOrderId) {
      rawOrderId = await db.saveOrder(env, chatId, productId, title, {
        osType,
        amount: discountedPrice,
        walletUsed,
        status: 'receipt_sent',
        note: boundOrder ? `رسید پس از لغو سفارش #1000${boundOrder.id}` : '',
      });
    }
    const orderId = `1000${rawOrderId}`;

    await api.forwardMessage(env, env.SUPPORT_CHAT_ID || env.ADMIN_CHAT_ID, chatId, message.message_id);

    const phone = await db.getPhone(env, chatId);
    const savedOrder = await db.getOrder(env, rawOrderId);
    await notifyAdmin(
      env,
      `🧾 <b>رسید پرداخت جدید - سفارش #${orderId}</b>\n\n` +
      `🛍 محصول: ${title}\n` +
      deliveryLines(savedOrder) +
      `💰 مبلغ خالص نهایی: ${money(discountedPrice)} تومان\n` +
      `💼 کیف پول: ${money(walletUsed)} تومان\n` +
      `💳 قابل پرداخت: ${money(payable)} تومان\n` +
      `📱 تلفن: ${phone ? `<code>${phone}</code>` : 'بدون شماره'}\n` +
      `🆔 chat_id: <code>${chatId}</code>`,
      KB.adminOrderKeyboard(rawOrderId)
    );

    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '✅ رسید شما ارسال شد. پس از بررسی تایید می‌گردد.', await menuKeyboardFor(env, chatId));
    return;
  }

  if (session.state === 'order_full_name') {
    await db.setSession(env, chatId, 'order_phone', { ...session.data, fullName: text });
    await api.sendMessage(env, chatId, '📱 شماره تلفن را وارد کنید:');
    return;
  }
  if (session.state === 'order_phone') {
    await db.setSession(env, chatId, 'order_bot_name', { ...session.data, phone: text });
    await api.sendMessage(env, chatId, '🤖 نام پیشنهادی برای ربات را وارد کنید:');
    return;
  }
  if (session.state === 'order_bot_name') {
    await db.setSession(env, chatId, 'order_activity', { ...session.data, botName: text });
    await api.sendMessage(env, chatId, '💼 حوزه فعالیت ربات چیست؟');
    return;
  }
  if (session.state === 'order_activity') {
    const d = { ...session.data, activity: text };
    const note = `نام: ${d.fullName}\nتلفن: ${d.phone}\nنام ربات: ${d.botName}\nفعالیت: ${d.activity}`;
    const rawOrderId = await db.saveOrder(env, chatId, 'custom_bot', 'سفارش ساخت ربات', { status: 'new', note });
    const orderId = `1000${rawOrderId}`;
    
    await notifyAdmin(env, `🤖 <b>سفارش ساخت ربات - سفارش #${orderId}</b>\n\n${note}`, KB.adminOrderKeyboard(rawOrderId));
    await db.clearSession(env, chatId);
    await api.sendMessage(env, chatId, '✅ سفارش ساخت ربات ثبت شد.', await menuKeyboardFor(env, chatId));
    return;
  }

  const productId = await findProductIdByButton(env, text);
  if (productId) {
    if (!(await canProceed(env, chatId))) return;
    await showProduct(env, chatId, productId);
    return;
  }

  if (await canProceed(env, chatId)) {
    await api.sendMessage(env, chatId, 'یکی از گزینه‌ها را انتخاب کنید 🌸', await menuKeyboardFor(env, chatId));
  }
}