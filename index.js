const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN         = process.env.WHATSAPP_TOKEN;
const PHONE_ID      = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN  || 'smartclub2024';
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'smartclub';

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID   || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

const sent = new Set();

// ─── Метки ────────────────────────────────────────────────────────────────────
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

// ─── Отправка сообщения ───────────────────────────────────────────────────────
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
    console.log('📥 webhook body:', JSON.stringify(req.body).slice(0, 500));

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

      // RadioButtonsGroup возвращает объект {id, title} или строку
      const gradeRaw = fd.client_grade;
      const goalRaw  = fd.client_goal;
      const gradeId  = typeof gradeRaw === 'object' ? gradeRaw?.id : gradeRaw;
      const goalId   = typeof goalRaw  === 'object' ? goalRaw?.id  : goalRaw;

      const name  = fd.contact_name  || '—';
      const ph    = fd.contact_phone || phone;
      const grade = GRADE_LABEL[gradeId] || gradeId || '—';
      const goal  = GOAL_LABEL[goalId]   || goalId  || '—';
      const now   = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      console.log(`✅ ЗАЯВКА: ${name} | ${ph} | ${grade} | ${goal}`);
      await appendToSheet([now, name, ph, grade, goal, 'Новая заявка']);

      // Подтверждение клиенту
      const confirmText =
        `✅ Заявка принята!\n\n` +
        `👤 ${name}\n` +
        `📱 ${ph}\n` +
        `🎓 ${grade} → ${goal}\n\n` +
        `Менеджер свяжется с вами в течение 30 минут и согласует время пробного урока.\n\n` +
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
  console.log(`🔑 Token:      ${TOKEN      ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID:   ${PHONE_ID   || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон:     ${TEMPLATE_NAME}`);
  console.log(`📊 Sheets ID:  ${SPREADSHEET_ID || '❌ не задан'}`);
});
