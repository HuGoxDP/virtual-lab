// path: src/app/ui/scenario-card/scenario-card.component.spec.ts
//
// Covers test-plan scenario 117.
//
// Release 1, phase 2 - DW-2.4: the card opens on click, launches from its button without also
// opening, falls back to the category gradient, and keeps long text from stretching the grid.

import { ComponentFixture, TestBed } from '@angular/core/testing';

import { categoryGradient } from '../category-gradient';
import { ScenarioCardComponent, ScenarioCardData } from './scenario-card.component';

function data(overrides: Partial<ScenarioCardData> = {}): ScenarioCardData {
  return {
    id: 'solar-system',
    title: 'Сонячна система',
    description: 'Орбіти планет у масштабі.',
    category: 'astronomy',
    categoryLabel: 'Астрономія',
    version: 'v1.4',
    author: 'О. Гуменюк',
    imageUrl: '',
    archiveBytes: 50537267,
    ...overrides,
  };
}

interface Rendered {
  fixture: ComponentFixture<ScenarioCardComponent>;
  root: HTMLElement;
  opened: string[];
  launched: string[];
}

async function render(scenario: ScenarioCardData): Promise<Rendered> {
  const fixture = TestBed.createComponent(ScenarioCardComponent);
  const opened: string[] = [];
  const launched: string[] = [];
  fixture.componentInstance.open.subscribe(id => opened.push(id));
  fixture.componentInstance.launch.subscribe(id => launched.push(id));
  fixture.componentRef.setInput('scenario', scenario);
  fixture.detectChanges();
  await fixture.whenStable();
  return { fixture, root: fixture.nativeElement as HTMLElement, opened, launched };
}

const q = <T extends Element>(root: HTMLElement, selector: string): T => root.querySelector<T>(selector)!;

describe('ScenarioCardComponent', () => {
  describe('events', () => {
    it('DW-2.4 emits open with the id when the card is clicked', async () => {
      const { root, opened, launched } = await render(data());
      q<HTMLElement>(root, '.scenario-card').click();
      expect(opened).toEqual(['solar-system']);
      expect(launched).toEqual([]);
    });

    it('DW-2.4 emits open when the description or cover is clicked', async () => {
      const { root, opened } = await render(data());
      q<HTMLElement>(root, '.description').click();
      q<HTMLElement>(root, '.cover').click();
      expect(opened).toEqual(['solar-system', 'solar-system']);
    });

    it('DW-2.4 the launch button emits launch only, never open', async () => {
      const { root, opened, launched } = await render(data());
      q<HTMLButtonElement>(root, 'button.launch').click();
      expect(launched).toEqual(['solar-system']);
      expect(opened).toEqual([]);
    });

    it('the title is a real button that opens the scenario (keyboard path) exactly once', async () => {
      const { root, opened, launched } = await render(data());
      const title = q<HTMLButtonElement>(root, '.open-button');
      expect(title.tagName).toBe('BUTTON');
      title.click();
      expect(opened).toEqual(['solar-system']);
      expect(launched).toEqual([]);
    });

    it('labels the launch button with the scenario title for assistive technology', async () => {
      const { root } = await render(data());
      expect(q(root, 'button.launch').getAttribute('aria-label')).toBe('Запустити: Сонячна система');
    });
  });

  describe('cover', () => {
    it('DW-2.4 without an image the cover is the category gradient and no <img> is rendered', async () => {
      const { root } = await render(data({ imageUrl: '' }));
      expect(root.querySelector('img')).toBeNull();
      expect(q<HTMLElement>(root, '.cover').style.background).toContain('gradient');
    });

    it('DW-2.4 the gradient is the one for the category', async () => {
      const { fixture, root } = await render(data({ category: 'biology' }));
      const probe = document.createElement('div');
      probe.style.background = categoryGradient('biology');
      expect(q<HTMLElement>(root, '.cover').style.background).toBe(probe.style.background);
      fixture.destroy();
    });

    it('shows the preview image when there is one', async () => {
      const { root } = await render(data({ imageUrl: '/previews/solar.png' }));
      const img = q<HTMLImageElement>(root, 'img');
      expect(img.getAttribute('src')).toBe('/previews/solar.png');
      expect(img.getAttribute('alt')).toBe('');
    });

    it('DW-2.4 an image that fails to load is removed and the gradient shows', async () => {
      const { fixture, root } = await render(data({ imageUrl: '/previews/missing.png' }));
      q<HTMLImageElement>(root, 'img').dispatchEvent(new Event('error'));
      fixture.detectChanges();
      expect(root.querySelector('img')).toBeNull();
      expect(q<HTMLElement>(root, '.cover').style.background).toContain('gradient');
    });

    it('a failure of one URL does not hide a different URL set later', async () => {
      const { fixture, root } = await render(data({ imageUrl: '/previews/missing.png' }));
      q<HTMLImageElement>(root, 'img').dispatchEvent(new Event('error'));
      fixture.componentRef.setInput('scenario', data({ imageUrl: '/previews/other.png' }));
      fixture.detectChanges();
      expect(q<HTMLImageElement>(root, 'img').getAttribute('src')).toBe('/previews/other.png');
    });
  });

  describe('content', () => {
    it('renders the kicker, version, title, description, author and WebGL badge', async () => {
      const { root } = await render(data());
      expect(q(root, '.card-kicker').textContent).toBe('Астрономія');
      expect(q(root, '.version').textContent).toBe('v1.4');
      expect(q(root, '.title').textContent!.trim()).toBe('Сонячна система');
      expect(q(root, '.description').textContent).toBe('Орбіти планет у масштабі.');
      expect(q(root, '.author-name').textContent).toBe('О. Гуменюк');
      expect(q(root, '.badge-webgl').textContent).toContain('WebGL');
    });

    it('DW-2.4 shows the archive size from bytes', async () => {
      expect(q((await render(data({ archiveBytes: 50537267 }))).root, '.badge-size').textContent).toBe('48,2 МБ');
    });

    it('DW-2.4 renders no size badge when the size is unknown (null or absent)', async () => {
      expect((await render(data({ archiveBytes: null }))).root.querySelector('.badge-size')).toBeNull();
      expect((await render(data({ archiveBytes: undefined }))).root.querySelector('.badge-size')).toBeNull();
    });

    it('omits the author and version when they are missing', async () => {
      const { root } = await render(data({ author: null, version: undefined }));
      expect(root.querySelector('.author')).toBeNull();
      expect(root.querySelector('.version')).toBeNull();
    });

    it('DW-2.4 clamps a 200-character title (two lines, wraps anywhere, full title as tooltip)', async () => {
      const long = 'Ш'.repeat(200);
      const { root } = await render(data({ title: long, description: 'Д'.repeat(600) }));
      const title = q<HTMLElement>(root, '.title');
      const style = getComputedStyle(title);
      expect(title.textContent!.trim()).toBe(long);
      expect(q(root, '.open-button').getAttribute('title')).toBe(long);
      expect(style.overflow).toBe('hidden');
      expect(style.overflowWrap).toBe('anywhere');
      expect(getComputedStyle(q<HTMLElement>(root, '.description')).overflow).toBe('hidden');
    });

    it('treats markup in the title as text', async () => {
      const { root } = await render(data({ title: '<img src=x onerror=alert(1)>' }));
      expect(q(root, '.title').querySelector('img')).toBeNull();
      expect(q(root, '.title').textContent).toContain('<img');
    });
  });
});
