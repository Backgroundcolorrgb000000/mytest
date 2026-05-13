const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Инициализация Express
const app = express();
app.use(cors());
// УВЕЛИЧИВАЕМ ЛИМИТ ДЛЯ КАРТИНОК (ДО 10 МБ)
app.use(express.json({ limit: '10mb' }));

// 1. Подключение к базе данных Firebase (Firestore)
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

// 2. Инициализация Google Gemini API
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'dummy_key');

// НОВАЯ ФУНКЦИЯ: Отправка сообщений в Telegram
const sendTelegramMessage = async (chatId, text) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        console.warn("Токен Telegram не настроен. Уведомление не отправлено.");
        return;
    }
    try {
        const url = `https://api.telegram.org/bot${token}/sendMessage`;
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
        console.log(`Уведомление отправлено пользователю ${chatId}`);
    } catch (error) {
        console.error("Ошибка отправки в Telegram:", error);
    }
};

// Middleware для проверки пользователя Telegram
const verifyUser = (req, res, next) => {
    const tgUserId = req.headers['x-tg-user-id'];
    if (!tgUserId) {
        req.userId = 'browser_test_user'; 
    } else {
        req.userId = tgUserId.toString(); 
    }
    next();
};

// --- ЭНДПОИНТЫ (API) ---

app.get('/', (req, res) => {
    res.send('🚀 FinanceApp Server is running!');
});

app.get('/api/transactions', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'База данных не подключена' });
// Добавить транзакцию
app.post('/api/transactions', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'База данных не подключена' });

    try {
        const { title, category, amount, icon, color, bg, date, rawDate } = req.body;
        const newTx = {
            id: Date.now(), // Уникальный числовой ID
            userId: req.userId,
            title, category, amount, icon, color, bg, date, rawDate
        };
        
        // Сохраняем в коллекцию 'transactions'
        await db.collection('transactions').doc(newTx.id.toString()).set(newTx);
        
        // НОВАЯ ЛОГИКА: Проверка на крупную трату (например, больше 500 000 сум)
        const absoluteAmount = Math.abs(amount);
        if (absoluteAmount >= 500000 && req.userId !== 'browser_test_user') {
            const message = `⚠️ <b>Крупная трата!</b>\n\nВы только что добавили расход: <b>${title}</b> на сумму <b>${absoluteAmount.toLocaleString('ru-RU')} сум</b> (Категория: ${category}).\n\n<i>Постарайтесь не выходить за рамки бюджета в этом месяце!</i> 🤖`;
            // Отправляем уведомление асинхронно, не задерживая ответ клиенту
            sendTelegramMessage(req.userId, message);
        }

        res.status(201).json(newTx);
    } catch (error) {
        console.error("Ошибка добавления транзакции:", error);
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

// Удалить транзакцию
app.delete('/api/transactions/:id', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'База данных не подключена' });
    try {
        const txId = req.params.id;
        await db.collection('transactions').doc(txId).delete();
        res.json({ success: true });
    } catch (error) {
        console.error("Ошибка удаления:", error);
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

// НОВЫЙ ЭНДПОИНТ: Распознавание чека (OCR)
app.post('/api/scan', verifyUser, async (req, res) => {
    try {
        const { imageBase64, mimeType } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Нет изображения' });

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `Проанализируй этот чек. Верни ТОЛЬКО валидный JSON объект (без markdown разметки) со следующими полями:
        - amount: общая сумма чека (только цифры, целое число, без пробелов)
        - title: название магазина или заведения (строка, кратко)
        - category: выбери одну наиболее подходящую категорию из списка: "Продукты", "Транспорт", "Еда вне дома", "Развлечения", "Покупки".`;

        const imageParts = [{ inlineData: { data: imageBase64, mimeType: mimeType } }];
        
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        let text = response.text();

        // Очищаем ответ от лишних символов, чтобы остался только чистый JSON
        text = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(text);

        res.json(data);
    } catch (error) {
        console.error('Ошибка распознавания:', error);
        res.status(500).json({ error: 'Не удалось прочитать чек' });
    }
});

// Чат с ИИ (Gemini)
app.post('/api/chat', verifyUser, async (req, res) => {
    try {
        const { message } = req.body;
        let txContext = "У пользователя пока нет расходов.";
        if (db) {
            const snapshot = await db.collection('transactions').where('userId', '==', req.userId).get();
            const txs = snapshot.docs.map(doc => ({
                категория: doc.data().category,
                сумма: doc.data().amount,
                название: doc.data().title
            }));
            if (txs.length > 0) {
                txContext = JSON.stringify(txs);
            }
        }
        const prompt = `Ты финансовый эксперт и помощник. Отвечай кратко, дружелюбно, на русском языке (максимум 3-4 предложения). 
        Вот список недавних транзакций пользователя (отрицательные суммы - это расходы): ${txContext}.
        Вопрос пользователя: ${message}`;

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        
        res.json({ reply: response.text() });
    } catch (error) {
        console.error('Ошибка ИИ:', error);
        res.status(500).json({ error: 'Извините, я сейчас немного перегружен. Попробуйте спросить чуть позже!' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});