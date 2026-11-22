import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inspectDocx } from './docx.mjs';
import { renderDocx, renderHtml, closeBrowser } from './render.mjs';
import { RenderError } from './errors.mjs';

const MAX_BODY = 16 * 1024 * 1024;
function decode(value) {
    if (
        typeof value !== 'string' ||
        value.length > 14 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
        value.length % 4 !== 0
    )
        throw new RenderError('invalid_docx', 'Supply a base64 DOCX document.');
    return Buffer.from(value, 'base64');
}

async function body(request) {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json')
        throw new RenderError('invalid_content_type', 'Use application/json.', 415);
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_BODY)
            throw new RenderError('body_too_large', 'The document request is too large.', 413);
        chunks.push(chunk);
    }
    try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
        return value;
    } catch {
        throw new RenderError('invalid_json', 'Supply a JSON object.');
    }
}

export function createRendererServer({
    token = process.env.DOCUMENT_RENDERER_TOKEN,
    docxRenderer = renderDocx,
    htmlRenderer = renderHtml,
} = {}) {
    if (!token || token.length < 32 || /[\s\x00-\x1f]/.test(token))
        throw new Error(
            'DOCUMENT_RENDERER_TOKEN must contain at least 32 non-whitespace characters.',
        );
    const expected = createHash('sha256').update(`Bearer ${token}`).digest();
    let busy = false;
    const server = createServer(async (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        if (request.url === '/healthz' && request.method === 'GET') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end('{"status":"ok"}');
            return;
        }
        const supplied = createHash('sha256')
            .update(request.headers.authorization || '')
            .digest();
        if (!timingSafeEqual(expected, supplied)) {
            response.writeHead(401, { 'Content-Type': 'application/json' });
            response.end('{"error":"unauthorized"}');
            return;
        }
        if (
            request.method !== 'POST' ||
            !['/v1/inspect-docx', '/v1/render-docx', '/v1/render-html'].includes(request.url)
        ) {
            response.writeHead(404);
            response.end();
            return;
        }
        if (busy) {
            response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '5' });
            response.end('{"error":"busy"}');
            return;
        }
        busy = true;
        try {
            const input = await body(request);
            if (request.url === '/v1/inspect-docx') {
                const result = inspectDocx(decode(input.document));
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(result));
            } else {
                const format = input.format ?? 'pdf';
                const result =
                    request.url === '/v1/render-docx'
                        ? await docxRenderer(decode(input.document), input.edits ?? [], format)
                        : await htmlRenderer(input.html);
                response.writeHead(200, {
                    'Content-Type':
                        request.url === '/v1/render-docx' && format === 'docx'
                            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                            : 'application/pdf',
                    'Content-Disposition': 'attachment',
                    'Content-Length': result.bytes.length,
                    'X-Document-Pages': String(result.pages),
                });
                response.end(result.bytes);
            }
        } catch (error) {
            const known = error instanceof RenderError;
            response.writeHead(known ? error.status : 500, { 'Content-Type': 'application/json' });
            response.end(
                JSON.stringify({
                    error: known ? error.code : 'render_failed',
                    message: known
                        ? error.message
                        : 'Document rendering failed. Check the renderer installation.',
                }),
            );
        } finally {
            busy = false;
        }
    });
    server.requestTimeout = 70000;
    server.headersTimeout = 10000;
    return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const server = createRendererServer();
    server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
    process.on('SIGTERM', () =>
        server.close(async () => {
            await closeBrowser();
            process.exit(0);
        }),
    );
}
