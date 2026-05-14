const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Инициализация Express
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

try {
    if (!process.env.FIREBASE_CREDENTIALS) {
        console.warn("ВНИМАНИЕ: Переменная FIREBASE_CREDENTIALS не найдена.");
    } else {
        const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("✅ База данных Firebase успешно подключена!");
    }
} catch (error) {
    console.error("❌ Ошибка подключения Firebase. Проверьте JSON ключ:", error);
}

const db = admin.apps.length ? admin.firestore() : null;

// Инициализация Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'dummy_key');

// Отправка уведомлений в Telegram
const sendTelegramMessage = async (chatId, text) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token || chatId === 'browser_test_user') return;
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
    } catch (error) {
        console.error("Ошибка отправки в Telegram:", error);
    }
};

const verifyUser = (req, res, next) => {
    const tgUserId = req.headers['x-tg-user-id'];
    req.userId = tgUserId ? tgUserId.toString() : 'browser_test_user';
    next();
};

// Функция авто-повтора для ИИ
async function callGeminiWithRetry(promptArray, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(promptArray);
            return await result.response;
        } catch (error) {
            if (i === retries - 1) throw error; 
            console.log(`[Google API] Ошибка/Перегрузка. Попытка ${i + 2}...`);
            await new Promise(res => setTimeout(res, 1500)); 
        }
    }
}

app.get('/', (req, res) => {
    res.send('🚀 FinanceApp Server is running!');
});

// Курсы валют
app.get('/api/rates', async (req, res) => {
    try {
        const response = await fetch('https://cbu.uz/ru/arkhiv-kursov-valyut/json/');
        const data = await response.json();
        const usd = data.find(c => c.Ccy === 'USD').Rate;
        const eur = data.find(c => c.Ccy === 'EUR').Rate;
        res.json({ USD: parseFloat(usd), EUR: parseFloat(eur) });
    } catch (error) {
        res.json({ USD: 12650, EUR: 13600 }); 
    }
});

// Получить транзакции
app.get('/api/transactions', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'База данных не подключена' });
    try {
        const snapshot = await db.collection('transactions')
            .where('userId', '==', req.userId)
            .orderBy('id', 'desc')
            .get();
        const txs = snapshot.docs.map(doc => doc.data());
        res.json(txs);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

// Добавить транзакцию
app.post('/api/transactions', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'База БД не подключена' });

    try {
        const { title, category, amount, icon, color, bg, date, rawDate, originalCurrency, originalAmount } = req.body;
        const newTx = {
            id: Date.now() + Math.floor(Math.random() * 1000), // Защита от дублей при массовом добавлении
            userId: req.userId,
            title, category, amount, icon, color, bg, date, rawDate, originalCurrency, originalAmount
        };
        
        await db.collection('transactions').doc(newTx.id.toString()).set(newTx);
        
        // Уведомление о крупной трате
        const absoluteAmount = Math.abs(amount);
        if (absoluteAmount >= 500000 && req.userId !== 'browser_test_user') {
            const message = `⚠️ <b>Крупная операция!</b>\n\nВы зафиксировали: <b>${title}</b> на сумму <b>${absoluteAmount.toLocaleString('ru-RU')} сум</b> (Категория: ${category}).\n\n<i>Контролируйте лимиты!</i> 📊`;
            sendTelegramMessage(req.userId, message);
        }

        res.status(201).json(newTx);
    } catch (error) {
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

// Удалить транзакцию
app.delete('/api/transactions/:id', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'БД не подключена' });
    try {
        await db.collection('transactions').doc(req.params.id).delete();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

// УМНОЕ СКАНИРОВАНИЕ ЧЕКА (С РАЗБИВКОЙ)
app.post('/api/scan', verifyUser, async (req, res) => {
    try {
        const { imageBase64, mimeType } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Нет фото' });

        const prompt = `Проанализируй этот чек. Верни ТОЛЬКО валидный JSON объект (без markdown разметки) в формате:
        {
          "storeName": "Краткое название магазина",
          "items": [
             {"name": "Товар 1", "price": число_цена_в_сумах, "category": "Категория"}
          ]
        }
        Если это ресторан, товары - это блюда. Категории выбирай из: Продукты, Транспорт, Еда вне дома, Развлечения, Покупки, Здоровье, Другое.`;

        const imageParts = [{ inlineData: { data: imageBase64, mimeType: mimeType } }];
        
        const response = await callGeminiWithRetry([prompt, ...imageParts]);
        let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(text);

        res.json(data);
    } catch (error) {
        console.error('Ошибка OCR:', error.message);
        res.status(500).json({ error: 'Не удалось прочитать чек' });
    }
});

// Чат с ИИ
app.post('/api/chat', verifyUser, async (req, res) => {
    try {
        const { message } = req.body;
        let txContext = "У пользователя пока нет расходов.";
        if (db) {
            const snapshot = await db.collection('transactions').where('userId', '==', req.userId).get();
            const txs = snapshot.docs.map(doc => ({ кат: doc.data().category, сум: doc.data().amount, назв: doc.data().title }));
            if (txs.length > 0) txContext = JSON.stringify(txs.slice(0, 50)); // Берем последние 50 для скорости
        }

        const prompt = `Ты финансовый эксперт. Отвечай кратко, дружелюбно (2-3 предложения). 
        Транзакции пользователя: ${txContext}.
        Вопрос: ${message}`;

        const response = await callGeminiWithRetry([prompt]);
        res.json({ reply: response.text() });

    } catch (error) {
        res.json({ reply: 'Извините, серверы Google сейчас перегружены 😔. Дайте мне пару минут!' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));