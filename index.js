const express = require('express');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const TOKEN          = process.env.WHATSAPP_TOKEN;
const PHONE_ID       = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN   = process.env.VERIFY_TOKEN    || 'smartclub2024';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '';
const GOOGLE_CREDS   = process.env.GOOGLE_CREDENTIALS || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD  || 'smartclub2024';
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

// ─── Хранилище чатов для PWA-панели ──────────────────────────────────────────
// { phone → { messages: [], unread: 0, botActive: true, lastMsg: '', lastTime: '' } }
const chats = new Map();

function getChat(phone) {
  if (!chats.has(phone)) {
    chats.set(phone, { messages: [], unread: 0, botActive: true, lastMsg: '', lastTime: '' });
  }
  return chats.get(phone);
}

function storeMsg(phone, dir, text) {
  const chat = getChat(phone);
  const time  = new Date().toISOString();
  chat.messages.push({ dir, text, time });
  chat.lastMsg  = text.slice(0, 60);
  chat.lastTime = time;
  if (dir === 'in') chat.unread++;
  sseNotify({ type: 'message', phone, dir, text, time });
}

// ─── SSE (Server-Sent Events) ─────────────────────────────────────────────────
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
  const text = '📚 Шаг 1 из 2 — Класс\nВ каком классе учится ваш ребёнок?';
  storeMsg(to, 'out', text);
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
      { id: 'nil',   title: 'НИШ',              description: 'Назарбаев Интеллектуальные Школы'  },
      { id: 'rfmsh', title: 'РФМШ',             description: 'Республиканская физмат школа'       },
      { id: 'bil',   title: 'БИЛ',              description: 'Bilim Innovation Lyceum'            },
      { id: 'combo', title: 'НИШ + РФМШ + КТЛ', description: 'Три школы — максимальные шансы'   }
    ];
  } else if (gradeId === 'g7') {
    rows = [
      { id: 'rfmsh',  title: 'РФМШ',             description: 'Математика, логика, олимпиадные'  },
      { id: 'ent',    title: 'ЕНТ',              description: 'Ранняя подготовка к тестированию'  },
      { id: 'basics', title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки' }
    ];
  } else if (gradeId === 'g9') {
    rows = [
      { id: 'rfmsh',   title: 'РФМШ',             description: 'Математика, логика, олимпиадные'    },
      { id: 'ent',     title: 'ЕНТ',              description: 'Подготовка к единому тестированию'  },
      { id: 'basics',  title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки' },
      { id: 'govexam', title: 'Гос. экзамены',    description: 'Аттестация 9 класс: алгебра, геом.' }
    ];
  } else if (gradeId === 'g10') {
    rows = [
      { id: 'ent_tech', title: 'ЕНТ — Техническое',   description: 'Математика, физика, информатика' },
      { id: 'ent_bio',  title: 'ЕНТ — Биологическое', description: 'Биология, химия, география'      }
    ];
  } else {
    rows = [{ id: 'nil', title: 'НИШ', description: 'Назарбаев Интеллектуальные Школы' }];
  }

  const text = `📚 Шаг 2 из 2 · ${gradeLabel}\nВыберите цель подготовки`;
  storeMsg(to, 'out', text);
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
  const text = '🎯 SmartClub — ваша программа\nОткройте персональную программу';
  storeMsg(to, 'out', text);
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

      storeMsg(phone, 'in', `[Записался на: ${GOAL_LABEL[goal] || goal} · ${GRADE_LABEL[grade] || grade}]`);
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
        await sendText(phone,
          `⬆️ Карточка с программой уже отправлена выше.\n\nОткройте её и нажмите *«Записаться на пробный урок»* 👆`
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
      storeMsg(phone, 'in', text);

      // Если менеджер уже ведёт диалог — бот молчит
      if (!chat.botActive) {
        console.log(`🤫 Бот выключен для ${phone}, менеджер ведёт диалог`);
        return;
      }

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
          `🕐 Пн–Сб · 09:00–20:00\n\nЖдём вас! 🌟`
        );

      } else if (st.state === 'awaiting_flow') {
        await sendText(phone,
          `⬆️ Карточка с программой уже отправлена выше.\n\nОткройте её и нажмите *«Записаться на пробный урок»* 👆`
        );

      } else {
        await sendWelcome(phone);
      }
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PWA ADMIN PANEL
// ═══════════════════════════════════════════════════════════════════════════════

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const pwd = req.headers['x-admin-password'] || req.query.p;
  if (pwd === ADMIN_PASSWORD) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────
app.get('/admin/events', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) { clearInterval(heartbeat); sseClients.delete(res); }
  }, 25000);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
});

// ── Admin API ─────────────────────────────────────────────────────────────────
app.get('/admin/api/chats', requireAuth, (_req, res) => {
  const list = [];
  for (const [phone, c] of chats) {
    list.push({ phone, unread: c.unread, botActive: c.botActive, lastMsg: c.lastMsg, lastTime: c.lastTime });
  }
  list.sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  res.json(list);
});

app.get('/admin/api/chat/:phone', requireAuth, (req, res) => {
  const c = chats.get(req.params.phone);
  if (!c) return res.json({ messages: [], botActive: true });
  c.unread = 0;
  res.json({ messages: c.messages, botActive: c.botActive });
});

app.post('/admin/api/send', requireAuth, async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone & text required' });
  const chat = getChat(phone);
  chat.botActive = false; // менеджер взял чат
  await sendText(phone, text);
  res.json({ ok: true });
});

app.post('/admin/api/toggle-bot', requireAuth, (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const chat = getChat(phone);
  chat.botActive = !chat.botActive;
  if (chat.botActive) userState.delete(phone); // сбросить состояние чтобы бот начал заново
  sseNotify({ type: 'bot_toggle', phone, botActive: chat.botActive });
  res.json({ botActive: chat.botActive });
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
    icons: [
      { src: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="%2325d366"/><text y=".9em" font-size="80" x="10">💬</text></svg>', sizes: '192x192', type: 'image/svg+xml' }
    ]
  });
});

// ── service worker ────────────────────────────────────────────────────────────
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
self.addEventListener('push', e => {
  const d = e.data ? e.data.json() : {};
  self.registration.showNotification(d.title || 'SmartClub', {
    body: d.body || '',
    icon: '/favicon.ico',
    badge: '/favicon.ico'
  });
});
self.addEventListener('notificationclick', e => { e.notification.close(); });
`);
});

// ── Главная страница PWA ──────────────────────────────────────────────────────
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<meta name="theme-color" content="#111b21"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<title>SmartClub Admin</title>
<link rel="manifest" href="/manifest.json"/>
<style>
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#111b21;color:#e9edef;height:100dvh;overflow:hidden;}
#app{display:flex;height:100dvh;}

/* ── Sidebar ── */
#sidebar{width:100%;max-width:380px;border-right:1px solid #222d34;display:flex;flex-direction:column;flex-shrink:0;}
#sidebar-header{background:#202c33;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;min-height:60px;}
#sidebar-header h1{font-size:20px;font-weight:600;color:#e9edef;}
.header-btn{background:none;border:none;color:#aebac1;cursor:pointer;padding:8px;border-radius:50%;font-size:20px;transition:background .2s;}
.header-btn:hover{background:#2a3942;}
#search-box{padding:8px 12px;background:#111b21;}
#search-input{width:100%;background:#202c33;border:none;border-radius:8px;padding:9px 14px;color:#e9edef;font-size:15px;outline:none;}
#search-input::placeholder{color:#8696a0;}
#chat-list{flex:1;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#374045 transparent;}
.chat-item{display:flex;align-items:center;padding:12px 16px;cursor:pointer;border-bottom:1px solid #1c2830;gap:12px;transition:background .15s;}
.chat-item:hover,.chat-item.active{background:#2a3942;}
.avatar{width:48px;height:48px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;}
.chat-info{flex:1;min-width:0;}
.chat-name{font-size:16px;font-weight:500;color:#e9edef;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.chat-preview{font-size:13px;color:#8696a0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;}
.chat-meta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;}
.chat-time{font-size:12px;color:#8696a0;}
.unread-badge{background:#00a884;color:#111b21;font-size:12px;font-weight:600;min-width:20px;height:20px;border-radius:10px;display:flex;align-items:center;justify-content:center;padding:0 5px;}
.bot-dot{width:8px;height:8px;border-radius:50%;background:#00a884;}
.bot-dot.off{background:#8696a0;}
.empty-list{text-align:center;padding:40px 20px;color:#8696a0;font-size:14px;}

/* ── Conversation ── */
#conversation{flex:1;display:flex;flex-direction:column;background:#0b141a;position:relative;}
#conv-header{background:#202c33;padding:12px 16px;display:flex;align-items:center;gap:12px;min-height:60px;}
#back-btn{background:none;border:none;color:#aebac1;cursor:pointer;font-size:22px;padding:4px;display:none;}
#conv-avatar{width:40px;height:40px;border-radius:50%;background:#00a884;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
#conv-info{flex:1;}
#conv-name{font-size:16px;font-weight:600;color:#e9edef;}
#conv-status{font-size:13px;color:#8696a0;}
#bot-toggle{background:#00a884;border:none;color:#111b21;font-size:13px;font-weight:600;padding:6px 14px;border-radius:20px;cursor:pointer;transition:background .2s;white-space:nowrap;}
#bot-toggle.off{background:#374045;color:#aebac1;}
#messages{flex:1;overflow-y:auto;padding:16px;scrollbar-width:thin;scrollbar-color:#374045 transparent;display:flex;flex-direction:column;gap:4px;}
.msg{max-width:70%;padding:8px 12px;border-radius:8px;font-size:15px;line-height:1.4;word-wrap:break-word;position:relative;}
.msg.in{background:#202c33;border-bottom-left-radius:2px;align-self:flex-start;}
.msg.out{background:#005c4b;border-bottom-right-radius:2px;align-self:flex-end;}
.msg-time{font-size:11px;color:#8696a0;display:block;margin-top:4px;text-align:right;}
.msg-system{text-align:center;color:#8696a0;font-size:12px;background:#182229;padding:4px 12px;border-radius:8px;align-self:center;max-width:80%;}
#input-bar{background:#202c33;padding:10px 16px;display:flex;align-items:flex-end;gap:10px;}
#msg-input{flex:1;background:#2a3942;border:none;border-radius:10px;padding:10px 14px;color:#e9edef;font-size:15px;outline:none;resize:none;max-height:120px;min-height:44px;font-family:inherit;line-height:1.4;}
#msg-input::placeholder{color:#8696a0;}
#send-btn{width:46px;height:46px;border-radius:50%;background:#00a884;border:none;cursor:pointer;color:#111b21;font-size:22px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .2s;}
#send-btn:hover{background:#06d755;}
#send-btn:disabled{background:#374045;cursor:not-allowed;}
#placeholder{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;color:#8696a0;background:#0b141a;}
#placeholder .icon{font-size:80px;opacity:.3;}
#placeholder p{font-size:16px;}

/* ── Login ── */
#login-screen{position:fixed;inset:0;background:#111b21;display:flex;align-items:center;justify-content:center;z-index:100;}
.login-card{background:#202c33;border-radius:16px;padding:32px;width:320px;text-align:center;}
.login-card h2{font-size:22px;font-weight:600;color:#e9edef;margin-bottom:8px;}
.login-card p{color:#8696a0;font-size:14px;margin-bottom:24px;}
.login-card input{width:100%;background:#2a3942;border:none;border-radius:8px;padding:12px 16px;color:#e9edef;font-size:16px;outline:none;margin-bottom:12px;text-align:center;letter-spacing:4px;}
.login-card button{width:100%;background:#00a884;border:none;border-radius:8px;padding:13px;color:#111b21;font-size:16px;font-weight:600;cursor:pointer;}
.login-error{color:#ef476f;font-size:13px;margin-top:8px;}

/* ── Mobile ── */
@media(max-width:680px){
  #sidebar{max-width:100%;}
  #conversation{position:fixed;inset:0;transform:translateX(100%);transition:transform .25s ease;z-index:10;}
  #conversation.open{transform:translateX(0);}
  #back-btn{display:flex!important;}
}

/* Wallpaper pattern */
#messages::before{content:'';position:fixed;inset:0;opacity:.04;pointer-events:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Ctext y='30' font-size='24'%3E💬%3C/text%3E%3C/svg%3E");}
</style>
</head>
<body>

<div id="login-screen">
  <div class="login-card">
    <div style="font-size:48px;margin-bottom:16px">💬</div>
    <h2>SmartClub Admin</h2>
    <p>Введите пароль для входа</p>
    <input type="password" id="pwd-input" placeholder="••••••••" onkeydown="if(event.key==='Enter')doLogin()"/>
    <button onclick="doLogin()">Войти</button>
    <div class="login-error" id="login-error"></div>
  </div>
</div>

<div id="app" style="display:none">
  <div id="sidebar">
    <div id="sidebar-header">
      <h1>💬 SmartClub</h1>
      <button class="header-btn" title="Обновить" onclick="loadChats()">↻</button>
    </div>
    <div id="search-box">
      <input id="search-input" type="search" placeholder="Поиск по номеру..." oninput="filterChats()"/>
    </div>
    <div id="chat-list"><div class="empty-list">Загрузка...</div></div>
  </div>

  <div id="placeholder">
    <div class="icon">💬</div>
    <p>Выберите чат из списка</p>
  </div>

  <div id="conversation">
    <div id="conv-header">
      <button id="back-btn" onclick="closeMobileChat()">←</button>
      <div id="conv-avatar">👤</div>
      <div id="conv-info">
        <div id="conv-name">—</div>
        <div id="conv-status">—</div>
      </div>
      <button id="bot-toggle" onclick="toggleBot()">🤖 Бот вкл</button>
    </div>
    <div id="messages"></div>
    <div id="input-bar">
      <textarea id="msg-input" placeholder="Сообщение..." rows="1"
        oninput="autoResize(this)" onkeydown="msgKeydown(event)"></textarea>
      <button id="send-btn" onclick="sendMsg()">➤</button>
    </div>
  </div>
</div>

<script>
let pwd = localStorage.getItem('sc_pwd') || '';
let activePhone = null;
let chatsData = [];
let sseConn = null;

// ── Login ─────────────────────────────────────────────────────────────────────
function doLogin() {
  const v = document.getElementById('pwd-input').value;
  fetch('/admin/api/chats', { headers: { 'x-admin-password': v } })
    .then(r => { if (r.ok) { pwd = v; localStorage.setItem('sc_pwd', v); showApp(); } else { document.getElementById('login-error').textContent = 'Неверный пароль'; } });
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  loadChats();
  connectSSE();
  requestNotifPermission();
}

// Auto-login if saved
if (pwd) {
  fetch('/admin/api/chats', { headers: { 'x-admin-password': pwd } })
    .then(r => r.ok ? showApp() : null);
}

// ── API helpers ───────────────────────────────────────────────────────────────
function api(method, path, body) {
  return fetch(path, {
    method, headers: { 'Content-Type': 'application/json', 'x-admin-password': pwd },
    body: body ? JSON.stringify(body) : undefined
  }).then(r => r.json());
}

// ── Chat list ─────────────────────────────────────────────────────────────────
function loadChats() {
  api('GET', '/admin/api/chats').then(list => {
    chatsData = list;
    renderChatList(list);
  });
}

function renderChatList(list) {
  const el = document.getElementById('chat-list');
  if (!list.length) { el.innerHTML = '<div class="empty-list">Нет чатов</div>'; return; }
  el.innerHTML = list.map(c => \`
    <div class="chat-item\${c.phone === activePhone ? ' active' : ''}" onclick="openChat('\${c.phone}')">
      <div class="avatar">👤</div>
      <div class="chat-info">
        <div class="chat-name">\${formatPhone(c.phone)}</div>
        <div class="chat-preview">\${esc(c.lastMsg || 'Нет сообщений')}</div>
      </div>
      <div class="chat-meta">
        <div class="chat-time">\${formatTime(c.lastTime)}</div>
        \${c.unread > 0 ? \`<div class="unread-badge">\${c.unread}</div>\` : \`<div class="bot-dot\${c.botActive ? '' : ' off'}" title="\${c.botActive ? 'Бот активен' : 'Менеджер'}"></div>\`}
      </div>
    </div>
  \`).join('');
}

function filterChats() {
  const q = document.getElementById('search-input').value.toLowerCase();
  renderChatList(q ? chatsData.filter(c => c.phone.includes(q)) : chatsData);
}

// ── Open chat ─────────────────────────────────────────────────────────────────
function openChat(phone) {
  activePhone = phone;
  const c = chatsData.find(x => x.phone === phone) || {};
  document.getElementById('conv-name').textContent = formatPhone(phone);
  document.getElementById('conv-status').textContent = c.botActive ? '🤖 Бот активен' : '👨‍💼 Менеджер ведёт';
  updateBotBtn(c.botActive !== false);
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('conversation').classList.add('open');
  renderChatList(chatsData);

  api('GET', \`/admin/api/chat/\${phone}\`).then(data => {
    updateBotBtn(data.botActive !== false);
    document.getElementById('conv-status').textContent = data.botActive !== false ? '🤖 Бот активен' : '👨‍💼 Менеджер ведёт';
    renderMessages(data.messages || []);
    // clear unread in list
    const entry = chatsData.find(x => x.phone === phone);
    if (entry) entry.unread = 0;
    renderChatList(chatsData);
  });
}

function closeMobileChat() {
  document.getElementById('conversation').classList.remove('open');
  activePhone = null;
}

// ── Messages ──────────────────────────────────────────────────────────────────
function renderMessages(msgs) {
  const el = document.getElementById('messages');
  if (!msgs.length) { el.innerHTML = '<div class="msg-system">Нет сообщений</div>'; return; }
  el.innerHTML = msgs.map(m => \`
    <div class="msg \${m.dir}">
      \${esc(m.text)}
      <span class="msg-time">\${formatTime(m.time)}</span>
    </div>
  \`).join('');
  el.scrollTop = el.scrollHeight;
}

function appendMessage(msg) {
  const el = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg ' + msg.dir;
  div.innerHTML = esc(msg.text) + \`<span class="msg-time">\${formatTime(msg.time)}</span>\`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// ── Send ──────────────────────────────────────────────────────────────────────
function sendMsg() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !activePhone) return;
  input.value = '';
  autoResize(input);
  api('POST', '/admin/api/send', { phone: activePhone, text })
    .then(() => loadChats());
}

function msgKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── Bot toggle ────────────────────────────────────────────────────────────────
function toggleBot() {
  if (!activePhone) return;
  api('POST', '/admin/api/toggle-bot', { phone: activePhone }).then(data => {
    updateBotBtn(data.botActive);
    document.getElementById('conv-status').textContent = data.botActive ? '🤖 Бот активен' : '👨‍💼 Менеджер ведёт';
    const entry = chatsData.find(x => x.phone === activePhone);
    if (entry) { entry.botActive = data.botActive; renderChatList(chatsData); }
  });
}

function updateBotBtn(active) {
  const btn = document.getElementById('bot-toggle');
  btn.textContent = active ? '🤖 Бот вкл' : '👤 Бот выкл';
  btn.className = active ? 'bot-toggle' : 'bot-toggle off';
  btn.id = 'bot-toggle';
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (sseConn) sseConn.close();
  sseConn = new EventSource(\`/admin/events?p=\${encodeURIComponent(pwd)}\`);
  sseConn.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'message') handleSSEMessage(d);
      else if (d.type === 'bot_toggle') handleSSEBotToggle(d);
    } catch (_) {}
  };
  sseConn.onerror = () => setTimeout(connectSSE, 3000);
}

function handleSSEMessage(d) {
  let entry = chatsData.find(x => x.phone === d.phone);
  if (!entry) { entry = { phone: d.phone, unread: 0, botActive: true, lastMsg: '', lastTime: '' }; chatsData.unshift(entry); }
  entry.lastMsg = d.text.slice(0, 60);
  entry.lastTime = d.time;
  if (d.dir === 'in' && d.phone !== activePhone) {
    entry.unread++;
    showNotification(d.phone, d.text);
  }
  if (d.phone === activePhone) appendMessage(d);
  renderChatList(chatsData);
}

function handleSSEBotToggle(d) {
  const entry = chatsData.find(x => x.phone === d.phone);
  if (entry) { entry.botActive = d.botActive; renderChatList(chatsData); }
}

// ── Notifications ──────────────────────────────────────────────────────────────
function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

function showNotification(phone, text) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification('SmartClub · ' + formatPhone(phone), { body: text.slice(0, 80), icon: '/favicon.ico' });
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function formatPhone(p) {
  if (!p) return '—';
  const d = p.replace(/\\D/g, '');
  if (d.length === 11) return '+' + d[0] + ' (' + d.slice(1,4) + ') ' + d.slice(4,7) + '-' + d.slice(7,9) + '-' + d.slice(9);
  return '+' + p;
}

function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\\n/g,'<br>');
}
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
  console.log(`✅ SmartClub Autobot + Admin запущен на порту ${PORT}`);
  console.log(`🔑 Token:    ${TOKEN    ? 'задан' : '❌ НЕ ЗАДАН'}`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ НЕ ЗАДАН'}`);
  console.log(`🔒 Admin:    /admin (пароль: ${ADMIN_PASSWORD})`);
  console.log(`🤖 Flow ID:  ${FLOW_ID}`);
});
