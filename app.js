const express = require('express');
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(require('./Router/parkingRouter'));
app.use(require('./Router/authRouter'));
app.use(require('./Router/profileRouter'));
app.use(require('./Router/parkingFloorRouter'));
app.use(require('./Router/parkingSlotRouter'));
app.use(require('./Router/customerRouter'));
app.use(require('./Router/rentalRouter'));
app.use(require('./Router/reportRouter'));
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const clientStatus = error.type === 'entity.too.large' ? 413
        : error.type === 'encoding.unsupported' || error.type === 'charset.unsupported' ? 415
        : error instanceof URIError || error.type === 'entity.parse.failed' ? 400 : 500;
    if (clientStatus === 500) console.error('Unhandled request error:', error.code || error.name);
    return res.status(clientStatus).json({ message: clientStatus === 413 ? 'Request body is too large'
        : clientStatus === 415 ? 'Unsupported request encoding' : clientStatus === 400 ? 'Invalid JSON body or URL' : 'Internal server error' });
});
module.exports = app;
