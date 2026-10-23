// path: src/app/site.config.ts

/**
 * Every text about the site itself — name, university, department, address, contacts, logo.
 * Taken from the Nocturne prototype; the owner checks them before a deploy, so they live here and
 * nowhere else. Interface wording that is not about the site (button labels, headings) stays in templates.
 */
export interface SiteConfig {
  readonly name: string;
  readonly university: string;
  /** Short form of the university for places where the full name does not fit (alt text, footer brand). */
  readonly universityShort: string;
  readonly department: string;
  /** One sentence for the footer's "about" block. */
  readonly about: string;
  readonly address: readonly string[];
  readonly email: string;
  readonly logo: { readonly src: string; readonly alt: string };
  readonly copyright: string;
}

export const SITE: SiteConfig = {
  name: 'Віртуальна лабораторія',
  university: 'Херсонський державний університет',
  universityShort: 'ХДУ',
  department: 'Кафедра інформатики, програмної інженерії та економічної кібернетики',
  about: 'Навчальний проєкт кафедри інформатики, програмної інженерії та економічної кібернетики.',
  address: ['вул. Університетська, 27', 'Херсон, 73003'],
  email: 'vlab@ksu.ks.ua',
  logo: { src: '/assets/brand/ksu-logo.png', alt: 'Херсонський державний університет' },
  copyright: '© 2026 Херсонський державний університет',
};
