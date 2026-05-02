const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN            = process.env.WHATSAPP_TOKEN;
const PHONE_ID         = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN     || 'smartclub2024';
const TEMPLATE_NAME    = process.env.TEMPLATE_NAME    || 'smartclub_quiz';
const SPREADSHEET_ID   = process.env.SPREADSHEET_ID   || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

// ─── Словари ──────────────────────────────────────────────────────────────────
const GRADE_MAP   = { '1': 'g3', '2': 'g5', '3': 'g7', '4': 'g10' };
const GOAL_MAP    = { '1': 'nil', '2': 'rfmsh', '3': 'bil', '4': 'ent' };
const GRADE_LABEL = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' };
const GOAL_LABEL  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ' };

// ─── Состояние пользователей ──────────────────────────────────────────────────
// phone → { state, grade, goal, program, now }
// state: 'grade' | 'goal' | 'awaiting_flow' | 'name'
const userState = new Map();

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
    console.log('📊 Записано в таблицу:', row);
  } catch (e) {
    console.error('❌ Ошибка Google Sheets:', e.message);
  }
}

// ─── Отправка текстового сообщения ───────────────────────────────────────────
async function sendMessage(to, text) {
  try {
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
    });
    const result = await r.json();
    if (result.error) console.error('❌ sendMessage error:', result.error.message);
    else console.log(`📤 Сообщение → ${to}`);
  } catch (e) {
    console.error('❌ sendMessage exception:', e.message);
  }
}

// ─── Отправка шаблона с Flow (с данными о классе и цели) ─────────────────────
async function sendFlowTemplate(phone, gradeId, goalId) {
  try {
    const body = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: TEMPLATE_NAME,
        language: { code: 'en' },
        components: [{
          type: 'button',
          sub_type: 'flow',
          index: '0',
          parameters: [{
            type: 'action',
            action: {
              flow_token: phone,
              flow_action_payload: {
                data: {
                  client_grade: gradeId,
                  client_goal: goalId
                }
              }
            }
          }]
        }]
      }
    };
    const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
      body: JSON.stringify(body)
    });
    const result = await r.json();
    if (result.error) console.error('❌ sendFlowTemplate error:', result.error.message);
    else console.log(`📨 Шаблон → ${phone} | grade=${gradeId} goal=${goalId}`);
  } catch (e) {
    console.error('❌ sendFlowTemplate exception:', e.message);
  }
}

// ─── Верификация webhook ───────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook верифицирован');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ─── Основной webhook ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;
    const st    = userState.get(phone) || { state: 'new' };
    console.log(`📩 ${phone} | type=${msg.type} | state=${st.state}`);

    // ── nfm_reply: пользователь нажал «Записаться» во флоу ───────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      console.log('🔔 nfm_reply:', JSON.stringify(msg.interactive.nfm_reply));

      let fd = {};
      try {
        const raw = msg.interactive.nfm_reply?.response_json;
        fd = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch (e) {}

      // program всегда статический — всегда приходит
      const program   = fd.program || st.goal || '—';
      const progLabel = GOAL_LABEL[program] || program.toUpperCase();
      const gradeLabel = GRADE_LABEL[st.grade] || st.grade || '—';
      const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      userState.set(phone, { ...st, state: 'name', program, now });

      await sendMessage(phone,
        `Отлично! Вы выбрали программу *${progLabel}* (${gradeLabel}) 🎓\n\n` +
        `Как вас зовут? Напишите имя в ответ на это сообщение.`
      );
      return;
    }

    // ── Текстовое сообщение ───────────────────────────────────────────────────
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();

      // Новый пользователь — спрашиваем класс
      if (st.state === 'new') {
        userState.set(phone, { state: 'grade' });
        await sendMessage(phone,
          '👋 Привет! SmartClub — подготовка к поступлению в НИШ, РФМШ, БИЛ и к ЕНТ.\n\n' +
          '*В каком классе ваш ребёнок?*\n\n' +
          '1️⃣  3–4 класс\n' +
          '2️⃣  5–6 класс\n' +
          '3️⃣  7–9 класс\n' +
          '4️⃣  10–11 класс\n\n' +
          'Ответьте цифрой 1, 2, 3 или 4'
        );

      // Ждём класс
      } else if (st.state === 'grade') {
        const gradeId = GRADE_MAP[text];
        if (!gradeId) {
          await sendMessage(phone, '⚠️ Пожалуйста, ответьте цифрой 1, 2, 3 или 4');
        } else {
          userState.set(phone, { ...st, state: 'goal', grade: gradeId });
          await sendMessage(phone,
            `${GRADE_LABEL[gradeId]} ✅\n\n` +
            '*Какая цель поступления?*\n\n' +
            '1️⃣  НИШ — Назарбаев Интеллектуальные Школы\n' +
            '2️⃣  РФМШ — Республиканская физмат школа\n' +
            '3️⃣  БИЛ — Bilim Innovation Lyceum\n' +
            '4️⃣  ЕНТ — Единое национальное тестирование\n\n' +
            'Ответьте цифрой 1, 2, 3 или 4'
          );
        }

      // Ждём цель
      } else if (st.state === 'goal') {
        const goalId = GOAL_MAP[text];
        if (!goalId) {
          await sendMessage(phone, '⚠️ Пожалуйста, ответьте цифрой 1, 2, 3 или 4');
        } else {
          userState.set(phone, { ...st, state: 'awaiting_flow', goal: goalId });
          // Отправляем шаблон с флоу — флоу откроется на правильном экране
          await sendFlowTemplate(phone, st.grade, goalId);
          await sendMessage(phone,
            `${GOAL_LABEL[goalId]} · ${GRADE_LABEL[st.grade]} 📚\n\n` +
            `Откройте карточку выше — там подробнее о программе и тарифах.\n` +
            `Нажмите *«Записаться на пробный урок»* чтобы оставить заявку.`
          );
        }

      // Ждём имя (после нажатия «Записаться» во флоу)
      } else if (st.state === 'name') {
        const { grade, program, now } = st;
        userState.delete(phone);

        const name       = text;
        const gradeLabel = GRADE_LABEL[grade] || grade || '—';
        const progLabel  = GOAL_LABEL[program] || program || '—';
        const row = [now, name, phone, gradeLabel, progLabel, 'Новая заявка'];

        console.log(`✅ ЗАЯВКА: ${name} | ${phone} | ${gradeLabel} | ${progLabel}`);
        await appendToSheet(row);

        await sendMessage(phone,
          `Спасибо, *${name}*! 🎉\n\n` +
          `Менеджер свяжется с вами в течение 30 минут и согласует время пробного урока.\n\n` +
          `📍 Алматы, ул. Байзакова 280\n` +
          `📞 +7 (707) 900-30-11`
        );

      // Ждём пока пользователь откроет флоу
      } else if (st.state === 'awaiting_flow') {
        await sendMessage(phone, '👆 Откройте карточку выше, посмотрите программу и нажмите «Записаться».');
      }
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
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
