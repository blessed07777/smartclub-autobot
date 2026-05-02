const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN            = process.env.WHATSAPP_TOKEN;
const PHONE_ID         = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN     = process.env.VERIFY_TOKEN   || 'smartclub2024';
const TEMPLATE_NAME    = process.env.TEMPLATE_NAME  || 'smartclub_quiz';
const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS_RAW = process.env.GOOGLE_CREDENTIALS || '';

// ─── Справочники ──────────────────────────────────────────────────────────────
const GRADE_LABEL = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' };
const GOAL_LABEL  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ' };

// ─── Состояние пользователей ──────────────────────────────────────────────────
// phone → { state, grade, goal, now }
// state: 'grade' | 'goal' | 'awaiting_flow' | 'name'
const userState = new Map();

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS_RAW) {
    console.log('[Sheets] переменные не заданы');
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
    console.log('📊 Записано:', row);
  } catch (e) {
    console.error('❌ Sheets:', e.message);
  }
}

// ─── Базовый fetch helper ─────────────────────────────────────────────────────
async function waPost(body) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  });
  const result = await r.json();
  if (result.error) console.error('❌ WA API:', result.error.message);
  return result;
}

// ─── Отправка обычного текста ─────────────────────────────────────────────────
async function sendText(to, text) {
  await waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
  console.log(`📤 text → ${to}`);
}

// ─── Список выбора класса (List Message) ─────────────────────────────────────
async function sendGradeList(to) {
  await waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: 'SmartClub' },
      body:   { text: 'В каком классе ваш ребёнок? Выберите из списка 👇' },
      footer: { text: 'SmartClub · Алматы' },
      action: {
        button: 'Выбрать класс',
        sections: [{
          title: 'Класс ребёнка',
          rows: [
            { id: 'g3',  title: '3–4 класс'   },
            { id: 'g5',  title: '5–6 класс'   },
            { id: 'g7',  title: '7–9 класс'   },
            { id: 'g10', title: '10–11 класс'  }
          ]
        }]
      }
    }
  });
  console.log(`📋 grade list → ${to}`);
}

// ─── Список выбора цели (List Message) ───────────────────────────────────────
async function sendGoalList(to, gradLabel) {
  await waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: gradLabel },
      body:   { text: 'Отлично! Теперь выберите цель поступления 👇' },
      footer: { text: 'SmartClub · Алматы' },
      action: {
        button: 'Выбрать цель',
        sections: [{
          title: 'Цель',
          rows: [
            { id: 'nil',   title: 'НИШ',  description: 'Назарбаев Интеллектуальные Школы' },
            { id: 'rfmsh', title: 'РФМШ', description: 'Республиканская физмат школа'      },
            { id: 'bil',   title: 'БИЛ',  description: 'Bilim Innovation Lyceum'           },
            { id: 'ent',   title: 'ЕНТ',  description: 'Единое национальное тестирование'  }
          ]
        }]
      }
    }
  });
  console.log(`📋 goal list → ${to}`);
}

// ─── Отправка шаблона с Flow ──────────────────────────────────────────────────
// flow_token кодирует: phone|grade|goal  →  расшифровывается в nfm_reply
async function sendFlowTemplate(phone, gradeId, goalId) {
  const flowToken = `${phone}|${gradeId}|${goalId}`;
  const result = await waPost({
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
            flow_token: flowToken,
            // Передаём grade+goal на flow-сервер — он откроет правильный экран
            flow_action_payload: {
              data: {
                client_grade: gradeId,
                client_goal:  goalId
              }
            }
          }
        }]
      }]
    }
  });
  console.log(`📨 flow template → ${phone} | token=${flowToken}`);
  return result;
}

// ─── Верификация webhook ───────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (
    req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === VERIFY_TOKEN
  ) {
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
    console.log(`📩 ${phone} | type=${msg.type} | interactive_type=${msg.interactive?.type || '-'} | state=${st.state}`);

    // ── 1. nfm_reply: пользователь нажал «Записаться» во флоу ────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      console.log('🔔 nfm_reply raw:', JSON.stringify(msg.interactive.nfm_reply));

      // Парсим response_json (program — статический, всегда приходит)
      let fd = {};
      try {
        const raw = msg.interactive.nfm_reply?.response_json;
        fd = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch (e) {}

      // Расшифровываем flow_token: "phone|grade|goal"
      const token = fd.flow_token || '';
      const parts = token.split('|');
      const gradeId = parts[1] || st.grade || '';
      const goalId  = parts[2] || st.goal  || fd.program || '';

      const gradeLabel = GRADE_LABEL[gradeId] || gradeId || '—';
      const goalLabel  = GOAL_LABEL[goalId]   || goalId  || '—';
      const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      console.log(`🎯 Из flow_token: grade=${gradeId} goal=${goalId}`);

      userState.set(phone, { ...st, state: 'name', grade: gradeId, goal: goalId, now });

      await sendText(phone,
        `Отлично! Вы выбрали *${goalLabel}* · ${gradeLabel} 🎓\n\n` +
        `Как вас зовут? Напишите имя — и мы сохраним заявку.`
      );
      return;
    }

    // ── 2. list_reply: пользователь выбрал из списка ─────────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
      const id    = msg.interactive.list_reply?.id    || '';
      const title = msg.interactive.list_reply?.title || '';
      console.log(`📌 list_reply: id="${id}" title="${title}"`);

      if (st.state === 'grade') {
        // Выбрали класс → спрашиваем цель
        userState.set(phone, { ...st, state: 'goal', grade: id });
        await sendGoalList(phone, GRADE_LABEL[id] || title);

      } else if (st.state === 'goal') {
        // Выбрали цель → отправляем флоу с нужным экраном
        userState.set(phone, { ...st, state: 'awaiting_flow', goal: id });
        await sendFlowTemplate(phone, st.grade, id);
        await sendText(phone,
          `${GOAL_LABEL[id]} · ${GRADE_LABEL[st.grade]} 📚\n\n` +
          `Откройте карточку выше — там программа и тарифы.\n` +
          `Нажмите *«Записаться на пробный урок»* чтобы оставить заявку.`
        );
      }
      return;
    }

    // ── 3. Текстовое сообщение ────────────────────────────────────────────────
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();

      if (st.state === 'name') {
        // Получили имя — сохраняем всё в Sheets
        const { grade, goal, now } = st;
        userState.delete(phone);

        const gradeLabel = GRADE_LABEL[grade] || grade || '—';
        const goalLabel  = GOAL_LABEL[goal]   || goal  || '—';
        const row = [now, text, phone, gradeLabel, goalLabel, 'Новая заявка'];

        console.log(`✅ ЗАЯВКА: ${text} | ${phone} | ${gradeLabel} | ${goalLabel}`);
        await appendToSheet(row);

        await sendText(phone,
          `Спасибо, *${text}*! 🎉\n\n` +
          `Менеджер свяжется с вами в течение 30 минут.\n\n` +
          `📍 Алматы, ул. Байзакова 280\n` +
          `📞 +7 (707) 900-30-11`
        );

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone, '👆 Откройте карточку выше, посмотрите программу и нажмите «Записаться».');

      } else {
        // Любое первое сообщение → начинаем квиз
        userState.set(phone, { state: 'grade' });
        await sendText(phone,
          '👋 Привет! SmartClub — подготовка к поступлению в НИШ, РФМШ, БИЛ и к ЕНТ.\n\n' +
          'Наши ученики поступают с первого раза. Подберём программу за 30 секунд 👇'
        );
        await sendGradeList(phone);
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
  console.log(`🔑 Token:     ${TOKEN      ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID:  ${PHONE_ID   || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон:    ${TEMPLATE_NAME}`);
  console.log(`📊 Sheets ID: ${SPREADSHEET_ID || '❌ не задан'}`);
});
