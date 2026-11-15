class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

function sendError(res, error) {
    if (error instanceof HttpError && !error.rollbackFailed) {
        return res.status(error.status).json({ message: error.message });
    }
    console.error('Request failed:', error.code || error.name);
    return res.status(500).json({ message: 'Internal server error' });
}

module.exports = { HttpError, sendError };
