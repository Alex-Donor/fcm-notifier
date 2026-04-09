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

// Эндпоинт для проверки работоспособности
app.get('/', (req, res) => {
  res.send('FCM Notifier is running');
});

// Функция для отправки уведомления (FCM v1)
async function sendNotification(fcmToken, title, body, type, messageId, userName, messageText) {
  const message = {
    token: fcmToken,
    notification: {
      title: title,
      body: body,
    },
    data: {
      type: type,
      messageId: messageId,
      userName: userName,
      messageText: messageText,
      title: title
    },
    android: {
      priority: 'high',
      notification: {
        sound: 'default',
        priority: 'high'
      }
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          contentAvailable: true
        }
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

// Слушаем изменения в коллекции messages
console.log('🔍 Начинаем прослушивание коллекции messages...');

db.collection('messages').onSnapshot(async (snapshot) => {
  console.log(`📨 Получено изменение: ${snapshot.docChanges().length} изменений`);
  
  // Используем for...of для корректной обработки асинхронных операций
  for (const change of snapshot.docChanges()) {
    if (change.type === 'added') {
      const message = change.doc.data();
      const messageId = change.doc.id;
      
      console.log(`📨 Новое сообщение от ${message.userName}: ${message.text?.substring(0, 50)}...`);
      
      // Игнорируем служебные сообщения о заходе
      if (message.type === 'entry') {
        console.log('⏩ Пропускаем служебное сообщение');
        continue;
      }
      
      const text = message.text || '';
      
      // ========== 1. Поиск упоминаний (исправленное регулярное выражение) ==========
      // Поддерживает форматы @[Имя Пользователя] и @Имя
      const mentionRegex = /@\[([^\]]+)\]|@([\wа-яА-ЯёЁ]+)/g;
      let match;
      while ((match = mentionRegex.exec(text)) !== null) {
        // Имя может быть в группе 1 (если формат @[...]) или в группе 2 (если @слово)
        const username = (match[1] || match[2]).trim();
        if (!username) continue;
        
        console.log(`🔍 Поиск пользователя: ${username}`);
        
        // Ищем пользователя по имени (регистронезависимый поиск)
        const userQuery = await db.collection('users')
          .where('name', '==', username)
          .limit(1)
          .get();
          
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          
          console.log(`📱 Найден пользователь ${username}, fcmToken: ${fcmToken ? 'есть' : 'нет'}`);
          
          // Не отправляем уведомление автору сообщения
          if (userId === message.userId) {
            console.log(`⏩ Не отправляем уведомление автору сообщения`);
            continue;
          }
          
          if (fcmToken) {
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
          } else {
            console.log(`⚠️ Нет FCM токена для пользователя ${username}`);
          }
        } else {
          console.log(`❌ Пользователь ${username} не найден`);
        }
      }
      
      // ========== 2. Обработка ответов ==========
      if (message.replyTo && message.replyTo.author) {
        const repliedAuthor = message.replyTo.author;
        console.log(`🔍 Ответ на сообщение пользователя: ${repliedAuthor}`);
        
        const userQuery = await db.collection('users')
          .where('name', '==', repliedAuthor)
          .limit(1)
          .get();
          
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          
          console.log(`📱 Найден пользователь ${repliedAuthor}, fcmToken: ${fcmToken ? 'есть' : 'нет'}`);
          
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
        } else {
          console.log(`❌ Пользователь ${repliedAuthor} не найден`);
        }
      }
    }
  }
}, (error) => {
  console.error('❌ Ошибка Firestore:', error);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`✅ FCM Notifier запущен на порту ${PORT}`);
  console.log(`📡 Сервер доступен по адресу: http://localhost:${PORT}`);
  console.log('🔍 Ожидание новых сообщений в Firestore...');
});
