const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 10000;

// Configuração da ligação ao PostgreSQL (Supabase)
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Testar ligação à base de dados e criar tabelas se não existirem
async function iniciarBaseDados() {
    try {
        await pool.query('SELECT NOW()');
        console.log('Conectado à base de dados PostgreSQL com sucesso.');

        // Criar tabela de utilizadores (caso não exista)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Criar tabela de rotas (suporte a múltiplas rotas por utilizador)
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

        // Criar utilizador admin padrão se não existir
        const userCheck = await pool.query('SELECT * FROM users WHERE username = $1', ['admin']);
        if (userCheck.rows.length === 0) {
            await pool.query('INSERT INTO users (username, password) VALUES ($1, $2)', ['admin', 'admin123']);
            console.log('Utilizador admin criado (user: admin / pass: admin123)');
        }
    } catch (err) {
        console.error('Erro ao conectar à base de dados PostgreSQL', err);
    }
}

iniciarBaseDados();

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'painel-voos-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Defina como true se usar HTTPS estrito com proxy
}));

// Servir ficheiros estáticos da pasta public (onde fica o index.html)
app.use(express.static(path.join(__dirname, 'public')));

// --- API DE AUTENTICAÇÃO ---

// Login simples
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
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

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ message: 'Sessão terminada' });
    });
});

// Verificar sessão ativa
app.get('/api/session', (req, res) => {
    if (req.session.userId) {
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        res.status(401).json({ loggedIn: false });
    }
});


// --- API DE GESTÃO DE MÚLTIPLAS ROTAS ---

// Listar todas as rotas do utilizador logado
app.get('/api/rotas', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Não autorizado' });
    }

    try {
        const result = await pool.query(
            'SELECT * FROM rotas WHERE user_id = $1 ORDER BY id DESC',
            [req.session.userId]
        );
        res.json(result.rows);
    } catch (err) {
        console.error('Erro ao buscar rotas:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// Adicionar uma nova rota para o utilizador logado
app.post('/api/rotas', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Não autorizado' });
    }

    const { origem, destino, data_voo } = req.body;

    if (!origem || !destino) {
        return res.status(400).json({ error: 'Origem e destino são obrigatórios' });
    }

    try {
        const result = await pool.query(
            'INSERT INTO rotas (user_id, origem, destino, data_voo) VALUES ($1, $2, $3, $4) RETURNING *',
            [req.session.userId, origem.toUpperCase(), destino.toUpperCase(), data_voo || null]
        );
        res.status(201).json({ message: 'Rota adicionada com sucesso!', rota: result.rows[0] });
    } catch (err) {
        console.error('Erro ao inserir rota:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// Apagar uma rota específica do utilizador logado
app.delete('/api/rotas/:id', async (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Não autorizado' });
    }

    const rotaId = req.params.id;

    try {
        const result = await pool.query(
            'DELETE FROM rotas WHERE id = $1 AND user_id = $2 RETURNING *',
            [rotaId, req.session.userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Rota não encontrada ou sem permissão' });
        }

        res.json({ message: 'Rota removida com sucesso!' });
    } catch (err) {
        console.error('Erro ao apagar rota:', err);
        res.status(500).json({ error: 'Erro interno no servidor' });
    }
});

// Iniciar servidor
app.listen(port, () => {
    console.log(`Servidor rodando na porta ${port}`);
});
