const admin = require('firebase-admin');
const express = require('express');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
const PORT = process.env.PORT || 3000;
const SERVER_START_TIME = new Date();

app.get('/', (req, res) => {
  res.send('FCM Notifier is running');
});

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
    android: { priority: 'high', notification: { sound: 'default', priority: 'high' } },
    apns: { payload: { aps: { sound: 'default', contentAvailable: true } } }
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

function isOverdue(controlDate, controlTime) {
  if (!controlDate || controlDate === 'no_kv' || !controlTime) return false;
  const now = new Date();
  const controlDateTime = new Date(`${controlDate}T${controlTime}:00+03:00`);
  return now >= controlDateTime;
}

// ========== 1. СЛУШАТЕЛЬ НОВЫХ СООБЩЕНИЙ (упоминания и ответы) ==========
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
      // упоминания
      const mentionRegex = /@\[([^\]]+)\]|@([\wа-яА-ЯёЁ]+)/g;
      let match;
      while ((match = mentionRegex.exec(text)) !== null) {
        const username = (match[1] || match[2]).trim();
        if (!username) continue;
        const userQuery = await db.collection('users').where('name', '==', username).limit(1).get();
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          if (userId !== message.userId && fcmToken) {
            await sendNotification(fcmToken, `🔔 Упоминание в чате`, `${message.userName}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`, 'mention', messageId, message.userName, text);
          }
        }
      }
      // ответы
      if (message.replyTo && message.replyTo.author) {
        const repliedAuthor = message.replyTo.author;
        const userQuery = await db.collection('users').where('name', '==', repliedAuthor).limit(1).get();
        if (!userQuery.empty) {
          const userDoc = userQuery.docs[0];
          const userId = userDoc.id;
          const fcmToken = userDoc.data().fcmToken;
          if (userId !== message.userId && fcmToken) {
            await sendNotification(fcmToken, `💬 Ответ на ваше сообщение`, `${message.userName}: ${text.substring(0, 100)}${text.length > 100 ? '...' : ''}`, 'reply', messageId, message.userName, text);
          }
        }
      }
    }
  }, (error) => {
    console.error('❌ Ошибка слушателя новых сообщений:', error);
  });

// ========== 2. СЛУШАТЕЛЬ ИЗМЕНЕНИЙ ВСЕХ СООБЩЕНИЙ (реакции) ==========
console.log('🔍 Запускаем слушатель изменений сообщений (для реакций)');
const previousReactions = new Map(); // messageId -> reactions объект
const sentNotificationKeys = new Set();

db.collection('messages')
  .onSnapshot(async (snapshot) => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'removed') {
        previousReactions.delete(change.doc.id);
        continue;
      }
      const messageId = change.doc.id;
      const newData = change.doc.data();
      // Пропускаем системные и entry сообщения
      if (newData.type !== 'regular') continue;

      const newReactions = newData.reactions || {};
      const oldReactions = previousReactions.get(messageId) || {};

      // Ищем добавленные реакции (появление нового userId в массиве users)
      const addedReactions = [];
      for (const [emoji, newReact] of Object.entries(newReactions)) {
        const oldReact = oldReactions[emoji] || { count: 0, users: [] };
        const oldUsers = oldReact.users || [];
        const newUsers = newReact.users || [];
        const addedUser = newUsers.find(uid => !oldUsers.includes(uid));
        if (addedUser) {
          addedReactions.push({ emoji, userId: addedUser });
        }
      }

      if (addedReactions.length > 0) {
        const messageAuthorId = newData.userId;
        if (messageAuthorId) {
          for (const react of addedReactions) {
            const reactorId = react.userId;
            if (reactorId === messageAuthorId) {
              console.log(`ℹ️ Пользователь ${reactorId} поставил реакцию на своё сообщение — уведомление не требуется`);
              continue;
            }
            const key = `${messageId}_${reactorId}_${react.emoji}`;
            if (sentNotificationKeys.has(key)) {
              console.log(`ℹ️ Уведомление о реакции ${react.emoji} уже отправлено для ${messageId} от ${reactorId}`);
              continue;
            }
            // Получаем FCM токен автора сообщения
            const authorDoc = await db.collection('users').doc(messageAuthorId).get();
            if (!authorDoc.exists) {
              console.log(`⚠️ Автор сообщения ${messageAuthorId} не найден`);
              continue;
            }
            const fcmToken = authorDoc.data().fcmToken;
            if (!fcmToken) {
              console.log(`⚠️ У автора ${messageAuthorId} нет FCM токена`);
              continue;
            }
            // Имя поставившего реакцию
            let reactorName = 'Пользователь';
            const reactorDoc = await db.collection('users').doc(reactorId).get();
            if (reactorDoc.exists) reactorName = reactorDoc.data().name || reactorName;
            const shortText = (newData.text || '').substring(0, 80);
            await sendNotification(
              fcmToken,
              `😊 Новая реакция`,
              `${reactorName} поставил(а) ${react.emoji} на: "${shortText}"`,
              'reaction',
              messageId,
              reactorName,
              shortText,
              react.emoji
            );
            sentNotificationKeys.add(key);
            // Очистка старых ключей
            if (sentNotificationKeys.size > 2000) {
              const toDelete = [...sentNotificationKeys].slice(0, 1000);
              toDelete.forEach(k => sentNotificationKeys.delete(k));
            }
          }
        }
      }
      // Сохраняем текущее состояние реакций для будущих сравнений
      previousReactions.set(messageId, JSON.parse(JSON.stringify(newReactions)));
    }
  }, (error) => {
    console.error('❌ Ошибка слушателя изменений (реакции):', error);
  });

// ========== 3. ПРОВЕРКА ПРОСРОЧЕК ==========
async function checkOverdueEntries() {
  try {
    const snapshot = await db.collection('messages')
      .where('type', '==', 'entry')
      .where('actualExitDisplay', '==', null)
      .get();
    for (const doc of snapshot.docs) {
      const entry = doc.data();
      if (entry.overdueNotified) continue;
      if (entry.controlDate && entry.controlDate !== 'no_kv' && entry.controlTime && isOverdue(entry.controlDate, entry.controlTime)) {
        if (entry.controlTakenBy && entry.controlTakenBy.userId) {
          const controllerId = entry.controlTakenBy.userId;
          const userDoc = await db.collection('users').doc(controllerId).get();
          const fcmToken = userDoc.exists ? userDoc.data().fcmToken : null;
          if (fcmToken) {
            await sendNotification(fcmToken, `⚠️ Просрочка выхода!`, `Выход пользователя ${entry.userName} просрочен. Контроль у вас.`, 'overdue', doc.id, entry.userName, '');
            await doc.ref.update({ overdueNotified: true });
          }
        } else {
          await doc.ref.update({ overdueNotified: true });
        }
      }
    }
  } catch (err) {
    console.error('❌ Ошибка при проверке просрочек:', err);
  }
}
setInterval(checkOverdueEntries, 5 * 60 * 1000);
checkOverdueEntries();

app.listen(PORT, () => {
  console.log(`✅ FCM Notifier запущен на порту ${PORT}`);
  console.log(`📡 Сервер доступен по адресу: http://localhost:${PORT}`);
  console.log(`🕒 Игнорируем старые сообщения (до ${SERVER_START_TIME.toISOString()})`);
  console.log('🔍 Ожидание новых сообщений и реакций в Firestore...');
});
