const admin = require('firebase-admin');
const express = require('express');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

// Время запуска сервера (UTC). Все сообщения с timestamp ДО этого момента игнорируем.
const SERVER_START_TIME = new Date();

app.get('/', (req, res) => {
  res.send('FCM Notifier is running');
});

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

function getEntryStatus(msg) {
  if (msg.actualExitDisplay) return 'completed';
  if (!msg.controlDate || msg.controlDate === 'no_kv') return 'active';
  const now = new Date();
  const controlDateTime = new Date(`${msg.controlDate}T${msg.controlTime}:00+03:00`);
  return now >= controlDateTime ? 'active-overdue' : 'active';
}

console.log('🔍 Начинаем прослушивание коллекции messages...');
console.log(`🕒 Игнорируем сообщения, созданные до ${SERVER_START_TIME.toISOString()}`);

db.collection('messages').onSnapshot(async (snapshot) => {
  console.log(`📨 Получено изменение: ${snapshot.docChanges().length} изменений`);

  for (const change of snapshot.docChanges()) {
    const messageId = change.doc.id;
    const message = change.doc.data();

    // --- Пропускаем старые сообщения (только для 'added') ---
    if (change.type === 'added') {
      let msgTime = null;
      if (message.timestamp && message.timestamp.toDate) {
        msgTime = message.timestamp.toDate();
      } else if (message.moscowTime) {
        // fallback: парсим московское время
        const parsed = new Date(message.moscowTime.replace(' ', 'T') + '+03:00');
        if (!isNaN(parsed.getTime())) msgTime = parsed;
      }
      if (msgTime && msgTime < SERVER_START_TIME) {
        console.log(`⏩ Пропускаем старое сообщение ${messageId} (${msgTime.toISOString()})`);
        continue;
      }
    }

    if (change.type === 'added') {
      if (message.type === 'entry') {
        console.log('⏩ Пропускаем служебное сообщение о заходе');
        continue;
      }
      const text = message.text || '';

      // 1. Упоминания
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

      // 2. Ответы
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
    else if (change.type === 'modified') {
      if (message.type === 'entry' && !message.actualExitDisplay) {
        const status = getEntryStatus(message);
        if (status === 'active-overdue' && !message.overdueNotified) {
          if (message.controlTakenBy && message.controlTakenBy.userId) {
            const controllerId = message.controlTakenBy.userId;
            const controllerName = message.controlTakenBy.userName;
            const userDoc = await db.collection('users').doc(controllerId).get();
            const fcmToken = userDoc.exists ? userDoc.data().fcmToken : null;
            if (fcmToken) {
              await sendNotification(
                fcmToken,
                `⚠️ Просрочка захода!`,
                `Заход пользователя ${message.userName} просрочен. Контроль у вас.`,
                'overdue',
                messageId,
                message.userName,
                ''
              );
              await change.doc.ref.update({ overdueNotified: true });
              console.log(`📤 Отправлено уведомление о просрочке для ${controllerName} (${controllerId})`);
            } else {
              console.log(`⚠️ Нет FCM токена для контролёра ${controllerName}`);
            }
          } else {
            console.log(`ℹ️ Заход просрочен, но контроль никем не взят, уведомление не отправлено`);
          }
        }
      }
    }
  }
}, (error) => {
  console.error('❌ Ошибка Firestore:', error);
});

app.listen(PORT, () => {
  console.log(`✅ FCM Notifier запущен на порту ${PORT}`);
  console.log(`📡 Сервер доступен по адресу: http://localhost:${PORT}`);
  console.log('🔍 Ожидание новых сообщений в Firestore...');
});
