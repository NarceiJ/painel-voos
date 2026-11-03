// Rota para listar as rotas do utilizador logado
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

// Rota para adicionar uma nova rota
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

// Rota para apagar uma rota específica
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
