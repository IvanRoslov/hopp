// slugify turns a human name into a lowercase id: Cyrillic is transliterated,
// everything that is not a-z or 0-9 becomes a dash. Shared by the main
// process (validation) and the page (live preview in forms).

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  є: 'ye', і: 'i', ї: 'yi', ґ: 'g',
};

export const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

export function slugify(name: string, maxLen = 40): string {
  let out = '';
  for (const ch of name.toLowerCase().normalize('NFKD')) {
    if (ch in CYRILLIC) out += CYRILLIC[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else if (/[̀-ͯ]/.test(ch)) continue; // combining marks left by NFKD
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-+/, '');
  if (/^[0-9]/.test(out)) out = 'p-' + out;
  out = out.slice(0, maxLen).replace(/-+$/, '');
  return out;
}
