const { IncomingMessage, ServerResponse } = require('node:http');
const { Duplex } = require('node:stream');

// Exercise Express and its JSON parser without opening a network socket.
function inject(app, { method = 'GET', url = '/', headers = {}, body, rawBody } = {}) {
    return new Promise((resolve, reject) => {
        const output = [];
        const socket = new Duplex({ read() {}, write(chunk, encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
        const request = new IncomingMessage(socket);
        request.method = method; request.url = url; request.httpVersion = '1.1';
        request.httpVersionMajor = 1; request.httpVersionMinor = 1;
        const payload = rawBody ?? (body === undefined ? '' : JSON.stringify(body));
        request.headers = { host: 'localhost', ...headers };
        if (payload) {
            request.headers['content-type'] ??= 'application/json';
            request.headers['content-length'] = String(Buffer.byteLength(payload));
        }
        const response = new ServerResponse(request);
        response.assignSocket(socket);
        const timeout = setTimeout(() => { socket.destroy(); reject(new Error('In-memory HTTP request timed out')); }, 3000);
        response.on('error', reject);
        request.on('error', () => {});
        response.on('finish', () => {
            clearTimeout(timeout);
            const raw = Buffer.concat(output).toString();
            const contents = raw.slice(raw.indexOf('\r\n\r\n') + 4);
            let parsed = contents;
            if (contents && String(response.getHeader('content-type')).includes('application/json')) {
                try { parsed = JSON.parse(contents); } catch (error) { socket.destroy(); reject(error); return; }
            }
            socket.destroy();
            resolve({ status: response.statusCode, headers: response.getHeaders(), body: parsed });
        });
        app(request, response);
        if (payload) request.push(Buffer.from(payload));
        request.complete = true;
        request.push(null);
    });
}
module.exports = { inject };
