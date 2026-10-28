// path: src/app/pages/admin/scenario-checks/scenario-checks.component.ts

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';

import { AdminRole, ScenarioVersion, TestRun } from '../../../models/admin.model';
import { AdminScenario } from '../../../models/scenario.model';
import { AdminApi } from '../../../services/admin-api.service';
import { AdminService } from '../../../services/admin.service';
import { formatDateTime } from '../../../ui/format';
import { IconComponent } from '../../../ui/icon/icon.component';
import { ModalComponent } from '../../../ui/modal/modal.component';
import { ToastService } from '../../../ui/toast/toast.service';
import { CheckListComponent } from '../check-list/check-list.component';
import { evaluateTestRun } from '../scenario-rules';
import { TestRunComponent } from '../test-run/test-run.component';

type Choice = 'current' | 'pending';

/**
 * The Перевірка tab (prototype 2i): the static checks stored with a version, a button to run them again,
 * and the stored test run read against the norms. A moderator's «Запустити тест» (off when the host sets
 * `testEnabled` false) runs the version on screen in a sandboxed player in this browser (`<vl-test-run>`),
 * saves the report against that version and shows it; `runTest` announces the start. When a proposal is
 * pending, the tab can show either version.
 * Everything in a check or a report comes from an archive or a browser and is only ever interpolated.
 */
@Component({
  selector: 'vl-scenario-checks',
  standalone: true,
  imports: [CheckListComponent, IconComponent, ModalComponent, TestRunComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './scenario-checks.component.scss',
  template: `
    @if (error(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }
    @if (loadError(); as message) {
      <p class="banner banner-error" role="alert">{{ message }}</p>
    }

    @if (pending() && current()) {
      <div class="choice" role="group" aria-label="Яку версію показати">
        <button type="button" class="btn" [class.btn-primary]="choice() === 'current'" [class.btn-secondary]="choice() !== 'current'" [attr.aria-pressed]="choice() === 'current'"
                data-choice="current" (click)="choice.set('current')">Поточна</button>
        <button type="button" class="btn" [class.btn-primary]="choice() === 'pending'" [class.btn-secondary]="choice() !== 'pending'" [attr.aria-pressed]="choice() === 'pending'"
                data-choice="pending" (click)="choice.set('pending')">Нова (очікує)</button>
      </div>
    }

    @if (testing(); as target) {
      <vl-modal heading="Тестовий запуск" [dismissible]="false">
        <vl-test-run [url]="target.url" (finished)="onTestFinished(target, $event)" (cancelled)="testing.set(null)" />
      </vl-modal>
    }

    <div class="checks-grid">
      <section class="panel" aria-labelledby="static-title">
        <div class="head">
          <h2 id="static-title">Автоперевірка архіву</h2>
          @if (version()) {
            <button type="button" class="btn btn-secondary" data-action="rerun" [disabled]="busy()" (click)="rerun()">
              <vl-icon name="arrows-clockwise" size="14" />Перевірити ще раз
            </button>
          }
        </div>
        @if (!version()) {
          @if (!loading()) { <p class="muted">Архіву ще немає, тож перевіряти нічого.</p> }
        } @else if (checks(); as stored) {
          <vl-check-list [checks]="stored" />
        } @else {
          <p class="muted" data-role="unchecked">Для цієї версії збереженої перевірки немає. Натисніть «Перевірити ще раз».</p>
        }
      </section>

      <section class="panel" aria-labelledby="run-title">
        <div class="head">
          <h2 id="run-title">Тестовий запуск</h2>
          @if (role() === 'moderator' && version()) {
            <button type="button" class="btn btn-secondary" data-action="run-test" [disabled]="!testEnabled() || busy()"
                    [attr.title]="testEnabled() ? null : 'Тестовий запуск вимкнено'"
                    (click)="startTest()">
              <vl-icon name="play-circle" size="14" />Запустити тест
            </button>
          }
        </div>

        @if (run(); as stored) {
          @if (stored.error !== undefined) {
            <p class="banner banner-error" role="alert" data-role="run-error">Запуск завершився помилкою: {{ stored.error }}</p>
          } @else {
            <table class="table norms" data-role="norms">
              <thead><tr><th>Показник</th><th>Результат</th><th>Норма</th></tr></thead>
              <tbody>
                @for (row of rows(); track row.key) {
                  <tr [attr.data-key]="row.key" [attr.data-ok]="row.ok">
                    <td>{{ row.label }}</td>
                    <td class="value" [class.ok]="row.ok === true" [class.bad]="row.ok === false">
                      {{ row.value }}<span class="visually-hidden">{{ row.ok === true ? ' — у нормі' : row.ok === false ? ' — поза нормою' : '' }}</span>
                    </td>
                    <td class="norm">{{ row.norm }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          <p class="muted meta">
            {{ metaLine() }}
          </p>
          @if (stored.engineBuild || stored.userAgent) {
            <p class="muted meta">{{ stored.engineBuild ? 'Рушій: ' + stored.engineBuild : '' }}{{ stored.engineBuild && stored.userAgent ? ' · ' : '' }}{{ stored.userAgent ?? '' }}</p>
          }
        } @else if (version()) {
          <p class="muted" data-role="no-run">
            Тестовий запуск ще не виконувався.{{ role() === 'author' ? ' Його виконує модератор.' : '' }}
          </p>
        }
      </section>
    </div>
  `,
})
export class ScenarioChecksComponent {
  readonly scenario = input.required<AdminScenario>();
  readonly role = input.required<AdminRole>();
  /** Whether the test run button works; a host that cannot run a player can switch it off. */
  readonly testEnabled = input(true);
  /** A moderator started a test run of this version. */
  readonly runTest = output<ScenarioVersion>();
  /** The checks were re-run: refetch the row (its counts changed). */
  readonly changed = output<void>();

  private readonly api = inject(AdminApi);
  private readonly toast = inject(ToastService);

  protected readonly versions = signal<ScenarioVersion[]>([]);
  protected readonly choice = signal<Choice>('current');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  /** The version a test run is in progress for (its dialog is open). */
  protected readonly testing = signal<ScenarioVersion | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly loadError = signal<string | null>(null);

  protected readonly current = computed(() => this.versions().find(v => v.state === 'current') ?? null);
  protected readonly pending = computed(() => this.versions().find(v => v.state === 'pending') ?? null);
  /** The version on screen: the pending one only when asked for (and still there), else the current one. */
  protected readonly version = computed(() => (this.choice() === 'pending' && this.pending()) || this.current());
  protected readonly checks = computed(() => this.version()?.checks ?? null);
  protected readonly run = computed(() => this.version()?.testRun ?? null);
  protected readonly rows = computed(() => (this.run() ? evaluateTestRun(this.run()!) : []));
  protected readonly metaLine = computed(() => {
    const run = this.run();
    if (!run) return '';
    const when = formatDateTime(run.ranAt);
    return [when && `Запущено ${when}`, run.ranBy && `виконав(ла) ${run.ranBy}`].filter(Boolean).join(' · ');
  });

  constructor() {
    effect(() => {
      void this.scenario().id;
      untracked(() => {
        this.versions.set([]);
        this.choice.set('current');
        this.error.set(null);
        this.loading.set(true);
        void this.load();
      });
    });
  }

  protected startTest(): void {
    const shown = this.version();
    if (!shown || !this.testEnabled() || this.testing() || this.role() !== 'moderator') return;
    this.error.set(null);
    this.testing.set(shown);
    this.runTest.emit(shown);
  }

  /** Saves the report (numbers or an error) against the version it was run for and shows what the server stored. */
  protected async onTestFinished(target: ScenarioVersion, report: TestRun): Promise<void> {
    const id = this.scenario().id;
    this.testing.set(null);
    this.busy.set(true);
    try {
      const testRun = await this.api.saveTestRun(id, target.id, report);
      if (id !== this.scenario().id) return;
      this.versions.update(list => list.map(v => (v.id === target.id ? { ...v, testRun } : v)));
      this.toast.show(testRun.error === undefined ? 'Результат тестового запуску збережено' : 'Запуск завершився помилкою — її збережено');
    } catch (err) {
      if (id === this.scenario().id) this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Runs the checks again on the stored archive and keeps the answer for the version on screen. */
  protected async rerun(): Promise<void> {
    const shown = this.version();
    if (!shown || this.busy()) return;
    const id = this.scenario().id;
    this.busy.set(true);
    this.error.set(null);
    try {
      const checks = await this.api.runChecks(id, shown.id);
      if (id !== this.scenario().id) return;
      this.versions.update(list => list.map(v => (v.id === shown.id ? { ...v, checks } : v)));
      this.toast.show('Перевірку виконано');
      this.changed.emit();
    } catch (err) {
      if (id === this.scenario().id) this.error.set(AdminService.describeError(err));
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    const id = this.scenario().id;
    try {
      const list = await this.api.versions(id);
      if (id !== this.scenario().id) return; // a response for the scenario the user already left
      this.versions.set(list);
      this.loadError.set(null);
    } catch (err) {
      if (id !== this.scenario().id) return;
      this.loadError.set(AdminService.describeError(err));
    } finally {
      if (id === this.scenario().id) this.loading.set(false);
    }
  }
}
