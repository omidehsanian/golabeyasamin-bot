export const ADMIN_ORDERS_BUTTON = '📦 سفارشات';
export const NEW_PRODUCT_BUTTON = '➕ ساخت محصول';
export const MANAGE_PRODUCTS_BUTTON = '🛠 مدیریت محصولات';
export const BROADCAST_BUTTON = '📢 ارسال پیام همگانی';
export const WALLET_BUTTON = '💼 موجودی کیف پول';
export const INVITE_BUTTON = '👥 دعوت از دوستان';
export const SUPPORT_BUTTON = '📞 ارتباط با ادمین';
export const CUSTOM_BOT_BUTTON = '🤖 ساخت ربات';

// متن دکمه‌های ثابت منو؛ نام محصول نباید با این‌ها یکی باشد
export const RESERVED_BUTTONS = [
  ADMIN_ORDERS_BUTTON,
  NEW_PRODUCT_BUTTON,
  MANAGE_PRODUCTS_BUTTON,
  BROADCAST_BUTTON,
  WALLET_BUTTON,
  INVITE_BUTTON,
  SUPPORT_BUTTON,
  CUSTOM_BOT_BUTTON,
  '🔙 انصراف',
  '📱 ثبت نام',
  '🔙 شاید بعدا',
];

// products: محصولات به ترتیب position؛ هر ردیف `columns` دکمه
// opts.superAdmin: سفارشات و پیام همگانی | opts.admin: ساخت/مدیریت محصولات
export function mainMenuKeyboard(products = [], opts = {}) {
  const { superAdmin = false, admin = superAdmin, columns = 2, customBot = false } = opts;
  const keyboard = [];
  for (let i = 0; i < products.length; i += columns) {
    keyboard.push(products.slice(i, i + columns).map((p) => ({ text: p.buttonText })));
  }
  keyboard.push([{ text: WALLET_BUTTON }, { text: INVITE_BUTTON }]);
  keyboard.push(customBot ? [{ text: SUPPORT_BUTTON }, { text: CUSTOM_BOT_BUTTON }] : [{ text: SUPPORT_BUTTON }]);

  if (superAdmin) {
    keyboard.push([{ text: ADMIN_ORDERS_BUTTON }, { text: BROADCAST_BUTTON }]);
  }
  if (admin) {
    // تا وقتی محصولی نیست فقط «ساخت محصول»
    keyboard.push(products.length ? [{ text: NEW_PRODUCT_BUTTON }, { text: MANAGE_PRODUCTS_BUTTON }] : [{ text: NEW_PRODUCT_BUTTON }]);
  }

  return { keyboard, resize_keyboard: true };
}

export function channelRequireKeyboard(joinLink) {
  return {
    inline_keyboard: [
      [{ text: '📢 عضویت در کانال', url: joinLink }],
      [{ text: '✅ عضو شدم / بررسی مجدد', callback_data: 'check_membership' }],
    ],
  };
}

export function registerKeyboard() {
  return {
    keyboard: [
      [{ text: '📱 ثبت نام', request_contact: true }],
      [{ text: '🔙 شاید بعدا' }],
    ],
    resize_keyboard: true,
  };
}

export function productKeyboard(product) {
  const inline_keyboard = [];
  if (product.needsOs) {
    inline_keyboard.push([
      { text: '🍎 نسخه آیفون (iOS)', callback_data: `os:${product.id}:ios` },
      { text: '🤖 نسخه اندروید', callback_data: `os:${product.id}:android` },
    ]);
  } else {
    inline_keyboard.push([
      { text: '💳 خرید / ثبت سفارش', callback_data: `buy:${product.id}` },
    ]);
  }
  return { inline_keyboard };
}

export function discountPromptKeyboard(productId, osType) {
  return {
    inline_keyboard: [
      [
        { text: '🎟️ بله، ورود کد تخفیف', callback_data: `discount_yes:${productId}:${osType}` },
        { text: '💳 خیر، ادامه پرداخت', callback_data: `discount_no:${productId}:${osType}` },
      ],
    ],
  };
}

export function paymentKeyboard(productId, osType = '', canPayWithWallet = false) {
  const inline_keyboard = [];
  if (canPayWithWallet) {
    inline_keyboard.push([
      { text: '💼 پرداخت کامل با اعتبار کیف پول', callback_data: `walletpay:${productId}:${osType}` },
    ]);
  }
  inline_keyboard.push([
    { text: '📸 ارسال رسید پرداخت', callback_data: `receipt:${productId}:${osType}` },
  ]);
  return { inline_keyboard };
}

// دکمه‌های پرداخت متصل به یک سفارش مشخص (pending)
export function orderPaymentKeyboard(orderId, canPayWithWallet = false) {
  const inline_keyboard = [];
  if (canPayWithWallet) {
    inline_keyboard.push([{ text: '💼 پرداخت کامل با اعتبار کیف پول', callback_data: `wpay:${orderId}` }]);
  }
  inline_keyboard.push([{ text: '📸 ارسال رسید پرداخت', callback_data: `rcpt:${orderId}` }]);
  return { inline_keyboard };
}

export function resumeKeyboard(orderId) {
  return {
    inline_keyboard: [[{ text: '🛒 ادامه خرید', callback_data: `resume:${orderId}` }]],
  };
}

export function cancelKeyboard() {
  return {
    keyboard: [[{ text: '🔙 انصراف' }]],
    resize_keyboard: true,
  };
}

export function adminOrderKeyboard(orderId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ تایید سفارش', callback_data: `confirm_order:${orderId}` },
        { text: '❌ رد سفارش', callback_data: `reject_order:${orderId}` },
      ],
    ],
  };
}