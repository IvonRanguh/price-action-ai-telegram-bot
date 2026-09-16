import { Alert } from '../types';

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt: number, retryAfterSec?: number): number {
  if (typeof retryAfterSec === 'number' && retryAfterSec > 0) {
    return retryAfterSec * 1000;
  }
  return INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
}

function isRetryableStatus(status?: number): boolean {
  if (!status) return true; // network/unknown
  return status === 429 || status >= 500;
}

/**
 * Send Telegram message to chat with retry (Cloudflare-friendly)
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }),
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // ignore JSON parse failure
      }

      if (res.ok) {
        console.log(`[Telegram] ✅ sent to ${chatId} (attempt ${attempt})`);
        return true;
      }

      const retryAfterSec = data?.parameters?.retry_after as number | undefined;
      const reason = data?.description || res.statusText || 'Unknown error';
      console.error(
        `[Telegram] ❌ failed to send to ${chatId} (attempt ${attempt}/${MAX_RETRIES}) status=${res.status} reason=${reason}`
      );

      const retryable = isRetryableStatus(res.status);
      const lastAttempt = attempt === MAX_RETRIES;

      if (!retryable || lastAttempt) {
        if (!retryable) {
          console.error(`[Telegram] ⛔ non-retryable status for ${chatId}, stop retrying.`);
        }
        return false;
      }

      const delayMs = getRetryDelayMs(attempt, retryAfterSec);
      console.log(`[Telegram] 🔁 retrying ${chatId} in ${delayMs}ms...`);
      await sleep(delayMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown error';
      console.error(
        `[Telegram] ❌ network/runtime error for ${chatId} (attempt ${attempt}/${MAX_RETRIES}) reason=${reason}`
      );

      const lastAttempt = attempt === MAX_RETRIES;
      if (lastAttempt) return false;

      const delayMs = getRetryDelayMs(attempt);
      console.log(`[Telegram] 🔁 retrying ${chatId} in ${delayMs}ms...`);
      await sleep(delayMs);
    }
  }

  return false;
}

/**
 * Format alert message for Telegram
 */
export function formatAlertMessage(alert: Alert): string {
  const { symbol, action, priceData } = alert;
  const change = priceData.price - priceData.previousClose;
  const changePercent = ((change / priceData.previousClose) * 100).toFixed(2);

  return `
<b>🚨 PRICE ACTION ALERT</b>

<b>Stock:</b> <code>${symbol}</code>
<b>Pattern:</b> ${action.description}
<b>Strength:</b> ${action.strength}/100

<b>Current Price:</b> <code>Rp ${priceData.price.toLocaleString('id-ID')}</code>
<b>Previous Close:</b> <code>Rp ${priceData.previousClose.toLocaleString('id-ID')}</code>
<b>Change:</b> <code>${change > 0 ? '+' : ''}${change.toFixed(0)} (${changePercent}%)</code>
<b>High:</b> <code>Rp ${priceData.high.toLocaleString('id-ID')}</code>
<b>Low:</b> <code>Rp ${priceData.low.toLocaleString('id-ID')}</code>

<i>Time: ${new Date(priceData.timestamp).toLocaleString('id-ID')}</i>
  `.trim();
}

/**
 * Send alert to all subscribed users
 * - Parallel per batch
 * - Delay between batches for rate limiting
 */
export async function broadcastAlert(
  botToken: string,
  alert: Alert
): Promise<number> {
  const message = formatAlertMessage(alert);
  let sentCount = 0;

  for (let i = 0; i < alert.chatIds.length; i += BATCH_SIZE) {
    const batch = alert.chatIds.slice(i, i + BATCH_SIZE);

    console.log(
      `[Telegram] 🚀 sending batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} recipients)`
    );

    const results = await Promise.all(
      batch.map((chatId) => sendTelegramMessage(botToken, chatId, message))
    );

    const successInBatch = results.filter(Boolean).length;
    const failedInBatch = results.length - successInBatch;
    sentCount += successInBatch;

    console.log(
      `[Telegram] 📊 batch result: success=${successInBatch}, failed=${failedInBatch}, totalSuccess=${sentCount}`
    );

    const hasNextBatch = i + BATCH_SIZE < alert.chatIds.length;
    if (hasNextBatch) {
      console.log(`[Telegram] ⏳ waiting ${BATCH_DELAY_MS}ms before next batch...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(
    `[Telegram] ✅ broadcast completed: success=${sentCount}/${alert.chatIds.length}`
  );

  return sentCount;
}
