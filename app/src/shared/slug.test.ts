import { describe, expect, it } from 'vitest';
import { SLUG_PATTERN, slugify } from './slug';

describe('slugify', () => {
  it('transliterates Cyrillic, including й and ё', () => {
    expect(slugify('Мой проект')).toBe('moy-proekt');
    expect(slugify('Ёлка')).toBe('yolka');
    expect(slugify('Шрифт заголовков')).toBe('shrift-zagolovkov');
  });
  it('drops Latin accents and turns everything else into dashes', () => {
    expect(slugify('Café  au lait!')).toBe('cafe-au-lait');
    expect(slugify('  --Hello__World--  ')).toBe('hello-world');
  });
  it('starts with a letter and keeps to the length', () => {
    expect(slugify('2026 plan')).toBe('p-2026-plan');
    expect(slugify('a'.repeat(50))).toHaveLength(40);
    expect(slugify('word '.repeat(20), 12)).toBe('word-word-wo');
    expect(SLUG_PATTERN.test(slugify('Мой проект'))).toBe(true);
  });
});
