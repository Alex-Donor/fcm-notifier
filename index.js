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
async function sendNotification(fcmToken, title, body, type, messageId, userName, messageText, reactionEmoji = '') {
  const message = {
    token: fcmToken,
    notification: { title, body },
    data: {
      type: type,
      messageId: messageId,
      userName: userName || '',
      messageText: messageText || '',
      title: title,
      reactionEmoji: reactionEmoji
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
  .where('timestamp', '>', SERVER_START_TIME)
  .onSnapshot(async (snapshot) => {
    console.log(`📨 Получено изменение: ${snapshot.docChanges().length} изменений (только новые)`);
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'added') continue;

      const message = change.doc.data();
      const messageId = change.doc.id;
      const text = message.text || '';

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

// ========== 2. СЛУШАТЕЛЬ ИЗМЕНЕНИЙ СУЩЕСТВУЮЩИХ СООБЩЕНИЙ (реакции) ==========
console.log('🔍 Запускаем слушатель изменений сообщений (для реакций)');
// Хранилище уже отправленных уведомлений о реакциях (чтобы не дублировать)
const sentReactionNotifications = new Set();

db.collection('messages')
  .onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type !== 'modified') continue;
      
      // ВАЖНО: проверяем, что prev существует (при первой загрузке его может не быть)
      if (!change.doc.prev) {
        console.log('ℹ️ Пропускаем изменение без prev данных');
        continue;
      }
      
      const newData = change.doc.data();
      const oldData = change.doc.prev.data();
      const messageId = change.doc.id;

      // Проверяем, изменилось ли поле reactions
      const oldReactions = oldData?.reactions || {};
      const newReactions = newData?.reactions || {};

      // Находим добавленные эмодзи (которых не было в старой версии или увеличилось количество)
      const addedEmojis = [];
      for (const [emoji, react] of Object.entries(newReactions)) {
        const oldCount = oldReactions[emoji]?.count || 0;
        if (react.count > oldCount) {
          // Определяем, какой пользователь добавил реакцию (новый в массиве users)
          const oldUsers = oldReactions[emoji]?.users || [];
          const newUsers = react.users || [];
          const addedUser = newUsers.find(uid => !oldUsers.includes(uid));
          if (addedUser) {
            addedEmojis.push({ emoji, userId: addedUser, count: react.count });
          }
        }
      }

      if (addedEmojis.length === 0) continue;

      // Для каждого добавленного эмодзи отправляем уведомление автору сообщения
      const messageAuthorId = newData.userId;
      if (!messageAuthorId) continue;

      const reactorId = addedEmojis[0].userId;
      // Уникальный ключ для предотвращения дублей (сообщение + реакция + пользователь)
      const notificationKey = `${messageId}_${reactorId}_${addedEmojis.map(e=>e.emoji).join(',')}`;
      if (sentReactionNotifications.has(notificationKey)) {
        console.log(`ℹ️ Уведомление уже отправлено: ${notificationKey}`);
        continue;
      }

      if (reactorId === messageAuthorId) {
        console.log(`ℹ️ Пользователь ${reactorId} поставил реакцию на своё сообщение — уведомление не требуется`);
        continue;
      }

      // Получаем данные автора сообщения (чтобы взять его FCM токен)
      const authorDoc = await db.collection('users').doc(messageAuthorId).get();
      if (!authorDoc.exists) continue;
      const fcmToken = authorDoc.data().fcmToken;
      if (!fcmToken) {
        console.log(`⚠️ У автора сообщения ${messageAuthorId} нет FCM токена`);
        continue;
      }

      // Получаем имя пользователя, поставившего реакцию
      let reactorName = 'Пользователь';
      const reactorDoc = await db.collection('users').doc(reactorId).get();
      if (reactorDoc.exists) reactorName = reactorDoc.data().name || reactorName;

      const emojiList = addedEmojis.map(e => e.emoji).join(', ');
      const shortMessageText = (newData.text || '').substring(0, 80);
      await sendNotification(
        fcmToken,
        `😊 Новая реакция на ваше сообщение`,
        `${reactorName} поставил(а) ${emojiList} на: "${shortMessageText}"`,
        'reaction',
        messageId,
        reactorName,
        shortMessageText,
        emojiList
      );
      
      // Запоминаем, что уведомление отправлено
      sentReactionNotifications.add(notificationKey);
      // Очищаем старые ключи (не более 1000)
      if (sentReactionNotifications.size > 1000) {
        const toDelete = [...sentReactionNotifications].slice(0, 500);
        toDelete.forEach(key => sentReactionNotifications.delete(key));
      }
    }
  }, (error) => {
    console.error('❌ Ошибка слушателя изменений (реакции):', error);
  });

// ========== 3. ПЕРИОДИЧЕСКАЯ ПРОВЕРКА ПРОСРОЧЕК ЗАХОДОВ (раз в минуту) ==========
async function checkOverdueEntries() {
  try {
    const snapshot = await db.collection('messages')
      .where('type', '==', 'entry')
      .where('actualExitDisplay', '==', null)
      .get();

    for (const doc of snapshot.docs) {
      const entry = doc.data();
      const entryId = doc.id;
      if (entry.overdueNotified) continue;

      if (entry.controlDate && entry.controlDate !== 'no_kv' && entry.controlTime) {
        if (isOverdue(entry.controlDate, entry.controlTime)) {
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
              await doc.ref.update({ overdueNotified: true });
              console.log(`📤 Отправлено уведомление о просрочке для ${controllerName} (${controllerId})`);
            } else {
              console.log(`⚠️ Нет FCM токена для контролёра ${controllerName}`);
            }
          } else {
            console.log(`ℹ️ Выход ${entry.userName} просрочен, но контроль никем не взят`);
            await doc.ref.update({ overdueNotified: true });
          }
        }
      }
    }
  } catch (err) {
    console.error('❌ Ошибка при проверке просрочек:', err);
  }
}

setInterval(checkOverdueEntries, 5 * 60 * 1000);
checkOverdueEntries();

// ========== ЗАПУСК СЕРВЕРА ==========
app.listen(PORT, () => {
  console.log(`✅ FCM Notifier запущен на порту ${PORT}`);
  console.log(`📡 Сервер доступен по адресу: http://localhost:${PORT}`);
  console.log(`🕒 Игнорируем старые сообщения (до ${SERVER_START_TIME.toISOString()})`);
  console.log('🔍 Ожидание новых сообщений и реакций в Firestore...');
});
