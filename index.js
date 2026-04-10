const admin = require('firebase-admin');
const express = require('express');

// Инициализация Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

// Время запуска сервера (UTC). Используем для фильтрации новых сообщений
const SERVER_START_TIME = new Date();

app.get('/', (req, res) => {
  res.send('FCM Notifier is running');
});

// Отправка push-уведомления через FCM v1
async function sendNotification(fcmToken, title, body, type, messageId, userName, messageText) {
  const message = {
    token: fcmToken,
    notification: { title, body },
    data: {
      type: type,
      messageId: messageId,
      userName: userName || '',
      messageText: messageText || '',
      title: title
    },
    android: {
      priority: 'high',
      notification: { sound: 'default', priority: 'high' }
    },
    apns: {
      payload: {
        aps: { sound: 'default', contentAvailable: true }
      }
    }
  };
  try {
    const response = await admin.messaging().send(message);
    console.log(`✅ Уведомление отправлено: ${title} (${response})`);
    return true;
  } catch (error) {
    console.error(`❌ Ошибка отправки уведомления:`, error);
    return false;
  }
}

// Функция проверки, просрочен ли заход
function isOverdue(controlDate, controlTime) {
  if (!controlDate || controlDate === 'no_kv' || !controlTime) return false;
  const now = new Date();
  const controlDateTime = new Date(`${controlDate}T${controlTime}:00+03:00`);
  return now >= controlDateTime;
}

// ========== 1. СЛУШАТЕЛЬ ТОЛЬКО ДЛЯ НОВЫХ СООБЩЕНИЙ (упоминания и ответы) ==========
console.log('🔍 Слушаем ТОЛЬКО новые сообщения (после', SERVER_START_TIME.toISOString(), ')');
db.collection('messages')
  .where('timestamp', '>', SERVER_START_TIME)   // Ключевая строка: загружаем только новые
  .onSnapshot(async (snapshot) => {
    console.log(`📨 Получено изменение: ${snapshot.docChanges().length} изменений (только новые)`);
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;   // нас интересуют только новые сообщения

      const message = change.doc.data();
      const messageId = change.doc.id;
      const text = message.text || '';

      // Пропускаем служебные сообщения о заходах
      if (message.type === 'entry') {
        console.log('⏩ Пропускаем служебное сообщение о заходе');
        continue;
      }

      // --- Обработка упоминаний ---
      const mentionRegex = /@\[([^\]]+)\]|@([\wа-яА-ЯёЁ]+)/g;
      let match;
      while ((match = mentionRegex.exec(text)) !== null) {
        const username = (match[1] || match[2]).trim();
        if (!username) continue;
        console.log(`🔍 Поиск пользователя для упоминания: ${username}`);
        const userQuery = await db.collection('users')
          .where('name', '==', username)
          .limit(1)
          .get();
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          if (userId !== message.userId && fcmToken) {
            await sendNotification(
              fcmToken,
              `🔔 Упоминание в чате`,
              `${message.userName}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
              'mention',
              messageId,
              message.userName,
              text
            );
          }
        }
      }

      // --- Обработка ответов ---
      if (message.replyTo && message.replyTo.author) {
        const repliedAuthor = message.replyTo.author;
        console.log(`🔍 Поиск пользователя для ответа: ${repliedAuthor}`);
        const userQuery = await db.collection('users')
          .where('name', '==', repliedAuthor)
          .limit(1)
          .get();
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          if (userId !== message.userId && fcmToken) {
            await sendNotification(
              fcmToken,
              `💬 Ответ на ваше сообщение`,
              `${message.userName}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
              'reply',
              messageId,
              message.userName,
              text
            );
          }
        }
      }
    }
  }, (error) => {
    console.error('❌ Ошибка Firestore (слушатель новых сообщений):', error);
  });

// ========== 2. ПЕРИОДИЧЕСКАЯ ПРОВЕРКА ПРОСРОЧЕК ЗАХОДОВ (раз в минуту) ==========
// Не требует загрузки всей истории – запрашиваем только активные заходы без выхода
async function checkOverdueEntries() {
  try {
    // Ищем все незавершённые заходы (без actualExitDisplay)
    const snapshot = await db.collection('messages')
      .where('type', '==', 'entry')
      .where('actualExitDisplay', '==', null)
      .get();

    for (const doc of snapshot.docs) {
      const entry = doc.data();
      const entryId = doc.id;
      // Если уже отправлено уведомление о просрочке – пропускаем
      if (entry.overdueNotified) continue;

      // Проверяем, есть ли КВ и не просрочено ли оно
      if (entry.controlDate && entry.controlDate !== 'no_kv' && entry.controlTime) {
        if (isOverdue(entry.controlDate, entry.controlTime)) {
          // Если контроль взят – уведомляем того, кто взял
          if (entry.controlTakenBy && entry.controlTakenBy.userId) {
            const controllerId = entry.controlTakenBy.userId;
            const controllerName = entry.controlTakenBy.userName;
            const userDoc = await db.collection('users').doc(controllerId).get();
            const fcmToken = userDoc.exists ? userDoc.data().fcmToken : null;
            if (fcmToken) {
              await sendNotification(
                fcmToken,
                `⚠️ Просрочка выхода!`,
                `Выход пользователя ${entry.userName} просрочен. Контроль у вас.`,
                'overdue',
                entryId,
                entry.userName,
                ''
              );
              // Ставим флаг, чтобы больше не отправлять
              await doc.ref.update({ overdueNotified: true });
              console.log(`📤 Отправлено уведомление о просрочке для ${controllerName} (${controllerId})`);
            } else {
              console.log(`⚠️ Нет FCM токена для контролёра ${controllerName}`);
            }
          } else {
            // Если контроль никем не взят – можно никого не уведомлять (или уведомить всех админов)
            console.log(`ℹ️ Выход ${entry.userName} просрочен, но контроль никем не взят`);
            // По желанию: можно поставить флаг, чтобы не проверять повторно
            await doc.ref.update({ overdueNotified: true });
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Ошибка при проверке просрочек:', err);
  }
}

// Запускаем проверку просрочек каждые 5 минут
setInterval(checkOverdueEntries, 5 * 60 * 1000);
// И сразу один раз при старте (на случай, если просрочка уже наступила)
checkOverdueEntries();

// ========== ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, () => {
  console.log(`✅ FCM Notifier запущен на порту ${PORT}`);
  console.log(`📡 Сервер доступен по адресу: http://localhost:${PORT}`);
  console.log(`🕒 Игнорируем старые сообщения (до ${SERVER_START_TIME.toISOString()})`);
  console.log('🔍 Ожидание новых сообщений в Firestore...');
});
