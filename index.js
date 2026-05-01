const express = require('express');
const app = express();
app.use(express.json());

const TOKEN         = process.env.WHATSAPP_TOKEN;
const PHONE_ID      = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN || 'smartclub2024';
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'smartclub';

// Запоминаем кому уже отправили шаблон (в памяти)
const sent = new Set();

// ─── Верификация webhook ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook верифицирован');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// ─── Входящие сообщения ───────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Быстро отвечаем Meta

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msg     = value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;

    // Только текстовые сообщения и только один раз на номер
    if (msg.type === 'text' && !sent.has(phone)) {
      sent.add(phone);
      await sendTemplate(phone);
      console.log(`📨 Шаблон отправлен → ${phone}`);
    }

  } catch (err) {
    console.error('❌ Ошибка webhook:', err.message);
  }
});

// ─── Отправка шаблона с кнопкой Flow ─────────────────────────────────────────
async function sendTemplate(phone) {
  const url  = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: 'ru' },
      components: [
        {
          type: 'button',
          sub_type: 'flow',
          index: '0',
          parameters: [
            {
              type: 'action',
              action: { flow_token: phone }
            }
          ]
        }
      ]
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();
  if (result.error) {
    console.error('❌ WhatsApp API ошибка:', result.error.message);
  } else {
    console.log('✅ Сообщение отправлено:', result.messages?.[0]?.id);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot запущен на порту ${PORT}`);
  console.log(`🔑 Token: ${TOKEN ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон: ${TEMPLATE_NAME}`);
});
