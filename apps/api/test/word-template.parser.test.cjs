const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { deflateRawSync } = require('node:zlib');
const { parseWordQuizTemplate } = require('../dist/assignments/word-template.parser');

function docx(lines, overrideXml) {
  const xml = overrideXml ?? `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${lines.map(line => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</w:t></w:r></w:p>`).join('')}<w:sectPr/></w:body></w:document>`;
  const name = Buffer.from('word/document.xml');
  const source = Buffer.from(xml);
  const data = deflateRawSync(source);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(source.length, 22); local.writeUInt16LE(name.length, 26);
  const localPart = Buffer.concat([local, name, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(source.length, 24); central.writeUInt16LE(name.length, 28);
  const centralPart = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralPart.length, 12); eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const validLines = [
  'ZAILY URPAQ QUIZ TEMPLATE V1', 'SUBJECT: Математика', 'TITLE: Дроби',
  'DESCRIPTION: Проверка знаний', 'TIME LIMIT MINUTES: 20', 'MAX ATTEMPTS: 2',
  'QUESTION:', 'TYPE: SINGLE_CHOICE', 'POINTS: 2.5', 'TEXT: Сколько будет 2 + 2?',
  'OPTIONS:', 'OPTION: [x] 4', 'OPTION: [ ] 5', 'END QUESTION',
  'QUESTION:', 'TYPE: SHORT_TEXT', 'TEXT: Объясните решение своими словами.', 'END QUESTION',
];

test('parses quiz metadata and choice/text questions from a DOCX document body', () => {
  const result = parseWordQuizTemplate(docx(validLines));
  assert.equal(result.subjectName, 'Математика');
  assert.equal(result.title, 'Дроби');
  assert.equal(result.timeLimitMinutes, 20);
  assert.equal(result.maxAttempts, 2);
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions[0].options.map(option => option.isCorrect), [true, false]);
  assert.equal(result.questions[1].type, 'SHORT_TEXT');
  assert.equal(result.questions[1].points, undefined);
});

test('the downloadable project template is a valid import and contains the three supported question types', () => {
  const file = path.join(__dirname, '../../web/public/templates/zaily-urpaq-test-template.docx');
  const result = parseWordQuizTemplate(fs.readFileSync(file));
  assert.deepEqual(result.questions.map(question => question.type), ['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'SHORT_TEXT']);
  assert.equal(result.questions[2].points, undefined);
});

test('rejects invalid archives and unknown template headers with a client error', () => {
  assert.throws(() => parseWordQuizTemplate(Buffer.from('not a word file')), error => error.getStatus?.() === 400);
  assert.throws(() => parseWordQuizTemplate(docx(['OTHER DOCUMENT', ...validLines.slice(1)])), error => error.getStatus?.() === 400);
});

test('rejects malformed choice keys and external XML entities', () => {
  const invalidChoice = validLines.map(line => line === 'OPTION: [x] 4' ? 'OPTION: correct 4' : line);
  assert.throws(() => parseWordQuizTemplate(docx(invalidChoice)), /OPTION запишите/);
  const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY bad SYSTEM "file:///secret">]><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>ZAILY URPAQ QUIZ TEMPLATE V1</w:t></w:r></w:p></w:body></w:document>';
  assert.throws(() => parseWordQuizTemplate(docx([], xml)), /внешние XML-сущности/);
});
