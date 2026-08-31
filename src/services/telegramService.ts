import axios from 'axios';
import { Alert } from '../types';

/**
 * Send Telegram message to chat
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  message: string
): Promise<boolean> {
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      }
    );
    return response.status === 200;
  } catch (error) {
    console.error(`Error sending message to ${chatId}:`, error);
    return false;
  }
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
 */
export async function broadcastAlert(
  botToken: string,
  alert: Alert
): Promise<number> {
  const message = formatAlertMessage(alert);
  let sentCount = 0;

  for (const chatId of alert.chatIds) {
    const success = await sendTelegramMessage(botToken, chatId, message);
    if (success) sentCount++;
  }

  return sentCount;
}
