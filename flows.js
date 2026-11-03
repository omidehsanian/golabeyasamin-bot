import * as api from './api.js';
import * as db from './db.js';
import * as KB from './keyboards.js';
import {
  buildProductCaption,
  getFullProduct,
  listProducts,
  needsAddress,
  orderPrice,
  parseVariant,
  shippingInfoText,
  variantLabel,
} from './products.js';
import { CART_PRODUCT_ID, applyDiscountScope, cartAsProduct, cartQuantity, getCart, getOrderProduct, isCartActive, itemsTotal, removeOrderItemsFromCart, replaceOrderItems } from './cart.js';
import { cartConfigEnabled, cashbackPercent, channelEnabled, customBotEnabled, freeShippingMin, money, isAdmin, isSuperAdmin, productColumns, productFeaturedFirst } from './config.js';

const BROADCAST_SOURCE_KEY = 'broadcast_source';

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ----------------------------------------------------
// بررسی گام‌به‌گام دسترسی کاربر (فقط عضویت کانال در ابتدا)
// ----------------------------------------------------
export async function canProceed(env, chatId) {
  if (!channelEnabled(env)) return true;
  const channelConfirmed = await db.isChannelConfirmed(env, chatId);
  if (!channelConfirmed) {
    const channelUsername = (env.CHANNEL_USERNAME || '').replace('@', '');
    const joinLink = `https://t.me/${channelUsername}`;
    await api.sendMessage(
      env,
      chatId,
      `🌸 برای استفاده از امکانات ربات، ابتدا باید در کانال ما عضو شوید:\n\n👉 @${channelUsername}`,
      KB.channelRequireKeyboard(joinLink)
    );
    return false;
  }

  // بررسی ثبت‌نام اجباری اولیه برداشته شد تا دکمه «شاید بعدا» کار کند.
  // ثبت‌نام فقط در بخش‌های حساس مثل کیف پول، دعوت از دوستان، پرداخت و دانلود اندروید چک می‌شود.

  return true;
}

// ----------------------------------------------------
// منوی اصلی: دکمه‌ی محصولات به ترتیب جایگاه + دکمه‌های ادمین
// ----------------------------------------------------
export async function menuKeyboardFor(env, chatId) {
  const products = await listProducts(env);
  const admin = isAdmin(env, chatId);
  const cart = await isCartActive(env);
  return KB.mainMenuKeyboard(products.filter((p) => !p.hidden), {
    superAdmin: isSuperAdmin(env, chatId),
    admin,
    columns: productColumns(env),
    featuredFirst: productFeaturedFirst(env),
    customBot: customBotEnabled(env),
    cart,
    cartToggle: admin && cartConfigEnabled(env) ? cart : null,
    hasProducts: products.length > 0,
  });
}

// ----------------------------------------------------
// ورود به منوی اصلی پس از ثبت‌نام
// ----------------------------------------------------
export async function resumeAfterRegistration(env, chatId) {
  await db.clearSession(env, chatId);
  await api.sendMessage(
    env,
    chatId,
    'از منوی زیر یکی رو انتخاب کن 👇',
    await menuKeyboardFor(env, chatId)
  );
}

// ----------------------------------------------------
// نمایش جزئیات محصول
// ----------------------------------------------------
export async function showProduct(env, chatId, productId) {
  const product = await getFullProduct(env, productId);
  if (!product || product.hidden) {
    await api.sendMessage(env, chatId, '❌ محصول پیدا نشد.', await menuKeyboardFor(env, chatId));
    return;
  }

  let text = buildProductCaption(product);
  if (product.price > 0) text += `\n\n${shippingInfoText(env)}`;
  let keyboard = null;
  if (product.price > 0) {
    keyboard = (await isCartActive(env))
      ? KB.productKeyboard(product, await cartQuantity(env, chatId, productId))
      : KB.directBuyKeyboard(product);
  }
  if (product.photoFileId) {
    await api.sendPhoto(env, chatId, product.photoFileId, text, keyboard);
  } else {
    await api.sendMessage(env, chatId, text, keyboard);
  }
}

// ----------------------------------------------------
// نمایش صفحه پرداخت (اصلاح قیمت و رفع مشکل پرانتزها در تلگرام)
// ----------------------------------------------------
// ----------------------------------------------------
// مراحل خرید: سبد ← روش تحویل ← کد تخفیف ← پیش‌فاکتور ← پرداخت ← (آدرس برای پیک و پست، اگر پروفایل کامل نباشد)
// ----------------------------------------------------
export const MAX_ADDRESS_LENGTH = 400;
export const ADDRESS_SESSION_STATES = ['profile_address', 'profile_postal'];

function cartText(items) {
  let text = '🛒 <b>سبد خرید شما:</b>\n\n';
  for (const i of items) {
    text += `▫️ ${escapeHtml(i.title)} × ${i.quantity.toLocaleString('fa-IR')} — ${money(i.unitPrice * i.quantity)} تومان\n`;
  }
  return `${text}\n💰 جمع کالاها: <b>${money(itemsTotal(items))} تومان</b>`;
}

const EMPTY_CART_TEXT = '🛒 سبد خرید شما خالی است.\n\nاز منو یک محصول انتخاب کنید و «افزودن به سبد خرید» را بزنید.';

export async function showCart(env, chatId) {
  const items = await getCart(env, chatId);
  await api.sendMessage(env, chatId, items.length ? cartText(items) : EMPTY_CART_TEXT, items.length ? KB.cartKeyboard(items) : null);
}

// تغییر تعداد از داخل صفحه‌ی سبد، روی همان پیام
export async function refreshCartMessage(env, chatId, messageId) {
  const items = await getCart(env, chatId);
  await api.callTelegram(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: items.length ? cartText(items) : EMPTY_CART_TEXT,
    parse_mode: 'HTML',
    reply_markup: items.length ? KB.cartKeyboard(items) : { inline_keyboard: [] },
  });
}

export async function askCartDelivery(env, chatId) {
  const items = await getCart(env, chatId);
  if (!items.length) {
    await api.sendMessage(env, chatId, EMPTY_CART_TEXT);
    return;
  }
  await api.sendMessage(
    env,
    chatId,
    `🚚 روش تحویل را انتخاب کنید:\n\n${shippingInfoText(env)}\n\n📍 اگر ارسال می‌خواهید، آدرس را بعد از پرداخت می‌گیریم.`,
    KB.cartDeliveryKeyboard()
  );
}

export async function askDelivery(env, chatId, productId, quantity) {
  await api.sendMessage(env, chatId, `🚚 روش تحویل را انتخاب کنید:\n\n${shippingInfoText(env)}`, KB.deliveryKeyboard(productId, quantity));
}

// ----------------------------------------------------
// پروفایل آدرس: آدرس ← کد پستی (۱۰ رقم)
// ----------------------------------------------------
export function normalizePostal(text) {
  return String(text || '')
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[\s-]/g, '');
}

function profileText(profile) {
  const postal = profile.postal ? `<code>${escapeHtml(profile.postal)}</code>` : profile.postalSkipped ? 'نامشخص' : 'ثبت نشده';
  return `📍 آدرس: ${escapeHtml(profile.address || 'ثبت نشده')}\n📮 کد پستی: ${postal}`;
}

export async function showAddressProfile(env, chatId) {
  const profile = await db.getAddressProfile(env, chatId);
  if (!profile.address) {
    await api.sendMessage(env, chatId, '📍 هنوز آدرسی ثبت نکرده‌اید. با ثبت آدرس، در خریدهای بعدی دیگر چیزی از شما پرسیده نمی‌شود.', KB.addressActionKeyboard('➕ ثبت آدرس'));
    return;
  }
  await api.sendMessage(
    env,
    chatId,
    `<b>مشخصات آدرس شما</b>\n\n${profileText(profile)}\n\nتغییر آدرس روی سفارش‌های تاییدشده اثر ندارد؛ برای آن‌ها به پشتیبانی پیام بدهید.`,
    KB.addressActionKeyboard()
  );
}

export async function askProfileAddress(env, chatId, intro = '') {
  await db.setSession(env, chatId, 'profile_address', {});
  await api.sendMessage(
    env,
    chatId,
    `${intro}✍️ آدرس کامل را با ذکر شهر بنویسید (شهر، خیابان، کوچه، پلاک، واحد):`,
    KB.cancelKeyboard()
  );
}

async function askProfilePostal(env, chatId) {
  await db.setSession(env, chatId, 'profile_postal', {});
  await api.sendMessage(env, chatId, '📮 کد پستی ۱۰ رقمی را بنویسید:', KB.skipPostalKeyboard());
}

// از هر جا که کار نیمه‌تمام مانده ادامه می‌دهد: آدرس دارد ولی کد پستی نه ← فقط کد پستی
export async function startAddressFill(env, chatId, intro = '') {
  const profile = await db.getAddressProfile(env, chatId);
  if (profile.complete) {
    await showAddressProfile(env, chatId);
    return;
  }
  if (!profile.address) {
    await askProfileAddress(env, chatId, intro);
    return;
  }
  await api.sendMessage(env, chatId, `${intro}📍 آدرس ثبت‌شده: ${escapeHtml(profile.address)}`, KB.addressActionKeyboard('✏️ تغییر آدرس'));
  await api.sendMessage(env, chatId, 'برای انصراف دکمه زیر را بزنید.', KB.cancelKeyboard());
  await askProfilePostal(env, chatId);
}

export async function handleAddressInput(env, chatId, state, text) {
  if (state === 'profile_address') {
    const address = text.replace(/\s+/g, ' ').trim();
    if (address.length < 10 || address.length > MAX_ADDRESS_LENGTH || address.startsWith('/')) {
      await api.sendMessage(env, chatId, `⚠️ لطفاً آدرس کامل را به‌صورت متن بنویسید (بین ۱۰ تا ${MAX_ADDRESS_LENGTH} کاراکتر):`, KB.cancelKeyboard());
      return;
    }
    await db.saveProfileAddress(env, chatId, address);
    // آدرس جدید ممکن است کد پستی قبلی را بی‌اعتبار کند
    await db.saveProfilePostal(env, chatId, '', false);
    await db.applyProfileToOrders(env, chatId, await db.getAddressProfile(env, chatId));
    await askProfilePostal(env, chatId);
    return;
  }

  const postal = normalizePostal(text);
  if (!/^\d{10}$/.test(postal)) {
    await api.sendMessage(env, chatId, '⚠️ کد پستی باید ۱۰ رقم باشد. دوباره بنویسید:', KB.skipPostalKeyboard());
    return;
  }
  await db.saveProfilePostal(env, chatId, postal, false);
  await finishAddressProfile(env, chatId);
}

export async function skipPostal(env, chatId) {
  await db.saveProfilePostal(env, chatId, '', true);
  await finishAddressProfile(env, chatId);
}

async function finishAddressProfile(env, chatId) {
  await db.clearSession(env, chatId);
  const profile = await db.getAddressProfile(env, chatId);
  const changed = await db.applyProfileToOrders(env, chatId, profile);
  const numbers = changed.map((o) => `1000${o.id}`).join('، ');
  const suffix = changed.length ? `\nسفارش ${numbers} به همین آدرس ارسال می‌شود.` : '';
  await api.sendMessage(env, chatId, `✅ مشخصات آدرس ذخیره شد.\n\n${profileText(profile)}${suffix}`, await menuKeyboardFor(env, chatId));
  for (const order of changed) {
    await notifyAdmin(env, `📍 <b>آدرس سفارش #1000${order.id} ثبت شد</b>\n🛍 ${escapeHtml(order.product_title || order.product_id)}\n${deliveryLines(order)}`);
  }
}

// ----------------------------------------------------
// بعد از پرداخت: کالاها از سبد برداشته می‌شوند و آدرس از پروفایل روی سفارش می‌آید
// ----------------------------------------------------
export async function prepareOrderDelivery(env, chatId, order) {
  if (order.product_id === CART_PRODUCT_ID) await removeOrderItemsFromCart(env, chatId, order.id);
  if (!needsAddress(order.os_type)) return order;
  return db.attachAddressToOrder(env, order.id, await db.getAddressProfile(env, chatId));
}

// پیام بعد از پرداخت به مشتری: آدرس کامل ← فقط یادآوری آدرس | ناقص ← همین‌جا پرسیده می‌شود
export async function followUpOrderAddress(env, chatId, order) {
  if (!needsAddress(order.os_type)) return;
  if (order.address_done_at) {
    const profile = await db.getAddressProfile(env, chatId);
    await api.sendMessage(env, chatId, `📦 سفارش به این آدرس ارسال می‌شود:\n${profileText(profile)}`, KB.addressActionKeyboard('✏️ تغییر آدرس'));
    return;
  }
  await startAddressFill(env, chatId, '📍 <b>آخرین قدم:</b> برای ارسال سفارش به آدرس شما نیاز داریم.\n\n');
}

export async function continueCheckout(env, chatId, productId, osType) {
  if (await db.isDiscountActive(env)) {
    await api.sendMessage(env, chatId, '🎟️ آیا کد تخفیف دارید؟', KB.discountPromptKeyboard(productId, osType));
  } else {
    await showPayment(env, chatId, productId, osType, 0);
  }
}

// محاسبه‌ی مبلغ از روی قیمت فعلی محصول، تعداد، تخفیف، هزینه‌ی ارسال و موجودی فعلی (موجودی منفی = صفر)
export async function priceBreakdown(env, chatId, product, osType = '', discountPercent = 0) {
  const p = orderPrice(env, product, osType, discountPercent);
  const wallet = Math.max(0, await db.getWallet(env, chatId));
  const walletUsed = p.price > 0 ? Math.min(wallet, p.price) : 0;
  return { ...p, wallet, walletUsed, payable: p.price - walletUsed };
}

// متن تحویل برای پیام‌های ادمین: روش تحویل، آدرس و کد پستی، یا هشدار «منتظر آدرس»
export function deliveryLines(order) {
  const label = variantLabel(order?.os_type);
  if (!label) return '';
  let text = `📦 ${label}\n`;
  if (!needsAddress(order.os_type)) return text;
  if (!order.address_requested_at) {
    // سفارش‌های قبل از پروفایل آدرس: آدرس در یادداشت است
    if (String(order.note || '').startsWith('📍')) text += `${escapeHtml(order.note)}\n`;
    return text;
  }
  if (order.ship_address) text += `📍 آدرس: ${escapeHtml(order.ship_address)}\n`;
  if (order.ship_postal) text += `📮 کد پستی: <code>${escapeHtml(order.ship_postal)}</code>\n`;
  if (!order.address_done_at) text += order.ship_address ? '⚠️ <b>منتظر کد پستی</b>\n' : '⚠️ <b>منتظر آدرس مشتری</b>\n';
  else if (!order.ship_postal) text += '📮 کد پستی: مشتری نمی‌داند\n';
  return text;
}

// صدور پیش‌فاکتور: یک سفارش pending ساخته یا تازه می‌شود و دکمه‌ها به همان سفارش متصل‌اند
// discountScope: محصولی که کد تخفیف فقط روی آن اعمال می‌شود (برای سبد خرید؛ null = همه)
export async function showPayment(env, chatId, productId, osType = '', discountPercent = 0, discountScope = null) {
  const isCart = productId === CART_PRODUCT_ID;
  if (isCart && !(await isCartActive(env))) {
    await api.sendMessage(env, chatId, '⛔ سبد خرید در حال حاضر غیرفعال است.', await menuKeyboardFor(env, chatId));
    return;
  }
  const cartItems = isCart ? applyDiscountScope(await getCart(env, chatId), discountScope) : [];
  const product = isCart ? (cartItems.length ? cartAsProduct(cartItems) : null) : await getFullProduct(env, productId);
  if (!product || product.hidden) {
    const text = isCart ? EMPTY_CART_TEXT : '❌ این محصول دیگر موجود نیست.';
    await api.sendMessage(env, chatId, text, await menuKeyboardFor(env, chatId));
    return;
  }

  const b = await priceBreakdown(env, chatId, product, osType, discountPercent);
  if (b.basePrice <= 0) {
    await api.sendMessage(env, chatId, '⚠️ این محصول هنوز قیمت‌گذاری نشده است.');
    return;
  }

  const order = await db.upsertPendingOrder(env, {
    chatId,
    productId,
    productTitle: product.title,
    osType,
    discountPercent,
    amount: b.price,
    walletUsed: b.walletUsed,
  });
  if (order && isCart) await replaceOrderItems(env, order.id, cartItems);

  const keyboard = order
    ? KB.orderPaymentKeyboard(order.id, b.price > 0 && b.wallet >= b.price)
    : KB.paymentKeyboard(productId, osType, b.price > 0 && b.wallet >= b.price);
  await api.sendMessage(env, chatId, invoiceText(env, product, osType, discountPercent, b), keyboard);
}

// «ادامه خرید»: قیمت، موجودی و وضعیت دوباره بررسی و همان مرحله‌ی قبلی بازیابی می‌شود
export async function resumeCheckout(env, chatId, order) {
  const product = await getOrderProduct(env, order);
  const discountPercent = Number(order.discount_percent) || 0;
  const b = product ? await priceBreakdown(env, chatId, product, order.os_type || '', discountPercent) : null;
  if (!product || product.hidden || b.basePrice <= 0) {
    await api.sendMessage(env, chatId, '⚠️ این محصول در حال حاضر قابل خرید نیست. لطفاً از منو محصول دیگری انتخاب کنید.', await menuKeyboardFor(env, chatId));
    return;
  }

  await db.refreshPendingAmounts(env, order.id, b.price, b.walletUsed);
  const text = invoiceText(env, product, order.os_type || '', discountPercent, b);

  if (order.checkout_step === 'awaiting_receipt') {
    await db.setSession(env, chatId, 'awaiting_receipt', {
      orderId: order.id,
      productId: order.product_id,
      osType: order.os_type || '',
      discountPercent,
    });
    await api.sendMessage(env, chatId, `${text}\n\n📸 لطفاً تصویر رسید واریزی خود را ارسال کنید:`, KB.cancelKeyboard());
    return;
  }

  await api.sendMessage(env, chatId, text, KB.orderPaymentKeyboard(order.id, b.price > 0 && b.wallet >= b.price));
}

function invoiceText(env, product, osType, discountPercent, b) {
  const { basePrice, discountAmount, shipping, price, wallet, walletUsed, payable } = b;
  const { delivery, quantity } = parseVariant(osType);

  let text = '💳 <b>پیش‌فاکتور خرید:</b>\n\n';
  if (product.items) {
    for (const i of product.items) {
      text += `▫️ ${escapeHtml(i.title)}: ${i.quantity.toLocaleString('fa-IR')} × ${money(i.unitPrice)} تومان\n`;
    }
    text += `💰 مبلغ کالا: ${money(basePrice)} تومان\n`;
  } else if (delivery) {
    text += `🛍 محصول: ${escapeHtml(product.title)}\n`;
    text += `🔢 تعداد: ${quantity.toLocaleString('fa-IR')} × ${money(product.price)} تومان\n`;
    text += `💰 مبلغ کالا: ${money(basePrice)} تومان\n`;
  } else {
    text += `🛍 محصول: ${escapeHtml(product.title)}\n💰 قیمت: ${money(basePrice)} تومان\n`;
  }

  if (discountPercent > 0) {
    text += `📉 تخفیف (${discountPercent}%): ${money(discountAmount)} تومان\n`;
  }

  if (delivery === 'pickup') {
    text += '🏬 تحویل حضوری: رایگان\n';
  } else if (delivery === 'courier') {
    text += shipping > 0
      ? `🛵 هزینه ارسال با پیک: ${money(shipping)} تومان\n`
      : `🛵 ارسال با پیک: <b>رایگان</b> (خرید بالای ${money(freeShippingMin(env))} تومان)\n`;
  } else if (delivery === 'post') {
    text += shipping > 0
      ? `📦 هزینه ارسال با پست: ${money(shipping)} تومان\n`
      : `📦 ارسال با پست: <b>رایگان</b> (خرید بالای ${money(freeShippingMin(env))} تومان)\n`;
  }
  text += `🧾 جمع کل: <b>${money(price)} تومان</b>\n`;

  if (walletUsed > 0) {
    text += `💼 اعتبار کیف پول: ${money(wallet)} تومان\n`;
    text += `🔹 کسر شده از کیف پول: ${money(walletUsed)} تومان\n`;
  }

  text += `💳 مبلغ قابل پرداخت: <b>${money(payable)} تومان</b>\n`;

  // همان محاسبه‌ی confirmOrder: درصدی از مبلغ نقدی
  const cashback = Math.round((payable * cashbackPercent(env)) / 100);
  if (cashback > 0) {
    text += `💸 کش‌بک: <b>${money(cashback)} تومان</b> (${cashbackPercent(env)}٪) بعد از تایید سفارش به کیف پول شما برمی‌گردد\n`;
  }
  text += '\n';

  if (payable <= 0) {
    text += '🎉 موجودی کیف پول شما برای خرید این محصول کافی است!';
  } else {
    text += `لطفاً مبلغ <b>${money(payable)} تومان</b> را به شماره کارت زیر واریز کرده و دکمه «ارسال رسید» را بزنید.\n\n` +
            `💳 شماره کارت: <code>${env.CARD_NUMBER || ''}</code>\n` +
            `👤 به نام: ${env.CARD_HOLDER || ''}`;
  }

  return text;
}

// ----------------------------------------------------
// اطلاع‌رسانی به ادمین‌ها
// ----------------------------------------------------
export async function notifyAdmin(env, text, keyboard = null) {
  const supportId = env.SUPPORT_CHAT_ID || env.ADMIN_CHAT_ID;
  if (supportId) {
    await api.sendMessage(env, supportId, text, keyboard);
  }
  if (env.ADMIN_CHAT_ID && env.ADMIN_CHAT_ID !== supportId) {
    await api.sendMessage(env, env.ADMIN_CHAT_ID, text, keyboard);
  }
}

// ----------------------------------------------------
// پیام همگانی خودکار
// ادمین فقط پیام را می‌فرستد؛ صف در دیتابیس ساخته می‌شود و Cron هر دقیقه یک دسته را
// ارسال می‌کند (processBroadcastQueue). پایان کار، خلاصه‌ی نتیجه برای ادمین فرستاده می‌شود.
// خود پیام ادمین با copyMessage کپی می‌شود، پس متن، عکس، فیلم، گیف، فایل و ویس همگی با
// همان کپشن و قالب‌بندی ارسال می‌شوند. وضعیت کار در settings نگه داشته می‌شود تا نیازی به
// تغییر ساختار جدول broadcast_queue نباشد.
// وضعیت ردیف‌های صف: pending → sending → sent | failed  (یا cancelled با /stopbroadcast)
// ----------------------------------------------------
const BROADCAST_JOB_KEY = 'broadcast_job';
const BROADCAST_ERROR_KEY = 'broadcast_last_error';
const BROADCAST_HEARTBEAT_KEY = 'broadcast_heartbeat';
// ردیف‌هایی که بیش از این مدت در وضعیت sending مانده‌اند (اجرای نیمه‌کاره) ناموفق حساب می‌شوند
const BROADCAST_STALE_MINUTES = 5;

// هر اجرای Cron یک دسته‌ی ۴۰تایی می‌فرستد (قابل تغییر با BROADCAST_BATCH_SIZE)
const DEFAULT_BROADCAST_BATCH = 40;
function broadcastBatchSize(env) {
  const n = Number(env.BROADCAST_BATCH_SIZE || DEFAULT_BROADCAST_BATCH);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_BROADCAST_BATCH;
}

async function getBroadcastJob(env) {
  try {
    return JSON.parse(await db.getSetting(env, BROADCAST_JOB_KEY, 'null'));
  } catch (e) {
    return null;
  }
}

async function broadcastCounts(env) {
  const { results } = await env.DB.prepare(
    'SELECT status, COUNT(*) AS cnt FROM broadcast_queue GROUP BY status'
  ).all();
  const counts = { pending: 0, sending: 0, sent: 0, failed: 0, cancelled: 0 };
  for (const r of results || []) counts[r.status] = Number(r.cnt) || 0;
  return counts;
}

function broadcastEta(env, left) {
  return Math.max(1, Math.ceil(left / broadcastBatchSize(env)));
}

export async function broadcastStatusText(env) {
  const job = await getBroadcastJob(env);
  if (!job || job.done) return '📭 در حال حاضر هیچ پیام همگانی در حال ارسال نیست.';
  const c = await broadcastCounts(env);
  const left = c.pending + c.sending;
  return (
    `📢 <b>پیام همگانی در حال ارسال است</b>\n\n` +
    `✅ موفق: ${c.sent} | ❌ ناموفق: ${c.failed}\n` +
    `⏳ باقی‌مانده: ${left} نفر (حدود ${broadcastEta(env, left)} دقیقه)\n\n` +
    `برای توقف: <code>/stopbroadcast</code>`
  );
}

export async function broadcastToAll(env, adminChatId, messageObj) {
  try {
    const running = await getBroadcastJob(env);
    if (running && !running.done) {
      await api.sendMessage(
        env,
        adminChatId,
        `⚠️ پیام همگانی قبلی هنوز تمام نشده است.\n\n${await broadcastStatusText(env)}`,
        await menuKeyboardFor(env, adminChatId)
      );
      return;
    }

    const chatIds = await db.getAllChatIds(env);

    if (!chatIds || chatIds.length === 0) {
      await api.sendMessage(env, adminChatId, '⚠️ هیچ کاربری در دیتابیس یافت نشد.', await menuKeyboardFor(env, adminChatId));
      return;
    }

    const textContent = (messageObj && (messageObj.text || messageObj.caption)) || '';
    const source = { from_chat_id: String(messageObj.chat.id), message_id: messageObj.message_id };
    await db.setSetting(env, BROADCAST_SOURCE_KEY, JSON.stringify(source));
    await db.setSetting(env, BROADCAST_ERROR_KEY, '');
    await db.setSetting(env, BROADCAST_HEARTBEAT_KEY, db.sqlTime());

    await env.DB.prepare("DELETE FROM broadcast_queue").run();

    const stmt = env.DB.prepare("INSERT INTO broadcast_queue (chat_id, text, status) VALUES (?, ?, 'pending')");
    const batchStmts = chatIds.map((cid) => stmt.bind(cid, textContent));
    await env.DB.batch(batchStmts);

    // job آخر از همه ذخیره می‌شود تا Cron فقط صف کامل‌شده را بردارد
    const job = { admin: String(adminChatId), total: chatIds.length, started_at: db.sqlTime(), done: false };
    await db.setSetting(env, BROADCAST_JOB_KEY, JSON.stringify(job));

    await api.sendMessage(
      env,
      adminChatId,
      `📢 <b>صف پیام همگانی ساخته شد!</b>\n\n` +
        `👥 تعداد کل کاربران: ${chatIds.length} نفر\n` +
        `⏱ زمان تقریبی ارسال: حدود ${broadcastEta(env, chatIds.length)} دقیقه\n\n` +
        `ارسال به‌صورت خودکار انجام می‌شود و نیازی به کاری از طرف شما نیست. ` +
        `بعد از پایان، نتیجه برایتان ارسال می‌شود.\n\n` +
        `وضعیت: <code>/broadcaststatus</code> | توقف: <code>/stopbroadcast</code>`,
      await menuKeyboardFor(env, adminChatId)
    );

  } catch (err) {
    await api.sendMessage(
      env,
      adminChatId,
      `❌ خطا در ایجاد صف پیام همگانی: ${err.message || err}`,
      await menuKeyboardFor(env, adminChatId)
    );
  }
}

// توقف ارسال: ردیف‌های ارسال‌نشده لغو می‌شوند؛ گزارش نهایی در اجرای بعدی Cron ارسال می‌شود
export async function stopBroadcast(env) {
  const job = await getBroadcastJob(env);
  if (!job || job.done) return null;
  const result = await env.DB.prepare("UPDATE broadcast_queue SET status = 'cancelled' WHERE status = 'pending'").run();
  return result.meta.changes || 0;
}

// گزارش پایان فقط یک بار ارسال می‌شود (compare-and-swap روی مقدار job در settings)
async function finishBroadcast(env, job, rawJob) {
  const doneJob = JSON.stringify({ ...job, done: true, finished_at: db.sqlTime() });
  const claimed = await env.DB.prepare('UPDATE settings SET value = ? WHERE key = ? AND value = ?')
    .bind(doneJob, BROADCAST_JOB_KEY, rawJob)
    .run();
  if (claimed.meta.changes !== 1) return false;

  const c = await broadcastCounts(env);
  const lastError = await db.getSetting(env, BROADCAST_ERROR_KEY, '');
  const errorLine = lastError ? `\n⚠️ آخرین خطا: <code>${escapeHtml(lastError)}</code>` : '';
  const cancelledLine = c.cancelled > 0 ? `\n⛔ متوقف‌شده (ارسال‌نشده): ${c.cancelled} نفر` : '';
  await api.sendMessage(
    env,
    job.admin,
    `🎉 <b>ارسال پیام همگانی به پایان رسید!</b>\n\n` +
      `👥 کل: ${job.total} نفر\n` +
      `✅ موفق: ${c.sent} | ❌ ناموفق: ${c.failed}${cancelledLine}${errorLine}`,
    await menuKeyboardFor(env, job.admin)
  );
  return true;
}

// اجرا با Cron: ارسال یک دسته و در صورت اتمام صف، گزارش نهایی به ادمین.
// maxSends: سقف ارسال در این اجرا (اگر Cron در همین دقیقه پیام سفارش‌ها را هم فرستاده باشد کمتر از ۴۰ است)
export async function processBroadcastQueue(env, now = new Date(), maxSends = Infinity) {
  const summary = { sent: 0, failed: 0, finished: false };
  const rawJob = await db.getSetting(env, BROADCAST_JOB_KEY, null);
  let job = null;
  try {
    job = JSON.parse(rawJob);
  } catch (e) {}
  // صف‌های قدیمی بدون job (نسخه‌ی دستی قبلی) خودکار ارسال نمی‌شوند
  if (!job || job.done) return summary;

  // برداشتن اتمی یک دسته: اجرای هم‌زمان Cron ردیف تکراری برنمی‌دارد
  const { results: rows } = await env.DB.prepare(
    `UPDATE broadcast_queue SET status = 'sending'
     WHERE id IN (SELECT id FROM broadcast_queue WHERE status = 'pending' ORDER BY id LIMIT ?)
     RETURNING id, chat_id, text`
  ).bind(Math.max(0, Math.min(broadcastBatchSize(env), maxSends))).all();

  if (rows && rows.length > 0) {
    await db.setSetting(env, BROADCAST_HEARTBEAT_KEY, db.sqlTime(now));

    let source = null;
    try {
      source = JSON.parse(await db.getSetting(env, BROADCAST_SOURCE_KEY, 'null'));
    } catch (e) {}

    const sentIds = [];
    const failedIds = [];
    let lastError = '';

    for (const row of rows) {
      try {
        let res;
        if (source && source.message_id) {
          res = await api.copyMessage(env, row.chat_id, source.from_chat_id, source.message_id);
        } else if (row.text) {
          res = await api.sendMessage(env, row.chat_id, row.text);
        }

        if (res && res.ok) {
          sentIds.push(row.id);
        } else {
          failedIds.push(row.id);
          lastError = res?.description || 'پیام قابل ارسالی پیدا نشد';
        }
      } catch (e) {
        failedIds.push(row.id);
        lastError = e.message || String(e);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const mark = (status, ids) =>
      env.DB.prepare(`UPDATE broadcast_queue SET status = ? WHERE id IN (${ids.map(() => '?').join(',')})`).bind(status, ...ids);
    const stmts = [];
    if (sentIds.length) stmts.push(mark('sent', sentIds));
    if (failedIds.length) stmts.push(mark('failed', failedIds));
    await env.DB.batch(stmts);
    if (lastError) await db.setSetting(env, BROADCAST_ERROR_KEY, lastError);

    summary.sent = sentIds.length;
    summary.failed = failedIds.length;
  }

  const c = await broadcastCounts(env);
  if (c.pending > 0) return summary;

  if (c.sending > 0) {
    // ردیف sending فقط وقتی باقی می‌ماند که اجرای قبلی وسط کار قطع شده باشد
    const heartbeat = await db.getSetting(env, BROADCAST_HEARTBEAT_KEY, job.started_at);
    const staleBefore = db.sqlTime(new Date(now.getTime() - BROADCAST_STALE_MINUTES * 60000));
    if (String(heartbeat) > staleBefore) return summary;
    await env.DB.prepare("UPDATE broadcast_queue SET status = 'failed' WHERE status = 'sending'").run();
    await db.setSetting(env, BROADCAST_ERROR_KEY, 'اجرای ارسال نیمه‌کاره قطع شد؛ وضعیت این ردیف‌ها نامعلوم است');
  }

  summary.finished = await finishBroadcast(env, job, rawJob);
  return summary;
}
