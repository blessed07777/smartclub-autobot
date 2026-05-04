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

// ─── Справочники ──────────────────────────────────────────────────────────────
const GRADE_LABEL = {
  g3:  '3–4 класс',
  g5:  '5–6 класс',
  g7:  '7–8 класс',
  g9:  '9 класс',
  g10: '10–11 класс'
};

const GOAL_LABEL = {
  nil:      'НИШ',
  rfmsh:    'РФМШ',
  bil:      'БИЛ',
  combo:    'НИШ + РФМШ + КТЛ',
  ent:      'ЕНТ',
  basics:   'Основные предметы',
  govexam:  'Гос. экзамены (9 класс)',
  ent_tech: 'ЕНТ — Техническое',
  ent_bio:  'ЕНТ — Биологическое',
  primary:  'Начальная школа'
};

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
      header: { type: 'text', text: '📚 Шаг 1 из 2 — Класс' },
      body:   { text: 'В каком классе учится ваш ребёнок?' },
      footer: { text: 'SmartClub · Астана · рус / каз' },
      action: {
        button: 'Выбрать класс',
        sections: [{ title: 'Класс ребёнка', rows: [
          { id: 'g3',  title: '3–4 класс',   description: 'Начальная школа — основы и логика' },
          { id: 'g5',  title: '5–6 класс',   description: 'Подготовка к НИШ, РФМШ, БИЛ'      },
          { id: 'g7',  title: '7–8 класс',   description: 'РФМШ, ЕНТ, основные предметы'     },
          { id: 'g9',  title: '9 класс',     description: 'ЕНТ, РФМШ, гос. экзамены'          },
          { id: 'g10', title: '10–11 класс', description: 'ЕНТ — техническое или биол.'       }
        ]}]
      }
    }
  });
}

// ─── Список целей (зависит от класса) ────────────────────────────────────────
async function sendGoalList(to, gradeId, gradeLabel) {
  let rows;

  if (gradeId === 'g3') {
    rows = [
      { id: 'primary', title: 'Школьная программа', description: 'Математика, логика, английский, русский' }
    ];
  } else if (gradeId === 'g5') {
    rows = [
      { id: 'nil',   title: 'НИШ',           description: 'Назарбаев Интеллектуальные Школы' },
      { id: 'rfmsh', title: 'РФМШ',          description: 'Республиканская физмат школа'      },
      { id: 'bil',   title: 'БИЛ',           description: 'Bilim Innovation Lyceum'           },
      { id: 'combo', title: 'НИШ + РФМШ + КТЛ', description: 'Три школы — максимальные шансы' }
    ];
  } else if (gradeId === 'g7') {
    rows = [
      { id: 'rfmsh',  title: 'РФМШ',                   description: 'Математика, логика, олимпиадные' },
      { id: 'ent',    title: 'ЕНТ',                    description: 'Ранняя подготовка к тестированию' },
      { id: 'basics', title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки'    }
    ];
  } else if (gradeId === 'g9') {
    rows = [
      { id: 'rfmsh',   title: 'РФМШ',                   description: 'Математика, логика, олимпиадные'   },
      { id: 'ent',     title: 'ЕНТ',                    description: 'Подготовка к единому тестированию' },
      { id: 'basics',  title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки'     },
      { id: 'govexam', title: 'Гос. экзамены',          description: 'Аттестация 9 класс: алгебра, геом.' }
    ];
  } else if (gradeId === 'g10') {
    rows = [
      { id: 'ent_tech', title: 'ЕНТ — Техническое',    description: 'Математика, физика, информатика'  },
      { id: 'ent_bio',  title: 'ЕНТ — Биологическое',  description: 'Биология, химия, география'        }
    ];
  } else {
    rows = [
      { id: 'nil', title: 'НИШ', description: 'Назарбаев Интеллектуальные Школы' }
    ];
  }

  await waPost({
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: `📚 Шаг 2 из 2 · ${gradeLabel}` },
      body:   { text: 'Отлично! Выберите цель подготовки:' },
      footer: { text: 'SmartClub · рус / каз направление' },
      action: {
        button: 'Выбрать цель',
        sections: [{ title: 'Цель подготовки', rows }]
      }
    }
  });
}

// ─── Интерактивное сообщение с флоу (не требует шаблона) ─────────────────────
async function sendFlowTemplate(to, gradeId, goalId) {
  const flowToken = `${to}|${gradeId}|${goalId}`;
  const FLOW_ID   = process.env.FLOW_ID || '806320295577232';
  const result = await waPost({
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: '🎯 SmartClub — ваша программа' },
      body:   { text: 'Мы подобрали программу специально для вашего ребёнка. Нажмите кнопку ниже, чтобы открыть её.' },
      footer: { text: 'SmartClub · Астана' },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_token: flowToken,
          flow_id: FLOW_ID,
          flow_cta: 'Открыть программу →',
          flow_action: 'data_exchange'
        }
      }
    }
  });
  console.log(`📨 flow interactive → ${to} | token=${flowToken}`);
  console.log(`📬 WA response:`, JSON.stringify(result));
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
      const token = msg.interactive.nfm_reply?.flow_token || '';
      const parts = token.split('|');
      const grade = parts[1] || st.grade || '';
      const goal  = parts[2] || st.goal  || '';
      const now   = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

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
        await sendGoalList(phone, id, GRADE_LABEL[id] || title);

      } else if (st.state === 'goal') {
        userState.set(phone, { ...st, state: 'awaiting_flow', goal: id });
        const result = await sendFlowTemplate(phone, st.grade, id);
        if (!result?.messages?.[0]?.id) {
          console.error('❌ Шаблон не отправлен:', JSON.stringify(result));
          userState.set(phone, { state: 'grade' });
          await sendText(phone, '⚠️ Не удалось открыть карточку программы. Попробуйте ещё раз 👇');
          await sendGradeList(phone);
        }

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone,
          `⬆️ Карточка с программой уже отправлена выше.\n\n` +
          `Откройте её и нажмите *«Записаться на пробный урок»* 👆`
        );

      } else {
        userState.set(phone, { state: 'grade' });
        await sendWelcome(phone);
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
          `🎁 *Что вас ждёт на первом визите:*\n\n` +
          `📝 Пробный урок — *бесплатно*\n` +
          `🔍 Диагностика знаний от эксперта — *бесплатно*\n` +
          `📊 Личный план подготовки с прогнозом результата\n` +
          `👨‍🏫 Знакомство с преподавателем и группой\n\n` +
          `Всё это без обязательств — приходите и убедитесь сами 💪`
        );

        await sendText(phone,
          `📍 *Как нас найти:*\n\n` +
          `Астана, Первая линия, *SmartClub*\n` +
          `🗺 https://2gis.kz/astana/geo/70000001102430714\n\n` +
          `🕐 Пн–Сб · 09:00–20:00\n\n` +
          `Ждём вас! 🌟`
        );

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone,
          `⬆️ Карточка с программой уже отправлена выше.\n\n` +
          `Откройте её и нажмите *«Записаться на пробный урок»* 👆`
        );

      } else {
        await sendWelcome(phone);
      }
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ─── Приветствие ─────────────────────────────────────────────────────────────
async function sendWelcome(phone) {
  userState.set(phone, { state: 'grade' });
  await sendText(phone,
    `👋 Добро пожаловать в *SmartClub*!\n\n` +
    `🏆 Каждый второй ученик поступает в *НИШ, РФМШ или БИЛ*\n` +
    `🎓 *90–100% выпускников получают грант в вуз*\n\n` +
    `Занятия ведутся на *русском и казахском* языке — подберём программу в любом направлении.\n\n` +
    `Всего 2 вопроса — и вы получите персональную программу для вашего ребёнка 👇`
  );
  await sendGradeList(phone);
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot запущен на порту ${PORT}`);
  console.log(`🔑 Token:    ${TOKEN    ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Шаблон:   ${TEMPLATE_NAME}`);
});
