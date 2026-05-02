const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN          = process.env.WHATSAPP_TOKEN;
const PHONE_ID       = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN  || 'smartclub2024';
const TEMPLATE_NAME  = process.env.TEMPLATE_NAME || 'smartclub_quiz';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS   = process.env.GOOGLE_CREDENTIALS || '';

const GRADE_LABEL = { g3: '3–4 класс', g5: '5–6 класс', g7: '7–9 класс', g10: '10–11 класс' };
const GOAL_LABEL  = { nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', ent: 'ЕНТ', combo: 'НИШ + РФМШ + КТЛ' };

const userState = new Map();

// ─── Google Sheets ────────────────────────────────────────────────────────────
async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS) return;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(GOOGLE_CREDS),
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

// ─── WA API ───────────────────────────────────────────────────────────────────
async function waPost(body) {
  const r = await fetch(`https://graph.facebook.com/v19.0/${PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  const res = await r.json();
  if (res.error) console.error('❌ WA:', res.error.message);
  return res;
}

async function sendText(to, text) {
  await waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

// ─── Список классов ───────────────────────────────────────────────────────────
async function sendGradeList(to) {
  await waPost({
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: '📚 Шаг 1 из 2' },
      body:   { text: 'В каком классе учится ваш ребёнок?' },
      footer: { text: 'SmartClub · Астана' },
      action: {
        button: 'Выбрать класс',
        sections: [{ title: 'Класс', rows: [
          { id: 'g3',  title: '3–4 класс',   description: 'Начало подготовки'      },
          { id: 'g5',  title: '5–6 класс',   description: 'Углублённая программа'  },
          { id: 'g7',  title: '7–9 класс',   description: 'Интенсивная подготовка' },
          { id: 'g10', title: '10–11 класс', description: 'Финальный этап'          }
        ]}]
      }
    }
  });
}

// ─── Список целей ─────────────────────────────────────────────────────────────
async function sendGoalList(to, gradeLabel) {
  await waPost({
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: `📚 Шаг 2 из 2 · ${gradeLabel}` },
      body:   { text: 'Отлично! Выберите цель поступления:' },
      footer: { text: 'SmartClub · Астана' },
      action: {
        button: 'Выбрать цель',
        sections: [{ title: 'Цель', rows: [
          { id: 'nil',   title: 'НИШ',           description: 'Назарбаев Интеллектуальные Школы' },
          { id: 'rfmsh', title: 'РФМШ',          description: 'Республиканская физмат школа'      },
          { id: 'bil',   title: 'БИЛ',           description: 'Bilim Innovation Lyceum'           },
          { id: 'ent',   title: 'ЕНТ',           description: 'Единое национальное тестирование'  },
          { id: 'combo', title: 'НИШ+РФМШ+КТЛ', description: 'Подготовка к трём школам сразу'    }
        ]}]
      }
    }
  });
}

// ─── Шаблон с флоу ───────────────────────────────────────────────────────────
// flow_token = "phone|grade|goal" — флоу-сервер читает grade/goal из токена
async function sendFlowTemplate(to, gradeId, goalId) {
  const flowToken = `${to}|${gradeId}|${goalId}`;
  const result = await waPost({
    messaging_product: 'whatsapp', to,
    type: 'template',
    template: {
      name: TEMPLATE_NAME,
      language: { code: 'ru' },
      components: [{
        type: 'button', sub_type: 'flow', index: '0',
        parameters: [{ type: 'action', action: { flow_token: flowToken } }]
      }]
    }
  });
  console.log(`📨 flow template → ${to} | token=${flowToken}`);
  return result;
}

// ─── Верификация webhook ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
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
      const token  = msg.interactive.nfm_reply?.flow_token || '';
      const parts  = token.split('|');
      const grade  = parts[1] || st.grade || '';
      const goal   = parts[2] || st.goal  || '';
      const now    = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      userState.set(phone, { ...st, state: 'name', grade, goal, now });

      await sendText(phone,
        `🎉 Отличный выбор!\n\n` +
        `Программа: *${GOAL_LABEL[goal] || goal}* · ${GRADE_LABEL[grade] || grade}\n\n` +
        `Последний шаг — напишите, пожалуйста, *как зовут вашего ребёнка* 👇`
      );
      return;
    }

    // ── list_reply: выбор из списка ───────────────────────────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
      const id    = msg.interactive.list_reply?.id    || '';
      const title = msg.interactive.list_reply?.title || '';

      if (st.state === 'grade') {
        userState.set(phone, { ...st, state: 'goal', grade: id });
        await sendGoalList(phone, GRADE_LABEL[id] || title);

      } else if (st.state === 'goal') {
        userState.set(phone, { ...st, state: 'awaiting_flow', goal: id });
        const result = await sendFlowTemplate(phone, st.grade, id);
        if (!result?.messages?.[0]?.id) {
          userState.delete(phone);
          await sendText(phone, '⚠️ Что-то пошло не так. Напишите нам снова.');
        }

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone, `⬆️ Карточка с программой уже отправлена выше.\n\nОткройте её и нажмите *«Записаться на пробный урок»* 👆`);

      } else {
        userState.set(phone, { state: 'grade' });
        await sendText(phone,
          `👋 Добро пожаловать в *SmartClub*!\n\n` +
          `*Каждый второй наш ученик поступает в НИШ, РФМШ или БИЛ* 🏆\n\n` +
          `Подберём программу для вашего ребёнка — 30 секунд 👇`
        );
        await sendGradeList(phone);
      }
      return;
    }

    // ── Текстовое сообщение ───────────────────────────────────────────────────
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();

      if (st.state === 'name') {
        const { grade, goal, now } = st;
        userState.delete(phone);

        const gradeLabel = GRADE_LABEL[grade] || grade || '—';
        const goalLabel  = GOAL_LABEL[goal]   || goal  || '—';
        const row = [now, text, phone, gradeLabel, goalLabel, 'Новая заявка'];

        console.log(`✅ ЗАЯВКА: ${text} | ${phone} | ${gradeLabel} | ${goalLabel}`);
        await appendToSheet(row);

        await sendText(phone,
          `✅ *${text}*, заявка принята!\n\n` +
          `Программа: *${goalLabel}* · ${gradeLabel}\n\n` +
          `Наш менеджер позвонит вам *в течение 15 минут* и запишет на пробный урок.`
        );

        await sendText(phone,
          `🎁 *Что вас ждёт:*\n\n` +
          `• Пробный урок — *бесплатно*\n` +
          `• Диагностика знаний от эксперта — *бесплатно*\n` +
          `• Личный план подготовки с прогнозом результата\n\n` +
          `📍 Астана, Первая линия, офис «Каhармандар»\n` +
          `🗺 https://2gis.kz/astana/geo/70000001102430714\n` +
          `🕐 Пн–Сб · 09:00–20:00`
        );

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone, `⬆️ Карточка с программой уже отправлена выше.\n\nОткройте её и нажмите *«Записаться на пробный урок»* 👆`);

      } else {
        userState.set(phone, { state: 'grade' });
        await sendText(phone,
          `👋 Добро пожаловать в *SmartClub*!\n\n` +
          `Пока другие школы обещают — мы гарантируем результат:\n` +
          `*каждый второй наш ученик поступает в НИШ, РФМШ или БИЛ* 🏆\n\n` +
          `Подберём программу для вашего ребёнка — это займёт 30 секунд 👇`
        );
        await sendGradeList(phone);
      }
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot запущен на порту ${PORT}`);
  console.log(`🔑 Token:    ${TOKEN    ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон:   ${TEMPLATE_NAME}`);
});
