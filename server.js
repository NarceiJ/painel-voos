const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function iniciarBaseDados() {
    try {
        await pool.query('SELECT NOW()');
        console.log('Conectado à base de dados PostgreSQL com sucesso.');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            )
        `);

        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS limite_rotas INT DEFAULT 2`);
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS rotas (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                origem VARCHAR(10) NOT NULL,
                destino VARCHAR(10) NOT NULL,
                data_voo DATE,
                criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', ['admin']);
        if (userCheck.rows.length === 0) {
            await pool.query('INSERT INTO users (username, password, limite_rotas) VALUES ($1, $2, $3)', ['admin', 'admin123', 50]);
            console.log('Utilizador admin criado');
        }
    } catch (err) {
        console.error('Erro ao conectar à base de dados PostgreSQL', err);
    }
}

iniciarBaseDados();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'painel-voos-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- LOGIN ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const cleanUser = username ? username.trim().toLowerCase() : '';
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [cleanUser, password]);
        if (result.rows.length > 0) {
            req.session.userId = result.rows[0].id;
            req.session.username = result.rows[0].username;
            res.json({ message: 'Login efetuado com sucesso!' });
        } else {
            res.status(401).json({ error: 'Credenciais inválidas' });
        }
    } catch (err) {
        console.error('Erro no login:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Sessão terminada' });
    });
});

app.get('/api/session', (req, res) => {
    if (req.session.userId) {
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        res.status(401).json({ loggedIn: false });
    }
});

// --- API PARA O BOT DO PYTHON LER TODAS AS ROTAS ---
app.get('/api/bot/rotas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.username, r.origem, r.destino, r.data_voo 
            FROM rotas r 
            JOIN users u ON r.user_id = u.id 
            ORDER BY r.id DESC
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar rotas para o bot:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// --- ADMIN: CRIAR E LISTAR CLIENTES ---
app.post('/api/admin/criar-cliente', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autorizado' });

    try {
        const adminCheck = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        if (adminCheck.rows.length === 0 || adminCheck.rows[0].username !== 'admin') {
            return res.status(403).json({ error: 'Acesso negado.' });
        }

        const { username, password, limite_rotas } = req.body;
        if (!username || !password || !limite_rotas) {
            return res.status(400).json({ error: 'Preencha todos os campos' });
        }

        const cleanUser = username.trim().toLowerCase();
        const userExist = await pool.query('SELECT * FROM users WHERE username = $1', [cleanUser]);
        if (userExist.rows.length > 0) {
            return res.status(400).json({ error: 'Este nome de utilizador já existe' });
        }

        await pool.query(
            'INSERT INTO users (username, password, limite_rotas) VALUES ($1, $2, $3)',
            [cleanUser, password, parseInt(limite_rotas)]
        );

        res.status(201).json({ message: 'Cliente criado com sucesso!' });
    } catch (err) {
        console.error('Erro ao criar cliente:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

app.get('/api/admin/clientes', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autorizado' });

    try {
        const adminCheck = await pool.query('SELECT username FROM users WHERE id = $1', [req.session.userId]);
        if (adminCheck.rows.length === 0 || adminCheck.rows[0].username !== 'admin') {
            return res.status(403).json({ error: 'Acesso negado.' });
        }

        const result = await pool.query('SELECT id, username, limite_rotas, created_at FROM users WHERE username != $1 ORDER BY id DESC', ['admin']);
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao listar clientes:', err);
        res.status(500).json({ error: 'Erro interno' });
    }
});

// --- GESTÃO DE ROTAS ---
app.get('/api/rotas', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autorizado' });

    try {
        const result = await pool.query('SELECT * FROM rotas WHERE user_id = $1 ORDER BY id DESC', [req.session.userId]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Erro interno' });
    }
});

app.post('/api/rotas', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autorizado' });

    const { origem, destino, data_voo } = req.body;
    if (!origem || !destino) return res.status(400).json({ error: 'Origem e destino obrigatórios' });

    try {
        const userResult = await pool.query('SELECT limite_rotas FROM users WHERE id = $1', [req.session.userId]);
        const limiteRotas = userResult.rows[0].limite_rotas;

        const countResult = await pool.query('SELECT COUNT(*) FROM rotas WHERE user_id = $1', [req.session.userId]);
        const totalRotasAtuais = parseInt(countResult.rows[0].count);

        if (totalRotasAtuais >= limiteRotas) {
            return res.status(403).json({ error: `Limite atingido! Máximo de ${limiteRotas} rotas permitidas.` });
        }

        const result = await pool.query(
            'INSERT INTO rotas (user_id, origem, destino, data_voo) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.session.userId, origem.toUpperCase(), destino.toUpperCase(), data_voo || null]
        );
        res.status(201).json({ message: 'Rota adicionada!', rota: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: 'Erro interno' });
    }
});

app.delete('/api/rotas/:id', async (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Não autorizado' });

    try {
        await pool.query('DELETE FROM rotas WHERE id = $1 AND user_id = $2', [req.params.id, req.session.userId]);
        res.json({ message: 'Removido com sucesso!' });
    } catch (err) {
        res.status(500).json({ error: 'Erro interno' });
    }
});

app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
