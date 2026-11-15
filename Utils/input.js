const { HttpError } = require('./httpErrors');
const { parseParkingId } = require('./parkingValidation');

function id(value, name = 'ID') {
    if (typeof value !== 'string' && typeof value !== 'number') throw new HttpError(400, `Invalid ${name}`);
    const result = parseParkingId(String(value ?? ''));
    if (result === null) throw new HttpError(400, `Invalid ${name}`);
    return result;
}
function object(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) {
        throw new HttpError(400, `Provide a JSON object using only: ${allowed.join(', ')}`);
    }
    return body;
}
function text(value, name, max = 255) {
    if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || value.includes('\0')) {
        throw new HttpError(400, `${name} must be non-empty text up to ${max} characters`);
    }
    return value.trim();
}
function page(query = {}) {
    for (const field of ['limit', 'offset']) {
        if (query[field] !== undefined && (typeof query[field] !== 'string' || !/^\d+$/.test(query[field]))) {
            throw new HttpError(400, `${field} must be a whole-number query parameter`);
        }
    }
    const limit = query.limit === undefined ? 100 : Number(query.limit);
    const offset = query.offset === undefined ? 0 : Number(query.offset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) {
        throw new HttpError(400, 'limit must be 1–200 and offset must be a non-negative integer');
    }
    return [limit, offset];
}
module.exports = { id, object, text, page };
