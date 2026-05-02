const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN          = process.env.WHATSAPP_TOKEN;
const PHONE_ID       = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN || 'smartclub2024';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS   = process.env.GOOGLE_CREDENTIALS || '';

// ─── Справочники ──────────────────────────────────────────────────────────────
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
  ent:   'ЕНТ',
  combo: 'НИШ + РФМШ + КТЛ'
};

const PROGRAM_TEXT = {
  nil: [
    '🏆 *НИШ — Назарбаев Интеллектуальные Школы*',
    '',
    'Каждый второй наш ученик поступает в НИШ — даже ударники!',
    '',
    '📌 *Грант = питание + учебники + проживание бесплатно*',
    'Конкурс до 15 человек на место.',
    '',
    '✅ Преподаватели из НИШ — знают формат изнутри',
    '✅ Реальные тесты прошлых лет',
    '✅ Маленькие группы — каждый под контролем',
    '✅ Еженедельный отчёт для родителей',
    '',
    '💳 1 мес — скидка 10% + 1 урок вокала 🎵',
    '💳 3 мес — скидка 20% + 2 урока вокала 🎵',
    '💳 6 мес — 1 месяц в подарок 🎁',
    '💳 Kaspi рассрочка 0-0-24 ✓',
    '',
    '📍 Астана, Первая линия, офис «Каhармандар»'
  ].join('\n'),

  rfmsh: [
    '🏆 *РФМШ — Республиканская физмат школа*',
    '',
    'Каждый второй наш ученик поступает в РФМШ!',
    '',
    'Большинство не поступают не из-за таланта — из-за неправильной подготовки.',
    'У нас работают учителя из РФМШ — знают формат изнутри.',
    '',
    '✅ Углублённая математика и физика с нуля',
    '✅ Олимпиадные задачи — именно формат РФМШ',
    '✅ Разбор ошибок после каждого теста',
    '✅ Еженедельный отчёт для родителей',
    '',
    '💳 1 мес — скидка 10% + 1 урок вокала 🎵',
    '💳 3 мес — скидка 20% + 2 урока вокала 🎵',
    '💳 6 мес — 1 месяц в подарок 🎁',
    '💳 Kaspi рассрочка 0-0-24 ✓',
    '',
    '📍 Астана, Первая линия, офис «Каhармандар»'
  ].join('\n'),

  bil: [
    '🏆 *БИЛ — Bilim Innovation Lyceum*',
    '',
    'Каждый второй наш ученик поступает в БИЛ с первого раза!',
    '',
    'Международная программа. 200+ наших учеников уже учатся в БИЛ.',
    '',
    '✅ Все предметы вступительного экзамена',
    '✅ Авторские материалы — актуальные форматы',
    '✅ Еженедельные пробные тесты',
    '✅ Маленькие группы — каждый под контролем',
    '✅ Еженедельный отчёт для родителей',
    '',
    '💳 1 мес — скидка 10% + 1 урок вокала 🎵',
    '💳 3 мес — скидка 20% + 2 урока вокала 🎵',
    '💳 6 мес — 1 месяц в подарок 🎁',
    '💳 Kaspi рассрочка 0-0-24 ✓',
    '',
    '📍 Астана, Первая линия, офис «Каhармандар»'
  ].join('\n'),

  ent: [
    '🏆 *Подготовка к ЕНТ*',
    '',
    'Средний прирост — *+28 баллов* за 3 месяца!',
    '',
    'Каждые 10 баллов — разница в грантах на миллионы.',
    'Все 5 предметов в одном месте.',
    '',
    '✅ Разбор ошибок индивидуально после теста',
    '✅ Прогноз итогового балла каждый месяц',
    '✅ Маленькие группы — каждый под контролем',
    '✅ Еженедельный отчёт для родителей',
    '',
    '💳 1 мес — скидка 10% + 1 урок вокала 🎵',
    '💳 3 мес — скидка 20% + 2 урока вокала 🎵',
    '💳 6 мес — 1 месяц в подарок 🎁',
    '💳 Kaspi рассрочка 0-0-24 ✓',
    '',
    '📍 Астана, Первая линия, офис «Каhармандар»'
  ].join('\n'),

  combo: [
    '🏆 *НИШ + РФМШ + КТЛ — Комбо*',
    '',
    'Три школы — один курс. Максимальные шансы!',
    '',
    'Единая база охватывает экзамены НИШ, РФМШ и КТЛ.',
    'Ваш ребёнок готов к любому из них — и выбирает лучший результат.',
    '',
    '✅ Преподаватели из НИШ, РФМШ и КТЛ',
    '✅ Реальные тесты всех трёх экзаменов',
    '✅ Диагностика по всем направлениям при записи',
    '✅ Маленькие группы — каждый под контролем',
    '✅ Еженедельный отчёт для родителей',
    '',
    '💳 1 мес — скидка 10% + 1 урок вокала 🎵',
    '💳 3 мес — скидка 20% + 2 урока вокала 🎵',
    '💳 6 мес — 1 месяц в подарок 🎁',
    '💳 Kaspi рассрочка 0-0-24 ✓',
    '',
    '📍 Астана, Первая линия, офис «Каhармандар»'
  ].join('\n')
};

// ─── Состояние пользователей ──────────────────────────────────────────────────
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
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
    body: JSON.stringify(body)
  });
  const res = await r.json();
  if (res.error) console.error('❌ WA:', res.error.message);
  return res;
}

async function sendText(to, text) {
  await waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

// ─── Выбор класса ─────────────────────────────────────────────────────────────
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
        sections: [{
          title: 'Класс',
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

// ─── Выбор цели ───────────────────────────────────────────────────────────────
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
        sections: [{
          title: 'Цель',
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

// ─── Карточка программы + отдельная кнопка ───────────────────────────────────
async function sendProgram(to, goalId, gradeLabel) {
  // Шаг 1: текст программы (без лимита)
  const text = PROGRAM_TEXT[goalId] || PROGRAM_TEXT['nil'];
  await sendText(to, `🎯 *Программа для ${gradeLabel}*\n\n${text}`);

  // Шаг 2: кнопка записи (отдельное сообщение — лимит 1024 символа обходится)
  await waPost({
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body:   { text: '👇 Нажмите, чтобы записаться на *бесплатный пробный урок*' },
      footer: { text: 'Первый урок и диагностика — бесплатно' },
      action: {
        buttons: [{
          type: 'reply',
          reply: { id: 'signup', title: '✅ Записаться бесплатно' }
        }]
      }
    }
  });
}

// ─── Верификация webhook ──────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    console.log('✅ Webhook верифицирован');
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

// ─── Webhook ──────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;

    const phone = msg.from;
    const st    = userState.get(phone) || { state: 'new' };
    console.log(`📩 ${phone} | type=${msg.type} | state=${st.state}`);

    // ── Кнопка "Записаться" ───────────────────────────────────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'button_reply') {
      const btnId = msg.interactive.button_reply?.id;
      if (btnId === 'signup') {
        const goalLabel  = GOAL_LABEL[st.goal]   || '—';
        const gradeLabel = GRADE_LABEL[st.grade] || '—';
        userState.set(phone, { ...st, state: 'name' });
        await sendText(phone,
          `🎉 Отличный выбор!\n\n` +
          `Программа: *${goalLabel}* · ${gradeLabel}\n\n` +
          `Осталось совсем чуть-чуть 👇\n\n` +
          `Напишите, пожалуйста, *как зовут вашего ребёнка?*`
        );
      }
      return;
    }

    // ── Выбор из списка ───────────────────────────────────────────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'list_reply') {
      const id    = msg.interactive.list_reply?.id    || '';
      const title = msg.interactive.list_reply?.title || '';

      if (st.state === 'grade') {
        userState.set(phone, { ...st, state: 'goal', grade: id });
        await sendGoalList(phone, GRADE_LABEL[id] || title);

      } else if (st.state === 'goal') {
        const gradeLabel = GRADE_LABEL[st.grade] || '—';
        userState.set(phone, { ...st, state: 'awaiting_signup', goal: id });
        await sendProgram(phone, id, gradeLabel);

      } else {
        // Любое другое состояние — перезапуск
        userState.set(phone, { state: 'grade' });
        await sendText(phone, `👋 Добро пожаловать в *SmartClub*!\n\nКаждый второй наш ученик поступает в НИШ, РФМШ или БИЛ 🏆\n\nПодберём программу для вашего ребёнка:`);
        await sendGradeList(phone);
      }
      return;
    }

    // ── Текстовое сообщение ───────────────────────────────────────────────────
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();

      if (st.state === 'name') {
        // Сохраняем заявку
        const now        = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
        const gradeLabel = GRADE_LABEL[st.grade] || st.grade || '—';
        const goalLabel  = GOAL_LABEL[st.goal]   || st.goal  || '—';
        const row = [now, text, phone, gradeLabel, goalLabel, 'Новая заявка'];

        userState.delete(phone);
        console.log(`✅ ЗАЯВКА: ${text} | ${phone} | ${gradeLabel} | ${goalLabel}`);
        await appendToSheet(row);

        // Сообщение 1: подтверждение заявки
        await sendText(phone,
          `✅ *${text}*, заявка принята!\n\n` +
          `Программа: *${goalLabel}* · ${gradeLabel}\n\n` +
          `Наш менеджер свяжется с вами *в течение 15 минут* и согласует удобное время.`
        );

        // Сообщение 2: что ждёт на пробном уроке
        await sendText(phone,
          `🎁 *Что вас ждёт на первом визите:*\n\n` +
          `📝 Пробный урок — *бесплатно*\n` +
          `🔍 Диагностика знаний от эксперта — *бесплатно*\n` +
          `📊 Личный план подготовки с прогнозом результата\n` +
          `👨‍🏫 Знакомство с преподавателем и группой\n\n` +
          `Всё это без обязательств — просто приходите и убедитесь сами 💪`
        );

        // Сообщение 3: адрес и ссылка
        await sendText(phone,
          `📍 *Как нас найти:*\n\n` +
          `Астана, Первая линия, офис «Каhармандар»\n` +
          `🗺 https://2gis.kz/astana/geo/70000001102430714\n\n` +
          `🕐 Пн–Сб · 09:00–20:00\n\n` +
          `Ждём вас! 🌟`
        );

      } else if (st.state === 'awaiting_signup') {
        await sendText(phone, `⬆️ Нажмите кнопку *«Записаться бесплатно»* в карточке выше 👆`);

      } else {
        // Любое сообщение — начинаем диалог
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

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Bot запущен на порту ${PORT}`);
  console.log(`🔑 Token:     ${TOKEN    ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID:  ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📊 Sheets ID: ${SPREADSHEET_ID || '❌ не задан'}`);
});
