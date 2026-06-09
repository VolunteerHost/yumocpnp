const fs = require('fs');
const path = require('path');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const mongodbUri = process.env.MONGODB_URI;
const storagePath = path.join(__dirname, 'data', 'storage.json');

let bot = null;
let botInfo = null;
let dbClient = null;
let storageCollection = null;
let requestsCollection = null;
let storage = { receiverId: null };

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

function readStorage() {
  try {
    const data = fs.readFileSync(storagePath, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return { receiverId: null };
  }
}

function writeStorage(payload) {
  try {
    fs.writeFileSync(storagePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    console.error('Не вдалося записати файл storage.json:', error.message || error);
  }
}

async function connectDatabase() {
  if (!mongodbUri) {
    console.warn('MONGODB_URI не задано. Підключення до MongoDB пропущено.');
    return;
  }

  try {
    dbClient = new MongoClient(mongodbUri);
    await dbClient.connect();
    const db = dbClient.db();
    storageCollection = db.collection('app_storage');
    requestsCollection = db.collection('requests');
    await storageCollection.createIndex({ key: 1 }, { unique: true });
    console.log('MongoDB Atlas підключено.');
  } catch (error) {
    console.error('Не вдалося підключитися до MongoDB Atlas:', error.message || error);
    dbClient = null;
    storageCollection = null;
    requestsCollection = null;
  }
}

async function loadStorage() {
  if (storageCollection) {
    try {
      const stored = await storageCollection.findOne({ key: 'botReceiver' });
      if (stored) {
        return { receiverId: stored.value || null };
      }
    } catch (error) {
      console.error('Помилка читання storage з MongoDB:', error.message || error);
    }
  }

  return readStorage();
}

async function saveStorage(payload) {
  if (storageCollection) {
    try {
      await storageCollection.updateOne(
        { key: 'botReceiver' },
        { $set: { value: payload.receiverId } },
        { upsert: true }
      );
    } catch (error) {
      console.error('Помилка збереження storage в MongoDB:', error.message || error);
    }
  }

  writeStorage(payload);
}

async function saveRequestLog(request) {
  if (!requestsCollection) {
    return;
  }

  try {
    await requestsCollection.insertOne({
      createdAt: new Date(),
      ...request,
    });
  } catch (error) {
    console.error('Помилка збереження заявки в MongoDB:', error.message || error);
  }
}

async function initializeBot() {
  if (!botToken) {
    console.warn('TELEGRAM_BOT_TOKEN не задано. Бот не запущено.');
    return;
  }

  bot = new TelegramBot(botToken, { polling: true });

  bot.getMe()
    .then((info) => {
      botInfo = info;
      console.log(`Telegram-бот готовий: @${info.username}`);
    })
    .catch((error) => {
      console.error('Не вдалося отримати дані бота:', error.message || error);
    });

  bot.onText(/\/start(@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    console.log('Received /start from', chatId, msg.from?.username || msg.from?.first_name, 'chatType', msg.chat.type);

    if (!storage.receiverId) {
      storage.receiverId = chatId;
      await saveStorage(storage);
      await bot.sendMessage(chatId, 'Вітаємо! Ви тепер отримуватимете заявки з сайту Betonolom UA.');
      return;
    }

    if (storage.receiverId === chatId) {
      await bot.sendMessage(chatId, 'Ви вже отримуєте заявки.');
    } else {
      await bot.sendMessage(chatId, "Цей бот вже прив'язаний до першого користувача і не може приймати заявки від інших.");
    }
  });

  bot.onText(/\/help(@\w+)?/, async (msg) => {
    await bot.sendMessage(msg.chat.id, 'Цей бот приймає заявки лише з сайту Betonolom UA. Перший користувач, який надішле /start, стає отримувачем заявок. Щоб скасувати прив’язку, використайте /unbind.');
  });

  bot.onText(/\/unbind(@\w+)?/, async (msg) => {
    const chatId = msg.chat.id;
    if (!storage.receiverId) {
      await bot.sendMessage(chatId, 'Немає встановленої прив’язки.');
      return;
    }

    if (storage.receiverId !== chatId) {
      await bot.sendMessage(chatId, 'Тільки поточний отримувач може скасувати прив’язку.');
      return;
    }

    storage.receiverId = null;
    await saveStorage(storage);
    await bot.sendMessage(chatId, 'Прив’язка до сайту успішно скасована. Щоб знову приймати заявки, надішліть /start.');
  });

  bot.on('message', (msg) => {
    console.log('Telegram message:', msg.chat.id, msg.chat.type, msg.text);
  });

  bot.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.message || error);
  });
}

app.post('/api/request', async (req, res) => {
  const { name, phone, email, address, task } = req.body;

  if (!name || !phone || !address || !task || !email) {
    return res.status(400).json({ error: 'Усі поля є обов’язковими для заповнення.' });
  }

  const requestText = `📩 Нова заявка з сайту Betonolom UA:\n\n` +
    `Ім'я: ${name}\n` +
    `Телефон: ${phone}\n` +
    `Email: ${email}\n` +
    `Адреса об'єкта: ${address}\n` +
    `Опис завдання: ${task}`;

  await saveRequestLog({ name, phone, email, address, task, status: 'received' });

  if (!bot) {
    console.log('Заявка прийнята, але бот неактивний:', requestText);
    return res.json({ status: 'accepted', message: 'Заявка прийнята, але Telegram-бот не активний. Перевірте налаштування.' });
  }

  if (!storage.receiverId) {
    console.log('Заявка прийнята, але отримувач ще не авторизований:\n', requestText);
    return res.json({ status: 'accepted', message: 'Заявка прийнята. Очікується авторизація отримувача через Telegram /start.' });
  }

  try {
    await bot.sendMessage(storage.receiverId, requestText);
    await saveRequestLog({ name, phone, email, address, task, status: 'sent' });
    return res.json({ status: 'sent', message: 'Заявку надіслано отримувачу.' });
  } catch (error) {
    console.error('Помилка відправки заявки в Telegram:', error.message || error);
    await saveRequestLog({ name, phone, email, address, task, status: 'failed', error: error.message });
    return res.status(500).json({ error: 'Не вдалося відправити заявку в Telegram. Спробуйте пізніше.' });
  }
});

app.get('/api/status', (req, res) => {
  res.json({
    bot: Boolean(bot),
    active: Boolean(botInfo),
    receiverId: storage.receiverId,
    botUsername: botInfo?.username || null,
    dbConnected: Boolean(storageCollection),
  });
});

async function init() {
  await connectDatabase();
  storage = await loadStorage();
  await initializeBot();

  app.listen(port, () => {
    console.log(`Сервер працює на http://localhost:${port}`);
    console.log(bot ? 'Telegram-бот ініціалізовано.' : 'Telegram-бот не активовано.');
  });
}

init().catch((error) => {
  console.error('Помилка ініціалізації сервера:', error.message || error);
  process.exit(1);
});
