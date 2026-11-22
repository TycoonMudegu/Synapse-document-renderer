import { chromium } from 'playwright';
import { PDFDocument } from 'pdf-lib';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { editDocx } from './docx.mjs';
import { RenderError } from './errors.mjs';

export async function pdfPages(bytes) {
    try {
        return (await PDFDocument.load(bytes)).getPageCount();
    } catch {
        throw new RenderError('invalid_pdf', 'The converter did not return a valid PDF.', 502);
    }
}

async function convert(directory, source, timeout = 25000) {
    const output = join(directory, source);
    await mkdir(output);
    await new Promise((resolve, reject) => {
        const child = spawn(
            process.env.LIBREOFFICE_BINARY || 'libreoffice',
            [
                `-env:UserInstallation=${pathToFileURL(join(directory, `profile-${source}`)).href}`,
                '--headless',
                '--norestore',
                '--nodefault',
                '--nofirststartwizard',
                '--nolockcheck',
                '--convert-to',
                'pdf:writer_pdf_Export',
                '--outdir',
                output,
                join(directory, `${source}.docx`),
            ],
            { stdio: 'ignore', detached: process.platform !== 'win32' },
        );
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            try {
                process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
            } catch {}
        }, timeout);
        child.once('error', () => {
            clearTimeout(timer);
            reject(
                new RenderError(
                    'converter_unavailable',
                    'The document converter is unavailable.',
                    503,
                ),
            );
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            if (code !== 0 || timedOut)
                reject(
                    new RenderError(
                        'conversion_failed',
                        'Document conversion failed or timed out. Try a simpler DOCX.',
                        502,
                    ),
                );
            else resolve();
        });
    });
    try {
        const pdf = await readFile(join(output, `${source}.pdf`));
        if (pdf.length > 20 * 1024 * 1024) throw new Error('oversize');
        return pdf;
    } catch {
        throw new RenderError(
            'conversion_failed',
            'The converter did not produce a supported PDF.',
            502,
        );
    }
}

export async function renderDocx(bytes, edits = [], format = 'pdf') {
    if (!['pdf', 'docx'].includes(format))
        throw new RenderError('invalid_format', 'Choose PDF or DOCX.');
    const edited = editDocx(bytes, edits);
    const directory = await mkdtemp(join(tmpdir(), 'synapse-document-'));
    try {
        await writeFile(join(directory, 'source.docx'), bytes, { mode: 0o600 });
        const baseline = await convert(directory, 'source');
        const sourcePages = await pdfPages(baseline);
        let output = baseline;
        if (edits.length) {
            await writeFile(join(directory, 'edited.docx'), edited, { mode: 0o600 });
            output = await convert(directory, 'edited');
        }
        const pages = await pdfPages(output);
        if (pages > sourcePages)
            throw new RenderError(
                'layout_overflow',
                'The revised text adds pages. Shorten it or edit the source template before generating again.',
                409,
            );
        if (pages > 10)
            throw new RenderError(
                'document_too_large',
                'Application documents must be ten pages or fewer.',
            );
        return { bytes: format === 'docx' ? edited : output, pages, sourcePages };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

let browserPromise;
async function browser() {
    if (!browserPromise)
        browserPromise = chromium
            .launch({
                executablePath: process.env.CHROMIUM_PATH || undefined,
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage'],
            })
            .catch((error) => {
                browserPromise = undefined;
                throw error;
            });
    return browserPromise;
}

export async function renderHtml(html) {
    if (typeof html !== 'string' || Buffer.byteLength(html) > 2 * 1024 * 1024)
        throw new RenderError('invalid_html', 'Supply an HTML document under 2 MiB.');
    const context = await (
        await browser()
    ).newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true });
    try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        const policy =
            "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
        await page.setContent(
            `<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}">${html}`,
            { waitUntil: 'load', timeout: 15000 },
        );
        await page.emulateMedia({ media: 'print' });
        await page.evaluate(() => document.fonts.ready);
        const bytes = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            tagged: true,
            timeout: 15000,
        });
        if (bytes.length > 20 * 1024 * 1024)
            throw new RenderError('document_too_large', 'The rendered document is too large.');
        const pages = await pdfPages(bytes);
        if (pages > 10)
            throw new RenderError(
                'document_too_large',
                'Application documents must be ten pages or fewer.',
            );
        return { bytes, pages };
    } finally {
        await context.close();
    }
}

export async function closeBrowser() {
    if (browserPromise) {
        const instance = await browserPromise;
        browserPromise = undefined;
        await instance.close();
    }
}
