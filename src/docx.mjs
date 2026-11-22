import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { RenderError } from './errors.mjs';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const XML = 'http://www.w3.org/XML/1998/namespace';
const partPattern = /^word\/(?:document|header\d+|footer\d+)\.xml$/;
const serializer = new XMLSerializer();
const invalid = () =>
    new RenderError(
        'invalid_docx',
        'Use a valid DOCX without active or externally linked content.',
    );

function parseXml(bytes) {
    const xml = strFromU8(bytes);
    if (/<!DOCTYPE|<!ENTITY|\b(?:DDEAUTO|INCLUDETEXT|INCLUDEPICTURE)\b/i.test(xml)) throw invalid();
    return new DOMParser({
        onError: () => {
            throw invalid();
        },
    }).parseFromString(xml, 'application/xml');
}

function rasterImage(name, bytes) {
    const prefix = Array.from(bytes.subarray(0, 8), (byte) =>
        byte.toString(16).padStart(2, '0'),
    ).join('');
    if (/\.png$/i.test(name)) return prefix === '89504e470d0a1a0a';
    if (/\.jpe?g$/i.test(name)) return prefix.startsWith('ffd8ff');
    if (/\.gif$/i.test(name)) return /^(?:474946383761|474946383961)/.test(prefix);
    if (/\.tiff?$/i.test(name)) return /^(?:49492a00|4d4d002a)/.test(prefix);
    if (/\.bmp$/i.test(name)) return prefix.startsWith('424d');
    return false;
}

function archive(bytes) {
    if (
        !(bytes instanceof Uint8Array) ||
        bytes.length > 10 * 1024 * 1024 ||
        bytes[0] !== 80 ||
        bytes[1] !== 75
    )
        throw invalid();
    let total = 0;
    let count = 0;
    const names = new Set();
    let files;
    try {
        files = unzipSync(bytes, {
            filter: (file) => {
                total += file.originalSize;
                count++;
                if (names.has(file.name)) throw invalid();
                names.add(file.name);
                if (
                    total > 32 * 1024 * 1024 ||
                    count > 1000 ||
                    file.name.includes('..') ||
                    file.name.startsWith('/') ||
                    file.name.includes('\\') ||
                    /(?:vbaProject|embeddings\/|activeX\/|\.bin$)/i.test(file.name)
                )
                    throw invalid();
                if (
                    file.name.startsWith('word/media/') &&
                    !/\.(?:png|jpe?g|gif|tiff?|bmp)$/i.test(file.name)
                )
                    throw invalid();
                return true;
            },
        });
    } catch {
        throw invalid();
    }
    if (!files['word/document.xml'] || !files['[Content_Types].xml']) throw invalid();
    for (const [name, value] of Object.entries(files)) {
        if (name.startsWith('word/media/') && !rasterImage(name, value)) throw invalid();
        if (name.endsWith('.xml') || name.endsWith('.rels')) {
            const doc = parseXml(value);
            if (name.endsWith('.rels')) {
                for (const relationship of Array.from(
                    doc.getElementsByTagNameNS('*', 'Relationship'),
                )) {
                    if (relationship.getAttribute('TargetMode') !== 'External') continue;
                    if (
                        !relationship.getAttribute('Type').endsWith('/hyperlink') ||
                        !/^(?:https?:|mailto:)/i.test(relationship.getAttribute('Target'))
                    )
                        throw invalid();
                }
            }
            if (/macroEnabled|oleObject|altChunk/i.test(strFromU8(value))) throw invalid();
        }
    }
    return files;
}

function texts(paragraph) {
    return Array.from(paragraph.getElementsByTagNameNS(W, 't')).filter((node) => {
        for (let parent = node.parentNode; parent; parent = parent.parentNode) {
            if (parent.namespaceURI === W && parent.localName === 'p') return parent === paragraph;
        }
        return false;
    });
}

function editable(paragraph, nodes) {
    return (
        nodes.length > 0 &&
        !['drawing', 'pict', 'fldChar', 'instrText', 'tab', 'br', 'hyperlink'].some(
            (name) => paragraph.getElementsByTagNameNS(W, name).length > 0,
        )
    );
}

function inspectFiles(files) {
    const paragraphs = [];
    for (const [part, bytes] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
        if (!partPattern.test(part)) continue;
        const document = parseXml(bytes);
        Array.from(document.getElementsByTagNameNS(W, 'p')).forEach((paragraph, index) => {
            const nodes = texts(paragraph);
            const text = nodes.map((node) => node.textContent).join('');
            if (text.trim() !== '')
                paragraphs.push({ part, index, text, editable: editable(paragraph, nodes) });
        });
    }
    if (paragraphs.length > 800)
        throw new RenderError('document_too_large', 'This template contains too many paragraphs.');
    return paragraphs;
}

export function inspectDocx(bytes) {
    return {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        paragraphs: inspectFiles(archive(bytes)),
    };
}

export function editDocx(bytes, edits = []) {
    if (!Array.isArray(edits) || edits.length > 100)
        throw new RenderError('invalid_edits', 'Supply at most 100 paragraph edits.');
    const files = archive(bytes);
    const changed = new Map();
    const modified = new Set();
    const seen = new Set();
    for (const edit of edits) {
        if (
            !edit ||
            typeof edit.part !== 'string' ||
            !partPattern.test(edit.part) ||
            !Number.isInteger(edit.index) ||
            edit.index < 0 ||
            typeof edit.original !== 'string' ||
            typeof edit.text !== 'string' ||
            edit.text.length > 12000 ||
            /[\r\n\x00]/.test(edit.text)
        )
            throw new RenderError(
                'invalid_edits',
                'Edits must identify an existing paragraph and contain plain paragraph text.',
            );
        const key = `${edit.part}:${edit.index}`;
        if (seen.has(key))
            throw new RenderError('invalid_edits', 'A paragraph can only be edited once.');
        seen.add(key);
        if (!files[edit.part])
            throw new RenderError(
                'stale_template',
                'The selected template paragraph no longer exists.',
                409,
            );
        if (!changed.has(edit.part)) changed.set(edit.part, parseXml(files[edit.part]));
        const document = changed.get(edit.part);
        const paragraph = document.getElementsByTagNameNS(W, 'p').item(edit.index);
        if (!paragraph)
            throw new RenderError(
                'stale_template',
                'The selected template paragraph no longer exists.',
                409,
            );
        const nodes = texts(paragraph);
        if (nodes.map((node) => node.textContent).join('') !== edit.original)
            throw new RenderError(
                'stale_template',
                'The source text changed. Inspect the template again.',
                409,
            );
        if (edit.text === edit.original) continue;
        if (!editable(paragraph, nodes))
            throw new RenderError(
                'complex_paragraph',
                'Edit this paragraph in Word; it contains a field, drawing, link or explicit line break.',
            );
        // Keep paragraphs, runs, styles, tables, section breaks, headers and assets in place.
        // Replacement text inherits the first source text run's character formatting.
        nodes[0].textContent = edit.text;
        nodes[0].setAttributeNS(XML, 'xml:space', 'preserve');
        for (const node of nodes.slice(1)) node.textContent = '';
        modified.add(edit.part);
    }
    if (modified.size === 0) return Buffer.from(bytes);
    for (const [name, document] of changed)
        if (modified.has(name)) files[name] = strToU8(serializer.serializeToString(document));
    return Buffer.from(zipSync(files, { level: 6 }));
}

export function textOfDocx(bytes) {
    return inspectDocx(bytes)
        .paragraphs.map((paragraph) => paragraph.text)
        .join('\n');
}
