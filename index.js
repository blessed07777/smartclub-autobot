const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN          = process.env.WHATSAPP_TOKEN;
const PHONE_ID       = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN    || 'smartclub2024';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS   = process.env.GOOGLE_CREDENTIALS || '';
const FLOW_ID        = process.env.FLOW_ID         || '806320295577232';

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

// ─── Хранилище состояния ──────────────────────────────────────────────────────
const userState = new Map();

// ─── Хранилище чатов ──────────────────────────────────────────────────────────
// phone → { messages:[], unread:0, botActive:true, lastMsg:'', lastTime:'', grade:'', goal:'', name:'' }
const chats = new Map();

function getChat(phone) {
  if (!chats.has(phone)) {
    chats.set(phone, { messages: [], unread: 0, botActive: true, greeted: false, lastMsg: '', lastTime: '', grade: '', goal: '', name: '', registeredAt: null });
  }
  return chats.get(phone);
}

function storeMsg(phone, dir, text) {
  const chat = getChat(phone);
  const time  = new Date().toISOString();
  chat.messages.push({ dir, text, time });
  chat.lastMsg  = text.slice(0, 80);
  chat.lastTime = time;
  if (dir === 'in') chat.unread++;
  sseNotify({ type: 'message', phone, dir, text, time });
}

// ─── SSE ──────────────────────────────────────────────────────────────────────
const sseClients = new Set();

function sseNotify(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

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
  storeMsg(to, 'out', text);
  await waPost({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } });
}

// ─── Список классов ───────────────────────────────────────────────────────────
async function sendGradeList(to) {
  storeMsg(to, 'out', '📚 Шаг 1 из 2 — В каком классе учится ваш ребёнок?');
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

// ─── Список целей ─────────────────────────────────────────────────────────────
async function sendGoalList(to, gradeId, gradeLabel) {
  let rows;
  if (gradeId === 'g3') {
    rows = [{ id: 'primary', title: 'Школьная программа', description: 'Математика, логика, английский, русский' }];
  } else if (gradeId === 'g5') {
    rows = [
      { id: 'nil',   title: 'НИШ',               description: 'Назарбаев Интеллектуальные Школы' },
      { id: 'rfmsh', title: 'РФМШ',              description: 'Республиканская физмат школа'      },
      { id: 'bil',   title: 'БИЛ',               description: 'Bilim Innovation Lyceum'           },
      { id: 'combo', title: 'НИШ + РФМШ + КТЛ', description: 'Три школы — максимальные шансы'   }
    ];
  } else if (gradeId === 'g7') {
    rows = [
      { id: 'rfmsh',  title: 'РФМШ',              description: 'Математика, логика, олимпиадные'   },
      { id: 'ent',    title: 'ЕНТ',               description: 'Ранняя подготовка к тестированию'  },
      { id: 'basics', title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки' }
    ];
  } else if (gradeId === 'g9') {
    rows = [
      { id: 'rfmsh',   title: 'РФМШ',              description: 'Математика, логика, олимпиадные'    },
      { id: 'ent',     title: 'ЕНТ',               description: 'Подготовка к единому тестированию'  },
      { id: 'basics',  title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки'  },
      { id: 'govexam', title: 'Гос. экзамены',     description: 'Аттестация 9 класс: алгебра, геом.' }
    ];
  } else if (gradeId === 'g10') {
    rows = [
      { id: 'ent_tech', title: 'ЕНТ — Техническое',   description: 'Математика, физика, информатика' },
      { id: 'ent_bio',  title: 'ЕНТ — Биологическое', description: 'Биология, химия, география'      }
    ];
  } else {
    rows = [{ id: 'nil', title: 'НИШ', description: 'Назарбаев Интеллектуальные Школы' }];
  }

  storeMsg(to, 'out', `📚 Шаг 2 из 2 · ${gradeLabel} — Выберите цель подготовки`);
  await waPost({
    messaging_product: 'whatsapp', to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: `📚 Шаг 2 из 2 · ${gradeLabel}` },
      body:   { text: 'Отлично! Выберите цель подготовки:' },
      footer: { text: 'SmartClub · рус / каз направление' },
      action: { button: 'Выбрать цель', sections: [{ title: 'Цель подготовки', rows }] }
    }
  });
}

// ─── Интерактивное сообщение с флоу ──────────────────────────────────────────
async function sendFlowTemplate(to, gradeId, goalId) {
  const flowToken = `${to}|${gradeId}|${goalId}`;
  storeMsg(to, 'out', '🎯 SmartClub — ваша персональная программа [Флоу]');
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
  console.log(`📨 flow → ${to} | token=${flowToken}`);
  return result;
}

// ─── Приветствие ──────────────────────────────────────────────────────────────
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
    const chat  = getChat(phone);
    console.log(`📩 ${phone} | type=${msg.type} | state=${st.state} | bot=${chat.botActive}`);

    // ── nfm_reply: пользователь нажал «Записаться» во флоу ───────────────────
    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      const token = msg.interactive.nfm_reply?.flow_token || '';
      const parts = token.split('|');
      const grade = parts[1] || st.grade || '';
      const goal  = parts[2] || st.goal  || '';
      const now   = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

      storeMsg(phone, 'in', `[Записался: ${GOAL_LABEL[goal] || goal} · ${GRADE_LABEL[grade] || grade}]`);
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
      storeMsg(phone, 'in', `[Выбрал: ${title}]`);

      if (st.state === 'grade') {
        userState.set(phone, { ...st, state: 'goal', grade: id });
        await sendGoalList(phone, id, GRADE_LABEL[id] || title);
      } else if (st.state === 'goal') {
        userState.set(phone, { ...st, state: 'awaiting_flow', goal: id });
        const result = await sendFlowTemplate(phone, st.grade, id);
        if (!result?.messages?.[0]?.id) {
          console.error('❌ Флоу не отправлен:', JSON.stringify(result));
          userState.set(phone, { state: 'grade' });
          await sendText(phone, '⚠️ Не удалось открыть карточку программы. Попробуйте ещё раз 👇');
          await sendGradeList(phone);
        }
      } else if (st.state === 'awaiting_flow') {
        await sendText(phone, `⬆️ Карточка с программой уже отправлена выше.\n\nОткройте её и нажмите *«Записаться на пробный урок»* 👆`);
      } else {
        await sendWelcome(phone);
      }
      return;
    }

    // ── Текстовое сообщение ───────────────────────────────────────────────────
    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();
      storeMsg(phone, 'in', text);

      if (!chat.botActive) {
        console.log(`🤫 Бот выключен для ${phone}`);
        return;
      }

      if (st.state === 'name') {
        const { grade, goal, now } = st;
        userState.delete(phone);

        const gradeLabel = GRADE_LABEL[grade] || grade || '—';
        const goalLabel  = GOAL_LABEL[goal]   || goal  || '—';
        const row = [now, text, phone, gradeLabel, goalLabel, 'Новая заявка'];

        // Сохраняем в чат для аналитики
        chat.name  = text;
        chat.grade = gradeLabel;
        chat.goal  = goalLabel;
        chat.registeredAt = now;

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
          `🕐 Пн–Сб · 09:00–20:00\n\nЖдём вас! 🌟`
        );

        // Воронка завершена — бот выключается, дальше ведёт менеджер
        chat.botActive = false;
        sseNotify({ type: 'bot_toggle', phone, botActive: false });

      } else if (st.state === 'awaiting_flow') {
        // Один раз напомнить про флоу, больше не реагировать
        await sendText(phone, `⬆️ Карточка с программой уже отправлена выше.\n\nОткройте её и нажмите *«Записаться на пробный урок»* 👆`);
      } else {
        // Приветствие только на самое первое сообщение
        if (!chat.greeted) {
          chat.greeted = true;
          await sendWelcome(phone);
        } else {
          console.log(`🔕 ${phone} уже получил приветствие, бот молчит`);
        }
      }
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PWA ADMIN PANEL
// ═══════════════════════════════════════════════════════════════════════════════

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/admin/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const hb = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/api/chats', (_req, res) => {
  const list = [];
  for (const [phone, c] of chats) {
    list.push({
      phone, unread: c.unread, botActive: c.botActive,
      lastMsg: c.lastMsg, lastTime: c.lastTime,
      name: c.name, grade: c.grade, goal: c.goal, registeredAt: c.registeredAt,
      msgCount: c.messages.length
    });
  }
  list.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  res.json(list);
});

app.get('/admin/api/chat/:phone', (req, res) => {
  const c = chats.get(req.params.phone);
  if (!c) return res.json({ messages: [], botActive: true });
  c.unread = 0;
  sseNotify({ type: 'read', phone: req.params.phone });
  res.json({ messages: c.messages, botActive: c.botActive, name: c.name, grade: c.grade, goal: c.goal });
});

app.post('/admin/api/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone & text required' });
  const chat = getChat(phone);
  chat.botActive = false;
  await sendText(phone, text);
  res.json({ ok: true });
});

app.post('/admin/api/toggle-bot', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const chat = getChat(phone);
  chat.botActive = !chat.botActive;
  if (chat.botActive) userState.delete(phone);
  sseNotify({ type: 'bot_toggle', phone, botActive: chat.botActive });
  res.json({ botActive: chat.botActive });
});

app.get('/admin/api/stats', (_req, res) => {
  const all = [...chats.values()];
  const registered = all.filter(c => c.registeredAt);
  const today = new Date().toDateString();
  const todayReg = registered.filter(c => new Date(c.registeredAt).toDateString() === today);

  // по целям
  const byGoal = {};
  registered.forEach(c => {
    const g = c.goal || 'Не указана';
    byGoal[g] = (byGoal[g] || 0) + 1;
  });

  // по классам
  const byGrade = {};
  registered.forEach(c => {
    const g = c.grade || 'Не указан';
    byGrade[g] = (byGrade[g] || 0) + 1;
  });

  // активность по часам (за последние 7 дней)
  const byHour = new Array(24).fill(0);
  all.forEach(c => c.messages.forEach(m => {
    if (m.dir === 'in') byHour[new Date(m.time).getHours()]++;
  }));

  res.json({
    totalChats: chats.size,
    totalRegistered: registered.length,
    todayRegistered: todayReg.length,
    activeBot: all.filter(c => c.botActive).length,
    byGoal,
    byGrade,
    byHour
  });
});

// ── manifest.json ─────────────────────────────────────────────────────────────
app.get('/manifest.json', (_req, res) => {
  res.json({
    name: 'SmartClub Admin',
    short_name: 'SmartClub',
    start_url: '/admin',
    display: 'standalone',
    background_color: '#111b21',
    theme_color: '#111b21',
    icons: [{
      src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='20' fill='%2325d366'/%3E%3Ctext y='.9em' font-size='80' x='10'%3E%F0%9F%92%AC%3C/text%3E%3C/svg%3E",
      sizes: '192x192', type: 'image/svg+xml'
    }]
  });
});

// ── service worker ────────────────────────────────────────────────────────────
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  self.registration.showNotification(d.title || 'SmartClub', { body: d.body || '' });
});
self.addEventListener('notificationclick', e => { e.notification.close(); });
`);
});

// ── Главная страница PWA ──────────────────────────────────────────────────────
const SHEETS_URL = SPREADSHEET_ID
  ? `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?usp=sharing&rm=minimal`
  : '';

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<meta name="theme-color" content="#111b21"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<title>SmartClub Admin</title>
<link rel="manifest" href="/manifest.json"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111b21;color:#e9edef;height:100dvh;overflow:hidden;display:flex;flex-direction:column;}

/* ── Tab bar ── */
#tabbar{display:flex;background:#202c33;border-top:1px solid #2a3942;flex-shrink:0;order:2;}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 4px 12px;cursor:pointer;color:#8696a0;font-size:11px;gap:3px;transition:color .2s;border:none;background:none;}
.tab .tab-icon{font-size:22px;line-height:1;}
.tab.active{color:#00a884;}
.tab.active .tab-icon{filter:drop-shadow(0 0 4px #00a884);}

/* ── Screens ── */
#screens{flex:1;overflow:hidden;order:1;display:flex;flex-direction:column;}
.screen{display:none;flex:1;flex-direction:column;overflow:hidden;}
.screen.active{display:flex;}

/* ══ CHATS SCREEN ══ */
#s-chats{flex-direction:row;}

/* Sidebar */
#sidebar{width:100%;max-width:360px;border-right:1px solid #222d34;display:flex;flex-direction:column;flex-shrink:0;background:#111b21;}
#sidebar-header{background:#202c33;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;min-height:58px;}
#sidebar-header h1{font-size:18px;font-weight:600;color:#e9edef;}
.icon-btn{background:none;border:none;color:#aebac1;cursor:pointer;width:36px;height:36px;border-radius:50%;font-size:18px;display:flex;align-items:center;justify-content:center;transition:background .2s;}
.icon-btn:hover{background:#2a3942;}
#search-wrap{padding:8px 12px;background:#111b21;}
#search-input{width:100%;background:#202c33;border:none;border-radius:8px;padding:9px 14px;color:#e9edef;font-size:14px;outline:none;}
#search-input::placeholder{color:#8696a0;}
#chat-list{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#2a3942 transparent;}
.ci{display:flex;align-items:center;padding:12px 16px;cursor:pointer;border-bottom:1px solid #1c2830;gap:11px;transition:background .15s;}
.ci:hover,.ci.active{background:#2a3942;}
.av{width:46px;height:46px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;color:#111b21;font-weight:700;}
.ci-info{flex:1;min-width:0;}
.ci-name{font-size:15px;font-weight:500;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ci-prev{font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;}
.ci-meta{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0;}
.ci-time{font-size:11px;color:#8696a0;}
.badge{background:#00a884;color:#111b21;font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;}
.bot-dot{width:8px;height:8px;border-radius:50%;background:#00a884;}
.bot-dot.off{background:#555;}
.empty{text-align:center;padding:48px 20px;color:#8696a0;font-size:14px;}

/* Conversation */
#conv{flex:1;display:flex;flex-direction:column;background:#0b141a;}
#conv-header{background:#202c33;padding:10px 14px;display:flex;align-items:center;gap:10px;min-height:58px;flex-shrink:0;}
#back-btn{background:none;border:none;color:#aebac1;font-size:22px;cursor:pointer;padding:4px 8px;display:none;line-height:1;}
#conv-av{width:40px;height:40px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;color:#111b21;font-weight:700;}
#conv-info{flex:1;min-width:0;}
#conv-name{font-size:15px;font-weight:600;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#conv-sub{font-size:12px;color:#8696a0;}
#bot-btn{border:none;font-size:13px;font-weight:600;padding:5px 13px;border-radius:20px;cursor:pointer;white-space:nowrap;transition:all .2s;}
#bot-btn.on{background:#00a884;color:#111b21;}
#bot-btn.off{background:#2a3942;color:#aebac1;}
#messages{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:3px;scrollbar-width:thin;scrollbar-color:#2a3942 transparent;}
.m{max-width:72%;padding:8px 12px;border-radius:8px;font-size:14px;line-height:1.45;word-wrap:break-word;}
.m.in{background:#202c33;border-bottom-left-radius:2px;align-self:flex-start;}
.m.out{background:#005c4b;border-bottom-right-radius:2px;align-self:flex-end;}
.m-t{font-size:10px;color:#8696a0;display:block;margin-top:3px;text-align:right;}
.m-sys{text-align:center;color:#8696a0;font-size:11px;background:#182229;padding:3px 10px;border-radius:8px;align-self:center;}
#input-bar{background:#202c33;padding:10px 12px;display:flex;align-items:flex-end;gap:8px;flex-shrink:0;}
#msg-inp{flex:1;background:#2a3942;border:none;border-radius:10px;padding:10px 13px;color:#e9edef;font-size:15px;outline:none;resize:none;max-height:120px;min-height:42px;font-family:inherit;line-height:1.4;}
#msg-inp::placeholder{color:#8696a0;}
#send-btn{width:44px;height:44px;border-radius:50%;background:#00a884;border:none;cursor:pointer;color:#111b21;font-size:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .2s;}
#send-btn:hover{background:#06d755;}
#no-chat{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#8696a0;}
#no-chat .big{font-size:72px;opacity:.25;}

/* ══ ANALYTICS SCREEN ══ */
#s-analytics{background:#0b141a;}
#analytics-inner{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:14px;scrollbar-width:thin;scrollbar-color:#2a3942 transparent;}

.a-header{background:#202c33;border-radius:12px;padding:16px;}
.a-header h2{font-size:17px;font-weight:600;color:#e9edef;margin-bottom:12px;}
.stats-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.stat-card{background:#0b141a;border-radius:10px;padding:14px;text-align:center;}
.stat-num{font-size:28px;font-weight:700;color:#00a884;}
.stat-lbl{font-size:12px;color:#8696a0;margin-top:2px;}

.a-section{background:#202c33;border-radius:12px;padding:16px;}
.a-section h3{font-size:15px;font-weight:600;color:#e9edef;margin-bottom:12px;}

.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
.bar-label{font-size:13px;color:#aebac1;width:130px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bar-wrap{flex:1;background:#0b141a;border-radius:4px;height:20px;overflow:hidden;}
.bar-fill{height:100%;background:#00a884;border-radius:4px;transition:width .4s ease;min-width:2px;}
.bar-count{font-size:12px;color:#8696a0;width:28px;text-align:right;flex-shrink:0;}

.chat-table{width:100%;border-collapse:collapse;}
.chat-table th{font-size:12px;color:#8696a0;text-align:left;padding:6px 8px;border-bottom:1px solid #2a3942;white-space:nowrap;}
.chat-table td{font-size:13px;color:#e9edef;padding:8px;border-bottom:1px solid #1c2830;vertical-align:top;}
.chat-table tr:last-child td{border-bottom:none;}
.tag{display:inline-block;background:#1c4a3a;color:#00a884;font-size:11px;padding:2px 7px;border-radius:10px;white-space:nowrap;}

/* ══ SHEETS SCREEN ══ */
#s-sheets{background:#111b21;}
#sheets-frame{flex:1;border:none;width:100%;height:100%;}
#sheets-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:#8696a0;padding:32px;text-align:center;}
#sheets-empty .big{font-size:56px;opacity:.3;}

/* ── Mobile ── */
@media(max-width:680px){
  #sidebar{max-width:100%;}
  #conv{position:fixed;inset:0;bottom:56px;transform:translateX(100%);transition:transform .25s ease;z-index:20;}
  #conv.open{transform:translateX(0);}
  #back-btn{display:flex!important;}
  #no-chat{display:none;}
}
</style>
</head>
<body>

<div id="screens">

  <!-- ══ CHATS ══ -->
  <div id="s-chats" class="screen active">
    <div id="sidebar">
      <div id="sidebar-header">
        <h1>💬 Чаты</h1>
        <button class="icon-btn" onclick="loadChats()" title="Обновить">↻</button>
      </div>
      <div id="search-wrap">
        <input id="search-input" type="search" placeholder="Поиск по номеру..." oninput="filterChats()"/>
      </div>
      <div id="chat-list"><div class="empty">Загрузка...</div></div>
    </div>

    <div id="no-chat">
      <div class="big">💬</div>
      <p>Выберите чат</p>
    </div>

    <div id="conv">
      <div id="conv-header">
        <button id="back-btn" onclick="closeConv()">←</button>
        <div id="conv-av">👤</div>
        <div id="conv-info">
          <div id="conv-name">—</div>
          <div id="conv-sub">—</div>
        </div>
        <button id="bot-btn" class="on" onclick="toggleBot()">🤖 Бот вкл</button>
      </div>
      <div id="messages"></div>
      <div id="input-bar">
        <textarea id="msg-inp" placeholder="Написать сообщение..." rows="1"
          oninput="autoResize(this)" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"></textarea>
        <button id="send-btn" onclick="sendMsg()">➤</button>
      </div>
    </div>
  </div>

  <!-- ══ ANALYTICS ══ -->
  <div id="s-analytics" class="screen">
    <div id="analytics-inner">
      <div class="a-header">
        <h2>📊 Аналитика</h2>
        <div class="stats-grid">
          <div class="stat-card"><div class="stat-num" id="st-total">—</div><div class="stat-lbl">Всего чатов</div></div>
          <div class="stat-card"><div class="stat-num" id="st-reg">—</div><div class="stat-lbl">Заявок всего</div></div>
          <div class="stat-card"><div class="stat-num" id="st-today">—</div><div class="stat-lbl">Заявок сегодня</div></div>
          <div class="stat-card"><div class="stat-num" id="st-bot">—</div><div class="stat-lbl">Бот активен</div></div>
        </div>
      </div>

      <div class="a-section">
        <h3>🎯 По программам</h3>
        <div id="chart-goal"></div>
      </div>

      <div class="a-section">
        <h3>🏫 По классам</h3>
        <div id="chart-grade"></div>
      </div>

      <div class="a-section">
        <h3>👥 Все обращения</h3>
        <table class="chat-table">
          <thead><tr>
            <th>Телефон</th><th>Имя</th><th>Класс</th><th>Программа</th><th>Время</th>
          </tr></thead>
          <tbody id="all-chats-tbody"></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- ══ SHEETS ══ -->
  <div id="s-sheets" class="screen">
    ${SHEETS_URL
      ? `<iframe id="sheets-frame" src="${SHEETS_URL}" allow="fullscreen"></iframe>`
      : `<div id="sheets-empty"><div class="big">📋</div><p>Google Sheets не подключён.</p><p style="font-size:13px;margin-top:8px">Добавьте переменную <strong>SPREADSHEET_ID</strong> в Railway.</p></div>`}
  </div>

</div>

<!-- ── Tab bar ── -->
<div id="tabbar">
  <button class="tab active" onclick="switchTab('chats',this)" id="tab-chats">
    <span class="tab-icon">💬</span>Чаты
  </button>
  <button class="tab" onclick="switchTab('analytics',this)" id="tab-analytics">
    <span class="tab-icon">📊</span>Аналитика
  </button>
  <button class="tab" onclick="switchTab('sheets',this)" id="tab-sheets">
    <span class="tab-icon">📋</span>Таблица
  </button>
</div>

<script>
let activePhone = null;
let chatsData   = [];
let sseConn     = null;

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('s-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'analytics') loadAnalytics();
}

// ── Load chats ────────────────────────────────────────────────────────────────
function loadChats() {
  fetch('/admin/api/chats').then(r => r.json()).then(list => {
    chatsData = list;
    renderList(list);
  });
}

function renderList(list) {
  const el = document.getElementById('chat-list');
  if (!list.length) { el.innerHTML = '<div class="empty">Нет чатов</div>'; return; }
  el.innerHTML = list.map(c => \`
    <div class="ci\${c.phone === activePhone ? ' active' : ''}" onclick="openChat('\${c.phone}')">
      <div class="av">\${initials(c.name || c.phone)}</div>
      <div class="ci-info">
        <div class="ci-name">\${esc(c.name || fmtPhone(c.phone))}</div>
        <div class="ci-prev">\${esc(c.lastMsg || 'Нет сообщений')}</div>
      </div>
      <div class="ci-meta">
        <div class="ci-time">\${fmtTime(c.lastTime)}</div>
        \${c.unread > 0 ? \`<div class="badge">\${c.unread}</div>\` : \`<div class="bot-dot\${c.botActive ? '' : ' off'}"></div>\`}
      </div>
    </div>
  \`).join('');
}

function filterChats() {
  const q = document.getElementById('search-input').value.toLowerCase();
  renderList(q ? chatsData.filter(c => c.phone.includes(q) || (c.name||'').toLowerCase().includes(q)) : chatsData);
}

// ── Open chat ─────────────────────────────────────────────────────────────────
function openChat(phone) {
  activePhone = phone;
  const c = chatsData.find(x => x.phone === phone) || {};
  document.getElementById('conv-name').textContent = c.name || fmtPhone(phone);
  document.getElementById('conv-sub').textContent  = c.botActive !== false ? '🤖 Бот активен' : '👨‍💼 Менеджер ведёт';
  setBotBtn(c.botActive !== false);
  document.getElementById('conv').classList.add('open');
  renderList(chatsData);

  fetch(\`/admin/api/chat/\${phone}\`).then(r => r.json()).then(data => {
    setBotBtn(data.botActive !== false);
    document.getElementById('conv-sub').textContent = data.botActive !== false ? '🤖 Бот активен' : '👨‍💼 Менеджер ведёт';
    renderMsgs(data.messages || []);
    const e = chatsData.find(x => x.phone === phone);
    if (e) { e.unread = 0; renderList(chatsData); }
  });
}

function closeConv() {
  document.getElementById('conv').classList.remove('open');
  activePhone = null;
}

// ── Messages ──────────────────────────────────────────────────────────────────
function renderMsgs(msgs) {
  const el = document.getElementById('messages');
  el.innerHTML = msgs.length
    ? msgs.map(m => \`<div class="m \${m.dir}">\${esc(m.text)}<span class="m-t">\${fmtTime(m.time)}</span></div>\`).join('')
    : '<div class="m-sys">Нет сообщений</div>';
  el.scrollTop = el.scrollHeight;
}

function appendMsg(m) {
  const el = document.getElementById('messages');
  const d = document.createElement('div');
  d.className = 'm ' + m.dir;
  d.innerHTML = esc(m.text) + \`<span class="m-t">\${fmtTime(m.time)}</span>\`;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────────────
function sendMsg() {
  const inp = document.getElementById('msg-inp');
  const text = inp.value.trim();
  if (!text || !activePhone) return;
  inp.value = ''; autoResize(inp);
  fetch('/admin/api/send', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: activePhone, text })
  }).then(() => loadChats());
}

function autoResize(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }

// ── Bot toggle ────────────────────────────────────────────────────────────────
function toggleBot() {
  if (!activePhone) return;
  fetch('/admin/api/toggle-bot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: activePhone })
  }).then(r => r.json()).then(d => {
    setBotBtn(d.botActive);
    document.getElementById('conv-sub').textContent = d.botActive ? '🤖 Бот активен' : '👨‍💼 Менеджер ведёт';
    const e = chatsData.find(x => x.phone === activePhone);
    if (e) { e.botActive = d.botActive; renderList(chatsData); }
  });
}

function setBotBtn(on) {
  const b = document.getElementById('bot-btn');
  b.className = on ? 'on' : 'off';
  b.textContent = on ? '🤖 Бот вкл' : '👤 Бот выкл';
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function loadAnalytics() {
  fetch('/admin/api/stats').then(r => r.json()).then(s => {
    document.getElementById('st-total').textContent = s.totalChats;
    document.getElementById('st-reg').textContent   = s.totalRegistered;
    document.getElementById('st-today').textContent = s.todayRegistered;
    document.getElementById('st-bot').textContent   = s.activeBot;
    renderBars('chart-goal',  s.byGoal);
    renderBars('chart-grade', s.byGrade);
  });

  fetch('/admin/api/chats').then(r => r.json()).then(list => {
    const tbody = document.getElementById('all-chats-tbody');
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#8696a0;padding:20px">Нет данных</td></tr>'; return; }
    tbody.innerHTML = list.map(c => \`
      <tr>
        <td style="color:#8696a0">\${fmtPhone(c.phone)}</td>
        <td>\${esc(c.name || '—')}</td>
        <td>\${esc(c.grade || '—')}</td>
        <td>\${c.goal ? \`<span class="tag">\${esc(c.goal)}</span>\` : '—'}</td>
        <td style="color:#8696a0;font-size:12px;white-space:nowrap">\${fmtTime(c.registeredAt || c.lastTime)}</td>
      </tr>
    \`).join('');
  });
}

function renderBars(elId, data) {
  const el = document.getElementById(elId);
  const entries = Object.entries(data).sort((a,b) => b[1]-a[1]);
  if (!entries.length) { el.innerHTML = '<div style="color:#8696a0;font-size:13px">Нет данных</div>'; return; }
  const max = entries[0][1];
  el.innerHTML = entries.map(([k,v]) => \`
    <div class="bar-row">
      <div class="bar-label" title="\${esc(k)}">\${esc(k)}</div>
      <div class="bar-wrap"><div class="bar-fill" style="width:\${Math.round(v/max*100)}%"></div></div>
      <div class="bar-count">\${v}</div>
    </div>
  \`).join('');
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (sseConn) sseConn.close();
  sseConn = new EventSource('/admin/events');
  sseConn.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'message') {
        let entry = chatsData.find(x => x.phone === d.phone);
        if (!entry) { entry = { phone: d.phone, unread: 0, botActive: true, lastMsg: '', lastTime: '' }; chatsData.unshift(entry); }
        entry.lastMsg = d.text.slice(0,80);
        entry.lastTime = d.time;
        if (d.dir === 'in' && d.phone !== activePhone) { entry.unread++; notify(d.phone, d.text); }
        if (d.phone === activePhone) appendMsg(d);
        renderList(chatsData);
      } else if (d.type === 'read') {
        const entry = chatsData.find(x => x.phone === d.phone);
        if (entry) { entry.unread = 0; renderList(chatsData); }
      } else if (d.type === 'bot_toggle') {
        const entry = chatsData.find(x => x.phone === d.phone);
        if (entry) { entry.botActive = d.botActive; renderList(chatsData); }
      }
    } catch(_) {}
  };
  sseConn.onerror = () => setTimeout(connectSSE, 3000);
}

// ── Notifications ─────────────────────────────────────────────────────────────
function notify(phone, text) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification('SmartClub · ' + fmtPhone(phone), { body: text.slice(0,80) });
  }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function fmtPhone(p) {
  if (!p) return '—';
  const d = p.replace(/\\D/g,'');
  if (d.length===11) return '+'+d[0]+' ('+d.slice(1,4)+') '+d.slice(4,7)+'-'+d.slice(7,9)+'-'+d.slice(9);
  return '+'+p;
}
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (d.toDateString()===now.toDateString()) return d.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  return d.toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
}
function esc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\\n/g,'<br>');
}
function initials(s) {
  if (!s) return '👤';
  const parts = s.trim().split(' ');
  if (parts[0].match(/^\\d/)) return s.slice(-2);
  return (parts[0][0]||'')+(parts[1]?.[0]||'');
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadChats();
connectSSE();
if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
</script>
</body>
</html>`;

app.get('/admin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML);
});

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Autobot + Admin PWA запущен на порту ${PORT}`);
  console.log(`🔑 Token:    ${TOKEN    ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`📋 Sheets:   ${SPREADSHEET_ID || '❌ не задан'}`);
  console.log(`🤖 Flow ID:  ${FLOW_ID}`);
  console.log(`🌐 Admin:    /admin`);
});
