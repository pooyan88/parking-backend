async function transaction(pool, work) {
    const client = await pool.connect();
    let started = false;
    let broken;
    try {
        await client.query('BEGIN');
        started = true;
        const result = await work(client);
        await client.query('COMMIT');
        started = false;
        return result;
    } catch (error) {
        if (started) {
            try { await client.query('ROLLBACK'); }
            catch (rollbackError) { broken = rollbackError; error.rollbackFailed = true; }
        }
        throw error;
    } finally {
        client.release(broken);
    }
}

module.exports = { transaction };
