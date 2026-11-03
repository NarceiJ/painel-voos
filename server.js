const express = require('express');
const { Pool } = require('pg');
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

// Configuração da Base de Dados PostgreSQL (Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Necessário para conexões externas com o Supabase
    }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('Erro ao conectar à base de dados PostgreSQL', err.stack);
    } else {
        console.log('Conectado à base de dados PostgreSQL com sucesso.');
        release();
        criarTabelas();
    }
});

async function criarTabelas() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT DEFAULT 'client'
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS flight_configs (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                origin TEXT,
                destination TEXT,
                departure_date TEXT,
                max_stops TEXT,
                currency TEXT,
                telegram_chat_id TEXT
            )
        `);

        // Criar utilizador admin padrão se não existir
        const adminCheck = await pool.query(`SELECT * FROM users WHERE username = 'admin'`);
        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await pool.query(
                `INSERT INTO users (username, password, role) VALUES ($1, $2, $3)`,
                ['admin', hashedPassword, 'admin']
            );
            console.log('Utilizador admin criado (user: admin / pass: admin123)');
        }
    } catch (err) {
        console.error('Erro ao criar tabelas:', err);
    }
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

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query(`SELECT * FROM users WHERE username = $1`, [username]);
        const user = result.rows[0];

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
    } catch (err) {
        console.error(err);
        res.send('Erro no servidor. <a href="/login">Voltar</a>');
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    
    const userId = req.session.user.id;
    try {
        const result = await pool.query(`SELECT * FROM flight_configs WHERE user_id = $1`, [userId]);
        const config = result.rows[0];

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
    } catch (err) {
        console.error(err);
        res.send('Erro ao carregar dashboard.');
    }
});

app.post('/update-config', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    const userId = req.session.user.id;
    const { origin, destination, departure_date, max_stops, telegram_chat_id } = req.body;

    try {
        const check = await pool.query(`SELECT * FROM flight_configs WHERE user_id = $1`, [userId]);
        
        if (check.rows.length > 0) {
            await pool.query(
                `UPDATE flight_configs SET origin = $1, destination = $2, departure_date = $3, max_stops = $4, telegram_chat_id = $5 WHERE user_id = $6`,
                [origin, destination, departure_date, max_stops, telegram_chat_id, userId]
            );
        } else {
            await pool.query(
                `INSERT INTO flight_configs (user_id, origin, destination, departure_date, max_stops, currency, telegram_chat_id) VALUES ($1, $2, $3, $4, $5, 'BRL', $6)`,
                [userId, origin, destination, departure_date, max_stops, telegram_chat_id]
            );
        }
        res.redirect('/dashboard');
    } catch (err) {
        console.error(err);
        res.send('Erro ao atualizar configurações.');
    }
});

app.get('/admin', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');

    try {
        const result = await pool.query(`
            SELECT users.id, users.username, flight_configs.origin, flight_configs.destination, flight_configs.departure_date 
            FROM users LEFT JOIN flight_configs ON users.id = flight_configs.user_id WHERE users.role = 'client'
        `);
        
        let html = `<h2>Painel Administrativo</h2>`;
        html += `<h3>Criar Novo Cliente</h3>
                 <form action="/admin/create-user" method="POST">
                    <input type="text" name="username" placeholder="Novo Utilizador" required />
                    <input type="password" name="password" placeholder="Palavra-passe" required />
                    <button type="submit">Criar Utilizador</button>
                 </form><hr>`;
        
        html += `<h3>Clientes e Configurações Atuais</h3><ul>`;
        result.rows.forEach(r => {
            html += `<li><b>${r.username}</b> - Rota: ${r.origin || 'N/D'} ➡️ ${r.destination || 'N/D'} (${r.departure_date || 'Sem data'})</li>`;
        });
        html += `</ul><br><a href="/logout">Terminar Sessão</a>`;
        
        res.send(html);
    } catch (err) {
        console.error(err);
        res.send('Erro ao carregar painel administrativo.');
    }
});

app.post('/admin/create-user', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.redirect('/login');
    const { username, password } = req.body;
    
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(`INSERT INTO users (username, password, role) VALUES ($1, $2, 'client')`, [username, hashedPassword]);
        res.redirect('/admin');
    } catch (err) {
        console.error(err);
        res.send('Erro ao criar utilizador (talvez o nome já exista). <a href="/admin">Voltar</a>');
    }
});

// --- APIS PARA O PYTHON (GITHUB ACTIONS) ---

app.get('/api/flight-config/:username', async (req, res) => {
    const { username } = req.params;
    try {
        const result = await pool.query(`
            SELECT flight_configs.* FROM flight_configs 
            JOIN users ON users.id = flight_configs.user_id 
            WHERE users.username = $1
        `, [username]);

        const config = result.rows[0];
        if (!config) {
            return res.status(404).json({ error: "Configuração não encontrada" });
        }
        res.json(config);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro interno no servidor" });
    }
});

app.get('/api/flight-configs-all', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT users.username, flight_configs.* FROM flight_configs 
            JOIN users ON users.id = flight_configs.user_id
        `);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Nenhuma configuração encontrada" });
        }
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Erro interno no servidor" });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
