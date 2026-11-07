import * as api from './api.js';
import * as db from './db.js';
import * as KB from './keyboards.js';
import { escapeHtml, getFullProduct, isPresale, isPurchasable, needsAddress, orderPrice, orderTitle, parseVariant, unitPrice, variantCode } from './products.js';
import { CART_PRODUCT_ID, cartQuantity, changeCartQuantity, clearCart, getOrderProduct, isCartActive } from './cart.js';
import { handleDiscountCallback, isDiscountAdminCallback } from './admin_discounts.js';
import { cashbackPercent, money, referralCommissionPercent, referralReward, isAdmin, isSuperAdmin } from './config.js';
import {
  askCartDelivery,
  askDelivery,
  askProfileAddress,
  broadcastStatusText,
  canProceed,
  continueCheckout,
  deliveryLines,
  followUpOrderAddress,
  menuKeyboardFor,
  notifyAdmin,
  prepareOrderDelivery,
  refreshCartMessage,
  resumeCheckout,
  showCart,
  showPayment,
  skipPostal,
  startAddressFill,
} from './flows.js';
import { sendLastOrders, sendOrdersExcel, sendOrdersReport, showCategoryMenu, showOrdersPanel } from './admin_orders.js';
import { sendUsersExcel } from './admin_users.js';
import { handleProductCallback, isProductCallback } from './admin_products.js';
export async function handleCallback(env, callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  // کسی که واقعاً دکمه را زده (برای بررسی دسترسی ادمین)
  const actorId = String(callbackQuery.from?.id ?? '');
  const data = String(callbackQuery.data || '');
  const callbackId = callbackQuery.id;
  const messageId = callbackQuery.message?.message_id;

  // دکمه‌های مدیریتی فقط برای سوپرادمین
  // نام کاربری تلگرام در مراحل خرید (برای جزئیات سفارش در پنل ادمین)
  if (/^(buy|qty|os|addr_ok|rcpt|wpay|walletpay|receipt|cart):/.test(data)) {
    await db.rememberUsername(env, actorId, callbackQuery.from?.username);
  }

  const adminOnly = data === 'bc_next' || data.startsWith('adm_') || data.startsWith('ord_type:') || data.startsWith('ord_fetch:');
  if (adminOnly && !isSuperAdmin(env, actorId)) {
    await api.answerCallbackQuery(env, callbackId, { text: '⛔ دسترسی ندارید.', show_alert: true });
    return;
  }

  // ساخت و مدیریت محصولات (همه‌ی ادمین‌ها)
  if (isProductCallback(data)) {
    if (!isAdmin(env, actorId)) {
      await api.answerCallbackQuery(env, callbackId, { text: '⛔ دسترسی ندارید.', show_alert: true });
      return;
    }
    await handleProductCallback(env, chatId, data, callbackId, messageId, actorId);
    return;
  }

  // ساخت کد تخفیف (همه‌ی ادمین‌ها)
  if (isDiscountAdminCallback(data)) {
    if (!isAdmin(env, actorId)) {
      await api.answerCallbackQuery(env, callbackId, { text: '⛔ دسترسی ندارید.', show_alert: true });
      return;
    }
    await handleDiscountCallback(env, chatId, actorId, data, callbackId, messageId);
    return;
  }

  // دکمه‌ی «ارسال دسته بعدی» پیام‌های قدیمی: ارسال حالا خودکار است، فقط وضعیت نمایش داده می‌شود
  if (data === 'bc_next') {
    await api.answerCallbackQuery(env, callbackId);
    await api.sendMessage(env, chatId, await broadcastStatusText(env));
    return;
  }

  if (data === 'check_membership') {
    const channelUsername = (env.CHANNEL_USERNAME || '').replace('@', '');
    try {
      const member = await api.getChatMember(env, `@${channelUsername}`, chatId);
      const status = member?.result?.status;
      const isMember = ['creator', 'administrator', 'member'].includes(status);

      if (isMember) {
        await db.setChannelConfirmed(env, chatId);
        await api.answerCallbackQuery(env, callbackId, { text: '✅ عضویت شما تایید شد!' });
        
        if (await canProceed(env, chatId)) {
          const registered = await db.isRegistered(env, chatId);
          if (!registered) {
            await api.sendMessage(env, chatId, '🌸 خوش آمدید!\n\nبرای فعال‌سازی کیف پول و هدیه ثبت‌نام، لطفا ثبت‌نام کنید:', KB.registerKeyboard());
          } else {
            await api.sendMessage(env, chatId, 'از منوی زیر یکی رو انتخاب کن 👇', await menuKeyboardFor(env, chatId));
          }
        }
      } else {
        await api.answerCallbackQuery(env, callbackId, { text: '❌ هنوز در کانال عضو نشده‌اید!', show_alert: true });
      }
    } catch (e) {
      await api.answerCallbackQuery(env, callbackId, { text: '❌ خطا در بررسی عضویت.', show_alert: true });
    }
    return;
  }

  // ---------- پنل سفارش‌های ادمین ----------
  // ord_type / ord_fetch: دکمه‌های پیام‌های قدیمی /orders که به پنل جدید هدایت می‌شوند
  if (data === 'adm_orders' || data.startsWith('ord_type:') || data.startsWith('ord_fetch:')) {
    await api.answerCallbackQuery(env, callbackId);
    await showOrdersPanel(env, chatId);
    return;
  }

  if (data === 'adm_xls:orders' || data === 'adm_xls:users') {
    await api.answerCallbackQuery(env, callbackId, { text: '⏳ در حال ساخت فایل اکسل...' });
    try {
      if (data === 'adm_xls:users') await sendUsersExcel(env, chatId);
      else await sendOrdersExcel(env, chatId, 'all');
    } catch (err) {
      await api.sendMessage(env, chatId, `❌ خطا در ساخت فایل اکسل: ${err.message || err}`);
    }
    return;
  }

  if (data.startsWith('adm_ord:')) {
    const [, key, view] = data.split(':');
    await api.answerCallbackQuery(env, callbackId);
    try {
      if (view === 'last') await sendLastOrders(env, chatId, key, 10);
      else if (view === 'report') await sendOrdersReport(env, chatId, key);
      else await showCategoryMenu(env, chatId, key);
    } catch (err) {
      await api.sendMessage(env, chatId, `❌ خطا در دریافت سفارش‌ها: ${err.message || err}`);
    }
    return;
  }

  // افزودن به سبد از صفحه‌ی محصول: دکمه‌های همان پیام به ➖ تعداد ➕ تبدیل می‌شوند
  if (data.startsWith('buy:') || data.startsWith('pq:')) {
    const parts = data.split(':');
    const productId = parts[parts.length - 1];
    const product = await getFullProduct(env, productId);
    // دکمه‌ی پیام قدیمی بعد از خاموش شدن سبد یا پیش‌خرید شدن کالا: خرید مستقیم
    if (isPresale(product) || !(await isCartActive(env))) {
      if (!isPurchasable(product) || unitPrice(product) <= 0) {
        await api.answerCallbackQuery(env, callbackId, { text: '❌ این محصول دیگر موجود نیست.', show_alert: true });
        return;
      }
      await api.answerCallbackQuery(env, callbackId);
      await api.sendMessage(env, chatId, '🔢 تعداد را انتخاب کنید:', KB.directBuyKeyboard(product));
      return;
    }
    const before = await cartQuantity(env, chatId, productId);
    const quantity = await changeCartQuantity(env, chatId, productId, parts[1] === 'dec' ? -1 : 1);
    if (quantity === null) {
      await api.answerCallbackQuery(env, callbackId, { text: '❌ این محصول دیگر موجود نیست.', show_alert: true });
      return;
    }
    const atMax = quantity === before && parts[1] !== 'dec';
    await api.answerCallbackQuery(env, callbackId, { text: atMax ? `حداکثر ${quantity.toLocaleString('fa-IR')} عدد از هر محصول` : '🛒 سبد خرید به‌روز شد' });
    if (messageId && !atMax) {
      await api.editMessageReplyMarkup(env, chatId, messageId, KB.productKeyboard({ id: productId }, quantity));
    }
    return;
  }

  // سبد خرید: cart:view | inc | dec | clear | checkout | ship
  if (data.startsWith('cart:')) {
    if (!(await isCartActive(env))) {
      await api.answerCallbackQuery(env, callbackId, { text: '⛔ سبد خرید در حال حاضر غیرفعال است.', show_alert: true });
      return;
    }
    const [, action, arg] = data.split(':');
    if (action === 'noop') {
      await api.answerCallbackQuery(env, callbackId);
      return;
    }
    if (action === 'inc' || action === 'dec') {
      await changeCartQuantity(env, chatId, arg, action === 'inc' ? 1 : -1);
      await api.answerCallbackQuery(env, callbackId);
      await refreshCartMessage(env, chatId, messageId);
      return;
    }
    if (action === 'clear') {
      await clearCart(env, chatId);
      await api.answerCallbackQuery(env, callbackId, { text: '🗑 سبد خالی شد.' });
      await refreshCartMessage(env, chatId, messageId);
      return;
    }
    await api.answerCallbackQuery(env, callbackId);
    if (action === 'view') {
      await showCart(env, chatId);
      return;
    }
    if (!(await db.isRegistered(env, chatId))) {
      await api.sendMessage(env, chatId, '⚠️ برای ثبت سفارش ابتدا باید ثبت‌نام کنید. سبد شما ذخیره می‌ماند:', KB.registerKeyboard());
      return;
    }
    if (action === 'checkout') {
      await askCartDelivery(env, chatId);
    } else if (action === 'ship' && ['p', 'c', 's'].includes(arg)) {
      await continueCheckout(env, chatId, CART_PRODUCT_ID, arg);
    }
    return;
  }

  // مشخصات آدرس
  if (data.startsWith('addr:')) {
    await api.answerCallbackQuery(env, callbackId);
    if (data === 'addr:edit') await askProfileAddress(env, chatId);
    else if (data === 'addr:fill') await startAddressFill(env, chatId);
    else if (data === 'addr:skip_postal') {
      const profile = await db.getAddressProfile(env, chatId);
      if (profile.address) await skipPostal(env, chatId);
      else await askProfileAddress(env, chatId);
    }
    return;
  }

  // دکمه‌های پیام‌های قدیمی: qty (تعداد) ← os (روش تحویل) ← addr_ok (آدرس ذخیره‌شده)
  if (/^(qty|os|addr_ok):/.test(data)) {
    const [action, productId, arg] = data.split(':');
    await api.answerCallbackQuery(env, callbackId);

    const registered = await db.isRegistered(env, chatId);
    if (!registered) {
      await api.sendMessage(env, chatId, '⚠️ برای ادامه خرید و ثبت سفارش ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }

    if (action === 'qty') {
      await askDelivery(env, chatId, productId, parseVariant(variantCode('pickup', arg)).quantity);
    } else {
      await db.clearSession(env, chatId);
      await continueCheckout(env, chatId, productId, parseVariant(arg).delivery ? arg : variantCode('pickup', 1));
    }
    return;
  }

  if (data.startsWith('discount_yes:')) {
    const [, productId, osType] = data.split(':');
    await api.answerCallbackQuery(env, callbackId);
    // دکمه‌ی قدیمی بعد از خاموش شدن سیستم تخفیف یا پیش‌خرید شدن کالا: مستقیم به پرداخت
    if (!(await db.isDiscountActive(env)) || isPresale(await getFullProduct(env, productId))) {
      await showPayment(env, chatId, productId, osType || '', 0);
      return;
    }
    await db.setSession(env, chatId, 'awaiting_discount_code', { productId, osType, attempts: 0 });
    await api.sendMessage(env, chatId, '✍️ لطفاً کد تخفیف خود را ارسال کنید (یا /cancel را بزنید):', KB.cancelKeyboard());
    return;
  }

  if (data.startsWith('discount_no:')) {
    const [, productId, osType] = data.split(':');
    await api.answerCallbackQuery(env, callbackId);
    await showPayment(env, chatId, productId, osType, 0);
    return;
  }

  // ---------- دکمه‌های متصل به سفارش (rcpt / wpay / resume) ----------
  if (data.startsWith('rcpt:') || data.startsWith('wpay:') || data.startsWith('resume:')) {
    const [action, rawId] = data.split(':');
    const order = await db.getOrder(env, Number(rawId));

    // فقط صاحب سفارش (بر اساس فرستنده‌ی واقعی کلیک) اجازه دارد
    if (!order || order.user_id !== actorId) {
      await api.answerCallbackQuery(env, callbackId, { text: '⛔ این سفارش متعلق به شما نیست.', show_alert: true });
      return;
    }
    if (!(await db.isRegistered(env, actorId))) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ ابتدا ثبت‌نام کنید.', show_alert: true });
      await api.sendMessage(env, chatId, '⚠️ برای ادامه خرید ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }

    if (action === 'resume') {
      const result = await db.resumePendingOrder(env, order.id, actorId);
      if (!result.ok) {
        await api.answerCallbackQuery(env, callbackId, { text: inactiveOrderText(result.order), show_alert: true });
        return;
      }
      await api.answerCallbackQuery(env, callbackId);
      await resumeCheckout(env, chatId, result.order);
      return;
    }

    if (action === 'rcpt') {
      if (!(await db.setCheckoutStep(env, order.id, actorId, 'awaiting_receipt'))) {
        await api.answerCallbackQuery(env, callbackId, { text: inactiveOrderText(await db.getOrder(env, order.id)), show_alert: true });
        return;
      }
      await startReceiptStep(env, chatId, callbackId, order);
      return;
    }

    // wpay
    await payOrderFromWallet(env, chatId, callbackId, order);
    return;
  }

  if (data.startsWith('receipt:')) {
    const parts = data.split(':');
    const productId = parts[1];
    const osType = parts[2] || '';
    const session = await db.getSession(env, chatId);
    const discountPercent = session.data?.discountPercent || 0;

    const registered = await db.isRegistered(env, chatId);
    if (!registered) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ ابتدا ثبت‌نام کنید.', show_alert: true });
      await api.sendMessage(env, chatId, '⚠️ برای ثبت نهایی سفارش ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }

    // دکمه‌ی پیش‌فاکتورهای قدیمی: اگر سفارش pending همین محصول وجود دارد، به همان متصل می‌شود
    const pending = await db.findPendingOrder(env, chatId, productId, osType);
    if (pending && (await db.setCheckoutStep(env, pending.id, chatId, 'awaiting_receipt'))) {
      await startReceiptStep(env, chatId, callbackId, pending);
      return;
    }

    await db.setSession(env, chatId, 'awaiting_receipt', { productId, osType, discountPercent });
    await api.answerCallbackQuery(env, callbackId);
    await api.sendMessage(env, chatId, '📸 لطفاً تصویر رسید واریزی خود را ارسال کنید:', KB.cancelKeyboard());
    return;
  }

  if (data.startsWith('walletpay:')) {
    const parts = data.split(':');
    const productId = parts[1];
    const osType = parts[2] || '';
    const session = await db.getSession(env, chatId);
    const discountPercent = session.data?.discountPercent || 0;

    const registered = await db.isRegistered(env, chatId);
    if (!registered) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ ابتدا ثبت‌نام کنید.', show_alert: true });
      await api.sendMessage(env, chatId, '⚠️ برای پرداخت ابتدا باید ثبت‌نام کنید:', KB.registerKeyboard());
      return;
    }

    const pending = await db.findPendingOrder(env, chatId, productId, osType);
    if (pending) {
      await payOrderFromWallet(env, chatId, callbackId, pending);
      return;
    }

    const product = await getFullProduct(env, productId);
    if (!product) return;
    // این دکمه‌ی قدیمی به سفارشی وصل نیست و پیش‌خرید بدون سفارش ثبت نمی‌شود
    if (!isPurchasable(product) || isPresale(product)) {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این محصول در حال حاضر قابل خرید نیست.', show_alert: true });
      return;
    }

    const finalPrice = orderPrice(env, product, osType, discountPercent).price;

    // بررسی موجودی و کسر آن به‌صورت اتمیک در دیتابیس انجام می‌شود؛
    // شناسه callback باعث می‌شود ارسال دوباره‌ی همین کلیک سفارش دوم نسازد.
    const result = await db.payOrderWithWallet(env, {
      payKey: `walletpay:${callbackId}`,
      chatId,
      productId,
      productTitle: product.title,
      osType,
      price: finalPrice,
    });

    if (result.ok) {
      const orderId = `1000${result.order.id}`;
      await api.answerCallbackQuery(env, callbackId, { text: '🎉 پرداخت انجام شد!' });
      if (result.reason === 'paid') {
        await db.clearSession(env, chatId);
        const paidOrder = await prepareOrderDelivery(env, chatId, result.order);
        await api.sendMessage(env, chatId, `✅ مبلغ ${money(paidOrder.amount)} تومان از کیف پول شما کسر شد.\nسفارش <b>${orderId}</b> ثبت شد.`);
        await notifyAdmin(
          env,
          `💼 <b>خرید با کیف پول (سفارش #${orderId})</b>\nمحصول: ${escapeHtml(product.title)}\n${deliveryLines(paidOrder)}مبلغ: ${money(paidOrder.amount)} تومان`
        );
        await followUpOrderAddress(env, chatId, paidOrder);
      }
    } else if (result.reason === 'invalid_price') {
      await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این محصول هنوز قیمت‌گذاری نشده است.', show_alert: true });
    } else {
      await api.answerCallbackQuery(env, callbackId, { text: '❌ موجودی کیف پول کافی نیست.', show_alert: true });
    }
    return;
  }

  if (data.startsWith('confirm_order:')) {
    // بررسی دسترسی سمت سرور، بر اساس فرستنده‌ی واقعی کلیک
    if (!isAdmin(env, actorId)) {
      await api.answerCallbackQuery(env, callbackId, { text: '⛔ دسترسی ندارید.', show_alert: true });
      return;
    }

    const rawOrderId = data.split(':')[1];
    const orderId = `1000${rawOrderId}`;
    const result = await db.confirmOrder(env, rawOrderId, {
      commissionPercent: referralCommissionPercent(env),
      referralReward: referralReward(env),
      cashbackPercent: cashbackPercent(env),
    });
    const order = result.order;

    // پاداش‌هایی که در همین اجرا ثبت شدند (در اجرای تکراری دوباره اطلاع داده نمی‌شود)
    if (result.referrerId && result.commission.appliedNow) {
      await api.sendMessage(
        env,
        result.referrerId,
        `🎁 <b>پاداش خرید زیرمجموعه!</b>\nکمیسیون (${referralCommissionPercent(env)}% از پرداختی خالص): <b>${money(result.commission.amount)} تومان</b> به کیف پول شما اضافه شد 🌸`
      );
    }
    if (result.referrerId && result.referralReward.appliedNow) {
      await api.sendMessage(
        env,
        result.referrerId,
        `🎉 <b>پاداش دعوت!</b>\nدوستی که دعوت کرده بودید اولین خریدش را انجام داد و <b>${money(result.referralReward.amount)} تومان</b> به کیف پول شما اضافه شد 🌸`
      );
    }

    if (!result.ok) {
      const reasons = {
        not_found: '⚠️ سفارش پیدا نشد.',
        already_confirmed: '⚠️ این سفارش قبلاً تایید شده است.',
        invalid_status: `⚠️ وضعیت این سفارش «${order?.status}» است و قابل تایید نیست.`,
        insufficient_wallet: `❌ موجودی کیف پول کاربر برای کسر ${money(order?.wallet_used)} تومان کافی نیست؛ سفارش تایید نشد.`,
      };
      await api.answerCallbackQuery(env, callbackId, { text: reasons[result.reason] || '⚠️ خطا', show_alert: true });
      return;
    }

    await api.answerCallbackQuery(env, callbackId, { text: '✅ سفارش تایید شد.' });

    if (messageId) {
      try {
        const originalText = callbackQuery.message?.text || callbackQuery.message?.caption || '';
        await api.callTelegram(env, 'editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: originalText + '\n\n<b>[✅ توسط شما تایید شد]</b>',
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] }
        });
      } catch (e) {}
    }

    if (order.product_id !== 'custom_bot') {
      const product = await getFullProduct(env, order.product_id);
      const productDisplayName = escapeHtml(product ? product.title : (order.product_title || 'محصول'));
      
      const nextStep = Number(order.presale_price) > 0
        ? 'و بعد از موجود شدن کالا تحویل یا ارسال می‌شود'
        : parseVariant(order.os_type).delivery === 'pickup'
          ? 'و برای تحویل حضوری آماده می‌شود'
          : 'و به زودی برای شما ارسال می‌شود';
      await api.sendMessage(
        env,
        order.user_id,
        `✅ <b>سفارش شما با شماره <b>${orderId}</b> تایید شد ${nextStep}.</b>\n\nمحصول: ${productDisplayName}`
      );
    }
    if (result.cashback.appliedNow) {
      const balance = await db.getWallet(env, order.user_id);
      await api.sendMessage(
        env,
        order.user_id,
        `💸 <b>کش‌بک خرید!</b>\n<b>${money(result.cashback.amount)} تومان</b> بابت سفارش ${orderId} به کیف پول شما برگشت.\n💼 موجودی فعلی: ${money(balance)} تومان`
      );
    }
    // آخرین پیام، تا دکمه‌ی ثبت آدرس زیر پیام‌های دیگر گم نشود
    if (needsAddress(order.os_type) && order.address_requested_at && !order.address_done_at) {
      await api.sendMessage(env, order.user_id, '📍 برای ارسال این سفارش هنوز آدرس و کد پستی شما را نداریم:', KB.fillAddressKeyboard());
    }
    return;
  }

  if (data.startsWith('reject_order:')) {
    if (!isAdmin(env, actorId)) {
      await api.answerCallbackQuery(env, callbackId, { text: '⛔ دسترسی ندارید.', show_alert: true });
      return;
    }

    const rawOrderId = data.split(':')[1];
    const orderId = `1000${rawOrderId}`;
    const result = await db.rejectOrder(env, rawOrderId);

    if (!result.ok) {
      const text = result.reason === 'invalid_status'
        ? `⚠️ وضعیت این سفارش «${result.order.status}» است و قابل رد نیست.`
        : '⚠️ سفارش نامعتبر یا قبلاً رد شده است.';
      await api.answerCallbackQuery(env, callbackId, { text, show_alert: true });
      return;
    }

    await api.answerCallbackQuery(env, callbackId, { text: '❌ سفارش رد شد.' });
    await api.sendMessage(env, result.order.user_id, `❌ رسید پرداخت شما برای سفارش <b>${orderId}</b> تایید نشد.`);
    return;
  }
}

function inactiveOrderText(order) {
  switch (order?.status) {
    case 'cancelled':
      return '⌛ این سفارش لغو شده است. برای خرید دوباره، محصول را از منو انتخاب کنید.';
    case 'receipt_sent':
      return '🧾 رسید این سفارش ثبت شده و در حال بررسی است.';
    case 'paid_by_wallet':
    case 'confirmed':
      return '✅ این سفارش قبلاً پرداخت یا تایید شده است.';
    case 'pending':
      return '⌛ مهلت تکمیل این سفارش تمام شده است. لطفاً دوباره از منو اقدام کنید.';
    default:
      return '⚠️ این سفارش دیگر فعال نیست.';
  }
}

async function startReceiptStep(env, chatId, callbackId, order) {
  await db.setSession(env, chatId, 'awaiting_receipt', {
    orderId: order.id,
    productId: order.product_id,
    osType: order.os_type || '',
    discountPercent: Number(order.discount_percent) || 0,
  });
  await api.answerCallbackQuery(env, callbackId);
  await api.sendMessage(env, chatId, '📸 لطفاً تصویر رسید واریزی خود را ارسال کنید:', KB.cancelKeyboard());
}

// پرداخت سفارش pending با کیف پول؛ قیمت و موجودی همین لحظه دوباره بررسی می‌شوند
async function payOrderFromWallet(env, chatId, callbackId, order) {
  const product = await getOrderProduct(env, order);
  if (!product || product.hidden || product.closed) {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این محصول در حال حاضر قابل خرید نیست.', show_alert: true });
    return;
  }
  const discountPercent = Number(order.discount_percent) || 0;
  const finalPrice = orderPrice(env, product, order.os_type || '', discountPercent).price;

  const result = await db.payPendingOrderWithWallet(env, order.id, chatId, finalPrice);
  const orderNo = `1000${order.id}`;

  if (result.reason === 'paid') {
    await api.answerCallbackQuery(env, callbackId, { text: '🎉 پرداخت انجام شد!' });
    await db.clearSession(env, chatId);
    const paidOrder = await prepareOrderDelivery(env, chatId, result.order);
    await api.sendMessage(env, chatId, `✅ مبلغ ${money(paidOrder.amount)} تومان از کیف پول شما کسر شد.\nسفارش <b>${orderNo}</b> ثبت شد.`);
    await notifyAdmin(
      env,
      `💼 <b>خرید با کیف پول (سفارش #${orderNo})</b>\nمحصول: ${escapeHtml(orderTitle(product))}\n${deliveryLines(paidOrder)}مبلغ: ${money(paidOrder.amount)} تومان`
    );
    await followUpOrderAddress(env, chatId, paidOrder);
  } else if (result.reason === 'duplicate') {
    await api.answerCallbackQuery(env, callbackId, { text: '✅ این سفارش قبلاً پرداخت شده است.' });
  } else if (result.reason === 'invalid_price') {
    await api.answerCallbackQuery(env, callbackId, { text: '⚠️ این محصول هنوز قیمت‌گذاری نشده است.', show_alert: true });
  } else if (result.reason === 'insufficient_wallet') {
    await api.answerCallbackQuery(env, callbackId, { text: '❌ موجودی کیف پول کافی نیست.', show_alert: true });
  } else {
    await api.answerCallbackQuery(env, callbackId, { text: inactiveOrderText(result.order), show_alert: true });
  }
}

export const handleCallbackQuery = handleCallback;