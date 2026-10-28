// path: src/app/pages/admin/archive-upload/archive-upload.component.spec.ts
//
// Test-plan scenarios 218 (DW-6.1) and 220 (DW-6.3): the drop zone refuses a file that cannot be right before
// uploading, shows progress with a cancel button, aborts on cancel or on leaving, and says in words why a
// server refusal happened (a 409 for a scenario in review explains withdrawal).

import { HttpErrorResponse } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { UploadCancelled } from '../../../services/admin-api.service';
import { settle } from '../admin-testing';
import { ArchiveSender, ArchiveUploadComponent } from './archive-upload.component';
import { WITHDRAW_HINT, checkArchiveFile, describeUploadError } from './archive-upload';

const MIB = 1024 * 1024;
const zip = (name = 'scene.zip', bytes = 4) => new File([new Uint8Array(bytes)], name);

describe('checkArchiveFile', () => {
  it('DW-6.3 accepts a ZIP within the cap, any case of the extension', () => {
    expect(checkArchiveFile(zip('a.zip'), 10 * MIB)).toBeNull();
    expect(checkArchiveFile(zip('A.ZIP'), 10 * MIB)).toBeNull();
  });

  it('DW-6.3 accepts a file of exactly the cap and refuses one byte more, naming both sizes', () => {
    expect(checkArchiveFile(zip('a.zip', 100), 100)).toBeNull();
    const refusal = checkArchiveFile(zip('a.zip', 101), 100);
    expect(refusal).toContain('завеликий');
    expect(refusal).toContain('Нічого не завантажено');
  });

  it('DW-6.3 refuses a 200 MB archive against a 100 MB cap with both figures in the message', () => {
    const big = { name: 'big.zip', size: 200 * MIB } as File;
    expect(checkArchiveFile(big, 100 * MIB)).toMatch(/200 МБ.*100 МБ/);
  });

  it('refuses a non-ZIP name and an empty file, and applies no cap while the cap is unknown', () => {
    expect(checkArchiveFile(zip('a.rar'), null)).toMatch(/\.zip/);
    expect(checkArchiveFile(zip('zip'), null)).toMatch(/\.zip/);
    expect(checkArchiveFile(zip('a.zip', 0), null)).toBe('Файл порожній.');
    expect(checkArchiveFile({ name: 'a.zip', size: 10 ** 12 } as File, null)).toBeNull();
  });
});

describe('describeUploadError', () => {
  it('DW-6.3 a 409 about a scenario in review keeps the server\'s words and adds the way out', () => {
    const err = new HttpErrorResponse({ status: 409, error: { error: 'Сценарій на перевірці: відкличте з перевірки, щоб завантажити новий архів' } });
    const text = describeUploadError(err)!;
    expect(text).toContain('Сценарій на перевірці');
    expect(text).toContain(WITHDRAW_HINT);
  });

  it('other refusals are shown as the server sent them, without the withdraw hint', () => {
    const taken = describeUploadError(new HttpErrorResponse({ status: 409, error: { error: 'Сценарій з id "x" вже існує' } }));
    expect(taken).toBe('Сценарій з id "x" вже існує');
    expect(describeUploadError(new HttpErrorResponse({ status: 413, error: { error: 'Архів завеликий: максимум 200 МіБ' } }))).toContain('200 МіБ');
  });

  it('a request that never reached the server says so instead of «Помилка 0»', () => {
    expect(describeUploadError(new HttpErrorResponse({ status: 0 }))).toContain('Немає звʼязку');
  });

  it('a cancelled upload is not an error', () => {
    expect(describeUploadError(new UploadCancelled())).toBeNull();
  });
});

describe('ArchiveUploadComponent', () => {
  let fixture: ComponentFixture<ArchiveUploadComponent>;
  let root: HTMLElement;
  let done: number;
  let send: ReturnType<typeof vi.fn<ArchiveSender>>;

  function open(sender: ArchiveSender, inputs: { maxBytes?: number | null; disabledReason?: string | null } = {}): void {
    send = vi.fn(sender);
    fixture = TestBed.createComponent(ArchiveUploadComponent);
    fixture.componentRef.setInput('send', send);
    fixture.componentRef.setInput('maxBytes', inputs.maxBytes ?? null);
    fixture.componentRef.setInput('disabledReason', inputs.disabledReason ?? null);
    done = 0;
    fixture.componentInstance.done.subscribe(() => done++);
    root = fixture.nativeElement;
    fixture.detectChanges();
  }

  const q = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;

  function pick(file: File): void {
    const input = q<HTMLInputElement>('[data-role="archive-input"]');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input.dispatchEvent(new Event('change'));
  }

  function drop(files: File[]): Event {
    const event = new Event('drop', { cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files } });
    q('.dropzone').dispatchEvent(event);
    return event;
  }

  /** A sender that stays in flight until `finish`, and rejects the way AdminApi does when aborted. */
  function pendingSender(): { sender: ArchiveSender; progress: (p: number) => void; finish: () => void; fail: (e: unknown) => void; aborted: () => boolean } {
    let onProgress: (p: number) => void = () => undefined;
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    let signalSeen: AbortSignal | undefined;
    const sender: ArchiveSender = (_file, progress, signal) => {
      onProgress = progress;
      signalSeen = signal;
      signal.addEventListener('abort', () => reject(new UploadCancelled()));
      return new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    };
    return { sender, progress: p => onProgress(p), finish: () => resolve(), fail: e => reject(e), aborted: () => !!signalSeen?.aborted };
  }

  it('DW-6.1 sends a picked file, shows progress with a cancel button, then reports done', async () => {
    const run = pendingSender();
    open(run.sender, { maxBytes: 200 * MIB });
    pick(zip('scene.zip', 1000));
    await settle(fixture, 2);

    expect(send).toHaveBeenCalledTimes(1);
    expect(q('.progress-card').textContent).toContain('scene.zip');
    expect(q('[data-action="cancel-upload"]')).toBeTruthy();
    expect(root.querySelector('.dropzone')).toBeNull();

    run.progress(40);
    await settle(fixture, 2);
    expect(q('.pct').textContent).toBe('40%');
    expect(q('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('40');
    expect(q('.progress-card').textContent).toContain('Завантаження на сервер');

    run.progress(100);
    await settle(fixture, 2);
    expect(q('.progress-card').textContent).toContain('Сервер перевіряє архів');

    run.finish();
    await settle(fixture);
    expect(done).toBe(1);
    expect(root.querySelector('.progress-card')).toBeNull();
    expect(root.querySelector('.banner-error')).toBeNull();
  });

  it('DW-6.1 a file dropped on the zone is sent too, and the browser\'s own handling of it is prevented', async () => {
    open(async () => undefined);
    const event = drop([zip()]);
    await settle(fixture);
    expect(event.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(done).toBe(1);
  });

  it('DW-6.1 cancel aborts the request, says nothing was saved, and does not report done', async () => {
    const run = pendingSender();
    open(run.sender);
    pick(zip());
    await settle(fixture, 2);

    q<HTMLButtonElement>('[data-action="cancel-upload"]').click();
    await settle(fixture);

    expect(run.aborted()).toBe(true);
    expect(done).toBe(0);
    expect(q('.banner-warn').textContent).toContain('скасовано');
    expect(root.querySelector('.banner-error')).toBeNull();
    expect(root.querySelector('.dropzone')).not.toBeNull(); // ready for another file
  });

  it('DW-6.1 leaving the page mid-upload aborts it', async () => {
    const run = pendingSender();
    open(run.sender);
    pick(zip());
    await settle(fixture, 2);
    fixture.destroy();
    expect(run.aborted()).toBe(true);
  });

  it('DW-6.3 an archive over the platform cap is refused before any request', async () => {
    open(async () => undefined, { maxBytes: 100 * MIB });
    pick({ name: 'huge.zip', size: 200 * MIB } as File);
    await settle(fixture);
    expect(send).not.toHaveBeenCalled();
    expect(q('.banner-error').textContent).toContain('завеликий');
    expect(done).toBe(0);
  });

  it('DW-6.3 a file that is not a ZIP, and an empty one, are refused before any request', async () => {
    open(async () => undefined);
    pick(zip('notes.txt'));
    await settle(fixture);
    expect(q('.banner-error').textContent).toContain('.zip');
    pick(zip('empty.zip', 0));
    await settle(fixture);
    expect(q('.banner-error').textContent).toContain('порожній');
    expect(send).not.toHaveBeenCalled();
  });

  it('dropping several files asks for one and sends none', async () => {
    open(async () => undefined);
    drop([zip('a.zip'), zip('b.zip')]);
    await settle(fixture);
    expect(send).not.toHaveBeenCalled();
    expect(q('.banner-error').textContent).toContain('один ZIP');
  });

  it('DW-6.3 a 409 for a scenario in review shows the server\'s words and the withdrawal hint', async () => {
    open(async () => {
      throw new HttpErrorResponse({ status: 409, error: { error: 'Сценарій на перевірці: відкличте з перевірки, щоб завантажити новий архів' } });
    });
    pick(zip());
    await settle(fixture);
    const text = q('.banner-error').textContent!;
    expect(text).toContain('Сценарій на перевірці');
    expect(text).toContain('«Публікація»');
    expect(done).toBe(0);
  });

  it('a failed upload can be retried: the zone comes back and the same file may be chosen again', async () => {
    let calls = 0;
    open(async () => { if (calls++ === 0) throw new HttpErrorResponse({ status: 500, error: { error: 'Помилка сервера' } }); });
    pick(zip());
    await settle(fixture);
    expect(q('.banner-error').textContent).toContain('Помилка сервера');
    pick(zip());
    await settle(fixture);
    expect(done).toBe(1);
    expect(root.querySelector('.banner-error')).toBeNull();
  });

  it('a disabled zone says why, takes no file and ignores a drop', async () => {
    open(async () => undefined, { disabledReason: 'Сценарій на перевірці' });
    expect(q('[data-role="archive-input"]').hasAttribute('disabled')).toBe(true);
    expect(q('.reason').textContent).toContain('Сценарій на перевірці');
    drop([zip()]);
    await settle(fixture);
    expect(send).not.toHaveBeenCalled();
  });

  it('shows the cap in the hint when it is known and a neutral phrase when not', () => {
    open(async () => undefined, { maxBytes: 200 * MIB });
    expect(q('.sub').textContent).toContain('до 200 МБ');
    fixture.componentRef.setInput('maxBytes', null);
    fixture.detectChanges();
    expect(q('.sub').textContent).toContain('ліміту сервера');
  });
});
