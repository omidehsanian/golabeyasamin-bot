export const ADMIN_ORDERS_BUTTON = '📦 سفارشات';
export const NEW_PRODUCT_BUTTON = '➕ ساخت محصول';
export const MANAGE_PRODUCTS_BUTTON = '🛠 مدیریت محصولات';
export const BROADCAST_BUTTON = '📢 ارسال پیام همگانی';
export const WALLET_BUTTON = '💼 موجودی کیف پول';
export const INVITE_BUTTON = '👥 دعوت از دوستان';
export const SUPPORT_BUTTON = '📞 ارتباط با ادمین';
export const CUSTOM_BOT_BUTTON = '🤖 ساخت ربات';
export const CART_BUTTON = '🛒 سبد خرید';
export const ADDRESS_BUTTON = '📍 آدرس';
// متن قبلی همین دکمه؛ کیبورد کاربران تا پیام منوی بعدی عوض نمی‌شود
export const OLD_ADDRESS_BUTTON = '📍 مشخصات آدرس';
export const ADMIN_DISCOUNTS_BUTTON = '🎟 کدهای تخفیف';
export const DISABLE_PRODUCT_BUTTON = '⏸ فعال / غیرفعال کردن کالا';
// دکمه‌ی روشن/خاموش سبد خرید برای ادمین‌ها (متن وضعیت بعد از این پیشوند می‌آید)
export const CART_TOGGLE_PREFIX = '⚙️ سبد خرید';

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
  CART_BUTTON,
  ADDRESS_BUTTON,
  OLD_ADDRESS_BUTTON,
  ADMIN_DISCOUNTS_BUTTON,
  DISABLE_PRODUCT_BUTTON,
  '🔙 انصراف',
  '📱 ثبت نام',
  '🔙 شاید بعدا',
];

// چیدمان ردیفی دکمه‌های محصول: هر ردیف `columns` تا؛ با featuredFirst اولین محصول یک ردیف کامل برای خودش دارد
export function productRows(items, columns = 2, featuredFirst = false) {
  const rows = [];
  const start = featuredFirst && items.length ? 1 : 0;
  if (start) rows.push([items[0]]);
  for (let i = start; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return rows;
}

// products: محصولات به ترتیب position
// opts.superAdmin: سفارشات و پیام همگانی | opts.admin: ساخت/مدیریت محصولات
// opts.cart: دکمه‌ی سبد دیده شود | opts.cartToggle: null = دکمه‌ی ادمین نباشد، true/false = وضعیت فعلی
// opts.hasProducts: محصولی هست، حتی اگر همه پنهان باشند
export function mainMenuKeyboard(products = [], opts = {}) {
  const {
    superAdmin = false,
    admin = superAdmin,
    columns = 2,
    featuredFirst = false,
    customBot = false,
    cart = true,
    cartToggle = null,
    hasProducts = products.length > 0,
  } = opts;
  const keyboard = productRows(products, columns, featuredFirst).map((row) =>
    row.map((p) => (p.buttonStyle ? { text: p.buttonText, style: p.buttonStyle } : { text: p.buttonText }))
  );
  // دکمه‌های ثابت جای خالی ردیف آخر محصولات را پر می‌کنند و با همان تعداد ستون ادامه می‌یابند
  const fixed = [ADDRESS_BUTTON, ...(cart ? [CART_BUTTON] : []), WALLET_BUTTON, INVITE_BUTTON, SUPPORT_BUTTON, ...(customBot ? [CUSTOM_BOT_BUTTON] : [])]
    .map((text) => ({ text }));
  // ردیف محصول ویژه همیشه تک‌دکمه می‌ماند
  const lastRow = products.length > (featuredFirst ? 1 : 0) ? keyboard.at(-1) : null;
  if (lastRow) lastRow.push(...fixed.splice(0, Math.max(0, columns - lastRow.length)));
  for (let i = 0; i < fixed.length; i += columns) keyboard.push(fixed.slice(i, i + columns));

  if (superAdmin) {
    keyboard.push([{ text: ADMIN_ORDERS_BUTTON }, { text: BROADCAST_BUTTON }]);
  }
  if (admin) {
    // تا وقتی محصولی نیست فقط «ساخت محصول»
    keyboard.push(hasProducts ? [{ text: NEW_PRODUCT_BUTTON }, { text: MANAGE_PRODUCTS_BUTTON }] : [{ text: NEW_PRODUCT_BUTTON }]);
    if (hasProducts) keyboard.push([{ text: DISABLE_PRODUCT_BUTTON }]);
    const row = [{ text: ADMIN_DISCOUNTS_BUTTON }];
    if (cartToggle !== null) row.push({ text: `${CART_TOGGLE_PREFIX}: ${cartToggle ? 'روشن ✅' : 'خاموش ⛔'}` });
    keyboard.push(row);
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

// صفحه‌ی محصول: دکمه‌ی افزودن، و بعد از افزودن ➖ تعداد ➕ روی همان پیام
export function productKeyboard(product, quantity = 0) {
  if (quantity <= 0) {
    return { inline_keyboard: [[{ text: '🛒 افزودن به سبد خرید', callback_data: `buy:${product.id}` }]] };
  }
  return {
    inline_keyboard: [
      [
        { text: '➖', callback_data: `pq:dec:${product.id}` },
        { text: `${quantity.toLocaleString('fa-IR')} عدد در سبد`, callback_data: 'cart:noop' },
        { text: '➕', callback_data: `pq:inc:${product.id}` },
      ],
      [{ text: '🛒 مشاهده سبد و ثبت سفارش', callback_data: 'cart:view' }],
    ],
  };
}

// خرید مستقیم وقتی سبد خاموش است: تعداد ← روش تحویل (مسیر qty: در callback.js)
export function directBuyKeyboard(product) {
  const button = (n) => ({ text: `${n.toLocaleString('fa-IR')} عدد`, callback_data: `qty:${product.id}:${n}` });
  return { inline_keyboard: [[button(1), button(2), button(3)], [button(5), button(10), button(20)]] };
}

export function cartKeyboard(items) {
  const inline_keyboard = items.map((i) => [
    { text: '➖', callback_data: `cart:dec:${i.productId}` },
    { text: `${i.title} ×${i.quantity.toLocaleString('fa-IR')}`, callback_data: 'cart:noop' },
    { text: '➕', callback_data: `cart:inc:${i.productId}` },
  ]);
  inline_keyboard.push([{ text: '✅ ثبت سفارش', callback_data: 'cart:checkout' }]);
  inline_keyboard.push([{ text: '🗑 خالی کردن سبد', callback_data: 'cart:clear' }]);
  return { inline_keyboard };
}

export function cartDeliveryKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🏬 تحویل حضوری (رایگان)', callback_data: 'cart:ship:p' }],
      [{ text: '🛵 پیک (فقط تهران)', callback_data: 'cart:ship:c' }],
      [{ text: '📦 پست (سایر شهرها)', callback_data: 'cart:ship:s' }],
    ],
  };
}

export function addressActionKeyboard(label = '✏️ ویرایش آدرس') {
  return { inline_keyboard: [[{ text: label, callback_data: 'addr:edit' }]] };
}

export function fillAddressKeyboard() {
  return { inline_keyboard: [[{ text: '📍 ثبت آدرس', callback_data: 'addr:fill' }]] };
}

export function skipPostalKeyboard() {
  return { inline_keyboard: [[{ text: 'کد پستی را نمی‌دانم', callback_data: 'addr:skip_postal' }]] };
}

export function deliveryKeyboard(productId, quantity) {
  return {
    inline_keyboard: [
      [{ text: '🏬 تحویل حضوری (رایگان)', callback_data: `os:${productId}:p${quantity}` }],
      [{ text: '🛵 پیک (فقط تهران)', callback_data: `os:${productId}:c${quantity}` }],
      [{ text: '📦 پست (سایر شهرها)', callback_data: `os:${productId}:s${quantity}` }],
    ],
  };
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