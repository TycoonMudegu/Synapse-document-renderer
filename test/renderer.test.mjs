import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { unzipSync, strToU8, strFromU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { inspectDocx, editDocx, textOfDocx } from '../src/docx.mjs';
import { createRendererServer } from '../src/server.mjs';
import { renderHtml, renderDocx, closeBrowser } from '../src/render.mjs';
import { fixture } from './fixtures.mjs';

const source = fixture();
const edit = {
    part: 'word/document.xml',
    index: 1,
    original: 'Original summary.',
    text: 'Revised summary.',
};
after(closeBrowser);

test('inspection resolves split text runs and identifies complex paragraphs without changing bytes', () => {
    const result = inspectDocx(source);
    assert.equal(result.sha256, createHash('sha256').update(source).digest('hex'));
    assert.equal(
        result.paragraphs.find((p) => p.part === edit.part && p.index === 1).text,
        edit.original,
    );
    assert.equal(
        result.paragraphs.find((p) => p.part === edit.part && p.index === 3).editable,
        false,
    );
    assert(result.paragraphs.some((p) => p.part === 'word/header1.xml'));
    assert.deepEqual(editDocx(source, []), source);
    assert.deepEqual(editDocx(source, [{ ...edit, text: edit.original }]), source);
});

test('paragraph edits keep styles, tables, margins, headers and embedded assets intact', () => {
    const before = unzipSync(source);
    const output = editDocx(source, [edit]);
    const after = unzipSync(output);
    for (const name of Object.keys(before))
        if (name !== edit.part) assert.deepEqual(after[name], before[name], name);
    assert.equal(textOfDocx(output).includes('Revised summary.'), true);
    const xml = strFromU8(after[edit.part]);
    assert(xml.includes('<w:tbl>'));
    assert(xml.includes('w:pgMar'));
    assert(xml.includes('w:ascii="Calibri"'));
    assert(xml.includes('w:color w:val="164A74"'));
    assert(xml.includes('Experience remains unchanged.'));
});

test('stale, duplicate, invented, multiline and complex edits are rejected', () => {
    for (const edits of [
        [{ ...edit, original: 'Wrong source' }],
        [edit, edit],
        [{ ...edit, index: 999 }],
        [{ ...edit, part: '../private.xml' }],
        [{ ...edit, text: 'New\nparagraph' }],
        [{ ...edit, index: 3, original: 'Explicitline break' }],
    ]) {
        assert.throws(() => editDocx(source, edits));
    }
});

test('unsafe archive paths, active content and excessive expansion are rejected', () => {
    for (const extra of [
        { '../escape.xml': strToU8('<x/>') },
        { 'word/vbaProject.bin': new Uint8Array([1]) },
        {
            'word/document.xml': strToU8(
                '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]><x/>',
            ),
        },
        { 'word/large.xml': new Uint8Array(33 * 1024 * 1024) },
        { 'word/media/linked.svg': strToU8('<svg/>') },
        { 'word/media/renamed.png': strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>') },
    ])
        assert.throws(() => inspectDocx(fixture(extra)));
});

test('external media relationships are rejected even with an XML namespace prefix', () => {
    assert.throws(() =>
        inspectDocx(
            fixture({
                'word/_rels/header1.xml.rels': strToU8(
                    '<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships"><r:Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" TargetMode="External" Target="http://169.254.169.254/latest/meta-data"/></r:Relationships>',
                ),
            }),
        ),
    );
});

test('the HTTP API authenticates before inspection and returns no-cache binary documents', async () => {
    const token = 'test-only-renderer-token-1234567890';
    const server = createRendererServer({
        token,
        docxRenderer: async () => ({ bytes: Buffer.from('%PDF-fixture'), pages: 1 }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        assert.equal((await fetch(`${base}/healthz`)).status, 200);
        const unauthorized = await fetch(`${base}/v1/inspect-docx`, { method: 'POST' });
        assert.equal(unauthorized.status, 401);
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const inspection = await fetch(`${base}/v1/inspect-docx`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ document: source.toString('base64') }),
        });
        assert.equal(inspection.status, 200);
        assert.equal(
            (await inspection.json()).sha256,
            createHash('sha256').update(source).digest('hex'),
        );
        const pdf = await fetch(`${base}/v1/render-docx`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ document: source.toString('base64'), edits: [edit] }),
        });
        assert.equal(pdf.headers.get('content-type'), 'application/pdf');
        assert.equal(pdf.headers.get('cache-control'), 'no-store');
        assert.equal(pdf.headers.get('x-document-pages'), '1');
        assert.equal(await pdf.text(), '%PDF-fixture');
        assert.equal(
            (await fetch(`${base}/v1/inspect-docx`, { method: 'POST', headers, body: '{' })).status,
            422,
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the renderer refuses concurrent expensive work instead of accumulating requests', async () => {
    let finish;
    const server = createRendererServer({
        token: 'test-only-renderer-token-1234567890',
        docxRenderer: () =>
            new Promise((resolve) => {
                finish = () => resolve({ bytes: Buffer.from('%PDF-fixture'), pages: 1 });
            }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const options = {
        method: 'POST',
        headers: {
            Authorization: 'Bearer test-only-renderer-token-1234567890',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ document: source.toString('base64') }),
    };
    try {
        const first = fetch(`${base}/v1/render-docx`, options);
        while (!finish) await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal((await fetch(`${base}/v1/render-docx`, options)).status, 429);
        finish();
        assert.equal((await first).status, 200);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Chromium prints CSS-sized pages while blocking page scripts and external resources', async () => {
    let requests = 0;
    const sentinel = createServer((req, res) => {
        requests++;
        res.end('unexpected');
    });
    await new Promise((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    try {
        const result = await renderHtml(
            `<html><style>@page{size:A4;margin:20mm}.page{break-after:page}</style><div class="page">First page</div><p>Second page</p><img src="http://127.0.0.1:${sentinel.address().port}/private"><script>document.body.innerHTML='bad';fetch('http://127.0.0.1:${sentinel.address().port}/script')</script></html>`,
        );
        assert.equal(result.pages, 2);
        assert.equal(requests, 0);
        const pdf = await PDFDocument.load(result.bytes);
        assert(Math.abs(pdf.getPage(0).getWidth() - 595.28) < 1);
        assert(Math.abs(pdf.getPage(0).getHeight() - 841.89) < 1);
    } finally {
        await new Promise((resolve) => sentinel.close(resolve));
    }
});

test(
    'LibreOffice renders preserved DOCX and rejects edits adding pages',
    { skip: process.env.RUN_CONVERSION_TESTS !== '1' },
    async () => {
        const baseline = await renderDocx(source, [], 'pdf');
        const edited = await renderDocx(source, [edit], 'pdf');
        assert.equal(baseline.pages, 1);
        assert.equal(edited.pages, 1);
        const docx = await renderDocx(source, [edit], 'docx');
        assert(textOfDocx(docx.bytes).includes(edit.text));
        await assert.rejects(
            () => renderDocx(source, [{ ...edit, text: 'Much longer text. '.repeat(500) }], 'pdf'),
            (error) => error.code === 'layout_overflow',
        );
    },
);
