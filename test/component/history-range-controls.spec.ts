import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import HistoryRangeControls from '../../ui/src/components/HistoryRangeControls.vue';
import type { HistoryRangeId } from '../../ui/src/history-range';
import { createAppI18n } from '../../ui/src/i18n';
import { en } from '../../ui/src/i18n/en';

/**
 * The §14.4 rolling-range control’s matrix (task 174; decision D-147):
 * the five options in ascending order with catalog labels, the
 * retention-driven disabling with its explanation as REAL TEXT (never
 * color alone, §14.1), the unknown-retention rule (nothing disabled),
 * the selection round-trip (radio → update:modelValue), inertness of
 * disabled options, the native keyboard semantics the radio group
 * carries structurally, and a theme-independence smoke (identical DOM
 * under every theme mode; tokens are the only color source, D-133).
 */

const wrappers: VueWrapper[] = [];

function mountControls(
  props: { modelValue?: HistoryRangeId; retentionDays?: number | null } = {},
): VueWrapper {
  const wrapper = mount(HistoryRangeControls, {
    global: { plugins: [createAppI18n()] },
    props: {
      modelValue: props.modelValue ?? '7d',
      retentionDays: props.retentionDays ?? null,
    },
  });
  wrappers.push(wrapper);
  return wrapper;
}

/** The rendered option rows keyed by range id. */
function optionOf(wrapper: VueWrapper, id: HistoryRangeId) {
  const option = wrapper.find(`[data-range-id="${id}"]`);
  expect(option.exists(), `option '${id}' renders`).toBe(true);
  return option;
}

afterEach(() => {
  while (wrappers.length > 0) wrappers.pop()?.unmount();
});

/* ── The control’s structure (§14.1 keyboard + group semantics) ───────── */

describe('HistoryRangeControls: the radio group', () => {
  it('is one native group: a fieldset with a real-text legend, five radios sharing one name', () => {
    const wrapper = mountControls();
    const fieldset = wrapper.find('fieldset[data-testid="history-range"]');
    expect(fieldset.exists()).toBe(true);
    expect(fieldset.find('legend').text()).toBe(en.overview.range.label);
    const radios = fieldset.findAll('input');
    // One shared `name` is what makes arrow-key navigation and the
    // roving checked state NATIVE behavior (§14.1 keyboard support —
    // no script handles keys here, the semantics do).
    expect(radios).toHaveLength(5);
    expect(new Set(radios.map((radio) => radio.attributes('name')))).toEqual(
      new Set(['history-range']),
    );
    expect(radios.every((radio) => radio.attributes('type') === 'radio')).toBe(true);
    // No focus tricks: the radios rely on native tabbing.
    expect(radios.every((radio) => radio.attributes('tabindex') === undefined)).toBe(true);
  });

  it('renders the five §14.4 options ascending with catalog labels', () => {
    const wrapper = mountControls();
    const options = wrapper.findAll('[data-testid="history-range-option"]');
    expect(options.map((option) => option.attributes('data-range-id'))).toEqual([
      '24h',
      '3d',
      '7d',
      '14d',
      '30d',
    ]);
    expect(options.map((option) => option.text())).toEqual([
      en.overview.range.hours24,
      en.overview.range.days3,
      en.overview.range.days7,
      en.overview.range.days14,
      en.overview.range.days30,
    ]);
  });

  it('wraps every radio in its option’s label — the explanation clicks with the option', () => {
    const wrapper = mountControls({ retentionDays: 7 });
    for (const option of wrapper.findAll('[data-testid="history-range-option"]')) {
      expect(option.element.tagName).toBe('LABEL');
      expect(option.find('input[type="radio"]').exists()).toBe(true);
    }
  });
});

/* ── The retention matrix (§14.4 disable + explain) ───────────────────── */

describe('HistoryRangeControls: retention-aware disabling', () => {
  it('disables nothing while retention is unknown — an unknown fact asserts nothing', () => {
    const wrapper = mountControls({ retentionDays: null });
    for (const option of wrapper.findAll('[data-testid="history-range-option"]')) {
      expect(option.find('input').attributes('disabled')).toBeUndefined();
    }
    expect(wrapper.find('[data-testid="history-range-reason"]').exists()).toBe(false);
  });

  it.each([
    { retentionDays: 7, disabled: ['14d', '30d'] },
    { retentionDays: 14, disabled: ['30d'] },
    { retentionDays: 30, disabled: [] },
  ] as const)(
    'retention $retentionDays days disables exactly $disabled — each with its explanation as text',
    ({ retentionDays, disabled }) => {
      const wrapper = mountControls({ retentionDays });
      for (const option of wrapper.findAll('[data-testid="history-range-option"]')) {
        const id = option.attributes('data-range-id') as HistoryRangeId;
        const input = option.find('input');
        if ((disabled as readonly string[]).includes(id)) {
          expect(input.attributes('disabled'), `'${id}' disabled`).toBeDefined();
          // §14.4’s “explain why” + §14.1’s never-color-alone: the
          // reason is REAL TEXT inside the option’s own label, naming
          // the configured retention.
          const reason = option.find('[data-testid="history-range-reason"]');
          expect(reason.exists()).toBe(true);
          expect(reason.text()).toBe(
            en.overview.range.disabledReason.replace('{days}', String(retentionDays)),
          );
        } else {
          expect(input.attributes('disabled'), `'${id}' enabled`).toBeUndefined();
          expect(option.find('[data-testid="history-range-reason"]').exists()).toBe(false);
        }
      }
    },
  );

  it('keeps an exactly-equal range enabled (only strict excess disables)', () => {
    const wrapper = mountControls({ retentionDays: 7 });
    expect(optionOf(wrapper, '7d').find('input').attributes('disabled')).toBeUndefined();
  });
});

/* ── Selection round-trip and inertness ───────────────────────────────── */

describe('HistoryRangeControls: selection', () => {
  it('checks the modelValue option and emits update:modelValue on a change', async () => {
    const wrapper = mountControls({ modelValue: '7d' });
    expect((optionOf(wrapper, '7d').find('input').element as HTMLInputElement).checked).toBe(true);
    await optionOf(wrapper, '24h').find('input').setChecked();
    const emitted = wrapper.emitted('update:modelValue');
    expect(emitted).toEqual([['24h']]);
  });

  it('never forwards a disabled option — the handler holds under every DOM implementation', async () => {
    const wrapper = mountControls({ retentionDays: 7 });
    await optionOf(wrapper, '30d').find('input').trigger('change');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });
});

/* ── Theme independence (D-133: tokens are the only color source) ─────── */

describe('HistoryRangeControls: theme independence smoke', () => {
  /** The state-carrying DOM shape: options × (checked, disabled, text). */
  function shapeOf(wrapper: VueWrapper): string {
    return wrapper
      .findAll('[data-testid="history-range-option"]')
      .map((option) => {
        const input = option.find('input').element as HTMLInputElement;
        return `${option.attributes('data-range-id')}:${input.checked}:${input.disabled}:${option.text()}`;
      })
      .join('|');
  }

  it('renders the identical control under light, dark, and system (attribute absent)', () => {
    const documentElement = document.documentElement;
    const shapes: string[] = [];
    try {
      documentElement.setAttribute('data-theme', 'dark');
      shapes.push(shapeOf(mountControls({ retentionDays: 7 })));
      documentElement.setAttribute('data-theme', 'light');
      shapes.push(shapeOf(mountControls({ retentionDays: 7 })));
      documentElement.removeAttribute('data-theme');
      shapes.push(shapeOf(mountControls({ retentionDays: 7 })));
    } finally {
      documentElement.removeAttribute('data-theme');
    }
    // The theme must not change WHAT the control states: the same
    // options, the same disabling, the same explanations — state is
    // carried by the disabled inputs and the text, never by theme.
    expect(new Set(shapes).size).toBe(1);
  });

  it('carries no hardcoded color — every color in the stylesheet is a token', () => {
    // D-133’s executable half: the SFC’s own stylesheet may name
    // colors only through var(--qm-…); a literal hex/rgb/hsl anywhere
    // in the component source is a regression.
    const source = readFileSync(
      join(process.cwd(), 'ui', 'src', 'components', 'HistoryRangeControls.vue'),
      'utf8',
    );
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
    expect(source).not.toMatch(/\brgb\(|\bhsl\(/u);
  });
});
