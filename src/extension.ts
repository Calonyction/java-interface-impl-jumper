import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

const CONFIG_SECTION = 'javaInterfaceImplJumper';
let enableCodeLens = true;
let enableFindReferences = false;
let excludeFolders: string[] = ['node_modules', '.history'];

// ═══════════════════════════════════════════════════════════════════════════════
// Logger
// ═══════════════════════════════════════════════════════════════════════════════

enum LogLevel { None = 0, Error = 1, Warning = 2, Info = 3, Debug = 4 }

let currentLogLevel = LogLevel.Info;

function log(level: LogLevel, message: string, ...args: any[]) {
    if (level > currentLogLevel) { return; }
    const fn = level <= LogLevel.Error ? console.error
        : level <= LogLevel.Warning ? console.warn
        : level <= LogLevel.Info ? console.log
        : console.debug;
    fn(`[JavaImplJumper] ${message}`, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════════
// LRU Cache
// ═══════════════════════════════════════════════════════════════════════════════

class LRUCache<K, V> {
    private map = new Map<K, V>();

    constructor(private maxSize: number) {}

    set(key: K, value: V): void {
        if (this.map.has(key)) { this.map.delete(key); }
        else if (this.map.size >= this.maxSize) {
            const oldest = this.map.keys().next().value;
            if (oldest !== undefined) { this.map.delete(oldest); }
        }
        this.map.set(key, value);
    }

    get(key: K): V | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            this.map.delete(key);
            this.map.set(key, value);
        }
        return value;
    }

    has(key: K): boolean { return this.map.has(key); }
    delete(key: K): boolean { return this.map.delete(key); }
    clear(): void { this.map.clear(); }

    deleteWhere(predicate: (key: K) => boolean): void {
        for (const key of [...this.map.keys()]) {
            if (predicate(key)) { this.map.delete(key); }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Caches & Invalidation
// ═══════════════════════════════════════════════════════════════════════════════

const interfaceImplCache = new LRUCache<string, string[]>(500);
const implInterfaceCache = new LRUCache<string, string[]>(500);
const methodLocationCache = new LRUCache<string, { line: number; column: number }>(200);
const interfaceFilesCache = new LRUCache<string, string[]>(500);
const lombokFieldCache = new LRUCache<string, { version: number; fields: JavaFieldInfo[] }>(200);
const referenceAccessTypeCache = new LRUCache<string, FieldAccessType | 'reference'>(1000);

type FieldAccessType = 'read' | 'write';

interface LombokAccessorConfig {
    hasGetter: boolean;
    hasSetter: boolean;
    customAccessorNaming: boolean;
}

interface JavaFieldInfo {
    name: string;
    type: string;
    line: number;
    column: number;
    ownerClassName: string | null;
    hasGetter: boolean;
    hasSetter: boolean;
    getterNames: string[];
    setterNames: string[];
}

interface FieldReferenceSearchOptions {
    includeReads: boolean;
    includeWrites: boolean;
    includeDeclaration: boolean;
}

type ReferenceTreeItemKind = 'root' | 'file' | 'reference';

interface ReferenceTreeNode {
    kind: ReferenceTreeItemKind;
    label: string;
    location?: vscode.Location;
    children?: ReferenceTreeNode[];
    accessType?: FieldAccessType | 'reference';
    detail?: string;
    hitText?: string;
    highlightRange?: [number, number];
}

function invalidateCachesForFile(filePath: string): void {
    const baseName = path.basename(filePath, '.java');
    interfaceImplCache.deleteWhere(k => k === baseName || k.startsWith('abstractImpl:'));
    implInterfaceCache.delete(baseName);
    interfaceFilesCache.deleteWhere(() => true);
    methodLocationCache.deleteWhere(k => k.includes(filePath));
    lombokFieldCache.delete(filePath);
    log(LogLevel.Debug, `Cache invalidated for: ${baseName}`);
}

function clearAllCaches(): void {
    interfaceImplCache.clear();
    implInterfaceCache.clear();
    methodLocationCache.clear();
    interfaceFilesCache.clear();
    lombokFieldCache.clear();
    referenceAccessTypeCache.clear();
    log(LogLevel.Debug, 'All caches cleared');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Java Parsing Utilities
// ═══════════════════════════════════════════════════════════════════════════════

const JAVA_KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally',
    'return', 'throw', 'new', 'case', 'break', 'continue', 'assert',
    'super', 'this', 'instanceof'
]);

const REQUEST_MAPPING_ANNOTATIONS = [
    '@RequestMapping', '@GetMapping', '@PostMapping',
    '@PutMapping', '@DeleteMapping', '@PatchMapping'
];

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Strip string/char literals and line comments from a single line */
function stripLine(line: string): string {
    return line
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\]|\\.)*'/g, "''")
        .replace(/\/\/.*$/, '');
}

/** Count { and } in a line after stripping strings/comments */
function countBraces(line: string): { open: number; close: number } {
    const stripped = stripLine(line);
    let open = 0, close = 0;
    for (const ch of stripped) {
        if (ch === '{') { open++; }
        else if (ch === '}') { close++; }
    }
    return { open, close };
}

/** Process block comments state for a line, returning cleaned text */
function processBlockComments(line: string, inBlockComment: boolean): { text: string; inBlockComment: boolean } {
    let result = '';
    let i = 0;
    let inComment = inBlockComment;

    while (i < line.length) {
        if (inComment) {
            const endIdx = line.indexOf('*/', i);
            if (endIdx >= 0) { i = endIdx + 2; inComment = false; }
            else { break; }
        } else {
            const startIdx = line.indexOf('/*', i);
            if (startIdx >= 0) {
                result += line.substring(i, startIdx);
                const endIdx = line.indexOf('*/', startIdx + 2);
                if (endIdx >= 0) { i = endIdx + 2; }
                else { inComment = true; break; }
            } else {
                result += line.substring(i);
                break;
            }
        }
    }
    return { text: result, inBlockComment: inComment };
}

/** Check if content defines a Java interface */
function isJavaInterfaceContent(content: string): boolean {
    return /^\s*(?:public\s+)?interface\s+\w+/m.test(content);
}

/** Check if content defines a Java class */
function isJavaClass(content: string): boolean {
    return /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+\w+/m.test(content);
}

/** Check if content defines a Java abstract class */
function isJavaAbstractClass(content: string): boolean {
    return /^\s*(?:public\s+)?abstract\s+class\s+\w+/m.test(content);
}

/** Get the type name (class or interface name) from content */
function getJavaTypeName(content: string): string | null {
    const match = content.match(/\b(?:interface|class)\s+(\w+)/);
    return match?.[1] ?? null;
}

/** Check if a trimmed line looks like a method declaration (not a call or statement) */
function looksLikeMethodDeclaration(text: string): boolean {
    if (!text.includes('(')) { return false; }

    const parenIdx = text.indexOf('(');
    const before = text.substring(0, parenIdx).trim();

    // Assignments are not method declarations
    if (before.includes('=')) { return false; }

    const words = before.split(/\s+/).filter(w => w.length > 0);
    // Need at least return_type + method_name = 2 words
    if (words.length < 2) { return false; }

    // Last word is the method name - reject if it contains '.' (method call on object)
    const lastWord = words[words.length - 1];
    if (lastWord.includes('.')) { return false; }

    // Reject control flow keywords
    const firstWord = words[0];
    if (JAVA_KEYWORDS.has(firstWord)) { return false; }

    return true;
}

/** Extract method name from a line containing a method signature */
function extractMethodName(text: string): string | null {
    const match = text.match(/\b(\w+)\s*\(/);
    if (!match) { return null; }
    return JAVA_KEYWORDS.has(match[1]) ? null : match[1];
}

/** Extract parameters string from a method signature */
function extractMethodParams(text: string): string {
    const match = text.match(/\(([^)]*)\)/);
    return match?.[1]?.trim() ?? '';
}

/** Check if method name matches the class/interface name (i.e., is a constructor) */
function isConstructor(methodName: string, fileContent: string): boolean {
    return getJavaTypeName(fileContent) === methodName;
}

/** Check annotation context above a method line */
function checkAnnotationsAbove(document: vscode.TextDocument, methodLine: number): { hasOverride: boolean; hasRequestMapping: boolean } {
    let hasOverride = false;
    let hasRequestMapping = false;

    for (let i = methodLine - 1; i >= Math.max(0, methodLine - 15); i--) {
        const text = document.lineAt(i).text.trim();
        if (text === '') { continue; }

        // Stop at code boundaries (not annotations or comments)
        if (!text.startsWith('@') && !text.startsWith('//') &&
            !text.startsWith('*') && !text.startsWith('/*') &&
            (text.endsWith(';') || text.endsWith('{') || text.endsWith('}'))) {
            break;
        }

        if (text.startsWith('@')) {
            if (text.includes('@Override')) { hasOverride = true; }
            if (REQUEST_MAPPING_ANNOTATIONS.some(a => text.includes(a))) { hasRequestMapping = true; }
        }
    }
    return { hasOverride, hasRequestMapping };
}

/** Parse a comma-separated list of types, respecting generic angle brackets */
function parseTypeList(str: string): string[] {
    const types: string[] = [];
    let depth = 0, current = '';
    for (const ch of str) {
        if (ch === '<') { depth++; }
        else if (ch === '>') { depth--; }
        else if (ch === ',' && depth === 0) {
            const name = current.trim().split('<')[0].trim();
            if (name && /^\w+$/.test(name)) { types.push(name); }
            current = '';
            continue;
        }
        current += ch;
    }
    const last = current.trim().split('<')[0].trim();
    if (last && /^\w+$/.test(last)) { types.push(last); }
    return types;
}

/** Get implemented interfaces from class content, including __extends:ParentClass markers */
function getImplementedInterfaces(content: string): string[] {
    const interfaces: string[] = [];

    // Extract class declaration (everything from 'class/interface Name' to first '{')
    const declMatch = content.match(/\b(?:class|interface)\s+\w+([^{]*)/);
    if (!declMatch) { return []; }
    const decl = declMatch[1];

    // Parse implements clause
    const implMatch = decl.match(/\bimplements\s+([\s\S]*)/);
    if (implMatch) {
        parseTypeList(implMatch[1]).forEach(t => interfaces.push(t));
    }

    // Parse extends clause (only before 'implements')
    const beforeImpl = implMatch ? decl.substring(0, decl.search(/\bimplements\b/)) : decl;
    const extendsMatch = beforeImpl.match(/\bextends\s+([\w.<>,?\s]+)/);
    if (extendsMatch) {
        const parent = extendsMatch[1].trim().split('<')[0].split(/\s/)[0].trim();
        if (parent && /^\w+$/.test(parent) && parent !== 'Object') {
            interfaces.push(`__extends:${parent}`);
        }
    }

    return interfaces.filter(i => i !== '');
}

/** Check if content contains a specific interface method (ends with ;) */
function containsMethod(content: string, methodName: string): boolean {
    return new RegExp(`\\b${escapeRegex(methodName)}\\s*\\([^)]*\\)\\s*(?:throws\\s+[\\w\\s,.<>]+)?\\s*;`).test(content);
}

/** Check if content contains a specific method implementation (has body { ) */
function containsImplementedMethod(content: string, methodName: string): boolean {
    const escaped = escapeRegex(methodName);
    return new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(?:throws\\s+[\\w\\s,.<>]+)?\\s*\\{`).test(content) ||
        new RegExp(`(?:public|protected)\\s+[\\w<>\\[\\],.\\s]+\\s+${escaped}\\s*\\(`).test(content);
}

/** Find the line where the import section ends */
function findImportSectionEndLine(lines: string[]): number {
    let lastImport = -1;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('import ')) { lastImport = i; continue; }
        if (line === '' || line.startsWith('//') || line.startsWith('/*') ||
            line.startsWith('*') || line.startsWith('package ')) { continue; }
        if (lastImport >= 0) { break; }
    }
    return lastImport;
}

/** Check if a line is a method definition (for reference filtering) */
function isMethodDefinitionLine(lineText: string, methodName: string): boolean {
    if (!lineText.includes(methodName)) { return false; }
    return looksLikeMethodDeclaration(lineText.trim());
}

/** Get class/interface name for display purposes */
function getClassNameFromContent(content: string): string | null {
    const m = content.match(/\b(?:class|interface)\s+(\w+)/);
    return m?.[1] ?? null;
}

/** 获取 Java package 名称 */
function getPackageNameFromContent(content: string): string | null {
    const match = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    return match?.[1] ?? null;
}

/** 获取指定行所在的方法名 */
function getEnclosingMethodName(document: vscode.TextDocument, lineNumber: number): string | null {
    let braceDepth = 0;
    let inBlockComment = false;
    let currentMethod: { name: string; depth: number } | null = null;

    for (let i = 0; i <= lineNumber; i++) {
        const rawLine = document.lineAt(i).text;
        const bc = processBlockComments(rawLine, inBlockComment);
        inBlockComment = bc.inBlockComment;
        const cleanedLine = bc.text;
        const trimmed = stripLine(cleanedLine).trim();
        const depthBefore = braceDepth;

        if (depthBefore === 1 && looksLikeMethodDeclaration(trimmed)) {
            const methodName = extractMethodName(trimmed);
            if (methodName && !isConstructor(methodName, document.getText())) {
                currentMethod = { name: methodName, depth: depthBefore };
            }
        }

        const braces = countBraces(cleanedLine);
        braceDepth += braces.open - braces.close;

        if (currentMethod && braceDepth <= currentMethod.depth && i < lineNumber) {
            currentMethod = null;
        }
    }

    return currentMethod?.name ?? null;
}

/** 构建 Java 语义引用 */
function buildJavaReference(document: vscode.TextDocument, position: vscode.Position): string | null {
    const content = document.getText();
    const className = getClassNameFromContent(content);
    if (!className) { return null; }

    const packageName = getPackageNameFromContent(content);
    const qualifiedClassName = packageName ? `${packageName}.${className}` : className;
    const methodName = getEnclosingMethodName(document, position.line);
    const lineNumber = position.line + 1;

    return methodName
        ? `${qualifiedClassName}#${methodName}:${lineNumber}`
        : `${qualifiedClassName}:${lineNumber}`;
}

/** 构建通用文件引用 */
function buildFileReference(document: vscode.TextDocument, position: vscode.Position): string {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const filePath = workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
        : document.uri.fsPath;
    return `${filePath}:${position.line + 1}`;
}

/** 构建类似 IDEA Copy Reference 的字符串 */
function buildCopyReference(document: vscode.TextDocument, position: vscode.Position): string {
    if (document.languageId === 'java') {
        return buildJavaReference(document, position) || buildFileReference(document, position);
    }

    return buildFileReference(document, position);
}

/** 计算方法引用搜索时可接受的 owner 名称 */
function getReferenceOwnerNames(content: string): string[] {
    const ownerNames = new Set<string>();
    const className = getClassNameFromContent(content);
    if (className) { ownerNames.add(className); }

    for (const iface of getImplementedInterfaces(content)) {
        if (!iface.startsWith('__extends:')) {
            ownerNames.add(iface);
        }
    }

    return [...ownerNames];
}

/** 判断 @Accessors 是否改变 JavaBean 方法命名 */
function hasCustomAccessorsNaming(content: string): boolean {
    const accessorsMatches = content.match(/@Accessors\s*\(([^)]*)\)/g) ?? [];
    return accessorsMatches.some(annotation => {
        const params = annotation.substring(annotation.indexOf('(') + 1, annotation.lastIndexOf(')'));
        return /\bfluent\s*=\s*true\b/.test(params) || /\bprefix\s*=/.test(params);
    });
}

/** 判断当前文件是否使用 Lombok 生成访问器 */
function getLombokAccessorConfig(content: string): LombokAccessorConfig {
    const customAccessorNaming = hasCustomAccessorsNaming(content);
    const hasData = /@Data\b/.test(content);
    const hasGetter = hasData || /@Getter\b/.test(content);
    const hasSetter = hasData || /@Setter\b/.test(content);

    return {
        hasGetter,
        hasSetter,
        customAccessorNaming
    };
}

/** 按 Lombok 规则生成访问器后缀 */
function toAccessorSuffix(fieldName: string): string {
    if (fieldName.length === 0) { return fieldName; }
    if (fieldName.length > 1 && /[A-Z]/.test(fieldName[1])) {
        return fieldName;
    }
    return fieldName.charAt(0).toUpperCase() + fieldName.slice(1);
}

/** 生成 Lombok 字段可能对应的 getter 名称 */
function buildGetterNames(fieldName: string, fieldType: string): string[] {
    const suffix = toAccessorSuffix(fieldName);
    const names = new Set<string>();
    const normalizedType = fieldType.replace(/\s+/g, '');
    const isBoolean = normalizedType === 'boolean' || normalizedType === 'Boolean';

    names.add(`get${suffix}`);
    if (isBoolean) {
        names.add(`is${suffix}`);
        if (fieldName.startsWith('is') && fieldName.length > 2 && /[A-Z]/.test(fieldName[2])) {
            names.add(fieldName);
            names.add(`get${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)}`);
        }
    }

    return [...names];
}

/** 生成 Lombok 字段可能对应的 setter 名称 */
function buildSetterNames(fieldName: string): string[] {
    return [`set${toAccessorSuffix(fieldName)}`];
}

/** 判断当前行是否像字段声明 */
function looksLikeFieldDeclaration(text: string): boolean {
    if (!text.endsWith(';') || text.includes('(') || text.includes(')')) { return false; }
    if (text.startsWith('return ') || text.startsWith('throw ')) { return false; }
    if (/\b(class|interface|enum|record)\b/.test(text)) { return false; }
    return /\b(private|protected|public)\b/.test(text);
}

/** 移除行内注解，降低字段解析复杂度 */
function stripInlineAnnotations(text: string): string {
    return text.replace(/@\w+(?:\([^)]*\))?\s*/g, '');
}

/** 解析 Java 字段声明行 */
function parseFieldDeclarationLine(text: string): { type: string; name: string } | null {
    const cleaned = stripInlineAnnotations(text)
        .replace(/\b(private|protected|public|static|final|transient|volatile)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!cleaned.endsWith(';')) { return null; }

    const withoutInitializer = cleaned.slice(0, -1).split('=')[0]?.trim();
    if (!withoutInitializer) { return null; }

    const match = withoutInitializer.match(/^(.+?)\s+([A-Za-z_]\w*)$/);
    if (!match) { return null; }

    return {
        type: match[1].trim(),
        name: match[2].trim()
    };
}

/** 解析 Lombok 类中的字段 */
function parseLombokFields(document: vscode.TextDocument): JavaFieldInfo[] {
    const filePath = document.uri.fsPath;
    const cached = lombokFieldCache.get(filePath);
    if (cached?.version === document.version) { return cached.fields; }

    const content = document.getText();
    const accessorConfig = getLombokAccessorConfig(content);
    if ((!accessorConfig.hasGetter && !accessorConfig.hasSetter) || accessorConfig.customAccessorNaming) {
        lombokFieldCache.set(filePath, { version: document.version, fields: [] });
        return [];
    }

    const ownerClassName = getClassNameFromContent(content);
    const fields: JavaFieldInfo[] = [];
    let braceDepth = 0;
    let inBlockComment = false;

    for (let i = 0; i < document.lineCount; i++) {
        const rawLine = document.lineAt(i).text;
        const bc = processBlockComments(rawLine, inBlockComment);
        inBlockComment = bc.inBlockComment;
        const cleanedLine = bc.text;
        const braces = countBraces(cleanedLine);
        const depthBefore = braceDepth;
        braceDepth += braces.open - braces.close;

        if (depthBefore !== 1) { continue; }

        const trimmed = stripLine(cleanedLine).trim();
        if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) {
            continue;
        }
        if (trimmed.startsWith('@') && !trimmed.includes(';')) { continue; }
        if (!looksLikeFieldDeclaration(trimmed)) { continue; }

        const parsed = parseFieldDeclarationLine(trimmed);
        if (!parsed) { continue; }

        const column = rawLine.indexOf(parsed.name);
        fields.push({
            name: parsed.name,
            type: parsed.type,
            line: i,
            column: Math.max(column, 0),
            ownerClassName,
            hasGetter: accessorConfig.hasGetter,
            hasSetter: accessorConfig.hasSetter,
            getterNames: accessorConfig.hasGetter ? buildGetterNames(parsed.name, parsed.type) : [],
            setterNames: accessorConfig.hasSetter ? buildSetterNames(parsed.name) : []
        });
    }

    lombokFieldCache.set(filePath, { version: document.version, fields });
    return fields;
}

/** 根据光标位置定位 Lombok 字段 */
function findFieldAtPosition(document: vscode.TextDocument, position: vscode.Position): JavaFieldInfo | null {
    const fields = parseLombokFields(document);
    for (const field of fields) {
        if (field.line !== position.line) { continue; }

        const start = field.column;
        const end = start + field.name.length;
        if (position.character >= start && position.character <= end) {
            return field;
        }
    }
    return null;
}

/** 判断当前行是否包含字段直接写入 */
function containsDirectFieldWrite(lineText: string, fieldName: string): boolean {
    const escaped = escapeRegex(fieldName);
    const assignmentPatterns = [
        new RegExp(`\\b${escaped}\\b\\s*(?:=|\\+=|-=|\\*=|/=|%=|&=|\\|=|\\^=|<<=|>>=|>>>=)`),
        new RegExp(`(?:\\+\\+|--)\\s*\\b${escaped}\\b`),
        new RegExp(`\\b${escaped}\\b\\s*(?:\\+\\+|--)`)
    ];
    return assignmentPatterns.some(pattern => pattern.test(lineText));
}

/** 判断当前行是否包含字段直接读取 */
function containsDirectFieldRead(lineText: string, fieldName: string): boolean {
    const escaped = escapeRegex(fieldName);
    if (!new RegExp(`\\b${escaped}\\b`).test(lineText)) { return false; }
    if (containsDirectFieldWrite(lineText, fieldName)) { return false; }
    return true;
}

/** 收集文件中看起来是目标类型的变量名，用来降低 getId 这类误报 */
function collectLikelyReceiverNames(content: string, className: string): Set<string> {
    const receiverNames = new Set<string>();
    const escapedClassName = escapeRegex(className);
    const declarationPatterns = [
        new RegExp(`\\b${escapedClassName}\\s+([a-zA-Z_]\\w*)\\b`, 'g'),
        new RegExp(`\\b(?:List|Set|Collection|Iterable|ArrayList|HashSet)\\s*<\\s*${escapedClassName}\\s*>\\s+([a-zA-Z_]\\w*)\\b`, 'g')
    ];

    for (const pattern of declarationPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            receiverNames.add(match[1]);
        }
    }

    return receiverNames;
}

/** 判断 getter/setter 调用是否属于目标类实例 */
function findAccessorCallColumn(rawLine: string, methodName: string, className: string | null, receiverNames: Set<string>): number {
    const escapedMethodName = escapeRegex(methodName);
    if (className) {
        const methodRefPattern = new RegExp(`\\b${escapeRegex(className)}\\s*::\\s*${escapedMethodName}\\b`);
        const methodRefMatch = methodRefPattern.exec(rawLine);
        if (methodRefMatch) {
            const methodCol = rawLine.indexOf(methodName, methodRefMatch.index);
            if (methodCol >= 0) { return methodCol; }
        }

        const newInstancePattern = new RegExp(`\\bnew\\s+${escapeRegex(className)}\\s*\\([^)]*\\)\\s*\\.\\s*${escapedMethodName}\\s*\\(`);
        const newInstanceMatch = newInstancePattern.exec(rawLine);
        if (newInstanceMatch) {
            const methodCol = rawLine.indexOf(methodName, newInstanceMatch.index);
            if (methodCol >= 0) { return methodCol; }
        }
    }

    for (const receiverName of receiverNames) {
        const receiverPattern = new RegExp(`\\b${escapeRegex(receiverName)}\\s*\\.\\s*${escapedMethodName}\\s*\\(`);
        const receiverMatch = receiverPattern.exec(rawLine);
        if (!receiverMatch) { continue; }

        const methodCol = rawLine.indexOf(methodName, receiverMatch.index);
        if (methodCol >= 0) { return methodCol; }
    }

    return -1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CodeLens Provider
// ═══════════════════════════════════════════════════════════════════════════════

function createCodeLens(line: number, doc: vscode.TextDocument, title: string, command: string, args: any[]): vscode.CodeLens {
    const range = new vscode.Range(line, 0, line, doc.lineAt(line).text.length);
    return new vscode.CodeLens(range, { title, command, arguments: args });
}

class JavaCodeLensProvider implements vscode.CodeLensProvider {

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (!enableCodeLens || !document.uri.fsPath.endsWith('.java')) { return []; }

        try {
            const codeLenses: vscode.CodeLens[] = [];
            const content = document.getText();
            const filePath = document.uri.fsPath;
            const isIntf = isJavaInterfaceContent(content);
            const isAbstract = !isIntf && isJavaAbstractClass(content);
            const typeName = getJavaTypeName(content);

            if (!typeName) { return []; }

            // --- Type-level CodeLens (interface / abstract class declaration) ---
            if (isIntf || isAbstract) {
                for (let i = 0; i < document.lineCount; i++) {
                    const text = document.lineAt(i).text;
                    if (isIntf && /\binterface\s+/.test(text) && text.includes(typeName)) {
                        codeLenses.push(createCodeLens(i, document, 'Jump to Implementation',
                            'java-interface-impl-jumper.jumpToImplementationFromInterface', [filePath, typeName]));
                        break;
                    }
                    if (isAbstract && /\babstract\s+class\s+/.test(text) && text.includes(typeName)) {
                        codeLenses.push(createCodeLens(i, document, 'Jump to Implementation',
                            'java-interface-impl-jumper.jumpToImplementationFromAbstractClass', [filePath, typeName]));
                        break;
                    }
                }
            }

            if (!isIntf) {
                const lombokFields = parseLombokFields(document);
                for (const field of lombokFields) {
                    if (field.hasGetter) {
                        codeLenses.push(createCodeLens(field.line, document, 'Find Reads',
                            'java-interface-impl-jumper.findLombokFieldReferences', [document.uri, field.line, field.name, 'read']));
                    }
                    if (field.hasSetter) {
                        codeLenses.push(createCodeLens(field.line, document, 'Find Writes',
                            'java-interface-impl-jumper.findLombokFieldReferences', [document.uri, field.line, field.name, 'write']));
                    }
                }
            }

            // --- Method-level CodeLens ---
            let braceDepth = 0;
            let inBlockComment = false;

            for (let i = 0; i < document.lineCount; i++) {
                if (token.isCancellationRequested) { break; }

                const rawLine = document.lineAt(i).text;

                // Handle block comments
                const bc = processBlockComments(rawLine, inBlockComment);
                inBlockComment = bc.inBlockComment;
                const cleanedLine = bc.text;

                // Count braces on cleaned line
                const braces = countBraces(cleanedLine);
                const depthBefore = braceDepth;
                braceDepth += braces.open - braces.close;

                // Only look for methods at class body level (brace depth 1)
                if (depthBefore !== 1) { continue; }

                const trimmed = cleanedLine.trim();
                if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('@')) {
                    continue;
                }

                if (!looksLikeMethodDeclaration(trimmed)) { continue; }

                const methodName = extractMethodName(trimmed);
                if (!methodName || isConstructor(methodName, content)) { continue; }

                const { hasOverride, hasRequestMapping } = checkAnnotationsAbove(document, i);

                if (isIntf) {
                    // For interface methods: skip default/static methods (they have bodies)
                    if (/\b(default|static)\b/.test(trimmed)) { continue; }

                    const params = extractMethodParams(trimmed);
                    codeLenses.push(createCodeLens(i, document, 'Jump to Implementation',
                        'java-interface-impl-jumper.jumpToImplementationFromMethod', [filePath, methodName, params]));

                    if (enableFindReferences) {
                        codeLenses.push(createCodeLens(i, document, 'Find References',
                            'java-interface-impl-jumper.findMethodReferences', [document.uri, i, methodName]));
                    }
                } else {
                    // For class methods
                    const isStatic = /\bstatic\b/.test(trimmed);

                    if (hasOverride && !isStatic) {
                        const params = extractMethodParams(trimmed);
                        codeLenses.push(createCodeLens(i, document, 'Jump to Interface',
                            'java-interface-impl-jumper.jumpToInterfaceFromMethod', [filePath, methodName, params]));
                    }

                    if (enableFindReferences && !hasRequestMapping && !isStatic) {
                        codeLenses.push(createCodeLens(i, document, 'Find References',
                            'java-interface-impl-jumper.findMethodReferences', [document.uri, i, methodName]));
                    }
                }
            }

            return codeLenses;
        } catch (error) {
            log(LogLevel.Error, 'Error in provideCodeLenses:', error);
            return [];
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Exclude Pattern
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a glob exclude pattern from excludeFolders config */
function buildExcludePattern(): string {
    if (excludeFolders.length === 0) { return ''; }
    if (excludeFolders.length === 1) { return `**/${excludeFolders[0]}/**`; }
    return `{${excludeFolders.map(f => `**/${f}/**`).join(',')}}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// File Search
// ═══════════════════════════════════════════════════════════════════════════════

/** Find interface files by name (optimized: search by filename first) */
async function findInterfaceFiles(interfaceName: string): Promise<string[]> {
    if (interfaceFilesCache.has(interfaceName)) {
        return interfaceFilesCache.get(interfaceName) || [];
    }

    const results: string[] = [];

    // Fast path: Java convention is filename = type name
    const files = await vscode.workspace.findFiles(`**/${interfaceName}.java`, buildExcludePattern());
    for (const file of files) {
        try {
            const content = await fs.promises.readFile(file.fsPath, 'utf8');
            if (isJavaInterfaceContent(content) && new RegExp(`\\binterface\\s+${escapeRegex(interfaceName)}\\b`).test(content)) {
                results.push(file.fsPath);
            }
        } catch (e) {
            log(LogLevel.Error, `Error reading ${file.fsPath}:`, e);
        }
    }

    interfaceFilesCache.set(interfaceName, results);
    return results;
}

/** Find all classes implementing a given interface */
async function findImplementations(interfaceName: string): Promise<string[]> {
    if (interfaceImplCache.has(interfaceName)) {
        return interfaceImplCache.get(interfaceName) || [];
    }

    const files = await vscode.workspace.findFiles('**/*.java', buildExcludePattern());
    const implementations: string[] = [];
    const implSet = new Set<string>();
    const abstractParents = new Set<string>();

    // First pass: find direct implementations
    const BATCH = 30;
    for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
            try {
                const content = await fs.promises.readFile(file.fsPath, 'utf8');
                if (!content.includes(interfaceName)) { return; }

                const impls = getImplementedInterfaces(content);
                if (impls.some(iface => iface === interfaceName)) {
                    if (!implSet.has(file.fsPath)) {
                        implSet.add(file.fsPath);
                        implementations.push(file.fsPath);
                    }
                    if (isJavaAbstractClass(content)) {
                        const name = getJavaTypeName(content);
                        if (name) { abstractParents.add(name); }
                    }
                }
            } catch {}
        }));
    }

    // Second pass: find classes extending abstract implementors
    if (abstractParents.size > 0) {
        for (let i = 0; i < files.length; i += BATCH) {
            await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
                if (implSet.has(file.fsPath)) { return; }
                try {
                    const content = await fs.promises.readFile(file.fsPath, 'utf8');
                    for (const parent of abstractParents) {
                        if (content.includes(parent) &&
                            new RegExp(`\\bextends\\s+${escapeRegex(parent)}\\b`).test(content)) {
                            implSet.add(file.fsPath);
                            implementations.push(file.fsPath);
                            break;
                        }
                    }
                } catch {}
            }));
        }
    }

    interfaceImplCache.set(interfaceName, implementations);
    return implementations;
}

/** Find classes extending a given abstract class */
async function findAbstractClassImplementations(abstractClassName: string): Promise<string[]> {
    const cacheKey = `abstractImpl:${abstractClassName}`;
    if (interfaceImplCache.has(cacheKey)) {
        return interfaceImplCache.get(cacheKey) || [];
    }

    const files = await vscode.workspace.findFiles('**/*.java', buildExcludePattern());
    const implementations: string[] = [];

    const BATCH = 30;
    for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(async (file) => {
            try {
                const content = await fs.promises.readFile(file.fsPath, 'utf8');
                if (content.includes(abstractClassName) &&
                    new RegExp(`\\bextends\\s+${escapeRegex(abstractClassName)}\\b`).test(content)) {
                    implementations.push(file.fsPath);
                }
            } catch {}
        }));
    }

    interfaceImplCache.set(cacheKey, implementations);
    return implementations;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Navigation Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/** Open a file and move cursor to a specific position */
async function openFileAtPosition(filePath: string, line: number, column: number): Promise<void> {
    const document = await vscode.workspace.openTextDocument(filePath);
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(line, column);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

/** Open a file and locate the class/interface declaration */
async function openFileAndLocateClass(filePath: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument(filePath);
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (/\bclass\s+\w+/.test(line) && !line.startsWith('//') && !line.startsWith('*')) {
            await openFileAtPosition(filePath, i, 0);
            return;
        }
    }

    // Fallback: just open the file
    await vscode.window.showTextDocument(document);
}

/** Jump to a specific method in a file */
async function jumpToMethodInFile(filePath: string, methodName: string, params: string = ''): Promise<void> {
    try {
        const cacheKey = `loc:${filePath}:${methodName}`;

        // Check cache
        const cached = methodLocationCache.get(cacheKey);
        if (cached) {
            await openFileAtPosition(filePath, cached.line, cached.column);
            return;
        }

        const document = await vscode.workspace.openTextDocument(filePath);
        const text = document.getText();
        const isIntf = isJavaInterfaceContent(text);
        let foundLine = -1;
        let foundCol = 0;

        // Line-by-line search
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line === '') { continue; }

            if (line.includes(methodName) && line.includes('(')) {
                if (isIntf) {
                    // Interface method: line should contain ; or throws
                    if (line.endsWith(';') || line.includes('throws')) {
                        foundLine = i;
                        foundCol = lines[i].indexOf(methodName);
                        break;
                    }
                } else {
                    // Class method: should look like a declaration
                    if (looksLikeMethodDeclaration(line)) {
                        foundLine = i;
                        foundCol = lines[i].indexOf(methodName);
                        break;
                    }
                }
            }
        }

        // Fallback: regex search
        if (foundLine === -1) {
            const regex = new RegExp(`\\b${escapeRegex(methodName)}\\s*\\(`);
            const match = regex.exec(text);
            if (match) {
                const pos = document.positionAt(match.index);
                foundLine = pos.line;
                foundCol = pos.character;
            }
        }

        if (foundLine >= 0) {
            if (foundCol < 0) { foundCol = 0; }
            methodLocationCache.set(cacheKey, { line: foundLine, column: foundCol });
            await openFileAtPosition(filePath, foundLine, foundCol);
        } else {
            vscode.window.showInformationMessage(`Method ${methodName} not found in ${path.basename(filePath)}`);
        }
    } catch (error) {
        log(LogLevel.Error, 'Error in jumpToMethodInFile:', error);
        vscode.window.showErrorMessage(`Error: ${error}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Jump Commands
// ═══════════════════════════════════════════════════════════════════════════════

/** Jump from interface method to its implementation(s) */
async function jumpToImplementationFromMethod(filePath: string, methodName: string, params: string = '') {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        if (!isJavaInterfaceContent(content)) {
            vscode.window.showInformationMessage('Current file is not a Java interface');
            return;
        }

        const interfaceName = getJavaTypeName(content);
        if (!interfaceName) {
            vscode.window.showInformationMessage('Could not determine interface name');
            return;
        }

        const implementations = await findImplementations(interfaceName);
        if (implementations.length === 0) {
            vscode.window.showInformationMessage(`No implementations found for interface ${interfaceName}`);
            return;
        }

        // Find implementations containing this method
        const matching: { label: string; filePath: string }[] = [];
        await Promise.all(implementations.map(async (implPath) => {
            try {
                const implContent = await fs.promises.readFile(implPath, 'utf8');
                if (containsImplementedMethod(implContent, methodName)) {
                    const isAbstract = isJavaAbstractClass(implContent);
                    matching.push({
                        label: path.basename(implPath) + (isAbstract ? ' (Abstract)' : ''),
                        filePath: implPath
                    });
                }
            } catch {}
        }));

        if (matching.length === 0) {
            vscode.window.showInformationMessage(`No implementation found for method ${methodName}`);
            return;
        }

        if (matching.length === 1) {
            await jumpToMethodInFile(matching[0].filePath, methodName, params);
            return;
        }

        const selected = await vscode.window.showQuickPick(
            matching.map(m => ({ label: m.label, description: m.filePath })),
            { placeHolder: `Select implementation for method ${methodName}` }
        );

        if (selected) {
            await jumpToMethodInFile(selected.description, methodName, params);
        }
    } catch (error) {
        log(LogLevel.Error, 'Error in jumpToImplementationFromMethod:', error);
        vscode.window.showErrorMessage(`Error: ${error}`);
    }
}

/** Jump from abstract class declaration to its implementations */
async function jumpToImplementationFromAbstractClass(filePath: string, className: string) {
    try {
        const implementations = await findAbstractClassImplementations(className);

        if (implementations.length === 0) {
            vscode.window.showInformationMessage(`No implementations found for abstract class ${className}`);
            return;
        }

        if (implementations.length === 1) {
            await openFileAndLocateClass(implementations[0]);
            return;
        }

        const selected = await vscode.window.showQuickPick(
            implementations.map(p => ({ label: path.basename(p), description: p })),
            { placeHolder: `Select implementation of ${className}` }
        );

        if (selected) { await openFileAndLocateClass(selected.description); }
    } catch (error) {
        log(LogLevel.Error, 'Error in jumpToImplementationFromAbstractClass:', error);
        vscode.window.showErrorMessage(`Error: ${error}`);
    }
}

/** Jump from interface declaration to its implementations */
async function jumpToImplementationFromInterface(filePath: string, interfaceName: string) {
    try {
        const implementations = await findImplementations(interfaceName);

        if (implementations.length === 0) {
            vscode.window.showInformationMessage(`No implementations found for interface ${interfaceName}`);
            return;
        }

        if (implementations.length === 1) {
            await openFileAndLocateClass(implementations[0]);
            return;
        }

        // Classify implementations (abstract vs concrete)
        const items: { label: string; description: string; isAbstract: boolean }[] = [];
        for (const impl of implementations) {
            try {
                const content = await fs.promises.readFile(impl, 'utf8');
                const isAbstract = isJavaAbstractClass(content);
                items.push({
                    label: path.basename(impl) + (isAbstract ? ' (Abstract)' : ''),
                    description: impl,
                    isAbstract
                });
            } catch {
                items.push({ label: path.basename(impl), description: impl, isAbstract: false });
            }
        }

        // Concrete classes first
        items.sort((a, b) => {
            if (a.isAbstract !== b.isAbstract) { return a.isAbstract ? 1 : -1; }
            return a.label.localeCompare(b.label);
        });

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Select implementation of ${interfaceName}`
        });

        if (selected) { await openFileAndLocateClass(selected.description); }
    } catch (error) {
        log(LogLevel.Error, 'Error in jumpToImplementationFromInterface:', error);
        vscode.window.showErrorMessage(`Error: ${error}`);
    }
}

/** Jump from @Override method to its interface definition */
async function jumpToInterfaceFromMethod(filePath: string, methodName: string, params: string = '') {
    try {
        const content = await fs.promises.readFile(filePath, 'utf8');
        if (!isJavaClass(content)) {
            vscode.window.showInformationMessage('Current file is not a Java class');
            return;
        }

        const className = getJavaTypeName(content);
        if (!className) {
            vscode.window.showInformationMessage('Could not determine class name');
            return;
        }

        // Get implemented interfaces (with parent class tracking)
        let allInterfaces: string[];
        if (implInterfaceCache.has(className)) {
            allInterfaces = [...(implInterfaceCache.get(className) || [])];
        } else {
            allInterfaces = getImplementedInterfaces(content);
            implInterfaceCache.set(className, allInterfaces);
        }

        // Resolve parent class interfaces
        const resolvedInterfaces: string[] = [];
        for (const intf of allInterfaces) {
            if (intf.startsWith('__extends:')) {
                const parentName = intf.substring('__extends:'.length);
                const parentFiles = await vscode.workspace.findFiles(`**/${parentName}.java`, buildExcludePattern());
                for (const pf of parentFiles) {
                    try {
                        const parentContent = await fs.promises.readFile(pf.fsPath, 'utf8');
                        const parentInterfaces = getImplementedInterfaces(parentContent)
                            .filter(i => !i.startsWith('__extends:'));
                        resolvedInterfaces.push(...parentInterfaces);
                    } catch {}
                }
            } else {
                resolvedInterfaces.push(intf);
            }
        }

        const uniqueInterfaces = [...new Set(resolvedInterfaces)];

        if (uniqueInterfaces.length === 0) {
            vscode.window.showInformationMessage('This class does not implement any interfaces');
            return;
        }

        // Find which interfaces contain this method
        const matchingInterfaces: { label: string; filePath: string }[] = [];
        await Promise.all(uniqueInterfaces.map(async (intf) => {
            const files = await findInterfaceFiles(intf);
            for (const file of files) {
                try {
                    const intfContent = await fs.promises.readFile(file, 'utf8');
                    if (containsMethod(intfContent, methodName)) {
                        matchingInterfaces.push({ label: intf, filePath: file });
                    }
                } catch {}
            }
        }));

        if (matchingInterfaces.length === 0) {
            vscode.window.showInformationMessage(`No interface found for method ${methodName}`);
            return;
        }

        if (matchingInterfaces.length === 1) {
            await jumpToMethodInFile(matchingInterfaces[0].filePath, methodName, params);
            return;
        }

        const selected = await vscode.window.showQuickPick(
            matchingInterfaces.map(i => ({ label: i.label, description: i.filePath })),
            { placeHolder: `Select interface for method ${methodName}` }
        );

        if (selected) {
            await jumpToMethodInFile(selected.description, methodName, params);
        }
    } catch (error) {
        log(LogLevel.Error, 'Error in jumpToInterfaceFromMethod:', error);
        vscode.window.showErrorMessage(`Error: ${error}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Find References
// ═══════════════════════════════════════════════════════════════════════════════

let outputChannel: vscode.OutputChannel;
let referenceTreeProvider: ReferenceResultsProvider;
let activeReferenceDecoration: vscode.TextEditorDecorationType | undefined;

class ReferenceResultsProvider implements vscode.TreeDataProvider<ReferenceTreeNode> {
    private readonly changeEmitter = new vscode.EventEmitter<ReferenceTreeNode | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;
    private root: ReferenceTreeNode = {
        kind: 'root',
        label: 'No references found',
        children: []
    };

    getTreeItem(element: ReferenceTreeNode): vscode.TreeItem {
        const collapsibleState = element.children && element.children.length > 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None;
        const label = element.highlightRange
            ? { label: element.label, highlights: [element.highlightRange] }
            : element.label;
        const item = new vscode.TreeItem(label, collapsibleState);

        if (element.kind === 'file') {
            item.resourceUri = element.location?.uri;
            item.contextValue = 'referenceFile';
            item.iconPath = new vscode.ThemeIcon('file-code');
        }

        if (element.kind === 'reference' && element.location) {
            item.description = element.accessType ? element.accessType.toUpperCase() : undefined;
            item.tooltip = element.label;
            item.iconPath = getReferenceIcon(element.accessType || 'reference');
            item.command = {
                title: 'Open Reference',
                command: 'java-interface-impl-jumper.openReferenceLocation',
                arguments: [element.location]
            };
            item.contextValue = 'referenceLocation';
        }

        return item;
    }

    getChildren(element?: ReferenceTreeNode): vscode.ProviderResult<ReferenceTreeNode[]> {
        if (!element) { return this.root.children || []; }
        return element.children || [];
    }

    async setReferences(title: string, references: vscode.Location[]): Promise<void> {
        this.root = {
            kind: 'root',
            label: title,
            children: await buildReferenceTreeNodes(references)
        };
        this.changeEmitter.fire(undefined);
    }
}

/** 获取不同引用类型的图标和颜色 */
function getReferenceIcon(accessType: FieldAccessType | 'reference'): vscode.ThemeIcon {
    if (accessType === 'read') {
        return new vscode.ThemeIcon('eye', new vscode.ThemeColor('testing.iconPassed'));
    }
    if (accessType === 'write') {
        return new vscode.ThemeIcon('edit', new vscode.ThemeColor('testing.iconQueued'));
    }
    return new vscode.ThemeIcon('references', new vscode.ThemeColor('charts.blue'));
}

/** 根据引用来源推断展示类型 */
function inferReferenceAccessType(hitText: string): FieldAccessType | 'reference' {
    if (/^set[A-Z_]/.test(hitText)) { return 'write'; }
    if (/^(get|is)[A-Z_]/.test(hitText)) { return 'read'; }
    return 'reference';
}

/** 生成引用位置缓存键 */
function getReferenceAccessTypeCacheKey(location: vscode.Location): string {
    return `${location.uri.fsPath}:${location.range.start.line}:${location.range.start.character}:${location.range.end.character}`;
}

/** 构建按文件分组的引用结果树 */
async function buildReferenceTreeNodes(references: vscode.Location[]): Promise<ReferenceTreeNode[]> {
    const grouped = new Map<string, vscode.Location[]>();
    for (const ref of references) {
        const refs = grouped.get(ref.uri.fsPath) || [];
        refs.push(ref);
        grouped.set(ref.uri.fsPath, refs);
    }

    const fileNodes: ReferenceTreeNode[] = [];
    for (const [filePath, fileReferences] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        const children: ReferenceTreeNode[] = [];
        const doc = await vscode.workspace.openTextDocument(filePath);
        const sortedRefs = fileReferences.sort((a, b) => a.range.start.line - b.range.start.line);

        for (const ref of sortedRefs) {
            const lineText = doc.lineAt(ref.range.start.line).text.trim();
            const hitText = doc.getText(ref.range);
            const accessType = referenceAccessTypeCache.get(getReferenceAccessTypeCacheKey(ref)) || inferReferenceAccessType(hitText);
            const prefix = `${ref.range.start.line + 1}: `;
            const label = `${prefix}${lineText}`;
            const hitStart = label.indexOf(hitText, prefix.length);
            const highlightRange: [number, number] | undefined = hitStart >= 0
                ? [hitStart, hitStart + hitText.length]
                : undefined;
            children.push({
                kind: 'reference',
                label,
                location: ref,
                accessType,
                hitText,
                highlightRange
            });
        }

        fileNodes.push({
            kind: 'file',
            label: `${path.basename(filePath)} (${children.length})`,
            location: new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0)),
            children
        });
    }

    return fileNodes;
}

/** 在编辑器中打开引用位置 */
async function openReferenceLocation(location: vscode.Location): Promise<void> {
    const document = await vscode.workspace.openTextDocument(location.uri);
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(location.range.start, location.range.end);
    if (activeReferenceDecoration) {
        activeReferenceDecoration.dispose();
    }
    activeReferenceDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
        border: '1px solid',
        borderColor: new vscode.ThemeColor('editor.findMatchBorder')
    });
    editor.setDecorations(activeReferenceDecoration, [location.range]);
    editor.revealRange(location.range, vscode.TextEditorRevealType.InCenter);
}

/** 复制当前 Java 行的引用 */
async function copyReference(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showInformationMessage('No active editor');
        return;
    }

    const reference = buildCopyReference(editor.document, editor.selection.active);

    await vscode.env.clipboard.writeText(reference);
    vscode.window.setStatusBarMessage(`Copied reference: ${reference}`, 3000);
}

/** 在底部面板展示引用结果 */
async function showReferencesInPanel(references: vscode.Location[], title: string): Promise<void> {
    await referenceTreeProvider.setReferences(title, references);
    await vscode.commands.executeCommand('java-interface-impl-jumper.referenceResults.focus');
}

/** Find all references to a method across the workspace */
async function findMethodReferences(docUri: vscode.Uri, lineNumber: number, methodName?: string) {
    if (!enableFindReferences) { return; }

    try {
        const document = await vscode.workspace.openTextDocument(docUri);
        let name = methodName || '';

        if (!name) {
            const lineText = document.lineAt(lineNumber).text.trim();
            name = extractMethodName(lineText) || '';
        }

        if (!name) {
            vscode.window.showInformationMessage('Could not determine method name');
            return;
        }

        if (JAVA_KEYWORDS.has(name)) {
            vscode.window.showWarningMessage(`"${name}" is a Java keyword, skipping reference search`);
            return;
        }

        outputChannel.show(true);
        outputChannel.appendLine(`\nFinding references to ${name}...`);

        const ownerNames = getReferenceOwnerNames(document.getText());
        const references = await findReferencesManually(name, docUri, ownerNames);

        outputChannel.appendLine(`Found ${references.length} references to ${name}`);

        // Filter out self-reference
        const filtered = references.filter(ref =>
            !(ref.uri.fsPath === docUri.fsPath && ref.range.start.line === lineNumber)
        );

        if (filtered.length === 0) {
            outputChannel.appendLine(`No external references found for method ${name}`);
            vscode.window.showInformationMessage(`No references found for method ${name}`);
            return;
        }

        if (filtered.length === 1) {
            const ref = filtered[0];
            const refDoc = await vscode.workspace.openTextDocument(ref.uri);
            const editor = await vscode.window.showTextDocument(refDoc);
            editor.selection = new vscode.Selection(ref.range.start, ref.range.end);
            editor.revealRange(ref.range, vscode.TextEditorRevealType.InCenter);
            return;
        }

        await showReferencesInPanel(filtered, `${name} (${filtered.length})`);
    } catch (error) {
        log(LogLevel.Error, 'Error in findMethodReferences:', error);
        vscode.window.showErrorMessage(`Error finding references: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** Manually search for method references across all Java files */
async function findReferencesManually(methodName: string, originUri: vscode.Uri, ownerNames: string[] = []): Promise<vscode.Location[]> {
    const references: vscode.Location[] = [];
    const seen = new Set<string>();
    const files = await vscode.workspace.findFiles('**/*.java', buildExcludePattern());
    const patternStr = `\\b${escapeRegex(methodName)}\\s*\\(`;

    const BATCH = 20;
    for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(async (fileUri) => {
            try {
                const content = await fs.promises.readFile(fileUri.fsPath, 'utf8');
                if (!content.includes(methodName)) { return; }
                if (ownerNames.length > 0 && !ownerNames.some(ownerName => content.includes(ownerName))) { return; }

                const lines = content.split('\n');
                const importEnd = findImportSectionEndLine(lines);
                const regex = new RegExp(patternStr, 'g');
                let match: RegExpExecArray | null;

                while ((match = regex.exec(content)) !== null) {
                    const before = content.substring(0, match.index);
                    const lineNum = before.split('\n').length - 1;

                    if (lineNum <= importEnd) { continue; }

                    const lineText = lines[lineNum].trim();
                    if (lineText.startsWith('import ')) { continue; }
                    if (isMethodDefinitionLine(lineText, methodName)) { continue; }

                    const key = `${fileUri.fsPath}:${lineNum}`;
                    if (seen.has(key)) { continue; }
                    seen.add(key);

                    const col = match.index - before.lastIndexOf('\n') - 1;
                    const location = new vscode.Location(
                        fileUri,
                        new vscode.Range(lineNum, col, lineNum, col + methodName.length)
                    );
                    referenceAccessTypeCache.set(getReferenceAccessTypeCacheKey(location), 'reference');
                    references.push(location);
                }
            } catch {}
        }));

        if (references.length > 500) { break; }
    }

    return references;
}

/** 在工作区中搜索 Lombok 字段的读写引用 */
async function findLombokFieldReferencesManually(
    field: JavaFieldInfo,
    originUri: vscode.Uri,
    options: FieldReferenceSearchOptions
): Promise<vscode.Location[]> {
    const references: vscode.Location[] = [];
    const seen = new Set<string>();
    const files = await vscode.workspace.findFiles('**/*.java', buildExcludePattern());
    const accessorNames = [
        ...(options.includeReads ? field.getterNames : []),
        ...(options.includeWrites ? field.setterNames : [])
    ];
    const searchTokens = [field.name, ...accessorNames];

    if (options.includeDeclaration) {
        references.push(new vscode.Location(
            originUri,
            new vscode.Range(field.line, field.column, field.line, field.column + field.name.length)
        ));
    }

    const BATCH = 20;
    for (let i = 0; i < files.length; i += BATCH) {
        await Promise.all(files.slice(i, i + BATCH).map(async (fileUri) => {
            try {
                const content = await fs.promises.readFile(fileUri.fsPath, 'utf8');
                if (!searchTokens.some(token => content.includes(token))) { return; }
                if (field.ownerClassName && !content.includes(field.ownerClassName) && fileUri.fsPath !== originUri.fsPath) {
                    return;
                }

                const lines = content.split('\n');
                const importEnd = findImportSectionEndLine(lines);
                const isOriginFile = fileUri.fsPath === originUri.fsPath;
                const receiverNames = field.ownerClassName
                    ? collectLikelyReceiverNames(content, field.ownerClassName)
                    : new Set<string>();

                for (let lineNum = 0; lineNum < lines.length; lineNum++) {
                    if (lineNum <= importEnd) { continue; }
                    if (isOriginFile && lineNum === field.line) { continue; }

                    const rawLine = lines[lineNum];
                    const lineText = stripLine(rawLine).trim();
                    if (!lineText || lineText.startsWith('import ')) { continue; }
                    if (lineText.startsWith('//') || lineText.startsWith('*')) { continue; }

                    const matches: { name: string; accessType: FieldAccessType }[] = [];

                    if (isOriginFile && options.includeReads && containsDirectFieldRead(lineText, field.name)) {
                        matches.push({ name: field.name, accessType: 'read' });
                    }
                    if (isOriginFile && options.includeWrites && containsDirectFieldWrite(lineText, field.name)) {
                        matches.push({ name: field.name, accessType: 'write' });
                    }
                    if (options.includeReads) {
                        for (const getterName of field.getterNames) {
                            if (isOriginFile && new RegExp(`\\b${escapeRegex(getterName)}\\s*\\(`).test(lineText)) {
                                matches.push({ name: getterName, accessType: 'read' });
                                continue;
                            }
                            if (findAccessorCallColumn(rawLine, getterName, field.ownerClassName, receiverNames) >= 0) {
                                matches.push({ name: getterName, accessType: 'read' });
                            }
                        }
                    }
                    if (options.includeWrites) {
                        for (const setterName of field.setterNames) {
                            if (isOriginFile && new RegExp(`\\b${escapeRegex(setterName)}\\s*\\(`).test(lineText)) {
                                matches.push({ name: setterName, accessType: 'write' });
                                continue;
                            }
                            if (findAccessorCallColumn(rawLine, setterName, field.ownerClassName, receiverNames) >= 0) {
                                matches.push({ name: setterName, accessType: 'write' });
                            }
                        }
                    }

                    for (const match of matches) {
                        const accessorCol = match.name === field.name
                            ? -1
                            : findAccessorCallColumn(rawLine, match.name, field.ownerClassName, receiverNames);
                        const col = accessorCol >= 0 ? accessorCol : rawLine.indexOf(match.name);
                        if (col < 0) { continue; }

                        const key = `${fileUri.fsPath}:${lineNum}:${col}:${match.accessType}`;
                        if (seen.has(key)) { continue; }
                        seen.add(key);

                        const location = new vscode.Location(
                            fileUri,
                            new vscode.Range(lineNum, col, lineNum, col + match.name.length)
                        );
                        referenceAccessTypeCache.set(getReferenceAccessTypeCacheKey(location), match.accessType);
                        references.push(location);
                    }
                }
            } catch {}
        }));

        if (references.length > 500) { break; }
    }

    return references;
}

/** 查找 Lombok 字段的读取或写入引用 */
async function findLombokFieldReferences(docUri: vscode.Uri, lineNumber: number, fieldName: string, accessType: FieldAccessType) {
    try {
        const document = await vscode.workspace.openTextDocument(docUri);
        const field = parseLombokFields(document).find(item => item.line === lineNumber && item.name === fieldName);
        if (!field) {
            vscode.window.showInformationMessage(`Could not determine Lombok field ${fieldName}`);
            return;
        }

        outputChannel.show(true);
        outputChannel.appendLine(`\nFinding ${accessType}s for Lombok field ${field.name}...`);

        const references = await findLombokFieldReferencesManually(field, docUri, {
            includeReads: accessType === 'read',
            includeWrites: accessType === 'write',
            includeDeclaration: false
        });

        outputChannel.appendLine(`Found ${references.length} ${accessType} references to ${field.name}`);

        if (references.length === 0) {
            vscode.window.showInformationMessage(`No ${accessType} references found for Lombok field ${field.name}`);
            return;
        }

        if (references.length === 1) {
            const ref = references[0];
            const refDoc = await vscode.workspace.openTextDocument(ref.uri);
            const editor = await vscode.window.showTextDocument(refDoc);
            editor.selection = new vscode.Selection(ref.range.start, ref.range.end);
            editor.revealRange(ref.range, vscode.TextEditorRevealType.InCenter);
            return;
        }

        await showReferencesInPanel(references, `${field.name} ${accessType} (${references.length})`);
    } catch (error) {
        log(LogLevel.Error, 'Error in findLombokFieldReferences:', error);
        vscode.window.showErrorMessage(`Error finding Lombok field references: ${error instanceof Error ? error.message : String(error)}`);
    }
}

class LombokFieldReferenceProvider implements vscode.ReferenceProvider {
    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        if (token.isCancellationRequested) { return []; }

        const field = findFieldAtPosition(document, position);
        if (!field) { return []; }

        return findLombokFieldReferencesManually(field, document.uri, {
            includeReads: field.hasGetter,
            includeWrites: field.hasSetter,
            includeDeclaration: context.includeDeclaration
        });
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extension Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

let cacheCleanupInterval: ReturnType<typeof setInterval> | undefined;

export function activate(context: vscode.ExtensionContext) {
    log(LogLevel.Info, 'Extension activated');

    // Read configuration
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    enableCodeLens = config.get('enableCodeLens', true);
    enableFindReferences = config.get('enableFindReferences', false);
    excludeFolders = config.get<string[]>('excludeFolders', ['node_modules', '.history']);

    // Output channel (created once, reused)
    outputChannel = vscode.window.createOutputChannel('Java Interface Impl Jumper');
    context.subscriptions.push(outputChannel);

    // 注册固定引用结果面板
    referenceTreeProvider = new ReferenceResultsProvider();
    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('java-interface-impl-jumper.referenceResults', referenceTreeProvider)
    );

    // Watch configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
                enableCodeLens = cfg.get('enableCodeLens', true);
                enableFindReferences = cfg.get('enableFindReferences', false);
                const newExcludeFolders = cfg.get<string[]>('excludeFolders', ['node_modules', '.history']);
                if (JSON.stringify(newExcludeFolders) !== JSON.stringify(excludeFolders)) {
                    excludeFolders = newExcludeFolders;
                    clearAllCaches();
                }
                log(LogLevel.Info, `Config updated: CodeLens=${enableCodeLens}, FindReferences=${enableFindReferences}, ExcludeFolders=${excludeFolders.join(',')}`);
            }
        })
    );

    // Register CodeLens provider
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: 'java', scheme: 'file' },
            new JavaCodeLensProvider()
        )
    );

    // 注册 Lombok 字段引用查询能力
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider(
            { language: 'java', scheme: 'file' },
            new LombokFieldReferenceProvider()
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('java-interface-impl-jumper.jumpToImplementationFromMethod', jumpToImplementationFromMethod),
        vscode.commands.registerCommand('java-interface-impl-jumper.jumpToInterfaceFromMethod', jumpToInterfaceFromMethod),
        vscode.commands.registerCommand('java-interface-impl-jumper.findMethodReferences', findMethodReferences),
        vscode.commands.registerCommand('java-interface-impl-jumper.findLombokFieldReferences', findLombokFieldReferences),
        vscode.commands.registerCommand('java-interface-impl-jumper.openReferenceLocation', openReferenceLocation),
        vscode.commands.registerCommand('java-interface-impl-jumper.copyReference', copyReference),
        vscode.commands.registerCommand('java-interface-impl-jumper.jumpToImplementationFromAbstractClass', jumpToImplementationFromAbstractClass),
        vscode.commands.registerCommand('java-interface-impl-jumper.jumpToImplementationFromInterface', jumpToImplementationFromInterface)
    );

    // File watcher: targeted invalidation on change, full clear on create/delete
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.java');
    watcher.onDidChange(uri => invalidateCachesForFile(uri.fsPath));
    watcher.onDidCreate(() => clearAllCaches());
    watcher.onDidDelete(() => clearAllCaches());
    context.subscriptions.push(watcher);

    // Periodic cache cleanup (every 30 minutes)
    cacheCleanupInterval = setInterval(clearAllCaches, 30 * 60 * 1000);
}

export function deactivate() {
    if (cacheCleanupInterval) {
        clearInterval(cacheCleanupInterval);
        cacheCleanupInterval = undefined;
    }
    if (activeReferenceDecoration) {
        activeReferenceDecoration.dispose();
        activeReferenceDecoration = undefined;
    }
    clearAllCaches();
}
