const admin = require('firebase-admin');
const express = require('express');

// Инициализация Firebase Admin SDK
// Ключ сервисного аккаунта берется из переменной окружения
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;

// Эндпоинт для проверки работоспособности сервера
app.get('/', (req, res) => {
  res.send('✅ FCM Notifier is running');
});

// Функция отправки push-уведомления через FCM
async function sendNotification(fcmToken, title, body, type, messageId, userName, messageText) {
  const payload = {
    notification: {
      title: title,
      body: body,
      sound: 'default'
    },
    data: {
      type: type,
      messageId: messageId,
      userName: userName,
      messageText: messageText,
      title: title
    }
  };
  
  try {
    await admin.messaging().sendToDevice(fcmToken, payload);
    console.log(`✅ Уведомление отправлено: ${title} → ${body.substring(0, 50)}...`);
    return true;
  } catch (error) {
    console.error(`❌ Ошибка отправки уведомления:`, error);
    
    // Если токен невалидный, удаляем его из Firestore
    if (error.code === 'messaging/invalid-registration-token' ||
        error.code === 'messaging/registration-token-not-registered') {
      console.log(`🗑️ Удаляем невалидный токен из Firestore`);
      // Здесь можно добавить логику удаления токена
    }
    return false;
  }
}

// Слушаем изменения в коллекции messages (реальное время)
db.collection('messages').onSnapshot(async (snapshot) => {
  snapshot.docChanges().forEach(async (change) => {
    // Обрабатываем только новые добавленные сообщения
    if (change.type === 'added') {
      const message = change.doc.data();
      const messageId = change.doc.id;
      
      // Игнорируем служебные сообщения о заходе/выходе
      if (message.type === 'entry') return;
      
      const text = message.text || '';
      const messageText = text;
      
      console.log(`📨 Новое сообщение от ${message.userName}: ${text.substring(0, 50)}...`);
      
      // ========== 1. Обработка упоминаний @username ==========
      const mentionRegex = /@([\wа-яА-ЯёЁ]+)/g;
      const mentions = [];
      let match;
      while ((match = mentionRegex.exec(text)) !== null) {
        mentions.push(match[1]);
      }
      
      for (const username of mentions) {
        console.log(`🔍 Поиск пользователя: ${username}`);
        
        // Ищем пользователя по имени в коллекции users
        const userQuery = await db.collection('users')
          .where('name', '==', username)
          .limit(1)
          .get();
          
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          
          // Не отправляем уведомление автору сообщения
          if (userId !== message.userId && fcmToken) {
            console.log(`📤 Отправка уведомления об упоминании для ${username}`);
            await sendNotification(
              fcmToken,
              `🔔 Упоминание в чате`,
              `${message.userName}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`,
              'mention',
              messageId,
              message.userName,
              text
            );
          } else if (userId === message.userId) {
            console.log(`⏭️ Пропускаем уведомление для автора сообщения`);
          } else if (!fcmToken) {
            console.log(`⚠️ У пользователя ${username} нет FCM токена`);
          }
        } else {
          console.log(`❌ Пользователь ${username} не найден в Firestore`);
        }
      }
      
      // ========== 2. Обработка ответов на сообщения ==========
      if (message.replyTo && message.replyTo.author) {
        const repliedAuthor = message.replyTo.author;
        console.log(`💬 Обнаружен ответ пользователю: ${repliedAuthor}`);
        
        const userQuery = await db.collection('users')
          .where('name', '==', repliedAuthor)
          .limit(1)
          .get();
          
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          
          if (userId !== message.userId && fcmToken) {
            console.log(`📤 Отправка уведомления об ответе для ${repliedAuthor}`);
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
  });
}, (error) => {
  console.error('❌ Ошибка подключения к Firestore:', error);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`✅ FCM Notifier сервер запущен на порту ${PORT}`);
  console.log(`🕒 Ожидание новых сообщений в Firestore...`);
  console.log(`🌐 Сервер доступен по адресу: http://localhost:${PORT}`);
});