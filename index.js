import { handleMessage } from './message.js';
import { handleCallbackQuery } from './callback.js';
import { processPendingOrders } from './scheduler.js';
import { processBroadcastQueue } from './flows.js';

const SUBREQUEST_BUDGET = 49;

// مقایسه‌ی زمان-ثابت، تا از زمان پاسخ نشود secret را حدس زد
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

// راه‌اندازی/بازنشانی ربات از طریق خود Worker (وقتی api.telegram.org از سیستم شما در دسترس نیست):
//   GET /setup?key=<WEBHOOK_SECRET>
// webhook قبلی و پیام‌های پردازش‌نشده‌ی قبلی پاک می‌شوند، دستورهای قدیمی ربات حذف و webhook روی همین Worker ثبت می‌شود.
async function setupBot(request, env) {
  const url = new URL(request.url);
  if (!env.WEBHOOK_SECRET || !safeEqual(url.searchParams.get('key') || '', env.WEBHOOK_SECRET)) {
    return new Response('unauthorized', { status: 401 });
  }
  const tg = async (method, payload = {}) => {
    const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return res.json();
  };
  const report = {
    getMe: await tg('getMe'),
    deleteWebhook: await tg('deleteWebhook', { drop_pending_updates: true }),
    deleteMyCommands: await tg('deleteMyCommands'),
    setWebhook: await tg('setWebhook', {
      url: `${url.origin}/`,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    }),
  };
  report.webhookInfo = await tg('getWebhookInfo');
  return new Response(JSON.stringify(report, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET' && new URL(request.url).pathname === '/setup') {
      return setupBot(request, env);
    }

    if (request.method !== 'POST') {
      return new Response('ربات فروشگاهی فعاله ✅');
    }

    // اگر WEBHOOK_SECRET تنظیم شده باشد، فقط درخواست‌هایی که تلگرام با همان secret_token می‌فرستد پذیرفته می‌شوند
    if (env.WEBHOOK_SECRET) {
      const token = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!safeEqual(token, env.WEBHOOK_SECRET)) {
        return new Response('unauthorized', { status: 401 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response('bad request', { status: 400 });
    }

    try {
      if (update.callback_query) {
        await handleCallbackQuery(env, update.callback_query);
      } else if (update.message) {
        await handleMessage(env, update.message);
      }
    } catch (e) {
      console.error('خطای پردازش آپدیت:', e);
    }

    return new Response('OK');
  },

  // Cron Trigger (wrangler.toml → [triggers]): یادآوری و لغو سفارش‌های معلق + ارسال خودکار پیام همگانی
  async scheduled(event, env, ctx) {
    const now = new Date(event.scheduledTime);
    ctx.waitUntil(
      (async () => {
        let used = 0;
        try {
          const orders = await processPendingOrders(env, now);
          used = orders.messages || 0;
          console.log('pending-orders', JSON.stringify(orders));
        } catch (e) {
          console.error('خطای پردازش سفارش‌های معلق:', e);
        }
        try {
          // سقف ۵۰ درخواست خروجی در هر اجرا (پلن رایگان): ۱ جا برای گزارش نهایی می‌ماند
          const bc = await processBroadcastQueue(env, now, SUBREQUEST_BUDGET - 1 - used);
          if (bc.sent || bc.failed || bc.finished) console.log('broadcast', JSON.stringify(bc));
        } catch (e) {
          console.error('خطای ارسال پیام همگانی:', e);
        }
      })()
    );
  },
};
