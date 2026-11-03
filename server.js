const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'chave-secreta-super-segura-voos',
    resave: false,
    saveUninitialized: false
}));

// Configuração da Base de Dados SQLite
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error('Erro ao abrir a base de dados', err.message);
    } else {
        console.log('Conectado à base de dados SQLite.');
        criarTabelas();
    }
});

function criarTabelas() {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'client'
    )`, () => {
        db.get(`SELECT * FROM users WHERE username = 'admin'`, async (err, row) => {
            if (!row) {
                const hashedPassword = await bcrypt.hash('admin123', 10);
                db.run(`INSERT INTO users (username, password, role) VALUES ('admin', ?, 'admin')`, [hashedPassword]);
                console.log('Utilizador admin criado (user: admin / pass: admin123)');
            }
        });
    });

    db.run(`CREATE TABLE IF NOT EXISTS flight_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        origin TEXT,
        destination TEXT,
        departure_date TEXT,
        max_stops TEXT,
        currency TEXT,
        telegram_chat_id TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);
}

// --- ROTAS DO PAINEL WEB ---

app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    res.send(`
        <h2>Login - Painel de Bots de Voos</h2>
        <form action="/login" method="POST">
            <input type="text" name="username" placeholder="Utilizador" required /><br><br>
            <input type="password" name="password" placeholder="Palavra-passe" required /><br><br>
            <button type="submit">Entrar</button>
        </form>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (user && await bcrypt.compare(password, user.password)) {
            req.session.user = user;
            if (user.role === 'admin') {
                res.redirect('/admin');
            } else {
                res.redirect('/dashboard');
            }
        } else {
            res.send('Utilizador ou palavra-passe incorretos. <a href="/login">Voltar</a>');
        }
    });
});

app.get('/dashboard', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const userId = req.session.user.id;
    db.get(`SELECT * FROM flight_configs WHERE user_id = ?`, [userId], (err, config) => {
        res.send(`
            <h2>Painel do Cliente - Configurar Alerta de Voo</h2>
            <form action="/update-config" method="POST">
                <label>Origem (IATA):</label><br>
                <input type="text" name="origin" value="${config ? config.origin : 'GRU'}" /><br><br>
                
                <label>Destino (IATA):</label><br>
                <input type="text" name="destination" value="${config ? config.destination : 'MCZ'}" /><br><br>
                
                <label>Data de Partida (YYYY-MM-DD):</label><br>
                <input type="text" name="departure_date" value="${config ? config.departure_date : '2026-12-31'}" /><br><br>
                
                <label>Tipo de Voo:</label>
                <select name="max_stops">
                    <option value="nonstop" ${config && config.max_stops === 'nonstop' ? 'selected' : ''}>Apenas Direto</option>
                    <option value="any" ${config && config.max_stops === 'any' ? 'selected' : ''}>Aceita Escalas</option>
                </select><br><br>

                <label>Chat ID do Telegram:</label><br>
                <input type="text" name="telegram_chat_id" value="${config ? config.telegram_chat_id : ''}" /><br><br>
                
                <button type="submit">Guardar Configurações</button>
            </form>
            <br><a href="/logout">Terminar Sessão</a>
        `);
    });
});

app.post('/update-config', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const userId = req.session.user.id;
    const { origin, destination, departure_date, max_stops, telegram_chat_id } = req.body;

    db.get(`SELECT * FROM flight_configs WHERE user_id = ?`, [userId], (err, row) => {
        if (row) {
            db.run(`UPDATE flight_configs SET origin = ?, destination = ?, departure_date = ?, max_stops = ?, telegram_chat_id = ? WHERE user_id = ?`,
                [origin, destination, departure_date, max_stops, telegram_chat_id, userId], () => {
                    res.redirect('/dashboard');
                });
        } else {
            db.run(`INSERT INTO flight_configs (user_id, origin, destination, departure_date, max_stops, currency, telegram_chat_id) VALUES (?, ?, ?, ?, ?, 'BRL', ?)`,
                [userId, origin, destination, departure_date, max_stops, telegram_chat_id], () => {
                    res.redirect('/dashboard');
                });
        }
    });
});

app.get('/admin', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');

    db.all(`SELECT users.id, users.username, flight_configs.origin, flight_configs.destination, flight_configs.departure_date 
            FROM users LEFT JOIN flight_configs ON users.id = flight_configs.user_id WHERE users.role = 'client'`, (err, rows) => {
        
        let html = `<h2>Painel Administrativo</h2>`;
        html += `<h3>Criar Novo Cliente</h3>
                 <form action="/admin/create-user" method="POST">
                    <input type="text" name="username" placeholder="Novo Utilizador" required />
                    <input type="password" name="password" placeholder="Palavra-passe" required />
                    <button type="submit">Criar Utilizador</button>
                 </form><hr>`;
        
        html += `<h3>Clientes e Configurações Atuais</h3><ul>`;
        rows.forEach(r => {
            html += `<li><b>${r.username}</b> - Rota: ${r.origin || 'N/D'} ➡️ ${r.destination || 'N/D'} (${r.departure_date || 'Sem data'})</li>`;
        });
        html += `</ul><br><a href="/logout">Terminar Sessão</a>`;
        
        res.send(html);
    });
});

app.post('/admin/create-user', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    db.run(`INSERT INTO users (username, password, role) VALUES (?, ?, 'client')`, [username, hashedPassword], (err) => {
        if (err) {
            return res.send('Erro ao criar utilizador. <a href="/admin">Voltar</a>');
        }
        res.redirect('/admin');
    });
});

// --- APIS PARA O PYTHON (GITHUB ACTIONS) ---

// API para buscar um cliente específico
app.get('/api/flight-config/:username', (req, res) => {
    const { username } = req.params;
    db.get(`SELECT flight_configs.* FROM flight_configs 
            JOIN users ON users.id = flight_configs.user_id 
            WHERE users.username = ?`, [username], (err, config) => {
        if (err || !config) {
            return res.status(404).json({ error: "Configuração não encontrada" });
        }
        res.json(config);
    });
});

// API para buscar TODOS os clientes de uma vez só
app.get('/api/flight-configs-all', (req, res) => {
    db.all(`SELECT users.username, flight_configs.* FROM flight_configs 
            JOIN users ON users.id = flight_configs.user_id`, (err, rows) => {
        if (err || !rows) {
            return res.status(404).json({ error: "Nenhuma configuração encontrada" });
        }
        res.json(rows);
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
