const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Инициализация Express
const app = express();
app.use(cors());
app.use(express.json());

// 1. Подключение к базе данных Firebase (Firestore)
// Railway передаст содержимое скачанного вами .json файла через переменную FIREBASE_CREDENTIALS
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

// Middleware для имитации авторизации (в будущем здесь будет проверка подписи Telegram)
const verifyUser = (req, res, next) => {
    // Временно жестко задаем ID пользователя. В релизе он будет браться из данных Telegram
    req.userId = 'tg_user_1'; 
    next();
};

// --- ЭНДПОИНТЫ (API) ---

// Проверка работы сервера
app.get('/', (req, res) => {
    res.send('🚀 FinanceApp Server is running!');
});

// Получить все транзакции
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
        
        // Сохраняем в коллекцию 'transactions', используя ID как имя документа
        await db.collection('transactions').doc(newTx.id.toString()).set(newTx);
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

// Чат с ИИ (Gemini)
app.post('/api/chat', verifyUser, async (req, res) => {
    try {
        const { message } = req.body;
        
        // Достаем историю расходов, чтобы ИИ давал персональные советы
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

        // Исправлено название модели на актуальное ("gemini-pro")
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        
        res.json({ reply: response.text() });
    } catch (error) {
        console.error('Ошибка ИИ:', error);
        res.status(500).json({ error: 'Извините, я сейчас немного перегружен. Попробуйте спросить чуть позже!' });
    }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на порту ${PORT}`);
});
