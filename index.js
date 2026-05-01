const express = require('express');
const app = express();
app.use(express.json());

const TOKEN         = process.env.WHATSAPP_TOKEN;
const PHONE_ID      = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN || 'smartclub2024';
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'smartclub';

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
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msg     = value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;
    console.log(`📩 Входящее сообщение от ${phone}, тип: ${msg.type}`);

    if (!sent.has(phone)) {
      sent.add(phone);

      // Сначала пробуем шаблон
      const ok = await sendTemplate(phone);

      // Если шаблон не сработал — отправляем текст
      if (!ok) {
        await sendText(phone, '👋 Привет! SmartClub поможет подготовить вашего ребёнка к НИШ, РФМШ, БИЛ или ЕНТ.\n\nОтветьте *1* чтобы узнать подробнее о программах.');
      }
    }

  } catch (err) {
    console.error('❌ Ошибка webhook:', err.message);
  }
});

// ─── Отправка шаблона ─────────────────────────────────────────────────────────
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
          parameters: [{ type: 'action', action: { flow_token: phone } }]
        }
      ]
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });

  const result = await response.json();
  if (result.error) {
    console.error('❌ Шаблон не отправлен:', result.error.message);
    return false;
  }
  console.log(`📨 Шаблон отправлен → ${phone}`);
  return true;
}

// ─── Отправка текста ──────────────────────────────────────────────────────────
async function sendText(phone, text) {
  const url  = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: text }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });

  const result = await response.json();
  if (result.error) {
    console.error('❌ Текст не отправлен:', result.error.message);
  } else {
    console.log(`✉️ Текст отправлен → ${phone}`);
  }
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot запущен на порту ${PORT}`);
  console.log(`🔑 Token: ${TOKEN ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон: ${TEMPLATE_NAME}`);
});
