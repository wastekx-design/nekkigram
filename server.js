const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new Database('nekkigram.db');
db.pragma('foreign_keys = ON');

// Таблицы
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT DEFAULT '',
        bio TEXT DEFAULT '',
        token TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT DEFAULT 'private' CHECK(type IN ('private','group','channel')),
        name TEXT,
        creator_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS chat_members (
        chat_id INTEGER,
        user_id INTEGER,
        role TEXT DEFAULT 'member' CHECK(role IN ('owner','admin','member','subscriber')),
        unread_count INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        text TEXT,
        reply_to INTEGER,
        edited INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER,
        user_id INTEGER,
        text TEXT,
        views INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
    );
`);

// Канал Nekkigram
const official = db.prepare("SELECT id FROM chats WHERE name = 'Nekkigram' AND type = 'channel'").get();
if (!official) {
    db.prepare("INSERT INTO chats (type, name) VALUES ('channel', 'Nekkigram')").run();
}

app.use(express.static('public'));
app.use(express.json());

// ===== API =====
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Заполните все поля' });
    if (username.length < 2) return res.json({ ok: false, error: 'Имя слишком короткое' });
    if (password.length < 3) return res.json({ ok: false, error: 'Пароль слишком короткий' });

    try {
        const token = 'tok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        const result = db.prepare('INSERT INTO users (username, password, token) VALUES (?, ?, ?)').run(username, password, token);
        
        // Подписка на Nekkigram
        const nekki = db.prepare("SELECT id FROM chats WHERE name = 'Nekkigram'").get();
        if (nekki) {
            db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'subscriber')").run(nekki.id, result.lastInsertRowid);
        }

        res.json({
            ok: true,
            token,
            user: { id: result.lastInsertRowid, username, avatar: '', bio: '' }
        });
    } catch (e) {
        res.json({ ok: false, error: 'Имя уже занято' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ? AND password = ?').get(username, password);
    if (!user) return res.json({ ok: false, error: 'Неверное имя или пароль' });

    const token = 'tok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, user.id);

    res.json({
        ok: true,
        token,
        user: { id: user.id, username: user.username, avatar: user.avatar || '', bio: user.bio || '' }
    });
});

app.post('/api/check_token', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE token = ?').get(req.body.token);
    if (!user) return res.json({ ok: false });
    res.json({ ok: true, user: { id: user.id, username: user.username, avatar: user.avatar || '', bio: user.bio || '' } });
});

// ===== SOCKET =====
io.on('connection', (socket) => {
    let userId = null;
    let username = null;

    socket.on('auth', (token, callback) => {
        const user = db.prepare('SELECT * FROM users WHERE token = ?').get(token);
        if (!user) return callback({ ok: false });

        userId = user.id;
        username = user.username;
        socket.userId = userId;
        socket.username = username;

        callback({
            ok: true,
            user: { id: user.id, username: user.username, avatar: user.avatar || '', bio: user.bio || '' }
        });

        sendChatList();
    });

    function sendChatList() {
        if (!userId) return;

        // Подписка на Nekkigram
        const nekki = db.prepare("SELECT id FROM chats WHERE name = 'Nekkigram'").get();
        if (nekki) {
            db.prepare("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'subscriber')").run(nekki.id, userId);
        }

        const chats = db.prepare(`
            SELECT c.*, cm.unread_count, cm.role,
                   (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_message,
                   (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_msg_time,
                   (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) as members_count
            FROM chats c
            JOIN chat_members cm ON c.id = cm.chat_id
            WHERE cm.user_id = ?
            ORDER BY c.id DESC
        `).all(userId);

        socket.emit('chat_list', chats);
    }

    socket.on('get_chats', () => sendChatList());

    socket.on('join_chat', (chatId) => {
        if (!userId) return;
        const member = db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
        if (!member) return;

        socket.join(`chat:${chatId}`);
        db.prepare('UPDATE chat_members SET unread_count = 0 WHERE chat_id = ? AND user_id = ?').run(chatId, userId);

        const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
        let history;

        if (chat.type === 'channel') {
            history = db.prepare(`
                SELECT p.*, u.username FROM posts p
                JOIN users u ON p.user_id = u.id
                WHERE p.chat_id = ? ORDER BY p.id DESC LIMIT 50
            `).all(chatId);
            socket.emit('chat_history', history.reverse(), 'channel');
        } else {
            history = db.prepare(`
                SELECT m.*, u.username FROM messages m
                JOIN users u ON m.user_id = u.id
                WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 50
            `).all(chatId);

            history.reverse().forEach(msg => {
                if (msg.reply_to) {
                    msg.reply_msg = db.prepare('SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?').get(msg.reply_to);
                }
            });

            socket.emit('chat_history', history.reverse(), chat.type);
        }
    });

    socket.on('send_message', (chatId, text, replyTo) => {
        if (!userId || !text) return;
        const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
        if (!chat) return;

        const member = db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
        if (!member) return;

        if (chat.type === 'channel') {
            if (member.role !== 'owner' && member.role !== 'admin') return;
            db.prepare('INSERT INTO posts (chat_id, user_id, text) VALUES (?, ?, ?)').run(chatId, userId, text);
            io.to(`chat:${chatId}`).emit('new_post', {
                username, text,
                time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            });
        } else {
            db.prepare('INSERT INTO messages (chat_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)').run(chatId, userId, text, replyTo || null);
            const msgId = db.prepare('SELECT last_insert_rowid()').get()['last_insert_rowid()'];

            const msgData = {
                id: msgId, chat_id: chatId, userId, username,
                text, reply_to: replyTo || null,
                time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
            };

            if (replyTo) {
                const reply = db.prepare('SELECT m.*, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?').get(replyTo);
                if (reply) msgData.reply_msg = reply;
            }

            io.to(`chat:${chatId}`).emit('new_message', msgData);

            const members = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').all(chatId, userId);
            members.forEach(m => {
                db.prepare('UPDATE chat_members SET unread_count = unread_count + 1 WHERE chat_id = ? AND user_id = ?').run(chatId, m.user_id);
            });
        }
    });

    socket.on('edit_message', (msgId, newText) => {
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(msgId, userId);
        if (!msg) return;
        db.prepare('UPDATE messages SET text = ?, edited = 1 WHERE id = ?').run(newText, msgId);
        io.to(`chat:${msg.chat_id}`).emit('message_edited', { id: msgId, text: newText });
    });

    socket.on('delete_message', (msgId) => {
        const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND user_id = ?').get(msgId, userId);
        if (!msg) return;
        db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
        io.to(`chat:${msg.chat_id}`).emit('message_deleted', msgId);
    });

    socket.on('create_private_chat', (targetUsername, callback) => {
        const target = db.prepare('SELECT id FROM users WHERE username = ?').get(targetUsername);
        if (!target) return callback({ ok: false, error: 'Пользователь не найден' });
        if (target.id === userId) return callback({ ok: false, error: 'Нельзя с собой' });

        const existing = db.prepare(`
            SELECT c.id FROM chats c
            JOIN chat_members m1 ON c.id = m1.chat_id AND m1.user_id = ?
            JOIN chat_members m2 ON c.id = m2.chat_id AND m2.user_id = ?
            WHERE c.type = 'private'
        `).get(userId, target.id);

        if (existing) return callback({ ok: true, chatId: existing.id });

        const chat = db.prepare("INSERT INTO chats (type) VALUES ('private')").run();
        db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chat.lastInsertRowid, userId);
        db.prepare('INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)').run(chat.lastInsertRowid, target.id);
        callback({ ok: true, chatId: chat.lastInsertRowid });
        sendChatList();
    });

    socket.on('create_group', (name, callback) => {
        const chat = db.prepare("INSERT INTO chats (type, name, creator_id) VALUES ('group', ?, ?)").run(name, userId);
        db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(chat.lastInsertRowid, userId);
        callback({ ok: true, chatId: chat.lastInsertRowid });
        sendChatList();
    });

    socket.on('create_channel', (name, callback) => {
        const chat = db.prepare("INSERT INTO chats (type, name, creator_id) VALUES ('channel', ?, ?)").run(name, userId);
        db.prepare("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')").run(chat.lastInsertRowid, userId);
        callback({ ok: true, chatId: chat.lastInsertRowid });
        sendChatList();
    });

    socket.on('update_profile', (data) => {
        if (!userId) return;
        if (data.username) {
            db.prepare('UPDATE users SET username = ? WHERE id = ?').run(data.username, userId);
            username = data.username;
        }
        if (data.bio !== undefined) db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(data.bio, userId);
        socket.emit('profile_updated', data);
    });

    socket.on('search_users', (query, callback) => {
        const users = db.prepare("SELECT id, username FROM users WHERE username LIKE ? AND id != ? LIMIT 15").all(`%${query}%`, userId);
        callback(users);
    });

    socket.on('get_feed', () => {
        if (!userId) return;
        const posts = db.prepare(`
            SELECT p.*, u.username, c.name as channel_name
            FROM posts p JOIN users u ON p.user_id = u.id
            JOIN chats c ON p.chat_id = c.id
            JOIN chat_members cm ON c.id = cm.chat_id AND cm.user_id = ?
            ORDER BY p.id DESC LIMIT 30
        `).all(userId);
        socket.emit('feed', posts);
    });

    socket.on('get_contacts', () => {
        if (!userId) return;
        const contacts = db.prepare(`
            SELECT DISTINCT u.id, u.username
            FROM users u
            JOIN chat_members cm1 ON u.id = cm1.user_id
            JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id
            WHERE cm2.user_id = ? AND u.id != ?
        `).all(userId, userId);
        socket.emit('contacts', contacts);
    });
});

server.listen(3000, () => console.log('Nekkigram запущен на http://localhost:3000'));