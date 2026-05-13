const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Инициализация Express
const app = express();
app.use(cors());
// УВЕЛИЧИВАЕМ ЛИМИТ ДЛЯ КАРТИНОК ИЗ СКАНЕРА ЧЕКОВ
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

const sendTelegramMessage = async (chatId, text) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
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
    if (!tgUserId) {
        req.userId = 'browser_test_user'; 
    } else {
        req.userId = tgUserId.toString(); 
    }
    next();
};

async function callGeminiWithRetry(promptArray, retries = 2) {
    for (let i = 0; i < retries; i++) {
        try {
            // Используем самую актуальную модель
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
            const result = await model.generateContent(promptArray);
            return await result.response;
        } catch (error) {
            if (i === retries - 1) throw error; // Если все попытки исчерпаны - пробрасываем ошибку
            console.log(`[Google API] Сервер перегружен. Попытка ${i + 2} из ${retries}...`);
            await new Promise(res => setTimeout(res, 1500)); // Ждем 1.5 секунды перед повтором
        }
    }
}


app.get('/', (req, res) => {
    res.send('🚀 FinanceApp Server is running!');
});

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
        console.error("Ошибка получения транзакций:", error);
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

app.post('/api/transactions', verifyUser, async (req, res) => {
    if (!db) return res.status(500).json({ error: 'База данных не подключена' });

    try {
        const { title, category, amount, icon, color, bg, date, rawDate, originalCurrency, originalAmount } = req.body;
        const newTx = {
            id: Date.now(), 
            userId: req.userId,
            title, category, amount, icon, color, bg, date, rawDate, originalCurrency, originalAmount
        };
        
        await db.collection('transactions').doc(newTx.id.toString()).set(newTx);
        
        // Уведомление о крупной трате в Telegram
        const absoluteAmount = Math.abs(amount);
        if (absoluteAmount >= 500000 && req.userId !== 'browser_test_user') {
            const message = `⚠️ <b>Крупная операция!</b>\n\nВы зафиксировали: <b>${title}</b> на сумму <b>${absoluteAmount.toLocaleString('ru-RU')} сум</b> (Категория: ${category}).\n\n<i>Старайтесь придерживаться ваших лимитов!</i> 📊`;
            sendTelegramMessage(req.userId, message);
        }

        res.status(201).json(newTx);
    } catch (error) {
        console.error("Ошибка добавления транзакции:", error);
        res.status(500).json({ error: 'Ошибка БД' });
    }
});

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

app.post('/api/scan', verifyUser, async (req, res) => {
    try {
        const { imageBase64, mimeType } = req.body;
        if (!imageBase64) return res.status(400).json({ error: 'Нет изображения' });

        const prompt = `Проанализируй этот чек. Верни ТОЛЬКО валидный JSON объект (без markdown разметки) со следующими полями:
        - amount: общая сумма чека (только цифры, целое число, без пробелов)
        - title: название магазина или заведения (строка, кратко)
        - category: выбери наиболее подходящую категорию.`;

        const imageParts = [{ inlineData: { data: imageBase64, mimeType: mimeType } }];
        
        // Используем нашу защищенную функцию с автоповтором
        const response = await callGeminiWithRetry([prompt, ...imageParts]);
        let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(text);

        res.json(data);
    } catch (error) {
        console.error('Ошибка распознавания:', error.message);
        res.status(500).json({ error: 'Не удалось прочитать чек' });
    }
});

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

        const prompt = `Ты финансовый эксперт и помощник. Отвечай кратко, дружелюбно, на русском языке (2-3 предложения). 
        Вот список недавних транзакций пользователя (отрицательные суммы - это расходы): ${txContext}.
        Вопрос пользователя: ${message}`;

        // Используем нашу защищенную функцию
        const response = await callGeminiWithRetry([prompt]);
        res.json({ reply: response.text() });

    } catch (error) {
        console.error('Ошибка ИИ:', error.message);
        // Вместо падения сервера, возвращаем пользователю вежливый ответ
        res.json({ reply: 'Извините, серверы Google сейчас перегружены 😔. Дайте мне пару минут на отдых, и спросите снова!' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});