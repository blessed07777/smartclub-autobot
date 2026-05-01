const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN           = process.env.WHATSAPP_TOKEN;
const PHONE_ID        = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'smartclub2024';
const TEMPLATE_NAME   = process.env.TEMPLATE_NAME   || 'smartclub_quiz';
const FLOW_SERVER_URL = process.env.FLOW_SERVER_URL  || ''; // https://smartclub-flow-production.up.railway.app

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID   || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

const sent = new Set();

const GRADE_LABEL = {
  g3:  '3–4 класс',
  g5:  '5–6 класс',
  g7:  '7–9 класс',
  g10: '10–11 класс'
};
const GOAL_LABEL = {
  nil:   'НИШ',
  rfmsh: 'РФМШ',
  bil:   'БИЛ',
  ent:   'ЕНТ'
};

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS_RAW) {
    console.log('[Sheets] Переменные не заданы, пропускаем');
    return;
  }
  try {
    const creds = JSON.parse(GOOGLE_CREDS_RAW);
    const auth  = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('📊 Записано в Google Таблицу:', row);
  } catch (e) {
    console.error('❌ Ошибка Google Sheets:', e.message);
  }
}

// ─── Получить сессию с flow-сервера ──────────────────────────────────────────
async function getSession(phone) {
  if (!FLOW_SERVER_URL) return {};
  try {
    const r = await fetch(`${FLOW_SERVER_URL}/session/${phone}`);
    const data = await r.json();
    console.log(`📂 Сессия для ${phone}:`, JSON.stringify(data));
    return data;
  } catch (e) {
    console.error('❌ Ошибка получения сессии:', e.message);
    return {};
  }
}

// ─── Отправка текстового сообщения ───────────────────────────────────────────
async function sendMessage(to, text) {
  const url  = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text }
  };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (result.error) {
    console.error('❌ Ошибка отправки сообщения:', result.error.message);
  } else {
    console.log(`📤 Сообщение отправлено → ${to}`);
  }
}

// ─── Отправка шаблона с Flow ──────────────────────────────────────────────────
async function sendFlowTemplate(phone) {
  const url  = `https://graph.facebook.com/v19.0/${PHONE_ID}/messages`;
  const body = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: 'en' },
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
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (result.error) {
    console.error('❌ Ошибка отправки шаблона:', result.error.message);
  } else {
    console.log(`📨 Шаблон отправлен → ${phone} | id: ${result.messages?.[0]?.id}`);
  }
}

// ─── Верификация webhook ───────────────────────────────────────────────────────
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

// ─── Обработка webhook ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msg     = value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;
    console.log(`📩 От ${phone} | type="${msg.type}" interactive_type="${msg.interactive?.type || ''}"`);

    // ── nfm_reply: Flow завершён ──────────────────────────────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      console.log('🔔 nfm_reply!');
      console.log('📦 raw:', JSON.stringify(msg.interactive.nfm_reply));

      // Парсим response_json
      let fd = {};
      try {
        const raw = msg.interactive.nfm_reply?.response_json;
        fd = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch (e) {
        console.error('❌ Ошибка парсинга response_json:', e.message);
      }
      console.log('📋 formData:', JSON.stringify(fd));

      // Программа из статического поля (всегда приходит)
      const program  = fd.program || fd.client_goal || '—';
      const progLabel = GOAL_LABEL[program] || program.toUpperCase();

      // Телефон из msg.from (всегда известен)
      const ph = phone;

      // Имя из формы (может не прийти)
      const name = fd.contact_name || fd.name || '—';

      // Класс из сессии flow-сервера (сохранён при выборе квиза)
      const session  = await getSession(phone);
      const gradeRaw = session.grade || fd.client_grade || '—';
      const grade    = GRADE_LABEL[gradeRaw] || gradeRaw;

      const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
      const row = [now, name, ph, grade, progLabel, 'Новая заявка'];

      console.log(`✅ ЗАЯВКА: ${name} | ${ph} | ${grade} | ${progLabel}`);
      await appendToSheet(row);

      // Подтверждение клиенту
      const confirmText =
        `✅ Заявка принята!\n\n` +
        `📱 ${ph}\n` +
        `🎓 ${grade} → ${progLabel}\n\n` +
        `Менеджер свяжется с вами в течение 30 минут.\n\n` +
        `📍 Алматы, ул. Байзакова 280\n📞 +7 (707) 900-30-11`;
      await sendMessage(phone, confirmText);
      return;
    }

    // ── Обычное сообщение: отправляем шаблон с Flow ───────────────────────────
    if (!sent.has(phone)) {
      sent.add(phone);
      await sendFlowTemplate(phone);
    }

  } catch (err) {
    console.error('❌ Ошибка webhook:', err.message);
  }
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot запущен на порту ${PORT}`);
  console.log(`🔑 Token:       ${TOKEN      ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID:    ${PHONE_ID   || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон:      ${TEMPLATE_NAME}`);
  console.log(`📊 Sheets ID:   ${SPREADSHEET_ID || '❌ не задан'}`);
  console.log(`🔗 Flow Server: ${FLOW_SERVER_URL || '❌ не задан'}`);
});
