import axios, { AxiosError } from 'axios';
import { Alert } from '../types';

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 1000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt: number, error: unknown): number {
  const axiosError = error as AxiosError<{ parameters?: { retry_after?: number } }>;
  const retryAfterSec = axiosError?.response?.data?.parameters?.retry_after;

  if (typeof retryAfterSec === 'number' && retryAfterSec > 0) {
    return retryAfterSec * 1000;
  }

  return INITIAL_BACKOFF_MS * 2 ** (attempt - 1);
}

function isRetryableError(error: unknown): boolean {
  const axiosError = error as AxiosError;
  const status = axiosError?.response?.status;

  if (!status) return true; // network / timeout / unknown transient errors
  if (status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * Send Telegram message to chat with retry
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await axios.post(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        }
      );

      const success = response.status === 200;
      if (success) {
        console.log(`[Telegram] ✅ sent to ${chatId} (attempt ${attempt})`);
      } else {
        console.warn(
          `[Telegram] ⚠️ non-200 for ${chatId}: ${response.status} (attempt ${attempt})`
        );
      }

      return success;
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError?.response?.status;
      const reason =
        axiosError?.response?.statusText || axiosError?.message || 'Unknown error';

      const retryable = isRetryableError(error);
      const lastAttempt = attempt === MAX_RETRIES;

      console.error(
        `[Telegram] ❌ failed to send to ${chatId} (attempt ${attempt}/${MAX_RETRIES})` +
          `${status ? ` status=${status}` : ''} reason=${reason}`
      );

      if (!retryable || lastAttempt) {
        if (!retryable) {
          console.error(`[Telegram] ⛔ non-retryable error for ${chatId}, stop retrying.`);
        }
        return false;
      }

      const delayMs = getRetryDelayMs(attempt, error);
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
      `[Telegram] 🚀 sending batch ${Math.floor(i / BATCH_SIZE) + 1} ` +
        `(${batch.length} recipients)`
    );

    const results = await Promise.all(
      batch.map((chatId) => sendTelegramMessage(botToken, chatId, message))
    );

    const successInBatch = results.filter(Boolean).length;
    const failedInBatch = results.length - successInBatch;
    sentCount += successInBatch;

    console.log(
      `[Telegram] 📊 batch result: success=${successInBatch}, failed=${failedInBatch}, ` +
        `totalSuccess=${sentCount}`
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
