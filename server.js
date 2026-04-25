const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));
app.use(express.json());

let db;

async function initDB() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync('nekkigram.db')) {
        const buffer = fs.readFileSync('nekkigram.db');
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    
    db.run("PRAGMA foreign_keys = ON");
    
    db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, first_name TEXT DEFAULT '', last_name TEXT DEFAULT '', username TEXT UNIQUE, password TEXT, avatar TEXT DEFAULT '', bio TEXT DEFAULT '', token TEXT UNIQUE)`);
    db.run(`CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT DEFAULT 'private', name TEXT, creator_id INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS chat_members (chat_id INTEGER, user_id INTEGER, role TEXT DEFAULT 'member', unread_count INTEGER DEFAULT 0, PRIMARY KEY (chat_id, user_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, user_id INTEGER, text TEXT, reply_to INTEGER, edited INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    db.run(`CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, user_id INTEGER, text TEXT, views INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))`);
    
    saveDB();
}

function saveDB() { const data = db.export(); fs.writeFileSync('nekkigram.db', Buffer.from(data)); }

function run(sql, params = []) { db.run(sql, params); saveDB(); }

function get(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return row;
    }
    stmt.free();
    return null;
}

function all(sql, params = []) {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
        rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
}

// Создаём канал Nekkigram при старте
function createOfficialChannel() {
    const ch = get("SELECT id FROM chats WHERE name = 'Nekkigram' AND type = 'channel'");
    if (!ch) {
        run("INSERT INTO chats (type, name) VALUES ('channel', 'Nekkigram')");
    }
}

// ===== API =====
app.post('/api/register', (req, res) => {
    const { first_name, last_name, username, password } = req.body;
    if (!first_name || !password) return res.json({ ok: false, error: 'Имя и пароль обязательны' });
    if (password.length < 3) return res.json({ ok: false, error: 'Пароль короткий' });
    
    if (username) {
        const exist = get("SELECT id FROM users WHERE username = ?", [username]);
        if (exist) return res.json({ ok: false, error: 'Юзернейм занят' });
    }
    
    const token = 'tok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    run('INSERT INTO users (first_name, last_name, username, password, token) VALUES (?, ?, ?, ?, ?)', [first_name, last_name || '', username || null, password, token]);
    
    const uid = get("SELECT last_insert_rowid() as id").id;
    
    // Подписка на Nekkigram
    const nekki = get("SELECT id FROM chats WHERE name = 'Nekkigram'");
    if (nekki) {
        run("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'subscriber')", [nekki.id, uid]);
    }
    
    res.json({ ok: true, token, user: { id: uid, first_name, last_name: last_name || '', username: username || '', avatar: '', bio: '' } });
});

app.post('/api/login', (req, res) => {
    const { login, password } = req.body;
    const user = get("SELECT * FROM users WHERE (username = ? OR first_name = ?) AND password = ?", [login, login, password]);
    if (!user) return res.json({ ok: false, error: 'Неверные данные' });
    
    const token = 'tok_' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    run("UPDATE users SET token = ? WHERE id = ?", [token, user.id]);
    
    res.json({ ok: true, token, user: { id: user.id, first_name: user.first_name, last_name: user.last_name || '', username: user.username || '', avatar: user.avatar || '', bio: user.bio || '' } });
});

app.post('/api/check_token', (req, res) => {
    const user = get("SELECT * FROM users WHERE token = ?", [req.body.token]);
    if (!user) return res.json({ ok: false });
    res.json({ ok: true, user: { id: user.id, first_name: user.first_name, last_name: user.last_name || '', username: user.username || '', avatar: user.avatar || '', bio: user.bio || '' } });
});

// ===== SOCKET =====
io.on('connection', (socket) => {
    let userId = null;
    let currentUser = null;
    
    socket.on('auth', (token, callback) => {
        const user = get("SELECT * FROM users WHERE token = ?", [token]);
        if (!user) return callback({ ok: false });
        userId = user.id;
        currentUser = user;
        socket.userId = userId;
        callback({ ok: true, user: { id: user.id, first_name: user.first_name, last_name: user.last_name || '', username: user.username || '', avatar: user.avatar || '', bio: user.bio || '' } });
        sendChatList();
    });

    function displayName(u) {
        if (!u) return '';
        return u.username ? '@' + u.username : u.first_name + (u.last_name ? ' ' + u.last_name : '');
    }

    function sendChatList() {
        if (!userId) return;
        
        // Авто-подписка на Nekkigram
        const nekki = get("SELECT id FROM chats WHERE name = 'Nekkigram'");
        if (nekki) run("INSERT OR IGNORE INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'subscriber')", [nekki.id, userId]);
        
        const chats = all(`
            SELECT c.*, cm.unread_count,
                   (SELECT text FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_message,
                   (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY id DESC LIMIT 1) as last_msg_time
            FROM chats c JOIN chat_members cm ON c.id = cm.chat_id WHERE cm.user_id = ? ORDER BY c.id DESC
        `, [userId]);
        socket.emit('chat_list', chats);
    }

    socket.on('get_chats', () => sendChatList());

    socket.on('join_chat', (chatId) => {
        if (!userId) return;
        const member = get("SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
        if (!member) return;
        
        socket.join('chat:' + chatId);
        run("UPDATE chat_members SET unread_count = 0 WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
        
        const chat = get("SELECT * FROM chats WHERE id = ?", [chatId]);
        let history;
        
        if (chat.type === 'channel') {
            history = all("SELECT p.*, u.first_name, u.last_name, u.username FROM posts p JOIN users u ON p.user_id = u.id WHERE p.chat_id = ? ORDER BY p.id DESC LIMIT 50", [chatId]).reverse();
            history.forEach(h => h.displayName = displayName(h));
        } else {
            history = all("SELECT m.*, u.first_name, u.last_name, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 50", [chatId]);
            history.reverse().forEach(msg => {
                msg.displayName = displayName(msg);
                if (msg.reply_to) {
                    const reply = get("SELECT m.*, u.first_name, u.last_name, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?", [msg.reply_to]);
                    if (reply) { reply.displayName = displayName(reply); msg.reply_msg = reply; }
                }
            });
        }
        socket.emit('chat_history', history, chat.type);
    });

    socket.on('send_message', (chatId, text, replyTo) => {
        if (!userId || !text) return;
        const chat = get("SELECT * FROM chats WHERE id = ?", [chatId]);
        if (!chat) return;
        const member = get("SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?", [chatId, userId]);
        if (!member) return;
        
        if (chat.type === 'channel') {
            if (member.role !== 'owner' && member.role !== 'admin') return;
            run("INSERT INTO posts (chat_id, user_id, text) VALUES (?, ?, ?)", [chatId, userId, text]);
            io.to('chat:' + chatId).emit('new_post', { displayName: displayName(currentUser), text, time: new Date().toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) });
        } else {
            run("INSERT INTO messages (chat_id, user_id, text, reply_to) VALUES (?, ?, ?, ?)", [chatId, userId, text, replyTo || null]);
            const mid = get("SELECT last_insert_rowid() as id").id;
            const msgData = { id: mid, chat_id: chatId, userId, displayName: displayName(currentUser), text, reply_to: replyTo || null, time: new Date().toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) };
            if (replyTo) {
                const reply = get("SELECT m.*, u.first_name, u.last_name, u.username FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = ?", [replyTo]);
                if (reply) { reply.displayName = displayName(reply); msgData.reply_msg = reply; }
            }
            io.to('chat:' + chatId).emit('new_message', msgData);
            all("SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?", [chatId, userId]).forEach(m => {
                run("UPDATE chat_members SET unread_count = unread_count + 1 WHERE chat_id = ? AND user_id = ?", [chatId, m.user_id]);
            });
        }
    });

    socket.on('create_private_chat', (targetUsername, callback) => {
        const target = get("SELECT id FROM users WHERE username = ? OR first_name = ?", [targetUsername, targetUsername]);
        if (!target) return callback({ ok: false, error: 'Пользователь не найден' });
        if (target.id === userId) return callback({ ok: false, error: 'Нельзя с собой' });
        const exist = get("SELECT c.id FROM chats c JOIN chat_members m1 ON c.id = m1.chat_id AND m1.user_id = ? JOIN chat_members m2 ON c.id = m2.chat_id AND m2.user_id = ? WHERE c.type = 'private'", [userId, target.id]);
        if (exist) return callback({ ok: true, chatId: exist.id });
        run("INSERT INTO chats (type) VALUES ('private')");
        const cid = get("SELECT last_insert_rowid() as id").id;
        run("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)", [cid, userId]);
        run("INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)", [cid, target.id]);
        callback({ ok: true, chatId: cid });
        sendChatList();
    });

    socket.on('create_group', (name, callback) => {
        run("INSERT INTO chats (type, name, creator_id) VALUES ('group', ?, ?)", [name, userId]);
        const cid = get("SELECT last_insert_rowid() as id").id;
        run("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')", [cid, userId]);
        callback({ ok: true, chatId: cid });
        sendChatList();
    });

    socket.on('create_channel', (name, callback) => {
        run("INSERT INTO chats (type, name, creator_id) VALUES ('channel', ?, ?)", [name, userId]);
        const cid = get("SELECT last_insert_rowid() as id").id;
        run("INSERT INTO chat_members (chat_id, user_id, role) VALUES (?, ?, 'owner')", [cid, userId]);
        callback({ ok: true, chatId: cid });
        sendChatList();
    });

    socket.on('edit_message', (msgId, newText) => {
        const msg = get("SELECT * FROM messages WHERE id = ? AND user_id = ?", [msgId, userId]);
        if (!msg) return;
        run("UPDATE messages SET text = ?, edited = 1 WHERE id = ?", [newText, msgId]);
        io.to('chat:' + msg.chat_id).emit('message_edited', { id: msgId, text: newText });
    });

    socket.on('delete_message', (msgId) => {
        const msg = get("SELECT * FROM messages WHERE id = ? AND user_id = ?", [msgId, userId]);
        if (!msg) return;
        run("DELETE FROM messages WHERE id = ?", [msgId]);
        io.to('chat:' + msg.chat_id).emit('message_deleted', msgId);
    });

    socket.on('update_profile', (data) => {
        if (!userId) return;
        if (data.first_name) run("UPDATE users SET first_name = ? WHERE id = ?", [data.first_name, userId]);
        if (data.last_name !== undefined) run("UPDATE users SET last_name = ? WHERE id = ?", [data.last_name, userId]);
        if (data.bio !== undefined) run("UPDATE users SET bio = ? WHERE id = ?", [data.bio, userId]);
        currentUser = get("SELECT * FROM users WHERE id = ?", [userId]);
    });

    socket.on('search_users', (query, callback) => {
        const users = all("SELECT id, first_name, last_name, username FROM users WHERE (first_name LIKE ? OR username LIKE ?) AND id != ? LIMIT 15", ['%'+query+'%', '%'+query+'%', userId]);
        callback(users);
    });

    socket.on('get_feed', () => {
        const posts = all("SELECT p.*, u.first_name, u.last_name, u.username, c.name as channel_name FROM posts p JOIN users u ON p.user_id = u.id JOIN chats c ON p.chat_id = c.id JOIN chat_members cm ON c.id = cm.chat_id AND cm.user_id = ? ORDER BY p.id DESC LIMIT 30", [userId]);
        posts.forEach(p => p.displayName = p.username ? '@'+p.username : p.first_name);
        socket.emit('feed', posts);
    });

    socket.on('get_contacts', () => {
        const contacts = all("SELECT DISTINCT u.id, u.first_name, u.last_name, u.username FROM users u JOIN chat_members cm1 ON u.id = cm1.user_id JOIN chat_members cm2 ON cm1.chat_id = cm2.chat_id WHERE cm2.user_id = ? AND u.id != ?", [userId, userId]);
        socket.emit('contacts', contacts);
    });
});

// ===== ЗАПУСК =====
initDB().then(() => {
    createOfficialChannel();
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => console.log('Nekkigram запущен на порту ' + PORT));
}).catch(err => console.error('Ошибка:', err));