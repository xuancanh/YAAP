import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writingGuide } from '../server/src/chats/turn-context.service';

test('the writing guide asks for plain, warm language and explains codes; the style only changes length', () => {
  const plain = writingGuide();
  assert.match(plain, /plain, everyday words and full sentences/);
  assert.match(plain, /say what it is the first time/);
  assert.match(plain, /Lead with what matters to the reader/);
  assert.match(plain, /warm and human/);
  assert.match(plain, /two to five sentences/);
  assert.match(writingGuide('concise'), /a few clear sentences, but never so short/);
  assert.match(writingGuide('detailed'), /Explain your reasoning/);
  for (const s of ['plain', 'concise', 'detailed', 'unknown']) assert.match(writingGuide(s), /No walls of text, no telegraphic notes/);
});
