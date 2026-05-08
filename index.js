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

const GRADE_LABEL = {
  g3: '3–4 класс', g5: '5–6 класс', g7: '7–8 класс', g9: '9 класс', g10: '10–11 класс'
};
const GOAL_LABEL = {
  nil: 'НИШ', rfmsh: 'РФМШ', bil: 'БИЛ', combo: 'НИШ + РФМШ + КТЛ',
  ent: 'ЕНТ', basics: 'Основные предметы', govexam: 'Гос. экзамены (9 класс)',
  ent_tech: 'ЕНТ — Техническое', ent_bio: 'ЕНТ — Биологическое', primary: 'Начальная школа'
};

const userState = new Map();
const chats     = new Map();

function getChat(phone) {
  if (!chats.has(phone)) {
    chats.set(phone, {
      messages: [], unread: 0, botActive: true, greeted: false,
      lastMsg: '', lastTime: '', grade: '', goal: '', name: '',
      registeredAt: null, status: 'new'
    });
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

const sseClients = new Set();
function sseNotify(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) { sseClients.delete(res); }
  }
}

async function appendToSheet(row) {
  if (!SPREADSHEET_ID || !GOOGLE_CREDS) return;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(GOOGLE_CREDS),
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const sheets = google.sheets({ version: 'v4', auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID, range: 'A:F',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] }
    });
  } catch (e) { console.error('❌ Sheets:', e.message); }
}

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

async function sendGradeList(to) {
  storeMsg(to, 'out', '📚 Шаг 1 из 2 — В каком классе учится ваш ребёнок?');
  await waPost({
    messaging_product: 'whatsapp', to, type: 'interactive',
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

async function sendGoalList(to, gradeId, gradeLabel) {
  let rows;
  if (gradeId === 'g3') rows = [{ id: 'primary', title: 'Школьная программа', description: 'Математика, логика, английский, русский' }];
  else if (gradeId === 'g5') rows = [
    { id: 'nil', title: 'НИШ', description: 'Назарбаев Интеллектуальные Школы' },
    { id: 'rfmsh', title: 'РФМШ', description: 'Республиканская физмат школа' },
    { id: 'bil', title: 'БИЛ', description: 'Bilim Innovation Lyceum' },
    { id: 'combo', title: 'НИШ + РФМШ + КТЛ', description: 'Три школы — максимальные шансы' }
  ];
  else if (gradeId === 'g7') rows = [
    { id: 'rfmsh', title: 'РФМШ', description: 'Математика, логика, олимпиадные' },
    { id: 'ent', title: 'ЕНТ', description: 'Ранняя подготовка к тестированию' },
    { id: 'basics', title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки' }
  ];
  else if (gradeId === 'g9') rows = [
    { id: 'rfmsh', title: 'РФМШ', description: 'Математика, логика, олимпиадные' },
    { id: 'ent', title: 'ЕНТ', description: 'Подготовка к единому тестированию' },
    { id: 'basics', title: 'Основные предметы', description: 'Алгебра, геометрия, физика, языки' },
    { id: 'govexam', title: 'Гос. экзамены', description: 'Аттестация 9 класс: алгебра, геом.' }
  ];
  else if (gradeId === 'g10') rows = [
    { id: 'ent_tech', title: 'ЕНТ — Техническое', description: 'Математика, физика, информатика' },
    { id: 'ent_bio', title: 'ЕНТ — Биологическое', description: 'Биология, химия, география' }
  ];
  else rows = [{ id: 'nil', title: 'НИШ', description: 'Назарбаев Интеллектуальные Школы' }];

  storeMsg(to, 'out', `📚 Шаг 2 из 2 · ${gradeLabel} — Выберите цель подготовки`);
  await waPost({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: `📚 Шаг 2 из 2 · ${gradeLabel}` },
      body:   { text: 'Отлично! Выберите цель подготовки:' },
      footer: { text: 'SmartClub · рус / каз направление' },
      action: { button: 'Выбрать цель', sections: [{ title: 'Цель подготовки', rows }] }
    }
  });
}

async function sendFlowTemplate(to, gradeId, goalId) {
  const flowToken = `${to}|${gradeId}|${goalId}`;
  storeMsg(to, 'out', '🎯 SmartClub — ваша персональная программа [Флоу]');
  const result = await waPost({
    messaging_product: 'whatsapp', to, type: 'interactive',
    interactive: {
      type: 'flow',
      header: { type: 'text', text: '🎯 SmartClub — ваша программа' },
      body:   { text: 'Мы подобрали программу специально для вашего ребёнка. Нажмите кнопку ниже, чтобы открыть её.' },
      footer: { text: 'SmartClub · Астана' },
      action: { name: 'flow', parameters: { flow_message_version: '3', flow_token: flowToken, flow_id: FLOW_ID, flow_cta: 'Открыть программу →', flow_action: 'data_exchange' } }
    }
  });
  return result;
}

async function sendWelcome(phone) {
  userState.set(phone, { state: 'grade' });
  await sendText(phone,
    `👋 Добро пожаловать в *SmartClub*!\n\n🏆 Каждый второй ученик поступает в *НИШ, РФМШ или БИЛ*\n🎓 *90–100% выпускников получают грант в вуз*\n\nЗанятия ведутся на *русском и казахском* языке.\n\nВсего 2 вопроса — и вы получите персональную программу для вашего ребёнка 👇`
  );
  await sendGradeList(phone);
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN)
    return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg) return;
    const phone = msg.from;
    const st    = userState.get(phone) || { state: 'new' };
    const chat  = getChat(phone);

    if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
      const token = msg.interactive.nfm_reply?.flow_token || '';
      const parts = token.split('|');
      const grade = parts[1] || st.grade || '';
      const goal  = parts[2] || st.goal  || '';
      const now   = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });
      storeMsg(phone, 'in', `[Записался: ${GOAL_LABEL[goal] || goal} · ${GRADE_LABEL[grade] || grade}]`);
      userState.set(phone, { ...st, state: 'name', grade, goal, now });
      await sendText(phone, `🎉 Отличный выбор!\n\nПрограмма: *${GOAL_LABEL[goal] || goal}* · ${GRADE_LABEL[grade] || grade}\n\nПоследний шаг — напишите, пожалуйста, *как зовут вашего ребёнка* 👇`);
      return;
    }

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
          userState.set(phone, { state: 'grade' });
          await sendText(phone, '⚠️ Не удалось открыть карточку. Попробуйте ещё раз 👇');
          await sendGradeList(phone);
        }
      } else if (st.state === 'awaiting_flow') {
        await sendText(phone, `⬆️ Карточка уже отправлена выше.\n\nОткройте её и нажмите *«Записаться»* 👆`);
      } else { await sendWelcome(phone); }
      return;
    }

    if (msg.type === 'text') {
      const text = (msg.text?.body || '').trim();
      storeMsg(phone, 'in', text);
      if (!chat.botActive) return;
      if (st.state === 'name') {
        const { grade, goal, now } = st;
        userState.delete(phone);
        const gradeLabel = GRADE_LABEL[grade] || grade || '—';
        const goalLabel  = GOAL_LABEL[goal]   || goal  || '—';
        chat.name = text; chat.grade = gradeLabel; chat.goal = goalLabel;
        chat.registeredAt = now; chat.status = 'registered';
        await appendToSheet([now, text, phone, gradeLabel, goalLabel, 'Новая заявка']);
        await sendText(phone, `✅ *${text}*, заявка принята!\n\nПрограмма: *${goalLabel}* · ${gradeLabel}\n\nНаш менеджер позвонит вам *в течение 15 минут* и запишет на пробный урок.`);
        await sendText(phone, `🎁 *Что вас ждёт на первом визите:*\n\n📝 Пробный урок — *бесплатно*\n🔍 Диагностика знаний от эксперта — *бесплатно*\n📊 Личный план подготовки\n👨‍🏫 Знакомство с преподавателем\n\nВсё без обязательств 💪`);
        await sendText(phone, `📍 *Как нас найти:*\n\nАстана, Первая линия, *SmartClub*\n🗺 https://2gis.kz/astana/geo/70000001102430714\n\n🕐 Пн–Сб · 09:00–20:00\n\nЖдём вас! 🌟`);
        chat.botActive = false;
        sseNotify({ type: 'bot_toggle', phone, botActive: false });
      } else if (st.state === 'awaiting_flow') {
        await sendText(phone, `⬆️ Карточка уже отправлена выше. Откройте её и нажмите *«Записаться»* 👆`);
      } else {
        if (!chat.greeted) { chat.greeted = true; await sendWelcome(phone); }
      }
    }
  } catch (err) { console.error('❌ Webhook error:', err.message); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PWA ADMIN API
// ═══════════════════════════════════════════════════════════════════════════════

app.get('/admin/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) { clearInterval(hb); sseClients.delete(res); } }, 25000);
  req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
});

app.get('/admin/api/chats', (_req, res) => {
  const list = [...chats.entries()].map(([phone, c]) => ({
    phone, unread: c.unread, botActive: c.botActive, status: c.status,
    lastMsg: c.lastMsg, lastTime: c.lastTime, name: c.name,
    grade: c.grade, goal: c.goal, registeredAt: c.registeredAt, msgCount: c.messages.length
  })).sort((a, b) => (b.lastTime || '').localeCompare(a.lastTime || ''));
  res.json(list);
});

app.get('/admin/api/chat/:phone', (req, res) => {
  const c = chats.get(req.params.phone);
  if (!c) return res.json({ messages: [], botActive: true, status: 'new' });
  c.unread = 0;
  sseNotify({ type: 'read', phone: req.params.phone });
  res.json({ messages: c.messages, botActive: c.botActive, status: c.status, name: c.name, grade: c.grade, goal: c.goal });
});

app.post('/admin/api/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone & text required' });
  getChat(phone).botActive = false;
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

app.post('/admin/api/status', (req, res) => {
  const { phone, status } = req.body;
  if (!phone || !status) return res.status(400).json({ error: 'phone & status required' });
  const chat = getChat(phone);
  chat.status = status;
  sseNotify({ type: 'status_change', phone, status });
  res.json({ status });
});

app.get('/admin/api/stats', (_req, res) => {
  const all = [...chats.values()];
  const registered = all.filter(c => c.registeredAt);
  const today = new Date().toDateString();
  const byGoal = {}, byGrade = {};
  registered.forEach(c => {
    byGoal[c.goal || '—']  = (byGoal[c.goal  || '—'] || 0) + 1;
    byGrade[c.grade || '—'] = (byGrade[c.grade || '—'] || 0) + 1;
  });
  const byStatus = {};
  all.forEach(c => { byStatus[c.status || 'new'] = (byStatus[c.status || 'new'] || 0) + 1; });
  // last 7 days
  const daily = {};
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    daily[d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })] = 0;
  }
  registered.forEach(c => {
    if (!c.registeredAt) return;
    const d = new Date(c.registeredAt.split(', ')[0].split('.').reverse().join('-'));
    const key = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    if (key in daily) daily[key]++;
  });
  res.json({
    totalChats: chats.size,
    totalRegistered: registered.length,
    todayRegistered: registered.filter(c => c.registeredAt && new Date(c.registeredAt).toDateString() === today).length,
    activeBot: all.filter(c => c.botActive).length,
    byGoal, byGrade, byStatus, daily
  });
});

app.get('/manifest.json', (_req, res) => res.json({
  name: 'SmartClub CRM', short_name: 'SmartClub', start_url: '/admin',
  display: 'standalone', background_color: '#0f172a', theme_color: '#6366f1',
  icons: [{ src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='24' fill='%236366f1'/%3E%3Ctext y='.9em' font-size='70' x='15'%3E%F0%9F%92%AC%3C/text%3E%3C/svg%3E", sizes: '192x192', type: 'image/svg+xml' }]
}));

app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`self.addEventListener('push',e=>{const d=e.data?e.data.json():{};self.registration.showNotification(d.title||'SmartClub',{body:d.body||'',icon:'/favicon.ico'})});`);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  PWA HTML
// ═══════════════════════════════════════════════════════════════════════════════
const SHEETS_URL = SPREADSHEET_ID ? `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit?usp=sharing&rm=minimal` : '';

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"/>
<title>SmartClub CRM</title>
<link rel="manifest" href="/manifest.json"/>
<style>
/* ── CSS Variables / Themes ─────────────────────────────────────────────── */
:root {
  --accent:    #6366f1;
  --accent2:   #8b5cf6;
  --green:     #10b981;
  --red:       #ef4444;
  --yellow:    #f59e0b;
  --blue:      #3b82f6;
  --radius:    14px;
  --radius-sm: 8px;
  --shadow:    0 4px 24px rgba(0,0,0,.18);
  --trans:     .2s ease;
}
[data-theme="dark"] {
  --bg:        #0f172a;
  --bg2:       #1e293b;
  --surface:   #1e293b;
  --surface2:  #334155;
  --border:    #334155;
  --text:      #f1f5f9;
  --text2:     #94a3b8;
  --text3:     #64748b;
  --msg-in:    #1e293b;
  --msg-out:   #312e81;
  --input-bg:  #0f172a;
}
[data-theme="light"] {
  --bg:        #f1f5f9;
  --bg2:       #e2e8f0;
  --surface:   #ffffff;
  --surface2:  #f8fafc;
  --border:    #e2e8f0;
  --text:      #0f172a;
  --text2:     #475569;
  --text3:     #94a3b8;
  --msg-in:    #f1f5f9;
  --msg-out:   #e0e7ff;
  --input-bg:  #f1f5f9;
}
[data-theme="smartclub"] {
  --bg:        #0a0a1a;
  --bg2:       #12122a;
  --surface:   #16163a;
  --surface2:  #1e1e4a;
  --border:    #2d2d6b;
  --text:      #e0e7ff;
  --text2:     #a5b4fc;
  --text3:     #6366f1;
  --msg-in:    #1e1e4a;
  --msg-out:   #312e81;
  --input-bg:  #0a0a1a;
}

/* ── Reset ──────────────────────────────────────────────────────────────── */
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100dvh;overflow:hidden;display:flex;flex-direction:column;transition:background var(--trans),color var(--trans);}

/* ── Scrollbar ──────────────────────────────────────────────────────────── */
::-webkit-scrollbar{width:4px;} ::-webkit-scrollbar-track{background:transparent;} ::-webkit-scrollbar-thumb{background:var(--border);border-radius:4px;}

/* ── Top Header ─────────────────────────────────────────────────────────── */
#topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:0 16px;height:56px;display:flex;align-items:center;gap:12px;flex-shrink:0;position:relative;z-index:10;}
#topbar-logo{width:36px;height:36px;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
#topbar-title{flex:1;}
#topbar-title h1{font-size:16px;font-weight:700;color:var(--text);letter-spacing:-.3px;}
#topbar-title p{font-size:12px;color:var(--text3);margin-top:1px;}
#conn-dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;box-shadow:0 0 6px var(--green);}
#conn-dot.off{background:var(--red);box-shadow:0 0 6px var(--red);}

/* Theme switcher */
#theme-switcher{display:flex;gap:4px;background:var(--bg);border-radius:10px;padding:3px;}
.theme-btn{width:28px;height:28px;border-radius:7px;border:none;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;background:transparent;transition:background var(--trans);}
.theme-btn.active,.theme-btn:hover{background:var(--surface2);}

/* ── Screens ─────────────────────────────────────────────────────────────── */
#screens{flex:1;overflow:hidden;display:flex;flex-direction:column;}
.screen{display:none;flex:1;flex-direction:column;overflow:hidden;}
.screen.active{display:flex;}

/* ── Tab bar ─────────────────────────────────────────────────────────────── */
#tabbar{display:flex;background:var(--surface);border-top:1px solid var(--border);flex-shrink:0;}
.tab{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:8px 4px 10px;cursor:pointer;color:var(--text3);font-size:10px;font-weight:600;gap:3px;border:none;background:none;transition:color var(--trans);position:relative;text-transform:uppercase;letter-spacing:.5px;}
.tab .ti{font-size:20px;transition:transform var(--trans);}
.tab.active{color:var(--accent);}
.tab.active .ti{transform:scale(1.15);}
.tab-badge{position:absolute;top:6px;right:calc(50% - 14px);background:var(--red);color:#fff;font-size:10px;font-weight:700;min-width:16px;height:16px;border-radius:8px;display:flex;align-items:center;justify-content:center;padding:0 3px;}

/* ══ CHATS SCREEN ══════════════════════════════════════════════════════════ */
#s-chats{flex-direction:row;}

/* Sidebar */
#sidebar{width:100%;max-width:340px;display:flex;flex-direction:column;border-right:1px solid var(--border);background:var(--surface);flex-shrink:0;}
#sidebar-top{padding:12px;}
#search-wrap{position:relative;}
#search-icon{position:absolute;left:11px;top:50%;transform:translateY(-50%);font-size:14px;color:var(--text3);}
#search-input{width:100%;background:var(--input-bg);border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px 9px 34px;color:var(--text);font-size:14px;outline:none;transition:border var(--trans);}
#search-input:focus{border-color:var(--accent);}
#search-input::placeholder{color:var(--text3);}

/* Filter chips */
#filter-chips{display:flex;gap:6px;padding:0 12px 10px;overflow-x:auto;scrollbar-width:none;}
#filter-chips::-webkit-scrollbar{display:none;}
.chip{border:1.5px solid var(--border);border-radius:20px;padding:4px 12px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;color:var(--text2);background:transparent;transition:all var(--trans);}
.chip.active{background:var(--accent);border-color:var(--accent);color:#fff;}

#chat-list{flex:1;overflow-y:auto;}
.ci{display:flex;align-items:center;padding:12px 14px;cursor:pointer;border-bottom:1px solid var(--border);gap:11px;transition:background var(--trans);position:relative;}
.ci:hover{background:var(--surface2);}
.ci.active{background:var(--surface2);}
.ci.active::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);border-radius:0 2px 2px 0;}

/* Avatar */
.av{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0;color:#fff;position:relative;}
.av-status{position:absolute;bottom:0;right:0;width:11px;height:11px;border-radius:50%;border:2px solid var(--surface);}

.ci-body{flex:1;min-width:0;}
.ci-row1{display:flex;justify-content:space-between;align-items:center;gap:4px;}
.ci-name{font-size:14px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.ci-time{font-size:11px;color:var(--text3);flex-shrink:0;}
.ci-row2{display:flex;justify-content:space-between;align-items:center;gap:4px;margin-top:2px;}
.ci-prev{font-size:13px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;}
.ci-badges{display:flex;gap:4px;align-items:center;flex-shrink:0;}
.unread{background:var(--accent);color:#fff;font-size:10px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:flex;align-items:center;justify-content:center;padding:0 4px;}
.bot-pill{font-size:10px;color:var(--text3);}

/* Status badges */
.sbadge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;white-space:nowrap;}
.sbadge.new       {background:#1e293b;color:#94a3b8;}
.sbadge.call      {background:#fef3c7;color:#d97706;}
.sbadge.reply     {background:#dbeafe;color:#2563eb;}
.sbadge.registered{background:#d1fae5;color:#059669;}
.sbadge.declined  {background:#fee2e2;color:#dc2626;}
[data-theme="dark"] .sbadge.call      {background:#422006;color:#fbbf24;}
[data-theme="dark"] .sbadge.reply     {background:#1e3a5f;color:#60a5fa;}
[data-theme="dark"] .sbadge.registered{background:#064e3b;color:#34d399;}
[data-theme="dark"] .sbadge.declined  {background:#4b0000;color:#f87171;}
[data-theme="smartclub"] .sbadge.call      {background:#3b1d00;color:#fbbf24;}
[data-theme="smartclub"] .sbadge.reply     {background:#0e2044;color:#93c5fd;}
[data-theme="smartclub"] .sbadge.registered{background:#032a1a;color:#6ee7b7;}
[data-theme="smartclub"] .sbadge.declined  {background:#2d0000;color:#fca5a5;}

.empty{text-align:center;padding:48px 20px;color:var(--text3);font-size:14px;}

/* ── Conversation ─────────────────────────────────────────────────────────── */
#conv{flex:1;display:flex;flex-direction:column;background:var(--bg);overflow:hidden;}

#conv-header{background:var(--surface);border-bottom:1px solid var(--border);padding:10px 14px;display:flex;align-items:center;gap:10px;min-height:58px;flex-shrink:0;}
#back-btn{background:none;border:none;color:var(--text2);font-size:22px;cursor:pointer;padding:0 6px;display:none;line-height:1;}
#conv-av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;flex-shrink:0;color:#fff;}
#conv-info{flex:1;min-width:0;}
#conv-name{font-size:15px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#conv-sub{font-size:12px;color:var(--text3);margin-top:1px;}

/* Header actions */
#conv-actions{display:flex;gap:6px;align-items:center;flex-shrink:0;}
#status-select{background:var(--surface2);border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:5px 8px;color:var(--text);font-size:12px;font-weight:600;cursor:pointer;outline:none;}
#bot-btn{border:none;font-size:12px;font-weight:700;padding:6px 12px;border-radius:20px;cursor:pointer;transition:all var(--trans);white-space:nowrap;}
#bot-btn.on {background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;box-shadow:0 2px 8px rgba(99,102,241,.4);}
#bot-btn.off{background:var(--surface2);color:var(--text2);}

/* Messages */
#messages{flex:1;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:4px;}
.m{max-width:72%;padding:9px 13px;border-radius:12px;font-size:14px;line-height:1.5;word-wrap:break-word;animation:fadeUp .15s ease;}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.m.in {background:var(--msg-in);border-bottom-left-radius:3px;align-self:flex-start;color:var(--text);}
.m.out{background:var(--msg-out);border-bottom-right-radius:3px;align-self:flex-end;color:var(--text);}
.m-t{font-size:10px;color:var(--text3);display:block;margin-top:4px;text-align:right;}
.m-sys{text-align:center;color:var(--text3);font-size:11px;background:var(--surface);padding:4px 12px;border-radius:10px;align-self:center;margin:4px 0;}
.date-sep{text-align:center;color:var(--text3);font-size:11px;font-weight:600;padding:8px 0;}

/* Quick replies */
#quick-replies{padding:8px 12px;display:flex;gap:6px;overflow-x:auto;flex-shrink:0;scrollbar-width:none;border-top:1px solid var(--border);}
#quick-replies::-webkit-scrollbar{display:none;}
.qr{background:var(--surface2);border:1.5px solid var(--border);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:600;color:var(--accent);cursor:pointer;white-space:nowrap;transition:all var(--trans);}
.qr:hover{background:var(--accent);color:#fff;border-color:var(--accent);}

/* Input bar */
#input-bar{background:var(--surface);border-top:1px solid var(--border);padding:10px 12px;display:flex;align-items:flex-end;gap:8px;flex-shrink:0;}
#msg-inp{flex:1;background:var(--input-bg);border:1.5px solid var(--border);border-radius:var(--radius-sm);padding:10px 13px;color:var(--text);font-size:14px;outline:none;resize:none;max-height:120px;min-height:42px;font-family:inherit;line-height:1.4;transition:border var(--trans);}
#msg-inp:focus{border-color:var(--accent);}
#msg-inp::placeholder{color:var(--text3);}
#send-btn{width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;cursor:pointer;color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all var(--trans);box-shadow:0 2px 8px rgba(99,102,241,.4);}
#send-btn:hover{transform:scale(1.08);}
#send-btn:active{transform:scale(.95);}

/* No chat placeholder */
#no-chat{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px;color:var(--text3);background:var(--bg);}
#no-chat .nc-icon{font-size:80px;opacity:.15;}
#no-chat p{font-size:16px;font-weight:500;}

/* ══ ANALYTICS ═════════════════════════════════════════════════════════════ */
#s-analytics{background:var(--bg);}
#analytics-inner{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;}

.kpi-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
.kpi{background:var(--surface);border-radius:var(--radius);padding:16px;border:1px solid var(--border);position:relative;overflow:hidden;}
.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;}
.kpi.k1::before{background:linear-gradient(90deg,var(--accent),var(--accent2));}
.kpi.k2::before{background:linear-gradient(90deg,var(--green),#34d399);}
.kpi.k3::before{background:linear-gradient(90deg,var(--yellow),#fbbf24);}
.kpi.k4::before{background:linear-gradient(90deg,var(--blue),#60a5fa);}
.kpi-num{font-size:32px;font-weight:800;color:var(--text);line-height:1;}
.kpi-lbl{font-size:12px;color:var(--text3);margin-top:6px;font-weight:500;}
.kpi-icon{position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:32px;opacity:.15;}

.card{background:var(--surface);border-radius:var(--radius);padding:16px;border:1px solid var(--border);}
.card-title{font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px;display:flex;align-items:center;gap:6px;}

/* Bar chart */
.bar-row{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.bar-lbl{font-size:12px;color:var(--text2);width:120px;flex-shrink:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.bar-wrap{flex:1;background:var(--bg);border-radius:4px;height:18px;overflow:hidden;}
.bar-fill{height:100%;background:linear-gradient(90deg,var(--accent),var(--accent2));border-radius:4px;transition:width .6s ease;min-width:3px;}
.bar-fill.green{background:linear-gradient(90deg,var(--green),#34d399);}
.bar-cnt{font-size:12px;color:var(--text3);width:24px;text-align:right;flex-shrink:0;font-weight:600;}

/* Mini chart (daily) */
#daily-chart{display:flex;align-items:flex-end;gap:4px;height:60px;padding-top:4px;}
.day-bar-wrap{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;}
.day-bar{width:100%;border-radius:4px 4px 0 0;background:linear-gradient(0deg,var(--accent),var(--accent2));min-height:3px;transition:height .4s ease;}
.day-lbl{font-size:9px;color:var(--text3);white-space:nowrap;}

/* Status donut */
.status-row{display:flex;align-items:center;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border);}
.status-row:last-child{border-bottom:none;}
.status-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.status-name{font-size:13px;color:var(--text2);flex:1;margin-left:10px;}
.status-pct{font-size:13px;font-weight:700;color:var(--text);}

/* All chats table */
.tbl{width:100%;border-collapse:collapse;}
.tbl th{font-size:11px;color:var(--text3);text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);text-transform:uppercase;letter-spacing:.5px;}
.tbl td{font-size:13px;color:var(--text);padding:9px 8px;border-bottom:1px solid var(--border);}
.tbl tr:last-child td{border-bottom:none;}
.tbl tr:hover td{background:var(--surface2);}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:rgba(99,102,241,.15);color:var(--accent);}

/* ══ SHEETS ════════════════════════════════════════════════════════════════ */
#s-sheets{background:var(--bg);}
#sheets-frame{flex:1;border:none;width:100%;height:100%;border-radius:0;}
#sheets-empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--text3);padding:32px;text-align:center;}
#sheets-empty .bi{font-size:56px;opacity:.25;}

/* ── Toast ──────────────────────────────────────────────────────────────── */
#toast{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--surface2);color:var(--text);padding:10px 20px;border-radius:20px;font-size:13px;font-weight:600;opacity:0;transition:all .3s;z-index:999;pointer-events:none;border:1px solid var(--border);}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0);}

/* ── Mobile ─────────────────────────────────────────────────────────────── */
@media(max-width:680px){
  #sidebar{max-width:100%;}
  #conv{position:fixed;inset:0;bottom:56px;transform:translateX(100%);transition:transform .28s cubic-bezier(.4,0,.2,1);z-index:20;}
  #conv.open{transform:translateX(0);}
  #back-btn{display:flex!important;}
  #no-chat{display:none;}
  .kpi-num{font-size:26px;}
}
</style>
</head>
<body data-theme="dark">

<!-- Top header -->
<div id="topbar">
  <div id="topbar-logo">💬</div>
  <div id="topbar-title">
    <h1>SmartClub CRM</h1>
    <p id="greeting">Загрузка...</p>
  </div>
  <div id="conn-dot" title="Подключено"></div>
  <div id="theme-switcher">
    <button class="theme-btn active" onclick="setTheme('dark',this)"   title="Тёмная">🌙</button>
    <button class="theme-btn"        onclick="setTheme('light',this)"  title="Светлая">☀️</button>
    <button class="theme-btn"        onclick="setTheme('smartclub',this)" title="SmartClub">✨</button>
  </div>
</div>

<div id="screens">

  <!-- ══ CHATS ══ -->
  <div id="s-chats" class="screen active">
    <div id="sidebar">
      <div id="sidebar-top">
        <div id="search-wrap">
          <span id="search-icon">🔍</span>
          <input id="search-input" type="search" placeholder="Поиск по имени или номеру..." oninput="filterChats()"/>
        </div>
      </div>
      <div id="filter-chips">
        <button class="chip active" onclick="setFilter('all',this)">Все</button>
        <button class="chip" onclick="setFilter('new',this)">🆕 Новые</button>
        <button class="chip" onclick="setFilter('call',this)">📞 Позвонить</button>
        <button class="chip" onclick="setFilter('reply',this)">💬 Ответить</button>
        <button class="chip" onclick="setFilter('registered',this)">✅ Записан</button>
        <button class="chip" onclick="setFilter('unread',this)">🔴 Непрочитанные</button>
      </div>
      <div id="chat-list"><div class="empty">Загрузка чатов...</div></div>
    </div>

    <div id="no-chat">
      <div class="nc-icon">💬</div>
      <p>Выберите чат из списка</p>
    </div>

    <div id="conv">
      <div id="conv-header">
        <button id="back-btn" onclick="closeConv()">←</button>
        <div id="conv-av">👤</div>
        <div id="conv-info">
          <div id="conv-name">—</div>
          <div id="conv-sub">—</div>
        </div>
        <div id="conv-actions">
          <select id="status-select" onchange="setStatus(this.value)">
            <option value="new">🆕 Новый</option>
            <option value="call">📞 Позвонить</option>
            <option value="reply">💬 Ответить</option>
            <option value="registered">✅ Записан</option>
            <option value="declined">🚫 Отказ</option>
          </select>
          <button id="bot-btn" class="on" onclick="toggleBot()">🤖 Бот</button>
        </div>
      </div>
      <div id="messages"></div>
      <div id="quick-replies">
        <button class="qr" onclick="insertQR('Здравствуйте! Скоро с вами свяжемся 😊')">Здравствуйте</button>
        <button class="qr" onclick="insertQR('Записали вас на пробный урок! Ждём вас 🎉')">Записали</button>
        <button class="qr" onclick="insertQR('Наш адрес: Астана, Первая линия, SmartClub. Пн–Сб 09:00–20:00')">Адрес</button>
        <button class="qr" onclick="insertQR('Перезвоним вам в течение 15 минут!')">Перезвоним</button>
        <button class="qr" onclick="insertQR('Есть вопросы? Мы всегда готовы помочь! 👨‍🏫')">Есть вопросы?</button>
      </div>
      <div id="input-bar">
        <textarea id="msg-inp" placeholder="Написать сообщение..." rows="1"
          oninput="autoResize(this)"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"></textarea>
        <button id="send-btn" onclick="sendMsg()">➤</button>
      </div>
    </div>
  </div>

  <!-- ══ ANALYTICS ══ -->
  <div id="s-analytics" class="screen">
    <div id="analytics-inner">

      <div class="kpi-grid">
        <div class="kpi k1"><div class="kpi-num" id="st-total">—</div><div class="kpi-lbl">Всего чатов</div><div class="kpi-icon">💬</div></div>
        <div class="kpi k2"><div class="kpi-num" id="st-reg">—</div><div class="kpi-lbl">Заявок всего</div><div class="kpi-icon">✅</div></div>
        <div class="kpi k3"><div class="kpi-num" id="st-today">—</div><div class="kpi-lbl">Сегодня</div><div class="kpi-icon">📅</div></div>
        <div class="kpi k4"><div class="kpi-num" id="st-bot">—</div><div class="kpi-lbl">Бот активен</div><div class="kpi-icon">🤖</div></div>
      </div>

      <div class="card">
        <div class="card-title">📈 Заявки за 7 дней</div>
        <div id="daily-chart"></div>
      </div>

      <div class="card">
        <div class="card-title">🎯 Статусы лидов</div>
        <div id="status-breakdown"></div>
      </div>

      <div class="card">
        <div class="card-title">📚 По программам</div>
        <div id="chart-goal"></div>
      </div>

      <div class="card">
        <div class="card-title">🏫 По классам</div>
        <div id="chart-grade"></div>
      </div>

      <div class="card">
        <div class="card-title">👥 Все обращения</div>
        <table class="tbl">
          <thead><tr>
            <th>Телефон</th><th>Имя</th><th>Класс</th><th>Программа</th><th>Статус</th><th>Время</th>
          </tr></thead>
          <tbody id="all-tbody"></tbody>
        </table>
      </div>

    </div>
  </div>

  <!-- ══ SHEETS ══ -->
  <div id="s-sheets" class="screen">
    ${SHEETS_URL
      ? `<iframe id="sheets-frame" src="${SHEETS_URL}" allow="fullscreen"></iframe>`
      : `<div id="sheets-empty"><div class="bi">📋</div><p style="font-weight:600">Google Sheets не подключён</p><p style="font-size:13px;margin-top:6px">Добавьте переменную <strong>SPREADSHEET_ID</strong> в Railway</p></div>`}
  </div>

</div>

<!-- Tab bar -->
<div id="tabbar">
  <button class="tab active" onclick="switchTab('chats',this)" id="tab-chats">
    <span class="ti">💬</span>Чаты<span class="tab-badge" id="total-badge" style="display:none"></span>
  </button>
  <button class="tab" onclick="switchTab('analytics',this)">
    <span class="ti">📊</span>Аналитика
  </button>
  <button class="tab" onclick="switchTab('sheets',this)">
    <span class="ti">📋</span>Таблица
  </button>
</div>

<div id="toast"></div>

<script>
// ── State ─────────────────────────────────────────────────────────────────────
let activePhone  = null;
let chatsData    = [];
let filterStatus = 'all';
let sseConn      = null;
let audioCtx     = null;

// ── Theme ─────────────────────────────────────────────────────────────────────
function setTheme(t, btn) {
  document.body.setAttribute('data-theme', t);
  localStorage.setItem('sc_theme', t);
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}
(function(){
  const t = localStorage.getItem('sc_theme') || 'dark';
  setTheme(t);
  const idx = {dark:0,light:1,smartclub:2}[t]||0;
  document.querySelectorAll('.theme-btn')[idx]?.classList.add('active');
})();

// ── Greeting ──────────────────────────────────────────────────────────────────
function setGreeting() {
  const h = new Date().getHours();
  const g = h < 12 ? 'Доброе утро' : h < 17 ? 'Добрый день' : 'Добрый вечер';
  document.getElementById('greeting').textContent = g + ', SmartClub 👋';
}
setGreeting();

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('s-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
  if (name === 'analytics') loadAnalytics();
}

// ── Filter ────────────────────────────────────────────────────────────────────
function setFilter(f, btn) {
  filterStatus = f;
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderList(chatsData);
}

function getFiltered(list) {
  const q = document.getElementById('search-input').value.toLowerCase();
  return list.filter(c => {
    if (q && !c.phone.includes(q) && !(c.name||'').toLowerCase().includes(q)) return false;
    if (filterStatus === 'all') return true;
    if (filterStatus === 'unread') return c.unread > 0;
    return c.status === filterStatus;
  });
}

// ── Load chats ────────────────────────────────────────────────────────────────
function loadChats() {
  fetch('/admin/api/chats').then(r => r.json()).then(list => {
    chatsData = list;
    renderList(list);
    updateTotalBadge();
  });
}

function renderList(list) {
  const el  = document.getElementById('chat-list');
  const filtered = getFiltered(list);
  if (!filtered.length) { el.innerHTML = \`<div class="empty">Нет чатов</div>\`; return; }
  el.innerHTML = filtered.map(c => {
    const av  = avatarColor(c.phone);
    const ini = initials(c.name || c.phone);
    const dotColor = c.botActive ? 'var(--green)' : 'var(--text3)';
    return \`<div class="ci\${c.phone===activePhone?' active':''}" onclick="openChat('\${c.phone}')">
      <div class="av" style="background:\${av}">
        \${ini}
        <div class="av-status" style="background:\${dotColor}"></div>
      </div>
      <div class="ci-body">
        <div class="ci-row1">
          <div class="ci-name">\${esc(c.name || fmtPhone(c.phone))}</div>
          <div class="ci-time">\${fmtTime(c.lastTime)}</div>
        </div>
        <div class="ci-row2">
          <div class="ci-prev">\${esc(c.lastMsg || 'Нет сообщений')}</div>
          <div class="ci-badges">
            \${c.unread > 0 ? \`<div class="unread">\${c.unread}</div>\` : ''}
            <span class="sbadge \${c.status||'new'}">\${statusLabel(c.status)}</span>
          </div>
        </div>
      </div>
    </div>\`;
  }).join('');
}

function filterChats() { renderList(chatsData); }

function updateTotalBadge() {
  const total = chatsData.reduce((s,c) => s + (c.unread||0), 0);
  const el = document.getElementById('total-badge');
  if (total > 0) { el.textContent = total; el.style.display = 'flex'; }
  else el.style.display = 'none';
}

// ── Open chat ─────────────────────────────────────────────────────────────────
function openChat(phone) {
  activePhone = phone;
  const c = chatsData.find(x => x.phone === phone) || {};
  document.getElementById('conv-name').textContent = c.name || fmtPhone(phone);
  document.getElementById('conv-sub').textContent  = c.grade && c.goal ? \`\${c.grade} · \${c.goal}\` : (c.botActive!==false?'🤖 Бот активен':'👨‍💼 Менеджер');
  const av = avatarColor(phone);
  document.getElementById('conv-av').style.background = av;
  document.getElementById('conv-av').textContent = initials(c.name||phone);
  setBotBtn(c.botActive !== false);
  document.getElementById('conv').classList.add('open');
  renderList(chatsData);

  fetch(\`/admin/api/chat/\${phone}\`).then(r => r.json()).then(data => {
    setBotBtn(data.botActive !== false);
    document.getElementById('status-select').value = data.status || 'new';
    renderMsgs(data.messages || []);
    const e = chatsData.find(x => x.phone === phone);
    if (e) { e.unread = 0; renderList(chatsData); updateTotalBadge(); }
  });
}

function closeConv() {
  document.getElementById('conv').classList.remove('open');
  activePhone = null;
  renderList(chatsData);
}

// ── Messages ──────────────────────────────────────────────────────────────────
function renderMsgs(msgs) {
  const el = document.getElementById('messages');
  if (!msgs.length) { el.innerHTML = '<div class="m-sys">Нет сообщений</div>'; return; }
  let html = '', lastDate = '';
  msgs.forEach(m => {
    const d = new Date(m.time).toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
    if (d !== lastDate) { html += \`<div class="date-sep">\${d}</div>\`; lastDate = d; }
    html += \`<div class="m \${m.dir}">\${esc(m.text)}<span class="m-t">\${fmtTime(m.time)}</span></div>\`;
  });
  el.innerHTML = html;
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
  fetch('/admin/api/send', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:activePhone,text}) })
    .then(() => loadChats());
}

function insertQR(text) {
  const inp = document.getElementById('msg-inp');
  inp.value = text; autoResize(inp); inp.focus();
}

function autoResize(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,120)+'px'; }

// ── Bot toggle ────────────────────────────────────────────────────────────────
function toggleBot() {
  if (!activePhone) return;
  fetch('/admin/api/toggle-bot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:activePhone}) })
    .then(r => r.json()).then(d => {
      setBotBtn(d.botActive);
      const e = chatsData.find(x => x.phone===activePhone);
      if (e) { e.botActive = d.botActive; renderList(chatsData); }
      toast(d.botActive ? '🤖 Бот включён' : '👤 Менеджер взял чат');
    });
}

function setBotBtn(on) {
  const b = document.getElementById('bot-btn');
  b.className = on ? 'on' : 'off';
  b.textContent = on ? '🤖 Бот' : '👤 Бот выкл';
}

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(val) {
  if (!activePhone) return;
  fetch('/admin/api/status', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({phone:activePhone,status:val}) })
    .then(() => {
      const e = chatsData.find(x => x.phone===activePhone);
      if (e) { e.status = val; renderList(chatsData); }
      toast('Статус: ' + statusLabel(val));
    });
}

// ── Analytics ─────────────────────────────────────────────────────────────────
function loadAnalytics() {
  fetch('/admin/api/stats').then(r => r.json()).then(s => {
    animateNum('st-total', s.totalChats);
    animateNum('st-reg',   s.totalRegistered);
    animateNum('st-today', s.todayRegistered);
    animateNum('st-bot',   s.activeBot);
    renderDailyChart(s.daily || {});
    renderStatusBreakdown(s.byStatus || {}, s.totalChats);
    renderBars('chart-goal',  s.byGoal,  false);
    renderBars('chart-grade', s.byGrade, true);
  });
  fetch('/admin/api/chats').then(r => r.json()).then(list => {
    const tbody = document.getElementById('all-tbody');
    if (!list.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:20px">Нет данных</td></tr>'; return; }
    tbody.innerHTML = list.map(c => \`<tr>
      <td style="color:var(--text3);font-size:12px">\${fmtPhone(c.phone)}</td>
      <td style="font-weight:600">\${esc(c.name||'—')}</td>
      <td style="font-size:12px">\${esc(c.grade||'—')}</td>
      <td>\${c.goal?\`<span class="tag">\${esc(c.goal)}</span>\`:'—'}</td>
      <td><span class="sbadge \${c.status||'new'}">\${statusLabel(c.status)}</span></td>
      <td style="color:var(--text3);font-size:11px">\${fmtTime(c.registeredAt||c.lastTime)}</td>
    </tr>\`).join('');
  });
}

function renderDailyChart(daily) {
  const el = document.getElementById('daily-chart');
  const entries = Object.entries(daily);
  const max = Math.max(...entries.map(e=>e[1]), 1);
  el.innerHTML = entries.map(([d,v]) => \`
    <div class="day-bar-wrap">
      <div class="day-bar" style="height:\${Math.max(v/max*56,3)}px"></div>
      <div class="day-lbl">\${d}</div>
    </div>
  \`).join('');
}

function renderStatusBreakdown(byStatus, total) {
  const el = document.getElementById('status-breakdown');
  const colors = { new:'var(--text3)', call:'var(--yellow)', reply:'var(--blue)', registered:'var(--green)', declined:'var(--red)' };
  const entries = Object.entries(byStatus).sort((a,b)=>b[1]-a[1]);
  el.innerHTML = entries.map(([k,v]) => \`
    <div class="status-row">
      <div class="status-dot" style="background:\${colors[k]||'var(--accent)'}"></div>
      <div class="status-name">\${statusLabel(k)}</div>
      <div class="status-pct">\${v} <span style="color:var(--text3);font-weight:400;font-size:12px">(\${total?Math.round(v/total*100):0}%)</span></div>
    </div>
  \`).join('');
}

function renderBars(elId, data, green) {
  const el = document.getElementById(elId);
  const entries = Object.entries(data||{}).sort((a,b)=>b[1]-a[1]);
  if (!entries.length) { el.innerHTML = '<div style="color:var(--text3);font-size:13px">Нет данных</div>'; return; }
  const max = entries[0][1];
  el.innerHTML = entries.map(([k,v]) => \`
    <div class="bar-row">
      <div class="bar-lbl" title="\${esc(k)}">\${esc(k)}</div>
      <div class="bar-wrap"><div class="bar-fill\${green?' green':''}" style="width:\${Math.round(v/max*100)}%"></div></div>
      <div class="bar-cnt">\${v}</div>
    </div>
  \`).join('');
}

function animateNum(id, target) {
  const el = document.getElementById(id);
  const start = 0, dur = 600;
  const startTime = performance.now();
  const step = now => {
    const p = Math.min((now-startTime)/dur, 1);
    el.textContent = Math.round(start + (target-start) * p);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function connectSSE() {
  if (sseConn) sseConn.close();
  sseConn = new EventSource('/admin/events');
  document.getElementById('conn-dot').classList.remove('off');
  sseConn.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'message') {
        let entry = chatsData.find(x => x.phone===d.phone);
        if (!entry) { entry={phone:d.phone,unread:0,botActive:true,lastMsg:'',lastTime:'',status:'new'}; chatsData.unshift(entry); }
        entry.lastMsg = d.text.slice(0,80); entry.lastTime = d.time;
        if (d.dir==='in' && d.phone!==activePhone) { entry.unread++; playSound(); showNotif(d.phone,d.text); }
        if (d.phone===activePhone) appendMsg(d);
        renderList(chatsData); updateTotalBadge();
      } else if (d.type==='read') {
        const entry=chatsData.find(x=>x.phone===d.phone); if(entry){entry.unread=0;renderList(chatsData);updateTotalBadge();}
      } else if (d.type==='bot_toggle') {
        const entry=chatsData.find(x=>x.phone===d.phone); if(entry){entry.botActive=d.botActive;renderList(chatsData);}
      } else if (d.type==='status_change') {
        const entry=chatsData.find(x=>x.phone===d.phone); if(entry){entry.status=d.status;renderList(chatsData);}
      }
    } catch(_){}
  };
  sseConn.onerror = () => { document.getElementById('conn-dot').classList.add('off'); setTimeout(connectSSE,3000); };
}

// ── Sound notification ────────────────────────────────────────────────────────
function playSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioCtx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
    osc.start(); osc.stop(audioCtx.currentTime + 0.3);
  } catch(_){}
}

// ── Browser notifications ──────────────────────────────────────────────────────
function showNotif(phone, text) {
  if ('Notification' in window && Notification.permission==='granted')
    new Notification('SmartClub · ' + fmtPhone(phone), { body: text.slice(0,80), icon: '/favicon.ico' });
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
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
  if (!s) return '?';
  const p = s.trim().split(' ');
  if (p[0].match(/^\\d/)) return s.slice(-2);
  return ((p[0][0]||'')+(p[1]?.[0]||'')).toUpperCase();
}
const AVATAR_COLORS = ['#6366f1','#8b5cf6','#ec4899','#10b981','#f59e0b','#3b82f6','#ef4444','#06b6d4'];
function avatarColor(phone) {
  let h = 0;
  for (let i=0; i<phone.length; i++) h = (h*31 + phone.charCodeAt(i)) & 0xffffffff;
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
}
function statusLabel(s) {
  return {new:'🆕 Новый',call:'📞 Позвонить',reply:'💬 Ответить',registered:'✅ Записан',declined:'🚫 Отказ'}[s] || '🆕 Новый';
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadChats();
connectSSE();
if ('Notification' in window && Notification.permission==='default') Notification.requestPermission();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(()=>{});
// Unlock audio on first touch
document.addEventListener('touchstart', () => { if(!audioCtx) audioCtx=new(window.AudioContext||window.webkitAudioContext)(); }, {once:true});
</script>
</body>
</html>`;

app.get('/admin', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(ADMIN_HTML);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`✅ SmartClub CRM запущен на порту ${PORT}`);
  console.log(`🌐 Панель: /admin`);
  console.log(`📱 Phone ID: ${PHONE_ID || '❌ не задан'}`);
  console.log(`📋 Sheets:   ${SPREADSHEET_ID || '❌ не задан'}`);
});
