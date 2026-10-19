import { BadRequestException } from '@nestjs/common';
import { inflateRawSync } from 'node:zlib';

const MAX_DOCX_BYTES = 5 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;
const HEADER = 'ZAILY URPAQ QUIZ TEMPLATE V1';
const TYPES = new Set(['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'SHORT_TEXT']);

export type ImportedQuestion = {
  type: string;
  prompt: string;
  points?: number;
  required: boolean;
  options?: Array<{ text: string; isCorrect: boolean }>;
};

export type ImportedAssignment = {
  title: string;
  subjectName: string;
  description?: string;
  timeLimitMinutes?: number;
  maxAttempts: number;
  lobbyTarget?: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  questions: ImportedQuestion[];
};

function fail(message: string): never { throw new BadRequestException(message); }

function getEntry(buffer: Buffer, target: string): Buffer {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.length > MAX_DOCX_BYTES) {
    return fail('Файл Word должен быть размером не более 5 МБ');
  }
  const min = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= min; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) return fail('Файл не является корректным DOCX');
  const count = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (!count || count > MAX_ZIP_ENTRIES || directorySize > MAX_DOCX_BYTES || cursor + directorySize > eocd) {
    return fail('Архив Word повреждён или содержит слишком много файлов');
  }
  let found: { method: number; compressed: number; size: number; localOffset: number; flags: number } | undefined;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) return fail('Архив Word повреждён');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > buffer.length) return fail('Архив Word повреждён');
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (name === target) found = { method, compressed, size, localOffset, flags };
    cursor = end;
  }
  if (!found) return fail('В DOCX отсутствует основной текст документа');
  if ((found.flags & 1) !== 0 || (found.method !== 0 && found.method !== 8) || found.size > MAX_XML_BYTES || found.compressed > MAX_DOCX_BYTES) {
    return fail('Формат или размер содержимого DOCX не поддерживается');
  }
  const local = found.localOffset;
  if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) return fail('Архив Word повреждён');
  const nameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const start = local + 30 + nameLength + extraLength;
  const end = start + found.compressed;
  if (end > buffer.length) return fail('Архив Word повреждён');
  try {
    const content = found.method === 0 ? buffer.subarray(start, end) : inflateRawSync(buffer.subarray(start, end), { maxOutputLength: MAX_XML_BYTES });
    if (content.length !== found.size) return fail('Размер XML не совпадает с заголовком DOCX');
    return content;
  } catch {
    return fail('Не удалось безопасно распаковать документ Word');
  }
}

function decodeXml(value: string) {
  return value.replace(/&#x([0-9a-f]{1,6});/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]{1,7});/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'").replace(/&amp;/gu, '&');
}

function paragraphs(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) return fail('В документе Word запрещены внешние XML-сущности');
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)].map(([, paragraph]) => {
    const pieces: string[] = [];
    for (const match of paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gu)) {
      if (match[1] !== undefined) pieces.push(decodeXml(match[1]));
      else pieces.push(match[0].startsWith('<w:tab') ? '\t' : '\n');
    }
    return pieces.join('').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '').trim();
  });
}

function integer(value: string, label: string, min: number, max: number): number {
  if (!/^\d{1,5}$/u.test(value.trim())) return fail(`${label}: укажите целое число от ${min} до ${max}`);
  const result = Number(value.trim());
  if (result < min || result > max) return fail(`${label}: допустимо от ${min} до ${max}`);
  return result;
}

export function parseWordQuizTemplate(buffer: Buffer): ImportedAssignment {
  const xml = getEntry(buffer, 'word/document.xml').toString('utf8');
  const lines = paragraphs(xml);
  if (lines[0]?.toLocaleUpperCase('en-US') !== HEADER) return fail('Скачайте шаблон Zaily Urpaq и заполните его без удаления первой строки');

  let title = '';
  let subjectName = '';
  let description = '';
  let timeLimitMinutes: number | undefined;
  let maxAttempts = 1;
  let lobbyTarget: number | undefined;
  let shuffleQuestions = true;
  let shuffleOptions = true;
  const questions: ImportedQuestion[] = [];
  let current: { type?: string; prompt?: string; textLines: string[]; points?: number; required: boolean; options: ImportedQuestion['options']; readingPrompt: boolean; readingOptions: boolean } | null = null;

  const valueAfter = (line: string, label: string) => line.slice(label.length).trim();
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    if (!current) {
      if (/^SUBJECT:/iu.test(line)) subjectName = valueAfter(line, 'SUBJECT:');
      else if (/^TITLE:/iu.test(line)) title = valueAfter(line, 'TITLE:');
      else if (/^DESCRIPTION:/iu.test(line)) description = valueAfter(line, 'DESCRIPTION:');
      else if (/^TIME LIMIT MINUTES:/iu.test(line)) { const raw = valueAfter(line, 'TIME LIMIT MINUTES:'); timeLimitMinutes = raw.toLocaleLowerCase('en-US') === 'none' ? undefined : integer(raw, 'Лимит времени', 1, 600); }
      else if (/^MAX ATTEMPTS:/iu.test(line)) maxAttempts = integer(valueAfter(line, 'MAX ATTEMPTS:'), 'Число попыток', 1, 100);
      else if (/^LOBBY SIZE:/iu.test(line)) { const raw = valueAfter(line, 'LOBBY SIZE:'); lobbyTarget = raw.toLocaleLowerCase('en-US') === 'none' ? undefined : integer(raw, 'Размер лобби', 1, 2000); }
      else if (/^SHUFFLE QUESTIONS:/iu.test(line)) shuffleQuestions = valueAfter(line, 'SHUFFLE QUESTIONS:').toLocaleLowerCase('en-US') !== 'no';
      else if (/^SHUFFLE OPTIONS:/iu.test(line)) shuffleOptions = valueAfter(line, 'SHUFFLE OPTIONS:').toLocaleLowerCase('en-US') !== 'no';
      else if (/^QUESTION:/iu.test(line)) current = { textLines: [], options: [], required: true, readingPrompt: false, readingOptions: false };
      else if (/^END QUESTION/iu.test(line)) return fail('Найден закрывающий тег без вопроса');
      continue;
    }

    if (/^END QUESTION/iu.test(line)) {
      const prompt = current.prompt ?? current.textLines.join('\n').trim();
      const type = current.type?.toUpperCase();
      if (!type || !TYPES.has(type)) return fail(`Вопрос ${questions.length + 1}: TYPE должен быть SINGLE_CHOICE, MULTIPLE_CHOICE или SHORT_TEXT`);
      if (!prompt) return fail(`Вопрос ${questions.length + 1}: заполните TEXT`);
      const question: ImportedQuestion = { type, prompt, required: current.required };
      if (type === 'SINGLE_CHOICE' || type === 'MULTIPLE_CHOICE') {
        if ((current.options?.length ?? 0) < 2) return fail(`Вопрос ${questions.length + 1}: добавьте минимум два варианта OPTION`);
        const correctCount = current.options!.filter(option => option.isCorrect).length;
        if (type === 'SINGLE_CHOICE' ? correctCount !== 1 : correctCount < 1) return fail(`Вопрос ${questions.length + 1}: отметьте правильные варианты в поле OPTION`);
        question.options = current.options;
        question.points = current.points ?? 1;
      }
      questions.push(question);
      current = null;
      continue;
    }
    if (/^TYPE:/iu.test(line)) { current.type = valueAfter(line, 'TYPE:').toUpperCase(); current.readingPrompt = false; current.readingOptions = false; continue; }
    if (/^POINTS:/iu.test(line)) { const raw = valueAfter(line, 'POINTS:'); const points = Number(raw); if (!/^(?:\d{1,5})(?:\.\d{1,2})?$/u.test(raw) || points < 0.01 || points > 10000) return fail(`Вопрос ${questions.length + 1}: POINTS от 0.01 до 10000 с точностью до двух знаков`); current.points = points; continue; }
    if (/^REQUIRED:/iu.test(line)) { current.required = valueAfter(line, 'REQUIRED:').toLocaleLowerCase('en-US') !== 'no'; continue; }
    if (/^TEXT:/iu.test(line)) { current.textLines.push(valueAfter(line, 'TEXT:')); current.readingPrompt = true; current.readingOptions = false; continue; }
    if (/^OPTIONS:/iu.test(line)) { current.readingPrompt = false; current.readingOptions = true; continue; }
    if (/^OPTION:/iu.test(line)) {
      current.readingPrompt = false; current.readingOptions = true;
      const text = valueAfter(line, 'OPTION:');
      const match = /^\[([xX ])\]\s*(.+)$/u.exec(text);
      if (!match || !match[2].trim()) return fail(`Вопрос ${questions.length + 1}: OPTION запишите как [x] правильный или [ ] неправильный`);
      current.options!.push({ text: match[2].trim(), isCorrect: match[1].toLowerCase() === 'x' });
      if (current.options!.length > 100) return fail('В одном вопросе допускается не более 100 вариантов');
      continue;
    }
    if (/^(?:CORRECT|TOLERANCE):/iu.test(line)) return fail(`Вопрос ${questions.length + 1}: текущий шаблон не поддерживает числовой тип ответа`);
    if (current.readingPrompt) current.textLines.push(line);
    else if (current.readingOptions && current.options!.length) current.options![current.options!.length - 1].text += `\n${line}`;
  }

  if (current) return fail('Не найден END QUESTION у последнего вопроса');
  if (!subjectName.trim() || subjectName.length > 120 || /[\p{Cc}\p{Cf}]/u.test(subjectName)) return fail('Заполните SUBJECT обычным текстом до 120 символов');
  if (!title.trim() || title.length > 200) return fail('Заполните TITLE (до 200 символов)');
  if (description.length > 5000) return fail('DESCRIPTION не должен превышать 5000 символов');
  if (!questions.length || questions.length > 200) return fail('В документе должно быть от 1 до 200 вопросов');
  return { title: title.trim(), subjectName: subjectName.trim(), description: description.trim() || undefined, timeLimitMinutes, maxAttempts, lobbyTarget, shuffleQuestions, shuffleOptions, questions };
}
