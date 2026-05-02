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
const GOAL_LABEL  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ', combo: 'НИШ + РФМШ + КТЛ' };

// ─── Состояние пользователей ──────────────────────────────────────────────────
const userState = new Map();

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS_RAW) return;
  try {
    const creds = JSON.parse(GOOGLE_CREDS_RAW);
    const auth  = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
    console.log('📊 Записано в таблицу:', row);
  } catch (e) {
    console.error('❌ Sheets:', e.message);
  }
}

// ─── WA API helper ────────────────────────────────────────────────────────────
async function waPost(body) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  const result = await r.json();
  if (result.error) console.error('❌ WA API:', result.error.message);
  return result;
}

async function sendText(to, text) {
  await waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
  console.log(`📤 text → ${to}`);
}

// ─── Приветствие + выбор класса ───────────────────────────────────────────────
async function sendWelcome(to) {
  await sendText(to,
    `👋 Добро пожаловать в *SmartClub*!\n\n` +
    `Пока другие школы обещают — мы гарантируем результат:\n` +
    `*каждый второй наш ученик поступает в НИШ, РФМШ или БИЛ* 🏆\n\n` +
    `Грант в НИШ — это питание, учебники и проживание *бесплатно*.\n` +
    `Конкурс до 15 человек на место — но мы знаем, как туда попасть.\n\n` +
    `Подберём программу для вашего ребёнка — это займёт 30 секунд 👇`
  );
  await sendGradeList(to);
}

// ─── Список выбора класса ─────────────────────────────────────────────────────
async function sendGradeList(to) {
  await waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '📚 Шаг 1 из 2' },
      body:   { text: 'В каком классе учится ваш ребёнок?' },
      footer: { text: 'SmartClub · Астана' },
      action: {
        button: 'Выбрать класс',
        sections: [{
          title: 'Класс ребёнка',
          rows: [
            { id: 'g3',  title: '3–4 класс',   description: 'Начало подготовки' },
            { id: 'g5',  title: '5–6 класс',   description: 'Углублённая программа' },
            { id: 'g7',  title: '7–9 класс',   description: 'Интенсивная подготовка' },
            { id: 'g10', title: '10–11 класс', description: 'Финальный этап' }
          ]
        }]
      }
    }
  });
}

// ─── Список выбора цели ───────────────────────────────────────────────────────
async function sendGoalList(to, gradeLabel) {
  await waPost({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: `📚 Шаг 2 из 2 · ${gradeLabel}` },
      body:   { text: 'Отлично! Теперь выберите цель поступления:' },
      footer: { text: 'SmartClub · Астана' },
      action: {
        button: 'Выбрать цель',
        sections: [{
          title: 'Цель поступления',
          rows: [
            { id: 'nil',   title: 'НИШ',           description: 'Назарбаев Интеллектуальные Школы' },
            { id: 'rfmsh', title: 'РФМШ',          description: 'Республиканская физмат школа'      },
            { id: 'bil',   title: 'БИЛ',           description: 'Bilim Innovation Lyceum'           },
            { id: 'ent',   title: 'ЕНТ',           description: 'Единое национальное тестирование'  },
            { id: 'combo', title: 'НИШ+РФМШ+КТЛ', description: 'Подготовка к трём школам сразу'    }
          ]
        }]
      }
    }
  });
}

// ─── Шаблон с флоу ───────────────────────────────────────────────────────────
// flow_token = "phone|grade|goal" — используется для маршрутизации на сервере
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
          action: { flow_token: flowToken }
        }]
      }]
    }
  });
  console.log(`📨 flow template → ${phone} | token=${flowToken}`);
  return result;
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
    console.log(`📩 ${phone} | type=${msg.type} | interactive_type=${msg.interactive?.type || '-'} | state=${st.state}`);

    // ── nfm_reply: пользователь нажал «Записаться» во флоу ───────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      console.log('🔔 nfm_reply:', JSON.stringify(msg.interactive.nfm_reply));

      let fd = {};
      try {
        const raw = msg.interactive.nfm_reply?.response_json;
        fd = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
      } catch (e) {}

      // Расшифровываем flow_token: "phone|grade|goal"
      const token    = fd.flow_token || '';
      const parts    = token.split('|');
      const gradeId  = parts[1] || st.grade || '';
      const goalId   = parts[2] || st.goal  || fd.program || '';

      const gradeLabel = GRADE_LABEL[gradeId] || '—';
      const goalLabel  = GOAL_LABEL[goalId]   || '—';
      const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      userState.set(phone, { ...st, state: 'name', grade: gradeId, goal: goalId, now });

      await sendText(phone,
        `🎉 Отличный выбор!\n\n` +
        `Программа: *${goalLabel}* · ${gradeLabel}\n\n` +
        `Последний шаг — напишите, как зовут вашего ребёнка 👇`
      );
      return;
    }

    // ── list_reply: выбор из списка ───────────────────────────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
      const id    = msg.interactive.list_reply?.id    || '';
      const title = msg.interactive.list_reply?.title || '';
      console.log(`📌 list_reply: id="${id}" title="${title}"`);

      if (st.state === 'grade') {
        userState.set(phone, { ...st, state: 'goal', grade: id });
        await sendGoalList(phone, GRADE_LABEL[id] || title);

      } else if (st.state === 'goal') {
        userState.set(phone, { ...st, state: 'awaiting_flow', goal: id });

        const result = await sendFlowTemplate(phone, st.grade, id);

        if (!result?.messages?.[0]?.id) {
          // Шаблон не отправился — сброс
          userState.delete(phone);
          await sendText(phone, '⚠️ Что-то пошло не так. Напишите нам снова — мы всё исправим.');
        }

      } else if (st.state === 'awaiting_flow') {
        // Пользователь нажал на список пока ждём флоу — напоминаем
        await sendText(phone,
          `⬆️ Карточка с программой уже отправлена выше.\n\n` +
          `Откройте её и нажмите *«Записаться на пробный урок»* 👆`
        );

      } else {
        // Неожиданный list_reply в другом состоянии — начинаем сначала
        userState.set(phone, { state: 'grade' });
        await sendWelcome(phone);
      }
      return;
    }

    // ── Текстовое сообщение ───────────────────────────────────────────────────
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();

      if (st.state === 'name') {
        // Получили имя — сохраняем в Sheets
        const { grade, goal, now } = st;
        userState.delete(phone);

        const gradeLabel = GRADE_LABEL[grade] || grade || '—';
        const goalLabel  = GOAL_LABEL[goal]   || goal  || '—';
        const row = [now, text, phone, gradeLabel, goalLabel, 'Новая заявка'];

        console.log(`✅ ЗАЯВКА: ${text} | ${phone} | ${gradeLabel} | ${goalLabel}`);
        await appendToSheet(row);

        await sendText(phone,
          `✅ *${text}*, заявка принята!\n\n` +
          `Наш менеджер позвонит вам *в течение 15 минут* и запишет на первый урок.\n\n` +
          `🎁 Первый урок — *бесплатно*\n` +
          `🎁 Диагностика знаний от эксперта — *в подарок*\n\n` +
          `─────────────────\n` +
          `📍 Астана, Первая линия, офис «Каhармандар»\n` +
          `🗺 https://2gis.kz/astana/geo/70000001102430714\n` +
          `🕐 Пн–Сб · 09:00–20:00`
        );

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone,
          `⬆️ Карточка с программой уже отправлена выше.\n\n` +
          `Откройте её и нажмите *«Записаться на пробный урок»* 👆`
        );

      } else {
        // Любое другое сообщение — начинаем сначала
        userState.set(phone, { state: 'grade' });
        await sendWelcome(phone);
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
