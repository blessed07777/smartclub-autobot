const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN         = process.env.WHATSAPP_TOKEN;
const PHONE_ID      = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN  = process.env.VERIFY_TOKEN || 'smartclub2024';
const TEMPLATE_NAME = process.env.TEMPLATE_NAME || 'smartclub';

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

const sent = new Set();

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
    console.log('📊 Записано в Google Таблицу');
  } catch (e) {
    console.error('❌ Ошибка Google Sheets:', e.message);
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

// ─── Входящие сообщения ────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const msg     = value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;
    console.log(`📩 Сообщение от ${phone} | type=${msg.type}`);

    // ── nfm_reply: Flow завершён, собираем данные формы ──────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      console.log('🔔 nfm_reply получен!');
      console.log('📦 raw nfm_reply:', JSON.stringify(msg.interactive.nfm_reply));

      let formData = {};
      try {
        const raw = msg.interactive.nfm_reply?.response_json;
        formData  = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch (e) {
        console.error('❌ Не удалось распарсить response_json:', e.message);
      }
      console.log('📋 formData:', JSON.stringify(formData));

      // Извлекаем поля — берём всё, что могло прийти
      const name    = formData.contact_name  || formData.client_name  || formData.name  || '—';
      const ph      = formData.contact_phone || formData.client_phone || formData.phone || phone;
      const grade   = formData.client_grade  || formData.grade        || '—';
      const goal    = formData.client_goal   || formData.goal         || '—';
      const program = formData.program       || goal;

      const gradeLabel = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' }[grade] || grade;
      const progLabel  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ' }[program] || (program ? program.toUpperCase() : '—');
      const now        = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      const row = [now, name, ph, gradeLabel, progLabel, 'nfm_reply'];
      console.log(`✅ ЗАЯВКА (nfm): ${name} | ${ph} | ${gradeLabel} | ${progLabel}`);
      await appendToSheet(row);
      return;
    }

    // ── Обычное сообщение: отправляем шаблон с Flow ───────────────────────────
    if (!sent.has(phone)) {
      sent.add(phone);
      await sendTemplate(phone);
    }
  } catch (err) {
    console.error('❌ Ошибка:', err.message);
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
    console.error('❌ Ошибка отправки:', result.error.message);
  } else {
    console.log(`📨 Шаблон отправлен → ${phone}`);
    console.log(`✅ Сообщение отправлено: ${result.messages?.[0]?.id}`);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot запущен на порту ${PORT}`);
  console.log(`🔑 Token: ${TOKEN ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон: ${TEMPLATE_NAME}`);
  console.log(`📊 Google Sheets: ${SPREADSHEET_ID ? SPREADSHEET_ID : '❌ не задан'}`);
});
