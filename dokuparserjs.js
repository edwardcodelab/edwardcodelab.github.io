/**
 * DokuParserJS: A lightweight JavaScript class for parsing DokuWiki markup into HTML.
 *
 * @param {Object} [options] - Parser options.
 * @param {string} [options.currentNamespace=''] - Current namespace for link resolution.
 * @param {Object} [options.interwikiMap={}] - Map of interwiki prefixes to URLs.
 * @param {boolean} [options.htmlok=true] - Enable HTML embedding.
 * @param {boolean} [options.typography=true] - Enable typography conversions.
 * @param {string} [options.mediaBasePath='/media/'] - Base path for media files (local mode).
 * @param {string} [options.pagesBasePath='/'] - Base path for wiki pages (local mode).
 * @param {boolean} [options.useTxtExtension=false] - Append .txt to internal links (local mode).
 * @param {boolean} [options.useDokuWikiPaths=false] - Use DokuWiki path format (/lib/exe/fetch.php, /doku.php).
 */
class DokuParserJS {
    constructor(options = {}) {
        this.currentNamespace = (options.currentNamespace || '').replace(/^:+|:+$/g, '');
        this.interwikiMap = options.interwikiMap || {
            wp: 'https://en.wikipedia.org/wiki/',
            doku: 'https://www.dokuwiki.org/'
        };
        this.htmlok = options.htmlok !== false;
        this.typography = options.typography !== false;
        this.mediaBasePath = options.mediaBasePath?.trim()
            ? options.mediaBasePath.replace(/\/+$/, '') + '/' : '/data/media/';
        this.pagesBasePath = options.pagesBasePath?.trim()
            ? options.pagesBasePath.replace(/\/+$/, '') + '/' : '/data/pages/';
        this.useTxtExtension = options.useTxtExtension || false;
        this.useDokuWikiPaths = options.useDokuWikiPaths || false;
        this.footnotes = [];
        this.footnoteContent = new Map();
        this.linkPlaceholders = [];
        this.nowikiPlaceholders = [];
        this.listStack = [];
        this.currentIndent = -1;
        this.currentType = null;
        this.currentSectionLevel = 0;
        this.currentSection = '';
        this.smileyMap = {
            '8-)': '😎', '8-O': '😲', ':-(': '😢', ':-)': '🙂', '=-)': '😊',
            ':-/': '😕', ':-\\': '😕', ':-D': '😄', ':-P': '😛', ':-O': '😯',
            ':-X': '😣', ':-|': '😐', ';-)': '😉', '^_^': '😄', ':!:': '❗',
            ':?:': '❓', 'LOL': '😂', 'FIXME': '🔧', 'DELETEME': '🗑️'
        };
        this.rules = [
            {
                pattern: /<nowiki>([\s\S]*?)<\/nowiki>/g,
                replace: (match, content) => {
                    const ph = `[NOWIKI_${this.nowikiPlaceholders.length}]`;
                    this.nowikiPlaceholders.push(content);
                    return ph;
                }
            },
            {
                pattern: /%%([\s\S]*?)%%/g,
                replace: (match, content) => {
                    content = content.trim();
                    if (this.currentSection === 'Text to Image Conversions') {
                        return this.smileyMap[content] || content;
                    } else if (this.currentSection.match(/^(Code Blocks|Downloadable Code Blocks)$/i)) {
                        return this.escapeEntities(content);
                    }
                    return this.escapeEntities(content);
                }
            },
            {
                pattern: /\{\{rss>(.+?)(?:\s+(.+?))?\}\}/g,
                replace: (match, url, params) => {
                    const paramList = params ? params.split(/\s+/) : [];
                    const count = parseInt(paramList.find(p => /^\d+$/.test(p)) || 8);
                    const items = Array.from({length: count}, (_, i) =>
                        `<li><a href="${url}" class="urlextern" rel="nofollow">RSS item ${i + 1}</a> by Author (${new Date().toISOString().split('T')[0]})</li>`
                    );
                    return `<ul class="rss">${items.join('')}</ul>`;
                }
            },
            {
                pattern: /\{\{(\s*)([^|{}]*?)(?:\?([^|]*?))?(?:\|(.+?)?)?(\s*)\}\}/g,
                replace: (match, leadingSpace, src, params, alt, trailingSpace) => {
                    let className = '';
                    if (!leadingSpace && !trailingSpace) className = 'mediacenter';
                    else if (leadingSpace && !trailingSpace) className = 'mediaright';
                    else if (!leadingSpace && trailingSpace) className = 'medialeft';
                    src = src.trim();
                    let width = '', height = '', isLinkOnly = false, isNoLink = false;
                    if (params) {
                        const paramList = params.split('&');
                        paramList.forEach(param => {
                            if (param.match(/^\d+$/)) width = param;
                            else if (param.match(/^\d+x\d+$/)) [width, height] = param.split('x');
                            else if (param === 'linkonly') isLinkOnly = true;
                            else if (param === 'nolink') isNoLink = true;
                        });
                    }
                    let resolvedSrc, filename;
                    if (!src.startsWith('http') && !src.startsWith('rss>')) {
                        const parts = src.split(':');
                        filename = parts.pop();
                        const namespace = parts.join(':').replace(/^:/, '');
                        resolvedSrc = this.resolveNamespace(namespace, '', true);
                        if (this.useDokuWikiPaths) {
                            src = `/lib/exe/fetch.php?media=${resolvedSrc ? encodeURIComponent(resolvedSrc) + ':' : ''}${encodeURIComponent(filename)}`;
                        } else {
                            src = this.mediaBasePath + (resolvedSrc ? resolvedSrc.split(':').map(encodeURIComponent).join('/') + '/' : '') + encodeURIComponent(filename);
                        }
                    } else {
                        filename = src.split('/').pop();
                        src = encodeURIComponent(src);
                    }
                    if (isLinkOnly) {
                        return `<a href="${src}" class="media" rel="nofollow">${alt || decodeURIComponent(filename)}</a>`;
                    }
                    const widthAttr = width ? ` width="${width}"` : '';
                    const heightAttr = height ? ` height="${height}"` : '';
                    const altAttr = alt ? ` alt="${alt}" title="${alt}"` : '';
                    const classAttr = className ? ` class="${className}"` : '';
                    const imgTag = `<img src="${src}"${widthAttr}${heightAttr}${altAttr}${classAttr} loading="lazy">`;
                    return isNoLink ? imgTag : `<a href="${src}" class="media">${imgTag}</a>`;
                }
            },
            {
                pattern: /\[\[(.+?)(?:\|(.+?))?\]\]/g,
                replace: (match, target, text) => {
                    target = target.trim();
                    text = text ? text.trim() : '';
                    if (text && text.match(/\{\{.*\}\}/)) {
                        text = this.applyRules(text);
                        text = text.replace(/<a\s+[^>]*class\s*=\s*"media"[^>]*>([\s\S]*?)<\/a>/g, '$1');
                    }
                    let display = text || target;
                    let href = target;
                    let className = '', attrs = '';
                    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
                    if (target.match(emailRegex)) {
                        href = `mailto:${target}`;
                        className = 'mail';
                        attrs = ` title="${target.replace(/ /g, ' [at] ').replace(/\./g, ' [dot] ')}"`;
                    } else if (target.match(/^https?:\/\//)) {
                        display = text || target.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
                        className = 'urlextern';
                        attrs = ` title="${target}" rel="nofollow"`;
                    } else if (target.includes('>')) {
                        const [wiki, page] = target.split('>');
                        if (this.interwikiMap[wiki]) {
                            href = this.interwikiMap[wiki] + encodeURIComponent(page);
                            display = text || page;
                            className = `interwiki iw_${wiki}`;
                            attrs = ` title="${this.interwikiMap[wiki]}${page}" data-wiki-id="${wiki}:${page}"`;
                        } else {
                            return match;
                        }
                    } else if (target.startsWith('\\')) {
                        className = 'windowsshares';
                        attrs = ` title="${target}"`;
                    } else {
                        let [page, section] = target.split('#');
                        let resolvedPage = this.resolveNamespace(page || 'start', this.currentNamespace);
                        if (section) {
                            href = this.useDokuWikiPaths
                                ? `/doku.php?id=${encodeURIComponent(resolvedPage)}#${section.toLowerCase().replace(/[^a-z0-9]/g, '_')}`
                                : `${this.pagesBasePath}${resolvedPage.split(':').map(encodeURIComponent).join('/')}${this.useTxtExtension ? '.txt' : ''}#${section.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
                            className = 'wikilink2';
                            attrs = ` title="${target}" data-wiki-id="${target}" rel="nofollow"`;
                        } else {
                            href = this.useDokuWikiPaths
                                ? `/doku.php?id=${encodeURIComponent(resolvedPage)}`
                                : `${this.pagesBasePath}${resolvedPage.split(':').map(encodeURIComponent).join('/')}${this.useTxtExtension ? '.txt' : ''}`;
                            className = resolvedPage.endsWith(':start') ? 'wikilink1 curid' : 'wikilink1';
                            attrs = ` data-wiki-id="${target}"`;
                        }
                    }
                    const placeholder = `[LINK_${this.linkPlaceholders.length}]`;
                    this.linkPlaceholders.push(`<a href="${href}" class="${className}"${attrs}>${display}</a>`);
                    return placeholder;
                }
            },
            { pattern: /\*\*(.+?)\*\*/g, replace: '<strong>$1</strong>' },
            { pattern: /\/\/(.+?)\/\//g, replace: '<em>$1</em>' },
            { pattern: /__(.+?)__/g, replace: '<em class="u">$1</em>' },
            { pattern: /''(.+?)''/g, replace: '<code>$1</code>' },
            { pattern: /<sub>(.+?)<\/sub>/g, replace: '<sub>$1</sub>' },
            { pattern: /<sup>(.+?)<\/sup>/g, replace: '<sup>$1</sup>' },
            { pattern: /<del>(.+?)<\/del>/g, replace: '<del>$1</del>' },
            {
                pattern: /<(?:html|HTML)>([\s\S]*?)<\/(?:html|HTML)>/g,
                replace: (match, content) => this.htmlok ? content : `<pre class="code html">${this.escapeEntities(content)}</pre>`
            },
            {
                pattern: /<(?:php|PHP)>([\s\S]*?)<\/(?:php|PHP)>/g,
                replace: (match, content) => `<pre class="code php">${this.escapeEntities(content)}</pre>`
            },
            { pattern: /~~NOTOC~~|~~NOCACHE~~|~~INFO:syntaxplugins~~/g, replace: '' },
            ...(this.typography ? [
                { pattern: /\s->(?=\s)/g, replace: ' &rarr; ' },
                { pattern: /\s<-(?=\s)/g, replace: ' &larr; ' },
                { pattern: /\s<->(?=\s)/g, replace: ' &harr; ' },
                { pattern: /\s=>(?=\s)/g, replace: ' &rArr; ' },
                { pattern: /\s<=(?=\s)/g, replace: ' &lArr; ' },
                { pattern: /\s<=>(?=\s)/g, replace: ' &hArr; ' },
                { pattern: /\s>>(?=\s)/g, replace: ' &raquo; ' },
                { pattern: /\s<<(?=\s)/g, replace: ' &laquo; ' },
                { pattern: /\s---(?=\s)/g, replace: ' &mdash; ' },
                { pattern: /\s--(?=\s)/g, replace: ' &ndash; ' },
                { pattern: /\(c\)/gi, replace: '&copy;' },
                { pattern: /\(tm\)/gi, replace: '&trade;' },
                { pattern: /\(r\)/gi, replace: '&reg;' },
                { pattern: /(\d+)x(\d+)/g, replace: '$1&times;$2' }
            ] : []),
            { pattern: /(^|\s)8-\)(?=\s|$)/g, replace: '$1😎' },
            { pattern: /(^|\s)8-O(?=\s|$)/g, replace: '$1😲' },
            { pattern: /(^|\s):-?\((?=\s|$)/g, replace: '$1😢' },
            { pattern: /(^|\s):-?\)(?=\s|$)/g, replace: '$1🙂' },
            { pattern: /(^|\s)=-?\)(?=\s|$)/g, replace: '$1😊' },
            { pattern: /(^|\s):-?\/(?=\s|$)/g, replace: '$1😕' },
            { pattern: /(^|\s):-?\\(?=\s|$)/g, replace: '$1😕' },
            { pattern: /(^|\s):-?D(?=\s|$)/g, replace: '$1😄' },
            { pattern: /(^|\s):-?P(?=\s|$)/g, replace: '$1😛' },
            { pattern: /(^|\s):-?O(?=\s|$)/g, replace: '$1😯' },
            { pattern: /(^|\s):-?X(?=\s|$)/g, replace: '$1😣' },
            { pattern: /(^|\s):-?\|(?=\s|$)/g, replace: '$1😐' },
            { pattern: /(^|\s);-\)(?=\s|$)/g, replace: '$1😉' },
            { pattern: /(^|\s)\^_\^(?=\s|$)/g, replace: '$1😄' },
            { pattern: /(^|\s):?:!:(?=\s|$)/g, replace: '$1❗' },
            { pattern: /(^|\s):?:\?:(?=\s|$)/g, replace: '$1❓' },
            { pattern: /(^|\s)LOL(?=\s|$)/g, replace: '$1😂' },
            { pattern: /(^|\s)FIXME(?=\s|$)/g, replace: '$1🔧' },
            { pattern: /(^|\s)DELETEME(?=\s|$)/g, replace: '$1🗑️' }
        ];
    }

    resolveNamespace(target, currentNamespace, isMedia = false) {
        target = target.trim();
        const originalTarget = target;
        let isStartPage = originalTarget.endsWith(':');
        if (isStartPage) target = target.slice(0, -1);
        let resolved;

        if (target.startsWith(':')) {
            resolved = target.substring(1);
        } else if (target.startsWith('..')) {
            let tempTarget = target;
            let levels = 0;
            while (tempTarget.startsWith('..')) {
                if (tempTarget.startsWith('..:')) {
                    tempTarget = tempTarget.substring(3);
                    levels++;
                } else {
                    tempTarget = tempTarget.substring(2);
                    levels++;
                }
            }
            let nsParts = currentNamespace ? currentNamespace.split(':') : [];
            while (levels > 0 && nsParts.length > 0) {
                nsParts.pop();
                levels--;
            }
            let parentNs = nsParts.join(':');
            resolved = parentNs ? parentNs + ':' + tempTarget : tempTarget;
        } else if (target.startsWith('.')) {
            let tempTarget = target.substring(target.startsWith('.:') ? 2 : 1);
            resolved = currentNamespace ? currentNamespace + ':' + tempTarget : tempTarget;
        } else {
            resolved = isMedia || target.includes(':') ? target : (currentNamespace ? currentNamespace + ':' + target : target);
        }

        resolved = resolved.replace(/:+/g, ':').replace(/^:/, '').replace(/:$/, '');
        if (!isMedia && !this.useDokuWikiPaths) {
            resolved = resolved.replace(/[^a-z0-9:-_\.]/gi, '').toLowerCase();
        }
        if (!isMedia && isStartPage && !resolved.endsWith(':start')) resolved += ':start';
        return resolved;
    }

    parse(doku) {
        let result = [];
        let lines = doku.split('\n');
        let tableBuffer = [];
        let tableRowspans = [];
        let tableAlignments = [];
        let tableAttributes = {};
        let quoteLevel = 0;
        let paragraphBuffer = [];
        let inCodeBlock = false;
        let codeBlockBuffer = [];
        let inPre = false;
        let preBuffer = [];
        let codeLang = '';
        let inTable = false;
        let inCodeSection = false;
        let codeBlockIndent = -1;
        this.footnotes = [];
        this.footnoteContent = new Map();
        this.linkPlaceholders = [];
        this.nowikiPlaceholders = [];
        this.listStack = [];
        this.currentIndent = -1;
        this.currentType = null;
        this.currentSectionLevel = 0;
        this.currentSection = '';

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i];
            let trimmed = line.trim();
            if (!trimmed) {
                if (inTable) {
                    result.push(this.renderTable(tableBuffer, tableAttributes));
                    tableBuffer = [];
                    tableRowspans = [];
                    tableAlignments = [];
                    tableAttributes = {};
                    inTable = false;
                } else if (inCodeBlock) {
                    codeBlockBuffer.push('');
                    continue;
                } else if (inPre) {
                    preBuffer.push('');
                    continue;
                } else if (quoteLevel > 0 || paragraphBuffer.length > 0 || this.listStack.length > 0) {
                    this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                    quoteLevel = 0;
                }
                continue;
            }

            // Handle <table> tag for attributes
            if (trimmed.match(/^<table\s+([^>]+)>/)) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                const match = trimmed.match(/^<table\s+([^>]+)>/);
                tableAttributes = this.parseTableAttributes(match[1]);
                inTable = true;
                continue;
            } else if (trimmed.match(/^<\/table>/)) {
                if (inTable) {
                    result.push(this.renderTable(tableBuffer, tableAttributes));
                    tableBuffer = [];
                    tableRowspans = [];
                    tableAlignments = [];
                    tableAttributes = {};
                    inTable = false;
                }
                continue;
            }

            if (trimmed.match(/^<code(?:\s+([^\s>]+))?>/)) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                inCodeBlock = true;
                inCodeSection = this.currentSection.match(/^(Links|Tables|Quoting|No Formatting|Embedding HTML and PHP|RSS\/ATOM Feed Aggregation|Control Macros|Syntax Plugins)$/i);
                codeBlockBuffer = [];
                const match = trimmed.match(/^<code(?:\s+([^\s>]+))?>/);
                codeLang = match[1] ? `code ${match[1]}` : 'code';
                const startIdx = line.indexOf('<code');
                const contentAfter = line.substring(startIdx + match[0].length);
                codeBlockBuffer.push(contentAfter);
                if (line.includes('</code>')) {
                    const beforeClose = contentAfter.substring(0, contentAfter.lastIndexOf('</code>'));
                    codeBlockBuffer[0] = beforeClose;
                    const classAttr = codeLang ? ` class="${codeLang}"` : '';
                    result.push(`<pre${classAttr}>${this.escapeEntities(codeBlockBuffer.join('\n'))}</pre>`);
                    inCodeBlock = false;
                    codeBlockBuffer = [];
                    codeLang = '';
                    inCodeSection = false;
                }
                continue;
            } else if (trimmed.match(/^<file(?:\s+([^\s>]+))?>/)) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                inCodeBlock = true;
                inCodeSection = this.currentSection.match(/^(Links|Tables|Quoting|No Formatting|Embedding HTML and PHP|RSS\/ATOM Feed Aggregation|Control Macros|Syntax Plugins)$/i);
                codeBlockBuffer = [];
                const match = trimmed.match(/^<file(?:\s+([^\s>]+))?>/);
                codeLang = match[1] ? `file ${match[1]}` : 'file';
                const startIdx = line.indexOf('<file');
                const contentAfter = line.substring(startIdx + match[0].length);
                codeBlockBuffer.push(contentAfter);
                if (line.includes('</file>')) {
                    const beforeClose = contentAfter.substring(0, contentAfter.lastIndexOf('</file>'));
                    codeBlockBuffer[0] = beforeClose;
                    const classAttr = codeLang ? ` class="${codeLang}"` : '';
                    result.push(`<pre${classAttr}>${this.escapeEntities(codeBlockBuffer.join('\n'))}</pre>`);
                    inCodeBlock = false;
                    codeBlockBuffer = [];
                    codeLang = '';
                    inCodeSection = false;
                }
                continue;
            } else if (inCodeBlock && (trimmed.endsWith('</code>') || trimmed.endsWith('</file>'))) {
                const endTag = trimmed.endsWith('</code>') ? '</code>' : '</file>';
                const beforeClose = line.substring(0, line.lastIndexOf(endTag));
                codeBlockBuffer.push(beforeClose);
                const classAttr = codeLang ? ` class="${codeLang}"` : '';
                result.push(`<pre${classAttr}>${this.escapeEntities(codeBlockBuffer.join('\n'))}</pre>`);
                inCodeBlock = false;
                codeBlockBuffer = [];
                codeLang = '';
                inCodeSection = false;
                continue;
            } else if (inCodeBlock) {
                codeBlockBuffer.push(line);
                continue;
            }

            const leadingSpaces = line.match(/^(\s*)/)[1];
            const indent = leadingSpaces.length;

            if (paragraphBuffer.length > 0 && (indent >= 2 || trimmed.match(/^(?:>|={2,6}.*={2,6}|[\^|]|-{4,})$/))) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
            }

            if (indent >= 2 && !inCodeBlock && !inTable && (line[indent] === '*' || line[indent] === '-') && (line[indent + 1] === ' ' || line.substring(indent + 1).trim() === '')) {
                let content = line.substring(indent + 2).trim();
                content = content.replace(/\\\\\s*$/, '');
                content = content.replace(/\\\\\s+/g, '<br>');
                content = inCodeSection ? this.escapeEntities(content) : this.applyRules(content);
                const listType = line[indent] === '*' ? 'ul' : 'ol';
                const depth = Math.floor(indent / 2);
                while (this.currentIndent > depth && this.listStack.length > 0) {
                    result.push('</li>');
                    result.push(`</${this.listStack.pop().type}>`);
                    this.currentIndent = this.listStack.length > 0 ? this.listStack[this.listStack.length - 1].indent : -1;
                    this.currentType = this.listStack.length > 0 ? this.listStack[this.listStack.length - 1].type : null;
                }
                if (this.currentIndent === -1 || depth > this.currentIndent) {
                    result.push(`<${listType}>`);
                    this.listStack.push({ type: listType, indent: depth });
                    this.currentType = listType;
                    this.currentIndent = depth;
                } else if (depth === this.currentIndent && this.currentType !== listType) {
                    result.push('</li>');
                    result.push(`</${this.listStack.pop().type}>`);
                    result.push(`<${listType}>`);
                    this.listStack.push({ type: listType, indent: depth });
                    this.currentType = listType;
                } else if (depth === this.currentIndent) {
                    result.push('</li>');
                }
                result.push(`<li class="level${depth}"><div class="li">${content || ''}</div>`);
                if (i + 1 < lines.length) {
                    const nextLine = lines[i + 1];
                    const nextTrimmed = nextLine.trim();
                    const nextIndent = nextLine.match(/^(\s*)/)[1].length;
                    const nextDepth = Math.floor(nextIndent / 2);
                    if (!nextTrimmed || nextIndent < 2 || !(nextLine[nextIndent] === '*' || nextLine[nextIndent] === '-') || nextDepth < depth) {
                        result.push('</li>');
                        if (!nextTrimmed || nextIndent < 2 || nextDepth < depth) {
                            while (this.listStack.length > 0 && this.currentIndent > (nextTrimmed ? nextDepth : 0)) {
                                result.push(`</${this.listStack.pop().type}>`);
                                this.currentIndent = this.listStack.length > 0 ? this.listStack[this.listStack.length - 1].indent : -1;
                                this.currentType = this.listStack.length > 0 ? this.listStack[this.listStack.length - 1].type : null;
                            }
                        }
                    }
                } else {
                    result.push('</li>');
                    while (this.listStack.length > 0) {
                        result.push(`</${this.listStack.pop().type}>`);
                        this.currentIndent = -1;
                        this.currentType = null;
                    }
                }
                continue;
            }

            if (!inCodeBlock && !inTable && indent >= 2 && !line.match(/^( {2,})([*|-]\s)/)) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                inPre = true;
                inCodeSection = this.currentSection.match(/^(Links|Tables|Quoting|No Formatting|Embedding HTML and PHP|RSS\/ATOM Feed Aggregation|Control Macros|Syntax Plugins)$/i);
                preBuffer = [line];
                codeBlockIndent = indent;
                continue;
            }
            if (inPre) {
                if (indent >= codeBlockIndent && trimmed && !line.match(/^( {2,})([*|-]\s)/)) {
                    preBuffer.push(line);
                    continue;
                } else {
                    let preContent = preBuffer.join('\n');
                    preContent = this.escapeEntities(preContent);
                    result.push(`<pre class="code">${preContent}</pre>`);
                    inPre = false;
                    preBuffer = [];
                    inCodeSection = false;
                    codeBlockIndent = -1;
                }
            }
            if (i === lines.length - 1 && inPre) {
                let preContent = preBuffer.join('\n');
                preContent = this.escapeEntities(preContent);
                result.push(`<pre class="code">${preContent}</pre>`);
                inPre = false;
                inCodeSection = false;
                codeBlockIndent = -1;
                continue;
            }

            const quoteMatch = line.match(/^(>+)\s*(.*)/);
            if (quoteMatch) {
                const newLevel = quoteMatch[1].length;
                const content = quoteMatch[2];
                let formattedContent = content.trim();
                formattedContent = formattedContent.replace(/\\\\\s*$/, '');
                formattedContent = formattedContent.replace(/\\\\\s+/g, '<br>');
                formattedContent = inCodeSection ? this.escapeEntities(formattedContent) : this.applyRules(formattedContent);
                while (quoteLevel > newLevel) {
                    result.push('</div></blockquote>');
                    quoteLevel--;
                }
                while (quoteLevel < newLevel) {
                    result.push('<blockquote><div class="no">');
                    quoteLevel++;
                }
                if (formattedContent) {
                    result.push(formattedContent);
                }
                if (i === lines.length - 1 && quoteLevel > 0) {
                    while (quoteLevel > 0) {
                        result.push('</div></blockquote>');
                        quoteLevel--;
                    }
                }
                continue;
            } else if (quoteLevel > 0) {
                while (quoteLevel > 0) {
                    result.push('</div></blockquote>');
                    quoteLevel--;
                }
            }

            if (!inCodeSection && (trimmed.match(/^[\^|]/) || inTable)) {
                if (paragraphBuffer.length > 0 || quoteLevel > 0 || this.listStack.length > 0) {
                    this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                }
                if (!inTable) {
                    inTable = true;
                    tableAlignments = [];
                    tableRowspans = [];
                }
                let isHeaderRow = trimmed.match(/^\^/) && trimmed.split('^').length > trimmed.split('|').length; // Majority ^ separators
                const sep = isHeaderRow ? '^' : '|';
                let rawLine = trimmed.substring(1);
                rawLine = rawLine.replace(/\/\/.*$/, '').trim(); // Remove comments
                rawLine = rawLine.endsWith(sep) ? rawLine.slice(0, -1) : rawLine;
                let cells = this.splitTableRow(rawLine, sep).map(c => c.trim());
                let row = { cells: [], isHeader: isHeaderRow, alignments: [], spans: [], isVerticalHeader: false };
                try {
                    // Check for vertical header (row starts with | and first cell starts with ^)
                    if (!isHeaderRow && trimmed.startsWith('|') && cells[0].startsWith('^')) {
                        row.isVerticalHeader = true;
                        rawLine = cells[0].substring(1).trim();
                        cells = this.splitTableRow(rawLine, '^').map(c => c.trim());
                        isHeaderRow = true; // Treat as header for first cell
                    }
                    // Normalize cell count to match max columns
                    const maxCells = Math.max(...tableBuffer.map(r => r.cells.length), cells.length);
                    while (cells.length < maxCells) cells.push('');
                    row.cells = new Array(maxCells);
                    row.alignments = new Array(maxCells).fill('leftalign');
                    row.spans = new Array(maxCells).fill().map(() => ({ rowspan: 1, colspan: 1 }));
                    let colIndex = 0;
                    for (let index = 0; index < cells.length; index++) {
                        let content = cells[index];
                        let align = 'leftalign';
                        if (cells[index].match(/^\s{2,}.*\s{2,}$/)) align = 'centeralign';
                        else if (cells[index].match(/^\s{2,}/)) align = 'rightalign';
                        else if (cells[index].match(/\s{2,}$/)) align = 'leftalign';
                        let colspan = 1;
                        let rowspan = 1;
                        if (content === ':::') {
                            rowspan = 0; // Indicates spanned cell
                            content = '';
                        } else if (content.match(/^:+$/)) {
                            rowspan = (content.match(/:/g) || []).length;
                            content = '';
                        } else if (content === '' && index < cells.length - 1 && cells[index + 1] === '') {
                            colspan = 1;
                            let k = index + 1;
                            while (k < cells.length && cells[k] === '') {
                                colspan++;
                                k++;
                            }
                            if (colIndex > 0) {
                                row.spans[colIndex - 1].colspan += colspan - 1;
                                index += colspan - 1;
                                continue;
                            }
                        }
                        content = inCodeSection ? this.escapeEntities(content) : this.applyRules(content);
                        row.cells[colIndex] = content;
                        row.alignments[colIndex] = align;
                        row.spans[colIndex] = { rowspan, colspan };
                        colIndex += colspan;
                    }
                    // Truncate to actual columns
                    row.cells = row.cells.slice(0, colIndex);
                    row.alignments = row.alignments.slice(0, colIndex);
                    row.spans = row.spans.slice(0, colIndex);
                    if (isHeaderRow || !tableAlignments.length) {
                        tableAlignments = row.alignments;
                    }
                    if (!tableRowspans.length || tableRowspans.length < row.cells.length) {
                        tableRowspans = new Array(row.cells.length).fill(0);
                    }
                    tableBuffer.push(row);
                    // Post-process rowspans for ::: (continuation)
                    for (let j = 0; j < row.cells.length; j++) {
                        if (row.cells[j] === '' && row.spans[j].rowspan === 0) { // ::: marker
                            // Find starting cell upward
                            let r = tableBuffer.length - 2; // Previous row
                            while (r >= 0) {
                                let prevRow = tableBuffer[r];
                                if (prevRow.cells[j] !== '' && prevRow.spans[j].rowspan > 0) {
                                    prevRow.spans[j].rowspan += 1;
                                    break;
                                }
                                r--;
                            }
                        }
                    }
                } catch (e) {
                    console.error(`Error parsing table row at line ${i + 1}: ${e.message}`);
                    if (tableBuffer.length > 0) {
                        result.push(this.renderTable(tableBuffer, tableAttributes));
                        tableBuffer = [];
                        tableRowspans = [];
                        tableAlignments = [];
                        tableAttributes = {};
                        inTable = false;
                    }
                    continue;
                }
                if (i === lines.length - 1 || (lines[i + 1] && !lines[i + 1].trim().match(/^[\^|]/))) {
                    result.push(this.renderTable(tableBuffer, tableAttributes));
                    tableBuffer = [];
                    tableRowspans = [];
                    tableAlignments = [];
                    tableAttributes = {};
                    inTable = false;
                }
                continue;
            }

            if (inTable && !trimmed.match(/^(?:\s*[\^|].*)$/)) {
                result.push(this.renderTable(tableBuffer, tableAttributes));
                tableBuffer = [];
                tableRowspans = [];
                tableAlignments = [];
                tableAttributes = {};
                inTable = false;
            }

            if (trimmed.match(/^={2,6}.*={2,6}$/)) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                const equalsCount = (trimmed.match(/=/g) || []).length / 2;
                let content = trimmed.replace(/^={2,6}/, '').replace(/={2,6}$/, '').trim();
                content = this.applyRules(content);
                const level = Math.max(1, Math.min(6, 6 - Math.floor(equalsCount) + 1));
                const id = content.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
                result.push(`<h${level} id="${id}">${content}</h${level}>`);
                this.currentSectionLevel = level;
                this.currentSection = content;
                inCodeSection = content.match(/^(Links|Tables|Quoting|No Formatting|Embedding HTML and PHP|RSS\/ATOM Feed Aggregation|Control Macros|Syntax Plugins)$/i);
                continue;
            }

            if (trimmed.match(/^-{4,}$/)) {
                this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                result.push('<hr>');
                inCodeSection = false;
                continue;
            }

            if (trimmed.match(/^\{\{.*\}\}$/) && !trimmed.match(/^\{\{rss>/)) {
                let content = this.applyRules(trimmed);
                result.push(`<p>${content}</p>`);
                if (i === lines.length - 1) this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
                continue;
            }

            let content = trimmed;
            content = content.replace(/\\\\\s*$/, '');
            content = content.replace(/\\\\\s+/g, '<br>');
            content = inCodeSection ? this.escapeEntities(content) : this.applyRules(content);
            paragraphBuffer.push(content);
            if (i === lines.length - 1) this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
        }

        this.flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes);
        if (inPre) {
            let preContent = preBuffer.join('\n');
            preContent = this.escapeEntities(preContent);
            result.push(`<pre class="code">${preContent}</pre>`);
        }
        if (this.footnoteContent.size > 0) {
            result.push('<div class="footnotes">');
            Array.from(this.footnoteContent.entries()).forEach(([note, index]) => {
                if (!note.trim()) return;
                const formattedNote = this.applyRules(note);
                result.push(`<div class="fn"><sup><a href="#fnt__${index + 1}" id="fn__${index + 1}" class="fn_bot">${index + 1}</a></sup> <div class="content">${formattedNote}</div></div>`);
            });
            result.push('</div>');
        }

        let finalResult = result.join('\n');
        this.linkPlaceholders.forEach((link, index) => {
            finalResult = finalResult.replace(`[LINK_${index}]`, link);
        });
        this.nowikiPlaceholders.forEach((raw, idx) => {
            finalResult = finalResult.replace(new RegExp(`\\[NOWIKI_${idx}\\]`, 'g'), this.escapeEntities(raw));
        });
        finalResult = `<div class="page group">${finalResult}</div>`;
        return finalResult;
    }

    parseTableAttributes(attrString) {
        const attributes = {};
        const attrRegex = /(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g;
        let match;
        while ((match = attrRegex.exec(attrString))) {
            const [, key, val1, val2, val3] = match;
            attributes[key] = val1 || val2 || val3;
        }
        return attributes;
    }

    splitTableRow(rawLine, sep) {
        const cells = [];
        let current = '';
        let inLink = 0;
        let inImage = 0;
        let escaped = false;

        for (let i = 0; i < rawLine.length; i++) {
            const char = rawLine[i];
            if (char === '\\' && !escaped) {
                escaped = true;
                current += char;
                continue;
            }
            if (char === '[' && rawLine[i + 1] === '[' && !escaped) {
                inLink++;
                current += '[[';
                i++;
                escaped = false;
                continue;
            }
            if (char === ']' && rawLine[i + 1] === ']' && inLink > 0 && !escaped) {
                inLink--;
                current += ']]';
                i++;
                escaped = false;
                continue;
            }
            if (char === '{' && rawLine[i + 1] === '{' && inLink === 0 && !escaped) {
                inImage++;
                current += '{{';
                i++;
                escaped = false;
                continue;
            }
            if (char === '}' && rawLine[i + 1] === '}' && inImage > 0 && !escaped) {
                inImage--;
                current += '}}';
                i++;
                escaped = false;
                continue;
            }
            if (char === sep && inLink === 0 && inImage === 0 && !escaped) {
                cells.push(current);
                current = '';
                escaped = false;
                continue;
            }
            current += char;
            escaped = false;
        }
        if (current !== '') cells.push(current);
        return cells;
    }

    renderTable(tableBuffer, tableAttributes) {
        let rowIndex = 0;
        let tableRowspans = new Array(tableBuffer[0]?.cells.length || 0).fill(0);
        let html = '<table class="inline"';
        for (const [key, value] of Object.entries(tableAttributes)) {
            html += ` ${key}="${this.escapeEntities(value)}"`;
        }
        html += '>';
        // Post-process rowspans for ::: before rendering
        for (let r = 1; r < tableBuffer.length; r++) {
            for (let j = 0; j < tableBuffer[r].cells.length; j++) {
                if (tableBuffer[r].cells[j] === '' && tableBuffer[r].spans[j].rowspan === 0) { // ::: marker
                    let sr = r - 1;
                    while (sr >= 0) {
                        if (tableBuffer[sr].cells[j] !== '' && tableBuffer[sr].spans[j].rowspan >= 1) {
                            tableBuffer[sr].spans[j].rowspan += 1;
                            break;
                        }
                        sr--;
                    }
                }
            }
        }
        for (const row of tableBuffer) {
            html += `<tr class="row${rowIndex}">`;
            let colIndex = 0;
            for (let i = 0; i < row.cells.length; i++) {
                if (tableRowspans[i] > 0) {
                    tableRowspans[i]--;
                    continue;
                }
                let { rowspan, colspan } = row.spans[i];
                if (rowspan === 0) {
                    colIndex++;
                    continue;
                }
                let content = row.cells[i];
                const tag = (row.isHeader || (row.isVerticalHeader && i === 0)) ? 'th' : 'td';
                const alignClass = row.alignments[i] || (i < tableAlignments.length ? tableAlignments[i] : 'leftalign');
                const classAttr = `class="col${colIndex} ${alignClass}"`;
                const rowspanAttr = rowspan > 1 ? ` rowspan="${rowspan}"` : '';
                const colspanAttr = colspan > 1 ? ` colspan="${colspan}"` : '';
                html += `<${tag} ${classAttr}${rowspanAttr}${colspanAttr}>${content}</${tag}>`;
                tableRowspans[i] = rowspan - 1;
                colIndex += colspan;
            }
            html += '</tr>';
            rowIndex++;
        }
        html += '</table>';
        return html;
    }

    applyRules(content) {
        let result = content;
        this.nowikiPlaceholders = [];
        this.rules.forEach(rule => {
            result = result.replace(rule.pattern, typeof rule.replace === 'function' ? rule.replace.bind(this) : rule.replace);
        });
        result = this.parseFootnotes(result);
        return result;
    }

    parseFootnotes(content) {
        return content.replace(/\(\((.+?)\)\)/g, (match, note) => {
            if (!note.trim()) return match;
            let index = this.footnoteContent.get(note);
            if (index === undefined) {
                index = this.footnoteContent.size;
                this.footnoteContent.set(note, index);
            }
            return `<sup><a href="#fn__${index + 1}" id="fnt__${index + 1}" class="fn_bot">[${index + 1}]</a></sup>`;
        });
    }

    escapeEntities(content) {
        return content
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    flushBlocks(result, tableBuffer, quoteLevel, paragraphBuffer, codeBlockBuffer, tableRowspans, tableAttributes) {
        if (this.listStack.length > 0) {
            while (this.listStack.length > 0) {
                result.push('</li>');
                result.push(`</${this.listStack.pop().type}>`);
                this.currentIndent = -1;
                this.currentType = null;
            }
        }
        if (tableBuffer.length > 0) {
            result.push(this.renderTable(tableBuffer, tableAttributes));
            tableBuffer.length = 0;
            tableRowspans.length = 0;
            tableAttributes = {};
        }
        if (quoteLevel > 0) {
            while (quoteLevel > 0) {
                result.push('</div></blockquote>');
                quoteLevel--;
            }
        }
        if (paragraphBuffer.length > 0) {
            let paraContent = paragraphBuffer.join(' ');
            if (paraContent.trim()) {
                result.push(`<p>${paraContent}</p>`);
            }
            paragraphBuffer.length = 0;
        }
        if (codeBlockBuffer.length > 0) {
            const classAttr = codeLang ? ` class="${codeLang}"` : '';
            result.push(`<pre${classAttr}>${this.escapeEntities(codeBlockBuffer.join('\n'))}</pre>`);
            codeBlockBuffer.length = 0;
        }
        if (this.currentSectionLevel > 0) {
            result.push(`</div>`);
            this.currentSectionLevel = 0;
        }
    }

    static parseCLI() {
        const fs = require('fs');
        const stdin = process.stdin;
        let input = '';
        stdin.setEncoding('utf8');
        stdin.on('readable', () => {
            let chunk;
            while ((chunk = stdin.read())) {
                input += chunk;
            }
        });
        stdin.on('end', () => {
            if (!input.trim()) {
                console.error('Usage: node dokuparserjs.js < input.txt');
                process.exit(1);
            }
            try {
                const parser = new DokuParserJS({
                    currentNamespace: process.env.DOKU_NAMESPACE || '',
                    mediaBasePath: process.env.DOKU_MEDIA_BASE_PATH || '/data/media/',
                    pagesBasePath: process.env.DOKU_PAGES_BASE_PATH || '/data/pages/',
                    useTxtExtension: process.env.DOKU_USE_TXT_EXTENSION === 'true',
                    useDokuWikiPaths: process.env.DOKU_USE_DOKUWIKI_PATHS === 'true'
                });
                const html = parser.parse(input);
                console.log(html);
                process.exit(0);
            } catch (e) {
                console.error('Error parsing input:', e.message);
                process.exit(1);
            }
        });
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = DokuParserJS;
    if (require.main === module) {
        DokuParserJS.parseCLI();
    }
} else {
    if (!window.DokuParserJS) {
        window.DokuParserJS = DokuParserJS;
    }
    document.addEventListener('DOMContentLoaded', function() {
        const parser = new DokuParserJS();
        const preview = document.getElementById('preview');
        if (preview && window.rawContent) {
            try {
                preview.innerHTML = parser.parse(window.rawContent);
            } catch (e) {
                console.error('Error parsing preview:', e.message);
            }
        }
    });
}
