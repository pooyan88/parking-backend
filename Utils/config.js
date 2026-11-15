function validateEnvironment(env = process.env) {
    const missing = ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','JWT_ACCESS_SECRET']
        .filter(name => typeof env[name] !== 'string' || !env[name]);
    if (missing.length) throw new Error(`Missing environment settings: ${missing.join(', ')}`);
    if (Buffer.byteLength(env.JWT_ACCESS_SECRET, 'utf8') < 32) throw new Error('JWT_ACCESS_SECRET must contain at least 32 bytes');
    const port = env.PORT === undefined ? 3002 : Number(env.PORT);
    if ((env.PORT !== undefined && !/^\d+$/.test(env.PORT)) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
    if (!/^\d+$/.test(env.DB_PORT) || Number(env.DB_PORT) < 1 || Number(env.DB_PORT) > 65535) throw new Error('Invalid DB_PORT');
    return { port };
}
module.exports = { validateEnvironment };
