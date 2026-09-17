const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load environment variables from .env if present
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const [key, ...vals] = trimmed.split('=');
      process.env[key.trim()] = vals.join('=').trim();
    }
  });
}

let PORT = process.env.PORT || 3000;
let WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'whatsapp_secret_verify_token_123';
let WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || '';
let WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
let GROQ_API_KEY = process.env.GROQ_API_KEY || '';
let NOTION_API_KEY = process.env.NOTION_API_KEY || '';
let NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '';

// In-memory Database / Fallback State
const state = {
  tasks: [
    { id: '1', title: 'Review project architecture', status: 'Pending', createdAt: new Date().toISOString() },
    { id: '2', title: 'Verify webhook endpoints', status: 'Done', createdAt: new Date().toISOString() }
  ],
  alarms: [],
  logs: [
    { time: new Date().toLocaleTimeString(), message: 'WhatsApp AI Assistant service initialized.' }
  ],
  notifications: []
};

function addLog(msg) {
  const logEntry = { time: new Date().toLocaleTimeString(), message: msg };
  state.logs.unshift(logEntry);
  if (state.logs.length > 50) state.logs.pop();
  console.log(`[${logEntry.time}] ${msg}`);
}

// Background Alarm Engine (Runs every 2 seconds for high precision)
setInterval(async () => {
  const now = new Date();
  for (const alarm of state.alarms) {
    if (alarm.status === 'Pending' && new Date(alarm.time) <= now) {
      alarm.status = 'Fired';
      const notificationMsg = `⏰ ALARM TRIGGERED: "${alarm.label}" at ${now.toLocaleTimeString()}`;
      addLog(notificationMsg);
      state.notifications.push({
        id: Date.now().toString(),
        label: alarm.label,
        time: now.toLocaleTimeString()
      });

      // Send via WhatsApp Cloud API if credentials configured
      if (WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID && alarm.recipient) {
        try {
          await sendWhatsAppMessage(alarm.recipient, `⏰ *Reminder:* ${alarm.label}`);
          addLog(`WhatsApp notification sent to ${alarm.recipient}`);
        } catch (err) {
          addLog(`Failed to send WhatsApp reminder: ${err.message}`);
        }
      }
    }
  }
}, 2000);

// Per-sender conversation history (for contextual memory)
const chatHistories = {};

function getHistory(sender) {
  if (!chatHistories[sender]) {
    chatHistories[sender] = [];
  }
  return chatHistories[sender];
}

// Groq / LLM Integration for Actions + Full General Q&A
async function processWithAI(userText, sender = 'Simulator') {
  const history = getHistory(sender);
  const now = new Date();
  
  const systemPrompt = `You are an elite, helpful WhatsApp AI personal assistant.
Current date and time: ${now.toISOString()} (${now.toLocaleTimeString()}).
User time context: The assistant is running on the user's system.

Capabilities:
1. CHECKLIST: Add, complete, delete, or list tasks.
2. ALARMS & REMINDERS: Schedule alarms (compute the exact target time in ISO format or relative seconds).
3. GENERAL KNOWLEDGE & ASSISTANCE: Answer ANY questions, explain concepts, write messages/emails, solve problems, summarize, brainstorm, or chat naturally.

You must reply with a STRICT JSON object only. No markdown fences around the json.
Schema:
{
  "action": "ADD_TASK" | "COMPLETE_TASK" | "DELETE_TASK" | "LIST_TASKS" | "SET_ALARM" | "LIST_ALARMS" | "CHAT",
  "task": "task description (for ADD_TASK, COMPLETE_TASK, DELETE_TASK)",
  "alarmTime": "ISO timestamp for when the alarm should trigger (for SET_ALARM)",
  "alarmLabel": "what the alarm is for (for SET_ALARM)",
  "reply": "The response message to send back to the user on WhatsApp. For general questions, provide a thorough, helpful, friendly answer formatted with WhatsApp formatting (*bold*, _italic_, bullet points)."
}

Guidelines for 'reply':
- For CHAT / general questions: provide clear, accurate, and insightful answers.
- For ADD_TASK: e.g. "✅ Added to checklist: *[task]*"
- For COMPLETE_TASK: e.g. "✅ Marked as completed: *[task]*"
- For DELETE_TASK: e.g. "🗑️ Removed: *[task]*"
- For SET_ALARM: e.g. "⏰ Alarm set for *[time]*: *[alarmLabel]*"
- For LIST_TASKS: provide a clean summary.`;

  if (GROQ_API_KEY) {
    try {
      const messages = [
        { role: 'system', content: systemPrompt },
        ...history.slice(-6), // Keep last 6 exchanges for context
        { role: 'user', content: userText }
      ];

      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: messages,
          temperature: 0.3,
          response_format: { type: 'json_object' }
        })
      });

      if (response.ok) {
        const data = await response.json();
        const parsed = JSON.parse(data.choices[0].message.content);
        
        // Save to history
        history.push({ role: 'user', content: userText });
        history.push({ role: 'assistant', content: parsed.reply });
        if (history.length > 20) history.splice(0, 2);
        
        return parsed;
      }
      const errText = await response.text();
      addLog(`Groq API returned HTTP ${response.status}: ${errText.substring(0, 100)}`);
    } catch (e) {
      addLog(`Groq API call failed: ${e.message}.`);
    }
  }

  // Built-in Natural Language Intent Engine (Fallback)
  const lower = userText.toLowerCase().trim();
  
  // Alarm / Reminder detection
  const remindMatch = lower.match(/(?:remind me|set alarm|alarm in|remind in)\s+(?:to\s+)?(.+?)(?:\s+in\s+(\d+)\s*(min|minute|sec|second|hour)s?)?$/i) 
    || lower.match(/(?:in\s+(\d+)\s*(min|minute|sec|second|hour)s?\s+(?:remind me to|to)\s+(.+))/i);

  if (remindMatch || lower.includes('alarm') || lower.includes('remind')) {
    let label = 'Scheduled reminder';
    let seconds = 60;

    const secMatch = lower.match(/(\d+)\s*(?:sec|second)/i);
    const minMatch = lower.match(/(\d+)\s*(?:min|minute)/i);
    const hourMatch = lower.match(/(\d+)\s*(?:hour|hr)/i);

    if (secMatch) seconds = parseInt(secMatch[1], 10);
    else if (minMatch) seconds = parseInt(minMatch[1], 10) * 60;
    else if (hourMatch) seconds = parseInt(hourMatch[1], 10) * 3600;

    const cleaned = userText.replace(/remind me to|set alarm for|set alarm|remind in|in \d+\s*\w+/gi, '').trim();
    if (cleaned) label = cleaned;

    const targetDate = new Date(Date.now() + seconds * 1000);
    return {
      action: 'SET_ALARM',
      alarmTime: targetDate.toISOString(),
      alarmLabel: label,
      reply: `⏰ Alarm set! I'll remind you to "${label}" at ${targetDate.toLocaleTimeString()}.`
    };
  }

  // Complete / Done Task
  if (lower.startsWith('done') || lower.startsWith('finish') || lower.startsWith('completed') || lower.startsWith('check off')) {
    const taskName = userText.replace(/^(?:done|finish|finished|completed|check off)\s+/i, '').trim();
    return {
      action: 'COMPLETE_TASK',
      task: taskName,
      reply: `✅ Marked "${taskName}" as completed!`
    };
  }

  // Delete / Remove Task
  if (lower.startsWith('delete') || lower.startsWith('remove')) {
    const taskName = userText.replace(/^(?:delete|remove)\s+/i, '').trim();
    return {
      action: 'DELETE_TASK',
      task: taskName,
      reply: `🗑️ Removed "${taskName}" from your checklist.`
    };
  }

  // Add Task
  if (lower.startsWith('add') || lower.startsWith('todo:') || (lower.includes('checklist') && lower.includes('add'))) {
    const task = userText.replace(/^add\s+(?:to\s+(?:my\s+)?(?:checklist|todo|tasks)?)?/i, '').replace(/to my checklist/i, '').trim();
    return {
      action: 'ADD_TASK',
      task: task || 'New task item',
      reply: `✅ Added to your checklist: "${task || 'New task item'}"`
    };
  }

  // List Tasks
  if (lower.includes('show task') || lower.includes('list task') || lower.includes('my checklist') || lower.includes('todo list') || lower.includes('tasks')) {
    const pending = state.tasks.filter(t => t.status !== 'Done');
    const taskListStr = pending.length > 0
      ? pending.map(t => `• ${t.title}`).join('\n')
      : 'Your checklist is empty! 🎉';
    return {
      action: 'LIST_TASKS',
      reply: `📋 *Current Checklist:*\n${taskListStr}`
    };
  }

  return {
    action: 'CHAT',
    reply: `👋 Hello! I received: "${userText}". You can say:\n• "Remind me in 10 seconds to stretch"\n• "Add Review report to checklist"\n• "Done Review report"\n• "What are my tasks?"`
  };
}

// Notion Sync Client
async function syncToNotion(type, title, date) {
  if (!NOTION_API_KEY || !NOTION_DATABASE_ID) {
    return { synced: false, reason: 'Using local store' };
  }
  try {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_API_KEY}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DATABASE_ID },
        properties: {
          Name: { title: [{ text: { content: title } }] },
          Type: { select: { name: type } },
          Date: date ? { date: { start: date } } : undefined
        }
      })
    });
    if (res.ok) {
      addLog(`Synced ${type} "${title}" to Notion.`);
      return { synced: true };
    }
  } catch (err) {
    addLog(`Notion sync error: ${err.message}`);
  }
  return { synced: false };
}

// WhatsApp Cloud API Sender
async function sendWhatsAppMessage(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    addLog(`[WhatsApp Outbound Mock] To: ${to} | Message: "${text}"`);
    return { mock: true };
  }
  const response = await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to,
      type: 'text',
      text: { body: text }
    })
  });
  return response.json();
}

// Execute Assistant Action
async function handleAction(parsed, sender = 'Simulator') {
  if (parsed.action === 'ADD_TASK') {
    const newTask = {
      id: Date.now().toString(),
      title: parsed.task,
      status: 'Pending',
      createdAt: new Date().toISOString()
    };
    state.tasks.push(newTask);
    addLog(`Task created: "${newTask.title}"`);
    await syncToNotion('Task', newTask.title);
  } else if (parsed.action === 'COMPLETE_TASK') {
    const task = state.tasks.find(t => t.title.toLowerCase().includes(parsed.task.toLowerCase()));
    if (task) {
      task.status = 'Done';
      addLog(`Task completed: "${task.title}"`);
    }
  } else if (parsed.action === 'DELETE_TASK') {
    const idx = state.tasks.findIndex(t => t.title.toLowerCase().includes(parsed.task.toLowerCase()));
    if (idx !== -1) {
      const removed = state.tasks.splice(idx, 1)[0];
      addLog(`Task deleted: "${removed.title}"`);
    }
  } else if (parsed.action === 'SET_ALARM') {
    const alarmTime = parsed.alarmTime.includes('T') 
      ? parsed.alarmTime 
      : new Date(Date.now() + (parseInt(parsed.alarmTime, 10) || 1) * 60000).toISOString();

    const newAlarm = {
      id: Date.now().toString(),
      label: parsed.alarmLabel,
      time: alarmTime,
      status: 'Pending',
      recipient: sender
    };
    state.alarms.push(newAlarm);
    addLog(`Alarm scheduled: "${newAlarm.label}" for ${new Date(alarmTime).toLocaleTimeString()}`);
    await syncToNotion('Alarm', newAlarm.label, alarmTime);
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Static Files (Web Simulator Dashboard)
  if (pathname === '/' || pathname === '/index.html') {
    const filePath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(filePath));
    }
    res.writeHead(404);
    return res.end('Dashboard not found.');
  }

  // Meta WhatsApp Cloud API Verification Webhook (GET)
  if (pathname === '/webhook' && req.method === 'GET') {
    const mode = parsedUrl.query['hub.mode'];
    const token = parsedUrl.query['hub.verify_token'];
    const challenge = parsedUrl.query['hub.challenge'];

    if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
      addLog('WhatsApp Cloud API Webhook verified successfully.');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end(challenge);
    }
    addLog('WhatsApp Webhook verification failed. Token mismatch.');
    res.writeHead(403);
    return res.end('Verification token mismatch');
  }

  // Meta WhatsApp Cloud API Inbound Messages Webhook (POST)
  if (pathname === '/webhook' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const entry = payload.entry?.[0]?.changes?.[0]?.value;
        const message = entry?.messages?.[0];

        if (message && message.text) {
          const from = message.from;
          const text = message.text.body;
          addLog(`Inbound WhatsApp message from ${from}: "${text}"`);

          const aiResult = await processWithAI(text, from);
          await handleAction(aiResult, from);
          await sendWhatsAppMessage(from, aiResult.reply);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        addLog(`Webhook error: ${err.message}`);
        res.writeHead(400);
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Web Simulator Chat API (POST)
  if (pathname === '/api/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { message } = JSON.parse(body);
        addLog(`Simulator input: "${message}"`);
        const aiResult = await processWithAI(message, 'SimulatorUser');
        await handleAction(aiResult, 'SimulatorUser');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          reply: aiResult.reply,
          action: aiResult.action,
          state: {
            tasks: state.tasks,
            alarms: state.alarms
          }
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // State & Notifications Polling API (GET)
  if (pathname === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const notifications = [...state.notifications];
    state.notifications = []; // Clear read notifications
    return res.end(JSON.stringify({
      tasks: state.tasks,
      alarms: state.alarms,
      logs: state.logs,
      notifications: notifications
    }));
  }

  // Config Status & Live Key Update API (GET/POST)
  if (pathname === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      groqConnected: !!GROQ_API_KEY,
      groqKeyMasked: GROQ_API_KEY ? GROQ_API_KEY.slice(0, 6) + '...' + GROQ_API_KEY.slice(-4) : '',
      whatsAppConnected: !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_NUMBER_ID),
      phoneId: WHATSAPP_PHONE_NUMBER_ID || '',
      verifyToken: WHATSAPP_VERIFY_TOKEN,
      notionConnected: !!(NOTION_API_KEY && NOTION_DATABASE_ID)
    }));
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const config = JSON.parse(body);
        if (config.groqApiKey !== undefined) GROQ_API_KEY = config.groqApiKey.trim();
        if (config.whatsappToken !== undefined) WHATSAPP_TOKEN = config.whatsappToken.trim();
        if (config.whatsappPhoneId !== undefined) WHATSAPP_PHONE_NUMBER_ID = config.whatsappPhoneId.trim();
        if (config.whatsappVerifyToken !== undefined) WHATSAPP_VERIFY_TOKEN = config.whatsappVerifyToken.trim();
        if (config.notionApiKey !== undefined) NOTION_API_KEY = config.notionApiKey.trim();
        if (config.notionDatabaseId !== undefined) NOTION_DATABASE_ID = config.notionDatabaseId.trim();

        // Persist to .env
        const newEnv = `PORT=${PORT}\nWHATSAPP_VERIFY_TOKEN=${WHATSAPP_VERIFY_TOKEN}\nWHATSAPP_TOKEN=${WHATSAPP_TOKEN}\nWHATSAPP_PHONE_NUMBER_ID=${WHATSAPP_PHONE_NUMBER_ID}\nGROQ_API_KEY=${GROQ_API_KEY}\nNOTION_API_KEY=${NOTION_API_KEY}\nNOTION_DATABASE_ID=${NOTION_DATABASE_ID}\n`;
        fs.writeFileSync(envPath, newEnv, 'utf-8');
        addLog('Configuration updated and saved to .env.');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Settings saved successfully!' }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, () => {
  addLog(`WhatsApp AI Assistant microservice running on http://localhost:${PORT}`);
  console.log(`\n🚀 Open your browser at: http://localhost:${PORT}\n`);
});
